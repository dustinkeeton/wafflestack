import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256, exists } from './util.mjs';
import { readLock, renderProject } from './render.mjs';
import {
  LOCK_FILE,
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  EXTENSIONS_DIR,
  resolveLockFile,
  resolveConfigFile,
  resolveLocalConfigFile,
  loadProjectConfig,
} from './project.mjs';
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
 * Compare managed files against the lock manifest.
 * Returns { ok, modified, missing, notes, attribution, allowMissing, nothingPresent }.
 *
 * `allowMissing` turns doctor into a CI-friendly drift gate: absent managed files are
 * reported informationally instead of failing the check, for repos that deliberately
 * gitignore *a subset* of their renders (so those files are legitimately absent in a fresh CI
 * checkout). Modified files are still an error, and a missing lock is still an error — the repo
 * never rendered, which the flag must not mask.
 *
 * That last rule applies one level down too (#311): a checkout where EVERY lock-tracked file is
 * absent is likewise a repo that never rendered, so `nothingPresent` fails the gate even under
 * `--allow-missing`. Without it, zero files present → zero modified → the check passes having
 * verified the empty set, and a green that inspected nothing is worse than a red. Tolerating a
 * subset is the supported posture; tolerating all of it never was.
 *
 * `attribution` maps each externally-sourced file to a human label for the source it came from
 * (#125), so a drift report names which external source a modified/missing file belongs to.
 * Built-in files have no entry (attributed to the toolkit); a pre-#125 lock with no `sources`
 * block yields an empty map — doctor then behaves exactly as before.
 *
 * `prerequisites` is the typed-prerequisite gate (#129): when `toolkitRoot` is supplied (the CLI
 * always passes it), doctor loads the project's selection and runs each SELECTED stack's declared
 * `prerequisites:` checks. An unmet `require`-level prerequisite is drift-equivalent — it fails
 * doctor (exit 1), so the shipped `waffle-doctor.yml` CI job verifies prerequisites on the same
 * run; a `recommend` entry only reports. The result is `{ evaluated, unmetRequired,
 * unmetRecommended, met }`. Evaluation is best-effort: if the toolkit/config cannot be loaded it
 * is skipped with a note rather than breaking the drift check, which needs neither.
 *
 * `verifyRender` (#314) closes the hole BOTH of the above share: they compare the tree to the lock,
 * and never ask whether either still reflects `.waffle/waffle.yaml`. Edit the config and forget to
 * re-render, and the files and the lock are stale *together* — they agree, and the gate goes green.
 * The flag renders the committed inputs into a temp dir and compares the resulting hashes to the
 * committed lock, so an un-applied config or extension change fails. It never touches the working
 * tree (which is precisely what makes it non-circular, unlike `render` + `doctor`: an in-place
 * render rewrites the very lock it would then be checked against). See `verifyRenderAgainstLock`.
 *
 * It composes with `allowMissing` deliberately: `nothingPresent` is the safety net (never pass
 * silently on nothing) and `--verify-render` is the principled escape from it ("I have no renders
 * on purpose — verify by rendering instead"), so `--allow-missing --verify-render` is a REAL gate
 * for a repo that commits only the lock. Opt-in: it needs the toolkit resolved (and, for external
 * `source:` stacks, possibly the network), so absent the flag doctor behaves exactly as before.
 */
export function doctor({ cwd, toolkitVersion, allowMissing = false, verifyRender = false, toolkitRoot = null, sourceCacheDir = defaultSourceCacheDir() }) {
  const lock = readLock(cwd);
  if (!lock) {
    return { ok: false, modified: [], missing: [], notes: [`${LOCK_FILE} not found — run \`wafflestack render\` first`], attribution: {}, allowMissing, prerequisites: noPrereqs(), render: noVerify() };
  }

  const attribution = {};
  for (const src of lock.sources ?? []) {
    const label = sourceLabel(src);
    for (const rel of src.files ?? []) attribution[rel] = label;
  }

  const modified = [];
  const missing = [];
  for (const [rel, hash] of Object.entries(lock.files)) {
    const abs = path.join(cwd, rel);
    if (!exists(abs)) {
      missing.push(rel);
    } else if (sha256(fs.readFileSync(abs)) !== hash) {
      modified.push(rel);
    }
  }

  // The all-absent guard (#311). `total > 0` keeps a lock with an empty file set out of it —
  // there is nothing to render, so nothing to have failed to render.
  const total = Object.keys(lock.files).length;
  const nothingPresent = allowMissing && total > 0 && missing.length === total;

  const notes = [];
  // A repo still on the legacy lock name reads fine (readLock falls back) but should migrate.
  const lockPath = resolveLockFile(cwd);
  if (lockPath.legacy) notes.push(lockPath.note);
  // Always report which toolkit version the tree was rendered from, so a drift report
  // says what a repo is sitting on — not just when it happens to skew from the CLI.
  const rendered = lock.toolkitVersion ?? 'unknown (pre-versioned lock)';
  notes.push(
    toolkitVersion
      ? `rendered by toolkit ${rendered}; installed CLI is ${toolkitVersion}`
      : `rendered by toolkit ${rendered}`,
  );
  if (toolkitVersion && lock.toolkitVersion && toolkitVersion !== lock.toolkitVersion) {
    notes.push(`version skew — run \`wafflestack upgrade\` to apply migrations and re-render`);
  }
  if (modified.length) {
    notes.push('managed files have local edits; move changes into .waffle/extensions/ or config, then re-render');
  }

  // Render verification (#314). Runs before the notes about absence below, because whether an
  // all-absent tree "verified nothing" depends on whether this reproduced the render instead.
  const render = verifyRender
    ? verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, sourceCacheDir })
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

  // Typed-prerequisite gate (#129). Best-effort: any failure to load the toolkit/config/selection
  // is surfaced as a note and skips the gate rather than breaking the drift check (which needs
  // neither). Only an unmet `require`-level prerequisite of a SELECTED stack fails doctor.
  let prerequisites = noPrereqs();
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
    } catch (err) {
      notes.push(`could not evaluate prerequisites: ${err.message}`);
    }
  }

  // With --allow-missing, only *modified* files count as drift; absent files are informational —
  // unless every one of them is absent, which is a never-rendered repo, not a tolerated subset.
  // `--verify-render` lifts exactly that veto and nothing else: an all-absent tree no longer
  // "verified nothing" once the render has been reproduced and checked against the lock.
  const driftOk = allowMissing
    ? modified.length === 0 && (!nothingPresent || verified)
    : modified.length === 0 && missing.length === 0;
  // An unmet `require` prerequisite is drift-equivalent — it fails the gate; `recommend` never does.
  // So is a render that no longer reproduces the lock — and so is a *failed* verification: the flag
  // asked a question that could not be answered, which must never read as a pass.
  const ok = driftOk && prerequisites.unmetRequired.length === 0 && render.ok;
  return { ok, modified, missing, notes, attribution, allowMissing, nothingPresent, prerequisites, render };
}

/**
 * Reproduce the render from the committed inputs and compare it to the committed lock (#314).
 *
 * The inputs — `.waffle/waffle.yaml`, the `.local` overlay, `.waffle/extensions/`, and the lock
 * itself — are copied into a fresh temp dir, which is then rendered as if it were the project.
 * The working tree is never written to, read-only from start to finish; the temp dir is removed in
 * a `finally`, including on error. That isolation is the whole point: gating on an in-place
 * `render` mutates the tree AND rewrites the lock it would be compared against, so it cannot fail
 * (see the tautology warning in docs/gitignore.md). Rendering to scratch and diffing against the
 * *unmodified* committed lock has no such circularity.
 *
 * Three ways the lock can disagree with a fresh render, reported separately because they mean
 * different things:
 *   - `stale`      — same path, different hash: the config/extension changed and was never applied.
 *   - `absent`     — the lock tracks a path the current config no longer produces (a stale entry a
 *                    re-render would prune).
 *   - `unexpected` — the config would produce a path the lock does not track (a re-render would add).
 *
 * The lock is copied in as an input, not just a comparison target, because render *reads* it: its
 * tracked paths are what keep an already-installed opt-in syrup item selected (see `renderProject`).
 * Without it, a repo that poured optional syrup would render a smaller set here and report every one
 * of those files as `absent` — drift that exists only because we withheld an input.
 *
 * A render that outright fails (bad config, unresolvable source) is a failure of the check, not a
 * clean bill of health: `ok: false` with the render's own errors. Same for a missing toolkit root.
 *
 * And the same for an input that is not here to render *from* (#308 review). The `.local` overlay is
 * gitignored by design, so it does not exist in a CI checkout — while the lock was rendered on a
 * machine where it did. Reproducing the render without it silently substitutes stack `default:`s
 * (`git.botEmail` is `required: false`, so nothing errors) and every file the overlay touched comes
 * back `stale`. That is a missing input, not drift, and reporting it as drift is worse than useless:
 * the remediation it implies — re-render and commit — would bake the default over the repo's real
 * bot identity. So when the lock says the overlay fed the render and the overlay is absent, refuse
 * the question: `ok: false` with an error that says which input is missing, and no drift at all.
 */
export function verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, sourceCacheDir = defaultSourceCacheDir() }) {
  const result = { evaluated: false, ok: false, checked: 0, stale: [], absent: [], unexpected: [], errors: [] };
  if (!toolkitRoot) {
    result.errors.push('--verify-render needs the toolkit to render from, but no toolkit root was supplied');
    return result;
  }
  if (lock?.renderedWithLocalOverlay && !exists(resolveLocalConfigFile(cwd).file)) {
    result.errors.push(
      `cannot verify the render: the lock was rendered with ${LOCAL_CONFIG_FILE}, which supplied a value the render used — and that file is not here. It is gitignored by design, so it is absent in every fresh CI checkout. Re-rendering without it would fall back to stack defaults and report every file it touched as stale, so this check refuses to guess. Move the render-affecting keys into ${CONFIG_FILE} (see docs/gitignore.md — a repo that verifies its render in CI must commit the values that feed it), or run --verify-render where the overlay exists.`,
    );
    return result;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wafflestack-verify-'));
  try {
    // Copy each input to its CANONICAL path, resolving a legacy layout on the way in. The temp
    // render therefore never triggers the legacy-dotfile migration (which renames files) — and
    // could not touch the real tree with it even if it did.
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

    const localConfig = resolveLocalConfigFile(cwd);
    if (exists(localConfig.file)) copy(localConfig.file, LOCAL_CONFIG_FILE);
    const extensions = path.join(cwd, EXTENSIONS_DIR);
    if (exists(extensions)) copy(extensions, EXTENSIONS_DIR);
    copy(resolveLockFile(cwd).file, LOCK_FILE);

    // `sourceBaseDir: cwd` keeps a relative local-path external `source:` resolving against the
    // real repo — the one thing in the render that must NOT follow the temp cwd.
    const rendered = renderProject({
      toolkitRoot,
      cwd: tmp,
      sourceBaseDir: cwd,
      toolkitVersion,
      sourceCacheDir,
      refreshSources: false,
    });
    if (!rendered.ok) {
      result.errors.push(...rendered.errors.map((e) => `render from the committed config failed: ${e}`));
      return result;
    }
    // Warnings are deliberately dropped: they describe the *temp* dir (no .codex/config.toml, no
    // .gitignore …), so surfacing them would be noise about a directory that is about to vanish.

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
 * Human label for a lock `sources` entry, used to attribute drift. A git source reads as
 * "<name> @ <short-commit>" (falling back to the ref when a pre-#125-ish lock recorded no
 * commit); a local-path source as "<name> (<path>)".
 */
function sourceLabel(src) {
  if (src.sourceType === 'git') {
    const at = src.commit ? String(src.commit).slice(0, 12) : (src.ref ?? 'unknown');
    return `${src.name} @ ${at}`;
  }
  return `${src.name} (${src.source})`;
}
