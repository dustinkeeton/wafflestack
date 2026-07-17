// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { readYaml, parseFrontmatter, exists, isBinary } from './util.mjs';
import { normalizeItemRef } from './refs.mjs';
import { VALID_TARGETS } from './project.mjs';
import { resolveSource } from './sources.mjs';
import { normalizePrerequisites } from './prerequisites.mjs';

/** @import { ExternalStackEntry } from './project.mjs' */

/**
 * The core toolkit types. This module owns them; every other module imports them from here.
 *
 * NOTE — two `kind` vocabularies coexist, and they are NOT interchangeable:
 *   - an ITEM's intrinsic `kind` (below) is `'agent'` | `'skill'` | `'files'` — singular for
 *     agents and skills, but plural for files;
 *   - a REF/selection `kind` (see refs.mjs `ItemKind`) is always plural: `'agents'` | `'skills'`
 *     | `'files'`.
 * A selection entry wraps an item as `{ kind: 'agents', item: AgentItem }` — outer kind plural,
 * inner `item.kind` singular. Typing both literally is deliberate: it makes tsc reject a
 * cross-vocabulary comparison like `item.kind === 'agents'`, which today would silently be
 * false forever. Do not "harmonize" these types without changing the runtime that produces them.
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
 * @property {string[] | null} targets declared harness scope, or null when unscoped (#364).
 *   null (no `targets:` key on the manifest entry) = renders unconditionally — the pre-#364
 *   contract, and the overwhelmingly common case, since a `.github/` payload has nothing to do
 *   with which harness you run. A list = renders only when the consumer has enabled at least one
 *   of these targets. Unlike an agent or a skill, a file has no per-harness variant, so `targets:`
 *   FILTERS it (whether it renders) rather than fanning it out (how many times).
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
 * @property {boolean} recommended true when the manifest sets `recommended: true`; the setup
 *   wizard pre-selects it by default (still user-overridable). Advisory only — it never forces a
 *   render or changes the render set.
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
 */

/**
 * The parsed `stack.yaml`, as AUTHORED — i.e. the shape a well-formed manifest has, not a shape
 * anything has yet proven. It comes straight off `readYaml`, so a malformed manifest can violate
 * it at runtime; `validate` (plus the defensive `String()`/`typeof` coercions below) stays
 * authoritative. Declaring it buys the `agents:`/`skills:`/`files:`/`optIn:` map callbacks a real
 * element type instead of an implicit `any`.
 *
 * @typedef {object} StackManifest
 * @property {string} [description]
 * @property {boolean} [recommended] pre-selected by the setup wizard unless the user opts out
 * @property {string[]} [agents] bare agent names
 * @property {string[]} [skills] bare skill names
 * @property {(string | { path: string, targets?: string[] })[]} [files] repo-relative output paths —
 *   a bare string, or the map form `{ path, targets }` that scopes the payload to harnesses (#364)
 * @property {string[]} [optIn] item refs gated out of a default render
 * @property {Record<string, any>} [config] declared template keys (key → spec)
 * @property {Record<string, string>} [env] legacy harness env map
 * @property {any} [prerequisites] normalized by `normalizePrerequisites`
 * @property {Record<string, string[]>} [requires] item ref → dependency refs
 * @property {string} [setup]
 * @property {unknown} [syrup] removed in 0.10.0 — its presence is a hard error
 */

/** The only keys a map-form `files:` entry may carry (#364). */
const FILE_ENTRY_KEYS = new Set(['path', 'targets']);

/**
 * Load the toolkit registry and every stack it lists.
 *
 * @param {string} rootDir
 * @returns {Toolkit}
 */
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

/**
 * Load the built-in toolkit plus every external `source` declared in the project, merging them
 * into one registry so a single render/lock/doctor pipeline handles all of them (#88).
 *
 * Each external `{ name, source, ref }` entry resolves to a toolkit root on disk (a git URL
 * fetched at the pinned `ref`, or a local path read in place — see `resolveSource`) and its
 * `name` selects a single stack from that root, loaded with the same `loadStack` machinery the
 * built-in stacks use. The stack is registered under the entry `name`, carrying a `provenance`
 * record ({ name, source, sourceType, ref, commit }) so `render` can attribute every file it
 * emits to its source in the lock (#125). `refreshSources` forces a git re-fetch of each pinned
 * ref (how `upgrade` observes a moved ref) rather than reusing the session cache.
 *
 * Collision detection is a hard error, never a silent shadow: if an external stack name is
 * already defined by another source — the built-in toolkit or an earlier external source — the
 * load fails loudly naming BOTH sources. (Item-name clashes among the *enabled* stacks of two
 * sources surface downstream as the render's per-output-path `emit()` conflict, which names the
 * two contributing stacks — hence a stack name uniquely identifies its source.)
 *
 * With no external stacks this is exactly `loadToolkit(builtinRoot)` — nothing is fetched.
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
    // Full provenance (#125): where every file this stack renders came from, recorded in the lock
    // so drift and upgrades attribute per source. Git → URL + pinned ref + resolved commit; a
    // local path → the path (no ref/commit).
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

  return { name: builtin.name, description: builtin.description, stacks };
}

/**
 * Locate the stack `name` under a resolved external source root. A source may be a full toolkit
 * root (the stack lives at `stacks/<name>/`, exactly like the built-in layout) or point directly
 * at a single stack directory (a `stack.yaml` at its root). Prefers the toolkit-root shape.
 * Returns the stack directory, or null when neither layout has a `stack.yaml`.
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

  // A manifest `agents:`/`skills:` entry is a bare name used verbatim as a path segment under
  // the stack dir. Reject separators and the dot segments BEFORE the first path.join, so a
  // traversal entry like `../../secret` is never dereferenced outside the toolkit root at load
  // time — the same load-time posture `files:` entries get below (#247 review). Fine-grained
  // slug shape is validateStack's job (AGENT_SLUG_RE); this only stops a name acting as a path.
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

  // The `@type` is load-bearing, not decoration: it contextually types the map callback's return
  // so `kind: 'agent'` keeps its LITERAL type instead of widening to `string`. Same for the two
  // below. (See the two-kind-vocabularies note on the typedefs.)
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

  // Generic payloads: a file authored under `files/<repo-relative-path>` renders verbatim
  // to that same path in the consuming project (CI workflows, scripts, config). Text files
  // are template-substituted, binaries byte-copied — text/binary is sniffed by content, so
  // any text type works, not just `.md`.
  //
  // An entry is a bare path string, or the map form `{ path, targets }` (#364) that scopes a
  // harness-specific payload to the harnesses it is actually for.
  /** @type {FileItem[]} */
  const files = (manifest.files ?? []).map((entry) => {
    const isMap = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
    if (isMap) {
      // Reject an unknown key rather than ignoring it: a `target:` (singular) typo would otherwise
      // leave the payload silently UNSCOPED — the exact failure this field exists to prevent. Same
      // reasoning as STACK_ENTRY_KEYS (project.mjs) and the `syrup:` → `optIn:` hard error.
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
      // A `targets:` list the render cannot honour is the one manifest shape whose only possible
      // effect is DESTRUCTIVE: because the render prunes every lock path it no longer produces
      // (#364), an already-poured copy is DELETED from the consumer's tree, with `ok: true` and no
      // warning. So the loader — not `validate` — owns EVERY name in this list.
      //
      // An EMPTY list scopes the file to nothing, so it can never render. It also cannot mean
      // anything an author intended: "scoped to no harness" is not a thing to want.
      if (Array.isArray(entry.targets) && !entry.targets.length) {
        throw new Error(
          `stack ${name}: files entry "${entry.path}" declares an empty \`targets:\` list, so it can never render — ` +
            `omit \`targets:\` to render it unconditionally`,
        );
      }
      // An UNKNOWN NAME is the same hazard reached by a one-character typo, and it was once left to
      // `validate` on the grounds that a stale name is "inert — nothing renders, nothing is
      // destroyed". THAT PREMISE IS FALSE, in both directions, and each is reproduced in the tests:
      //   - `targets: [claud]` resolves to NOTHING, so it is `targets: []` spelled differently: the
      //     poured copy is pruned out of EVERY consumer's tree.
      //   - `targets: [claude, codxe]` (partially valid — one real name survives) still deletes the
      //     poured copy out of a CODEX consumer's tree. "One valid name survives" does not make the
      //     entry safe; it only narrows WHICH consumers it destroys.
      // So there is no inert case to be tolerant of, and a rule keyed on "resolves to zero valid
      // names" would have closed only the first hole. `validate` is toolkit-developer lint that
      // consumers never run over built-in stacks (`render` imports only `validateExternalStacks`),
      // and the toolkit is explicitly forkable — a fork without that CI gate must not be able to
      // ship a silent delete. The consumer's own config has always hard-errored on an unknown target
      // name (project.mjs); the manifest is the side that can DESTROY a file, so it is not the side
      // that gets to be lenient. A name outside VALID_TARGETS can only ever be an authoring bug:
      // the set is closed and code-defined, not an open extension point.
      if (Array.isArray(entry.targets)) {
        // Widened to string[] deliberately: the whole point is to test UNTRUSTED manifest strings
        // against the closed Target set, so `includes` must accept a plain string rather than
        // presupposing the very thing being checked.
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
    // Target scoping (#364), optional: null = unscoped = renders regardless of the consumer's
    // `targets:` (the pre-#364 contract). Every declared name is validated ABOVE, at load — unlike
    // `optIn:` and `prerequisites:`, this field is load-strict, because it is the only one whose
    // malformation deletes a file out of a consumer's repo.
    const targets = isMap && entry.targets !== undefined ? entry.targets.map(String) : null;
    return { kind: 'files', name: rel, path: file, binary: isBinary(fs.readFileSync(file)), targets };
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
    // Advisory pre-selection flag (#201): the setup wizard defaults recommended stacks ON, still
    // user-overridable. `=== true` so a missing/malformed value is a plain `false`, mirroring the
    // defensive coercions used throughout this loader. Read generically from the manifest so #202
    // needs only a one-line `recommended: true` in its stack.yaml — never keyed on a stack name.
    recommended: manifest.recommended === true,
    agents,
    skills,
    files,
    optIn,
    config,
    declared,
    // Legacy harness `env:` map — read-compatible and unchanged (#129): still warned at render
    // by `checkEnvPrerequisites` (target-aware — it checks the harness settings file). The typed
    // `prerequisites:` list below SUBSUMES env as one of its kinds without forcing this map to
    // migrate; a stack may use either or both.
    env: manifest.env ?? {},
    // Typed external prerequisites (#47/#129): a declared list of environment things the stack
    // needs (tool/secret/scope/label/setting/service/env), each with a deterministic `check`
    // and a require/recommend `level`. Verified by the `doctor` gate and warned at render.
    prerequisites: normalizePrerequisites(manifest.prerequisites),
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
