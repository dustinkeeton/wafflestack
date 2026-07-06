import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  exists,
  writeFileEnsuringDir,
  stringifyFrontmatter,
} from './util.mjs';
import { substitute, placeholderKeys, compilePattern } from './template.mjs';
import { loadToolkit, missingRequiredKeys } from './toolkit.mjs';
import { computeSelection, skippedSyrupCompanions } from './refs.mjs';
import { generateWaffleDocs } from './waffledocs.mjs';
import {
  loadProjectConfig,
  makeResolver,
  migrateLegacyDotfiles,
  staleGitignoreEntries,
  resolveLockFile,
  CONFIG_FILE,
  LOCK_FILE,
  EXTENSIONS_DIR,
} from './project.mjs';

/**
 * Render every enabled stack into the project at `cwd`.
 * Frozen-image contract: outputs are regenerated verbatim; managed files from the
 * previous lock that are no longer rendered get deleted; a fresh lock is written.
 */
export function renderProject({ toolkitRoot, cwd, toolkitVersion, force = false, log = () => {} }) {
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
  const project = loadProjectConfig(cwd, warnings);
  const toolkit = loadToolkit(toolkitRoot);
  const errors = [];
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

  // Read the previous lock up front: its tracked file paths let the selection keep
  // rendering an opt-in syrup item the repo already has (so existing installs keep getting
  // updates) while gating opt-in syrup out of a fresh stack expansion.
  const oldLock = readLock(cwd);
  const trackedFiles = new Set(Object.keys(oldLock?.files ?? {}));

  // Selection = union(items of enabled stacks) ∪ closure(include items) − eject.
  const selection = computeSelection(toolkit, project, trackedFiles);
  errors.push(...selection.errors);

  // Reverse the syrup companion edge (#74): an opt-in syrup file pairs with a companion waffle
  // via `requires:` (installing the syrup pulls the companion), but the render only walks that
  // forward — so selecting the companion, or enabling its whole stack, leaves the paired syrup
  // gated out and silent. Surface each skipped pairing with the exact pour command. This is the
  // deliberately non-interactive CLI's stand-in for the both/one/neither question the setup
  // playbook (schema/SETUP.md step 2) now requires an agent to ask.
  for (const { fileRef, stackName, companions } of skippedSyrupCompanions(toolkit, selection)) {
    warnings.push(
      `opt-in syrup ${fileRef} (${stackName}) pairs with selected ${companions.join(', ')} but was not ` +
        `installed — run \`wafflestack install ${fileRef}\` to pour it, or leave it out on purpose`,
    );
  }

  // Group by owning stack so config/env checks run per stack, but only over the
  // items actually selected (an included item does not drag in its stack's siblings).
  const groups = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName).items.push({ kind, item });
  }

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

    // Compile any `pattern:` guards this stack declares once, then enforce them at every
    // substitution site below (render-time value validation for config values).
    const patterns = compilePatterns(stack, errors);

    for (const { kind, item } of items) {
      if (kind === 'agents') renderAgent({ agent: item, stack, resolvers, project, cwd, emit, errors, patterns });
      else if (kind === 'skills') renderSkill({ skill: item, stack, resolvers, project, cwd, emit, errors, patterns });
      else renderFiles({ file: item, stack, resolve: primaryResolver, emit, errors, patterns });
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

  // The same placeholder is substituted once per target, so a missing value yields
  // one error per target — collapse to a distinct set.
  if (errors.length) return { ok: false, errors: [...new Set(errors)], warnings };

  // Frozen image: reconcile against the previous lock (read up front) before touching the tree.
  const managed = oldLock?.files ?? {};

  // Refuse to clobber a pre-existing UNMANAGED file: a path this render would produce that
  // already exists on disk but was not tracked by the previous lock — i.e. the consumer's
  // own hand-written file, not a prior render of ours. A byte-identical file is adopted
  // silently (the write is a no-op and the new lock records it either way); only a genuine
  // content difference is a collision. `--force` overwrites. Checked before any write or
  // prune, so a refusal leaves the whole tree untouched — same fail-loud spirit as the
  // cross-stack `emit()` conflict above.
  if (!force) {
    const collisions = [];
    for (const [rel, content] of outputs) {
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
    if (!outputs.has(rel) && exists(path.join(cwd, rel))) {
      fs.rmSync(path.join(cwd, rel));
      removed.push(rel);
    }
  }

  const lockFiles = {};
  for (const [rel, content] of [...outputs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    writeFileEnsuringDir(path.join(cwd, rel), content);
    lockFiles[rel] = sha256(content);
  }

  const lock = {
    toolkitVersion,
    targets: project.targets,
    stacks: project.stacks,
    include: project.include,
    files: lockFiles,
  };
  writeFileEnsuringDir(path.join(cwd, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);

  log(`rendered ${outputs.size} files${removed.length ? `, removed ${removed.length} stale` : ''}`);
  return { ok: true, errors: [], warnings, written: [...outputs.keys()], removed };
}

function renderAgent({ agent, stack, resolvers, project, cwd, emit, errors, patterns }) {
  const context = `${stack.name}/agents/${agent.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'agents', `${agent.name}.md`);
  // Body and description are substituted per target so `harness.*` resolves to that
  // target's identity (description is the one frontmatter field carrying prose).
  const bodyFor = (target) =>
    appendExtension(substitute(agent.body, resolvers[target], stack.declared, errors, context, patterns), cwd, extPath);
  const descriptionFor = (target) =>
    substitute(agent.data.description ?? '', resolvers[target], stack.declared, errors, context, patterns);

  if (project.targets.includes('claude')) {
    const fm = { name: agent.data.name ?? agent.name, description: descriptionFor('claude') };
    if (agent.data.skills) fm.skills = agent.data.skills;
    Object.assign(fm, agent.data.claude ?? {});
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

function renderSkill({ skill, stack, resolvers, project, cwd, emit, errors, patterns }) {
  const targetDirs = [];
  if (project.targets.includes('claude')) targetDirs.push({ target: 'claude', dir: path.join('.claude', 'skills', skill.name) });
  if (project.targets.includes('agents-dir')) targetDirs.push({ target: 'agents-dir', dir: path.join('.agents', 'skills', skill.name) });
  if (!targetDirs.length) return;

  const itemContext = `${stack.name}/skills/${skill.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'skills', `${skill.name}.md`);
  for (const rel of skill.files) {
    const abs = path.join(skill.dir, rel);
    if (rel.endsWith('.md')) {
      const context = `${itemContext}/${rel}`;
      const raw = fs.readFileSync(abs, 'utf8');
      // Substitute per target: `.claude/skills` uses the claude identity, `.agents/skills`
      // the agents-dir (Codex) identity — they diverge only where `harness.*` is used.
      for (const { target, dir } of targetDirs) {
        let content = substitute(raw, resolvers[target], stack.declared, errors, context, patterns);
        if (rel === 'SKILL.md') content = appendExtension(content, cwd, extPath);
        emit(path.join(dir, rel), content, itemContext);
      }
    } else {
      const content = fs.readFileSync(abs);
      for (const { dir } of targetDirs) emit(path.join(dir, rel), content, itemContext);
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
function renderFiles({ file, stack, resolve, emit, errors, patterns }) {
  const context = `${stack.name}/files/${file.name}`;
  if (file.binary) {
    emit(file.name, fs.readFileSync(file.path), context);
    return;
  }
  const raw = fs.readFileSync(file.path, 'utf8');
  emit(file.name, substitute(raw, resolve, stack.declared, errors, context, patterns), context);
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

export function readLock(cwd) {
  const { file } = resolveLockFile(cwd);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Compile every `pattern:` a stack's config declares into a Map<key, RegExp> for
 * render-time value validation. A pattern that fails to compile is a toolkit-authoring
 * bug (validate reports it precisely) — here we fail the render loudly rather than
 * silently skip the check, so a broken guard can never ship unenforced.
 */
function compilePatterns(stack, errors) {
  const map = new Map();
  for (const [key, spec] of Object.entries(stack.config)) {
    if (typeof spec?.pattern !== 'string') continue;
    try {
      map.set(key, compilePattern(spec.pattern));
    } catch (err) {
      errors.push(`stack "${stack.name}" config key ${key} has an invalid pattern: ${err.message}`);
    }
  }
  return map;
}

/** Placeholder keys referenced by a set of selected items' source content. */
function collectUsedKeys(items) {
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
