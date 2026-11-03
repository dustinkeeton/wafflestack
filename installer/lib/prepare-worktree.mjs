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
import { applySettings, parseSettingsKey, settingsConflicts, settingsValueAt } from './settings.mjs';

const harnessPath = (p) => /^(?:\.claude|\.codex|\.agents)\//.test(p);
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const present = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Resolve source bytes by the destination lock, never by the associated main checkout. */
export function resolvePreparationToolkit({ lock, toolkitRoot, offline = false, sourceCacheDir = defaultSourceCacheDir(), allowUnreleased = false, cwd }) {
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
  if (identity.status === 'release' && identity.tag === lock.toolkit.ref && identity.commit === lock.toolkit.commit && identity.version === lock.toolkitVersion && toolkitSource(identity.repo) === lock.toolkit.source) {
    return { root: toolkitRoot, pin, version: lock.toolkitVersion };
  }
  try {
    const resolved = resolveSource({ name: 'worktree-toolkit', source: httpsUrl(slug), sourceType: 'git', ref: lock.toolkit.commit }, { cacheDir: sourceCacheDir, offline });
    if (git(resolved.root, ['rev-parse', '--verify', `${lock.toolkit.ref}^{commit}`]) !== lock.toolkit.commit || resolved.commit !== lock.toolkit.commit || json(path.join(resolved.root, 'package.json')).version !== lock.toolkitVersion) throw new Error('pin mismatch');
    return { root: resolved.root, pin, version: lock.toolkitVersion };
  } catch {
    throw new Error(`${offline ? 'offline cache miss' : 'unavailable or mismatched toolkit'} for ${pin} — make the locked commit available in the source cache online, or explicitly upgrade and commit the new lock`);
  }
}

/** Prepare only harness artifacts; the Git administrative directory holds the transaction mutex. */
export function prepareWorktree({ cwd, toolkitRoot, offline = false, untrustedConfig = false, allowUnreleased = false, sourceCacheDir = defaultSourceCacheDir(), resolveToolkit = resolvePreparationToolkit, beforeWrite = () => {} }) {
  const result = { status: 'failed', targets: [], pin: null, generatedPaths: [], conflicts: [], overlayMode: 'canonical', notices: [], missingIgnore: [], errors: [] };
  let mutex;
  let acquired = false;
  let temp;
  const backups = new Map();
  const applied = [];
  const written = new Map();
  try {
    cwd = fs.realpathSync(cwd);
    if (fs.realpathSync(git(cwd, ['rev-parse', '--show-toplevel'])) !== cwd || git(cwd, ['rev-parse', '--is-bare-repository']) !== 'false') throw new Error('destination must be the root of a non-bare Git checkout');
    const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir']);
    mutex = path.join(gitDir, 'wafflestack-prepare');
    try { fs.mkdirSync(mutex, { mode: 0o700 }); acquired = true; } catch (e) {
      if (e.code === 'EEXIST') throw new Error('preparation active or interrupted — stop the owning process, inspect the private transaction in the checkout Git directory, then remove only its wafflestack-prepare directory and retry before launching');
      throw e;
    }
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
    const selected = resolveToolkit({ lock, toolkitRoot, offline, sourceCacheDir, allowUnreleased, cwd });
    result.pin = selected.pin;
    const main = git(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice('worktree '.length);
    const localOverlay = resolveLocalConfigFile(cwd).file;
    const mainOverlay = resolveLocalConfigFile(main).file;
    let policy = 'destination';
    try { policy = git(cwd, ['config', '--local', '--get', 'wafflestack.worktreeOverlay']) || policy; } catch {}
    if (!['destination', 'main'].includes(policy)) throw new Error('wafflestack.worktreeOverlay must be destination or main');
    if (untrustedConfig && policy === 'main') throw new Error('--untrusted-config refuses main-overlay inheritance; set wafflestack.worktreeOverlay to destination');
    let localConfigDir = cwd;
    if (present(localOverlay)) result.overlayMode = 'destination-overlay';
    else if (policy === 'main' && present(mainOverlay)) {
      if (git(main, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) throw new Error('main overlay association does not match Git common directory');
      localConfigDir = main;
      result.overlayMode = 'main-overlay';
    } else if (main !== cwd && present(mainOverlay)) result.notices.push('destination overlay policy omits the main checkout private overlay; prepared canonical resources');
    const overlayFile = resolveLocalConfigFile(localConfigDir).file;
    if (present(overlayFile)) {
      const coverage = gitIgnoreStatus(localConfigDir, [path.relative(localConfigDir, overlayFile)]);
      if (!coverage || coverage.tracked.size || !coverage.ignored.size) throw new Error('private overlay must be untracked and ignored before preparation');
    }
    let planned;
    try {
      planned = renderProject({ cwd, toolkitRoot: selected.root, toolkitVersion: selected.version, planOnly: true, localConfigDir, untrustedConfig, offline, sourceCacheDir });
    } catch { throw new Error('render planning failed — validate destination config, extensions and source trust with the pinned toolkit; private values suppressed'); }
    if (!planned.ok) throw new Error('render planning failed — validate config/extension inputs and external-source trust with the pinned toolkit; private values suppressed');
    const { plan } = planned;
    result.targets = plan.targets;
    if (!isDeepStrictEqual(plan.files, lock.files) || !isDeepStrictEqual(plan.settings, lock.settings ?? {}) ||
      !isDeepStrictEqual(plan.canonicalTargets, lock.targets) || !isDeepStrictEqual(plan.canonicalStacks, lock.stacks) ||
      !isDeepStrictEqual(plan.canonicalInclude, lock.include ?? []) || !isDeepStrictEqual(plan.sources, lock.sources ?? [])) throw new Error('config/lock/pinned toolkit mismatch — run a pinned render or upgrade, review and commit its canonical lock before preparation');
    const outputs = new Map([...plan.effective.outputs].filter(([p]) => harnessPath(p)));
    const settings = new Map([...plan.effective.settings].filter(([p]) => harnessPath(p)));
    const ejected = [...plan.effective.selection.ejected].map((ref) => {
      const parsed = parseRef(ref);
      return itemOutputMatcher(parsed.kind, parsed.name);
    });
    const isEjected = (rel) => ejected.some((matches) => matches(rel));
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
    for (const rel of Object.keys(previous.files ?? {})) {
      if (harnessPath(rel) && !isEjected(rel) && !outputs.has(rel) && !settingFiles.includes(rel) && present(path.join(cwd, rel))) result.conflicts.push(rel);
    }
    for (const rel of plan.canonical.outputs.keys()) {
      if (harnessPath(rel) && !outputs.has(rel) && present(path.join(cwd, rel))) result.conflicts.push(rel);
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
    const privatePaths = [...outputs].filter(([p, c]) => sha256(c) !== plan.files[p]).map(([p]) => p);
    for (const [key, value] of settings) if (!isDeepStrictEqual(value, plan.settings[key])) privatePaths.push(parseSettingsKey(key).file);
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
    const changes = [...outputs].filter(([p, c]) => !present(path.join(cwd, p)) || !fs.readFileSync(path.join(cwd, p)).equals(Buffer.from(c)));
    for (const [rel] of changes) {
      const abs = path.join(cwd, rel);
      backups.set(rel, present(abs) ? fs.readFileSync(abs) : null);
    }
    fs.writeFileSync(path.join(mutex, 'journal.json'), JSON.stringify([...backups].map(([p, b]) => [p, b?.toString('base64') ?? null])), { mode: 0o600 });
    for (const [rel, content] of changes) {
      beforeWrite(rel);
      if (!resolveWritableInside(cwd, rel) || hasSymlink(cwd, rel)) throw new Error('destination changed during preparation');
      const abs = path.join(cwd, rel);
      const before = backups.get(rel);
      if (before === null ? present(abs) : !present(abs) || !fs.readFileSync(abs).equals(before)) throw new Error('destination edited during preparation');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      applied.push(rel);
      written.set(rel, Buffer.from(content));
      fs.writeFileSync(abs, content, { mode: 0o600 });
    }
    for (const [rel, content] of outputs) if (!fs.readFileSync(path.join(cwd, rel)).equals(Buffer.from(content))) throw new Error('artifact verification failed');
    for (const [key, value] of settings) if (!isDeepStrictEqual(settingsValueAt(cwd, key), value)) throw new Error('settings verification failed');
    fs.writeFileSync(receiptPath, JSON.stringify({ files: Object.fromEntries([...outputs].filter(([p]) => harnessPath(p) && !settingFiles.includes(p)).map(([p, c]) => [p, sha256(c)])), settings: Object.fromEntries([...settings].map(([key, value]) => [key, sha256(JSON.stringify(value))])) }), { mode: 0o600 });
    result.generatedPaths = changes.map(([p]) => p);
    result.status = changes.length ? 'ready' : 'no-op';
  } catch (e) {
    for (const rel of applied.reverse()) {
      try {
        if (!resolveWritableInside(cwd, rel) || hasSymlink(cwd, rel) || !fs.readFileSync(path.join(cwd, rel)).equals(written.get(rel))) throw new Error('artifact changed after write');
        const before = backups.get(rel);
        if (before === null) fs.rmSync(path.join(cwd, rel));
        else fs.writeFileSync(path.join(cwd, rel), before);
      }
      catch { result.errors.push('rollback incomplete — inspect private transaction journal before retrying'); acquired = false; }
    }
    result.errors.push(e.message);
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    if (acquired) fs.rmSync(mutex, { recursive: true, force: true });
  }
  return result;
}

function hasSymlink(cwd, rel) {
  let current = cwd;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (present(current)?.isSymbolicLink()) return true;
  }
  return false;
}
