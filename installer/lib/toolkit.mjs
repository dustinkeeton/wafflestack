import fs from 'node:fs';
import path from 'node:path';
import { readYaml, parseFrontmatter, exists, isBinary } from './util.mjs';
import { normalizeItemRef } from './refs.mjs';

/** Load the toolkit registry and every stack it lists. */
export function loadToolkit(rootDir) {
  const registry = readYaml(path.join(rootDir, 'toolkit.yaml'));
  const stacks = new Map();
  for (const name of registry.stacks ?? []) {
    const dir = path.join(rootDir, 'stacks', name);
    if (!exists(path.join(dir, 'stack.yaml'))) continue; // not yet authored
    stacks.set(name, loadStack(name, dir));
  }
  return { name: registry.name, description: registry.description, stacks };
}

function loadStack(name, dir) {
  const manifest = readYaml(path.join(dir, 'stack.yaml'));
  const config = manifest.config ?? {};
  const declared = new Set(Object.keys(config));

  const agents = (manifest.agents ?? []).map((agentName) => {
    const file = path.join(dir, 'agents', `${agentName}.md`);
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return { kind: 'agent', name: agentName, file, data, body };
  });

  const skills = (manifest.skills ?? []).map((skillName) => {
    const skillDir = path.join(dir, 'skills', skillName);
    const files = fs
      .readdirSync(skillDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(skillDir, path.join(e.parentPath ?? e.path, e.name)))
      .sort();
    if (!files.includes('SKILL.md')) {
      throw new Error(`stack ${name}: skill ${skillName} has no SKILL.md`);
    }
    return { kind: 'skill', name: skillName, dir: skillDir, files };
  });

  // Generic payloads: a file authored under `files/<repo-relative-path>` renders verbatim
  // to that same path in the consuming project (CI workflows, scripts, config). Text files
  // are template-substituted, binaries byte-copied — text/binary is sniffed by content, so
  // any text type works, not just `.md`.
  const files = (manifest.files ?? []).map((entry) => {
    const rel = String(entry);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === '..')) {
      throw new Error(`stack ${name}: files entry "${rel}" must be a repo-relative path that stays inside the project`);
    }
    const file = path.join(dir, 'files', rel);
    if (!exists(file)) throw new Error(`stack ${name}: files entry "${rel}" not found under files/`);
    return { kind: 'files', name: rel, path: file, binary: isBinary(fs.readFileSync(file)) };
  });

  // The `syrup:` gate key was renamed to `optIn:` in 0.10.0. Fail loudly on a stale manifest
  // key rather than silently ignoring it — a silently-dropped gate would un-gate sensitive
  // syrup (e.g. a workflow needing repo write permissions) into the default render.
  if (manifest.syrup !== undefined) {
    throw new Error(`stack ${name}: manifest key \`syrup:\` was renamed to \`optIn:\` in 0.10.0 — rename it in stack.yaml`);
  }

  // optIn: sensitive items (e.g. a workflow needing repo write permissions) whose syrup must
  // be poured only on request. Each entry is an item ref (`files/<path>`) defined in this
  // stack; an opt-in item is excluded from a stack's default render unless the consumer
  // explicitly installs it or already tracks its path in the lock. The gate lives in
  // `computeSelection()`/`renderProject()`; `validate` checks each ref resolves.
  const optIn = new Set((manifest.optIn ?? []).map((ref) => normalizeItemRef(String(ref))));

  return {
    name,
    dir,
    description: manifest.description ?? '',
    agents,
    skills,
    files,
    optIn,
    config,
    declared,
    env: manifest.env ?? {},
    // Optional per-item dependency declarations: `skills/<name>`/`agents/<name>` →
    // list of `skills/<name>`/`agents/<name>` refs. Formalizes prose-only skill deps.
    requires: manifest.requires ?? {},
    setup: typeof manifest.setup === 'string' ? manifest.setup : '',
  };
}

/**
 * Config keys that are `required` and unresolved. When `usedKeys` is supplied, only
 * keys actually referenced by the selected items are considered — so a partial install
 * (one item from a stack) does not demand config only the stack's other items use.
 */
export function missingRequiredKeys(stack, values, lookup, usedKeys = null) {
  const missing = [];
  for (const [key, spec] of Object.entries(stack.config)) {
    if (!spec?.required) continue;
    if (usedKeys && !usedKeys.has(key)) continue;
    if (lookup(values, key) === undefined) missing.push(key);
  }
  return missing;
}
