import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  exists,
  writeFileEnsuringDir,
  stringifyFrontmatter,
} from './util.mjs';
import { substitute, placeholderKeys } from './template.mjs';
import { loadToolkit, missingRequiredKeys } from './toolkit.mjs';
import { computeSelection } from './refs.mjs';
import {
  loadProjectConfig,
  makeResolver,
  LOCK_FILE,
  EXTENSIONS_DIR,
} from './project.mjs';

/**
 * Render every enabled bundle into the project at `cwd`.
 * Frozen-image contract: outputs are regenerated verbatim; managed files from the
 * previous lock that are no longer rendered get deleted; a fresh lock is written.
 */
export function renderProject({ toolkitRoot, cwd, toolkitVersion, log = () => {} }) {
  const project = loadProjectConfig(cwd);
  const toolkit = loadToolkit(toolkitRoot);
  const errors = [];
  const warnings = [];
  const outputs = new Map(); // relative path -> content (string | Buffer)
  const producedBy = new Map(); // relative path -> "bundle/kind/name" that emitted it
  // Two enabled bundles may define same-named items (alternative implementations of
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

  // Selection = union(items of enabled bundles) ∪ closure(include items) − eject.
  const selection = computeSelection(toolkit, project);
  errors.push(...selection.errors);

  // Group by owning bundle so config/env checks run per bundle, but only over the
  // items actually selected (an included item does not drag in its bundle's siblings).
  const groups = new Map();
  for (const { bundleName, bundle, kind, item } of selection.items) {
    if (!groups.has(bundleName)) groups.set(bundleName, { bundle, items: [] });
    groups.get(bundleName).items.push({ kind, item });
  }

  for (const [bundleName, { bundle, items }] of groups) {
    // One resolver per enabled target — the reserved `harness.*` keys resolve
    // differently per output target (Claude vs. Codex attribution, etc.).
    const primaryTarget = project.targets[0] ?? 'claude';
    const resolvers = {};
    for (const target of project.targets) resolvers[target] = makeResolver(bundle, project.values, target);
    // Files render once (harness-independent) and the missing-required-key probe needs a
    // single resolver — both use the primary target's identity for any `harness.*` refs.
    const primaryResolver = resolvers[primaryTarget] ?? makeResolver(bundle, project.values, primaryTarget);
    // Scope required-config to keys the *selected* items actually reference — installing
    // one skill from a bundle must not demand config only its siblings use.
    const usedKeys = collectUsedKeys(items);
    const missing = missingRequiredKeys(bundle, project.values, (values, key) => primaryResolver(key), usedKeys);
    if (missing.length) {
      errors.push(
        `bundle "${bundleName}" needs config values: ${missing.map((k) => `config.${k}`).join(', ')} — add them to .wafflestack.yaml (or the .local overlay)`,
      );
      continue;
    }

    for (const { kind, item } of items) {
      if (kind === 'agents') renderAgent({ agent: item, bundle, resolvers, project, cwd, emit, errors });
      else if (kind === 'skills') renderSkill({ skill: item, bundle, resolvers, project, cwd, emit, errors });
      else renderFiles({ file: item, bundle, resolve: primaryResolver, emit, errors });
    }
    // Env prerequisites still warn when any item from this bundle renders.
    checkEnvPrerequisites({ bundle, project, cwd, warnings });
  }

  // The same placeholder is substituted once per target, so a missing value yields
  // one error per target — collapse to a distinct set.
  if (errors.length) return { ok: false, errors: [...new Set(errors)], warnings };

  // Frozen image: remove previously managed files that this render no longer produces.
  const oldLock = readLock(cwd);
  const removed = [];
  for (const rel of Object.keys(oldLock?.files ?? {})) {
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
    bundles: project.bundles,
    include: project.include,
    files: lockFiles,
  };
  writeFileEnsuringDir(path.join(cwd, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);

  log(`rendered ${outputs.size} files${removed.length ? `, removed ${removed.length} stale` : ''}`);
  return { ok: true, errors: [], warnings, written: [...outputs.keys()], removed };
}

function renderAgent({ agent, bundle, resolvers, project, cwd, emit, errors }) {
  const context = `${bundle.name}/agents/${agent.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'agents', `${agent.name}.md`);
  // Body and description are substituted per target so `harness.*` resolves to that
  // target's identity (description is the one frontmatter field carrying prose).
  const bodyFor = (target) =>
    appendExtension(substitute(agent.body, resolvers[target], bundle.declared, errors, context), cwd, extPath);
  const descriptionFor = (target) =>
    substitute(agent.data.description ?? '', resolvers[target], bundle.declared, errors, context);

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

function renderSkill({ skill, bundle, resolvers, project, cwd, emit, errors }) {
  const targetDirs = [];
  if (project.targets.includes('claude')) targetDirs.push({ target: 'claude', dir: path.join('.claude', 'skills', skill.name) });
  if (project.targets.includes('agents-dir')) targetDirs.push({ target: 'agents-dir', dir: path.join('.agents', 'skills', skill.name) });
  if (!targetDirs.length) return;

  const itemContext = `${bundle.name}/skills/${skill.name}`;
  const extPath = path.join(EXTENSIONS_DIR, 'skills', `${skill.name}.md`);
  for (const rel of skill.files) {
    const abs = path.join(skill.dir, rel);
    if (rel.endsWith('.md')) {
      const context = `${itemContext}/${rel}`;
      const raw = fs.readFileSync(abs, 'utf8');
      // Substitute per target: `.claude/skills` uses the claude identity, `.agents/skills`
      // the agents-dir (Codex) identity — they diverge only where `harness.*` is used.
      for (const { target, dir } of targetDirs) {
        let content = substitute(raw, resolvers[target], bundle.declared, errors, context);
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
 * byte-for-byte. The rel path doubles as the cross-bundle conflict key, so two enabled
 * bundles emitting the same path fail loudly, exactly like same-named skills.
 */
function renderFiles({ file, bundle, resolve, emit, errors }) {
  const context = `${bundle.name}/files/${file.name}`;
  if (file.binary) {
    emit(file.name, fs.readFileSync(file.path), context);
    return;
  }
  const raw = fs.readFileSync(file.path, 'utf8');
  emit(file.name, substitute(raw, resolve, bundle.declared, errors, context), context);
}

function appendExtension(body, cwd, relPath) {
  const extensionFile = path.join(cwd, relPath);
  if (!exists(extensionFile)) return body;
  const ext = fs.readFileSync(extensionFile, 'utf8').trim();
  if (!ext) return body;
  return `${body.trimEnd()}\n\n<!-- BEGIN project extension: ${relPath} -->\n\n${ext}\n\n<!-- END project extension -->\n`;
}

/**
 * Bundles can require env vars (e.g. agent-teams experiments). We never edit the
 * project's shared config files — we verify and tell the user exactly what to add.
 */
function checkEnvPrerequisites({ bundle, project, cwd, warnings }) {
  for (const [key, value] of Object.entries(bundle.env)) {
    if (project.targets.includes('claude')) {
      const settingsFile = path.join(cwd, '.claude', 'settings.json');
      let ok = false;
      if (exists(settingsFile)) {
        try {
          ok = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.env?.[key] === value;
        } catch { /* unparseable -> warn below */ }
      }
      if (!ok) {
        warnings.push(`bundle "${bundle.name}" needs env ${key}=${value} in .claude/settings.json ("env" section)`);
      }
    }
    if (project.targets.includes('codex')) {
      const configFile = path.join(cwd, '.codex', 'config.toml');
      const text = exists(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
      if (!new RegExp(`^\\s*${key}\\s*=\\s*"${value}"`, 'm').test(text)) {
        warnings.push(`bundle "${bundle.name}" needs ${key} = "${value}" under [shell_environment_policy.set] in .codex/config.toml`);
      }
    }
  }
}

export function readLock(cwd) {
  const file = path.join(cwd, LOCK_FILE);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
