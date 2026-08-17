import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, exists } from './util.mjs';
import { readLock, readLocalLock, readTreeLock, renderProject, configGuardProblems } from './render.mjs';
import {
  LOCK_FILE,
  LOCAL_LOCK_FILE,
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  EXTENSIONS_DIR,
  resolveLockFile,
  resolveConfigFile,
  loadProjectConfig,
} from './project.mjs';
import { describeToolkitProvenance } from './toolkit-ref.mjs';
import { loadToolkitWithSources } from './toolkit.mjs';
import { computeSelection } from './refs.mjs';
import { applicablePrerequisites, evaluatePrerequisites } from './prerequisites.mjs';
import { defaultSourceCacheDir } from './sources.mjs';

/** The empty prerequisite result — no gate ran (no toolkit root, or evaluation was skipped). */
function noPrereqs() {
  return { evaluated: false, unmetRequired: [], unmetRecommended: [], met: [] };
}

/** The empty render-verification result — the flag was not passed, so no render was reproduced. */
function noVerify() {
  return { evaluated: false, ok: true, checked: 0, stale: [], absent: [], unexpected: [], errors: [] };
}

/** Compare managed files against the lock manifest — see the doctor entry in AGENTS.md. */
export function doctor({ cwd, toolkitVersion, toolkitIdentity = null, allowMissing = false, verifyRender = false, toolkitRoot = null, sourceCacheDir = defaultSourceCacheDir() }) {
  const lock = readLock(cwd);
  if (!lock) {
    // `toolkitProvenance` stays in the return shape even with no lock — callers read `.status` unguarded.
    const toolkitProvenance = { status: /** @type {const} */ ('not-recorded'), notes: [] };
    return { ok: false, modified: [], missing: [], notes: [`${LOCK_FILE} not found — run \`wafflestack render\` first`], attribution: {}, allowMissing, toolkitProvenance, prerequisites: noPrereqs(), render: noVerify() };
  }
  // The manifest of what is actually on disk (#317): `lock` unless a local overlay shaped it.
  const tree = readTreeLock(cwd);
  // EXISTS, not `tree !== lock`: readLock re-parses per call, so the fallback is equal-but-distinct.
  const localRender = readLocalLock(cwd) !== null;

  const attribution = {};
  for (const src of tree.sources ?? []) {
    const label = sourceLabel(src);
    for (const rel of src.files ?? []) attribution[rel] = label;
  }

  const modified = [];
  const missing = [];
  for (const [rel, hash] of Object.entries(tree.files)) {
    const abs = path.join(cwd, rel);
    if (!exists(abs)) {
      missing.push(rel);
    } else if (sha256(fs.readFileSync(abs)) !== hash) {
      modified.push(rel);
    }
  }

  // The all-absent guard (#311). `total > 0` excludes an empty lock (nothing to have failed).
  const total = Object.keys(tree.files).length;
  const nothingPresent = allowMissing && total > 0 && missing.length === total;

  const notes = [];
  // A repo still on the legacy lock name reads fine (readLock falls back) but should migrate.
  const lockPath = resolveLockFile(cwd);
  if (lockPath.legacy) notes.push(lockPath.note);
  if (localRender) {
    notes.push(
      `${LOCAL_CONFIG_FILE} feeds this machine's render, so the files on disk were checked against ${LOCAL_LOCK_FILE} (this machine's render); ${LOCK_FILE} records the canonical render and is the one you commit`,
    );
  }
  const rendered = lock.toolkitVersion ?? 'unknown (pre-versioned lock)';
  notes.push(
    toolkitVersion
      ? `rendered by toolkit ${rendered}; installed CLI is ${toolkitVersion}`
      : `rendered by toolkit ${rendered}`,
  );
  if (toolkitVersion && lock.toolkitVersion && toolkitVersion !== lock.toolkitVersion) {
    notes.push(
      toolkitIdentity && toolkitIdentity.status !== 'release' && toolkitIdentity.latestTag && toolkitIdentity.repo
        ? `version skew — run \`npx --yes github:${toolkitIdentity.repo}#${toolkitIdentity.latestTag} upgrade\` to apply migrations and re-render (this CLI is ${toolkitIdentity.status}; a bare \`upgrade\` re-fetches the default branch)`
        : 'version skew — run `wafflestack upgrade` to apply migrations and re-render',
    );
  }

  // Provenance WARNS only, never gates `ok`, and reads the canonical lock rather than the overlay (#374).
  const toolkitProvenance = describeToolkitProvenance({
    lockToolkit: lock.toolkit ?? null,
    lockVersion: lock.toolkitVersion ?? null,
    identity: toolkitIdentity,
  });
  notes.push(...toolkitProvenance.notes);

  if (modified.length) {
    notes.push('managed files have local edits; move changes into .waffle/extensions/ or config, then re-render');
  }

  // Runs BEFORE the absence notes: whether an all-absent tree "verified nothing" depends on it (#314).
  const render = verifyRender
    ? verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, toolkitIdentity, sourceCacheDir })
    : noVerify();
  const verified = render.evaluated;

  if (nothingPresent && verified) {
    notes.push(`every managed file (${total}/${total}) is absent, but the render was reproduced from ${CONFIG_FILE} and checked against the lock (--verify-render) — this check verified the render, not the tree`);
  } else if (nothingPresent) {
    notes.push(`every managed file (${total}/${total}) is absent — this check verified nothing; run \`wafflestack render\`, or add \`--verify-render\` to verify by re-rendering the committed config against the lock (\`render\` + \`git diff --exit-code ${LOCK_FILE}\` is the manual equivalent) if the repo deliberately commits only the lock`);
  } else if (allowMissing && missing.length) {
    notes.push(`${missing.length} managed file(s) absent but tolerated (--allow-missing) — expected when a repo gitignores some renders (partial/CI checkout)`);
  }
  if (render.stale.length || render.unexpected.length || render.absent.length) {
    notes.push(`the lock does not match what ${CONFIG_FILE} (+ ${EXTENSIONS_DIR}/) would render — re-render and commit the result`);
  }

  // Prerequisite and config-guard gates, best-effort: a load failure becomes a note and skips both.
  let prerequisites = noPrereqs();
  let configProblems = [];
  if (toolkitRoot) {
    try {
      const project = loadProjectConfig(cwd);
      const toolkit = loadToolkitWithSources({
        builtinRoot: toolkitRoot,
        externalStacks: project.externalStacks ?? [],
        cwd,
        cacheDir: sourceCacheDir,
        refreshSources: false,
      });
      const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
      const trackedFiles = new Set(Object.keys(lock.files ?? {}));
      const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);
      const applicable = applicablePrerequisites(toolkit, selection);
      prerequisites = { evaluated: true, ...evaluatePrerequisites(applicable, cwd) };

      // Runs in every doctor mode without a re-render: tree and lock can hash-match a value the
      // toolkit now rejects, having rendered before the guard existed (#218).
      configProblems = configGuardProblems({ toolkit, project, selection });
      for (const problem of configProblems) notes.push(`invalid config value: ${problem}`);
      if (configProblems.length) {
        notes.push(`fix the value(s) in ${CONFIG_FILE}, then re-render — the current render was produced before this guard and may carry the bad value`);
      }
    } catch (err) {
      notes.push(`could not evaluate prerequisites: ${err.message}`);
    }
  }

  const driftOk = allowMissing
    ? modified.length === 0 && (!nothingPresent || verified)
    : modified.length === 0 && missing.length === 0;
  const ok = driftOk && prerequisites.unmetRequired.length === 0 && render.ok && configProblems.length === 0;
  return { ok, modified, missing, notes, attribution, allowMissing, nothingPresent, prerequisites, render, configProblems, toolkitProvenance };
}

/** Reproduce the render from the committed inputs in a temp dir and diff it against the lock (#314). */
export function verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, toolkitIdentity = null, sourceCacheDir = defaultSourceCacheDir() }) {
  const result = { evaluated: false, ok: false, checked: 0, stale: [], absent: [], unexpected: [], errors: [] };
  if (!toolkitRoot) {
    result.errors.push('--verify-render needs the toolkit to render from, but no toolkit root was supplied');
    return result;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wafflestack-verify-'));
  try {
    // Copy each input to its CANONICAL path so the temp render never triggers the legacy migration.
    const copy = (from, to) => {
      const dest = path.join(tmp, to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(from, dest, { recursive: true });
    };
    const config = resolveConfigFile(cwd);
    if (!exists(config.file)) {
      result.errors.push(`${CONFIG_FILE} not found — there is no config to verify the render against`);
      return result;
    }
    copy(config.file, CONFIG_FILE);

    // Extensions are copied (committed ⇒ part of the canonical render); the `.local` overlay is NOT (#317).
    const extensions = path.join(cwd, EXTENSIONS_DIR);
    if (exists(extensions)) copy(extensions, EXTENSIONS_DIR);
    copy(resolveLockFile(cwd).file, LOCK_FILE);

    // `sourceBaseDir: cwd` keeps a relative external `source:` resolving against the real repo, not tmp.
    const rendered = renderProject({
      toolkitRoot,
      cwd: tmp,
      sourceBaseDir: cwd,
      toolkitVersion,
      toolkitIdentity,
      sourceCacheDir,
      refreshSources: false,
    });
    if (!rendered.ok) {
      result.errors.push(...rendered.errors.map((e) => `render from the committed config failed: ${e}`));
      return result;
    }
    // Warnings dropped: they describe the temp dir (about to vanish), not the real tree.

    // Files-only, deliberately: comparing the `toolkit` block would red every unpinned consumer (#374).
    const produced = readLock(tmp)?.files ?? {};
    const tracked = lock.files ?? {};
    for (const [rel, hash] of Object.entries(tracked)) {
      if (!(rel in produced)) result.absent.push(rel);
      else if (produced[rel] !== hash) result.stale.push(rel);
    }
    for (const rel of Object.keys(produced)) {
      if (!(rel in tracked)) result.unexpected.push(rel);
    }

    result.evaluated = true;
    result.checked = Object.keys(produced).length;
    result.ok = !result.stale.length && !result.absent.length && !result.unexpected.length;
    for (const list of [result.stale, result.absent, result.unexpected]) list.sort((a, b) => a.localeCompare(b));
    return result;
  } catch (err) {
    result.errors.push(`could not verify the render: ${err.message}`);
    return result;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Human label for a lock `sources` entry, used to attribute drift (#125). */
function sourceLabel(src) {
  if (src.sourceType === 'git') {
    const at = src.commit ? String(src.commit).slice(0, 12) : (src.ref ?? 'unknown');
    return `${src.name} @ ${at}`;
  }
  return `${src.name} (${src.source})`;
}
