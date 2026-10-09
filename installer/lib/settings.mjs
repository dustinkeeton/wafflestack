// Lock-managed ENTRIES inside a consumer-owned JSON settings file (#594): mods render as
// `enabledPlugins` + `extraKnownMarketplaces` keys merged into `.claude/settings.json`, never a file.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { exists, resolveInside, writeFileEnsuringDir } from './util.mjs';

export const SETTINGS_FILE = path.join('.claude', 'settings.json');

const enc = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const dec = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');

/** A lock `settings` key: `<file>#/<RFC 6901 pointer>`, e.g. `.claude/settings.json#/enabledPlugins/x@y`. */
export const settingsKey = (segments, file = SETTINGS_FILE) => `${file}#/${segments.map(enc).join('/')}`;

/** @returns {{ file: string, segments: string[] } | null} */
export function parseSettingsKey(key) {
  const at = key.indexOf('#/');
  return at < 0 ? null : { file: key.slice(0, at), segments: key.slice(at + 2).split('/').map(dec) };
}

export const marketplaceKey = (marketplace) => settingsKey(['extraKnownMarketplaces', marketplace]);
export const pluginKey = (pluginId) => settingsKey(['enabledPlugins', pluginId]);
const PLUGIN_PREFIX = settingsKey(['enabledPlugins', '']);
const MARKETPLACE_PREFIX = settingsKey(['extraKnownMarketplaces', '']);

/** Does `key` enable mod `name` (`<name>@<any marketplace>`)? */
export const ownsModKey = (name) => (key) => key.startsWith(pluginKey(`${name}@`));

/** Every key a lock tracks — rendered paths and settings entries — the "already poured" set. */
export const lockKeys = (lock) => [...Object.keys(lock?.files ?? {}), ...Object.keys(lock?.settings ?? {})];

/**
 * The entries a mod selection renders: the marketplace once, each plugin id (`<name>@<marketplace>`)
 * enabled under it. A `ref` pins the source to the toolkit release (#595); null tracks the default branch.
 *
 * @param {{ pluginIds: string[], marketplace: string, repo: string, ref?: string | null }} opts
 * @returns {Map<string, unknown>}
 */
export function modSettingsEntries({ pluginIds, marketplace, repo, ref = null }) {
  const entries = new Map();
  if (!pluginIds.length) return entries;
  entries.set(marketplaceKey(marketplace), { source: { source: 'github', repo, ...(ref ? { ref } : {}) } });
  for (const id of pluginIds) entries.set(pluginKey(id), true);
  return entries;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @returns {{ abs: string | null, present: boolean, data?: any, error?: string }} */
function readSettingsFile(cwd, file) {
  const abs = resolveInside(cwd, file);
  if (!abs) return { abs: null, present: false, error: `${file} resolves outside the project root` };
  if (!exists(abs)) return { abs, present: false, data: {} };
  try {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return isObject(data) ? { abs, present: true, data } : { abs, present: true, error: `${file} is not a JSON object` };
  } catch (err) {
    return { abs, present: true, error: `${file} is not valid JSON: ${err.message}` };
  }
}

/** The value at `segments`, `undefined` when absent; `blocked` when a parent is a non-object. */
function lookup(data, segments) {
  let node = data;
  for (const [i, seg] of segments.entries()) {
    if (!isObject(node)) return { value: undefined, blocked: i > 0 };
    if (!Object.hasOwn(node, seg)) return { value: undefined, blocked: false };
    node = node[seg];
  }
  return { value: node, blocked: false };
}

function setAt(data, segments, value) {
  let node = data;
  for (const seg of segments.slice(0, -1)) {
    if (!isObject(node[seg])) node[seg] = {};
    node = node[seg];
  }
  node[segments.at(-1)] = value;
}

/** Delete `segments` and every parent object it leaves empty. */
function deleteAt(data, segments) {
  const [head, ...rest] = segments;
  if (!isObject(data) || !Object.hasOwn(data, head)) return;
  if (rest.length) {
    deleteAt(data[head], rest);
    if (isObject(data[head]) && !Object.keys(data[head]).length) delete data[head];
  } else {
    delete data[head];
  }
}

const byFile = (keys) => {
  const groups = new Map();
  for (const key of keys) {
    const parsed = parseSettingsKey(key);
    if (!parsed) continue;
    if (!groups.has(parsed.file)) groups.set(parsed.file, []);
    groups.get(parsed.file).push({ key, segments: parsed.segments });
  }
  return groups;
};

/** The current value of one settings key on disk; `undefined` when absent or unreadable. */
export function settingsValueAt(cwd, key) {
  const parsed = parseSettingsKey(key);
  const file = parsed && readSettingsFile(cwd, parsed.file);
  return file?.data ? lookup(file.data, parsed.segments).value : undefined;
}

/**
 * Pre-write gate, mirroring #25's refusal for files: an unmanaged key already holding a DIFFERENT
 * value is a collision (identical is adopted); an unparseable settings file is an error.
 *
 * @param {string} cwd @param {Map<string, unknown>} desired @param {Record<string, unknown>} managed
 */
export function settingsConflicts(cwd, desired, managed) {
  const collisions = [];
  const errors = [];
  for (const [file, entries] of byFile([...desired.keys(), ...Object.keys(managed)])) {
    const read = readSettingsFile(cwd, file);
    if (read.error) {
      errors.push(`cannot merge wafflestack entries into ${read.error} — fix it, then re-render`);
      continue;
    }
    for (const { key, segments } of entries) {
      if (!desired.has(key) || key in managed) continue;
      const { value, blocked } = lookup(read.data, segments);
      if (blocked || (value !== undefined && !isDeepStrictEqual(value, desired.get(key)))) collisions.push(key);
    }
  }
  return { collisions, errors };
}

/**
 * Merge `desired` into the settings files and drop `managed` keys no longer desired. Foreign keys are
 * never touched; a file whose values would not change is not rewritten. Returns the pruned keys.
 *
 * @param {string} cwd @param {Map<string, unknown>} desired @param {Record<string, unknown>} managed
 */
export function applySettings(cwd, desired, managed) {
  const removed = [];
  for (const [file, entries] of byFile(new Set([...desired.keys(), ...Object.keys(managed)]))) {
    const read = readSettingsFile(cwd, file);
    if (read.error) continue;
    const before = structuredClone(read.data);
    for (const { key, segments } of entries) {
      if (desired.has(key)) setAt(read.data, segments, desired.get(key));
      else if (lookup(read.data, segments).value !== undefined) {
        deleteAt(read.data, segments);
        removed.push(key);
      }
    }
    const adds = entries.some(({ key }) => desired.has(key));
    if (!isDeepStrictEqual(before, read.data) || (!read.present && adds)) {
      writeFileEnsuringDir(read.abs, `${JSON.stringify(read.data, null, 2)}\n`);
    }
  }
  return removed;
}

/** Remove `keys` from their settings files (eject/uninstall); returns the keys actually removed. */
export function removeSettingsEntries(cwd, keys) {
  return applySettings(cwd, new Map(), Object.fromEntries(keys.map((k) => [k, null])));
}

/**
 * Doctor's compare for settings entries: a missing FILE is `missing` (a partial checkout, like an
 * absent rendered file); a dropped or changed key in a present file is `modified`.
 *
 * @param {string} cwd @param {Record<string, unknown>} entries the lock's `settings` map
 */
export function settingsDrift(cwd, entries) {
  const modified = [];
  const missing = [];
  for (const [file, group] of byFile(Object.keys(entries))) {
    const read = readSettingsFile(cwd, file);
    for (const { key, segments } of group) {
      if (!read.present) missing.push(key);
      else if (read.error || !isDeepStrictEqual(lookup(read.data, segments).value, entries[key])) modified.push(key);
    }
  }
  return { modified, missing };
}

/**
 * The keys an eject of mod `name` releases from one lock's `settings`: its plugin entries, plus the
 * marketplace entries once no plugin entry remains to need them.
 */
export function modReleaseKeys(settings, name) {
  const keys = Object.keys(settings ?? {});
  const owned = keys.filter(ownsModKey(name));
  const othersRemain = keys.some((k) => k.startsWith(PLUGIN_PREFIX) && !owned.includes(k));
  return othersRemain ? owned : [...owned, ...keys.filter((k) => owned.length && k.startsWith(MARKETPLACE_PREFIX))];
}

/** Sorted plain object for the lock. */
export const settingsLockMap = (entries) =>
  Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
