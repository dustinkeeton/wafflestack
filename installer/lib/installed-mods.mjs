// Stale installed mods (#730): an enabled mod whose Claude Code install record is older than the
// version this toolkit ships. Read-only over per-machine state; every failure is silence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, parseVersion } from './util.mjs';
import { readMarketplace } from './marketplace.mjs';
import { MOD_MANIFEST } from './toolkit.mjs';
import { enabledPluginIds } from './settings.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Claude Code's plugins root: `$CLAUDE_CODE_PLUGIN_CACHE_DIR`, else `<config dir>/plugins`. */
export function defaultPluginsDir(env = process.env) {
  if (env.CLAUDE_CODE_PLUGIN_CACHE_DIR) return path.resolve(env.CLAUDE_CODE_PLUGIN_CACHE_DIR);
  return path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude'), 'plugins');
}

/** Parsed `installed_plugins.json`, or `null` when absent, unreadable, or not the expected shape. */
export function readInstalledPlugins(pluginsDir) {
  if (!pluginsDir) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8'));
    return isObject(data) && isObject(data.plugins) ? data : null;
  } catch {
    return null;
  }
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The plugin.json `version` this toolkit ships for each of its marketplace entries. */
function shippedVersions(toolkitRoot) {
  const versions = new Map();
  let market;
  try {
    market = readMarketplace(toolkitRoot);
  } catch {
    return { name: null, versions };
  }
  for (const entry of Array.isArray(market?.plugins) ? market.plugins : []) {
    if (typeof entry?.source !== 'string') continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(toolkitRoot, entry.source, MOD_MANIFEST), 'utf8'));
      if (parseVersion(manifest.version)) versions.set(entry.name, manifest.version);
    } catch { /* skip an unreadable manifest */ }
  }
  return { name: market?.name ?? null, versions };
}

/**
 * Install records for the mods `settings` enables that are strictly older than the shipped version.
 * Records count when user-scope, or project/local-scope for this `cwd`.
 *
 * @param {{ cwd: string, settings: Record<string, unknown> | undefined, toolkitRoot: string | null, pluginsDir: string | null }} opts
 * @returns {{ id: string, scope: string, installed: string, source: string, command: string }[]}
 */
export function staleMods({ cwd, settings, toolkitRoot, pluginsDir }) {
  const ids = enabledPluginIds(settings);
  if (!ids.length || !toolkitRoot || !pluginsDir) return [];
  const installed = readInstalledPlugins(pluginsDir);
  if (!installed) return [];
  const { name: marketplace, versions } = shippedVersions(toolkitRoot);
  const here = realpath(cwd);
  const stale = [];
  for (const id of ids) {
    const at = id.lastIndexOf('@');
    const source = versions.get(id.slice(0, at));
    if (!source || id.slice(at + 1) !== marketplace) continue;
    const records = Array.isArray(installed.plugins[id]) ? installed.plugins[id] : [];
    for (const rec of records) {
      if (!isObject(rec) || !parseVersion(rec.version)) continue;
      const mine = rec.scope === 'user' || ((rec.scope === 'project' || rec.scope === 'local') && typeof rec.projectPath === 'string' && realpath(rec.projectPath) === here);
      if (!mine || compareVersions(rec.version, source) >= 0) continue;
      stale.push({ id, scope: rec.scope, installed: rec.version, source, command: `claude plugin update ${id} --scope ${rec.scope}` });
    }
  }
  return stale;
}

/** The doctor note for one stale record; `skew` (CLI ≠ render) means the pinned marketplace can't reach `source` until a re-render. */
export function formatStaleMod(m, { skew = false } = {}) {
  const where = m.scope === 'user' ? '' : ' (from this repo)';
  const first = skew ? '`wafflestack upgrade` (the render pins an older release), then ' : '';
  return `mod ${m.id} is installed at ${m.installed} (${m.scope} scope) but this toolkit ships ${m.source} — run${where}: ${first}${m.command}, then /reload-plugins or restart the session`;
}
