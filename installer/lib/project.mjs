import path from 'node:path';
import { readYaml, deepMerge, exists, lookupPath } from './util.mjs';

export const CONFIG_FILE = '.wafflestack.yaml';
export const LOCAL_CONFIG_FILE = '.wafflestack.local.yaml';
export const LOCK_FILE = '.wafflestack.lock.json';
export const EXTENSIONS_DIR = path.join('.wafflestack', 'extensions');

export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'];

/** Load .wafflestack.yaml with the gitignored local overlay merged over it. */
export function loadProjectConfig(cwd) {
  const file = path.join(cwd, CONFIG_FILE);
  if (!exists(file)) {
    throw new Error(`${CONFIG_FILE} not found in ${cwd} — run \`wafflestack init\` first`);
  }
  let cfg = readYaml(file) ?? {};
  const localFile = path.join(cwd, LOCAL_CONFIG_FILE);
  if (exists(localFile)) cfg = deepMerge(cfg, readYaml(localFile) ?? {});

  const targets = cfg.targets ?? VALID_TARGETS;
  const bad = targets.filter((t) => !VALID_TARGETS.includes(t));
  if (bad.length) {
    throw new Error(`invalid targets in ${CONFIG_FILE}: ${bad.join(', ')} (valid: ${VALID_TARGETS.join(', ')})`);
  }

  return {
    targets,
    bundles: cfg.bundles ?? [],
    include: cfg.include ?? [],
    values: cfg.config ?? {},
    eject: cfg.eject ?? [],
  };
}

/**
 * Reserved `harness.*` template values, resolved per output target. Not declared in
 * any bundle — always available. A project may override any sub-key via
 * `config.harness.<sub>` (a scalar applied to every target, or a per-target map).
 */
export const HARNESS_BUILTINS = {
  assistantName: { claude: 'Claude', codex: 'Codex', 'agents-dir': 'Codex' },
  attributionPath: { claude: 'claude-code', codex: 'Codex', 'agents-dir': 'Codex' },
  // Where rendered skills live from that target's point of view, for content that
  // references skill files by path ("read {{harness.skillsDir}}/x/SKILL.md").
  skillsDir: { claude: '.claude/skills', codex: '.agents/skills', 'agents-dir': '.agents/skills' },
};

/**
 * Resolver for a bundle rendering to `target`:
 * - `harness.<sub>` — project override (scalar for all targets, or per-target map),
 *   falling back to the built-in for `target`.
 * - anything else — project config value, else the bundle-declared default.
 */
export function makeResolver(bundle, values, target) {
  return (key) => {
    if (key.startsWith('harness.')) {
      const sub = key.slice('harness.'.length);
      const override = lookupPath(values, key);
      let v;
      if (override !== undefined) {
        v = isPlainObject(override) ? override[target] : override;
      }
      if (v === undefined) v = HARNESS_BUILTINS[sub]?.[target];
      return v;
    }
    const v = lookupPath(values, key);
    if (v !== undefined) return v;
    return bundle.config[key]?.default;
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
