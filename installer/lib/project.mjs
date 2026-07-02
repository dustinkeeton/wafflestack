import fs from 'node:fs';
import path from 'node:path';
import { readYaml, deepMerge, exists, lookupPath } from './util.mjs';

export const CONFIG_FILE = '.waffle.yaml';
export const LOCAL_CONFIG_FILE = '.waffle.local.yaml';
export const LOCK_FILE = '.waffle.lock.json';
export const EXTENSIONS_DIR = path.join('.waffle', 'extensions');

// Legacy (pre-0.6.0) consumer dot-paths. Still read as a fallback so a repo that has not
// re-rendered under >=0.6.0 keeps working, and renamed to the names above by a plain
// `render`/`upgrade` (via `migrateLegacyDotfiles`) or the 0.6.0 migration step (#17).
export const LEGACY_CONFIG_FILE = '.wafflestack.yaml';
export const LEGACY_LOCAL_CONFIG_FILE = '.wafflestack.local.yaml';
export const LEGACY_LOCK_FILE = '.wafflestack.lock.json';
export const LEGACY_EXTENSIONS_DIR = path.join('.wafflestack', 'extensions');

export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'];

/**
 * Resolve a consumer dot-path under `cwd`, preferring the current `.waffle.*` name but
 * falling back to the legacy `.wafflestack.*` name when only the legacy file is present.
 * Returns `{ file, legacy, note }` — `file` is the absolute path to read (the current name
 * when neither exists, so "not found" errors name the current file), `legacy` flags a
 * fallback, and `note` is a one-line deprecation message the caller can surface.
 */
function resolveDotPath(cwd, currentName, legacyName) {
  const current = path.join(cwd, currentName);
  if (exists(current)) return { file: current, legacy: false, note: null };
  const legacy = path.join(cwd, legacyName);
  if (exists(legacy)) {
    return {
      file: legacy,
      legacy: true,
      note: `legacy ${legacyName} is deprecated — run \`wafflestack render\` (or \`upgrade\`) to rename it to ${currentName}`,
    };
  }
  return { file: current, legacy: false, note: null };
}

export const resolveConfigFile = (cwd) => resolveDotPath(cwd, CONFIG_FILE, LEGACY_CONFIG_FILE);
export const resolveLocalConfigFile = (cwd) => resolveDotPath(cwd, LOCAL_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE);
export const resolveLockFile = (cwd) => resolveDotPath(cwd, LOCK_FILE, LEGACY_LOCK_FILE);

/**
 * Rename any legacy `.wafflestack.*` consumer dot-paths under `cwd` to their `.waffle.*`
 * equivalents, in place. Idempotent: a path moves only when the legacy name exists and the
 * current name does not, so re-running on an already-migrated or fresh repo is a harmless
 * no-op. Returns the `{ from, to }` renames performed (for reporting). This is the body of
 * the 0.6.0 migration and also runs at the top of every `render`, so a plain re-render
 * carries a legacy repo across too.
 */
export function migrateLegacyDotfiles(cwd) {
  const renamed = [];
  const pairs = [
    [LEGACY_CONFIG_FILE, CONFIG_FILE],
    [LEGACY_LOCAL_CONFIG_FILE, LOCAL_CONFIG_FILE],
    [LEGACY_LOCK_FILE, LOCK_FILE],
    [LEGACY_EXTENSIONS_DIR, EXTENSIONS_DIR],
  ];
  for (const [from, to] of pairs) {
    const fromPath = path.join(cwd, from);
    const toPath = path.join(cwd, to);
    if (exists(fromPath) && !exists(toPath)) {
      fs.mkdirSync(path.dirname(toPath), { recursive: true });
      fs.renameSync(fromPath, toPath);
      renamed.push({ from, to });
    }
  }
  // The legacy `.wafflestack/` dir only ever held `extensions/`; drop it once emptied.
  const legacyDir = path.join(cwd, '.wafflestack');
  if (exists(legacyDir)) {
    try {
      if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    } catch { /* non-empty or racing — leave it in place */ }
  }
  return renamed;
}

/**
 * Which legacy `.wafflestack.*` paths a repo's `.gitignore` still lists. The CLI never edits
 * `.gitignore` (a consumer owns it), so after the dotfile rename we remind them to update the
 * entries themselves. Self-clearing: returns [] once the stale lines are gone.
 */
export function staleGitignoreEntries(cwd) {
  const gi = path.join(cwd, '.gitignore');
  if (!exists(gi)) return [];
  const text = fs.readFileSync(gi, 'utf8');
  return [LEGACY_LOCAL_CONFIG_FILE, LEGACY_LOCK_FILE].filter((name) => text.includes(name));
}

/**
 * Load `.waffle.yaml` with the gitignored local overlay merged over it, falling back to the
 * legacy `.wafflestack.*` names when the current ones are absent. Deprecation notes for any
 * legacy read are pushed onto `notes` (when provided) for the caller to surface.
 */
export function loadProjectConfig(cwd, notes = []) {
  const cfgPath = resolveConfigFile(cwd);
  if (!exists(cfgPath.file)) {
    throw new Error(`${CONFIG_FILE} not found in ${cwd} — run \`wafflestack init\` first`);
  }
  if (cfgPath.legacy) notes.push(cfgPath.note);
  let cfg = readYaml(cfgPath.file) ?? {};
  const localPath = resolveLocalConfigFile(cwd);
  if (exists(localPath.file)) {
    if (localPath.legacy) notes.push(localPath.note);
    cfg = deepMerge(cfg, readYaml(localPath.file) ?? {});
  }

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
