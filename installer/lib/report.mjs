// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { readLock } from './render.mjs';
import { doctor } from './doctor.mjs';
import { formatPrereq } from './prerequisites.mjs';
import { loadProjectConfig, LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE, resolveConfigFile } from './project.mjs';
import { exists } from './util.mjs';

/**
 * @typedef {object} ReportBundle the redacted diagnostics `wafflestack report` prints (#473)
 * @property {{ version: string, status: string, commit: string|null }} cli the CLI that collected this
 * @property {ReportLock|null} lock the committed lock, or null when the repo was never rendered
 * @property {ReportConfig} config the committed config — key PATHS only, never a value
 * @property {{ node: string, platform: string, localOverlay: boolean, localLock: boolean }} environment
 * @property {ReportHealth} health a summarized canonical `doctor()` run
 *
 * @typedef {object} ReportLock
 * @property {string|null} toolkitVersion
 * @property {{ source: string|null, ref: string|null, commit: string|null, status: string|null }} toolkit
 * @property {string[]} targets
 * @property {string[]} stacks
 * @property {string[]} include
 * @property {number} trackedFiles
 * @property {{ name: string, sourceType: string, ref: string|null, commit: string|null }[]} sources
 *
 * @typedef {object} ReportConfig
 * @property {boolean} present
 * @property {string|null} error the load failure, when `present` but unparseable
 * @property {string[]} targets
 * @property {string[]} stacks
 * @property {{ name: string, sourceType: string, ref: string|null }[]} externalStacks
 * @property {string[]} include
 * @property {string[]} eject
 * @property {string[]} configKeys dotted key paths declared under `config:`; values are dropped
 *
 * @typedef {object} ReportHealth
 * @property {boolean} ok
 * @property {number} modified
 * @property {number} missing
 * @property {number} staleRender
 * @property {string[]} unmetRequired
 * @property {string[]} unmetRecommended
 * @property {string[]} notes
 */

/**
 * Collect the bundle. Structural redaction first: the config is loaded `canonical` (the overlay is
 * never opened), doctor runs `canonical` (the local lock is never opened), and only config key paths
 * are projected. A scrub pass over every string then handles what structure cannot.
 *
 * @param {{ cwd: string, toolkitRoot: string, toolkitVersion: string, toolkitIdentity?: import('./toolkit-ref.mjs').ToolkitIdentity|null, home?: string, platform?: string, nodeVersion?: string }} opts
 * @returns {ReportBundle}
 */
export function collectReport({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity = null, home = os.homedir(), platform = process.platform, nodeVersion = process.version }) {
  const lock = readLockSafe(cwd);
  const config = projectConfig(cwd);
  const health = summarizeDoctor({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity });
  const bundle = {
    cli: { version: toolkitVersion, status: toolkitIdentity?.status ?? 'unverified', commit: toolkitIdentity?.commit ?? null },
    lock,
    config,
    environment: {
      node: nodeVersion,
      platform,
      localOverlay: exists(path.join(cwd, LOCAL_CONFIG_FILE)),
      localLock: exists(path.join(cwd, LOCAL_LOCK_FILE)),
    },
    health,
  };
  return /** @type {ReportBundle} */ (redact(bundle, { cwd, home }));
}

/** @param {string} cwd @returns {ReportLock|null} */
function readLockSafe(cwd) {
  /** @type {any} */
  let lock;
  try {
    lock = readLock(cwd);
  } catch {
    return null;
  }
  if (!lock) return null;
  return {
    toolkitVersion: lock.toolkitVersion ?? null,
    toolkit: {
      source: lock.toolkit?.source ?? null,
      ref: lock.toolkit?.ref ?? null,
      commit: lock.toolkit?.commit ?? null,
      status: lock.toolkit?.status ?? null,
    },
    targets: strings(lock.targets),
    stacks: strings(lock.stacks),
    include: strings(lock.include),
    trackedFiles: Object.keys(lock.files ?? {}).length,
    sources: (Array.isArray(lock.sources) ? lock.sources : []).map((/** @type {any} */ s) => ({
      name: String(s.name),
      sourceType: String(s.sourceType ?? 'unknown'),
      ref: s.ref ?? null,
      commit: s.commit ?? null,
    })),
  };
}

/** @param {string} cwd @returns {ReportConfig} */
function projectConfig(cwd) {
  /** @type {ReportConfig} */
  const empty = { present: false, error: null, targets: [], stacks: [], externalStacks: [], include: [], eject: [], configKeys: [] };
  if (!exists(resolveConfigFile(cwd).file)) return empty;
  try {
    const project = loadProjectConfig(cwd, [], { canonical: true });
    return {
      present: true,
      error: null,
      targets: strings(project.targets),
      stacks: strings(project.stacks),
      externalStacks: project.externalStacks.map((s) => ({ name: s.name, sourceType: s.sourceType, ref: s.ref })),
      include: strings(project.include),
      eject: strings(project.eject),
      configKeys: keyPaths(project.values),
    };
  } catch (err) {
    return { ...empty, present: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {{ cwd: string, toolkitRoot: string, toolkitVersion: string, toolkitIdentity: import('./toolkit-ref.mjs').ToolkitIdentity|null }} opts
 * @returns {ReportHealth}
 */
function summarizeDoctor({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity }) {
  try {
    const r = doctor({ cwd, toolkitVersion, toolkitIdentity, toolkitRoot, canonical: true });
    return {
      ok: r.ok,
      modified: r.modified.length,
      missing: r.missing.length,
      staleRender: r.render.stale.length + r.render.absent.length + r.render.unexpected.length,
      unmetRequired: r.prerequisites.unmetRequired.map(formatPrereq),
      unmetRecommended: r.prerequisites.unmetRecommended.map(formatPrereq),
      notes: r.notes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, modified: 0, missing: 0, staleRender: 0, unmetRequired: [], unmetRecommended: [], notes: [`doctor could not run: ${message}`] };
  }
}

/**
 * Dotted key paths of a config value tree; arrays and scalars are leaves, their values dropped.
 *
 * @param {any} obj
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function keyPaths(obj, prefix = '') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  /** @type {string[]} */
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keyPaths(v, key));
    else out.push(key);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const REMOTE_URL = /(?:\b(?:https?|ssh|git):\/\/[^\s'"`<>]+|\b[\w.-]+@[\w.-]+:[\w./-]+(?:\.git)?\b)/g;

/**
 * Scrub one string: `cwd` → `<repo>`, home → `~`, emails and git remote URLs → placeholders.
 * Order matters — `cwd` usually sits under home, and an scp-style remote contains an `@`.
 *
 * @param {string} text
 * @param {{ cwd?: string, home?: string }} scope
 * @returns {string}
 */
export function scrub(text, { cwd, home } = {}) {
  let out = text;
  for (const dir of variants(cwd)) out = out.split(dir).join('<repo>');
  for (const dir of variants(home)) out = out.split(dir).join('~');
  out = out.replace(REMOTE_URL, '<git-remote>');
  out = out.replace(EMAIL, '<email>');
  return out;
}

/** @param {string|undefined} dir @returns {string[]} the literal and realpath forms, longest first */
function variants(dir) {
  if (!dir) return [];
  const set = new Set([dir, path.resolve(dir)]);
  try {
    set.add(fs.realpathSync(dir));
  } catch {
    // an absent dir has no realpath; the literal forms still apply
  }
  return [...set].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Apply `scrub` to every string in a value tree, keys included.
 *
 * @param {any} value
 * @param {{ cwd?: string, home?: string }} scope
 * @returns {any}
 */
export function redact(value, scope) {
  if (typeof value === 'string') return scrub(value, scope);
  if (Array.isArray(value)) return value.map((v) => redact(v, scope));
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[scrub(k, scope)] = redact(v, scope);
    return out;
  }
  return value;
}

/**
 * The Markdown environment block — a collapsed `<details>` ready to paste under a report body.
 *
 * @param {ReportBundle} b
 * @returns {string}
 */
export function formatReportMarkdown(b) {
  const list = (/** @type {string[]} */ xs) => (xs.length ? xs.join(', ') : '(none)');
  const short = (/** @type {string|null} */ sha) => (sha ? sha.slice(0, 7) : 'null');
  const lines = ['<details>', '<summary>wafflestack environment (from `wafflestack report`)</summary>', ''];
  if (b.lock) {
    const t = b.lock.toolkit;
    lines.push(`- **lock**: rendered by toolkit ${b.lock.toolkitVersion ?? 'unknown'} — source ${t.source ?? 'null'}, ref ${t.ref ?? 'null'}, commit ${short(t.commit)}, status ${t.status ?? 'null'}; ${b.lock.trackedFiles} tracked files`);
    lines.push(`- **targets**: ${list(b.lock.targets)}`);
    lines.push(`- **stacks**: ${list(b.lock.stacks)}`);
    lines.push(`- **include**: ${list(b.lock.include)}`);
    if (b.lock.sources.length) lines.push(`- **external sources**: ${list(b.lock.sources.map((s) => `${s.name} (${s.sourceType}${s.ref ? ` @ ${s.ref}` : ''})`))}`);
  } else {
    lines.push('- **lock**: none — the repo has not been rendered');
  }
  if (b.config.present) {
    if (b.config.error) lines.push(`- **config**: present but failed to load — ${b.config.error}`);
    else {
      lines.push(`- **config**: targets ${list(b.config.targets)}; stacks ${list(b.config.stacks)}${b.config.externalStacks.length ? `; external ${list(b.config.externalStacks.map((s) => `${s.name} (${s.sourceType}${s.ref ? ` @ ${s.ref}` : ''})`))}` : ''}`);
      lines.push(`- **eject**: ${list(b.config.eject)}`);
      lines.push(`- **config keys** (values withheld): ${list(b.config.configKeys)}`);
    }
  } else {
    lines.push('- **config**: no `.waffle/waffle.yaml`');
  }
  lines.push(`- **installed CLI**: ${b.cli.version} (${b.cli.status}${b.cli.commit ? ` ${short(b.cli.commit)}` : ''})`);
  lines.push(`- **environment**: node ${b.environment.node}, ${b.environment.platform}; local overlay ${b.environment.localOverlay ? 'present' : 'absent'}${b.environment.localLock ? ' (local lock present)' : ''}`);
  const h = b.health;
  lines.push(`- **doctor**: ${h.ok ? 'ok' : 'NOT ok'} — ${h.modified} modified, ${h.missing} missing, ${h.staleRender} stale-render`);
  if (h.unmetRequired.length) lines.push(`- **prerequisites unmet (require)**: ${list(h.unmetRequired)}`);
  if (h.unmetRecommended.length) lines.push(`- **prerequisites unmet (recommend)**: ${list(h.unmetRecommended)}`);
  if (h.notes.length) {
    lines.push('- **doctor notes**:');
    for (const n of h.notes) lines.push(`  - ${n}`);
  }
  lines.push('', '</details>', '');
  return lines.join('\n');
}

/** @param {any} xs @returns {string[]} */
function strings(xs) {
  return Array.isArray(xs) ? xs.map((x) => String(x)) : [];
}
