// @ts-check
// The opt-in large-asset audit `doctor` runs when a project points it at the studios
// `asset_audit.py` script. Advisory by default: it never changes doctor's exit code unless
// strict mode is on, and every failure to run is a one-line note, never a crash. Read-only and
// offline — the script is run as `python3 -I -B <script> audit <repo> --json` with a timeout.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { loadProjectConfig, CONFIG_FILE } from './project.mjs';
import { lookupPath } from './util.mjs';

/** Env twin of `doctor.assetAudit.script`: a path to `asset_audit.py`. Setting it turns the check on. */
export const ASSET_AUDIT_ENV = 'WAFFLESTACK_ASSET_AUDIT';
/** The CLI flag that makes asset findings fail `doctor` for one run. */
export const ASSET_AUDIT_STRICT_FLAG = '--asset-audit-strict';
export const DEFAULT_TIMEOUT_SECONDS = 120;
/** How many error/warning findings the summary lists before pointing at the full report. */
export const TOP_FINDINGS = 5;

const REPORT_KIND = 'asset-audit-report';
const SUPPORTED_MAJOR = '1';
const SETTING_KEYS = ['script', 'strict', 'timeoutSeconds'];

/**
 * @typedef {object} AssetAuditSettings
 * @property {boolean} enabled
 * @property {string|null} script absolute path to the audit script
 * @property {'env'|'config'|null} scriptSource
 * @property {boolean} strict
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
 * @property {boolean} enabled the project (or env) asked for the audit
 * @property {boolean} ran the audit produced a usable report
 * @property {boolean} strict
 * @property {string[]} notes one-line notes: settings problems, or why the audit did not run
 * @property {{ error: number, warning: number, info: number, result: string }|null} summary
 * @property {AssetFinding[]} top the first `TOP_FINDINGS` error/warning findings
 * @property {number} reported error + warning findings in the report
 * @property {boolean} strictFailed strict mode is on and the audit found an error or warning
 * @property {string|null} script
 */

/** @returns {AssetAuditResult} the result for a project that did not opt in */
export function assetAuditDisabled() {
  return { enabled: false, ran: false, strict: false, notes: [], summary: null, top: [], reported: 0, strictFailed: false, script: null };
}

/**
 * Read the settings from `doctor.assetAudit` in `.waffle/waffle.yaml` (+ the local overlay unless
 * `canonical`) and the `WAFFLESTACK_ASSET_AUDIT` env override. A missing or unreadable config just
 * means "env only": this check never adds a failure mode of its own.
 *
 * @param {{ cwd: string, canonical?: boolean, strictFlag?: boolean, env?: NodeJS.ProcessEnv, home?: string }} opts
 * @returns {AssetAuditSettings}
 */
export function resolveAssetAuditSettings({ cwd, canonical = false, strictFlag = false, env = process.env, home = os.homedir() }) {
  /** @type {string[]} */
  const notes = [];
  /** @type {any} */
  let block;
  try {
    const project = loadProjectConfig(cwd, [], { canonical });
    block = project.doctor && typeof project.doctor === 'object' ? project.doctor.assetAudit : undefined;
    if (lookupPath(project.values, 'doctor.assetAudit') !== undefined) {
      notes.push(`asset audit: \`config.doctor.assetAudit\` in ${CONFIG_FILE} is ignored — move it to a top-level \`doctor: { assetAudit: … }\` block (not under \`config:\`)`);
    }
  } catch {
    block = undefined;
  }

  let configScript = null;
  let strict = strictFlag;
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (block !== undefined && block !== null) {
    if (typeof block !== 'object' || Array.isArray(block)) {
      notes.push('asset audit: `doctor.assetAudit` must be a mapping with a `script:` path — ignored');
    } else {
      const unknown = Object.keys(block).filter((k) => !SETTING_KEYS.includes(k));
      if (unknown.length) notes.push(`asset audit: unknown key(s) under \`doctor.assetAudit\` ignored: ${unknown.join(', ')} (known: ${SETTING_KEYS.join(', ')})`);
      if (typeof block.script === 'string' && block.script.trim()) configScript = block.script.trim();
      else if (block.script !== undefined) notes.push('asset audit: `doctor.assetAudit.script` must be a non-empty path — ignored');
      if (block.strict === true) strict = true;
      else if (block.strict !== undefined && block.strict !== false) notes.push('asset audit: `doctor.assetAudit.strict` must be true or false — treated as false');
      if (block.timeoutSeconds !== undefined) {
        const t = block.timeoutSeconds;
        if (typeof t === 'number' && Number.isFinite(t) && t > 0) timeoutSeconds = t;
        else notes.push(`asset audit: \`doctor.assetAudit.timeoutSeconds\` must be a positive number — using ${DEFAULT_TIMEOUT_SECONDS}`);
      }
    }
  }

  const envScript = String(env[ASSET_AUDIT_ENV] ?? '').trim();
  const raw = envScript || configScript;
  const scriptSource = envScript ? 'env' : configScript ? 'config' : null;
  if (!raw && block && typeof block === 'object' && !Array.isArray(block) && block.script === undefined) {
    notes.push(`asset audit: \`doctor.assetAudit\` has no \`script:\` and ${ASSET_AUDIT_ENV} is unset — skipped`);
  }
  return {
    enabled: Boolean(raw),
    script: raw ? resolveScriptPath(raw, cwd, home) : null,
    scriptSource,
    strict: Boolean(raw) && strict,
    timeoutMs: Math.round(timeoutSeconds * 1000),
    notes,
  };
}

/**
 * `~` / `~/…` expand to the home directory; a relative path resolves against the project root.
 * @param {string} raw @param {string} cwd @param {string} home
 */
export function resolveScriptPath(raw, cwd, home) {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return path.resolve(cwd, raw);
}

/**
 * Run the audit read-only against `cwd` and summarize it. Never throws.
 *
 * @param {{ cwd: string, settings: AssetAuditSettings, python?: string, spawn?: typeof spawnSync }} opts
 * @returns {AssetAuditResult}
 */
export function runAssetAudit({ cwd, settings, python = 'python3', spawn = spawnSync }) {
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

  let isFile = false;
  try {
    isFile = fs.statSync(settings.script).isFile();
  } catch { /* reported below */ }
  if (!isFile) return skip(`script not found at ${settings.script} (from ${settings.scriptSource === 'env' ? ASSET_AUDIT_ENV : 'doctor.assetAudit.script'})`);

  // `-I` isolates Python from PYTHON* env vars, the user site and the current directory; `-B`
  // writes no bytecode. The audit itself never runs `git status` or anything that writes.
  const r = spawn(python, ['-I', '-B', settings.script, 'audit', cwd, '--json'], {
    cwd,
    encoding: 'utf8',
    timeout: settings.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const err = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
  if (err?.code === 'ENOENT') return skip(`${python} not found on PATH (the audit needs Python 3.9 or newer)`);
  if (err?.code === 'ETIMEDOUT' || (r.signal && r.status === null)) return skip(`timed out after ${settings.timeoutMs / 1000}s (raise doctor.assetAudit.timeoutSeconds)`);
  if (err) return skip(`could not start ${python}: ${err.message}`);
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
