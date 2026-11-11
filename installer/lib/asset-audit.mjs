// @ts-check
// The opt-in large-asset audit `doctor` runs when the person running it points it at the studios
// `asset_audit.py` script. Advisory by default: it never changes doctor's exit code unless strict
// mode is on, and every failure to run is a one-line note, never a crash. Read-only and offline.
//
// Trust boundary: the script path is code doctor executes, so it is taken ONLY from the
// `WAFFLESTACK_ASSET_AUDIT` env variable or the untracked local overlay — never from the committed
// `waffle.yaml`, which a cloned repo or a pull request controls — and never from inside the repo.
// `python3` is resolved from PATH entries outside the repo, run from the temp dir with a minimal env.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { loadProjectConfig, gitIgnoreStatus, resolveLocalConfigFile, CONFIG_FILE, LOCAL_CONFIG_FILE } from './project.mjs';
import { lookupPath } from './util.mjs';

/** Env twin of `doctor.assetAudit.script`: a path to `asset_audit.py`. Setting it turns the check on. */
export const ASSET_AUDIT_ENV = 'WAFFLESTACK_ASSET_AUDIT';
/** The CLI flag that makes asset findings fail `doctor` for one run. */
export const ASSET_AUDIT_STRICT_FLAG = '--asset-audit-strict';
/** The CLI flag that passes `--allow-unhydrated` to the audit for one run. */
export const ASSET_AUDIT_ALLOW_UNHYDRATED_FLAG = '--asset-audit-allow-unhydrated';
export const DEFAULT_TIMEOUT_SECONDS = 120;
/** How many error/warning findings the summary lists before pointing at the full report. */
export const TOP_FINDINGS = 5;

const REPORT_KIND = 'asset-audit-report';
const SUPPORTED_MAJOR = '1';
const SETTING_KEYS = ['script', 'strict', 'timeoutSeconds', 'allowUnhydrated'];

/**
 * @typedef {object} AssetAuditSettings
 * @property {boolean} enabled
 * @property {string|null} script absolute path to the audit script
 * @property {'env'|'local'|null} scriptSource
 * @property {boolean} strict
 * @property {boolean} allowUnhydrated
 * @property {number} timeoutMs
 * @property {string[]} notes problems with the settings themselves (never fatal)
 *
 * @typedef {object} AssetFinding
 * @property {string} id
 * @property {string} severity
 * @property {string} path
 * @property {string} message
 * @property {string} fix
 *
 * @typedef {object} AssetAuditResult
 * @property {boolean} enabled the person running doctor asked for the audit
 * @property {boolean} ran the audit produced a usable report
 * @property {boolean} strict
 * @property {string[]} notes one-line notes: settings problems, or why the audit did not run
 * @property {{ error: number, warning: number, info: number, result: string }|null} summary
 * @property {AssetFinding[]} top the first `TOP_FINDINGS` error/warning findings
 * @property {number} reported error + warning findings in the report
 * @property {boolean} strictFailed strict mode is on and the audit found an error or warning
 * @property {string|null} script
 */

/** @returns {AssetAuditResult} the result for a run that did not opt in */
export function assetAuditDisabled() {
  return { enabled: false, ran: false, strict: false, notes: [], summary: null, top: [], reported: 0, strictFailed: false, script: null };
}

/** @param {string} child @param {string} parent  true when `child` is `parent` or inside it */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** @param {string} p the realpath when it exists, else the resolved path */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Validate one `doctor.assetAudit` block. `allowScript: false` (the committed file) drops `script`
 * with a note.
 *
 * @param {any} block
 * @param {string} where the file name, for notes
 * @param {boolean} allowScript
 * @param {string[]} notes
 * @returns {{ script?: string, strict?: boolean, timeoutSeconds?: number, allowUnhydrated?: boolean }}
 */
function readBlock(block, where, allowScript, notes) {
  /** @type {{ script?: string, strict?: boolean, timeoutSeconds?: number, allowUnhydrated?: boolean }} */
  const out = {};
  if (block === undefined || block === null) return out;
  if (typeof block !== 'object' || Array.isArray(block)) {
    notes.push(`asset audit: \`doctor.assetAudit\` in ${where} must be a mapping — ignored`);
    return out;
  }
  const unknown = Object.keys(block).filter((k) => !SETTING_KEYS.includes(k));
  if (unknown.length) notes.push(`asset audit: unknown key(s) under \`doctor.assetAudit\` in ${where} ignored: ${unknown.join(', ')} (known: ${SETTING_KEYS.join(', ')})`);
  if (block.script !== undefined) {
    if (!allowScript) {
      notes.push(`asset audit: \`doctor.assetAudit.script\` in ${where} is ignored — a committed file must not choose code for doctor to run; set it in ${LOCAL_CONFIG_FILE} (gitignored) or the ${ASSET_AUDIT_ENV} environment variable`);
    } else if (typeof block.script === 'string' && block.script.trim()) {
      out.script = block.script.trim();
    } else {
      notes.push(`asset audit: \`doctor.assetAudit.script\` in ${where} must be a non-empty path — ignored`);
    }
  }
  for (const key of /** @type {const} */ (['strict', 'allowUnhydrated'])) {
    if (block[key] === undefined) continue;
    if (typeof block[key] === 'boolean') out[key] = block[key];
    else notes.push(`asset audit: \`doctor.assetAudit.${key}\` in ${where} must be true or false — ignored`);
  }
  if (block.timeoutSeconds !== undefined) {
    const t = block.timeoutSeconds;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) out.timeoutSeconds = t;
    else notes.push(`asset audit: \`doctor.assetAudit.timeoutSeconds\` in ${where} must be a positive number — ignored`);
  }
  return out;
}

/**
 * The local overlay's `doctor.assetAudit` block — but only when git confirms the overlay is NOT
 * tracked, since a committed "local" file is just as attacker-controlled as `waffle.yaml`.
 *
 * @param {string} cwd @param {string[]} notes
 * @returns {any}
 */
function localBlock(cwd, notes) {
  const file = resolveLocalConfigFile(cwd).file;
  if (!fs.existsSync(file)) return undefined;
  /** @type {any} */
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined; // a broken overlay is reported by the render/doctor paths that load it
  }
  const block = doc && typeof doc === 'object' && doc.doctor && typeof doc.doctor === 'object' ? doc.doctor.assetAudit : undefined;
  if (block && typeof block === 'object' && !Array.isArray(block) && block.script !== undefined) {
    const rel = path.relative(cwd, file).split(path.sep).join('/');
    const status = gitIgnoreStatus(cwd, [rel]);
    if (!status) {
      notes.push(`asset audit: \`doctor.assetAudit.script\` in ${LOCAL_CONFIG_FILE} is ignored — git could not confirm the file is untracked; use the ${ASSET_AUDIT_ENV} environment variable`);
      return { ...block, script: undefined };
    }
    if (status.tracked.has(rel)) {
      notes.push(`asset audit: \`doctor.assetAudit.script\` in ${LOCAL_CONFIG_FILE} is ignored — that file is tracked by git, so the repo chose it; use the ${ASSET_AUDIT_ENV} environment variable`);
      return { ...block, script: undefined };
    }
  }
  return block;
}

/**
 * Settings, from (lowest to highest): committed `doctor.assetAudit` (`strict`, `timeoutSeconds`,
 * `allowUnhydrated` only), the untracked local overlay (all keys), then the env variable and CLI
 * flags. A missing or unreadable config just means "env only": this check adds no failure mode.
 *
 * @param {{ cwd: string, strictFlag?: boolean, allowUnhydratedFlag?: boolean, env?: NodeJS.ProcessEnv, home?: string }} opts
 * @returns {AssetAuditSettings}
 */
export function resolveAssetAuditSettings({ cwd, strictFlag = false, allowUnhydratedFlag = false, env = process.env, home = os.homedir() }) {
  /** @type {string[]} */
  const notes = [];
  /** @type {any} */
  let committed;
  try {
    const project = loadProjectConfig(cwd, [], { canonical: true });
    committed = project.doctor && typeof project.doctor === 'object' ? project.doctor.assetAudit : undefined;
    if (lookupPath(project.values, 'doctor.assetAudit') !== undefined) {
      notes.push(`asset audit: \`config.doctor.assetAudit\` in ${CONFIG_FILE} is ignored — use a top-level \`doctor: { assetAudit: … }\` block (not under \`config:\`)`);
    }
  } catch {
    committed = undefined;
  }
  const merged = {
    ...readBlock(committed, CONFIG_FILE, false, notes),
    ...readBlock(localBlock(cwd, notes), LOCAL_CONFIG_FILE, true, notes),
  };

  const envScript = String(env[ASSET_AUDIT_ENV] ?? '').trim();
  const raw = envScript || merged.script || null;
  /** @type {'env'|'local'|null} */
  const scriptSource = envScript ? 'env' : merged.script ? 'local' : null;
  const enabled = Boolean(raw);
  return {
    enabled,
    script: raw ? resolveScriptPath(raw, cwd, home) : null,
    scriptSource,
    strict: enabled && (strictFlag || merged.strict === true),
    allowUnhydrated: enabled && (allowUnhydratedFlag || merged.allowUnhydrated === true),
    timeoutMs: Math.round((merged.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
    notes,
  };
}

/**
 * `~` / `~/…` expand to the home directory; a relative path resolves against the project root
 * (and is then refused for being inside it, unless it climbs out with `..`).
 * @param {string} raw @param {string} cwd @param {string} home
 */
export function resolveScriptPath(raw, cwd, home) {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return path.resolve(cwd, raw);
}

/**
 * The PATH entries doctor trusts: absolute, and not inside the project root (a repo must not be
 * able to plant a `python3` or `git` that doctor then runs).
 *
 * @param {string|undefined} pathVar @param {string} cwd
 * @returns {string[]}
 */
export function safePathEntries(pathVar, cwd) {
  const root = real(cwd);
  return String(pathVar ?? '')
    .split(path.delimiter)
    .filter((d) => d && path.isAbsolute(d) && !isInside(real(d), root));
}

/**
 * `python` as an absolute path: kept when already absolute, else looked up in the safe PATH.
 * @param {string} python @param {string[]} dirs
 * @returns {string|null}
 */
export function resolvePython(python, dirs) {
  if (path.isAbsolute(python)) return python;
  for (const dir of dirs) {
    const candidate = path.join(dir, python);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * The only variables the audit sees: the safe PATH, HOME, locale, and git's no-optional-locks.
 * @param {NodeJS.ProcessEnv} env @param {string[]} dirs
 * @returns {NodeJS.ProcessEnv}
 */
export function auditEnv(env, dirs) {
  /** @type {NodeJS.ProcessEnv} */
  const out = { PATH: dirs.join(path.delimiter), GIT_OPTIONAL_LOCKS: '0' };
  if (env.HOME) out.HOME = env.HOME;
  for (const [k, v] of Object.entries(env)) {
    if ((k === 'LANG' || k.startsWith('LC_')) && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Run the audit read-only against `cwd` and summarize it. Never throws.
 *
 * @param {{ cwd: string, settings: AssetAuditSettings, python?: string, env?: NodeJS.ProcessEnv, spawn?: typeof spawnSync }} opts
 * @returns {AssetAuditResult}
 */
export function runAssetAudit({ cwd, settings, python = 'python3', env = process.env, spawn = spawnSync }) {
  const result = assetAuditDisabled();
  result.notes.push(...settings.notes);
  if (!settings.enabled || !settings.script) return result;
  result.enabled = true;
  result.strict = settings.strict;
  result.script = settings.script;
  const skip = (/** @type {string} */ why) => {
    result.notes.push(`asset audit not run: ${why}`);
    return result;
  };
  const from = settings.scriptSource === 'env' ? ASSET_AUDIT_ENV : `doctor.assetAudit.script in ${LOCAL_CONFIG_FILE}`;

  let isFile = false;
  try {
    isFile = fs.statSync(settings.script).isFile();
  } catch { /* reported below */ }
  if (!isFile) return skip(`script not found at ${settings.script} (from ${from})`);
  if (isInside(real(settings.script), real(cwd))) {
    return skip(`refusing script ${settings.script} (from ${from}) — it is inside the project being audited; keep the audit script outside the repo`);
  }

  const dirs = safePathEntries(env.PATH, cwd);
  const interpreter = resolvePython(python, dirs);
  if (!interpreter) return skip(`${python} not found on PATH (outside the project; the audit needs Python 3.9 or newer)`);

  // `-I` isolates Python from PYTHON* env vars, the user site and the script's folder on sys.path;
  // `-B` writes no bytecode. The temp dir as cwd keeps the repo off every relative lookup — the
  // repo path is passed as an argument. The audit itself never runs `git status` or writes.
  const args = ['-I', '-B', settings.script, 'audit', cwd, '--json'];
  if (settings.allowUnhydrated) args.push('--allow-unhydrated');
  const r = spawn(interpreter, args, {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: settings.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: auditEnv(env, dirs),
  });
  const err = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
  if (err?.code === 'ENOENT') return skip(`${interpreter} not found (the audit needs Python 3.9 or newer)`);
  if (err?.code === 'ETIMEDOUT' || (r.signal && r.status === null)) return skip(`timed out after ${settings.timeoutMs / 1000}s (raise doctor.assetAudit.timeoutSeconds)`);
  if (err) return skip(`could not start ${interpreter}: ${err.message}`);
  const stderr = lastLine(String(r.stderr ?? ''));
  if (r.status === 2) return skip(`the audit could not run (exit 2)${stderr ? `: ${stderr}` : ''}`);
  if (r.status !== 0 && r.status !== 1) return skip(`the audit exited ${r.status}${stderr ? `: ${stderr}` : ''}`);

  /** @type {any} */
  let report;
  try {
    report = JSON.parse(String(r.stdout ?? ''));
  } catch {
    return skip('the audit did not print a JSON report');
  }
  if (!report || report.kind !== REPORT_KIND) return skip(`unexpected report kind ${JSON.stringify(report?.kind ?? null)} (expected "${REPORT_KIND}")`);
  const major = String(report.schema_version ?? '').split('.')[0];
  if (major !== SUPPORTED_MAJOR) return skip(`unsupported report schema_version ${JSON.stringify(report.schema_version ?? null)} (this CLI reads ${SUPPORTED_MAJOR}.x)`);

  const s = report.summary ?? {};
  const count = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
  result.summary = { error: count(s.error), warning: count(s.warning), info: count(s.info), result: typeof s.result === 'string' ? clean(s.result, 40) : 'unknown' };
  // Unknown ids are read by severity (the report's compatibility rule); info is never listed.
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const actionable = findings.filter((/** @type {any} */ f) => f && (f.severity === 'error' || f.severity === 'warning'));
  actionable.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  result.reported = actionable.length;
  result.top = actionable.slice(0, TOP_FINDINGS).map((/** @type {any} */ f) => ({
    id: clean(f.id, 80),
    severity: f.severity,
    path: clean(f.path, 160),
    message: clean(f.message, 240),
    fix: clean(f.fix, 240),
  }));
  result.ran = true;
  result.strictFailed = result.strict && result.summary.error + result.summary.warning > 0;
  return result;
}

/**
 * The doctor output section: nothing for a disabled audit, otherwise a summary line, the top
 * findings with fix hints, and the strict verdict.
 *
 * @param {AssetAuditResult} a
 * @param {{ cwd?: string }} [opts]
 * @returns {string[]}
 */
export function formatAssetAudit(a, { cwd = '.' } = {}) {
  /** @type {string[]} */
  const lines = [...a.notes];
  if (!a.enabled || !a.ran || !a.summary) return lines;
  const s = a.summary;
  const mode = a.strict ? 'strict — errors and warnings fail doctor' : 'advisory — does not change the exit code';
  lines.push(`asset audit: ${s.error} error(s), ${s.warning} warning(s), ${s.info} info (${mode})`);
  for (const f of a.top) {
    lines.push(`  ${f.severity} ${f.id}: ${f.path || '(repository)'} — ${f.message}`);
    if (f.fix) lines.push(`    fix: ${f.fix}`);
  }
  if (a.reported > a.top.length) {
    lines.push(`  … and ${a.reported - a.top.length} more; full report: python3 ${a.script} audit ${cwd}`);
  }
  if (a.strictFailed) lines.push('asset audit failed doctor (strict mode is on)');
  return lines;
}

/** One printable line: control characters (a filename can hold a newline) escaped, length capped. */
function clean(/** @type {unknown} */ value, /** @type {number} */ max) {
  // eslint-disable-next-line no-control-regex
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\n' ? '\\n' : c === '\t' ? ' ' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The last non-empty line: where a Python traceback names the error. */
function lastLine(/** @type {string} */ text) {
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return clean(line, 200);
}
