import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  exists,
  writeFileEnsuringDir,
  stringifyFrontmatter,
} from './util.mjs';
import { substitute, placeholderKeys, makeGuard } from './template.mjs';
import { loadToolkitWithSources, missingRequiredKeys } from './toolkit.mjs';
import { defaultSourceCacheDir } from './sources.mjs';
import { computeSelection, skippedSyrupCompanions } from './refs.mjs';
import { validateExternalStacks, RESERVED_AGENT_KEYS } from './validate.mjs';
import { applicablePrerequisites, evaluatePrerequisites, formatPrereq, RENDER_PROBE_KINDS } from './prerequisites.mjs';
import { generateWaffleDocs } from './waffledocs.mjs';
import {
  loadProjectConfig,
  makeResolver,
  migrateLegacyDotfiles,
  staleGitignoreEntries,
  gitignoreMentions,
  resolveLockFile,
  resolveLocalConfigFile,
  localLockPath,
  HARNESS_PATTERNS,
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  LOCK_FILE,
  LOCAL_LOCK_FILE,
  EXTENSIONS_DIR,
} from './project.mjs';

/**
 * Render every enabled stack into the project at `cwd`.
 * Frozen-image contract: outputs are regenerated verbatim; managed files from the
 * previous lock that are no longer rendered get deleted; a fresh lock is written.
 *
 * ## Two renders, because the lock is shared and the overlay is not (#317)
 *
 * `.waffle/waffle.local.yaml` is a developer's private tooling: gitignored, different on every
 * machine, and absent in CI. It must never reach a teammate's workspace — and the lock is a
 * *committed* file, so a lock built from the overlay's values is exactly that leak. (It was one:
 * two developers with different `git.botEmail` overlays produced different committed lock hashes,
 * and each one's commit reverted the other's.) So this function computes the render twice:
 *
 *   - the **effective** render — committed config *plus* the overlay — is what gets **written to
 *     disk**, so your working copy carries YOUR values, exactly as before;
 *   - the **canonical** render — committed inputs alone (`.waffle/waffle.yaml` +
 *     `.waffle/extensions/`) — is what gets **hashed into `.waffle/waffle.lock.json`**.
 *
 * Canonical means *everything committed*. Extensions are committed, so they are canonical and they
 * still propagate — that contrast with the overlay is the whole design. The consequences all fall
 * out: every developer's committed lock is byte-identical, nobody is ever red-gated into committing
 * a personal value, and `doctor --verify-render` (which renders the committed config in a temp dir)
 * reproduces the canonical lock exactly, so it goes green in CI instead of refusing to answer.
 *
 * With no overlay present the two configs are the same object and the second render is skipped
 * entirely — the overwhelmingly common case pays nothing and behaves byte-for-byte as before.
 *
 * When they diverge, the bytes on disk are no longer the bytes the lock records, so the frozen-image
 * bookkeeping needs its own truthful record of the tree: `.waffle/waffle.local.lock.json`, gitignored,
 * written only on divergence and removed when it ends. See `readTreeLock`.
 *
 * `sourceBaseDir` is the base a *relative local-path* external `source:` resolves against; it
 * defaults to `cwd` (the project being rendered), which is what every ordinary render wants. It is
 * separable only for `doctor --verify-render` (#314), which renders the committed inputs into a
 * temp dir to check them against the lock: there `cwd` is the scratch dir, but a `source: ../foo`
 * in the config still names a path relative to the REAL repo. Nothing else in the render follows
 * it — outputs, extensions, and the lock all stay bound to `cwd`.
 */
export function renderProject({
  toolkitRoot,
  cwd,
  sourceBaseDir = cwd,
  toolkitVersion,
  force = false,
  log = () => {},
  sourceCacheDir = defaultSourceCacheDir(),
  refreshSources = false,
}) {
  const warnings = [];
  // Carry a legacy repo forward before reading anything: move the consumer dot-paths
  // (root `.waffle.*`, or pre-0.6.0 `.wafflestack.*`) into `.waffle/` so config load and
  // the frozen-image lock below see the current layout. A no-op on an already-migrated or
  // fresh repo.
  for (const { from, to } of migrateLegacyDotfiles(cwd)) log(`renamed legacy ${from} → ${to}`);
  const stale = staleGitignoreEntries(cwd);
  if (stale.length) {
    warnings.push(
      `.gitignore still lists ${stale.join(', ')} — update to the .waffle/ paths (the CLI does not edit .gitignore)`,
    );
  }

  // The two configs (see the docblock). `canonicalProject === project` — the same object, by
  // identity — is the "no overlay" fast path every branch below tests against.
  const project = loadProjectConfig(cwd, warnings);
  const canonicalProject = exists(resolveLocalConfigFile(cwd).file)
    ? loadProjectConfig(cwd, [], { canonical: true })
    : project;

  // External stack sources (#88): resolve each declared `{ name, source, ref }` entry to a
  // toolkit root — a git URL fetched at the pinned `ref`, or a local path read in place — and
  // merge its named stack into the registry, so one render/lock/doctor pipeline handles built-in
  // and external stacks alike. Cross-source name collisions are a hard error naming both sources
  // (see loadToolkitWithSources). A resolution/collision failure is surfaced as a render error
  // (same fail-loud, tree-untouched contract as the guards below), not thrown.
  const loadToolkitFor = (proj) =>
    loadToolkitWithSources({
      builtinRoot: toolkitRoot,
      externalStacks: proj.externalStacks ?? [],
      cwd: sourceBaseDir,
      cacheDir: sourceCacheDir,
      refreshSources,
    });
  let toolkit;
  let canonicalToolkit;
  try {
    toolkit = loadToolkitFor(project);
    // The canonical render must resolve its stacks from the COMMITTED config too — otherwise an
    // overlay that redeclares `stacks:` (an added source, a different `ref:`) would leak back into
    // the lock through the toolkit registry, by the back door. Re-resolved only when the overlay
    // actually changes the external entries; the source cache makes that near-free when it does.
    canonicalToolkit = sameExternalStacks(project, canonicalProject) ? toolkit : loadToolkitFor(canonicalProject);
  } catch (err) {
    return { ok: false, warnings, errors: [err.message] };
  }

  // Install-time trust boundary (#126): before rendering anything, lint the definitions of every
  // EXTERNAL stack (a stack pulled from a `source:` — it carries `provenance`). A malformed
  // third-party stack (missing frontmatter, undeclared placeholder, dangling `requires:`) must
  // fail loudly HERE, before a single file is written, with a message naming the source — the
  // consumer can't fix it and shouldn't ship a broken render. Load-time already rejects the
  // coarser breakage (unparseable manifest, missing SKILL.md); this adds the finer lint the
  // toolkit's own `validate` runs, scoped to external stacks so built-in ones aren't re-linted on
  // every consumer render. Returning here leaves the tree untouched (nothing is written yet).
  const externalProblems = new Set([
    ...(project.externalStacks?.length ? validateExternalStacks(toolkit) : []),
    ...(canonicalToolkit !== toolkit && canonicalProject.externalStacks?.length
      ? validateExternalStacks(canonicalToolkit)
      : []),
  ]);
  if (externalProblems.size) {
    return {
      ok: false,
      warnings,
      errors: [...externalProblems].map((p) => `${p} — malformed external stack; fix it at the source before rendering`),
    };
  }

  // Read both locks up front, before anything is written.
  //   `lock`      — the committed, CANONICAL lock: what the project renders.
  //   `localLock` — the gitignored, EFFECTIVE lock: what THIS machine last rendered. Absent
  //                 unless the overlay moved a byte.
  // Every question about the tree on disk (which files are mine to prune, which pre-existing file
  // would I clobber, which opt-in syrup is already poured here) must be answered by the lock that
  // actually describes that tree — so the frozen-image bookkeeping below reads `treeLock`, never
  // `lock`. Answering from the canonical lock on an overlay machine would prune files it never
  // wrote and refuse to overwrite files it did.
  const lock = readLock(cwd);
  const localLock = readLocalLock(cwd);
  const treeLock = localLock ?? lock;

  const errors = [];
  const effective = computeOutputs({
    toolkit,
    project,
    cwd,
    errors,
    warnings,
    trackedFiles: new Set(Object.keys(treeLock?.files ?? {})),
  });

  // Generalized prerequisite warnings (#129): beyond the legacy `env:` map, every declared
  // `prerequisites:` entry cheap to probe locally (a `tool`/`env` kind — a `command -v` binary
  // check or an env-var read) that is currently unmet emits a non-blocking `warning:`. This is
  // advisory only — it never fails the render (that is `doctor`'s job), and it deliberately does
  // NOT shell out for the network/auth kinds (secret, scope, label, setting, service), which the
  // deliberate `doctor` gate verifies instead. Scoped to the selected items, like `requires:`.
  //
  // Deliberately OUTSIDE `computeOutputs`: it shells out, and it describes the machine you are
  // rendering on — so it runs once, against the effective selection, never twice.
  {
    const prereqs = applicablePrerequisites(toolkit, { items: effective.selection.items });
    const { unmetRequired, unmetRecommended } = evaluatePrerequisites(prereqs, cwd, {
      kinds: RENDER_PROBE_KINDS,
      timeoutMs: 5000,
    });
    for (const p of [...unmetRequired, ...unmetRecommended]) warnings.push(formatPrereq(p));
  }

  // The same placeholder is substituted once per target, so a missing value yields
  // one error per target — collapse to a distinct set.
  //
  // The developer's OWN render is checked first, and a failure returns here — which is also what
  // keeps the canonical failure below unambiguous. If the effective render is broken, that is the
  // problem to report; only once it is clean can a *canonical* error mean anything else.
  if (errors.length) return { ok: false, errors: [...new Set(errors)], warnings };

  // The canonical render — the bytes the lock will record. Nothing here is written to disk.
  // Its warnings are dropped on purpose: they describe a render that exists nowhere (the syrup
  // pairing note, the env prerequisites) and would double every line the effective pass already
  // said.
  const canonicalErrors = [];
  const canonical =
    canonicalProject === project
      ? effective
      : computeOutputs({
          toolkit: canonicalToolkit,
          project: canonicalProject,
          cwd,
          errors: canonicalErrors,
          warnings: [],
          trackedFiles: new Set(Object.keys(lock?.files ?? {})),
        });

  // A canonical error that survives a clean effective render can have exactly one cause: the
  // overlay supplied something the committed config cannot. The headline case is a `required:` key
  // with no `default:` held ONLY in the overlay — the render works for you and for nobody else,
  // and the lock could not be built from committed inputs at all.
  //
  // That must be LOUD, never a silent fallback to a default nobody asked for, and never a silent
  // half-lock (#317, constraint 2). It is not a red-gate on a *personal* value either: the fix is
  // to commit SOME value — a team address, the stack's own default, a placeholder — while your
  // private one keeps overriding it locally. A defaultless required key is by definition one the
  // stack cannot render without, so the canonical render must be given something.
  if (canonicalErrors.length) {
    return {
      ok: false,
      warnings,
      errors: [
        `${LOCK_FILE} records the CANONICAL render — what ${CONFIG_FILE} + ${EXTENSIONS_DIR}/ produce on ` +
          `their own — and that render fails. Yours succeeds only because ${LOCAL_CONFIG_FILE} supplies what ` +
          `the committed config is missing, and that overlay is private: it is gitignored, so it is in no ` +
          `teammate's checkout and in no CI runner, and the shared lock can never be built from it. Commit a ` +
          `value for each key below to ${CONFIG_FILE} — the overlay still overrides it locally, for you alone.`,
        ...new Set(canonicalErrors),
      ],
    };
  }

  // Frozen image: reconcile against the lock that describes the TREE (read up front).
  const managed = treeLock?.files ?? {};

  // Refuse to clobber a pre-existing UNMANAGED file: a path this render would produce that
  // already exists on disk but was not tracked by the previous lock — i.e. the consumer's
  // own hand-written file, not a prior render of ours. A byte-identical file is adopted
  // silently (the write is a no-op and the new lock records it either way); only a genuine
  // content difference is a collision. `--force` overwrites. Checked before any write or
  // prune, so a refusal leaves the whole tree untouched — same fail-loud spirit as the
  // cross-stack `emit()` conflict above.
  if (!force) {
    const collisions = [];
    for (const [rel, content] of effective.outputs) {
      if (rel in managed) continue; // already ours — re-render/restore is expected
      const abs = path.join(cwd, rel);
      if (!exists(abs)) continue; // fresh path — nothing to clobber
      if (sha256(fs.readFileSync(abs)) === sha256(content)) continue; // identical — silent adopt
      collisions.push(rel);
    }
    if (collisions.length) {
      const errs = collisions
        .sort((a, b) => a.localeCompare(b))
        .map(
          (rel) =>
            `refusing to overwrite ${rel}: a pre-existing file not tracked by ${LOCK_FILE} — back it up or remove it and re-render, or pass \`--force\` to overwrite it`,
        );
      return { ok: false, errors: errs, warnings };
    }
  }

  // Remove previously managed files that this render no longer produces.
  const removed = [];
  for (const rel of Object.keys(managed)) {
    if (!effective.outputs.has(rel) && exists(path.join(cwd, rel))) {
      fs.rmSync(path.join(cwd, rel));
      removed.push(rel);
    }
  }

  // Write the EFFECTIVE render — your overlay's values, on your disk.
  for (const [rel, content] of sortedOutputs(effective.outputs)) {
    writeFileEnsuringDir(path.join(cwd, rel), content);
  }

  const canonicalFiles = hashOutputs(canonical.outputs);
  const effectiveFiles = canonical === effective ? canonicalFiles : hashOutputs(effective.outputs);

  // Per-source provenance (#125): attribute every rendered *external* file to the source it came
  // from. `producedBy` records "<stackName>/<kind>/…" per output, and only external stacks carry
  // `provenance` — so built-in and waffledocs outputs have no source entry and stay attributable
  // to the toolkit as before. The `sources` block is omitted when empty, so a built-in-only lock
  // is byte-identical to the pre-#125 shape (backward compatible: an old lock still validates and
  // doctors clean, since doctor/upgrade treat a missing `sources` as "all built-in").
  const sources = collectSourceProvenance(canonical.groups, canonical.producedBy, canonicalFiles);

  // The committed lock: canonical throughout — its `targets`/`stacks`/`include` come from the
  // committed config, not the merged one, for the same reason its hashes do. `stacks:` records
  // the enabled built-in stack names; `sources` (when present) records each external source's
  // resolved provenance and the files it produced. External files also live in `files` so doctor
  // drift-checks them like any managed file.
  writeLockFile(path.join(cwd, LOCK_FILE), {
    toolkitVersion,
    targets: canonicalProject.targets,
    stacks: canonicalProject.stacks,
    include: canonicalProject.include,
    ...(sources.length ? { sources } : {}),
    files: canonicalFiles,
  });

  // The local lock: written only when the overlay actually moved a byte, so a repo with no overlay
  // — or one holding only keys the render never reads (`git.signingKey`, a board id) — never grows
  // the file at all. Removed again the moment that stops being true, because a stale local lock
  // would go on describing a tree that no longer exists.
  const localLockFile = localLockPath(cwd);
  const overlayChangedTheRender = JSON.stringify(effectiveFiles) !== JSON.stringify(canonicalFiles);
  if (overlayChangedTheRender) {
    writeLockFile(localLockFile, {
      toolkitVersion,
      targets: project.targets,
      stacks: project.stacks,
      include: project.include,
      ...(() => {
        const s = collectSourceProvenance(effective.groups, effective.producedBy, effectiveFiles);
        return s.length ? { sources: s } : {};
      })(),
      files: effectiveFiles,
    });
    // An un-ignored local lock would be the very propagation this design closes, one file over:
    // commit it and every teammate's `doctor` compares their tree against YOUR machine's hashes.
    if (!gitignoreMentions(cwd, LOCAL_LOCK_FILE)) {
      warnings.push(
        `${LOCAL_CONFIG_FILE} feeds your render, so ${LOCAL_LOCK_FILE} now records the result — and .gitignore ` +
          `does not list it. It is machine-specific, like the overlay itself: add it (or re-run with ` +
          `\`--gitignore\`). ${LOCK_FILE} stays canonical and is the one to commit.`,
      );
    }
  } else if (exists(localLockFile)) {
    fs.rmSync(localLockFile);
  }

  log(`rendered ${effective.outputs.size} files${removed.length ? `, removed ${removed.length} stale` : ''}`);
  return { ok: true, errors: [], warnings, written: [...effective.outputs.keys()], removed, sources };
}

/**
 * Compute every file a `project` config would render — the pure core of `renderProject`, run once
 * per config (effective and canonical; see that docblock). It reads the toolkit and the committed
 * `.waffle/extensions/`, and writes nothing: the caller decides which result lands on disk and
 * which one is merely hashed.
 *
 * `errors` and `warnings` are push-style sinks the caller owns — the canonical pass hands in a
 * throwaway `warnings` array precisely because its advisories describe a render that exists
 * nowhere. Returns the pieces the caller still needs: `outputs` (path → content), `producedBy`
 * (path → the "stack/kind/name" that emitted it) and `groups`, which together build the lock's
 * per-source provenance, and `selection`, which the prerequisite probe runs against.
 */
function computeOutputs({ toolkit, project, cwd, trackedFiles, errors, warnings }) {
  const outputs = new Map(); // relative path -> content (string | Buffer)
  const producedBy = new Map(); // relative path -> "stack/kind/name" that emitted it
  // Two enabled stacks may define same-named items (alternative implementations of
  // the same skill, say) — fine in the toolkit, but rendering both would silently
  // last-write-wins. Fail loudly instead.
  const emit = (rel, content, context) => {
    if (producedBy.has(rel) && producedBy.get(rel) !== context) {
      errors.push(
        `output conflict: ${rel} is produced by both ${producedBy.get(rel)} and ${context} — enable only one, or eject one of them`,
      );
      return;
    }
    producedBy.set(rel, context);
    outputs.set(rel, content);
  };

  // Selection = union(items of enabled stacks) ∪ closure(include items) − eject. An external
  // `{ name, source, ref }` entry enables its stack exactly like a bare built-in name — both are
  // registered in `toolkit.stacks` — so fold the external names into the enabled set here.
  // `trackedFiles` (the caller's lock paths) lets the selection keep rendering an opt-in syrup item
  // the repo already has, so existing installs keep getting updates while opt-in syrup stays gated
  // out of a fresh stack expansion.
  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);
  errors.push(...selection.errors);

  // Reverse the syrup companion edge (#74): an opt-in syrup file pairs with a companion waffle
  // via `requires:` (installing the syrup pulls the companion), but the render only walks that
  // forward — so selecting the companion, or enabling its whole stack, leaves the paired syrup
  // gated out and silent. Surface each skipped pairing with the exact pour command. This is the
  // deliberately non-interactive CLI's stand-in for the both/one/neither question the setup
  // playbook (schema/SETUP.md step 2) now requires an agent to ask.
  for (const { fileRef, stackName, companions } of skippedSyrupCompanions(toolkit, selection)) {
    // External opt-in syrup is doubly gated (#126): a paired external syrup file was authored
    // outside this repo, so its extra trust-boundary acknowledgement rides along with the
    // both/one/neither pairing note — distinct from a built-in companion, which needs only the
    // ordinary opt-in.
    const prov = toolkit.stacks.get(stackName)?.provenance;
    const external = prov
      ? ` — this is EXTERNAL syrup from source "${stackName}" (${describeProvenance(prov)}), so pouring it ` +
        `additionally requires an explicit trust-boundary acknowledgement beyond the normal opt-in`
      : '';
    warnings.push(
      `opt-in syrup ${fileRef} (${stackName}) pairs with selected ${companions.join(', ')} but was not ` +
        `installed — run \`wafflestack install ${fileRef}\` to pour it, or leave it out on purpose${external}`,
    );
  }

  // Trust-boundary acknowledgement for EXTERNAL opt-in syrup being poured (#126). Opt-in syrup is
  // already gated behind explicit opt-in; when it comes from an external source, the content was
  // authored OUTSIDE this repo (and may demand elevated permissions — a workflow with repo write),
  // so pouring it deserves one more, clearly-worded acknowledgement, distinct from built-in opt-in
  // syrup. The CLI never prompts, so — like the pairing warning above — this is surfaced as a
  // required acknowledgement the setup/install flow must put to the user.
  for (const { stackName, stack, kind, item } of selection.items) {
    if (kind !== 'files' || !stack.provenance) continue;
    if (!stack.optIn.has(`files/${item.name}`)) continue;
    warnings.push(
      `EXTERNAL opt-in syrup files/${item.name} (from external source "${stackName}" — ` +
        `${describeProvenance(stack.provenance)}) is being rendered into this repo. It was authored ` +
        `OUTSIDE this repo and may demand elevated permissions (e.g. repo write) — acknowledge this ` +
        `trust boundary, beyond the normal opt-in, and confirm you trust the source before committing ` +
        `the render`,
    );
  }

  // Group by owning stack so config/env checks run per stack, but only over the
  // items actually selected (an included item does not drag in its stack's siblings).
  const groups = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName).items.push({ kind, item });
  }

  // Compile every `pattern:` guard the toolkit declares ONCE, across all stacks, then enforce
  // them at every substitution site below (render-time value validation for config values).
  // Toolkit-wide, not per-stack: see compileGuards.
  const guards = compileGuards(toolkit, errors);

  for (const [stackName, { stack, items }] of groups) {
    // One resolver per enabled target — the reserved `harness.*` keys resolve
    // differently per output target (Claude vs. Codex attribution, etc.).
    const primaryTarget = project.targets[0] ?? 'claude';
    const resolvers = {};
    for (const target of project.targets) resolvers[target] = makeResolver(stack, project.values, target);
    // Files render once (harness-independent) and the missing-required-key probe needs a
    // single resolver — both use the primary target's identity for any `harness.*` refs.
    const primaryResolver = resolvers[primaryTarget] ?? makeResolver(stack, project.values, primaryTarget);
    // Scope required-config to keys the *selected* items actually reference — installing
    // one skill from a stack must not demand config only its siblings use.
    const usedKeys = collectUsedKeys(items);
    const missing = missingRequiredKeys(stack, project.values, (values, key) => primaryResolver(key), usedKeys);
    if (missing.length) {
      errors.push(
        `stack "${stackName}" needs config values: ${missing.map((k) => `config.${k}`).join(', ')} — add them to ${CONFIG_FILE} (or the .local overlay)`,
      );
      continue;
    }

    for (const { kind, item } of items) {
      if (kind === 'agents') renderAgent({ agent: item, stack, resolvers, project, cwd, emit, errors, guards });
      else if (kind === 'skills') renderSkill({ skill: item, stack, resolvers, project, cwd, emit, errors, guards });
      else renderFiles({ file: item, stack, resolve: primaryResolver, emit, errors, guards });
    }
    // Env prerequisites still warn when any item from this stack renders.
    checkEnvPrerequisites({ stack, project, cwd, warnings });
  }

  // Generate the `.waffle/` overview docs (cheat sheet + team intro, Markdown + branded HTML)
  // from the same computed selection, through the same `emit()` choke point — so they are
  // lock-tracked, doctor-drift-checked, pruned when stale, and refreshed on every render.
  // Only when the item loop was clean: a missing required key already failed the render, and
  // re-substituting descriptions here would just repeat those errors.
  if (!errors.length) {
    for (const { rel, content } of generateWaffleDocs({ toolkit, project, selection, errors })) {
      emit(rel, content, 'waffledocs');
    }
  }

  return { outputs, producedBy, groups, selection };
}

/** Outputs in a stable order — the lock's key order, and therefore its bytes, must not depend on
 *  the order stacks happened to render in. */
const sortedOutputs = (outputs) => [...outputs.entries()].sort(([a], [b]) => a.localeCompare(b));

/** A lock's `files` manifest: every rendered path → the sha256 of its content, sorted. */
function hashOutputs(outputs) {
  const files = {};
  for (const [rel, content] of sortedOutputs(outputs)) files[rel] = sha256(content);
  return files;
}

/** @param {string} file @param {object} lock */
function writeLockFile(file, lock) {
  writeFileEnsuringDir(file, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Do two configs declare the same external stack sources? Compared structurally (`normalizeStackEntries`
 * emits its entries in config order, with a fixed key order), so this is exactly "would these two
 * resolve the same toolkit registry" — the question that decides whether the canonical render can
 * reuse the effective render's toolkit or must load its own.
 */
function sameExternalStacks(a, b) {
  return JSON.stringify(a.externalStacks ?? []) === JSON.stringify(b.externalStacks ?? []);
}

function renderAgent({ agent, stack, resolvers, project, cwd, emit, errors, guards }) {
  const context = `${stack.name}/agents/${agent.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'agents', `${agent.name}.md`);
  // Body and description are substituted per target so `harness.*` resolves to that
  // target's identity (description is the one frontmatter field carrying prose).
  const bodyFor = (target) =>
    appendExtension(substitute(agent.body, resolvers[target], stack.declared, errors, context, guards), cwd, extPath);
  const descriptionFor = (target) =>
    substitute(agent.data.description ?? '', resolvers[target], stack.declared, errors, context, guards);

  if (project.targets.includes('claude')) {
    const fm = { name: agent.data.name ?? agent.name, description: descriptionFor('claude') };
    if (agent.data.skills) fm.skills = agent.data.skills;
    // `identity:` (#156) — the agent's virtualized git author, read at spawn time by the
    // delegate orchestrator off the rendered agent file. Harnesses that don't know the field
    // ignore it (Claude Code identifies an agent by name/description), so passing it through
    // is safe; codex's TOML has no shape for it and drops it.
    if (agent.data.identity) fm.identity = agent.data.identity;
    // The `claude:` passthrough may not shadow a reserved key. `validateStack` rejects that for
    // toolkit and (via `validateExternalStacks`, above) external stacks alike; stripping here is
    // defense in depth, so a validated `identity` can never be overwritten by an unvalidated one
    // hoisted out of `claude:` — that pathway would bypass DISPLAY_NAME_RE entirely.
    for (const [k, v] of Object.entries(agent.data.claude ?? {})) {
      if (!RESERVED_AGENT_KEYS.includes(k)) fm[k] = v;
    }
    emit(
      path.join('.claude', 'agents', `${agent.name}.md`),
      stringifyFrontmatter(fm, bodyFor('claude')),
      context,
    );
  }
  if (project.targets.includes('codex')) {
    emit(
      path.join('.codex', 'agents', `${agent.name}.toml`),
      agentToml(agent, bodyFor('codex'), descriptionFor('codex')),
      context,
    );
  }
  if (project.targets.includes('agents-dir')) {
    // Cross-tool `.agents/` convention: harness-neutral Markdown that mirrors the Claude
    // agent shape (frontmatter name/description + the neutral `skills:` grant-pointer, body)
    // but drops the Claude-only `claude:` passthrough block — so it renders correctly for any
    // AGENTS.md-ecosystem tool. Skills already land in the sibling `.agents/skills/`.
    const fm = { name: agent.data.name ?? agent.name, description: descriptionFor('agents-dir') };
    if (agent.data.skills) fm.skills = agent.data.skills;
    if (agent.data.identity) fm.identity = agent.data.identity;
    emit(
      path.join('.agents', 'agents', `${agent.name}.md`),
      stringifyFrontmatter(fm, bodyFor('agents-dir')),
      context,
    );
  }
}

function agentToml(agent, body, description = agent.data.description ?? '') {
  const name = agent.data.name ?? agent.name;
  return [
    `name = ${tomlBasicString(name)}`,
    `description = ${tomlBasicString(description)}`,
    `developer_instructions = ${tomlMultilineString(body.trimEnd())}`,
    '',
  ].join('\n');
}

function tomlBasicString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function tomlMultilineString(s) {
  // Escape backslashes and any run of 3+ quotes that would terminate the literal.
  const escaped = String(s).replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
  return `"""\n${escaped}"""`;
}

function renderSkill({ skill, stack, resolvers, project, cwd, emit, errors, guards }) {
  // Map each output dir → the target identity to substitute it with. Codex and agents-dir
  // both consume skills from the cross-tool `.agents/skills` convention (per OpenAI's docs,
  // Codex scans `.agents/skills` from the cwd up to the repo root), so they share one output
  // dir — deduped here (first target wins) to avoid emitting the same path twice. Their
  // `harness.*` built-ins are identical, so the shared render is unambiguous. That premise is
  // load-bearing (a divergent built-in would make this file's content depend on which *other*
  // targets are enabled) and pinned by a test — see HARNESS_BUILTINS' `agentsDir` note.
  const skillDirs = new Map(); // dir -> target identity
  const addDir = (dir, target) => { if (!skillDirs.has(dir)) skillDirs.set(dir, target); };
  if (project.targets.includes('claude')) addDir(path.join('.claude', 'skills', skill.name), 'claude');
  const crossToolDir = path.join('.agents', 'skills', skill.name);
  if (project.targets.includes('agents-dir')) addDir(crossToolDir, 'agents-dir');
  if (project.targets.includes('codex')) addDir(crossToolDir, 'codex');
  if (!skillDirs.size) return;

  const itemContext = `${stack.name}/skills/${skill.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'skills', `${skill.name}.md`);
  for (const rel of skill.files) {
    const abs = path.join(skill.dir, rel);
    if (rel.endsWith('.md')) {
      const context = `${itemContext}/${rel}`;
      const raw = fs.readFileSync(abs, 'utf8');
      // Substitute per target: `.claude/skills` uses the claude identity, `.agents/skills`
      // the agents-dir/codex (Codex) identity — they diverge only where `harness.*` is used.
      for (const [dir, target] of skillDirs) {
        let content = substitute(raw, resolvers[target], stack.declared, errors, context, guards);
        if (rel === 'SKILL.md') content = appendExtension(content, cwd, extPath);
        emit(path.join(dir, rel), content, itemContext);
      }
    } else {
      const content = fs.readFileSync(abs);
      for (const dir of skillDirs.keys()) emit(path.join(dir, rel), content, itemContext);
    }
  }
}

/**
 * Emit a generic `files/` payload to its repo-relative path — independent of `targets:`,
 * since a file has no per-harness variant and renders once. Text is template-substituted
 * (declared keys + `harness.*` resolved against the primary target); binaries are copied
 * byte-for-byte. The rel path doubles as the cross-stack conflict key, so two enabled
 * stacks emitting the same path fail loudly, exactly like same-named skills.
 */
function renderFiles({ file, stack, resolve, emit, errors, guards }) {
  const context = `${stack.name}/files/${file.name}`;
  if (file.binary) {
    emit(file.name, fs.readFileSync(file.path), context);
    return;
  }
  const raw = fs.readFileSync(file.path, 'utf8');
  emit(file.name, substitute(raw, resolve, stack.declared, errors, context, guards), context);
}

function appendExtension(body, cwd, relPath) {
  const extensionFile = path.join(cwd, relPath);
  if (!exists(extensionFile)) return body;
  const ext = fs.readFileSync(extensionFile, 'utf8').trim();
  if (!ext) return body;
  return `${body.trimEnd()}\n\n<!-- BEGIN project extension: ${relPath} -->\n\n${ext}\n\n<!-- END project extension -->\n`;
}

/**
 * Stacks can require env vars (e.g. agent-teams experiments). We never edit the
 * project's shared config files — we verify and tell the user exactly what to add.
 */
function checkEnvPrerequisites({ stack, project, cwd, warnings }) {
  for (const [key, value] of Object.entries(stack.env)) {
    if (project.targets.includes('claude')) {
      const settingsFile = path.join(cwd, '.claude', 'settings.json');
      let ok = false;
      if (exists(settingsFile)) {
        try {
          ok = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.env?.[key] === value;
        } catch { /* unparseable -> warn below */ }
      }
      if (!ok) {
        warnings.push(`stack "${stack.name}" needs env ${key}=${value} in .claude/settings.json ("env" section)`);
      }
    }
    if (project.targets.includes('codex')) {
      const configFile = path.join(cwd, '.codex', 'config.toml');
      const text = exists(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
      if (!new RegExp(`^\\s*${key}\\s*=\\s*"${value}"`, 'm').test(text)) {
        warnings.push(`stack "${stack.name}" needs ${key} = "${value}" under [shell_environment_policy.set] in .codex/config.toml`);
      }
    }
  }
}

/**
 * The committed lock — the CANONICAL render (#317): what `.waffle/waffle.yaml` +
 * `.waffle/extensions/` produce on any machine, with the private `.local` overlay excluded. This
 * is the project's shared contract, and the only lock `--verify-render` ever checks against.
 */
export function readLock(cwd) {
  const { file } = resolveLockFile(cwd);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The gitignored local lock — the EFFECTIVE render this machine last wrote, overlay values
 * included. `null` on the overwhelmingly common machine, where the overlay is absent or changes no
 * output byte and `render` therefore writes no such file.
 */
export function readLocalLock(cwd) {
  const file = localLockPath(cwd);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The lock that describes the files ON DISK — the local lock when the overlay shaped this tree,
 * else the committed one. Every check that hashes the working tree must read through here
 * (`doctor`'s drift check, `list`'s per-item status, `render`'s prune and clobber guards):
 * comparing a tree the overlay shaped against the *canonical* hashes would report every file the
 * overlay touched as hand-edited, which is a permanently red `doctor` for the one developer whose
 * private tooling the canonical lock exists to protect.
 *
 * Note what does NOT read through here: `--verify-render`, which asks the orthogonal question —
 * does the COMMITTED config still reproduce the COMMITTED lock — and must therefore stay on the
 * canonical pair, on every machine.
 */
export function readTreeLock(cwd) {
  return readLocalLock(cwd) ?? readLock(cwd);
}

/** Human-readable identity of an external source from its lock provenance: `source@ref`, or just
 * `source` for a local path (no ref). Used in the trust-boundary warnings for external syrup. */
function describeProvenance(prov) {
  return prov?.ref ? `${prov.source}@${prov.ref}` : prov?.source;
}

/**
 * Build the lock's per-source provenance: one `{ name, source, sourceType, ref, commit, files }`
 * entry per external source that rendered at least one file, `files` being the source's rendered
 * paths. `groups` is the per-stack render grouping (only external stacks carry `provenance`);
 * `producedBy` maps each output path to its "<stackName>/…" context, whose leading segment names
 * the owning stack (stack names are unique across all sources, so the segment identifies it
 * unambiguously). Built-in and waffledocs outputs have no external source and are simply absent.
 * Sources and their file lists are sorted for a deterministic lock.
 */
function collectSourceProvenance(groups, producedBy, lockFiles) {
  const provenanceByStack = new Map();
  for (const { stack } of groups.values()) {
    if (stack.provenance) provenanceByStack.set(stack.name, stack.provenance);
  }
  if (!provenanceByStack.size) return [];

  const filesBySource = new Map();
  for (const rel of Object.keys(lockFiles)) {
    const stackName = producedBy.get(rel)?.split('/')[0];
    if (stackName && provenanceByStack.has(stackName)) {
      if (!filesBySource.has(stackName)) filesBySource.set(stackName, []);
      filesBySource.get(stackName).push(rel);
    }
  }

  return [...provenanceByStack.values()]
    .map((prov) => ({ ...prov, files: (filesBySource.get(prov.name) ?? []).sort((a, b) => a.localeCompare(b)) }))
    .filter((source) => source.files.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compile every `pattern:` declared anywhere in the toolkit into a Map<key, guard[]> for
 * render-time value validation — each guard a makeGuard record carrying the RegExp, the raw
 * authored pattern, and its declaring source, so a rejection can name the guard that fired
 * (#244 F1). A pattern that fails to compile is a toolkit-authoring bug (validate reports it
 * precisely) — here we fail the render loudly rather than silently skip the check, so a
 * broken guard can never ship unenforced.
 *
 * The map spans **every** stack, not just the selected ones (#155 review). A guard is a
 * property of the config KEY, not of which stack happens to be installed. `git.cmd` is
 * declared by both `github-workflow` and `orchestration`, but only the former declares the
 * `git.botName` / `git.botEmail` it composes — so a per-stack map left an orchestration-only
 * install splicing an unvalidated `botEmail: "$(id)@x.com"` straight into an agent-executed
 * shell command, while the identical value was rejected once `github-workflow` was co-installed.
 * That is the same "accident of what else happens to be present" failure mode `expandNested`'s
 * doc comment (template.mjs) says the nested-enforcement path exists to prevent. W5b/W5c pin
 * that independence. The flip side — a stack the project never installs can veto its value —
 * is why the guard records carry provenance: the error names the failing pattern and its
 * declaring stack, so the veto is legible even when the declarer is outside the selection.
 *
 * A key declared with a pattern in more than one stack must satisfy ALL of them — the strictest
 * reading, and the only one that cannot be weakened by installing another stack. No shipped
 * scalar key is dual-declared today, so the AND is pinned by a two-stack fixture test
 * ("pattern guards from two stacks AND together", #244 F2) rather than by shipped data; its
 * `entryPatterns` twin IS live on shipped data (`git.agentIdentities` declares byte-identical
 * entryPatterns in both `github-workflow` and `orchestration`), and #254 adds a dual-declared
 * `git.cmd` pattern relying on exactly this union.
 *
 * The same collection runs for `entryPatterns:` (#156), the map-valued sibling of `pattern:`:
 * `Map<key, Map<leaf, guard[]>>`, unioned toolkit-wide on the same reasoning. Returns the pair
 * as a `guards` object, which is what `substitute()` takes.
 */
function compileGuards(toolkit, errors) {
  const patterns = new Map();
  const entryPatterns = new Map();
  const add = (key, guard) => {
    const existing = patterns.get(key);
    if (existing) existing.push(guard);
    else patterns.set(key, [guard]);
  };
  const addEntry = (key, leaf, guard) => {
    let leaves = entryPatterns.get(key);
    if (!leaves) entryPatterns.set(key, (leaves = new Map()));
    const existing = leaves.get(leaf);
    if (existing) existing.push(guard);
    else leaves.set(leaf, [guard]);
  };
  // Reserved `harness.*` injection guards (#131) — always enforced, never declared in a
  // stack's config. Seed them first; a stack's own `config:` patterns cannot collide because
  // `harness.*` is never a declarable config key.
  for (const [sub, pattern] of Object.entries(HARNESS_PATTERNS)) {
    try {
      add(`harness.${sub}`, makeGuard(pattern, 'the reserved harness guards'));
    } catch (err) {
      errors.push(`reserved harness.${sub} has an invalid pattern: ${err.message}`);
    }
  }
  for (const [stackName, stack] of toolkit.stacks) {
    for (const [key, spec] of Object.entries(stack.config ?? {})) {
      const source = `stack "${stackName}"`;
      if (typeof spec?.pattern === 'string') {
        try {
          add(key, makeGuard(spec.pattern, source));
        } catch (err) {
          errors.push(`stack "${stackName}" config key ${key} has an invalid pattern: ${err.message}`);
        }
      }
      for (const [leaf, pattern] of Object.entries(spec?.entryPatterns ?? {})) {
        if (typeof pattern !== 'string') {
          errors.push(`stack "${stackName}" config key ${key} entryPattern ${leaf} is not a string`);
          continue;
        }
        try {
          addEntry(key, leaf, makeGuard(pattern, source));
        } catch (err) {
          errors.push(`stack "${stackName}" config key ${key} has an invalid entryPattern for ${leaf}: ${err.message}`);
        }
      }
    }
  }
  return { patterns, entryPatterns };
}

/** Placeholder keys referenced by a set of selected items' source content. */
export function collectUsedKeys(items) {
  const keys = new Set();
  for (const { kind, item } of items) {
    if (kind === 'agents') {
      for (const k of placeholderKeys(item.body)) keys.add(k);
      for (const k of placeholderKeys(item.data.description ?? '')) keys.add(k);
    } else if (kind === 'skills') {
      for (const rel of item.files) {
        if (!rel.endsWith('.md')) continue;
        for (const k of placeholderKeys(fs.readFileSync(path.join(item.dir, rel), 'utf8'))) keys.add(k);
      }
    } else if (!item.binary) {
      for (const k of placeholderKeys(fs.readFileSync(item.path, 'utf8'))) keys.add(k);
    }
  }
  return keys;
}
