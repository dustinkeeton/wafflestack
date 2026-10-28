// @ts-check
// The config-key catalog (#701): which keys a selection references and how each stack declares
// them. A leaf module so `config`, `setup`, `state`, `render` and the generated reference file
// (#703) share one catalog without an import cycle.

import fs from 'node:fs';
import path from 'node:path';
import { makeResolver } from './project.mjs';
import { lookupPath } from './util.mjs';
import { placeholderKeys } from './template.mjs';

/** @import { Stack } from './toolkit.mjs' */
/** @import { SelectionItem } from './refs.mjs' */
/** @import { Target } from './project.mjs' */

/**
 * @typedef {'default'|'waffle.yaml'|'waffle.local.yaml'} Source
 *
 * @typedef {object} CatalogEntry one in-scope key of one stack
 * @property {string} key
 * @property {any} spec the stack's `config:` declaration
 * @property {any} value the effective value for this stack (undefined when unset with no default)
 * @property {boolean} set the project config (overlay included) gives it a value
 * @property {Source} source
 *
 * @typedef {object} CatalogStack
 * @property {string} stackName
 * @property {Stack} stack
 * @property {CatalogEntry[]} entries declaration order, scoped to the keys the selected items reference
 *
 * @typedef {object} MergedKey one key across every selected stack declaring it
 * @property {string} key
 * @property {any} value
 * @property {boolean} set
 * @property {Source} source
 * @property {boolean} required some declaring stack requires it
 * @property {boolean} blocked some declaring stack requires it and resolves no value
 * @property {{ stackName: string, stack: Stack, spec: any, value: any }[]} decls
 * @property {boolean} conflict the declarations disagree on requiredness/default/constraints
 * @property {string|null} [expanded] a templated value, fully expanded
 */

/**
 * The first sentence of a `description:`, whitespace-collapsed — the full prose stays in `stack.yaml`.
 * @param {unknown} text
 */
export function firstSentence(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  return m ? m[1] : flat;
}

/**
 * @param {string} key
 * @param {Record<string, any>} overlayValues
 * @param {Record<string, any>} committedValues
 * @returns {'local-overlay'|'waffle.yaml'|'stack-default'}
 */
export function layerOf(key, overlayValues, committedValues) {
  if (lookupPath(overlayValues, key) !== undefined) return 'local-overlay';
  if (lookupPath(committedValues, key) !== undefined) return 'waffle.yaml';
  return 'stack-default';
}

/**
 * Placeholder keys referenced by a set of selected items' source content.
 * @param {{ kind: string, item: any }[]} items
 * @returns {Set<string>}
 */
export function collectUsedKeys(items) {
  /** @type {Set<string>} */
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
    } else if (kind === 'files' && !item.binary) {
      for (const k of placeholderKeys(fs.readFileSync(item.path, 'utf8'))) keys.add(k);
    }
  }
  return keys;
}

/** @type {Record<string, Source>} */
const SOURCE_OF_LAYER = { 'local-overlay': 'waffle.local.yaml', 'waffle.yaml': 'waffle.yaml', 'stack-default': 'default' };

/**
 * `used` plus every key reachable through a used key's default template or `omitWhenEmpty:` gate.
 * @param {Set<string>} used
 * @param {Record<string, any>} config
 */
function closeOverDefaults(used, config) {
  const out = new Set(used);
  const queue = [...out];
  while (queue.length) {
    const spec = config[/** @type {string} */ (queue.pop())];
    const next = typeof spec?.default === 'string' ? [...placeholderKeys(spec.default)] : [];
    if (typeof spec?.omitWhenEmpty === 'string') next.push(spec.omitWhenEmpty);
    for (const k of next) {
      if (out.has(k)) continue;
      out.add(k);
      queue.push(k);
    }
  }
  return out;
}

/**
 * Every config key the selected items reference, per stack, with its effective value — scoped like
 * the render (#77): each stack resolves through its own resolver.
 *
 * @param {SelectionItem[]} items
 * @param {{ values: Record<string, any>, target: Target, toolkitVersion?: string, overlayValues?: Record<string, any>, committedValues?: Record<string, any> }} opts
 * @returns {CatalogStack[]}
 */
export function configCatalog(items, { values, target, toolkitVersion, overlayValues = {}, committedValues = values }) {
  /** @type {Map<string, { stack: Stack, items: { kind: string, item: any }[] }>} */
  const groups = new Map();
  for (const { stackName, stack, kind, item } of items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName)?.items.push({ kind, item });
  }
  /** @type {CatalogStack[]} */
  const out = [];
  for (const [stackName, { stack, items: its }] of groups) {
    const usedKeys = closeOverDefaults(collectUsedKeys(its), stack.config ?? {});
    const resolve = makeResolver(stack, values, target, toolkitVersion === undefined ? {} : { toolkitVersion });
    const entries = Object.entries(stack.config ?? {})
      .filter(([key]) => usedKeys.has(key))
      .map(([key, spec]) => ({
        key,
        spec,
        value: resolve(key),
        set: lookupPath(values, key) !== undefined,
        source: SOURCE_OF_LAYER[layerOf(key, overlayValues, committedValues)],
      }));
    out.push({ stackName, stack, entries });
  }
  return out;
}

/** @param {any} spec */
function declSignature(spec) {
  const s = spec ?? {};
  return JSON.stringify([!!s.required, s.default ?? null, s.range ?? null, s.modes ?? null, s.configModes ?? null, s.flag ?? null, s.lockMode ?? null]);
}

/**
 * Fold the per-stack catalog into one entry per key, sorted. Declarations that disagree on anything
 * but the description are a conflict — surfaced, never silently resolved.
 *
 * @param {CatalogStack[]} stacks
 * @returns {MergedKey[]}
 */
export function mergeCatalog(stacks) {
  /** @type {Map<string, MergedKey>} */
  const byKey = new Map();
  for (const { stackName, stack, entries } of stacks) {
    for (const e of entries) {
      const decl = { stackName, stack, spec: e.spec, value: e.value };
      const m = byKey.get(e.key);
      if (!m) {
        byKey.set(e.key, { key: e.key, value: e.value, set: e.set, source: e.source, required: false, blocked: false, decls: [decl], conflict: false });
        continue;
      }
      m.decls.push(decl);
      if (m.value === undefined) m.value = e.value;
      if (declSignature(e.spec) !== declSignature(m.decls[0].spec)) m.conflict = true;
    }
  }
  for (const m of byKey.values()) {
    m.required = m.decls.some((d) => !!d.spec?.required);
    m.blocked = m.decls.some((d) => !!d.spec?.required && d.value === undefined);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}
