// @ts-check
// Recommended external plugins (#199): a stack's `recommendedPlugins:` entries, which `setup`
// offers to the user and nothing installs. Why they live on stack.yaml, not the registry: FORMAT.md.

import { normalizeItemRef } from './refs.mjs';

/** Allowed `recommendedPlugins:` entry keys; `validate` reports anything else. */
export const PLUGIN_ENTRY_KEYS = Object.freeze(['name', 'source', 'why', 'items', 'targets']);

/**
 * @typedef {object} RecommendedPlugin a normalized `recommendedPlugins:` entry — not yet validated
 * @property {number} index position in the list, for error messages
 * @property {string | null} name
 * @property {string | null} source marketplace ref or URL, surfaced verbatim; never fetched
 * @property {string | null} why one-line rationale shown before offering
 * @property {string[] | null} items item refs this recommendation is scoped to (null = absent or not a list)
 * @property {string[] | null} targets advisory harness names; printed, never a filter (null = absent or not a list)
 * @property {string[]} unknownKeys keys outside PLUGIN_ENTRY_KEYS
 * @property {any} raw the entry exactly as authored
 */

/**
 * Lenient: nothing throws. A present-but-not-a-list value becomes one unusable entry so
 * `validate` can report it instead of silence.
 *
 * @param {unknown} raw
 * @returns {RecommendedPlugin[]}
 */
export function normalizeRecommendedPlugins(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry, index) => {
    const isMap = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
    const e = isMap ? entry : {};
    /** @type {(v: unknown) => string | null} */
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      index,
      name: str(e.name),
      source: str(e.source),
      why: str(e.why),
      // `kind/name` form, matching `prerequisites[].items:`.
      items: Array.isArray(e.items) ? e.items.map((/** @type {unknown} */ r) => normalizeItemRef(String(r))) : null,
      targets: Array.isArray(e.targets) ? e.targets.map(String) : null,
      unknownKeys: isMap ? Object.keys(e).filter((k) => !PLUGIN_ENTRY_KEYS.includes(k)) : [],
      raw: entry,
    };
  });
}

/**
 * Entries with enough to act on (a name and a source); the rest are reported by `validate`
 * and never shown.
 *
 * @param {RecommendedPlugin[] | undefined} plugins
 * @returns {RecommendedPlugin[]}
 */
export function offerablePlugins(plugins) {
  return (plugins ?? []).filter((p) => p.name && p.source);
}
