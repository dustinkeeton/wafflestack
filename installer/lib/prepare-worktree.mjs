// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { renderProject, readLock } from './render.mjs';
import { resolveToolkitIdentity, toolkitPinFromLock, parseRepoSlug, httpsUrl, toolkitSource } from './toolkit-ref.mjs';
import { resolveSource, defaultSourceCacheDir } from './sources.mjs';
import { resolveConfigFile, resolveLockFile, resolveLocalConfigFile, LOCAL_LOCK_FILE, gitIgnoreStatus } from './project.mjs';
import { sha256, resolveWritableInside } from './util.mjs';
import { parseRef, itemOutputMatcher } from './refs.mjs';
import { acquirePreparation, recoverPreparation, replaceBytes, readBytes, sameBytes } from './preparation-transaction.mjs';
import { applySettings, parseSettingsKey, settingsConflicts, settingsValueAt } from './settings.mjs';

/** @param {string} p */
const harnessPath = (p) => /^(?:\.claude|\.codex|\.agents)\//.test(p);
/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** @param {string} p */
const present = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
/** @param {string} p @returns {any} JSON is validated by the consuming boundary. */
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * @typedef {{ toolkitVersion: string, toolkit?: import('./toolkit-ref.mjs').ToolkitLockEntry, files: Record<string,string>, settings?: Record<string,unknown> }} PreparationLock
 * @typedef {{ root: string, pin: string, version: string }} PreparedToolkit
 * @typedef {{ lock: PreparationLock, toolkitRoot: string, cwd: string, offline?: boolean, untrustedConfig?: boolean, sourceCacheDir?: string, allowUnreleased?: boolean }} ToolkitOptions
 * @typedef {{ cwd: string, toolkitRoot: string, offline?: boolean, untrustedConfig?: boolean, allowUnreleased?: boolean, sourceCacheDir?: string, overlay?: 'local'|'main'|'none', resolveToolkit?: (options: ToolkitOptions) => PreparedToolkit, beforeWrite?: (path: string) => void }} PrepareOptions
 * @typedef {{ status: 'failed'|'ready'|'no-op', targets: string[], pin: string|null, generatedPaths: string[], prunedPaths: string[], conflicts: string[], overlayMode: 'canonical'|'destination-overlay'|'main-overlay', notices: string[], missingIgnore: string[], errors: string[] }} PrepareResult
 */

/** Resolve source bytes by the destination lock, never by the associated main checkout.
 * @param {ToolkitOptions} options
 * @returns {PreparedToolkit}
 */
export function resolvePreparationToolkit({ lock, toolkitRoot, offline = false, untrustedConfig = false, sourceCacheDir = defaultSourceCacheDir(), allowUnreleased = false, cwd }) {
  const pin = toolkitPinFromLock(lock);
  const identity = resolveToolkitIdentity({ toolkitRoot, offline: true });
  if (!pin || !/^v\d+\.\d+\.\d+$/.test(lock.toolkit?.ref ?? '') || !/^[a-f0-9]{40}$/i.test(lock.toolkit?.commit ?? '')) {
    if (allowUnreleased && fs.realpathSync(toolkitRoot) === fs.realpathSync(cwd) && lock.toolkit?.status === 'unreleased') {
      return { root: toolkitRoot, pin: 'development-checkout', version: lock.toolkitVersion };
    }
    throw new Error('lock has no reproducible release provenance — run upgrade with an explicitly selected released toolkit, then commit config and lock; toolkit development alone may use --allow-unreleased in its own checkout');
  }
  const slug = parseRepoSlug(lock.toolkit.source);
  if (!slug || toolkitSource(`${slug.owner}/${slug.repo}`) !== lock.toolkit.source) throw new Error('unsupported toolkit provenance — repair the lock with a pinned upgrade');
  if (`${slug.owner}/${slug.repo}` !== identity.repo) throw new Error('toolkit repository differs from the running CLI — repair the lock using the trusted pinned CLI');
  if ((identity.origin !== 'checkout' || !git(toolkitRoot, ['status', '--porcelain', '--untracked-files=all'])) && identity.commit === lock.toolkit.commit && identity.version === lock.toolkitVersion && toolkitSource(identity.repo) === lock.toolkit.source) {
    return { root: toolkitRoot, pin, version: lock.toolkitVersion };
  }
  try {
    const resolved = resolveSource({ name: 'worktree-toolkit', source: httpsUrl(slug), sourceType: 'git', ref: lock.toolkit.commit }, { cacheDir: sourceCacheDir, offline: offline || untrustedConfig });
    if (git(resolved.root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('dirty toolkit cache');
    if (git(resolved.root, ['rev-parse', '--verify', `${lock.toolkit.ref}^{commit}`]) !== lock.toolkit.commit || resolved.commit !== lock.toolkit.commit || json(path.join(resolved.root, 'package.json')).version !== lock.toolkitVersion) throw new Error('pin mismatch');
    return { root: resolved.root, pin, version: lock.toolkitVersion };
  } catch {
    throw new Error(`${offline ? 'offline cache miss' : 'unavailable or mismatched toolkit'} for ${pin} — run npx --yes ${pin} prepare-worktree in trusted setup; make the locked commit available in the source cache online, or explicitly upgrade and commit the new lock`);
  }
}

/** Prepare only harness artifacts; the Git administrative directory holds the transaction mutex.
 * @param {PrepareOptions} options
 * @returns {PrepareResult}
 */
export function prepareWorktree({ cwd, toolkitRoot, offline = false, untrustedConfig = false, allowUnreleased = false, sourceCacheDir = defaultSourceCacheDir(), overlay, resolveToolkit = resolvePreparationToolkit, beforeWrite = () => {} }) {
  /** @type {PrepareResult} */
  const result = { status: 'failed', targets: [], pin: null, generatedPaths: [], prunedPaths: [], conflicts: [], overlayMode: 'canonical', notices: [], missingIgnore: [], errors: [] };
  let mutex = '';
  let acquired = false;
  let temp;
  try {
    if (overlay !== undefined && !['local', 'main', 'none'].includes(overlay)) throw new Error('--overlay must be local, main, or none');
    cwd = fs.realpathSync(cwd);
    if (fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel'])) !== cwd || git(cwd, ['rev-parse', '--is-bare-repository']) !== 'false') throw new Error('destination must be the root of a non-bare Git checkout');
    const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir']);
    mutex = path.join(gitDir, 'wafflestack-prepare');
    acquirePreparation(mutex, () => recoverPreparation(cwd, mutex));
    acquired = true;
    const lockPath = resolveLockFile(cwd).file;
    const configPath = resolveConfigFile(cwd).file;
    for (const input of [lockPath, configPath]) {
      const rel = path.relative(cwd, input);
      if (!resolveWritableInside(cwd, rel)) throw new Error('config or lock escapes the destination checkout');
      if (git(cwd, ['show', `HEAD:${rel}`]) !== fs.readFileSync(input, 'utf8').trim()) throw new Error(`${rel} differs from HEAD — commit the intended inputs and lock before preparation`);
    }
    const lock = readLock(cwd);
    if (!lock) throw new Error('missing lock — run a pinned upgrade/render and commit the lock first');
    result.pin = toolkitPinFromLock(lock);
    const selected = resolveToolkit({ lock, toolkitRoot, offline, untrustedConfig, sourceCacheDir, allowUnreleased, cwd });
    result.pin = selected.pin;
    const main = git(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice('worktree '.length);
    const localOverlay = resolveLocalConfigFile(cwd).file;
    const mainOverlay = resolveLocalConfigFile(main).file;
    let policy = 'destination';
    try { policy = git(cwd, ['config', '--local', '--get', 'wafflestack.worktreeOverlay']) || policy; } catch {}
    if (overlay !== undefined) policy = overlay === 'local' ? 'destination' : overlay;
    if (!['destination', 'main', 'none'].includes(policy)) throw new Error('wafflestack.worktreeOverlay must be destination or main');
    if (untrustedConfig && policy === 'main') throw new Error('--untrusted-config refuses main-overlay inheritance; set wafflestack.worktreeOverlay to destination');
    let localConfigDir = cwd;
    if (policy !== 'none' && present(localOverlay)) result.overlayMode = 'destination-overlay';
    else if (policy === 'main' && present(mainOverlay)) {
      if (git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) throw new Error('main overlay association does not match Git common directory');
      localConfigDir = main;
      result.overlayMode = 'main-overlay';
    } else if (main !== cwd && present(mainOverlay)) result.notices.push('destination overlay policy omits the main checkout private overlay; prepared canonical resources');
    const overlayFile = resolveLocalConfigFile(localConfigDir).file;
    if (policy !== 'none' && present(overlayFile)) {
      const coverage = gitIgnoreStatus(localConfigDir, [path.relative(localConfigDir, overlayFile)]);
      if (!coverage || coverage.tracked.size || !coverage.ignored.size) throw new Error('private overlay must be untracked and ignored before preparation');
    }
    let planned;
    try {
      planned = renderProject({ cwd, toolkitRoot: selected.root, toolkitVersion: selected.version, planOnly: true, localConfigDir, ignoreLocalConfig: policy === 'none', untrustedConfig, offline, sourceCacheDir });
    } catch (error) { throw new Error(safePlanningError([error.message])); }
    if (!planned.ok) throw new Error(safePlanningError(planned.errors));
    const { plan } = planned;
    result.targets = plan.targets;
    if (!isDeepStrictEqual(plan.files, lock.files) || !isDeepStrictEqual(plan.settings, lock.settings ?? {}) ||
      !isDeepStrictEqual(plan.canonicalTargets, lock.targets) || !isDeepStrictEqual(plan.canonicalStacks, lock.stacks) ||
      !isDeepStrictEqual(plan.canonicalInclude, lock.include ?? []) || !isDeepStrictEqual(plan.sources, lock.sources ?? [])) throw new Error('config/lock/pinned toolkit mismatch — run a pinned render or upgrade, review and commit its canonical lock before preparation');
    const outputs = new Map([...plan.effective.outputs].filter(([p]) => harnessPath(p)));
    const settings = new Map([...plan.effective.settings].filter(([p]) => harnessPath(p)));
    const ejected = [...plan.effective.selection.ejected].map((ref) => {
      const parsed = parseRef(ref);
      if (parsed.form === 'stack') throw new Error('invalid ejected resource: expected an item reference');
      return itemOutputMatcher(parsed.kind, parsed.name);
    });
    const isEjected = (/** @type {string} */ rel) => ejected.some((matches) => matches(rel));
    const receiptPath = path.join(gitDir, 'wafflestack-prepared.json');
    const previous = present(receiptPath) ? json(receiptPath) : { files: {} };
    const settingFiles = [...new Set([...settings.keys()].map((p) => parseSettingsKey(p).file))];
    const paths = [...outputs.keys(), ...settingFiles];
    for (const rel of [...paths, LOCAL_LOCK_FILE]) {
      if (!resolveWritableInside(cwd, rel) || hasSymlink(cwd, rel)) result.conflicts.push(rel);
    }
    if (result.conflicts.length) throw new Error('unsafe symlink destinations — remove links and retry');
    for (const [rel, content] of outputs) {
      const abs = path.join(cwd, rel);
      const stat = present(abs);
      if (stat && (!stat.isFile() || ![sha256(content), previous.files?.[rel], lock.files[rel]].includes(sha256(fs.readFileSync(abs))))) result.conflicts.push(rel);
    }
    const prune = [];
    for (const rel of Object.keys(previous.files ?? {})) {
      if (!harnessPath(rel) || isEjected(rel) || outputs.has(rel) || settingFiles.includes(rel)) continue;
      const abs = path.join(cwd, rel);
      if (!resolveWritableInside(cwd, rel) || hasSymlink(cwd, rel)) { result.conflicts.push(rel); continue; }
      const stat = present(abs);
      if (!stat) continue;
      if (!stat.isFile() || sha256(fs.readFileSync(abs)) !== previous.files[rel] || git(cwd, ['ls-files', '--', rel])) result.conflicts.push(rel);
      else prune.push(rel);
    }
    for (const rel of plan.canonical.outputs.keys()) {
      if (harnessPath(rel) && !outputs.has(rel) && !prune.includes(rel) && !isEjected(rel) && present(path.join(cwd, rel))) result.conflicts.push(rel);
    }
    for (const key of plan.canonical.settings.keys()) {
      if (harnessPath(key) && !settings.has(key) && settingsValueAt(cwd, key) !== undefined) result.conflicts.push(key);
    }
    for (const key of Object.keys(previous.settings ?? {})) {
      if (!settings.has(key) && !isEjected(key) && settingsValueAt(cwd, key) !== undefined) result.conflicts.push(key);
    }
    const managedSettings = Object.fromEntries([...settings.keys()].filter((key) => {
      const current = settingsValueAt(cwd, key);
      return current !== undefined && (sha256(JSON.stringify(current)) === previous.settings?.[key] || isDeepStrictEqual(current, lock.settings?.[key]));
    }).map((key) => [key, true]));
    const check = settingsConflicts(cwd, settings, managedSettings);
    result.conflicts.push(...check.collisions);
    if (check.errors.length) result.conflicts.push(...settingFiles);
    if (result.conflicts.length) throw new Error('conflicting or stale artifacts — preserve your edits, reconcile the named paths with an explicit render/eject, then retry');
    const coverage = gitIgnoreStatus(cwd, paths);
    if (!coverage) throw new Error('cannot determine Git ignore/tracking posture');
    result.missingIgnore = paths.filter((p) => !coverage.tracked.has(p) && !coverage.ignored.has(p));
    const privatePaths = [...outputs].filter(([p, c]) => sha256(c) !== /** @type {Record<string, string>} */ (plan.files)[p]).map(([p]) => p);
    for (const [key, value] of settings) if (!isDeepStrictEqual(value, /** @type {Record<string, unknown>} */ (plan.settings)[key])) privatePaths.push(parseSettingsKey(key).file);
    const privateCoverage = gitIgnoreStatus(cwd, [...privatePaths, LOCAL_LOCK_FILE]);
    if (!privateCoverage) throw new Error('cannot determine private output ignore coverage');
    const exposed = privatePaths.filter((p) => privateCoverage.tracked.has(p) || !privateCoverage.ignored.has(p));
    if (exposed.length) {
      result.conflicts.push(...exposed);
      throw new Error('private overlay output would be tracked or exposed — explicitly untrack/ignore affected harness output or change overlay policy first');
    }
    if (privatePaths.length && (privateCoverage.tracked.has(LOCAL_LOCK_FILE) || !privateCoverage.ignored.has(LOCAL_LOCK_FILE))) throw new Error('private local lock must be untracked and ignored — adjust the ignore posture first');
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wafflestack-prepare-'));
    for (const rel of settingFiles) {
      const abs = path.join(cwd, rel);
      if (present(abs)) { fs.mkdirSync(path.dirname(path.join(temp, rel)), { recursive: true }); fs.copyFileSync(abs, path.join(temp, rel)); }
    }
    applySettings(temp, settings, {});
    for (const rel of settingFiles) outputs.set(rel, fs.readFileSync(path.join(temp, rel)));
    if (privatePaths.length) {
      const localManifest = {
        ...lock, targets: plan.targets,
        files: {
          ...Object.fromEntries(Object.entries(lock.files).filter(([p]) => !harnessPath(p))),
          ...Object.fromEntries([...outputs].filter(([p]) => !settingFiles.includes(p)).map(([p, c]) => [p, sha256(c)])),
        },
        settings: Object.fromEntries(settings),
      };
      outputs.set(LOCAL_LOCK_FILE, `${JSON.stringify(localManifest, null, 2)}\n`);
    }
    else if (present(path.join(cwd, LOCAL_LOCK_FILE))) throw new Error('stale local lock — reconcile it with an explicit render before canonical preparation');
    const receipt = Buffer.from(JSON.stringify({ files: Object.fromEntries([...outputs].filter(([p]) => harnessPath(p) && !settingFiles.includes(p)).map(([p, c]) => [p, sha256(c)])), settings: Object.fromEntries([...settings].map(([key, value]) => [key, sha256(JSON.stringify(value))])) }));
    /** @type {[string, Buffer|null][]} */
    const desired = [...outputs].map(([p, c]) => [p, Buffer.from(c)]);
    desired.push(...prune.map((p) => /** @type {[string, null]} */ ([p, null])));
    const changes = desired.filter(([p, c]) => !sameBytes(readBytes(path.join(cwd, p)), c));
    const entries = changes.map(([rel, content]) => [rel, readBytes(path.join(cwd, /** @type {string} */ (rel)))?.toString('base64') ?? null, content?.toString('base64') ?? null]);
    if (present(receiptPath)?.isSymbolicLink()) throw new Error('unsafe receipt destination');
    entries.push(['@receipt', readBytes(receiptPath)?.toString('base64') ?? null, receipt.toString('base64')]);
    replaceBytes(path.join(mutex, 'journal.json'), Buffer.from(JSON.stringify({ version: 1, entries })));
    for (const [rel, content] of changes) {
      const p = /** @type {string} */ (rel);
      beforeWrite(p);
      if (!resolveWritableInside(cwd, p) || hasSymlink(cwd, p)) throw new Error('destination changed during preparation');
      const before = entries.find(([r]) => r === rel)[1];
      if (!sameBytes(readBytes(path.join(cwd, p)), before === null ? null : Buffer.from(before, 'base64'))) throw new Error('destination edited during preparation');
      replaceBytes(path.join(cwd, p), /** @type {Buffer} */ (content));
    }
    for (const [rel, content] of outputs) if (!fs.readFileSync(path.join(cwd, rel)).equals(Buffer.from(content))) throw new Error('artifact verification failed');
    for (const rel of prune) if (present(path.join(cwd, rel))) throw new Error('prune verification failed');
    for (const [key, value] of settings) if (!isDeepStrictEqual(settingsValueAt(cwd, key), value)) throw new Error('settings verification failed');
    replaceBytes(receiptPath, receipt);
    result.generatedPaths = changes.filter(([, c]) => c !== null).map(([p]) => p);
    result.prunedPaths = prune;
    result.status = changes.length ? 'ready' : 'no-op';
  } catch (e) {
    if (acquired) {
      try { recoverPreparation(cwd, mutex); }
      catch { result.errors.push('rollback incomplete — inspect private transaction journal before retrying'); acquired = false; }
    }
    result.errors.push(e.message);
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    if (acquired) fs.rmSync(mutex, { recursive: true, force: true });
  }
  return result;
}

/** @param {string} cwd @param {string} rel */
function hasSymlink(cwd, rel) {
  let current = cwd;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (present(current)?.isSymbolicLink()) return true;
  }
  return false;
}

/** Categorize renderer failures without copying private values or raw YAML into diagnostics.
 * @param {string[]} errors
 */
export function safePlanningError(errors) {
  const text = errors.join('\n');
  const category = /missing config value|required config|missing required|needs config values/i.test(text)
    ? 'missing required configuration: supply the required keys in the destination config'
    : /source:|external stack|trust|--untrusted-config/i.test(text)
      ? 'external source or trust failure: check destination source declarations and trusted setup policy'
      : /YAMLParseError|YAMLException|parse|mapping|indent|flow sequence/i.test(text)
        ? 'invalid configuration syntax: check destination YAML and extension frontmatter'
        : 'invalid render inputs: check destination config, extensions and selected resources';
  return `render planning failed — ${category}. Inspect locally with the pinned CLI; private values suppressed. Re-render and commit canonical inputs/lock when repaired, then retry prepare-worktree.`;
}
