import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  exists,
  writeFileEnsuringDir,
  stringifyFrontmatter,
} from './util.mjs';
import { substitute, placeholderKeys, makeGuard } from './template.mjs';
import { toolkitLockEntry } from './toolkit-ref.mjs';
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
 * Render every enabled stack into the project at `cwd`. Frozen-image contract: outputs regenerated
 * verbatim, managed files no longer rendered are pruned, a fresh lock is written.
 *
 * Renders TWICE — effective (committed config + local overlay) to disk, canonical (committed inputs
 * alone) into the committed lock — so the private overlay never leaks into shared state (#317).
 * `sourceBaseDir` exists only for `doctor --verify-render` (#314). `toolkitIdentity` (#373/#374) is
 * echoed into the lock's `toolkit` block; null ⇒ block omitted, pre-#374 lock shape.
 */
export function renderProject({
  toolkitRoot,
  cwd,
  sourceBaseDir = cwd,
  toolkitVersion,
  toolkitIdentity = null,
  force = false,
  log = () => {},
  sourceCacheDir = defaultSourceCacheDir(),
  refreshSources = false,
}) {
  const warnings = [];
  // Carry a legacy repo forward before reading: migrate consumer dot-paths into `.waffle/` (#43);
  // a no-op on an already-migrated or fresh repo.
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

  // External stack sources (#88): resolve each `{ name, source, ref }` entry to a toolkit root and
  // merge its named stack; failures surface as render errors, not throws. See loadToolkitWithSources.
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

  // Install-time trust boundary (#126): lint every EXTERNAL stack's definitions before any write,
  // failing loudly with the source named. Scoped to external stacks; a return leaves the tree untouched.
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

  // Read both locks up front (#317): `lock` is the committed canonical lock, `localLock` the
  // gitignored effective one (absent unless the overlay moved a byte). Every question about the
  // tree on disk uses `treeLock`, never `lock` — see `readTreeLock`.
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

  // Generalized prerequisite warnings (#129): unmet locally-probeable (`tool`/`env`) prerequisites
  // warn but never fail the render (that is `doctor`'s job); network/auth kinds are left to doctor.
  // Deliberately OUTSIDE `computeOutputs` — it shells out, so it runs once against the effective selection.
  {
    const prereqs = applicablePrerequisites(toolkit, { items: effective.selection.items });
    const { unmetRequired, unmetRecommended } = evaluatePrerequisites(prereqs, cwd, {
      kinds: RENDER_PROBE_KINDS,
      timeoutMs: 5000,
    });
    for (const p of [...unmetRequired, ...unmetRecommended]) warnings.push(formatPrereq(p));
  }

  // A missing value yields one error per target — collapse to a distinct set. The effective render
  // is checked first so a failure returns here, keeping the canonical failure below unambiguous.
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

  // A canonical error surviving a clean effective render has one cause: the overlay supplied
  // something the committed config cannot (a defaultless `required:` key). Must be LOUD, not a silent
  // half-lock (#317, constraint 2); the fix is to commit SOME value while the overlay overrides locally.
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

  // Refuse to clobber a pre-existing UNMANAGED file — a produced path that exists on disk but was
  // untracked by the previous lock (#25). Byte-identical is adopted silently; `--force` overwrites.
  // Checked before any write or prune, so a refusal leaves the tree untouched.
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

  // Per-source provenance (#125): attribute every rendered EXTERNAL file to its source. Only
  // external stacks carry `provenance`; the `sources` block is omitted when empty, so a
  // built-in-only lock is byte-identical to the pre-#125 shape. See collectSourceProvenance.
  const sources = collectSourceProvenance(canonical.groups, canonical.producedBy, canonicalFiles);

  // Built-in toolkit provenance (#374): `toolkitVersion` alone does NOT identify content, so the
  // `toolkit` block records it. `toolkitLockEntry` owns the "`commit` iff release" rule and the
  // `unverified` carry-forward; each lock carries forward from its OWN predecessor (#317).
  const toolkitBlock = toolkitLockEntry(toolkitIdentity, { prevLock: lock, newFiles: canonicalFiles, toolkitVersion });

  // The committed lock: canonical throughout — its `targets`/`stacks`/`include` come from the
  // committed config, not the merged one, for the same reason its hashes do. `stacks:` records
  // the enabled built-in stack names; `sources` (when present) records each external source's
  // resolved provenance and the files it produced. External files also live in `files` so doctor
  // drift-checks them like any managed file.
  writeLockFile(path.join(cwd, LOCK_FILE), {
    toolkitVersion,
    ...(toolkitBlock ? { toolkit: toolkitBlock } : {}),
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
    const localToolkitBlock = toolkitLockEntry(toolkitIdentity, {
      prevLock: localLock,
      newFiles: effectiveFiles,
      toolkitVersion,
    });
    writeLockFile(localLockFile, {
      toolkitVersion,
      ...(localToolkitBlock ? { toolkit: localToolkitBlock } : {}),
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
  // `identity` rides back on the result so a caller that didn't resolve it can read the ref (null
  // when unthreaded). `toolkit` is the block as WRITTEN, which `upgrade` diffs against the old block.
  return {
    ok: true,
    errors: [],
    warnings,
    written: [...effective.outputs.keys()],
    removed,
    sources,
    toolkit: toolkitBlock,
    identity: toolkitIdentity,
  };
}

/**
 * Compute every file a `project` config would render — the pure core of `renderProject`, run once
 * per config (effective and canonical). Writes nothing; `errors`/`warnings` are caller-owned sinks.
 * Returns `outputs` (path → content), `producedBy`, `groups`, and `selection`.
 */
function computeOutputs({ toolkit, project, cwd, trackedFiles, errors, warnings }) {
  const outputs = new Map(); // relative path -> content (string | Buffer)
  const producedBy = new Map(); // relative path -> "stack/kind/name" that emitted it
  // Two enabled stacks defining a same-named item would silently last-write-wins; fail loudly instead.
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

  // Selection = union(items of enabled stacks) ∪ closure(include items) − eject; external entries
  // fold into the enabled set here. `trackedFiles` keeps updating opt-in syrup the repo already has.
  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);
  errors.push(...selection.errors);

  // Reverse the syrup companion edge (#74): the render walks `requires:` forward only, so selecting a
  // companion leaves its paired opt-in syrup gated out and silent — surface each skipped pairing.
  for (const { fileRef, stackName, companions, scopedTo } of skippedSyrupCompanions(toolkit, selection)) {
    // External opt-in syrup is doubly gated (#126): a paired external syrup file was authored
    // outside this repo, so its extra trust-boundary acknowledgement rides along with the
    // both/one/neither pairing note — distinct from a built-in companion, which needs only the
    // ordinary opt-in.
    const prov = toolkit.stacks.get(stackName)?.provenance;
    const external = prov
      ? ` — this is EXTERNAL syrup from source "${stackName}" (${describeProvenance(prov)}), so pouring it ` +
        `additionally requires an explicit trust-boundary acknowledgement beyond the normal opt-in`
      : '';
    // #364: the pairing is real, but the scope makes it UNCOMPLETABLE here — so state it without a
    // pour command (`install` would render nothing, and persisting the `include:` would re-warn on
    // every future render). Suppressing the notification instead would hand the consumer the manual
    // half of the flow, deny them the automated half, and say nothing: #74, exactly.
    if (scopedTo) {
      warnings.push(
        `opt-in syrup ${fileRef} (${stackName}) pairs with selected ${companions.join(', ')}, but is scoped to ` +
          `targets [${scopedTo.join(', ')}] and this project enables [${project.targets.join(', ')}] — it CANNOT ` +
          `be poured here, so that flow stays incomplete. Enable one of its targets in ${CONFIG_FILE} to complete ` +
          `the pairing, or leave it out on purpose${external}`,
      );
      continue;
    }
    warnings.push(
      `opt-in syrup ${fileRef} (${stackName}) pairs with selected ${companions.join(', ')} but was not ` +
        `installed — run \`wafflestack install ${fileRef}\` to pour it, or leave it out on purpose${external}`,
    );
  }

  // #364: an explicitly `include:`d syrup file scoped to targets this project has not enabled
  // renders nothing. Say so — a silent no-op on an explicit include is the same "half-installed and
  // silent" failure the pairing warning above exists to prevent. A stack-expansion skip stays
  // silent, exactly like the `optIn:` gate: only an explicit ask earns an explicit answer.
  for (const { ref, targets } of selection.targetSkipped) {
    warnings.push(
      `${ref} is scoped to targets [${targets.join(', ')}] and this project enables ` +
        `[${project.targets.join(', ')}] — it is not rendered. Enable one of its targets in ` +
        `${CONFIG_FILE}, or drop it from \`include:\`.`,
    );
  }

  // #364: a SELECTED waffle whose `requires:` edge lands on a scoped-out file renders WITHOUT that
  // dependency — the "half-installed and silent" failure #74 prevents, via the one entry path with
  // neither warning nor lint. For opt-in syrup, enabling a target clears the scope-broken condition
  // while the dependency still doesn't exist, so the remedy states both steps (enable AND install).
  // `targetSkipped`/`targetBrokenRequires` are always set, so both read bare (no `?? []`).
  for (const { ref, requiredBy, targets, optIn } of selection.targetBrokenRequires) {
    const remedy = optIn
      ? `${ref} is also OPT-IN syrup, so enabling a target is necessary but NOT sufficient: enable one of ` +
        `its targets in ${CONFIG_FILE} AND install it (\`wafflestack install ${ref}\`) — doing only the ` +
        `first renders nothing and silences this warning`
      : `Enable one of its targets in ${CONFIG_FILE}`;
    warnings.push(
      `selected ${requiredBy} requires ${ref}, which is scoped to targets [${targets.join(', ')}] and this ` +
        `project enables [${project.targets.join(', ')}] — the dependency is NOT rendered, so the flow is ` +
        `incomplete. ${remedy}, or expect ${requiredBy} to run without it.`,
    );
  }

  // Trust-boundary acknowledgement for EXTERNAL opt-in syrup being poured (#126): authored outside this
  // repo, so surface a required acknowledgement the flow must put to the user, distinct from built-in opt-in.
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
    // A file renders ONCE with the primary target's identity; a `targets:`-scoped file (#364) is the
    // one exception on WHICH identity — see `resolverFor`. `targets:` decides whether, not how many.
    const primaryResolver = resolvers[primaryTarget] ?? makeResolver(stack, project.values, primaryTarget);
    // #364: a scoped file substitutes with the primary-most target it DECLARES, not the project's
    // primary target (which may be a harness it isn't for); an unscoped file keeps primaryResolver.
    // computeSelection guarantees a selected scoped file at least one declared target, so `find` hits.
    const resolverFor = (f) =>
      (f.targets ? resolvers[project.targets.find((t) => f.targets.includes(t))] : primaryResolver) ?? primaryResolver;
    // Scope required-config to keys the *selected* items actually reference — installing
    // one skill from a stack must not demand config only its siblings use.
    const usedKeys = collectUsedKeys(items);
    const missing = missingRequiredKeys(stack, project.values, (values, key) => primaryResolver(key), usedKeys);
    if (missing.length) {
      // Names the committed config, and ONLY it: a `required:` key with no resolvable value is the one
      // class that may not live only in the overlay (#317); advising it would contradict the guard above.
      errors.push(
        `stack "${stackName}" needs config values: ${missing.map((k) => `config.${k}`).join(', ')} — add them to ${CONFIG_FILE}`,
      );
      continue;
    }

    for (const { kind, item } of items) {
      if (kind === 'agents') renderAgent({ agent: item, stack, resolvers, project, cwd, emit, errors, guards });
      else if (kind === 'skills') renderSkill({ skill: item, stack, resolvers, project, cwd, emit, errors, guards });
      else renderFiles({ file: item, stack, resolve: resolverFor(item), emit, errors, guards });
    }
    // Env prerequisites still warn when any item from this stack renders.
    checkEnvPrerequisites({ stack, project, cwd, warnings });
  }

  // Generate the `.waffle/` overview docs through the same `emit()` choke point, so they are
  // lock-tracked, drift-checked, and pruned like any output. Only when the item loop was clean.
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
  // Body and description substituted per target so `harness.*` resolves to that target's identity.
  const bodyFor = (target) =>
    appendExtension(substitute(agent.body, resolvers[target], stack.declared, errors, context, guards), cwd, extPath);
  const descriptionFor = (target) =>
    substitute(agent.data.description ?? '', resolvers[target], stack.declared, errors, context, guards);

  if (project.targets.includes('claude')) {
    const fm = { name: agent.data.name ?? agent.name, description: descriptionFor('claude') };
    if (agent.data.skills) fm.skills = agent.data.skills;
    // `identity:` (#156) — the agent's virtualized git author, read at spawn time off the rendered
    // file. Harnesses that don't know it ignore it; codex's TOML has no shape for it and drops it.
    if (agent.data.identity) fm.identity = agent.data.identity;
    // The `claude:` passthrough may not shadow a reserved key (#156); `validateStack` rejects it,
    // and stripping here is defense in depth so a validated `identity` can't be overwritten.
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
    // Cross-tool `.agents/` convention: harness-neutral Markdown mirroring the Claude agent shape
    // but dropping the Claude-only `claude:` passthrough. Skills land in the sibling `.agents/skills/`.
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
  // Map each output dir → the target identity to substitute it with. Codex and agents-dir share the
  // cross-tool `.agents/skills` dir, deduped here (first target wins); their `harness.*` built-ins
  // are identical so the shared render is unambiguous (#156 — see HARNESS_BUILTINS' `agentsDir` note).
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
      // Substitute per target — they diverge only where `harness.*` is used.
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
 * Emit a generic `files/` payload to its repo-relative path. Renders ONCE, never per-target; an
 * optional `targets:` decides WHETHER it renders (#364), settled by `computeSelection` beforehand.
 * Text is template-substituted (caller's `resolve`); binaries are copied byte-for-byte. The rel path
 * doubles as the cross-stack conflict key.
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
 * The lock that describes the files ON DISK (#317) — the local lock when the overlay shaped this
 * tree, else the committed one. Every check that hashes the working tree reads through here
 * (`doctor` drift, `list` status, `render`'s prune/clobber guards). NOT `--verify-render`, which
 * asks whether the COMMITTED config reproduces the COMMITTED lock and stays on the canonical pair.
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
 * Build the lock's per-source provenance: one entry per external source that rendered ≥1 file.
 * Only external stacks carry `provenance`; built-in and waffledocs outputs are absent. Sorted for
 * a deterministic lock.
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
 * Compile every `pattern:` declared anywhere in the toolkit into a Map<key, guard[]> for render-time
 * value validation, each guard carrying its RegExp/source so a rejection names it (#244 F1). A guard
 * that won't compile fails the render loudly. The map spans EVERY stack, not just selected ones (#155):
 * a guard is a property of the config KEY, so a per-stack map let an unvalidated value through when its
 * declaring stack was absent — the "accident of what else is present" failure `expandNested` prevents.
 * A key guarded in multiple stacks must satisfy ALL (#244 F2). `entryPatterns:` (#156) collects the same
 * way; returns the pair as a `guards` object for `substitute()`.
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
          // `patternHint:` (#218) — optional prose remedy carried on the guard, printed after the
          // pattern when it fires. See describeHints (template.mjs): the message IS the upgrade path.
          add(key, makeGuard(spec.pattern, source, typeof spec.patternHint === 'string' ? spec.patternHint : ''));
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

/**
 * The config-value guard failures a render WOULD produce, evaluated WITHOUT rendering (#218) — so
 * bare `doctor` (which only hashes the tree, and whose `--verify-render` is opt-in, #314) can enforce
 * a `pattern:` guard in the shipped form. FAITHFULNESS IS THE POINT: it runs the real `substitute()`
 * against `{{key}}` rather than re-implementing the check, reporting one problem per KEY. An undefined
 * value is skipped (that's `missingRequiredKeys`' business); only a RESOLVED value is guarded.
 */
export function configGuardProblems({ toolkit, project, selection }) {
  const problems = [];
  // A guard that fails to compile is a toolkit-authoring bug; surface it here, matching render.
  const guards = compileGuards(toolkit, problems);

  const groups = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName).items.push({ kind, item });
  }

  const reported = new Set();
  for (const [stackName, { stack, items }] of groups) {
    // The primary target, exactly as render's `primaryResolver` does (no guarded key resolves per-target).
    const target = project.targets?.[0] ?? 'claude';
    const resolve = makeResolver(stack, project.values, target);
    for (const key of collectUsedKeys(items)) {
      if (reported.has(key)) continue;
      if (!guards.patterns.has(key) && !guards.entryPatterns.has(key)) continue;
      if (resolve(key) === undefined) continue; // see above — not this check's business
      const before = problems.length;
      substitute(`{{${key}}}`, resolve, stack.declared, problems, `stack "${stackName}"`, guards);
      if (problems.length > before) reported.add(key);
    }
  }
  return problems;
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
