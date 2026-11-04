// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sha256, exists, readYaml, resolveWritableInside } from './util.mjs';
import { renderProject, readLock, readLocalLock, readTreeLock } from './render.mjs';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  LOCK_FILE,
  LOCAL_LOCK_FILE,
  EXTENSIONS_DIR,
  resolveConfigFile,
  resolveLocalConfigFile,
  resolveLockFile,
  localLockPath,
  loadProjectConfig,
  gitIgnoreStatus,
} from './project.mjs';
import { toolkitPinFromLock, parseRepoSlug, httpsUrl } from './toolkit-ref.mjs';
import { isDeepStrictEqual } from 'node:util';
import { settingsConflicts, applySettings, settingsValueAt, parseSettingsKey, lockKeys } from './settings.mjs';
import { defaultSourceCacheDir, resolveSource, gitFetchCheckout } from './sources.mjs';

/**
 * Worktree provisioning (#820): lay the lock-described harness resources of ONE checkout into that
 * checkout, before an agent session starts there. Reads the destination's own committed config,
 * extensions and lock; stages a render in a temp dir; copies only the harness artifacts
 * (`.claude/`, `.codex/`, `.agents/` for the enabled targets, plus the lock-managed
 * `.claude/settings.json` entries) that are missing or stale; refuses on any conflict before
 * writing a byte; validates every artifact after writing. The committed lock, `.github/`
 * payloads, generated `.waffle/` docs, project-owned files and the git index are never touched.
 *
 * @typedef {'local'|'main'|'none'} OverlayMode
 * @typedef {{ path: string, reason: string }} Conflict
 * @typedef {object} PrepareResult
 * @property {'ready'|'no-op'|'failed'} status
 * @property {string} cwd
 * @property {{ toplevel: string|null, linked: boolean, mainCheckout: string|null }} checkout
 * @property {string[]} targets
 * @property {{ version: string|null, ref: string|null, status: string|null, from: 'running'|'cache'|'fetch'|null }} pin  `from`: which toolkit rendered — the running CLI, the lock's pinned release served from the source cache, or fetched into it
 * @property {{ mode: OverlayMode|null, source: string|null, effective: 'canonical'|'overlay'|null, file: string|null }} overlay
 * @property {string[]} generated   harness paths written by this run
 * @property {string[]} refreshed   lock-tracked paths rewritten from an older render of the same lock
 * @property {string[]} pruned      paths an earlier preparation wrote that this lock no longer renders, removed unchanged
 * @property {number} present       harness paths already matching
 * @property {string[]} settings    settings keys written by this run
 * @property {Conflict[]} conflicts
 * @property {{ checked: boolean, uncovered: string[] }} ignore
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {string[]} notes
 */

/** @type {OverlayMode[]} */
export const OVERLAY_MODES = ['local', 'main', 'none'];
/** Top-level consumer config key: `worktrees: { overlay: main }`. */
export const WORKTREES_KEY = 'worktrees';
/** Lock-file name, resolved through `git rev-parse --git-path` so it lives in the worktree's git dir. */
export const PREPARE_LOCK = 'wafflestack-prepare.lock';
/** Per-worktree record of the hashes `prepareWorktree` wrote (same git-path home): a later run may refresh those files. */
export const PREPARED_MANIFEST = 'wafflestack-prepared.json';
/** Output dirs that are harness resources, per target. `.codex/` holds agents only; its skills share `.agents/`. */
export const HARNESS_DIRS = Object.freeze({ claude: ['.claude/'], codex: ['.codex/', '.agents/'], 'agents-dir': ['.agents/'] });
/** The first release that ships `prepare-worktree` — the floor a host recipe checks a lock pin against. */
export const PREPARE_WORKTREE_SINCE = '0.20.0';

/** @typedef {(cwd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: Error }} RunGit */

/**
 * The toolkit that provisions `lock`: the running CLI when its version — and, for a release, its
 * tag and commit — are the lock's; otherwise the lock's own release pin, served from the source cache
 * or cloned into it once (never when offline). A lock with no release pin can only be provisioned by
 * a CLI at its version. Every refusal names the pinned command the caller can run instead.
 *
 * @param {{ lock: any, cwd: string, toolkitRoot: string, toolkitVersion: string, toolkitIdentity?: any, offline?: boolean, sourceCacheDir?: string, resolve?: typeof resolveSource }} args
 * @returns {{ root: string, version: string, identity: any, from: 'running'|'cache'|'fetch' } | { error: string }}
 */
export function resolvePinnedToolkit({ lock, cwd, toolkitRoot, toolkitVersion, toolkitIdentity = null, offline = false, sourceCacheDir = defaultSourceCacheDir(), resolve = resolveSource }) {
  const pin = toolkitPinFromLock(lock);
  const t = lock?.toolkit ?? {};
  const sameVersion = lock?.toolkitVersion === toolkitVersion;
  const releaseMismatch = Boolean(pin && toolkitIdentity?.status === 'release' && (toolkitIdentity.tag !== t.ref || (t.commit && toolkitIdentity.commit && toolkitIdentity.commit !== t.commit)));
  if (sameVersion && !releaseMismatch) return { root: toolkitRoot, version: toolkitVersion, identity: toolkitIdentity, from: 'running' };
  const running = `wafflestack ${toolkitVersion}${toolkitIdentity?.tag ? ` (${toolkitIdentity.tag})` : ''}`;
  const rendered = `${lock?.toolkitVersion ?? 'an unversioned toolkit'}${pin ? ` (${pin})` : ''}`;
  if (!pin) {
    return { error: `this CLI is ${running}, but ${LOCK_FILE} was rendered by ${rendered} and records no release pin (toolkit status: ${t.status ?? 'not recorded'}) — a worktree is provisioned by the toolkit its lock pins, never by whichever CLI happens to run; from the main checkout run \`wafflestack upgrade\` with a release of the toolkit, commit the lock, and prepare again — or, for the toolkit's own checkout, run its installer with --allow-unreleased` };
  }
  const remedy = `run the pinned toolkit yourself:\n  npx --yes ${pin} prepare-worktree --cwd "${cwd}"`;
  const slug = parseRepoSlug(t.source);
  if (!slug) return { error: `this CLI is ${running}, but ${LOCK_FILE} was rendered by ${rendered}, whose source is not a GitHub repository this CLI can fetch — ${remedy}` };
  let fetched = false;
  const gitFetch = offline
    ? () => { throw new Error('offline, and the pinned release is not in the source cache'); }
    : (/** @type {string} */ src, /** @type {string} */ ref, /** @type {string} */ dest) => { fetched = true; gitFetchCheckout(src, ref, dest); };
  let resolved;
  try {
    resolved = resolve({ name: `wafflestack ${t.ref}`, source: httpsUrl(slug), sourceType: 'git', ref: t.ref }, { cacheDir: sourceCacheDir, gitFetch });
  } catch (err) {
    return { error: `this CLI is ${running}, but ${LOCK_FILE} was rendered by ${rendered}; resolving that release failed (${/** @type {Error} */ (err).message}) — ${offline ? 'go online once so it can be fetched into the source cache, or ' : ''}${remedy}` };
  }
  if (t.commit && resolved.commit && resolved.commit !== t.commit) {
    return { error: `${LOCK_FILE} pins ${pin} at commit ${String(t.commit).slice(0, 12)}, but that tag resolves to ${resolved.commit.slice(0, 12)} on ${httpsUrl(slug)} — the tag moved; re-render from a release you trust and commit the lock` };
  }
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(resolved.root, 'package.json'), 'utf8')).version;
  } catch { /* reported below */ }
  if (version !== lock.toolkitVersion) {
    return { error: `${LOCK_FILE} pins ${pin} and says version ${lock.toolkitVersion}, but the toolkit at that tag is version ${version ?? 'unknown'} — the lock is inconsistent; re-render from a release you trust and commit the lock` };
  }
  return { root: resolved.root, version, identity: null, from: fetched ? 'fetch' : 'cache' };
}

/** @type {RunGit} */
export function defaultRunGit(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error };
}

/**
 * Where a checkout sits in its repository, resolved through git (a `.git` file, an external or a
 * nested linked worktree all answer alike). `mainCheckout` is the common dir's parent when that
 * dir is a `.git`; null for a bare or relocated repository.
 *
 * @param {string} cwd
 * @param {RunGit} [runGit]
 * @returns {{ toplevel: string, gitDir: string, commonDir: string, linked: boolean, mainCheckout: string|null } | { error: string }}
 */
export function checkoutInfo(cwd, runGit = defaultRunGit) {
  const ask = (/** @type {string} */ flag) => {
    const r = runGit(cwd, ['rev-parse', flag]);
    if (r.error || r.status !== 0) return null;
    const out = r.stdout.trim();
    return out ? path.resolve(cwd, out) : null;
  };
  const toplevel = ask('--show-toplevel');
  const gitDir = ask('--git-dir');
  const commonDir = ask('--git-common-dir');
  if (!toplevel || !gitDir || !commonDir) return { error: `${cwd} is not inside a git work tree (git rev-parse failed)` };
  const real = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const common = real(commonDir);
  const linked = real(gitDir) !== common;
  const mainCheckout = path.basename(common) === '.git' ? path.dirname(common) : null;
  return { toplevel: real(toplevel), gitDir: real(gitDir), commonDir: common, linked, mainCheckout };
}

/**
 * Which overlay feeds the staged render. Precedence: the CLI flag, the main checkout's own
 * overlay (`worktrees.overlay` — the machine whose private values would be imported is the one
 * that opts in), the destination's config, then `local`. Only the flag and the main overlay may say
 * `main`: a committed config must not pull a teammate's private overlay into their render.
 *
 * @param {{ flag?: string|null, mainOverlayRaw?: any, projectRaw?: any, destOverlayRaw?: any }} args
 * @returns {{ mode: OverlayMode, source: 'flag'|'main-overlay'|'config'|'default' } | { error: string }}
 */
export function resolveOverlayPolicy({ flag = null, mainOverlayRaw = null, projectRaw = null, destOverlayRaw = null }) {
  const valid = (/** @type {unknown} */ v) => typeof v === 'string' && OVERLAY_MODES.includes(/** @type {OverlayMode} */ (v));
  const bad = (/** @type {unknown} */ v, /** @type {string} */ where) =>
    `${where}: \`${WORKTREES_KEY}.overlay\` must be one of ${OVERLAY_MODES.join(', ')} (got ${JSON.stringify(v)})`;
  if (flag !== null) {
    if (!valid(flag)) return { error: `--overlay must be one of ${OVERLAY_MODES.join(', ')} (got ${JSON.stringify(flag)})` };
    return { mode: /** @type {OverlayMode} */ (flag), source: 'flag' };
  }
  const layers = /** @type {const} */ ([
    [mainOverlayRaw, 'main-overlay', `the main checkout's ${LOCAL_CONFIG_FILE}`],
    [destOverlayRaw, 'config', LOCAL_CONFIG_FILE],
    [projectRaw, 'config', CONFIG_FILE],
  ]);
  for (const [raw, source, where] of layers) {
    const v = raw?.[WORKTREES_KEY]?.overlay;
    if (v === undefined || v === null) continue;
    if (!valid(v)) return { error: bad(v, where) };
    if (v === 'main' && source !== 'main-overlay') {
      return { error: `${where}: \`${WORKTREES_KEY}.overlay: main\` is accepted only from the main checkout's own ${LOCAL_CONFIG_FILE} or the --overlay flag — a config that travels with the branch may not opt a private overlay in` };
    }
    return { mode: v, source };
  }
  return { mode: 'local', source: 'default' };
}

/**
 * Is a rendered path a harness resource for these targets? Settings keys are judged by their file.
 *
 * @param {string} rel
 * @param {string[]} targets
 */
export function isHarnessPath(rel, targets) {
  const file = parseSettingsKey(rel)?.file ?? rel;
  return targets.some((t) => (HARNESS_DIRS[/** @type {keyof typeof HARNESS_DIRS} */ (t)] ?? []).some((d) => file.startsWith(d)));
}

/** @param {any} lock @returns {Record<string, string>} files + stringified settings, as `--verify-render` compares them */
const lockManifest = (lock) => ({
  ...(lock?.files ?? {}),
  ...Object.fromEntries(Object.entries(lock?.settings ?? {}).map(([k, v]) => [k, JSON.stringify(v)])),
});

/**
 * Render the destination's committed inputs (plus `overlayFile`, when given) in a temp dir and
 * read the result back. Nothing in `cwd` is touched; `sourceBaseDir: cwd` keeps a relative
 * external `source:` resolving against the real checkout.
 *
 * @param {{ cwd: string, toolkitRoot: string, toolkitVersion: string, toolkitIdentity: any, overlayFile: string|null, untrustedConfig: boolean, sourceCacheDir: string }} args
 * @returns {{ ok: true, canonical: any, tree: any, files: Map<string, Buffer>, overlayChanged: boolean } | { ok: false, errors: string[] }}
 */
export function stageRender({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity, overlayFile, untrustedConfig, sourceCacheDir }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wafflestack-prepare-'));
  try {
    const copy = (/** @type {string} */ from, /** @type {string} */ to) => {
      const dest = path.join(tmp, to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(from, dest, { recursive: true });
    };
    copy(resolveConfigFile(cwd).file, CONFIG_FILE);
    const extensions = path.join(cwd, EXTENSIONS_DIR);
    if (exists(extensions)) copy(extensions, EXTENSIONS_DIR);
    copy(resolveLockFile(cwd).file, LOCK_FILE);
    if (overlayFile) copy(overlayFile, LOCAL_CONFIG_FILE);
    const rendered = renderProject({ toolkitRoot, cwd: tmp, sourceBaseDir: cwd, toolkitVersion, toolkitIdentity, sourceCacheDir, refreshSources: false, untrustedConfig });
    if (!rendered.ok) return { ok: false, errors: rendered.errors.map((e) => `staged render failed: ${e}`) };
    const canonical = readLock(tmp);
    const local = readLocalLock(tmp);
    const tree = local ?? canonical;
    const files = new Map();
    for (const rel of Object.keys(tree?.files ?? {})) files.set(rel, fs.readFileSync(path.join(tmp, rel)));
    return { ok: true, canonical, tree, files, overlayChanged: local !== null };
  } catch (err) {
    return { ok: false, errors: [`could not stage the render: ${/** @type {Error} */ (err).message}`] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {string} cwd @param {RunGit} runGit @param {string} name @returns {string|null} */
function gitPath(cwd, runGit, name) {
  const r = runGit(cwd, ['rev-parse', '--git-path', name]);
  return r.error || r.status !== 0 ? null : path.resolve(cwd, r.stdout.trim());
}

/** @param {string} file @returns {any} */
function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Hold the per-worktree preparation lock while `fn` runs. A live holder refuses; a dead one is taken over.
 *
 * @template T
 * @param {string} cwd @param {RunGit} runGit @param {() => T} fn
 * @returns {T | { error: string }}
 */
function withPrepareLock(cwd, runGit, fn) {
  const lockFile = gitPath(cwd, runGit, PREPARE_LOCK);
  if (!lockFile) return { error: 'could not locate the git dir to take the preparation lock' };
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const take = () => {
    try {
      fs.writeFileSync(lockFile, payload, { flag: 'wx' });
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      return false;
    }
  };
  if (!take()) {
    let holder = { pid: NaN, startedAt: 'unknown' };
    try {
      holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch { /* unreadable: treated as stale below */ }
    if (pidAlive(holder.pid)) {
      return { error: `another preparation is running in this worktree (pid ${holder.pid}, started ${holder.startedAt}) — wait for it, or remove ${lockFile} if that process is gone` };
    }
    fs.rmSync(lockFile, { force: true });
    if (!take()) return { error: `could not take the preparation lock at ${lockFile}` };
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

/** @param {unknown} pid */
function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/** Remove `dir` and each parent it leaves empty, stopping below `cwd`. @param {string} cwd @param {string} dir */
function pruneEmptyDirs(cwd, dir) {
  const root = path.resolve(cwd);
  for (let d = path.resolve(dir); d !== root && d.startsWith(root + path.sep); d = path.dirname(d)) {
    try {
      if (fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch {
      return;
    }
  }
}

/** @param {string} abs @param {Buffer} content */
function writeAtomic(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  fs.renameSync(tmp, abs);
}

/** @param {string} file @returns {any} */
function readYamlIfPresent(file) {
  if (!exists(file)) return null;
  try {
    return readYaml(file) ?? {};
  } catch (err) {
    return { __error: /** @type {Error} */ (err).message };
  }
}

/**
 * Provision one checkout's harness resources from its own lock. See the module docblock; the
 * CLI prints the result and exits 1 on `failed`.
 *
 * @param {{ cwd: string, toolkitRoot: string, toolkitVersion: string, toolkitIdentity?: any, overlay?: string|null, untrustedConfig?: boolean, offline?: boolean, sourceCacheDir?: string, runGit?: RunGit, resolve?: typeof resolveSource }} args
 * @returns {PrepareResult}
 */
export function prepareWorktree({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity = null, overlay = null, untrustedConfig = false, offline = false, sourceCacheDir = defaultSourceCacheDir(), runGit = defaultRunGit, resolve = resolveSource }) {
  cwd = path.resolve(cwd);
  /** @type {PrepareResult} */
  const result = {
    status: 'failed',
    cwd,
    checkout: { toplevel: null, linked: false, mainCheckout: null },
    targets: [],
    pin: { version: null, ref: null, status: null, from: null },
    overlay: { mode: null, source: null, effective: null, file: null },
    generated: [],
    refreshed: [],
    pruned: [],
    present: 0,
    settings: [],
    conflicts: [],
    ignore: { checked: false, uncovered: [] },
    errors: [],
    warnings: [],
    notes: [],
  };
  const fail = (/** @type {string[]} */ ...errors) => {
    result.errors.push(...errors);
    return result;
  };

  const git = checkoutInfo(cwd, runGit);
  if ('error' in git) return fail(git.error);
  result.checkout = { toplevel: git.toplevel, linked: git.linked, mainCheckout: git.mainCheckout };

  const cfgPath = resolveConfigFile(cwd);
  if (!exists(cfgPath.file)) {
    return fail(`${CONFIG_FILE} not found in ${cwd} — this checkout carries no wafflestack config; set it up in the main checkout, commit it, and bring the branch up to date`);
  }
  const lock = readLock(cwd);
  if (!lock) {
    return fail(`${LOCK_FILE} not found in ${cwd} — the lock describes what to provision; run \`wafflestack render\` in the main checkout, commit the lock, and bring the branch up to date`);
  }
  const pin = toolkitPinFromLock(lock);
  result.pin = { version: lock.toolkitVersion ?? null, ref: pin, status: lock.toolkit?.status ?? null, from: null };
  const toolkit = resolvePinnedToolkit({ lock, cwd, toolkitRoot, toolkitVersion, toolkitIdentity, offline, sourceCacheDir, resolve });
  if ('error' in toolkit) return fail(toolkit.error);
  result.pin.from = toolkit.from;
  if (toolkit.from !== 'running') result.notes.push(`rendered with the lock's pinned release ${pin}, ${toolkit.from === 'fetch' ? 'fetched into' : 'served from'} the source cache — this CLI (${toolkitVersion}) did not render`);
  if (pin && toolkit.from === 'running' && toolkitIdentity && toolkitIdentity.status !== 'release') {
    result.warnings.push(`the lock pins ${pin}, but this CLI is ${toolkitIdentity.status} at the same version — fine for toolkit development, otherwise run \`npx --yes ${pin} prepare-worktree\``);
  }

  /** @type {import('./project.mjs').ProjectConfig} */
  let project;
  try {
    project = loadProjectConfig(cwd, result.notes);
  } catch (err) {
    return fail(/** @type {Error} */ (err).message);
  }
  result.targets = project.targets;

  const projectRaw = readYamlIfPresent(cfgPath.file);
  const destOverlayFile = resolveLocalConfigFile(cwd).file;
  const destOverlayRaw = readYamlIfPresent(destOverlayFile);
  const mainOverlayFile = git.linked && git.mainCheckout ? path.join(git.mainCheckout, LOCAL_CONFIG_FILE) : null;
  const mainOverlayRaw = mainOverlayFile ? readYamlIfPresent(mainOverlayFile) : null;
  for (const [raw, where] of [[projectRaw, cfgPath.file], [destOverlayRaw, destOverlayFile], [mainOverlayRaw, mainOverlayFile]]) {
    if (raw?.__error) return fail(`${where} does not parse: ${raw.__error}`);
  }
  const policy = resolveOverlayPolicy({ flag: overlay, mainOverlayRaw, projectRaw, destOverlayRaw });
  if ('error' in policy) return fail(policy.error);
  result.overlay.mode = policy.mode;
  result.overlay.source = policy.source;

  /** @type {string|null} */
  let overlayFile = null;
  if (policy.mode !== 'none' && destOverlayRaw) overlayFile = destOverlayFile;
  else if (policy.mode === 'main' && git.linked && mainOverlayRaw) overlayFile = mainOverlayFile;
  if (untrustedConfig && policy.mode === 'main') {
    return fail('--untrusted-config refuses overlay policy `main`: a private overlay from another checkout never feeds a render of a tree you did not author — prepare with `--overlay none` or `local`');
  }
  if (policy.mode === 'main' && git.linked && !git.mainCheckout) {
    return fail(`--overlay main: this worktree's main checkout could not be resolved (git common dir ${git.commonDir} is not a \`.git\` directory)`);
  }
  if (mainOverlayRaw && overlayFile !== mainOverlayFile) {
    result.notes.push(
      `the main checkout (${git.mainCheckout}) has a private ${LOCAL_CONFIG_FILE}; overlay policy \`${policy.mode}\` (${policy.source}) leaves it out, so this worktree gets the canonical render — pass \`--overlay main\`, or set \`${WORKTREES_KEY}: { overlay: main }\` in that file, to render with it`,
    );
  }
  if (policy.mode === 'none' && destOverlayRaw) result.notes.push(`overlay policy \`none\`: this checkout's own ${LOCAL_CONFIG_FILE} is left out of the render`);
  result.overlay.file = overlayFile;

  const stagedRender = stageRender({ cwd, toolkitRoot: toolkit.root, toolkitVersion: toolkit.version, toolkitIdentity: toolkit.identity, overlayFile, untrustedConfig, sourceCacheDir });
  if ('errors' in stagedRender) return fail(...stagedRender.errors);
  const staged = stagedRender;
  result.overlay.effective = staged.overlayChanged ? 'overlay' : 'canonical';

  const committed = lockManifest(lock);
  const stagedCanonical = lockManifest(staged.canonical);
  const stale = Object.keys({ ...committed, ...stagedCanonical }).filter((k) => committed[k] !== stagedCanonical[k]).sort();
  if (stale.length) {
    return fail(
      `${LOCK_FILE} does not match what ${CONFIG_FILE} (+ ${EXTENSIONS_DIR}/) renders with ${toolkit.from === 'running' ? 'this toolkit' : `its pinned toolkit ${pin}`} (${stale.length} path(s): ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''}) — re-render in the main checkout, commit the lock, and bring the branch up to date`,
    );
  }

  const desiredFiles = [...staged.files.keys()].filter((rel) => isHarnessPath(rel, project.targets)).sort((a, b) => a.localeCompare(b));
  const desiredSettings = new Map(Object.entries(staged.tree?.settings ?? {}).filter(([k]) => isHarnessPath(k, project.targets)));
  const treeLock = readTreeLock(cwd);
  const destLocal = readLocalLock(cwd);

  const manifestFile = gitPath(cwd, runGit, PREPARED_MANIFEST);
  const manifest = manifestFile ? readJsonIfPresent(manifestFile) : null;
  /** @type {Record<string, string>} */
  const prepared = manifest?.files ?? {};
  /** @type {Record<string, unknown>} */
  const preparedSettings = manifest?.settings ?? {};
  const locked = withPrepareLock(cwd, runGit, plan);
  return 'status' in locked ? locked : fail(locked.error);

  /** Classify, refuse on conflicts, write, validate — under the preparation lock. */
  function plan() {
    /** @type {Conflict[]} */
    const conflicts = [];
    /** @type {{ rel: string, abs: string, kind: 'missing'|'stale' }[]} */
    const writes = [];
    let present = 0;
    for (const rel of desiredFiles) {
      const content = /** @type {Buffer} */ (staged.files.get(rel));
      const want = sha256(content);
      const abs = resolveWritableInside(cwd, rel);
      if (!abs) {
        conflicts.push({ path: rel, reason: 'resolves outside the checkout through a symlink' });
        continue;
      }
      let stat = null;
      try {
        stat = fs.lstatSync(abs);
      } catch { /* absent */ }
      if (!stat) {
        writes.push({ rel, abs, kind: 'missing' });
        continue;
      }
      if (stat.isDirectory()) {
        conflicts.push({ path: rel, reason: 'a directory sits where a file is rendered' });
        continue;
      }
      const have = sha256(fs.readFileSync(abs));
      if (have === want) {
        present++;
        continue;
      }
      const ours = new Set([lock.files?.[rel], destLocal?.files?.[rel], prepared[rel]].filter(Boolean));
      if (ours.has(have)) writes.push({ rel, abs, kind: 'stale' });
      else conflicts.push({ path: rel, reason: rel in (treeLock?.files ?? {}) ? 'a managed file with local edits (move them into .waffle/extensions/ or config, or restore it)' : 'an unmanaged file already exists at this path (move it aside, or eject the item to keep it)' });
    }

    const managedSettings = treeLock?.settings ?? {};
    // Settings entries follow the file rule: present+matching counts, absent is written, a value the
    // lock or an earlier run recorded is refreshed, any other value is a local edit and a conflict.
    /** @type {Record<string, boolean>} */
    const ownedSettings = {};
    /** @type {string[]} */
    const settingsToWrite = [];
    for (const [key, value] of desiredSettings) {
      const current = settingsValueAt(cwd, key);
      if (current === undefined) {
        settingsToWrite.push(key);
      } else if (isDeepStrictEqual(current, value)) {
        ownedSettings[key] = true;
      } else if ([managedSettings[key], preparedSettings[key]].some((v) => v !== undefined && isDeepStrictEqual(v, current))) {
        ownedSettings[key] = true;
        settingsToWrite.push(key);
      } else {
        conflicts.push({ path: key, reason: 'a lock-managed settings entry with local edits (restore it, or keep the change outside the managed key)' });
      }
    }
    // What an earlier preparation wrote and this lock no longer renders: removed when unchanged,
    // a conflict when edited — the manifest proves ownership, so nothing else is ever pruned.
    /** @type {{ rel: string, abs: string }[]} */
    const prunes = [];
    for (const rel of Object.keys(prepared)) {
      if (desiredFiles.includes(rel)) continue;
      const abs = resolveWritableInside(cwd, rel);
      if (!abs || !exists(abs)) {
        delete prepared[rel];
        continue;
      }
      if (sha256(fs.readFileSync(abs)) === prepared[rel]) prunes.push({ rel, abs });
      else conflicts.push({ path: rel, reason: 'written by an earlier preparation, no longer rendered by this lock, and edited since (move it aside)' });
    }
    /** @type {string[]} */
    const staleSettings = [];
    for (const key of Object.keys(preparedSettings)) {
      if (desiredSettings.has(key)) continue;
      const current = settingsValueAt(cwd, key);
      if (current === undefined) delete preparedSettings[key];
      else if (isDeepStrictEqual(current, preparedSettings[key])) staleSettings.push(key);
      else conflicts.push({ path: key, reason: 'written by an earlier preparation, no longer rendered by this lock, and edited since (restore or remove it)' });
    }
    const check = settingsConflicts(cwd, desiredSettings, ownedSettings);
    if (check.errors.length) return fail(...check.errors);
    for (const key of check.collisions) {
      if (!conflicts.some((c) => c.path === key)) conflicts.push({ path: key, reason: 'a settings entry already holds a different value not tracked by the lock' });
    }
    // Settings files and the local lock are written through their own paths, so they get the same
    // symlink containment check as every rendered file (a committed link could point them out of the tree).
    const settingsFiles = [...new Set([...settingsToWrite, ...staleSettings].map((k) => parseSettingsKey(k)?.file ?? k))].sort();
    const sideFiles = new Set([...desiredSettings.keys(), ...Object.keys(managedSettings)].map((k) => parseSettingsKey(k)?.file ?? k));
    if (staged.overlayChanged) sideFiles.add(LOCAL_LOCK_FILE);
    for (const file of [...sideFiles].sort()) {
      if (!resolveWritableInside(cwd, file)) conflicts.push({ path: file, reason: 'resolves outside the checkout through a symlink' });
    }

    const toWrite = writes.map((w) => w.rel);
    const localLockNeeded = staged.overlayChanged;
    const probe = [...toWrite, ...settingsFiles, ...(localLockNeeded ? [LOCAL_LOCK_FILE] : [])];
    const status = probe.length ? gitIgnoreStatus(cwd, probe) : null;
    if (probe.length && !status) result.notes.push('could not ask git whether the generated paths are ignored (git unavailable?) — check .gitignore covers them');
    if (status) {
      result.ignore.checked = true;
      const tracked = 'tracked by git, and the private overlay would change it — overlay-derived content never lands in tracked output (gitignore the render, or prepare with `--overlay none`)';
      const canonicalHash = (/** @type {string} */ rel) => staged.canonical?.files?.[rel];
      for (const rel of toWrite) {
        if (!status.tracked.has(rel)) continue;
        const want = sha256(/** @type {Buffer} */ (staged.files.get(rel)));
        if (want !== canonicalHash(rel)) conflicts.push({ path: rel, reason: tracked });
      }
      for (const key of settingsToWrite) {
        const file = parseSettingsKey(key)?.file ?? key;
        if (status.tracked.has(file) && !isDeepStrictEqual(desiredSettings.get(key), staged.canonical?.settings?.[key])) conflicts.push({ path: key, reason: tracked });
      }
      if (localLockNeeded && status.tracked.has(LOCAL_LOCK_FILE)) conflicts.push({ path: LOCAL_LOCK_FILE, reason: 'tracked by git — the local lock is private; `git rm --cached` it and gitignore it' });
      result.ignore.uncovered = probe.filter((p) => !status.tracked.has(p) && !status.ignored.has(p) && !status.beyondSymlink.has(p)).sort();
      if (result.ignore.uncovered.length) {
        result.warnings.push(
          `${result.ignore.uncovered.length} generated path(s) are neither tracked nor gitignored and would show as untracked: ${result.ignore.uncovered.slice(0, 5).join(', ')}${result.ignore.uncovered.length > 5 ? ', …' : ''} — add them to the committed .gitignore from the main checkout (\`wafflestack render --gitignore\` offers the recommended entries), or to \`git rev-parse --git-path info/exclude\`, which every linked worktree of this repository shares; nothing was added for you`,
        );
      }
    }

    if (conflicts.length) {
      result.conflicts = conflicts.sort((a, b) => a.path.localeCompare(b.path));
      return fail(`${conflicts.length} conflict(s) — nothing was written; resolve them and prepare again:`, ...result.conflicts.map((c) => `  ${c.path}: ${c.reason}`));
    }

    // Every write records what it replaced, so a failure part-way restores the tree as found.
    /** @type {[string, Buffer|null][]} */
    const undo = [];
    const snapshot = (/** @type {string} */ abs) => undo.push([abs, exists(abs) ? fs.readFileSync(abs) : null]);
    const restore = () => {
      for (const [abs, before] of undo.reverse()) {
        try {
          if (before === null) fs.rmSync(abs, { force: true });
          else fs.writeFileSync(abs, before);
        } catch { /* best effort: the validation below reports what is left */ }
      }
    };
    const localLockFile = localLockPath(cwd);
    try {
      for (const { rel, abs, kind } of writes) {
        snapshot(abs);
        writeAtomic(abs, /** @type {Buffer} */ (staged.files.get(rel)));
        (kind === 'missing' ? result.generated : result.refreshed).push(rel);
      }
      if (settingsToWrite.length || staleSettings.length) {
        for (const file of settingsFiles) snapshot(path.join(cwd, file));
        applySettings(cwd, desiredSettings, { ...ownedSettings, ...Object.fromEntries(staleSettings.map((k) => [k, true])) });
        result.settings = settingsToWrite;
      }
      for (const { rel, abs } of prunes) {
        snapshot(abs);
        fs.rmSync(abs);
        pruneEmptyDirs(cwd, path.dirname(abs));
        result.pruned.push(rel);
      }
      if (localLockNeeded) {
        const after = `${JSON.stringify(staged.tree, null, 2)}\n`;
        if (!exists(localLockFile) || fs.readFileSync(localLockFile, 'utf8') !== after) {
          snapshot(localLockFile);
          writeAtomic(localLockFile, Buffer.from(after));
        }
      } else if (exists(localLockFile)) {
        snapshot(localLockFile);
        fs.rmSync(localLockFile);
        result.notes.push(`removed a stale ${LOCAL_LOCK_FILE}: this render is canonical`);
      }
    } catch (err) {
      restore();
      result.generated = [];
      result.refreshed = [];
      result.settings = [];
      result.pruned = [];
      return fail(`writing failed (${/** @type {Error} */ (err).message}) — the ${undo.length} path(s) touched were restored as found; nothing is ready, fix the cause and prepare again`);
    }
    result.present = present;
    if (manifestFile && (writes.length || settingsToWrite.length || prunes.length || staleSettings.length)) {
      for (const { rel } of writes) prepared[rel] = sha256(/** @type {Buffer} */ (staged.files.get(rel)));
      for (const { rel } of prunes) delete prepared[rel];
      for (const key of settingsToWrite) preparedSettings[key] = desiredSettings.get(key);
      for (const key of staleSettings) delete preparedSettings[key];
      fs.writeFileSync(manifestFile, `${JSON.stringify({ files: prepared, settings: preparedSettings }, null, 2)}\n`);
    }

    const broken = desiredFiles.filter((rel) => {
      const abs = path.join(cwd, rel);
      return !exists(abs) || sha256(fs.readFileSync(abs)) !== sha256(/** @type {Buffer} */ (staged.files.get(rel)));
    });
    for (const [key, value] of desiredSettings) if (!isDeepStrictEqual(settingsValueAt(cwd, key), value)) broken.push(key);
    if (broken.length) {
      restore();
      return fail(`validation after writing failed for ${broken.length} path(s): ${broken.slice(0, 5).join(', ')} — the paths this run touched were restored; nothing is ready, check the filesystem and prepare again`);
    }
    result.status = result.generated.length || result.refreshed.length || result.settings.length || result.pruned.length ? 'ready' : 'no-op';
    return result;
  }
}

/**
 * The lock-managed harness paths a checkout should hold — what `prepareWorktree` provisions.
 *
 * @param {any} lock @param {string[]} targets
 */
export function expectedHarnessPaths(lock, targets) {
  return lockKeys(lock).filter((k) => isHarnessPath(k, targets)).sort((a, b) => a.localeCompare(b));
}

/**
 * Human text for the CLI. One status line first, then the facts, then anything to act on.
 *
 * @param {PrepareResult} r
 * @returns {string}
 */
export function formatPrepareResult(r) {
  const lines = [];
  const where = r.checkout.linked ? `linked worktree of ${r.checkout.mainCheckout ?? 'an unresolved main checkout'}` : 'main checkout';
  if (r.status === 'failed') {
    lines.push(`prepare-worktree: failed — ${r.cwd}`);
  } else {
    const counts = [`${r.generated.length} written`, ...(r.refreshed.length ? [`${r.refreshed.length} refreshed`] : []), ...(r.pruned.length ? [`${r.pruned.length} pruned`] : []), `${r.present} already present`];
    lines.push(`prepare-worktree: ${r.status} — ${counts.join(', ')} in ${r.cwd}`);
  }
  lines.push(`  checkout: ${where}`);
  if (r.pin.version) lines.push(`  toolkit:  ${r.pin.version}${r.pin.ref ? ` (${r.pin.ref})` : ` (${r.pin.status ?? 'unpinned'}, no release pin)`}${r.pin.from && r.pin.from !== 'running' ? ` — pinned release ${r.pin.from === 'fetch' ? 'fetched into' : 'served from'} the source cache` : ''}`);
  if (r.targets.length) lines.push(`  targets:  ${r.targets.join(', ')}`);
  if (r.overlay.mode) {
    const eff = r.overlay.effective === 'overlay' ? `overlay-effective (${r.overlay.file})` : r.overlay.effective === 'canonical' ? 'canonical' : 'undetermined';
    lines.push(`  overlay:  ${eff} — policy ${r.overlay.mode} (${r.overlay.source})`);
  }
  if (r.settings.length) lines.push(`  settings: ${r.settings.length} entr${r.settings.length === 1 ? 'y' : 'ies'} written`);
  for (const n of r.notes) lines.push(`note: ${n}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const e of r.errors) lines.push(`error: ${e}`);
  return `${lines.join('\n')}\n`;
}
