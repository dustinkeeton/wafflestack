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

/**
 * Compare managed files against the lock manifest → { ok, modified, missing, notes, attribution,
 * allowMissing, nothingPresent, prerequisites, render, configProblems, toolkitProvenance }.
 *
 * - allowMissing: absent files report instead of failing; modified and a missing lock still fail. An
 *   ALL-absent tree fails anyway (nothingPresent) — a never-rendered repo, not a tolerated subset (#311).
 * - attribution: maps each externally-sourced file to a human label so drift names its source (#125).
 * - prerequisites: a SELECTED stack's require-level checks fail doctor; recommend only reports (#129).
 * - verifyRender: re-renders committed inputs to a temp dir and diffs hashes vs the lock, catching a
 *   config/extension edit the tree and lock are stale about together; non-circular, and composes with
 *   allowMissing as the real gate for a lock-only repo (#314). Two locks: canonical is reproduced,
 *   tree-vs-lock reads readTreeLock so an overlay machine's bytes aren't called hand-edited (#317).
 * - toolkitProvenance: a WARNING, never gates `ok` (incl. same-version/different-commit); verifyRender
 *   already covers anything that mattered (#374). toolkitIdentity (#373) feeds it and the skew remedy.
 */
export function doctor({ cwd, toolkitVersion, toolkitIdentity = null, allowMissing = false, verifyRender = false, toolkitRoot = null, sourceCacheDir = defaultSourceCacheDir() }) {
  const lock = readLock(cwd);
  if (!lock) {
    // `toolkitProvenance` is part of the RETURN SHAPE even with no lock, so #372 can read
    // `.status` without a TypeError (#372/#374/#384 F5); no lock records no provenance.
    const toolkitProvenance = { status: /** @type {const} */ ('not-recorded'), notes: [] };
    return { ok: false, modified: [], missing: [], notes: [`${LOCK_FILE} not found — run \`wafflestack render\` first`], attribution: {}, allowMissing, toolkitProvenance, prerequisites: noPrereqs(), render: noVerify() };
  }
  // The manifest of what is actually on disk (#317): `lock` unless a local overlay shaped it.
  const tree = readTreeLock(cwd);
  // Ask whether a local lock EXISTS, not `tree !== lock`: readLock re-parses each call, so the
  // no-overlay fallback returns an equal-but-distinct object that would test true everywhere.
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
  // Say which lock answered the on-disk question — on an overlay machine those are not the
  // committed hashes, by design (#317).
  if (localRender) {
    notes.push(
      `${LOCAL_CONFIG_FILE} feeds this machine's render, so the files on disk were checked against ${LOCAL_LOCK_FILE} (this machine's render); ${LOCK_FILE} records the canonical render and is the one you commit`,
    );
  }
  // Always report which toolkit version rendered the tree, not just on skew from the CLI.
  const rendered = lock.toolkitVersion ?? 'unknown (pre-versioned lock)';
  notes.push(
    toolkitVersion
      ? `rendered by toolkit ${rendered}; installed CLI is ${toolkitVersion}`
      : `rendered by toolkit ${rendered}`,
  );
  if (toolkitVersion && lock.toolkitVersion && toolkitVersion !== lock.toolkitVersion) {
    // Name a remedy that WORKS and describe only the CLI in hand — never predict the gate (#372/#373).
    // Offline (the identity plain doctor is handed) an npx install reads `unverified` even when pinned
    // to a release tag, while `requireRelease()` resolves its OWN networked identity and proceeds.
    notes.push(
      toolkitIdentity && toolkitIdentity.status !== 'release' && toolkitIdentity.latestTag && toolkitIdentity.repo
        ? `version skew — run \`npx --yes github:${toolkitIdentity.repo}#${toolkitIdentity.latestTag} upgrade\` to apply migrations and re-render (this CLI is ${toolkitIdentity.status}; a bare \`upgrade\` re-fetches the default branch)`
        : 'version skew — run `wafflestack upgrade` to apply migrations and re-render',
    );
  }

  // Toolkit provenance (#374) — WARNING ONLY; see the docblock. Read from the CANONICAL lock, not
  // `tree`: which toolkit produced the render is a property of the committed render, not the overlay.
  const toolkitProvenance = describeToolkitProvenance({
    lockToolkit: lock.toolkit ?? null,
    lockVersion: lock.toolkitVersion ?? null,
    identity: toolkitIdentity,
  });
  notes.push(...toolkitProvenance.notes);

  if (modified.length) {
    notes.push('managed files have local edits; move changes into .waffle/extensions/ or config, then re-render');
  }

  // Render verification (#314), before the absence notes: whether an all-absent tree "verified
  // nothing" depends on whether this reproduced the render.
  const render = verifyRender
    ? verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, toolkitIdentity, sourceCacheDir })
    : noVerify();
  // Verification only *replaces* the on-disk comparison when it actually ran to completion.
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

  // Typed-prerequisite gate (#129) and config-value guard gate (#218). Best-effort: a load failure
  // becomes a note and skips both gates. Only a SELECTED stack's unmet `require` fails doctor.
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

      // A `pattern:` guard polices the config VALUE, so it runs in every doctor mode without a
      // re-render — catching a config the toolkit now rejects that tree and lock still hash-match
      // because it rendered before the guard existed (#218, recorded under #27).
      configProblems = configGuardProblems({ toolkit, project, selection });
      for (const problem of configProblems) notes.push(`invalid config value: ${problem}`);
      if (configProblems.length) {
        notes.push(`fix the value(s) in ${CONFIG_FILE}, then re-render — the current render was produced before this guard and may carry the bad value`);
      }
    } catch (err) {
      notes.push(`could not evaluate prerequisites: ${err.message}`);
    }
  }

  // Under --allow-missing only *modified* files are drift, except an all-absent tree (a never-
  // rendered repo) — which `--verify-render` alone excuses once it reproduces the render.
  const driftOk = allowMissing
    ? modified.length === 0 && (!nothingPresent || verified)
    : modified.length === 0 && missing.length === 0;
  // `ok` also fails on an unmet `require` prerequisite, a render that no longer reproduces the lock
  // (or a *failed* verification — an unanswered question is not a pass), and a rejected config value
  // (#218). `toolkitProvenance` is DELIBERATELY ABSENT — it only warns, never gates (#374; docblock).
  const ok = driftOk && prerequisites.unmetRequired.length === 0 && render.ok && configProblems.length === 0;
  return { ok, modified, missing, notes, attribution, allowMissing, nothingPresent, prerequisites, render, configProblems, toolkitProvenance };
}

/**
 * Reproduce the render from the committed inputs and compare it to the committed lock (#314).
 *
 * Copies `.waffle/waffle.yaml`, `.waffle/extensions/`, and the lock into a fresh temp dir, renders
 * there, and diffs the result — read-only on the tree, temp dir removed in `finally`. Rendering to
 * scratch (not in place) is what keeps it non-circular. The `.local` overlay is NOT copied: the lock
 * is defined not to depend on it (#317). The lock is copied as an INPUT, not just a target, because
 * render reads its tracked paths to keep an already-poured opt-in item selected. A render that fails
 * (or a missing toolkit root) is `ok: false` with the render's errors, not a clean bill.
 *
 * Three disagreements, reported separately:
 *   - `stale`      — same path, different hash: the config/extension changed and was never applied.
 *   - `absent`     — the lock tracks a path the current config no longer produces.
 *   - `unexpected` — the config would produce a path the lock does not track.
 *
 * The comparison is `files`-ONLY, and must stay that way (#374) — see the comment at the site.
 */
export function verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, toolkitIdentity = null, sourceCacheDir = defaultSourceCacheDir() }) {
  const result = { evaluated: false, ok: false, checked: 0, stale: [], absent: [], unexpected: [], errors: [] };
  if (!toolkitRoot) {
    result.errors.push('--verify-render needs the toolkit to render from, but no toolkit root was supplied');
    return result;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wafflestack-verify-'));
  try {
    // Copy each input to its CANONICAL path, resolving a legacy layout in — so the temp render never
    // triggers the legacy-dotfile migration, and could not touch the real tree if it did.
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

    // Extensions ARE copied (committed ⇒ canonical ⇒ part of the render being verified); the `.local`
    // overlay is NOT — see the docblock (#317).
    const extensions = path.join(cwd, EXTENSIONS_DIR);
    if (exists(extensions)) copy(extensions, EXTENSIONS_DIR);
    copy(resolveLockFile(cwd).file, LOCK_FILE);

    // `sourceBaseDir: cwd` keeps a relative external `source:` resolving against the real repo, not
    // the temp cwd. `toolkitIdentity` is threaded so the temp render writes the same `toolkit` block
    // a real one would (#374) — no effect on the files-only verdict, but a silent output diff is a trap.
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

    // Files-only comparison, deliberately (#374): extending it to the `toolkit` provenance block
    // would red every unpinned consumer on a byte-identical render. See DECISIONS #374.
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

/**
 * Human label for a lock `sources` entry, used to attribute drift (#125): a git source reads as
 * "<name> @ <short-commit>" (ref when no commit recorded), a local-path source as "<name> (<path>)".
 */
function sourceLabel(src) {
  if (src.sourceType === 'git') {
    const at = src.commit ? String(src.commit).slice(0, 12) : (src.ref ?? 'unknown');
    return `${src.name} @ ${at}`;
  }
  return `${src.name} (${src.source})`;
}
