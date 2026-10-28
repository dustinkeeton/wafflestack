// @ts-check
// `wafflestack config [key-prefix]` (#701): look up the config keys a selection can set — value,
// source file, default, constraints. `setup` builds its "Config values" section from the same
// `configCatalog`, so the two views cannot drift.

import { loadToolkitWithSources } from './toolkit.mjs';
import { defaultSourceCacheDir } from './sources.mjs';
import { computeSelection } from './refs.mjs';
import { readTreeLock, collectUsedKeys } from './render.mjs';
import { lockKeys } from './settings.mjs';
import { loadProjectConfig, makeResolver, resolveLocalConfigFile } from './project.mjs';
import { exists, readYaml, lookupPath } from './util.mjs';
import { layerOf, firstSentence, expandKey } from './state.mjs';

/** @import { Stack } from './toolkit.mjs' */
/** @import { SelectionItem } from './refs.mjs' */
/** @import { ProjectConfig, Target } from './project.mjs' */

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
 * @property {{ stackName: string, stack: Stack, spec: any, value: any }[]} decls
 * @property {boolean} conflict the declarations disagree on requiredness/default/constraints
 * @property {string|null} [expanded] a templated value, fully expanded
 *
 * @typedef {object} ConfigModel
 * @property {MergedKey[]} keys
 * @property {string[]} errors selection problems
 * @property {Map<string, string[]>} declaredElsewhere out-of-scope key → declaring stacks
 *
 * @typedef {{ mode: 'list'|'detail', query: string, keys: MergedKey[], key?: MergedKey, error?: undefined }
 *   | { error: string }} ConfigQuery
 */

/** @type {Record<string, Source>} */
const SOURCE_OF_LAYER = { 'local-overlay': 'waffle.local.yaml', 'waffle.yaml': 'waffle.yaml', 'stack-default': 'default' };

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
    const usedKeys = collectUsedKeys(its);
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
        byKey.set(e.key, { key: e.key, value: e.value, set: e.set, source: e.source, required: !!e.spec?.required, decls: [decl], conflict: false });
        continue;
      }
      m.decls.push(decl);
      m.required ||= !!e.spec?.required;
      if (m.value === undefined) m.value = e.value;
      if (declSignature(e.spec) !== declSignature(m.decls[0].spec)) m.conflict = true;
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Collect the config view of the repo at `cwd`. Read-only; throws when `.waffle/waffle.yaml` is absent.
 *
 * @param {{ cwd: string, toolkitRoot: string, toolkitVersion: string, sourceCacheDir?: string }} opts
 * @returns {ConfigModel}
 */
export function collectConfig({ cwd, toolkitRoot, toolkitVersion, sourceCacheDir = defaultSourceCacheDir() }) {
  const project = loadProjectConfig(cwd);
  const overlayFile = resolveLocalConfigFile(cwd).file;
  const localOverlay = exists(overlayFile);
  const canonical = localOverlay ? loadProjectConfig(cwd, [], { canonical: true }) : project;
  const overlayValues = localOverlay ? (readYaml(overlayFile)?.config ?? {}) : {};

  const toolkit = loadToolkitWithSources({
    builtinRoot: toolkitRoot,
    externalStacks: project.externalStacks ?? [],
    cwd,
    cacheDir: sourceCacheDir,
    refreshSources: false,
  });
  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const trackedFiles = new Set(lockKeys(readTreeLock(cwd)));
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);
  const target = project.targets[0] ?? 'claude';

  const catalog = configCatalog(selection.items, { values: project.values, target, toolkitVersion, overlayValues, committedValues: canonical.values });
  const keys = mergeCatalog(catalog);
  for (const k of keys) {
    if (typeof k.value === 'string' && k.value.includes('{{')) k.expanded = expandKey(k.decls[0].stack, project, target, k.key);
  }

  const inScope = new Set(keys.map((k) => k.key));
  /** @type {Map<string, string[]>} */
  const declaredElsewhere = new Map();
  for (const [name, stack] of toolkit.stacks) {
    for (const key of Object.keys(stack.config ?? {})) {
      if (inScope.has(key)) continue;
      declaredElsewhere.set(key, [...(declaredElsewhere.get(key) ?? []), name]);
    }
  }
  return { keys, errors: selection.errors, declaredElsewhere };
}

/**
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  /** @type {number[]} */
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The closest in-scope key or dotted ancestor to `q`, or null when nothing is close.
 * @param {string} q
 * @param {string[]} keys
 */
export function nearestKey(q, keys) {
  const candidates = new Set();
  for (const k of keys) {
    const parts = k.split('.');
    for (let i = 1; i <= parts.length; i++) candidates.add(parts.slice(0, i).join('.'));
  }
  const limit = Math.max(2, Math.floor(q.length / 4));
  /** @type {string|null} */
  let best = null;
  let bestD = Infinity;
  const lq = q.toLowerCase();
  for (const c of [...candidates].sort()) {
    const lc = c.toLowerCase();
    // Ties go to a completion of what was typed (`a.n` → `a.num`, not its parent `a`).
    const d = editDistance(lq, lc) - (lc.startsWith(lq) ? 0.5 : 0);
    if (d < bestD) [best, bestD] = [c, d];
  }
  return bestD <= limit ? best : null;
}

/**
 * Answer `wafflestack config [arg]`: every key, one exact key, a dotted prefix, or an error.
 *
 * @param {ConfigModel} model
 * @param {string} [arg]
 * @returns {ConfigQuery}
 */
export function queryConfig(model, arg) {
  const query = String(arg ?? '').trim().replace(/^config\./, '');
  if (!query) return { mode: 'list', query, keys: model.keys };
  if (query === 'harness' || query.startsWith('harness.')) {
    return { error: '`harness.*` keys are per-target built-ins, not stack config — see schema/FORMAT.md, "The `harness.*` namespace"' };
  }
  const key = model.keys.find((k) => k.key === query);
  const children = model.keys.filter((k) => k.key.startsWith(`${query}.`));
  if (key) return { mode: 'detail', query, key, keys: children };
  if (children.length) return { mode: 'list', query, keys: children };

  const elsewhere = model.declaredElsewhere.get(query);
  if (elsewhere) {
    return { error: `config key \`${query}\` is declared by stack(s) ${elsewhere.join(', ')} but nothing in this selection references it` };
  }
  const hint = nearestKey(query, model.keys.map((k) => k.key));
  return { error: `unknown config key or prefix \`${query}\`${hint ? ` — did you mean \`${hint}\`?` : ''}` };
}

const SUMMARY_MAX = 110;

/**
 * A value on one line; multi-line and long structured values point at the exact-key lookup.
 * @param {string} key
 * @param {any} v
 */
function inlineValue(key, v) {
  if (v === undefined) return '(unset)';
  if (typeof v === 'string') {
    const lines = v.split('\n').length;
    return lines > 1 ? `(multi-line, ${lines} lines — wafflestack config ${key})` : v;
  }
  const json = JSON.stringify(v);
  return json.length <= 80 ? json : `(${Array.isArray(v) ? 'list' : 'map'}, ${json.length} chars — wafflestack config ${key})`;
}

/** @param {any} v */
function fullValue(v) {
  if (v === undefined) return '(unset)';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

/** @param {{ min?: number, max?: number }} range */
function formatRange(range) {
  if (range.min !== undefined && range.max !== undefined) return `${range.min}–${range.max}`;
  return range.min !== undefined ? `≥ ${range.min}` : `≤ ${range.max}`;
}

/**
 * The stack-level `constraints:` touching `key`, phrased relative to it.
 * @param {MergedKey} k
 * @returns {string[]}
 */
function constraintsOf(k) {
  const seen = new Set();
  for (const { stack } of k.decls) {
    for (const c of Array.isArray(stack.constraints) ? stack.constraints : []) {
      const keys = Array.isArray(c?.keys) ? c.keys : [];
      if (!keys.includes(k.key)) continue;
      if (c.kind === 'lessThan') seen.add(keys[0] === k.key ? `< ${keys[1]}` : `> ${keys[0]}`);
      else if (c.kind === 'anyPositive') seen.add(`at least one of {${keys.join(', ')}} > 0`);
      else seen.add(`${c.kind}: ${keys.join(', ')}`);
    }
  }
  return [...seen];
}

/**
 * The present constraint facts of one declaration, as `label: value` pairs.
 * @param {any} spec
 * @returns {[string, string][]}
 */
function specFacts(spec) {
  /** @type {[string, string][]} */
  const facts = [];
  if (spec?.range) facts.push(['range', formatRange(spec.range)]);
  // configModes, when present, is what doctor accepts in config — `modes` would overstate it.
  if (Array.isArray(spec?.configModes)) facts.push(['config may set', spec.configModes.join('|')]);
  else if (Array.isArray(spec?.modes)) facts.push(['modes', spec.modes.join('|')]);
  if (spec?.flag && typeof spec.flag === 'object') {
    facts.push(['flag', [spec.flag.on, spec.flag.off].filter((t) => t !== undefined).join(' / ')]);
  }
  return facts;
}

/** @param {MergedKey} k */
function tag(k) {
  if (k.value === undefined && k.required) return 'required ⚠';
  return k.set ? k.source : 'default';
}

/** @param {MergedKey} k */
function conflictLines(k) {
  const lines = ['⚠ declarations disagree — each stack renders its own:'];
  for (const d of k.decls) {
    const req = d.spec?.required ? 'required' : 'optional';
    const def = d.spec?.default === undefined ? 'no default' : `default ${inlineValue(k.key, d.spec.default)}`;
    lines.push(`  ${d.stackName}: ${req}, ${def} → ${inlineValue(k.key, d.value)}`);
  }
  return lines;
}

/**
 * @param {string} text
 * @param {number} width
 */
function wrap(text, width) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** @param {MergedKey} k */
function listBlock(k) {
  const spec = k.decls[0].spec;
  let summary = firstSentence(spec?.description);
  if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1)}…`;
  /** @type {string[]} */
  const meta = [];
  if (spec?.default !== undefined) meta.push(`default: ${inlineValue(k.key, spec.default)}`);
  for (const [label, v] of specFacts(spec)) meta.push(`${label}: ${v}`);
  for (const c of constraintsOf(k)) meta.push(`constraint: ${c}`);
  meta.push(`${k.decls.length > 1 ? 'stacks' : 'stack'}: ${k.decls.map((d) => d.stackName).join(', ')}`);
  const lines = [`${k.key} = ${inlineValue(k.key, k.value)}   [${tag(k)}]`];
  if (summary) lines.push(`  ${summary}`);
  lines.push(`  ${meta.join(' · ')}`);
  if (k.conflict) lines.push(...conflictLines(k).map((l) => `  ${l}`));
  return lines;
}

/** @param {MergedKey} k */
function detailBlock(k) {
  const spec = k.decls[0].spec;
  /** @param {string} label @param {string} v */
  const field = (label, v) => (v.includes('\n') ? [`${label}:`, ...v.split('\n').map((l) => `    ${l}`)] : [`${label}: ${v}`]);
  const lines = [k.key, ''];
  lines.push(...field('value', fullValue(k.value)));
  if (k.expanded && k.expanded !== k.value) lines.push(...field('expands to', k.expanded));
  lines.push(`source: ${k.set ? k.source : 'default'}`);
  lines.push(...field('default', spec?.default === undefined ? '(none)' : fullValue(spec.default)));
  lines.push(`required: ${k.required ? (k.value === undefined ? 'yes ⚠ (unset — render blocker)' : 'yes') : 'no'}`);
  for (const [label, v] of specFacts(spec)) lines.push(`${label}: ${v}`);
  for (const c of constraintsOf(k)) lines.push(`constraint: ${c}`);
  lines.push(`${k.decls.length > 1 ? 'stacks' : 'stack'}: ${k.decls.map((d) => d.stackName).join(', ')}`);
  if (k.conflict) lines.push(...conflictLines(k));
  const desc = wrap(spec?.description, 100);
  if (desc.length) lines.push('', ...desc);
  return lines;
}

/**
 * Plain-text rendering of a successful query.
 * @param {Extract<ConfigQuery, { mode: string }>} r
 * @returns {string}
 */
export function formatConfig(r) {
  /** @type {string[]} */
  const lines = [];
  if (r.mode === 'detail' && r.key) {
    lines.push(...detailBlock(r.key));
    if (r.keys.length) lines.push('', `keys under ${r.query}.:`, '');
  } else {
    const scope = r.query ? ` under \`${r.query}\`` : '';
    lines.push(`${r.keys.length} config key(s)${scope} in scope for this selection — exact lookup: wafflestack config <key>`, '');
  }
  for (const k of r.keys) lines.push(...listBlock(k), '');
  return `${lines.join('\n').trimEnd()}\n`;
}
