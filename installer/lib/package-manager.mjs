import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

/** Lockfile → manager, in precedence order when several are present. */
export const LOCKFILES = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const SCRIPT_KEYS = [
  ['project.testCmd', 'test'],
  ['project.lintCmd', 'lint'],
  ['project.typecheckCmd', 'typecheck'],
  ['project.buildCmd', 'build'],
];

/**
 * @param {unknown} value a `package.json` `packageManager` field
 * @returns {{ name: string, version: string } | null}
 */
export function parsePackageManagerField(value) {
  if (typeof value !== 'string') return null;
  const m = /^(npm|pnpm|yarn|bun)@([^\s+]+)(?:\+\S*)?$/.exec(value.trim());
  return m ? { name: m[1], version: m[2] } : null;
}

/**
 * @typedef {{ name: string|null, version: string|null, source: 'packageManager'|'lockfile'|null, lockfile: string|null, conflicts: string[] }} Detection
 */

/**
 * @param {{ packageJson: any, lockfiles: string[] }} input
 * @returns {Detection | null}
 */
export function packageManagerFrom({ packageJson, lockfiles }) {
  if (!packageJson || typeof packageJson !== 'object') return null;
  const present = LOCKFILES.filter(([file]) => lockfiles.includes(file));
  const field = parsePackageManagerField(packageJson.packageManager);
  /** @type {Detection} */
  let detection;
  if (field) {
    detection = { name: field.name, version: field.version, source: 'packageManager', lockfile: null, conflicts: [] };
  } else if (present.length) {
    const [lockfile, name] = present[0];
    detection = { name, version: null, source: 'lockfile', lockfile, conflicts: [] };
  } else {
    return { name: null, version: null, source: null, lockfile: null, conflicts: [] };
  }
  detection.conflicts = [...new Set(present.map(([, n]) => n).filter((n) => n !== detection.name))];
  return detection;
}

/**
 * @param {Detection | null} detection
 * @param {Record<string, unknown> | undefined} scripts the `package.json` `scripts` map
 * @returns {Record<string, string>} config key → suggested command
 */
export function suggestCommands(detection, scripts) {
  const pm = detection?.name;
  if (!pm || !PACKAGE_MANAGERS.includes(pm)) return {};
  const has = (s) => !!scripts && typeof scripts === 'object' && Object.hasOwn(scripts, s);
  /** @type {Record<string, string>} */
  const out = { 'project.installCmd': `${pm} install` };
  for (const [key, script] of SCRIPT_KEYS) {
    if (!has(script)) continue;
    // `bun test` runs Bun's own test runner, not the `test` script.
    if (script === 'test' && pm !== 'bun') out[key] = `${pm} test`;
    else out[key] = `${pm} run ${script}`;
  }
  return out;
}

/**
 * Reads `cwd/package.json` and the lockfiles beside it; never throws.
 * @param {string} cwd
 * @returns {{ detection: Detection, suggestions: Record<string, string> } | null}
 */
export function detectPackageManager(cwd) {
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const lockfiles = LOCKFILES.map(([f]) => f).filter((f) => fs.existsSync(path.join(cwd, f)));
  const detection = packageManagerFrom({ packageJson, lockfiles });
  if (!detection) return null;
  return { detection, suggestions: suggestCommands(detection, packageJson.scripts) };
}
