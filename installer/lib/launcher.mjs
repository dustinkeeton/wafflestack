// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { LOCK_FILE, LEGACY_ROOT_LOCK_FILE, LEGACY_LOCK_FILE } from './project.mjs';
import { parseRepoSlug, httpsUrl, parseLsRemoteTags, gitLsRemoteTags, commitFromNpmLockfile } from './toolkit-ref.mjs';

/**
 * The launcher (#726): an installed `wafflestack` runs the toolkit commit the repo's lock pins,
 * fetched once into the user cache and re-exec'd. Trust gate and decision order → AGENTS.md "Launcher".
 *
 * @typedef {{ kind: 'pin', source: string, commit: string, ref: string|null, version: string|null }} Pin
 * @typedef {Pin | { kind: 'none', reason: string } | { kind: 'malformed', reason: string }} PinResult
 * @typedef {{ schema: number, source: string, commit: string, tag: string|null, trust: 'tagged'|'approved',
 *   version: string|null, resolved: string|null, toolkitRoot: string, fetchedAt: string, fetchedBy: string|null }} LauncherRecord
 * @typedef {LauncherRecord & { dir: string, cli: string }} CacheEntry
 * @typedef {{ status: number|null, stderr: string }} NpmResult
 * @typedef {(args: string[], opts: { cwd: string, env: NodeJS.ProcessEnv }) => NpmResult} RunNpm
 * @typedef {{ code: number|null, signal: NodeJS.Signals|null }} ChildExit
 * @typedef {{ action: 'continue', note: string|null }
 *   | { action: 'refuse', message: string }
 *   | { action: 'run', entry: CacheEntry }
 *   | { action: 'fetch', pin: Pin, tag: string|null, trust: 'tagged'|'approved', note: string|null }
 *   | { action: 'ask', pin: Pin, reason: string }} Decision
 */

export const LAUNCHER_RECORD = 'launcher.json';
export const LAUNCHER_RECORD_SCHEMA = 1;
export const LAUNCHED_ENV = 'WAFFLESTACK_LAUNCHED';
export const NO_FOLLOW_ENV = 'WAFFLESTACK_NO_FOLLOW_LOCK';
export const NO_FOLLOW_FLAG = '--no-follow-lock';
export const DEFAULT_TRUSTED_SOURCES = Object.freeze(['github:dustinkeeton/wafflestack']);
export const TOOLKIT_SUBDIR = path.join('node_modules', 'wafflestack');
export const FOLLOW_COMMANDS = Object.freeze([
  'setup', 'init', 'list', 'toggle', 'install', 'render', 'bake', 'doctor', 'state', 'config', 'report', 'eject', 'uninstall', 'reinstall',
]);
const SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const STALE_TMP_MS = 60 * 60 * 1000;

/** `$XDG_CACHE_HOME/wafflestack`, else `~/.cache/wafflestack` — the root `toolkits/<sha>/` lives under. */
export function defaultLauncherCacheDir(env = process.env) {
  const xdg = env.XDG_CACHE_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache'), 'wafflestack');
}

/** User-level config (never repo config): `$XDG_CONFIG_HOME/wafflestack/config.json`, else `~/.config/…`. */
export function defaultLauncherConfigFile(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config'), 'wafflestack', 'config.json');
}

/**
 * The committed lock nearest `cwd`, walking up to the filesystem root. Never the local lock.
 *
 * @param {string} cwd
 * @param {{ exists?: (p: string) => boolean }} [io]
 * @returns {{ file: string, dir: string } | null}
 */
export function findLock(cwd, { exists = fs.existsSync } = {}) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    for (const name of [LOCK_FILE, LEGACY_ROOT_LOCK_FILE, LEGACY_LOCK_FILE]) {
      const file = path.join(dir, name);
      if (exists(file)) return { file, dir };
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** `github:Owner/Repo` → `github:owner/repo`; anything not a plain GitHub slug → null. @param {unknown} s */
export function normalizeSource(s) {
  if (typeof s !== 'string' || !/^github:/i.test(s.trim()) || s.trim().slice(7).startsWith('-')) return null;
  const slug = parseRepoSlug(s.trim());
  if (!slug || !/^[\w.-]+$/.test(slug.owner) || !/^[\w.-]+$/.test(slug.repo)) return null;
  return `github:${slug.owner}/${slug.repo}`.toLowerCase();
}

/**
 * @param {string} lockFile
 * @param {{ readFile?: (p: string) => string }} [io]
 * @returns {PinResult}
 */
export function readPin(lockFile, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let lock;
  try {
    lock = JSON.parse(readFile(lockFile));
  } catch (err) {
    return { kind: 'malformed', reason: `cannot parse ${lockFile}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const t = lock && typeof lock === 'object' ? lock.toolkit : null;
  if (!t || typeof t !== 'object') return { kind: 'none', reason: 'the lock records no toolkit pin' };
  if (t.status !== 'release') return { kind: 'none', reason: `the lock records toolkit status ${t.status ?? 'unknown'}` };
  if (t.commit == null || t.source == null) return { kind: 'none', reason: 'the lock records no toolkit commit or source' };
  if (typeof t.commit !== 'string' || !SHA.test(t.commit)) return { kind: 'malformed', reason: `toolkit.commit ${JSON.stringify(t.commit)} is not a 40-character sha` };
  const source = normalizeSource(t.source);
  if (!source) return { kind: 'malformed', reason: `toolkit.source ${JSON.stringify(t.source)} is not github:<owner>/<repo>` };
  const ref = typeof t.ref === 'string' && t.ref ? t.ref : null;
  const version = typeof lock.toolkitVersion === 'string' ? lock.toolkitVersion : null;
  return { kind: 'pin', source, commit: t.commit, ref, version };
}

/**
 * The default trusted source plus the user config's `trustedSources` (additive; a malformed file adds nothing).
 *
 * @param {{ file?: string, readFile?: (p: string) => string }} [opts]
 * @returns {{ sources: string[], warning: string|null }}
 */
export function trustedSources({ file = defaultLauncherConfigFile(), readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const sources = new Set(DEFAULT_TRUSTED_SOURCES);
  let text;
  try {
    text = readFile(file);
  } catch {
    return { sources: [...sources], warning: null };
  }
  try {
    const doc = JSON.parse(text);
    const list = doc?.trustedSources ?? [];
    if (!Array.isArray(list)) throw new Error('trustedSources must be an array');
    for (const s of list) {
      const n = normalizeSource(s);
      if (!n) throw new Error(`${JSON.stringify(s)} is not github:<owner>/<repo>`);
      sources.add(n);
    }
    return { sources: [...sources], warning: null };
  } catch (err) {
    return { sources: [...DEFAULT_TRUSTED_SOURCES], warning: `ignoring ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The `vX.Y.Z` tag IN `source` that points at exactly `commit`, or null. Throws when the lookup fails.
 *
 * @param {string} source normalized
 * @param {string} commit
 * @param {{ lsRemote?: (url: string) => string }} [io]
 * @returns {string|null}
 */
export function releaseTagFor(source, commit, { lsRemote = gitLsRemoteTags } = {}) {
  const slug = parseRepoSlug(source);
  if (!slug) return null;
  const tag = parseLsRemoteTags(lsRemote(httpsUrl(slug))).byCommit.get(commit) ?? null;
  return tag && RELEASE_TAG.test(tag) ? tag : null;
}

/**
 * A completed cache entry for `sha`, or null. Keyed by commit alone: the sha fixes the bytes.
 *
 * @param {string} root
 * @param {string} sha
 * @returns {CacheEntry|null}
 */
export function readCacheEntry(root, sha) {
  if (!SHA.test(sha)) return null;
  const dir = path.join(root, 'toolkits', sha);
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, LAUNCHER_RECORD), 'utf8'));
    const cli = path.join(dir, TOOLKIT_SUBDIR, 'installer', 'cli.mjs');
    if (rec?.schema !== LAUNCHER_RECORD_SCHEMA || rec.commit !== sha || !fs.existsSync(cli)) return null;
    return { ...rec, dir, cli };
  } catch {
    return null;
  }
}

/** @param {string} root @returns {{ source: string, commit: string, approvedAt: string }[]} */
export function readApprovals(root) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'launcher-approvals.json'), 'utf8'));
    return Array.isArray(doc?.approved) ? doc.approved.filter((/** @type {any} */ a) => a && typeof a.source === 'string' && typeof a.commit === 'string') : [];
  } catch {
    return [];
  }
}

/** @param {string} root @param {{ source: string, commit: string }} pair @param {() => Date} [now] */
export function recordApproval(root, { source, commit }, now = () => new Date()) {
  const approved = readApprovals(root).filter((a) => !(a.source === source && a.commit === commit));
  approved.push({ source, commit, approvedAt: now().toISOString() });
  writeJsonAtomic(path.join(root, 'launcher-approvals.json'), { approved });
}

/** @param {string} file @param {unknown} doc */
function writeJsonAtomic(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** @type {RunNpm} */
export function defaultRunNpm(args, { cwd, env }) {
  const execpath = env.npm_execpath;
  const viaNode = execpath && /\.c?js$/.test(execpath);
  const cmd = viaNode ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(cmd, viaNode ? [execpath, ...args] : args, {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], shell: !viaNode && process.platform === 'win32',
  });
  return { status: r.status, stderr: r.error ? r.error.message : String(r.stderr ?? '') };
}

/**
 * Install `source#commit` with npm into `<root>/toolkits/<commit>/` (an npx-shaped layout, so the
 * child's own provenance resolves) and write `launcher.json` last. Returns the completed entry.
 *
 * @param {{ root: string, source: string, commit: string, tag: string|null, trust: 'tagged'|'approved',
 *   fetchedBy?: string|null, runNpm?: RunNpm, env?: NodeJS.ProcessEnv, now?: () => Date }} opts
 * @returns {CacheEntry}
 */
export function fetchToolkit({ root, source, commit, tag, trust, fetchedBy = null, runNpm = defaultRunNpm, env = process.env, now = () => new Date() }) {
  const slug = parseRepoSlug(source);
  if (!slug || !SHA.test(commit)) throw new Error(`refusing to fetch ${source}#${commit}`);
  const toolkits = path.join(root, 'toolkits');
  fs.mkdirSync(toolkits, { recursive: true, mode: 0o700 });
  sweepStaleTmp(toolkits, now().getTime());
  const tmp = path.join(toolkits, `.tmp-${commit}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    const spec = `github:${slug.owner}/${slug.repo}#${commit}`;
    const r = runNpm(['install', '--prefix', tmp, '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev', spec], {
      cwd: tmp, env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.status !== 0) throw new Error(`npm install ${spec} failed${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
    const toolkitDir = path.join(tmp, TOOLKIT_SUBDIR);
    const pkg = JSON.parse(fs.readFileSync(path.join(toolkitDir, 'package.json'), 'utf8'));
    if (pkg?.name !== 'wafflestack') throw new Error(`${spec} is not a wafflestack package (name ${JSON.stringify(pkg?.name)})`);
    const got = commitFromNpmLockfile(toolkitDir, 'wafflestack');
    if (got !== commit) throw new Error(`npm resolved ${spec} to ${got ?? 'an unknown commit'}, not ${commit}`);
    if (!fs.existsSync(path.join(toolkitDir, 'installer', 'cli.mjs'))) throw new Error(`${spec} has no installer/cli.mjs`);
    /** @type {LauncherRecord} */
    const record = {
      schema: LAUNCHER_RECORD_SCHEMA, source, commit, tag, trust,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      resolved: hiddenLockResolved(tmp),
      toolkitRoot: TOOLKIT_SUBDIR.split(path.sep).join('/'),
      fetchedAt: now().toISOString(), fetchedBy,
    };
    fs.writeFileSync(path.join(tmp, LAUNCHER_RECORD), `${JSON.stringify(record, null, 2)}\n`);
    return settle(tmp, root, commit);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Rename tmp → final; a concurrent winner is kept, a half-written final dir is replaced once. */
function settle(/** @type {string} */ tmp, /** @type {string} */ root, /** @type {string} */ commit) {
  const final = path.join(root, 'toolkits', commit);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, final);
      break;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw err;
      const winner = readCacheEntry(root, commit);
      if (winner) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return winner;
      }
      if (attempt) throw err;
      fs.rmSync(final, { recursive: true, force: true });
    }
  }
  const entry = readCacheEntry(root, commit);
  if (!entry) throw new Error(`cache entry for ${commit} is incomplete after fetch`);
  return entry;
}

/** @param {string} prefix @returns {string|null} */
function hiddenLockResolved(prefix) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '.package-lock.json'), 'utf8'));
    const r = lock?.packages?.['node_modules/wafflestack']?.resolved;
    return typeof r === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** @param {string} toolkits @param {number} nowMs */
function sweepStaleTmp(toolkits, nowMs) {
  try {
    for (const name of fs.readdirSync(toolkits)) {
      if (!name.startsWith('.tmp-')) continue;
      const p = path.join(toolkits, name);
      if (nowMs - fs.statSync(p).mtimeMs > STALE_TMP_MS) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    // A sweep failure leaves litter, never a failed launch.
  }
}

/**
 * Should this invocation run in-process, or under the lock's pinned toolkit? First match wins.
 *
 * @param {object} ctx
 * @param {string|undefined} ctx.command
 * @param {string[]} ctx.argv the full original argv after the node + script entries
 * @param {string} ctx.cwd the `--cwd` value (resolved)
 * @param {NodeJS.ProcessEnv} ctx.env
 * @param {boolean} ctx.noFollow
 * @param {() => { origin: string, commit: string|null, version: string }} ctx.identity lazily resolved, offline
 * @param {boolean} ctx.offline
 * @param {boolean} ctx.interactive
 * @param {string} ctx.root cache root
 * @param {() => { sources: string[], warning: string|null }} [ctx.trusted]
 * @param {(url: string) => string} [ctx.lsRemote]
 * @param {(p: string) => boolean} [ctx.exists]
 * @param {(p: string) => string} [ctx.readFile]
 * @param {string} [ctx.configFile] for the remedy text
 * @returns {Decision}
 */
export function decideFollow(ctx) {
  const { command, argv, env } = ctx;
  if (env[LAUNCHED_ENV]) return { action: 'continue', note: null };
  if (ctx.noFollow) return { action: 'continue', note: null };
  if (!command || !FOLLOW_COMMANDS.includes(command) || argv.includes('--help') || argv.includes('-h')) return { action: 'continue', note: null };
  const id = ctx.identity();
  if (id.origin === 'checkout') return { action: 'continue', note: null };
  const lock = findLock(ctx.cwd, { exists: ctx.exists });
  if (!lock) return { action: 'continue', note: `note: no ${LOCK_FILE} found from ${ctx.cwd} — running installed wafflestack ${id.version}` };
  const pin = readPin(lock.file, ctx.readFile ? { readFile: ctx.readFile } : {});
  if (pin.kind === 'none') return { action: 'continue', note: `note: ${pin.reason} — running installed wafflestack ${id.version}` };
  if (pin.kind === 'malformed') {
    return { action: 'refuse', message: `wafflestack: refusing to run — ${lock.file} has a malformed toolkit pin: ${pin.reason}. Fix the lock (\`wafflestack upgrade\` rewrites it), or pass ${NO_FOLLOW_FLAG} to run the installed ${id.version}.` };
  }
  if (id.commit === pin.commit) return { action: 'continue', note: null };
  const cached = readCacheEntry(ctx.root, pin.commit);
  if (cached) return { action: 'run', entry: cached };
  const label = `${pin.source}@${pin.commit.slice(0, 12)}${pin.ref ? ` (${pin.ref})` : ''}`;
  if (ctx.offline) {
    return { action: 'refuse', message: `wafflestack: the lock pins toolkit ${label}, which is not cached, and --offline is set — run once online to fetch it, or pass ${NO_FOLLOW_FLAG} to run the installed ${id.version}.` };
  }
  const trusted = (ctx.trusted ?? (() => trustedSources()))();
  let reason;
  if (!trusted.sources.includes(pin.source)) {
    reason = `${pin.source} is not a trusted source (trusted: ${trusted.sources.join(', ')})`;
  } else {
    try {
      const tag = releaseTagFor(pin.source, pin.commit, ctx.lsRemote ? { lsRemote: ctx.lsRemote } : {});
      if (tag) {
        const note = pin.ref && pin.ref !== tag ? `note: the lock names ${pin.ref}, but ${pin.source} tags ${pin.commit.slice(0, 12)} as ${tag}` : null;
        return { action: 'fetch', pin, tag, trust: 'tagged', note };
      }
      reason = `no release tag in ${pin.source} points at ${pin.commit.slice(0, 12)}`;
    } catch (err) {
      reason = `could not list ${pin.source}'s release tags: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (readApprovals(ctx.root).some((a) => a.source === pin.source && a.commit === pin.commit)) {
    return { action: 'fetch', pin, tag: null, trust: 'approved', note: null };
  }
  if (ctx.interactive) return { action: 'ask', pin, reason };
  return {
    action: 'refuse',
    message: [
      `wafflestack: the lock pins toolkit ${label}, which the installed wafflestack ${id.version} will not run: ${reason}.`,
      `  - trust the source: add "${pin.source}" to "trustedSources" in ${ctx.configFile ?? defaultLauncherConfigFile(env)}`,
      `  - run the installed version instead: ${NO_FOLLOW_FLAG} (or ${NO_FOLLOW_ENV}=1)`,
      '  - or move the pin to the installed version: wafflestack upgrade',
    ].join('\n'),
  };
}

/**
 * May the launcher prompt? A real TTY on stdin and stderr, not CI, and neither `--yes` nor `--untrusted-config`.
 *
 * @param {{ argv: string[], env: NodeJS.ProcessEnv, stdinTTY?: boolean, stderrTTY?: boolean }} opts
 */
export function isInteractive({ argv, env, stdinTTY = Boolean(process.stdin.isTTY), stderrTTY = Boolean(process.stderr.isTTY) }) {
  const ci = String(env.CI ?? '').trim().toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return false;
  return stdinTTY && stderrTTY && !argv.includes('--yes') && !argv.includes('--untrusted-config');
}

/** Ask a y/N question on stderr. @param {string} question @returns {Promise<boolean>} */
export function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/**
 * Run the cached toolkit with the same argv and stdio; the parent ignores SIGINT/SIGTERM meanwhile.
 *
 * @param {{ entry: CacheEntry, argv: string[], env: NodeJS.ProcessEnv, spawnChild?: typeof spawn }} opts
 * @returns {Promise<ChildExit>}
 */
export function reexec({ entry, argv, env, spawnChild = spawn }) {
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);
  const done = () => {
    process.off('SIGINT', ignore);
    process.off('SIGTERM', ignore);
  };
  return new Promise((resolve) => {
    const child = spawnChild(process.execPath, [entry.cli, ...argv], { stdio: 'inherit', env: { ...env, [LAUNCHED_ENV]: entry.commit } });
    child.on('error', (err) => {
      done();
      process.stderr.write(`wafflestack: could not start the pinned toolkit ${entry.cli}: ${err.message}\n`);
      resolve({ code: 1, signal: null });
    });
    child.on('exit', (code, signal) => {
      done();
      resolve({ code, signal });
    });
  });
}

/** The exit code a child's `(code, signal)` maps to — 128 + signal number, as a shell reports it. @param {ChildExit} r */
export function exitCodeOf({ code, signal }) {
  if (signal) return 128 + (os.constants.signals[signal] ?? 0);
  return code ?? 1;
}

/**
 * Execute `decideFollow`: notes and refusals to stderr, prompt, fetch, re-exec.
 * `{ action: 'continue' }` means the caller dispatches in-process; otherwise exit with `code`.
 *
 * @param {Parameters<typeof decideFollow>[0] & { version?: string, prompt?: (q: string) => Promise<boolean>,
 *   runNpm?: RunNpm, spawnChild?: typeof spawn, stderr?: (s: string) => void }} ctx
 * @returns {Promise<{ action: 'continue' } | { action: 'exit', code: number }>}
 */
export async function followLock(ctx) {
  const say = ctx.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  let decision = decideFollow(ctx);
  if (decision.action === 'continue') {
    if (decision.note) say(decision.note);
    return { action: 'continue' };
  }
  if (decision.action === 'refuse') {
    say(decision.message);
    return { action: 'exit', code: 1 };
  }
  if (decision.action === 'ask') {
    const { pin, reason } = decision;
    const ok = await (ctx.prompt ?? promptYesNo)(
      `wafflestack: this repo's lock pins toolkit ${pin.source}@${pin.commit} — ${reason}.\nFetch and run that commit (it executes on this machine)? [y/N] `,
    );
    if (!ok) {
      say(`wafflestack: not running ${pin.source}@${pin.commit.slice(0, 12)} — pass ${NO_FOLLOW_FLAG} to run the installed version.`);
      return { action: 'exit', code: 1 };
    }
    recordApproval(ctx.root, pin);
    decision = { action: 'fetch', pin, tag: null, trust: 'approved', note: null };
  }
  let entry;
  if (decision.action === 'fetch') {
    if (decision.note) say(decision.note);
    const { pin, tag, trust } = decision;
    say(`wafflestack: fetching pinned toolkit ${pin.source}@${pin.commit.slice(0, 12)}${tag ? ` (${tag})` : ''} into ${path.join(ctx.root, 'toolkits')}`);
    try {
      entry = fetchToolkit({ root: ctx.root, source: pin.source, commit: pin.commit, tag, trust, fetchedBy: ctx.version ?? null, runNpm: ctx.runNpm, env: ctx.env });
    } catch (err) {
      say(`wafflestack: could not fetch the pinned toolkit: ${err instanceof Error ? err.message : String(err)} — pass ${NO_FOLLOW_FLAG} to run the installed version.`);
      return { action: 'exit', code: 1 };
    }
  } else {
    entry = decision.entry;
  }
  const exit = await reexec({ entry, argv: ctx.argv.filter((a) => a !== NO_FOLLOW_FLAG), env: ctx.env, spawnChild: ctx.spawnChild });
  return { action: 'exit', code: exitCodeOf(exit) };
}
