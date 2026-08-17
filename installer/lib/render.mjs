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
  const effective = computeOutputs({
    toolkit,
    project,
    cwd,
    errors,
    warnings,
    trackedFiles: new Set(Object.keys(treeLock?.files ?? {})),
  });

  // Deliberately OUTSIDE `computeOutputs`: this shells out, so it runs once. Warns, never fails.
  {
    const prereqs = applicablePrerequisites(toolkit, { items: effective.selection.items });
    const { unmetRequired, unmetRecommended } = evaluatePrerequisites(prereqs, cwd, {
      kinds: RENDER_PROBE_KINDS,
      timeoutMs: 5000,
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
          trackedFiles: new Set(Object.keys(lock?.files ?? {})),
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

  // Checked before any write or prune (#25), so a refusal leaves the tree untouched.
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

  const removed = [];
  for (const rel of Object.keys(managed)) {
    if (!effective.outputs.has(rel) && exists(path.join(cwd, rel))) {
      fs.rmSync(path.join(cwd, rel));
      removed.push(rel);
    }
  }

  for (const [rel, content] of sortedOutputs(effective.outputs)) {
    writeFileEnsuringDir(path.join(cwd, rel), content);
  }

  const canonicalFiles = hashOutputs(canonical.outputs);
  const effectiveFiles = canonical === effective ? canonicalFiles : hashOutputs(effective.outputs);

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
  });

  // Written only when the overlay actually moved a byte, and removed again the moment that stops
  // being true — a stale local lock would describe a tree that no longer exists.
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

  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);
  errors.push(...selection.errors);

  // The render walks `requires:` forward only, so reverse the edge to catch a gated pairing (#74).
  for (const { fileRef, stackName, companions, scopedTo } of skippedSyrupCompanions(toolkit, selection)) {
    const prov = toolkit.stacks.get(stackName)?.provenance;
    const external = prov
      ? ` — this is EXTERNAL syrup from source "${stackName}" (${describeProvenance(prov)}), so pouring it ` +
        `additionally requires an explicit trust-boundary acknowledgement beyond the normal opt-in`
      : '';
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
    // One resolver per enabled target — the reserved `harness.*` keys resolve per target.
    const primaryTarget = project.targets[0] ?? 'claude';
    const resolvers = {};
    for (const target of project.targets) resolvers[target] = makeResolver(stack, project.values, target);
    const primaryResolver = resolvers[primaryTarget] ?? makeResolver(stack, project.values, primaryTarget);
    // A scoped file substitutes with the primary-most target it DECLARES (#364).
    const resolverFor = (f) =>
      (f.targets ? resolvers[project.targets.find((t) => f.targets.includes(t))] : primaryResolver) ?? primaryResolver;
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

    for (const { kind, item } of items) {
      if (kind === 'agents') renderAgent({ agent: item, stack, resolvers, project, cwd, emit, errors, guards });
      else if (kind === 'skills') renderSkill({ skill: item, stack, resolvers, project, cwd, emit, errors, guards });
      else renderFiles({ file: item, stack, resolve: resolverFor(item), emit, errors, guards });
    }
    checkEnvPrerequisites({ stack, project, cwd, warnings });
  }

  if (!errors.length) {
    for (const { rel, content } of generateWaffleDocs({ toolkit, project, selection, errors })) {
      emit(rel, content, 'waffledocs');
    }
  }

  return { outputs, producedBy, groups, selection };
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

/** Human-readable identity of an external source: `source@ref`, or `source` for a local path. */
function describeProvenance(prov) {
  return prov?.ref ? `${prov.source}@${prov.ref}` : prov?.source;
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
    }
  }
  return { patterns, entryPatterns };
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

  const groups = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName).items.push({ kind, item });
  }

  const reported = new Set();
  for (const [stackName, { stack, items }] of groups) {
    // The primary target, exactly as render's `primaryResolver` does.
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
