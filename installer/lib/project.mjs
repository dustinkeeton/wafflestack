import fs from 'node:fs';
import path from 'node:path';
import { readYaml, deepMerge, exists, lookupPath } from './util.mjs';

// Canonical consumer paths — everything wafflestack keeps in a consumer repo lives inside
// the one `.waffle/` directory (config, local overlay, lock, extensions) as of 0.8.0 (#43).
export const CONFIG_FILE = '.waffle/waffle.yaml';
export const LOCAL_CONFIG_FILE = '.waffle/waffle.local.yaml';
export const LOCK_FILE = '.waffle/waffle.lock.json';
export const EXTENSIONS_DIR = path.join('.waffle', 'extensions');

// Legacy (0.6.0 – 0.7.x) repo-root dot-paths, introduced by the #17 rename and moved into
// `.waffle/` by the 0.8.0 migration (#43). Still read as a fallback, and moved to the names
// above by a plain `render`/`upgrade` (via `migrateLegacyDotfiles`) or the 0.8.0 step.
export const LEGACY_ROOT_CONFIG_FILE = '.waffle.yaml';
export const LEGACY_ROOT_LOCAL_CONFIG_FILE = '.waffle.local.yaml';
export const LEGACY_ROOT_LOCK_FILE = '.waffle.lock.json';

// Legacy (pre-0.6.0) consumer dot-paths. Still read as a (last) fallback so a repo that has
// not re-rendered since keeps working; `migrateLegacyDotfiles` chains them through the
// 0.6.0 rename (#17) all the way into `.waffle/` in one pass.
export const LEGACY_CONFIG_FILE = '.wafflestack.yaml';
export const LEGACY_LOCAL_CONFIG_FILE = '.wafflestack.local.yaml';
export const LEGACY_LOCK_FILE = '.wafflestack.lock.json';
export const LEGACY_EXTENSIONS_DIR = path.join('.wafflestack', 'extensions');

export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'];

/**
 * Resolve a consumer dot-path under `cwd`, preferring the current `.waffle/` name but
 * falling back through `legacyNames` (ordered newest generation first) when only an older
 * layout is present. Returns `{ file, legacy, note }` — `file` is the absolute path to read
 * (the current name when nothing exists, so "not found" errors name the current file),
 * `legacy` flags a fallback, and `note` is a one-line deprecation message the caller can
 * surface, naming the legacy path found and how to migrate it.
 */
function resolveDotPath(cwd, currentName, legacyNames) {
  const current = path.join(cwd, currentName);
  if (exists(current)) return { file: current, legacy: false, note: null };
  for (const legacyName of legacyNames) {
    const legacy = path.join(cwd, legacyName);
    if (exists(legacy)) {
      return {
        file: legacy,
        legacy: true,
        note: `legacy ${legacyName} is deprecated — run \`wafflestack render\` (or \`upgrade\`) to move it to ${currentName}`,
      };
    }
  }
  return { file: current, legacy: false, note: null };
}

export const resolveConfigFile = (cwd) =>
  resolveDotPath(cwd, CONFIG_FILE, [LEGACY_ROOT_CONFIG_FILE, LEGACY_CONFIG_FILE]);
export const resolveLocalConfigFile = (cwd) =>
  resolveDotPath(cwd, LOCAL_CONFIG_FILE, [LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE]);
export const resolveLockFile = (cwd) =>
  resolveDotPath(cwd, LOCK_FILE, [LEGACY_ROOT_LOCK_FILE, LEGACY_LOCK_FILE]);

/**
 * Move any legacy consumer dot-paths under `cwd` to their current `.waffle/` locations, in
 * place. Idempotent: a path moves only when the older name exists and the newer one does
 * not, so re-running on an already-migrated or fresh repo is a harmless no-op. The pairs
 * are ordered oldest generation first so a pre-0.6.0 repo chains `.wafflestack.*` →
 * `.waffle.*` → `.waffle/waffle.*` in a single pass. Returns the `{ from, to }` renames
 * performed (for reporting). This is the shared body of the 0.6.0 and 0.8.0 migrations and
 * also runs at the top of every `render`, so a plain re-render carries a legacy repo
 * across too.
 */
export function migrateLegacyDotfiles(cwd) {
  const renamed = [];
  const pairs = [
    // pre-0.6.0 `.wafflestack.*` → 0.6.0-era root `.waffle.*` (#17) …
    [LEGACY_CONFIG_FILE, LEGACY_ROOT_CONFIG_FILE],
    [LEGACY_LOCAL_CONFIG_FILE, LEGACY_ROOT_LOCAL_CONFIG_FILE],
    [LEGACY_LOCK_FILE, LEGACY_ROOT_LOCK_FILE],
    [LEGACY_EXTENSIONS_DIR, EXTENSIONS_DIR],
    // … then root `.waffle.*` → inside the `.waffle/` directory (#43). Creating `.waffle/`
    // coexists with a pre-existing `.waffle/extensions/` (mkdir is recursive-safe).
    [LEGACY_ROOT_CONFIG_FILE, CONFIG_FILE],
    [LEGACY_ROOT_LOCAL_CONFIG_FILE, LOCAL_CONFIG_FILE],
    [LEGACY_ROOT_LOCK_FILE, LOCK_FILE],
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
 * Which legacy paths a repo's `.gitignore` still lists — the now-stale root
 * `.waffle.local.yaml` / `.waffle.lock.json` lines as well as the pre-0.6.0
 * `.wafflestack.*` ones. The CLI never edits `.gitignore` unasked (a consumer owns it), so
 * after a dotfile move we remind them to update the entries themselves. Self-clearing:
 * returns [] once the stale lines are gone. (A current `.waffle/waffle.*` line never
 * matches a legacy name — the `/` breaks the substring — so migrated repos stay quiet.)
 */
export function staleGitignoreEntries(cwd) {
  const gi = path.join(cwd, '.gitignore');
  if (!exists(gi)) return [];
  const text = fs.readFileSync(gi, 'utf8');
  return [
    LEGACY_ROOT_LOCAL_CONFIG_FILE,
    LEGACY_ROOT_LOCK_FILE,
    LEGACY_LOCAL_CONFIG_FILE,
    LEGACY_LOCK_FILE,
  ].filter((name) => text.includes(name));
}

// Marker prefixing wafflestack's own appended block, so a human scanning `.gitignore` can see
// where the offered entries came from. Written once; a later run appends more lines below it.
export const GITIGNORE_MARKER = '# wafflestack';

/**
 * Idempotently append `.gitignore` entries the consumer has approved — via the `--gitignore`
 * flag on `init`/`render`/`install`, or an agent acting on the setup playbook's offer. This is
 * the one place the CLI writes `.gitignore`, refining the "never edits it" stance to "never
 * edits it *unasked*". Append-only and non-destructive: an entry already present (exact,
 * whitespace-trimmed line match) is skipped, existing content is preserved verbatim (a missing
 * trailing newline is added so the first appended entry can't glue onto the last existing
 * line), and the `# wafflestack` marker is written once. Creates `.gitignore` when absent.
 * Returns the entries actually added (for reporting) — [] when everything was already present.
 */
export function ensureGitignoreEntries(cwd, entries) {
  const gi = path.join(cwd, '.gitignore');
  const existing = exists(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const toAdd = [];
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (entry && !present.has(entry)) {
      present.add(entry); // also dedupes repeats within `entries`
      toAdd.push(entry);
    }
  }
  if (!toAdd.length) return [];

  const block = toAdd.map((e) => `${e}\n`).join('');
  let out;
  if (!existing) {
    out = `${GITIGNORE_MARKER}\n${block}`;
  } else {
    const base = existing.endsWith('\n') ? existing : `${existing}\n`;
    // Blank line + marker before the first wafflestack block; later runs append under it.
    const header = existing.includes(GITIGNORE_MARKER) ? '' : `\n${GITIGNORE_MARKER}\n`;
    out = `${base}${header}${block}`;
  }
  fs.writeFileSync(gi, out);
  return toAdd;
}

/**
 * The `.gitignore` entries wafflestack recommends for a loaded `project` — the baseline offer
 * behind the `--gitignore` flag and the setup playbook. Always the local overlay
 * (`.waffle/waffle.local.yaml`, account-specific config that must never be committed), plus
 * the resolved `git.worktreesDir` (throwaway working state) when an enabled bundle declares
 * that key. Dev-only / self-hosting mode — also gitignoring the renders +
 * `.waffle/waffle.lock.json`, paired with `doctor --allow-missing` — is a separate opt-in the
 * agent proposes case by case, not part of this baseline.
 */
export function recommendedGitignoreEntries(toolkit, project) {
  const entries = [LOCAL_CONFIG_FILE];
  for (const name of project.bundles ?? []) {
    const bundle = toolkit.bundles.get(name);
    if (!bundle || !('git.worktreesDir' in bundle.config)) continue;
    const resolve = makeResolver(bundle, project.values ?? {}, project.targets?.[0] ?? 'claude');
    const dir = resolve('git.worktreesDir');
    if (dir) {
      const normalized = `${String(dir).replace(/\/+$/, '')}/`; // dir-only match, no double slash
      if (!entries.includes(normalized)) entries.push(normalized);
    }
    break; // bundles share the one key; a single worktrees dir is enough
  }
  return entries;
}

/**
 * Load `.waffle/waffle.yaml` with the gitignored local overlay merged over it, falling back
 * to the legacy root `.waffle.*` — and then pre-0.6.0 `.wafflestack.*` — names when the
 * current ones are absent. Deprecation notes for any legacy read are pushed onto `notes`
 * (when provided) for the caller to surface.
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
