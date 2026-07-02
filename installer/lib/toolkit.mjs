import fs from 'node:fs';
import path from 'node:path';
import { readYaml, parseFrontmatter, exists, isBinary } from './util.mjs';

/** Load the toolkit registry and every bundle it lists. */
export function loadToolkit(rootDir) {
  const registry = readYaml(path.join(rootDir, 'toolkit.yaml'));
  const bundles = new Map();
  for (const name of registry.bundles ?? []) {
    const dir = path.join(rootDir, 'bundles', name);
    if (!exists(path.join(dir, 'bundle.yaml'))) continue; // not yet authored
    bundles.set(name, loadBundle(name, dir));
  }
  return { name: registry.name, description: registry.description, bundles };
}

function loadBundle(name, dir) {
  const manifest = readYaml(path.join(dir, 'bundle.yaml'));
  const config = manifest.config ?? {};
  const declared = new Set(Object.keys(config));

  const agents = (manifest.agents ?? []).map((agentName) => {
    const file = path.join(dir, 'agents', `${agentName}.md`);
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return { kind: 'agent', name: agentName, file, data, body };
  });

  const skills = (manifest.skills ?? []).map((skillName) => {
    const skillDir = path.join(dir, 'skills', skillName);
    const files = fs
      .readdirSync(skillDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(skillDir, path.join(e.parentPath ?? e.path, e.name)))
      .sort();
    if (!files.includes('SKILL.md')) {
      throw new Error(`bundle ${name}: skill ${skillName} has no SKILL.md`);
    }
    return { kind: 'skill', name: skillName, dir: skillDir, files };
  });

  // Generic payloads: a file authored under `files/<repo-relative-path>` renders verbatim
  // to that same path in the consuming project (CI workflows, scripts, config). Text files
  // are template-substituted, binaries byte-copied — text/binary is sniffed by content, so
  // any text type works, not just `.md`.
  const files = (manifest.files ?? []).map((entry) => {
    const rel = String(entry);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === '..')) {
      throw new Error(`bundle ${name}: files entry "${rel}" must be a repo-relative path that stays inside the project`);
    }
    const file = path.join(dir, 'files', rel);
    if (!exists(file)) throw new Error(`bundle ${name}: files entry "${rel}" not found under files/`);
    return { kind: 'files', name: rel, path: file, binary: isBinary(fs.readFileSync(file)) };
  });

  return {
    name,
    dir,
    description: manifest.description ?? '',
    agents,
    skills,
    files,
    config,
    declared,
    env: manifest.env ?? {},
    // Optional per-item dependency declarations: `skills/<name>`/`agents/<name>` →
    // list of `skills/<name>`/`agents/<name>` refs. Formalizes prose-only skill deps.
    requires: manifest.requires ?? {},
    setup: typeof manifest.setup === 'string' ? manifest.setup : '',
  };
}

/**
 * Config keys that are `required` and unresolved. When `usedKeys` is supplied, only
 * keys actually referenced by the selected items are considered — so a partial install
 * (one item from a bundle) does not demand config only the bundle's other items use.
 */
export function missingRequiredKeys(bundle, values, lookup, usedKeys = null) {
  const missing = [];
  for (const [key, spec] of Object.entries(bundle.config)) {
    if (!spec?.required) continue;
    if (usedKeys && !usedKeys.has(key)) continue;
    if (lookup(values, key) === undefined) missing.push(key);
  }
  return missing;
}
