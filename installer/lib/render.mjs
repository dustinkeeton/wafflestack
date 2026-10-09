import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  exists,
  resolveInside,
  writeFileEnsuringDir,
  stringifyFrontmatter,
} from './util.mjs';
import { substitute, placeholderKeys, makeGuard, isModeScalar } from './template.mjs';
import { toolkitLockEntry, lockRepoSlug, classifyToolkitRefValue } from './toolkit-ref.mjs';
import { marketplacePluginId } from './marketplace.mjs';
import { modSettingsEntries, settingsConflicts, applySettings, settingsLockMap, lockKeys } from './settings.mjs';
import { loadToolkitWithSources, missingRequiredKeys } from './toolkit.mjs';
import { defaultSourceCacheDir } from './sources.mjs';
import { computeSelection, skippedSyrupCompanions, unpouredRequiredSyrup, disabledStackRequires, closureFor } from './refs.mjs';
import { validateExternalStacks, RESERVED_AGENT_KEYS } from './validate.mjs';
import {
  applicablePrerequisites,
  describeProvenance,
  evaluatePrerequisites,
  externalCheckGates,
  formatCheckGate,
  formatPrereq,
  RENDER_PROBE_KINDS,
  unacknowledgedStacks,
} from './prerequisites.mjs';
import { generateWaffleDocs } from './waffledocs.mjs';
import { applyModelInvocation, overrideFor } from './model-invocation.mjs';
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
  for (const { from, to } of migrateLegacyDotfiles(cwd)) log(`renamed legacy ${from} → ${to}`);
  const stale = staleGitignoreEntries(cwd);
  if (stale.length) {
    warnings.push(
      `.gitignore still lists ${stale.join(', ')} — update to the .waffle/ paths (the CLI does not edit .gitignore)`,
    );
  }

  // `canonicalProject === project` — the same object, by identity — is the "no overlay" fast path
  // every branch below tests against.
  const project = loadProjectConfig(cwd, warnings);
  const canonicalProject = exists(resolveLocalConfigFile(cwd).file)
    ? loadProjectConfig(cwd, [], { canonical: true })
    : project;

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
    // The canonical render resolves its stacks from the COMMITTED config too, or an overlay that
    // redeclares `stacks:` leaks back into the lock through the toolkit registry.
    canonicalToolkit = sameExternalStacks(project, canonicalProject) ? toolkit : loadToolkitFor(canonicalProject);
  } catch (err) {
    return { ok: false, warnings, errors: [err.message] };
  }

  // Install-time trust boundary (#126): lint every EXTERNAL stack before any write, so a return
  // leaves the tree untouched.
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

  // Every question about the tree on disk uses `treeLock`, never `lock` (#317) — see `readTreeLock`.
  const lock = readLock(cwd);
  const localLock = readLocalLock(cwd);
  const treeLock = localLock ?? lock;

  const errors = [];
  const marketplace = { name: toolkit.name, repo: toolkitRepo(toolkitRoot) };
  const effective = computeOutputs({
    toolkit,
    project,
    cwd,
    errors,
    warnings,
    toolkitVersion,
    trackedFiles: new Set(lockKeys(treeLock)),
    marketplace,
  });

  // Deliberately OUTSIDE `computeOutputs`: this shells out, so it runs once. Warns, never fails.
  // An external stack's checks stay unrun until its command list is acknowledged (#458).
  {
    const gates = externalCheckGates(toolkit, project);
    for (const gate of gates) if (!gate.acknowledged) warnings.push(formatCheckGate(gate));
    const prereqs = applicablePrerequisites(toolkit, { items: effective.selection.items });
    const { unmetRequired, unmetRecommended } = evaluatePrerequisites(prereqs, cwd, {
      kinds: RENDER_PROBE_KINDS,
      timeoutMs: 5000,
      skipStacks: unacknowledgedStacks(gates),
    });
    for (const p of [...unmetRequired, ...unmetRecommended]) warnings.push(formatPrereq(p));
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)], warnings };

  // The bytes the lock will record: nothing here is written to disk, and its warnings are dropped.
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
          toolkitVersion,
          trackedFiles: new Set(lockKeys(lock)),
          marketplace,
        });

  // A canonical error surviving a clean effective render means the overlay supplied something the
  // committed config cannot — LOUD, never a silent half-lock (#317).
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

  const managed = treeLock?.files ?? {};
  const managedSettings = treeLock?.settings ?? {};

  // Checked before any write or prune (#25), so a refusal leaves the tree untouched.
  const settingsCheck = settingsConflicts(cwd, effective.settings, managedSettings);
  if (settingsCheck.errors.length) return { ok: false, errors: settingsCheck.errors, warnings };
  if (!force) {
    const collisions = [...settingsCheck.collisions];
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
        .map((rel) =>
          effective.settings.has(rel)
            ? `refusing to overwrite settings entry ${rel}: it already holds a different value not tracked by ${LOCK_FILE} — remove it and re-render, or pass \`--force\` to overwrite it`
            : `refusing to overwrite ${rel}: a pre-existing file not tracked by ${LOCK_FILE} — back it up or remove it and re-render, or pass \`--force\` to overwrite it`,
        );
      return { ok: false, errors: errs, warnings, collisions };
    }
  }

  const removed = [];
  for (const rel of Object.keys(managed)) {
    if (effective.outputs.has(rel)) continue;
    const abs = resolveInside(cwd, rel); // a lock key must never reach outside the repo (#459)
    if (!abs) {
      warnings.push(`refusing to prune lock entry "${rel}": it resolves outside the project root — remove it from the lock by hand`);
      continue;
    }
    if (!exists(abs)) continue;
    fs.rmSync(abs);
    removed.push(rel);
    pruneEmptyDirs(cwd, path.dirname(abs));
  }

  for (const [rel, content] of sortedOutputs(effective.outputs)) {
    writeFileEnsuringDir(path.join(cwd, rel), content);
  }
  removed.push(...applySettings(cwd, effective.settings, managedSettings));

  const canonicalFiles = hashOutputs(canonical.outputs);
  const effectiveFiles = canonical === effective ? canonicalFiles : hashOutputs(effective.outputs);
  const canonicalSettings = settingsLockMap(canonical.settings);
  const effectiveSettings = settingsLockMap(effective.settings);
  const settingsBlock = (map) => (Object.keys(map).length ? { settings: map } : {});

  const sources = collectSourceProvenance(canonical.groups, canonical.producedBy, canonicalFiles);

  // Each lock carries its toolkit block forward from its OWN predecessor (#317/#374).
  const toolkitBlock = toolkitLockEntry(toolkitIdentity, { prevLock: lock, newFiles: canonicalFiles, toolkitVersion });

  writeLockFile(path.join(cwd, LOCK_FILE), {
    toolkitVersion,
    ...(toolkitBlock ? { toolkit: toolkitBlock } : {}),
    targets: canonicalProject.targets,
    stacks: canonicalProject.stacks,
    include: canonicalProject.include,
    ...(sources.length ? { sources } : {}),
    files: canonicalFiles,
    ...settingsBlock(canonicalSettings),
  });

  // Written only when the overlay actually moved a byte, and removed again the moment that stops
  // being true — a stale local lock would describe a tree that no longer exists.
  const localLockFile = localLockPath(cwd);
  const overlayChangedTheRender =
    JSON.stringify(effectiveFiles) !== JSON.stringify(canonicalFiles) ||
    JSON.stringify(effectiveSettings) !== JSON.stringify(canonicalSettings);
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
      ...settingsBlock(effectiveSettings),
    });
    // Commit an un-ignored local lock and every teammate's `doctor` reads YOUR machine's hashes.
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
 */
function computeOutputs({ toolkit, project, cwd, trackedFiles, errors, warnings, toolkitVersion, marketplace }) {
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

  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);
  errors.push(...selection.errors);

  // The pour the warnings below suggest crosses a trust boundary when the syrup is external.
  const externalNote = (stackName) => {
    const prov = toolkit.stacks.get(stackName)?.provenance;
    return prov
      ? ` — this is EXTERNAL syrup from source "${stackName}" (${describeProvenance(prov)}), so pouring it ` +
          `additionally requires an explicit trust-boundary acknowledgement beyond the normal opt-in`
      : '';
  };

  // The render walks `requires:` forward only, so reverse the edge to catch a gated pairing (#74).
  for (const { fileRef, stackName, companions, scopedTo } of skippedSyrupCompanions(toolkit, selection)) {
    const external = externalNote(stackName);
    // The pairing is real but UNCOMPLETABLE here (#364), so it is stated without a pour command.
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

  // The same edge walked FORWARD (#371): a selected item's `requires:` onto opt-in syrup nobody
  // poured renders without it — a stack-expanded dependent never enters a closure.
  for (const { ref, requiredBy, stackName } of unpouredRequiredSyrup(toolkit, selection)) {
    warnings.push(
      `selected ${requiredBy} requires opt-in syrup ${ref} (${stackName}), which was not installed — the ` +
        `dependency is NOT rendered, so the flow is incomplete. Run \`wafflestack install ${ref}\` to pour ` +
        `it, or expect ${requiredBy} to run without it${externalNote(stackName)}`,
    );
  }

  // A cross-stack `requires:` edge onto a stack this project does not enable (#520): expansion
  // never pulls another stack's items in, so it warns instead — never silently enables.
  // Leads with the item route: it is a subset of the stack route, so never needs more config (#549).
  for (const { ref, requiredBy, stackName, installRef } of disabledStackRequires(toolkit, selection)) {
    const needs = (keys) => (keys.length ? `needs ${summarizeConfigKeys(keys)}` : 'needs no config values');
    const whole = toolkit.stacks.get(stackName);
    const [kind, ...rest] = ref.split('/');
    const name = rest.join('/');
    const item = whole?.[kind]?.find((i) => i.name === name);
    const itemNodes = item ? closureFor(toolkit, { stack: stackName, kind, name, item }) : [];
    const itemNeeds = needs(missingConfigFor(toolkit, project, itemNodes));
    const stackNodes = whole ? itemsOfStack(whole) : [];
    const stackNeeds = needs(missingConfigFor(toolkit, project, stackNodes));
    warnings.push(
      `selected ${requiredBy} requires ${ref}, which is provided by stack "${stackName}" — that stack is not ` +
        `enabled here, so the dependency is NOT rendered and the flow is incomplete. Cheapest fix: run ` +
        `\`wafflestack install ${installRef}\` to pull just that item (with its own dependencies) — it ` +
        `${itemNeeds}. Or add "${stackName}" to \`stacks:\` in ${CONFIG_FILE}, which renders the whole stack and ` +
        `${stackNeeds}. Or expect ${requiredBy} to run without it.`,
    );
  }

  // Only an explicit ask earns an answer: a stack-expansion scope skip stays silent (#364).
  for (const { ref, targets } of selection.targetSkipped) {
    warnings.push(
      `${ref} is scoped to targets [${targets.join(', ')}] and this project enables ` +
        `[${project.targets.join(', ')}] — it is not rendered. Enable one of its targets in ` +
        `${CONFIG_FILE}, or drop it from \`include:\`.`,
    );
  }

  // A tombstone forwarded the ref, so the render is correct but the consumer's pin is stale (#335).
  for (const { from, to, via } of selection.forwarded ?? []) {
    const chain = via.length > 1 ? ` (via ${via.slice(1).join(' → ')})` : '';
    warnings.push(
      `\`include:\` still names ${from}, which was renamed to ${to}${chain} — it was forwarded, so this render ` +
        `is complete, but the pin is stale. Run \`wafflestack upgrade\` to rewrite it, or edit ${CONFIG_FILE} by hand.`,
    );
  }

  // A selected waffle whose `requires:` edge lands on a scoped-out file renders WITHOUT that
  // dependency (#364); for opt-in syrup, enabling a target is necessary but not sufficient.
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

  const groups = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName).items.push({ kind, item });
  }

  // Toolkit-wide, not per-stack — see compileGuards.
  const guards = compileGuards(toolkit, errors);

  for (const [stackName, { stack, items }] of groups) {
    const { resolvers, primaryResolver } = targetResolvers(stack, project, toolkitVersion);
    // Scoped to the *selected* items' keys, so one skill never demands its siblings' config.
    const usedKeys = collectUsedKeys(items);
    const missing = missingRequiredKeys(stack, project.values, (values, key) => primaryResolver(key), usedKeys);
    if (missing.length) {
      // Names the committed config, and ONLY it: a `required:` key may not live in the overlay (#317).
      errors.push(
        `stack "${stackName}" needs config values: ${missing.map((k) => `config.${k}`).join(', ')} — add them to ${CONFIG_FILE}`,
      );
      continue;
    }

    for (const { kind, item } of items) renderItem({ kind, item, stack, resolvers, primaryResolver, project, cwd, emit, errors, guards });
    checkEnvPrerequisites({ stack, project, cwd, warnings });
  }

  warnings.push(...modelInvocationWarnings(project, selection));
  const settings = modSettings({ selection, project, marketplace, errors, warnings, toolkitVersion, guards });

  if (!errors.length) {
    for (const { rel, content } of generateWaffleDocs({ toolkit, project, selection, errors, toolkitVersion })) {
      emit(rel, content, 'waffledocs');
    }
  }

  return { outputs, producedBy, groups, selection, settings };
}

/**
 * Selected mods → project-scope settings entries (#594). Only built-in mods are in the toolkit's
 * marketplace, so an external stack's mod is skipped with a warning.
 */
function modSettings({ selection, project, marketplace, errors, warnings, toolkitVersion, guards }) {
  const mods = [];
  let modStack = null;
  const shippedBy = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (kind !== 'mods' || !project.targets.includes('claude')) continue;
    if (stack.provenance) {
      warnings.push(`mods/${item.name} comes from external stack "${stackName}", which has no marketplace here — not enabled`);
      continue;
    }
    if (shippedBy.has(item.name)) {
      errors.push(`output conflict: mods/${item.name} is shipped by both ${shippedBy.get(item.name)} and ${stackName} — enable only one, or eject one of them`);
      continue;
    }
    shippedBy.set(item.name, stackName);
    modStack ??= stack;
    mods.push(item);
  }
  if (mods.length && !marketplace?.repo) {
    errors.push(
      `cannot enable ${mods.map((m) => `mods/${m.name}`).join(', ')}: no GitHub repository is known for the ` +
        `"${marketplace?.name}" marketplace — set \`repository\` in the toolkit's package.json`,
    );
    return new Map();
  }
  const pluginIds = mods.map((m) => marketplacePluginId(m.name, marketplace.name));
  const ref = mods.length ? modMarketplaceRef({ stack: modStack, project, toolkitVersion, guards, marketplace, warnings }) : null;
  return modSettingsEntries({ pluginIds, marketplace: marketplace.name, repo: marketplace.repo, ref });
}

/** The key whose pin the marketplace source follows (#595), so a mod and the CLI are one version. */
export const MOD_REF_KEY = 'waffle.toolkitRef';

/**
 * The git ref the marketplace source pins: the `#fragment` of `waffle.toolkitRef` as the shipping
 * stack resolves it (its default pins `v<toolkitVersion>`). Unpinned or non-GitHub → null, no `ref`.
 */
function modMarketplaceRef({ stack, project, toolkitVersion, guards, marketplace, warnings }) {
  const resolve = makeResolver(stack, project.values, 'claude', { toolkitVersion });
  const value = substitute(`{{${MOD_REF_KEY}}}`, resolve, new Set([MOD_REF_KEY]), [], MOD_REF_KEY, guards);
  const found = classifyToolkitRefValue(value);
  if (!('fragment' in found)) return null;
  const pinRepo = `${found.slug.owner}/${found.slug.repo}`;
  if (pinRepo.toLowerCase() !== marketplace.repo.toLowerCase()) {
    warnings.push(`${MOD_REF_KEY} pins ${pinRepo}, but mods install from the ${marketplace.repo} marketplace — its ref ${found.fragment} must exist there`);
  }
  return found.fragment;
}

/** `owner/repo` the toolkit's marketplace lives at — a content-bearing source, so the lock stays deterministic. */
function toolkitRepo(toolkitRoot) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(toolkitRoot, 'package.json'), 'utf8'));
  } catch { /* no package.json: only npm's lockfile can answer */ }
  const slug = lockRepoSlug({ toolkitRoot, pkg });
  return slug ? `${slug.owner}/${slug.repo}` : null;
}

/** Remove `dir` and each parent it leaves empty, stopping below `cwd`. */
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

/** One resolver per enabled target — the reserved `harness.*` keys resolve per target. */
function targetResolvers(stack, project, toolkitVersion) {
  const primaryTarget = project.targets[0] ?? 'claude';
  /** @type {Record<string, (key: string) => any>} */
  const resolvers = {};
  const runtime = { toolkitVersion };
  for (const target of project.targets) resolvers[target] = makeResolver(stack, project.values, target, runtime);
  const primaryResolver = resolvers[primaryTarget] ?? makeResolver(stack, project.values, primaryTarget, runtime);
  return { resolvers, primaryResolver };
}

function renderItem({ kind, item, stack, resolvers, primaryResolver, project, cwd, emit, errors, guards }) {
  if (kind === 'agents') renderAgent({ agent: item, stack, resolvers, project, cwd, emit, errors, guards });
  else if (kind === 'skills') renderSkill({ skill: item, stack, resolvers, project, cwd, emit, errors, guards });
  else if (kind === 'mods') return; // a settings entry, not a file — see modSettings
  else {
    // A scoped file substitutes with the primary-most target it DECLARES (#364).
    const declared = item.targets ? resolvers[project.targets.find((t) => item.targets.includes(t))] : null;
    renderFiles({ file: item, stack, resolve: declared ?? primaryResolver, emit, errors, guards });
  }
}

/**
 * One item's outputs exactly as `render` would write them, in memory (#577): `Map<rel, content>`,
 * or `null` when the render would error (missing config, failing guard). Writes nothing.
 *
 * @param {{ toolkit: import('./toolkit.mjs').Toolkit, project: import('./project.mjs').ProjectConfig,
 *   cwd: string, node: { stack: string, kind: string, item: any }, toolkitVersion?: string }} args
 * @returns {Map<string, string | Buffer> | null}
 */
export function renderItemInMemory({ toolkit, project, cwd, node, toolkitVersion }) {
  const stack = toolkit.stacks.get(node.stack);
  if (!stack) return null;
  /** @type {string[]} */
  const errors = [];
  const guards = compileGuards(toolkit, errors);
  const { resolvers, primaryResolver } = targetResolvers(stack, project, toolkitVersion);
  const used = collectUsedKeys([node]);
  if (missingRequiredKeys(stack, project.values, (_v, key) => primaryResolver(key), used).length) return null;
  const outputs = new Map();
  const emit = (rel, content) => outputs.set(rel, content);
  try {
    renderItem({ kind: node.kind, item: node.item, stack, resolvers, primaryResolver, project, cwd, emit, errors, guards });
  } catch {
    return null;
  }
  return errors.length ? null : outputs;
}

/**
 * A `skills.modelInvocation` entry that cannot take effect is a warning, never an error (#476):
 * the key stays put while a stack is toggled off, and the non-`claude` targets have no such key.
 *
 * @param {import('./project.mjs').ProjectConfig} project
 * @param {{ items: { kind: string, item: { name: string } }[] }} selection
 * @returns {string[]}
 */
function modelInvocationWarnings(project, selection) {
  const { disabled = [], enabled = [] } = project.modelInvocation ?? {};
  const named = [...disabled, ...enabled];
  if (!named.length) return [];
  if (!project.targets.includes('claude')) {
    return [
      `skills.modelInvocation names ${named.join(', ')} but no \`claude\` target is enabled — the override is a no-op (codex/agents-dir have no disable-model-invocation key)`,
    ];
  }
  const rendered = new Set(selection.items.filter((s) => s.kind === 'skills').map((s) => s.item.name));
  const unmatched = named.filter((n) => !rendered.has(n));
  return unmatched.length
    ? [`skills.modelInvocation names ${unmatched.join(', ')}, which no selected stack renders — left in ${CONFIG_FILE}, ignored this render`]
    : [];
}

/** Outputs in a stable order — the lock's bytes must not depend on the order stacks rendered in. */
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
 * Do two configs declare the same external stack sources? Structural compare — `normalizeStackEntries`
 * emits entries in config order with a fixed key order.
 */
function sameExternalStacks(a, b) {
  return JSON.stringify(a.externalStacks ?? []) === JSON.stringify(b.externalStacks ?? []);
}

function renderAgent({ agent, stack, resolvers, project, cwd, emit, errors, guards }) {
  const context = `${stack.name}/agents/${agent.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'agents', `${agent.name}.md`);
  const bodyFor = (target) =>
    appendExtension(substitute(agent.body, resolvers[target], stack.declared, errors, context, guards), cwd, extPath);
  const descriptionFor = (target) =>
    substitute(agent.data.description ?? '', resolvers[target], stack.declared, errors, context, guards);

  if (project.targets.includes('claude')) {
    const fm = { name: agent.data.name ?? agent.name, description: descriptionFor('claude') };
    if (agent.data.skills) fm.skills = agent.data.skills;
    if (agent.data.identity) fm.identity = agent.data.identity;
    // Stripping reserved keys here is defense in depth — `validateStack` already rejects a
    // `claude:` passthrough that shadows one (#156).
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
  // Codex and agents-dir share the cross-tool `.agents/skills` dir, deduped here (first target
  // wins); their `harness.*` built-ins are identical, so the shared render is unambiguous (#156).
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
      for (const [dir, target] of skillDirs) {
        let content = substitute(raw, resolvers[target], stack.declared, errors, context, guards);
        // The override is a Claude Code frontmatter key; the cross-tool dir renders the source verbatim (#476).
        if (rel === 'SKILL.md' && target === 'claude') {
          content = applyModelInvocation(content, overrideFor(project.modelInvocation, skill.name));
        }
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

/** Stacks can require env vars; we never edit the project's shared config, only verify and warn. */
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
 * The committed lock — the CANONICAL render (#317), overlay excluded, and the only lock
 * `--verify-render` ever checks against.
 */
export function readLock(cwd) {
  const { file } = resolveLockFile(cwd);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The gitignored local lock — the EFFECTIVE render this machine last wrote, overlay included.
 * `null` when the overlay is absent or changes no output byte.
 */
export function readLocalLock(cwd) {
  const file = localLockPath(cwd);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The lock that describes the files ON DISK (#317). Every check that hashes the working tree reads
 * through here — but NOT `--verify-render`, which stays on the canonical pair.
 */
export function readTreeLock(cwd) {
  return readLocalLock(cwd) ?? readLock(cwd);
}

/**
 * Build the lock's per-source provenance: one entry per external source that rendered ≥1 file,
 * sorted for a deterministic lock.
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
 * value validation. The map spans EVERY stack, not just selected ones (#155): a guard is a property
 * of the config KEY, so a per-stack map lets a value through whenever its declaring stack is absent.
 */
function compileGuards(toolkit, errors) {
  const patterns = new Map();
  const entryPatterns = new Map();
  const modes = new Map();
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
  // Reserved `harness.*` injection guards (#131) — always enforced, never declared in a stack.
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
      // Behavioral keys (#478): a closed `modes:` list and/or a `lockMode:` travel with the key too.
      const modeList = Array.isArray(spec?.modes) && spec.modes.every(isModeScalar) ? spec.modes : null;
      const lockMode = isModeScalar(spec?.lockMode) ? spec.lockMode : undefined;
      if (modeList || lockMode !== undefined) {
        const guard = { modes: modeList, lockMode, source };
        const existing = modes.get(key);
        if (existing) existing.push(guard);
        else modes.set(key, [guard]);
      }
    }
  }
  return { patterns, entryPatterns, modes };
}

/**
 * The config-value guard failures a render WOULD produce, evaluated WITHOUT rendering (#218). It
 * runs the real `substitute()` against `{{key}}` rather than re-implementing the check; an
 * undefined value is skipped, only a RESOLVED value is guarded.
 */
export function configGuardProblems({ toolkit, project, selection }) {
  const problems = [];
  // A guard that fails to compile is a toolkit-authoring bug; surface it here, matching render.
  const guards = compileGuards(toolkit, problems);
  const nodes = selection.items.map(({ stackName, stack, kind, item }) => ({ stack: stackName, stackDef: stack, kind, item }));
  for (const f of guardFailures(toolkit, project, nodes, guards)) problems.push(...f.problems);
  return problems;
}

/**
 * Each used, resolved, guarded key whose value fails a guard, once per key: `{ key, stackName, stack,
 * resolve, problems }`. Runs the real `substitute()` on `{{key}}` with the primary-target resolver.
 */
function* guardFailures(toolkit, project, nodes, guards) {
  const groups = new Map();
  for (const n of nodes) {
    const stack = n.stackDef ?? toolkit.stacks.get(n.stack);
    if (!stack) continue;
    if (!groups.has(n.stack)) groups.set(n.stack, { stack, items: [] });
    groups.get(n.stack).items.push({ kind: n.kind, item: n.item });
  }
  const reported = new Set();
  const target = project.targets?.[0] ?? 'claude';
  for (const [stackName, { stack, items }] of groups) {
    const resolve = makeResolver(stack, project.values, target);
    for (const key of collectUsedKeys(items)) {
      if (reported.has(key)) continue;
      if (!guards.patterns.has(key) && !guards.entryPatterns.has(key) && !guards.modes.has(key)) continue;
      if (resolve(key) === undefined) continue; // a missing key is missingConfigFor's to report
      const problems = [];
      substitute(`{{${key}}}`, resolve, stack.declared, problems, `stack "${stackName}"`, guards);
      if (!problems.length) continue;
      reported.add(key);
      yield { key, stackName, stack, resolve, problems };
    }
  }
}

/**
 * Keys a set of items would use whose resolved value fails a guard render enforces (#578), split by
 * guard: `modes` when only the `modes:`/`lockMode:` check fails, else `pattern`. `config.`-prefixed, sorted.
 *
 * @param {import('./toolkit.mjs').Toolkit} toolkit
 * @param {import('./project.mjs').ProjectConfig} project
 * @param {{ stack: string, kind: string, item: any }[]} nodes
 * @returns {{ pattern: string[], modes: string[] }}
 */
export function failingConfigFor(toolkit, project, nodes) {
  const guards = compileGuards(toolkit, []);
  const unmoded = { ...guards, modes: new Map() };
  const pattern = new Set();
  const modes = new Set();
  for (const { key, stackName, stack, resolve } of guardFailures(toolkit, project, nodes, guards)) {
    const rest = [];
    substitute(`{{${key}}}`, resolve, stack.declared, rest, `stack "${stackName}"`, unmoded);
    (rest.length ? pattern : modes).add(`config.${key}`);
  }
  return { pattern: [...pattern].sort(), modes: [...modes].sort() };
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
    } else if (kind === 'files' && !item.binary) {
      for (const k of placeholderKeys(fs.readFileSync(item.path, 'utf8'))) keys.add(k);
    }
  }
  return keys;
}

/**
 * Required config keys a set of items would demand but `project` leaves unresolved (#549) — the
 * same check `render` refuses on, asked before an install. `nodes` are `{ stack, kind, item }`.
 *
 * @param {import('./toolkit.mjs').Toolkit} toolkit
 * @param {import('./project.mjs').ProjectConfig} project
 * @param {{ stack: string, kind: string, item: any }[]} nodes
 * @returns {string[]} `config.`-prefixed keys, sorted
 */
export function missingConfigFor(toolkit, project, nodes) {
  const byStack = new Map();
  for (const n of nodes) {
    if (!byStack.has(n.stack)) byStack.set(n.stack, []);
    byStack.get(n.stack).push(n);
  }
  const missing = new Set();
  for (const [stackName, items] of byStack) {
    const stack = toolkit.stacks.get(stackName);
    if (!stack) continue;
    const resolve = makeResolver(stack, project.values, project.targets[0] ?? 'claude');
    for (const k of missingRequiredKeys(stack, project.values, (_v, key) => resolve(key), collectUsedKeys(items))) {
      missing.add(`config.${k}`);
    }
  }
  return [...missing].sort();
}

/** Shorten `config.arch.a, config.arch.b` to `config.arch.*` — one entry per first segment. */
export function summarizeConfigKeys(keys) {
  const groups = new Map();
  for (const k of keys) {
    const head = k.split('.').slice(0, 2).join('.');
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(k);
  }
  return [...groups].map(([head, ks]) => (ks.length > 1 ? `${head}.*` : ks[0])).join(', ');
}

/** Every item of a stack as `{ stack, kind, item }` nodes — what enabling it would render. */
function itemsOfStack(stack) {
  return ['agents', 'skills', 'files', 'mods'].flatMap((kind) =>
    (stack[kind] ?? [])
      .filter((item) => kind === 'agents' || kind === 'skills' || !stack.optIn.has(`${kind}/${item.name}`))
      .map((item) => ({ stack: stack.name, kind, item })),
  );
}
