// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { readYaml, parseFrontmatter, exists, isBinary } from './util.mjs';
import { normalizeItemRef } from './refs.mjs';
import { VALID_TARGETS } from './project.mjs';
import { resolveSource } from './sources.mjs';
import { normalizePrerequisites } from './prerequisites.mjs';
import { loadRegistry } from './registry.mjs';

/** @import { ExternalStackEntry } from './project.mjs' */
/** @import { Registry } from './registry.mjs' */

/**
 * The core toolkit types. This module owns them; every other module imports them from here.
 *
 * @typedef {object} AgentItem
 * @property {'agent'} kind
 * @property {string} name
 * @property {string} file absolute path to `agents/<name>.md`
 * @property {Record<string, any>} data parsed frontmatter
 * @property {string} body markdown body, frontmatter stripped
 *
 * @typedef {object} SkillItem
 * @property {'skill'} kind
 * @property {string} name
 * @property {string} dir absolute path to `skills/<name>/`
 * @property {string[]} files skill-dir-relative paths, sorted; always includes `SKILL.md`
 *
 * @typedef {object} FileItem
 * @property {'files'} kind
 * @property {string} name the repo-relative output path (also the item's name)
 * @property {string} path absolute path to the source file under `files/`
 * @property {boolean} binary byte-copied when true, template-substituted when false
 * @property {string[] | null} targets declared harness scope (#364): null renders unconditionally,
 *   a list renders only when the consumer has enabled at least one listed target
 *
 * @typedef {AgentItem | SkillItem | FileItem} Item
 *
 * @typedef {object} Provenance
 * @property {string} name
 * @property {string} source
 * @property {'git' | 'path'} sourceType
 * @property {string | null} ref
 * @property {string | null} commit
 *
 * @typedef {object} Stack
 * @property {string} name
 * @property {string} dir
 * @property {string} description
 * @property {boolean} recommended pre-selected by the setup wizard; advisory only, never changes
 *   the render set
 * @property {AgentItem[]} agents
 * @property {SkillItem[]} skills
 * @property {FileItem[]} files
 * @property {Set<string>} optIn normalized `files/<path>` refs gated out of a default render
 * @property {Record<string, any>} config the declared `config:` block (key → spec)
 * @property {Set<string>} declared the keys of `config`
 * @property {Record<string, string>} env legacy harness `env:` map
 * @property {any[]} prerequisites normalized typed prerequisites
 * @property {Record<string, string[]>} requires item ref → dependency refs
 * @property {string} setup
 * @property {Provenance} [provenance] present only for a stack loaded from an external source
 *
 * @typedef {object} Toolkit
 * @property {string} name
 * @property {string} description
 * @property {Map<string, Stack>} stacks
 * @property {Registry} registry the waffle registry (#335) for the BUILT-IN stacks; absent file ⇒
 *   `{ present: false }` and every gate keyed on it no-ops
 */

/**
 * The parsed `stack.yaml` as AUTHORED — a malformed manifest can violate it at runtime, so
 * `validate` plus the defensive coercions below stay authoritative.
 *
 * @typedef {object} StackManifest
 * @property {string} [description]
 * @property {boolean} [recommended] pre-selected by the setup wizard unless the user opts out
 * @property {string[]} [agents] bare agent names
 * @property {string[]} [skills] bare skill names
 * @property {(string | { path: string, targets?: string[] })[]} [files] repo-relative output paths
 * @property {string[]} [optIn] item refs gated out of a default render
 * @property {Record<string, any>} [config] declared template keys (key → spec)
 * @property {Record<string, string>} [env] legacy harness env map
 * @property {any} [prerequisites] normalized by `normalizePrerequisites`
 * @property {Record<string, string[]>} [requires] item ref → dependency refs
 * @property {string} [setup]
 * @property {unknown} [syrup] removed in 0.10.0 — its presence is a hard error
 */

const FILE_ENTRY_KEYS = new Set(['path', 'targets']);

/**
 * Load the toolkit registry and every stack it lists.
 *
 * @param {string} rootDir
 * @returns {Toolkit}
 */
export function loadToolkit(rootDir) {
  const manifest = readYaml(path.join(rootDir, 'toolkit.yaml'));
  const stacks = new Map();
  for (const name of manifest.stacks ?? []) {
    const dir = path.join(rootDir, 'stacks', name);
    if (!exists(path.join(dir, 'stack.yaml'))) continue; // not yet authored
    stacks.set(name, loadStack(name, dir));
  }
  return { name: manifest.name, description: manifest.description, stacks, registry: loadRegistry(rootDir) };
}

/**
 * Load the built-in toolkit plus every external `source` declared in the project, merging them
 * into one registry so a single render/lock/doctor pipeline handles all of them (#88).
 *
 * @param {object} opts
 * @param {string} opts.builtinRoot toolkit root of the built-in stacks
 * @param {ExternalStackEntry[]} [opts.externalStacks]
 * @param {string} [opts.cwd] resolves a local-path source
 * @param {string} [opts.cacheDir] where git sources are checked out
 * @param {(source: string, ref: string, dest: string) => void} [opts.gitFetch] injectable for tests
 * @param {(dir: string) => string | null} [opts.gitResolveCommit] injectable for tests
 * @param {boolean} [opts.refreshSources] force a git re-fetch instead of reusing the session cache
 * @returns {Toolkit}
 */
export function loadToolkitWithSources({ builtinRoot, externalStacks = [], cwd, cacheDir, gitFetch, gitResolveCommit, refreshSources = false }) {
  const builtin = loadToolkit(builtinRoot);
  if (!externalStacks.length) return builtin;

  const stacks = new Map(builtin.stacks);
  const origin = new Map(); // stackName -> human-readable source, for collision messages
  for (const name of builtin.stacks.keys()) origin.set(name, 'the built-in toolkit');

  for (const ext of externalStacks) {
    if (stacks.has(ext.name)) {
      throw new Error(
        `stack "${ext.name}" is defined by two sources — ${origin.get(ext.name)} and external source ` +
          `${describeSource(ext)} — a stack name must be unique across all sources; rename or remove one`,
      );
    }
    const { root, commit } = resolveSource(ext, { cwd, cacheDir, gitFetch, gitResolveCommit, refresh: refreshSources });
    const dir = externalStackDir(root, ext.name);
    if (!dir) {
      throw new Error(
        `external stack "${ext.name}" (source: ${ext.source}) resolved to ${root} but no stack was found there — ` +
          `expected stacks/${ext.name}/stack.yaml (a toolkit root) or a stack.yaml at the source root (a single-stack source)`,
      );
    }
    const stack = loadStack(ext.name, dir);
    stack.provenance = {
      name: ext.name,
      source: ext.source,
      sourceType: ext.sourceType,
      ref: ext.ref ?? null,
      commit: commit ?? null,
    };
    stacks.set(ext.name, stack);
    origin.set(ext.name, `external source ${describeSource(ext)}`);
  }

  // The BUILT-IN registry rides through unchanged (#335): an external stack is governed by its own
  // toolkit's registry, and its unregistered waffles read as "available" to every gate here.
  return { name: builtin.name, description: builtin.description, stacks, registry: builtin.registry };
}

/**
 * Locate the stack `name` under a resolved external source root, preferring the toolkit-root
 * shape (`stacks/<name>/`) over a single-stack source (`stack.yaml` at its root).
 *
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
function externalStackDir(root, name) {
  const inToolkit = path.join(root, 'stacks', name);
  if (exists(path.join(inToolkit, 'stack.yaml'))) return inToolkit;
  if (exists(path.join(root, 'stack.yaml'))) return root;
  return null;
}

/**
 * @param {ExternalStackEntry} ext
 * @returns {string}
 */
function describeSource(ext) {
  return ext.ref ? `${ext.source}@${ext.ref}` : ext.source;
}

/**
 * @param {string} name
 * @param {string} dir
 * @returns {Stack}
 */
function loadStack(name, dir) {
  /** @type {StackManifest} */
  const manifest = readYaml(path.join(dir, 'stack.yaml'));
  const config = manifest.config ?? {};
  const declared = new Set(Object.keys(config));

  // Reject separators and dot segments BEFORE the first path.join, so a traversal entry like
  // `../../secret` is never dereferenced outside the toolkit root (#247). Slug shape is
  // validateStack's job; this only stops a name acting as a path.
  /**
   * @param {string} kind
   * @param {string} entry
   * @returns {string}
   */
  const bareName = (kind, entry) => {
    const n = String(entry);
    if (/[\\/]/.test(n) || n === '.' || n === '..') {
      throw new Error(`stack ${name}: ${kind} entry "${n}" must be a bare name with no path separators`);
    }
    return n;
  };

  // The `@type` is load-bearing: it types the map callback's return so `kind` keeps its LITERAL
  // type instead of widening to `string`. Same for the two below.
  /** @type {AgentItem[]} */
  const agents = (manifest.agents ?? []).map((entry) => {
    const agentName = bareName('agents', entry);
    const file = path.join(dir, 'agents', `${agentName}.md`);
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return { kind: 'agent', name: agentName, file, data, body };
  });

  /** @type {SkillItem[]} */
  const skills = (manifest.skills ?? []).map((entry) => {
    const skillName = bareName('skills', entry);
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

  /** @type {FileItem[]} */
  const files = (manifest.files ?? []).map((entry) => {
    const isMap = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
    if (isMap) {
      // Reject an unknown key rather than ignoring it: a `target:` (singular) typo would otherwise
      // leave the payload silently UNSCOPED.
      for (const k of Object.keys(entry)) {
        if (!FILE_ENTRY_KEYS.has(k)) {
          throw new Error(
            `stack ${name}: files entry has unknown key "${k}" (allowed: ${[...FILE_ENTRY_KEYS].join(', ')})`,
          );
        }
      }
      if (typeof entry.path !== 'string') {
        throw new Error(`stack ${name}: a mapping files entry needs a \`path:\` string (the repo-relative output path)`);
      }
      if (entry.targets !== undefined && !Array.isArray(entry.targets)) {
        throw new Error(`stack ${name}: files entry "${entry.path}" \`targets:\` must be a list of target names`);
      }
      // A `targets:` list the render cannot honour DELETES an already-poured copy from the
      // consumer's tree (the render prunes every lock path it no longer produces, #364), so the
      // loader — not `validate` — owns every name in this list.
      if (Array.isArray(entry.targets) && !entry.targets.length) {
        throw new Error(
          `stack ${name}: files entry "${entry.path}" declares an empty \`targets:\` list, so it can never render — ` +
            `omit \`targets:\` to render it unconditionally`,
        );
      }
      if (Array.isArray(entry.targets)) {
        // Widened to string[] deliberately: `includes` must accept an untrusted manifest string
        // rather than presupposing the very thing being checked.
        const known = /** @type {string[]} */ (VALID_TARGETS);
        const bad = entry.targets.map(String).filter((t) => !known.includes(t));
        if (bad.length) {
          throw new Error(
            `stack ${name}: files entry "${entry.path}" declares unknown target${bad.length > 1 ? 's' : ''} ` +
              `${bad.map((t) => `"${t}"`).join(', ')} (valid: ${VALID_TARGETS.join(', ')}) — an unknown name scopes the ` +
              `file away from the consumers it names, so an already-poured copy would be DELETED from their tree`,
          );
        }
      }
    }
    const rel = String(isMap ? entry.path : entry);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === '..')) {
      throw new Error(`stack ${name}: files entry "${rel}" must be a repo-relative path that stays inside the project`);
    }
    const file = path.join(dir, 'files', rel);
    if (!exists(file)) throw new Error(`stack ${name}: files entry "${rel}" not found under files/`);
    const targets = isMap && entry.targets !== undefined ? entry.targets.map(String) : null;
    return { kind: 'files', name: rel, path: file, binary: isBinary(fs.readFileSync(file)), targets };
  });

  if (manifest.syrup !== undefined) {
    throw new Error(`stack ${name}: manifest key \`syrup:\` was renamed to \`optIn:\` in 0.10.0 — rename it in stack.yaml`);
  }

  // Item refs excluded from a stack's default render; the gate itself lives in
  // `computeSelection()`/`renderProject()`.
  const optIn = new Set((manifest.optIn ?? []).map((ref) => normalizeItemRef(String(ref))));

  return {
    name,
    dir,
    description: manifest.description ?? '',
    recommended: manifest.recommended === true,
    agents,
    skills,
    files,
    optIn,
    config,
    declared,
    // Legacy `env:` map (#129) — subsumed by the typed `prerequisites:` below; a stack may use
    // either or both.
    env: manifest.env ?? {},
    prerequisites: normalizePrerequisites(manifest.prerequisites),
    requires: manifest.requires ?? {},
    setup: typeof manifest.setup === 'string' ? manifest.setup : '',
  };
}

/**
 * Config keys that are `required` and unresolved.
 *
 * @param {Stack} stack
 * @param {Record<string, any>} values resolved project config values
 * @param {(values: Record<string, any>, key: string) => any} lookup dotted-path lookup
 * @param {Set<string> | null} [usedKeys] keys actually referenced by the selected items
 * @returns {string[]} the missing required keys
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
