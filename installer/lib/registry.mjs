// @ts-check
// The waffle registry (#335): `stacks/registry.yaml` → waffle identity, location, availability.
// Fail-open — only the exact string `wip` gates, because gating DELETES a poured waffle.

import path from 'node:path';
import { readYaml, exists } from './util.mjs';

/** The registry file, relative to the toolkit root. */
export const REGISTRY_FILE = path.join('stacks', 'registry.yaml');

/** The registered waffle kinds, in the SINGULAR item vocabulary (`item.kind` in toolkit.mjs). */
export const WAFFLE_KINDS = Object.freeze(['agent', 'skill']);

/**
 * The waffle lifecycle. NEVER mark an already-shipped waffle `wip` — the render's prune would
 * delete it from every consumer that has it; use `deprecated`.
 */
export const WAFFLE_STATUSES = Object.freeze(['stable', 'wip', 'deprecated', 'replaced']);

/** Statuses of a waffle that still EXISTS on disk (so it carries a `stack:` and a `path:`). */
export const LIVE_STATUSES = Object.freeze(['stable', 'wip', 'deprecated']);

/** The only keys a registry entry may carry; anything else is a `validate` red, never ignored. */
export const REGISTRY_ENTRY_KEYS = Object.freeze(['name', 'kind', 'stack', 'path', 'status', 'replacedBy', 'note']);

/** How deep a `replacedBy` chain may be followed before we call it a cycle. */
const MAX_REPLACEMENT_HOPS = 8;

/**
 * @typedef {object} RegistryEntry a registry entry, normalized but NOT yet validated
 * @property {number} index position in the file, for error messages
 * @property {string | null} name the canonical waffle name
 * @property {string | null} kind singular (`agent` | `skill`), or null when unusable
 * @property {'agents' | 'skills' | null} refKind the same kind in the plural REF vocabulary
 * @property {string | null} stack owning stack (live statuses only)
 * @property {string | null} path toolkit-root-relative path (live statuses only)
 * @property {string | null} status one of WAFFLE_STATUSES, or null when unusable
 * @property {string | null} replacedBy successor waffle NAME (`replaced` requires it)
 * @property {string | null} note optional free text
 * @property {string[]} unknownKeys keys outside REGISTRY_ENTRY_KEYS, for `validate`
 * @property {any} raw the entry exactly as authored
 *
 * @typedef {object} Registry
 * @property {boolean} present false when the toolkit ships no registry file — every gate no-ops
 * @property {string} file absolute path to the registry file
 * @property {RegistryEntry[]} entries every entry, in file order
 * @property {Map<string, RegistryEntry>} live `<stack>::<refKind>/<name>` → entry (live statuses)
 * @property {Map<string, RegistryEntry>} replaced `<refKind>/<name>` → entry (tombstones)
 */

/**
 * The plural REF kind for a singular item kind (see the two-vocabularies note in toolkit.mjs).
 *
 * @param {unknown} kind
 * @returns {'agents' | 'skills' | null}
 */
export function refKindOf(kind) {
  if (kind === 'agent') return 'agents';
  if (kind === 'skill') return 'skills';
  return null;
}

/**
 * The singular item kind for a plural REF kind; `files` answers null — syrup is out of scope.
 *
 * @param {unknown} kind
 * @returns {'agent' | 'skill' | null}
 */
export function waffleKindOf(kind) {
  if (kind === 'agents') return 'agent';
  if (kind === 'skills') return 'skill';
  return null;
}

/**
 * The toolkit-root-relative path a live waffle MUST occupy; `validate` reds on any other path.
 *
 * @param {string} stack
 * @param {string} kind singular waffle kind
 * @param {string} name
 * @returns {string | null} POSIX-separated, toolkit-root-relative; null for an unknown kind
 */
export function canonicalWafflePath(stack, kind, name) {
  if (kind === 'agent') return `stacks/${stack}/agents/${name}.md`;
  if (kind === 'skill') return `stacks/${stack}/skills/${name}`;
  return null;
}

/**
 * Read `stacks/registry.yaml`: an ABSENT file is a silent no-op, a corrupt one is a HARD ERROR.
 *
 * @param {string} rootDir toolkit root
 * @returns {Registry}
 */
export function loadRegistry(rootDir) {
  const file = path.join(rootDir, REGISTRY_FILE);
  /** @type {Registry} */
  const registry = { present: false, file, entries: [], live: new Map(), replaced: new Map() };
  if (!exists(file)) return registry;
  registry.present = true;

  const doc = readYaml(file);
  if (doc === null || doc === undefined) {
    throw new Error(`${REGISTRY_FILE} is empty — it must declare a \`waffles:\` list (use \`waffles: []\` for none)`);
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${REGISTRY_FILE} must be a mapping with a \`waffles:\` list`);
  }
  const raw = /** @type {any} */ (doc).waffles;
  if (!Array.isArray(raw)) {
    throw new Error(
      raw === undefined
        ? `${REGISTRY_FILE} has no \`waffles:\` key — it must declare a list of registry entries`
        : `${REGISTRY_FILE}: \`waffles:\` must be a list of registry entries`,
    );
  }

  raw.forEach((entry, index) => {
    const record = normalizeEntry(entry, index);
    registry.entries.push(record);
    // Index only what is USABLE: a malformed entry stays in `entries` for `validate` but never gates.
    if (!record.name || !record.refKind || !record.status) return;
    if (record.status === 'replaced') {
      const key = `${record.refKind}/${record.name}`;
      if (!registry.replaced.has(key)) registry.replaced.set(key, record);
      return;
    }
    if (!LIVE_STATUSES.includes(record.status) || !record.stack) return;
    const key = liveKey(record.stack, record.refKind, record.name);
    if (!registry.live.has(key)) registry.live.set(key, record);
  });

  return registry;
}

/**
 * @param {any} entry
 * @param {number} index
 * @returns {RegistryEntry}
 */
function normalizeEntry(entry, index) {
  const isMap = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
  const e = isMap ? entry : {};
  /** @type {(v: unknown) => string | null} */
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const kind = str(e.kind);
  const status = str(e.status);
  return {
    index,
    name: str(e.name),
    kind: kind && WAFFLE_KINDS.includes(kind) ? kind : null,
    refKind: refKindOf(kind),
    stack: str(e.stack),
    path: str(e.path),
    status: status && WAFFLE_STATUSES.includes(status) ? status : null,
    replacedBy: str(e.replacedBy),
    note: str(e.note),
    unknownKeys: isMap ? Object.keys(e).filter((k) => !REGISTRY_ENTRY_KEYS.includes(k)) : [],
    raw: entry,
  };
}

/**
 * @param {string} stack
 * @param {string} refKind
 * @param {string} name
 * @returns {string}
 */
function liveKey(stack, refKind, name) {
  return `${stack}::${refKind}/${name}`;
}

/**
 * The registered status of a live waffle, or `null` when it is not registered — an external
 * stack, a toolkit with no registry file, or a malformed entry.
 *
 * @param {Registry | null | undefined} registry
 * @param {string} stackName
 * @param {string} refKind the PLURAL ref kind (`agents` | `skills` | `files`)
 * @param {string} name
 * @returns {string | null}
 */
export function waffleStatus(registry, stackName, refKind, name) {
  if (!registry?.present) return null;
  return registry.live.get(liveKey(stackName, refKind, name))?.status ?? null;
}

/**
 * Is this waffle gated out of every consumer-facing surface? True for the exact status `wip` only.
 *
 * @param {Registry | null | undefined} registry
 * @param {string} stackName
 * @param {string} refKind
 * @param {string} name
 * @returns {boolean}
 */
export function isWaffleWip(registry, stackName, refKind, name) {
  return waffleStatus(registry, stackName, refKind, name) === 'wip';
}

/**
 * Follow a `replaced` tombstone transitively to the ref that supersedes it; a cycle or an
 * over-long chain answers null rather than looping.
 *
 * @param {Registry | null | undefined} registry
 * @param {string} refKind the PLURAL ref kind
 * @param {string} name
 * @returns {{ ref: string, name: string, via: string[] } | null} the terminal ref, plus the names
 *   walked through to reach it (for a report that names the whole rename chain)
 */
export function replacementFor(registry, refKind, name) {
  if (!registry?.present) return null;
  /** @type {string[]} */
  const via = [];
  let current = name;
  for (let hop = 0; hop < MAX_REPLACEMENT_HOPS; hop += 1) {
    const entry = registry.replaced.get(`${refKind}/${current}`);
    if (!entry) {
      return via.length ? { ref: `${refKind}/${current}`, name: current, via } : null;
    }
    if (!entry.replacedBy) return null; // a plain removal — there is nothing to forward TO
    if (via.includes(entry.replacedBy) || entry.replacedBy === name) return null; // cycle
    via.push(current);
    current = entry.replacedBy;
  }
  return null; // chain too long — treated exactly like a cycle
}
