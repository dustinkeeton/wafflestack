// @ts-check
/**
 * Recommended external plugins (#199) — the manifest affordance by which a stack points at
 * **harness plugins that live outside this toolkit** (a Claude Code plugin / marketplace entry, a
 * Codex extension) so `wafflestack setup` can OFFER them with the author's rationale.
 *
 * ## What this is not
 *
 * A plugin is **not a waffle**. Nothing here is rendered, locked, pruned, or ejected; the toolkit
 * neither fetches nor installs a plugin, and the render set is byte-identical whether a stack
 * declares recommendations or not. The whole feature is a **curated sentence the wizard reads to
 * the user**, in the same purely-advisory family as the `recommended:` stack flag: the toolkit
 * suggests, the user installs. That is why it is safe for this data to be un-verifiable — the
 * toolkit makes no claim it cannot back, because it makes no claim at all beyond "the stack author
 * suggests this".
 *
 * ## Why it lives on `stack.yaml` and not in the waffle registry
 *
 * The registry (`stacks/registry.yaml`, #335) is the identity/location/availability index for the
 * waffles this toolkit SHIPS: every entry names something on disk that a render can produce, and
 * its key set is closed precisely so an unrecognised key cannot silently change what exists. An
 * external plugin has none of those properties — no path, no status the render honours, nothing to
 * prune — so an entry for one would be a record about a thing the registry does not govern.
 * Curation belongs next to the thing doing the curating: the stack whose flow is better with the
 * plugin. `recommended:` (#201) set that precedent for advisory stack metadata; this follows it.
 *
 * Waffle-level granularity still exists, and it reuses vocabulary an author already knows: an
 * entry's optional `items:` list scopes the recommendation to specific waffles of the stack,
 * exactly as `prerequisites[].items:` does — so a partial install is pitched only the plugins its
 * own selection benefits from, and "a *waffle* references a recommended plugin" needs no second
 * schema surface.
 *
 * ## Tolerance
 *
 * Normalization is deliberately lenient (the `normalizePrerequisites` posture, not the `targets:`
 * posture): a malformed entry is normalized to null fields and reported by `validate`, never
 * thrown at load. The split is the toolkit's standing rule — the loader hard-errors only on
 * malformations whose effect is DESTRUCTIVE (a bad `files: targets:` deletes a poured file out of
 * a consumer's tree). A bad plugin recommendation can, at absolute worst, fail to be mentioned.
 * Unknown keys are still collected rather than dropped, so `validate` can name a `reason:`-for-
 * `why:` slip instead of leaving the entry quietly rationale-less.
 */

import { normalizeItemRef } from './refs.mjs';

/**
 * The only keys a `recommendedPlugins:` entry may carry. Anything else is reported by `validate`
 * (see REGISTRY_ENTRY_KEYS for the same reasoning): a near-miss spelling is the likely mistake,
 * and a silently-ignored `reason:` leaves the wizard offering a plugin with no rationale — the one
 * thing the entry exists to carry.
 */
export const PLUGIN_ENTRY_KEYS = Object.freeze(['name', 'source', 'why', 'items', 'targets']);

/**
 * @typedef {object} RecommendedPlugin a normalized `recommendedPlugins:` entry — NOT yet validated
 * @property {number} index position in the list, for error messages
 * @property {string | null} name the plugin's name, as the user will look for it
 * @property {string | null} source where the user gets it — a marketplace ref or a URL. Surfaced
 *   verbatim for the user to act on; the toolkit never fetches it.
 * @property {string | null} why the one-line rationale the wizard shows before asking
 * @property {string[] | null} items item refs this recommendation is scoped to (null = the key is
 *   absent or is not a list — `validate` tells those two apart via `raw`)
 * @property {string[] | null} targets harnesses the plugin is for (null = absent/not a list).
 *   ADVISORY: the inventory is generated before a project's targets are known, so this is printed
 *   for the setup agent to act on, never a filter the code applies.
 * @property {string[]} unknownKeys keys outside PLUGIN_ENTRY_KEYS, for `validate`
 * @property {any} raw the entry exactly as authored
 */

/**
 * Normalize a stack manifest's raw `recommendedPlugins:` list.
 *
 * Absent (or explicitly null) ⇒ `[]`, the overwhelmingly common case. A present-but-not-a-list
 * value is wrapped as ONE unusable entry rather than discarded: `prerequisites:` written as a map
 * vanishes silently today, and silence is the failure mode an author cannot debug — this way
 * `validate` says the entry is not a well-formed mapping instead of saying nothing at all.
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
      // Refs are normalized to `kind/name` form so they compare against a selection's refs, the
      // same way `prerequisites[].items:` does.
      items: Array.isArray(e.items) ? e.items.map((/** @type {unknown} */ r) => normalizeItemRef(String(r))) : null,
      targets: Array.isArray(e.targets) ? e.targets.map(String) : null,
      unknownKeys: isMap ? Object.keys(e).filter((k) => !PLUGIN_ENTRY_KEYS.includes(k)) : [],
      raw: entry,
    };
  });
}

/**
 * The entries a surface may actually OFFER: enough of an entry survives to be acted on (a name to
 * look for, a source to get it from). A malformed entry is reported by `validate` and simply not
 * shown — a fork that does not run `validate` prints nothing rather than a half-line naming a
 * plugin the user cannot find.
 *
 * @param {RecommendedPlugin[] | undefined} plugins
 * @returns {RecommendedPlugin[]}
 */
export function offerablePlugins(plugins) {
  return (plugins ?? []).filter((p) => p.name && p.source);
}
