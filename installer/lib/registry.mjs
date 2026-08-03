// @ts-check
/**
 * The **waffle registry** (#335) — `stacks/registry.yaml`, the single source of truth for waffle
 * identity, location, and availability.
 *
 * Before it existed, a waffle's existence was purely disk-driven: `stack.yaml` named it by bare
 * name and `refs.mjs` resolved that name against whatever directories happened to be present. Two
 * things followed. A rename or a move broke NOTHING loudly at the toolkit level — it just silently
 * changed what existed, and the consumer whose `include:` pinned the old ref found out at their
 * next render. And every waffle on disk was installable, so there was no way to develop one in the
 * open without shipping it, and no way to retire one without stranding whoever had pinned it.
 *
 * The registry closes both. It is *enforced*, not advisory:
 *   - `validate` reconciles registry ↔ filesystem ↔ every `stack.yaml` and reds on any divergence,
 *     which is what makes a rename impossible to land without updating the registry;
 *   - `refs.mjs` gates consumer-facing resolution on it, so a `wip` waffle is never offered;
 *   - a `replaced` entry carries the forward-fix, so a pinned consumer ref is FORWARDED rather
 *     than erroring, and `upgrade` rewrites the pin for good.
 *
 * ## Scope: what is registered, and what deliberately is not
 *
 * **Waffles only** — agents and skills. `files/` payloads (syrup) are NOT registered: syrup is
 * addressed by its repo-relative OUTPUT PATH rather than by a name, so its identity is already
 * pinned by the thing it renders to, and it has its own availability gate (`optIn:`). Registering
 * it would duplicate both with nothing left to decide. `stacks/registry.yaml` is likewise not a
 * stack list — `toolkit.yaml` owns that.
 *
 * **Built-in stacks only.** An external stack merged in from a `source:` (one carrying a
 * `provenance` record) belongs to a DIFFERENT toolkit and is governed by that toolkit's registry,
 * if it has one. Nothing here reds on it and nothing here gates it: a lookup for an unregistered
 * waffle returns `null`, which every gate reads as "available".
 *
 * ## The fail-open rule
 *
 * A lookup answers `null` for anything it does not recognise, and **only the exact string `wip`
 * gates**. That is not laziness, it is the safe direction: the render prunes every lock path it no
 * longer produces, so gating a waffle out DELETES it from a consumer's tree. A typo (`stabel`,
 * `WIP`) must therefore never be read as "gate this out" — it stays available and `validate` reds
 * on it. The destructive reading is the one that requires an exact, recognised spelling.
 *
 * A missing registry file is likewise a total no-op: the toolkit is simply ungated (this is what
 * lets a fixture or a fork run without one). What a registry-less toolkit loses is the enforcement,
 * not the ability to render.
 */

import path from 'node:path';
import { readYaml, exists } from './util.mjs';

/** The registry file, relative to the toolkit root. */
export const REGISTRY_FILE = path.join('stacks', 'registry.yaml');

/**
 * The registered waffle kinds, in the SINGULAR item vocabulary (`item.kind` in toolkit.mjs) —
 * `files` is deliberately absent; syrup is out of registry scope (see the module docblock).
 */
export const WAFFLE_KINDS = Object.freeze(['agent', 'skill']);

/**
 * The waffle lifecycle, and the whole of it:
 *   - `stable`     — offered, installable, supported. The default state of a shipped waffle.
 *   - `wip`        — present in the repo, never offered. Develop a waffle in the open without
 *                    shipping it. It is skipped by stack expansion, refused by an explicit
 *                    install, dropped from an agent's `skills:` closure, and absent from the setup
 *                    inventory. NEVER mark an already-shipped waffle `wip` — the render's prune
 *                    would delete it from every consumer that has it; use `deprecated`.
 *   - `deprecated` — still offered and still installable, but on the way out. May carry
 *                    `replacedBy` to name its successor, which `upgrade` surfaces as advice.
 *   - `replaced`   — a TOMBSTONE. The waffle no longer exists on disk; the entry survives so its
 *                    `replacedBy` can forward a consumer who pinned the old ref.
 */
export const WAFFLE_STATUSES = Object.freeze(['stable', 'wip', 'deprecated', 'replaced']);

/** Statuses of a waffle that still EXISTS on disk (so it carries a `stack:` and a `path:`). */
export const LIVE_STATUSES = Object.freeze(['stable', 'wip', 'deprecated']);

/**
 * The only keys a registry entry may carry. Unknown keys are rejected by `validate` rather than
 * ignored, for the reason every other manifest in this toolkit rejects them: a `replacedby:`
 * casing slip or a `status2:` typo would otherwise leave the entry silently in its DEFAULT
 * reading, which for a tombstone means a pinned consumer is never forwarded.
 */
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
 * The singular item kind for a plural REF kind. `files` has no registry kind — syrup is out of
 * scope — so it answers null, which every caller reads as "not a registered waffle".
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
 * The toolkit-root-relative path a live waffle MUST occupy. The registry records a path rather
 * than deriving one so the file reads as a location index, but the location is not a free choice:
 * `loadStack` joins the bare manifest name under the stack dir, so any other path would be a
 * fiction. `validate` checks the recorded path against this — which is exactly what turns a MOVE
 * into a red rather than a silent change of what exists.
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
 * Read `stacks/registry.yaml` from a toolkit root.
 *
 * An ABSENT file is a first-class, silent no-op (`present: false`) — see the module docblock.
 * A file that exists but is not a mapping with a `waffles:` list is a HARD ERROR, and the split is
 * deliberate: absence means "this toolkit does not use a registry", whereas a corrupt one means
 * "this toolkit uses a registry and we cannot read it", and quietly degrading THAT to an ungated
 * render is how a `wip` waffle ships. Per-entry shape problems are not errors here — they are
 * reported by `validateRegistry`, because every one of them is inert under the fail-open rule.
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
    // Index only what is USABLE. A malformed entry stays in `entries` (so `validate` reports it)
    // but never reaches a gate — under the fail-open rule an unindexed waffle is simply available.
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
 * (provenance-bearing) stack, a toolkit with no registry file, or a malformed entry.
 *
 * Keyed on the OWNING STACK as well as the ref, because a waffle name is not toolkit-unique (the
 * ref grammar has a stack-qualified form precisely because two stacks may define the same name),
 * and one of the two being `wip` must not gate the other.
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
 * Is this waffle gated out of every consumer-facing surface? True for the exact status `wip` and
 * nothing else — see the fail-open rule in the module docblock.
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
 * Follow a `replaced` tombstone to the ref that supersedes it — the forward-fix for a consumer
 * whose config still pins the old name.
 *
 * The chain is followed transitively (`a` → `b` → `c` returns `c`), so a waffle renamed twice
 * still forwards in one hop from a very old pin, and a cycle or an over-long chain answers null
 * rather than looping — `validate` reds on both, and a gate must not hang on a bad registry.
 * A tombstone whose successor is ITSELF a live entry is the terminal case; a tombstone with no
 * `replacedBy` (a plain removal) answers null, and the caller reports the ref as unknown.
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
      // `current` is no longer a tombstone: either we walked at least one hop (a real forward) or
      // the very first lookup missed (nothing to forward).
      return via.length ? { ref: `${refKind}/${current}`, name: current, via } : null;
    }
    if (!entry.replacedBy) return null; // a plain removal — there is nothing to forward TO
    if (via.includes(entry.replacedBy) || entry.replacedBy === name) return null; // cycle
    via.push(current);
    current = entry.replacedBy;
  }
  return null; // chain too long — treated exactly like a cycle
}
