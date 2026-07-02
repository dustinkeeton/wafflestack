import path from 'node:path';
import { readYaml, deepMerge, exists, lookupPath } from './util.mjs';

export const CONFIG_FILE = '.agent-toolkit.yaml';
export const LOCAL_CONFIG_FILE = '.agent-toolkit.local.yaml';
export const LOCK_FILE = '.agent-toolkit.lock.json';
export const EXTENSIONS_DIR = path.join('.agent-toolkit', 'extensions');

export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'];

/** Load .agent-toolkit.yaml with the gitignored local overlay merged over it. */
export function loadProjectConfig(cwd) {
  const file = path.join(cwd, CONFIG_FILE);
  if (!exists(file)) {
    throw new Error(`${CONFIG_FILE} not found in ${cwd} — run \`agent-toolkit init\` first`);
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
    values: cfg.config ?? {},
    eject: cfg.eject ?? [],
  };
}

/** Resolver for a bundle: project config value, else the bundle-declared default. */
export function makeResolver(bundle, values) {
  return (key) => {
    const v = lookupPath(values, key);
    if (v !== undefined) return v;
    return bundle.config[key]?.default;
  };
}
