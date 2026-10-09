// The toolkit repo as a Claude Code plugin marketplace (#593): one entry per stack mod SOURCE dir.
import fs from 'node:fs';
import path from 'node:path';
import { MOD_MANIFEST } from './toolkit.mjs';

export const MARKETPLACE_FILE = path.join('.claude-plugin', 'marketplace.json');

/** `./stacks/<stack>/mods/<name>` — the entry `source` for a mod, relative to the toolkit root. */
export const marketplaceSource = (stack, mod) => `./stacks/${stack}/mods/${mod}`;

/** `<plugin>@<marketplace>` — the `enabledPlugins` key Claude Code uses for a marketplace plugin. */
export const marketplacePluginId = (plugin, marketplace) => `${plugin}@${marketplace}`;

/** Parse `.claude-plugin/marketplace.json`; `null` when absent. Throws on malformed JSON. */
export function readMarketplace(rootDir) {
  const file = path.join(rootDir, MARKETPLACE_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Keep the marketplace in lockstep with the stacks: every built-in mod listed once, by its
 * plugin.json `name`, at its source dir; no entry pointing anywhere else. A toolkit with no mods
 * needs no marketplace.
 *
 * @param {string} rootDir toolkit root
 * @param {import('./toolkit.mjs').Toolkit} toolkit
 * @returns {string[]} problems
 */
export function validateMarketplace(rootDir, toolkit) {
  const mods = [...toolkit.stacks.values()].flatMap((s) => s.mods.map((m) => ({ stack: s.name, mod: m })));
  let market;
  try {
    market = readMarketplace(rootDir);
  } catch (err) {
    return [`${MARKETPLACE_FILE} is not valid JSON: ${err.message}`];
  }
  if (!market) return mods.length ? [`${MARKETPLACE_FILE} is missing but the toolkit ships ${mods.length} mod(s)`] : [];

  const problems = [];
  if (market.name !== toolkit.name) problems.push(`${MARKETPLACE_FILE}: name "${market.name}" must equal toolkit.yaml name "${toolkit.name}"`);
  const plugins = Array.isArray(market.plugins) ? market.plugins : [];
  if (!Array.isArray(market.plugins)) problems.push(`${MARKETPLACE_FILE}: \`plugins\` must be a list`);

  const bySource = new Map();
  const names = new Set();
  for (const entry of plugins) {
    if (names.has(entry?.name)) problems.push(`${MARKETPLACE_FILE}: plugin name "${entry.name}" is listed twice`);
    names.add(entry?.name);
    const src = typeof entry?.source === 'string' ? entry.source : null;
    if (!src) {
      problems.push(`${MARKETPLACE_FILE}: plugin "${entry?.name}" needs a string \`source\` pointing at a stack mod dir`);
      continue;
    }
    if (bySource.has(src)) problems.push(`${MARKETPLACE_FILE}: source ${src} is listed twice`);
    bySource.set(src, entry);
    if (!fs.existsSync(path.join(rootDir, src))) problems.push(`${MARKETPLACE_FILE}: plugin "${entry.name}" points at nonexistent ${src}`);
  }

  const expected = new Set();
  for (const { stack, mod } of mods) {
    const src = marketplaceSource(stack, mod.name);
    expected.add(src);
    const entry = bySource.get(src);
    if (!entry) {
      problems.push(`${MARKETPLACE_FILE}: mod ${stack}/mods/${mod.name} is not listed (add source "${src}")`);
      continue;
    }
    let pluginName;
    try {
      pluginName = JSON.parse(fs.readFileSync(path.join(mod.dir, MOD_MANIFEST), 'utf8')).name;
    } catch {
      continue; // validateStack already reds an unparseable manifest
    }
    if (entry.name !== pluginName) {
      problems.push(`${MARKETPLACE_FILE}: entry for ${src} is named "${entry.name}" but its ${MOD_MANIFEST} says "${pluginName}"`);
    }
  }
  for (const [src, entry] of bySource) {
    if (!expected.has(src) && fs.existsSync(path.join(rootDir, src))) {
      problems.push(`${MARKETPLACE_FILE}: plugin "${entry.name}" points at ${src}, which is not a declared stack mod`);
    }
  }
  return problems;
}
