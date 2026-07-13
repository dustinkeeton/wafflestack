// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { readYaml, deepMerge, exists, lookupPath } from './util.mjs';

/** @import { Toolkit, Stack } from './toolkit.mjs' */

/**
 * @typedef {'claude' | 'codex' | 'agents-dir'} Target an enabled output harness
 *
 * @typedef {object} ExternalStackEntry a `{ name, source, ref }` entry from `stacks:` (#88)
 * @property {string} name the stack name, unique across ALL sources
 * @property {string} source a git URL or a local filesystem path
 * @property {'git' | 'path'} sourceType classified by `classifyStackSource`
 * @property {string | null} ref pinned tag/branch/commit; always null for a local path
 *
 * @typedef {object} ProjectConfig the loaded `.waffle/waffle.yaml` (+ local overlay)
 * @property {Target[]} targets
 * @property {string[]} stacks built-in stack names
 * @property {ExternalStackEntry[]} externalStacks
 * @property {string[]} include item refs to install with their dependency closure
 * @property {Record<string, any>} values the `config:` block — parsed YAML, so `any`-valued
 * @property {string[]} eject item refs released to project ownership
 *
 * @typedef {object} ResolvedDotPath
 * @property {string} file absolute path to read (the CURRENT name when nothing exists)
 * @property {boolean} legacy true when a fallback (older layout) was found
 * @property {string | null} note a one-line deprecation message to surface, else null
 */

// Canonical consumer paths — everything wafflestack keeps in a consumer repo lives inside
// the one `.waffle/` directory (config, local overlay, lock, extensions) as of 0.8.0 (#43).
export const CONFIG_FILE = '.waffle/waffle.yaml';
export const LOCAL_CONFIG_FILE = '.waffle/waffle.local.yaml';
export const LOCK_FILE = '.waffle/waffle.lock.json';
// The gitignored twin of the lock (#317). `LOCK_FILE` records the CANONICAL render — the one
// the committed inputs produce, identical on every machine — so it can be committed without
// carrying a developer's private overlay values into shared state. But the bytes actually on
// disk are the EFFECTIVE render (canonical + the local overlay), and the frozen-image
// bookkeeping needs a truthful record of *those*: which files this machine wrote (to prune
// and to not clobber), and what they hashed to (so `doctor` still catches a hand-edit).
// That is this file. Written only when the overlay actually changes an output byte, removed
// again when it stops; account-specific by construction, so — like the overlay itself — it
// must never be committed (`recommendedGitignoreEntries` offers it).
export const LOCAL_LOCK_FILE = '.waffle/waffle.local.lock.json';
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

/** @type {Target[]} */
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'];

/**
 * Resolve a consumer dot-path under `cwd`, preferring the current `.waffle/` name but
 * falling back through `legacyNames` (ordered newest generation first) when only an older
 * layout is present. Returns `{ file, legacy, note }` — `file` is the absolute path to read
 * (the current name when nothing exists, so "not found" errors name the current file),
 * `legacy` flags a fallback, and `note` is a one-line deprecation message the caller can
 * surface, naming the legacy path found and how to migrate it.
 *
 * @param {string} cwd
 * @param {string} currentName
 * @param {string[]} legacyNames ordered newest generation first
 * @returns {ResolvedDotPath}
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

/** @type {(cwd: string) => ResolvedDotPath} */
export const resolveConfigFile = (cwd) =>
  resolveDotPath(cwd, CONFIG_FILE, [LEGACY_ROOT_CONFIG_FILE, LEGACY_CONFIG_FILE]);
/** @type {(cwd: string) => ResolvedDotPath} */
export const resolveLocalConfigFile = (cwd) =>
  resolveDotPath(cwd, LOCAL_CONFIG_FILE, [LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE]);
/** @type {(cwd: string) => ResolvedDotPath} */
export const resolveLockFile = (cwd) =>
  resolveDotPath(cwd, LOCK_FILE, [LEGACY_ROOT_LOCK_FILE, LEGACY_LOCK_FILE]);
/**
 * The local lock (#317) has no legacy generations — it was born inside `.waffle/` — so it needs
 * no fallback chain, just its absolute path.
 *
 * @param {string} cwd
 * @returns {string}
 */
export const localLockPath = (cwd) => path.join(cwd, LOCAL_LOCK_FILE);

/**
 * Move any legacy consumer dot-paths under `cwd` to their current `.waffle/` locations, in
 * place. Idempotent: a path moves only when the older name exists and the newer one does
 * not, so re-running on an already-migrated or fresh repo is a harmless no-op. The pairs
 * are ordered oldest generation first so a pre-0.6.0 repo chains `.wafflestack.*` →
 * `.waffle.*` → `.waffle/waffle.*` in a single pass. Returns the `{ from, to }` renames
 * performed (for reporting). This is the shared body of the 0.6.0 and 0.8.0 migrations and
 * also runs at the top of every `render`, so a plain re-render carries a legacy repo
 * across too.
 *
 * @param {string} cwd
 * @returns {{ from: string, to: string }[]} the renames performed (for reporting)
 */
export function migrateLegacyDotfiles(cwd) {
  /** @type {{ from: string, to: string }[]} */
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
 *
 * @param {string} cwd
 * @returns {string[]}
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

/**
 * Is `entry` named anywhere in the repo's `.gitignore`? A deliberately literal test — it matches
 * the entry's basename as a substring and does not evaluate glob semantics, so a repo that ignores
 * the file by pattern rather than by name reads as "not ignored".
 *
 * That is the safe direction for its only caller. `render` uses it to *remind* a repo to ignore the
 * local lock it just wrote (#317): an un-ignored `.waffle/waffle.local.lock.json` is the very
 * propagation the canonical lock exists to prevent, one file over — commit it and every teammate's
 * `doctor` starts comparing their tree against YOUR machine's hashes. A stray reminder costs a line
 * of noise; a missed one costs the invariant. It is a warning, never a gate.
 *
 * @param {string} cwd
 * @param {string} entry a `.gitignore`-able repo-relative path
 * @returns {boolean}
 */
export function gitignoreMentions(cwd, entry) {
  const gi = path.join(cwd, '.gitignore');
  if (!exists(gi)) return false;
  return fs.readFileSync(gi, 'utf8').includes(path.basename(entry));
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
 *
 * @param {string} cwd
 * @param {Iterable<string>} entries
 * @returns {string[]} the entries actually added
 */
export function ensureGitignoreEntries(cwd, entries) {
  const gi = path.join(cwd, '.gitignore');
  const existing = exists(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  /** @type {string[]} */
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
 * The exact inverse of `ensureGitignoreEntries` — strip the entries wafflestack itself offered,
 * for `uninstall` (#182). Deliberately as literal as its twin, and for the same reason: this
 * function edits a file the toolkit does not own.
 *
 * Only a line whose trimmed text EXACTLY equals one of `entries` is removed. There is no
 * "delete from the marker to the next blank line" heuristic, because the marker does not in fact
 * bound the block: `ensureGitignoreEntries` appends later batches at EOF, and any line the
 * consumer wrote afterwards lands inside that span too. Eating it would be the one unrecoverable
 * mistake an uninstall can make in a file it did not write.
 *
 * The `# wafflestack` marker is removed only when it has been left labelling nothing — i.e. the
 * next line is blank or end-of-file — together with the blank separator line its twin wrote above
 * it. A marker that still has lines under it (a stale entry from a stack no longer enabled, a
 * consumer line appended below) keeps them company and survives. Every other byte of the file is
 * preserved verbatim, including the original trailing-newline habit.
 *
 * Returns the entries actually removed; [] when none were present (idempotent, so a second
 * `uninstall` is a clean no-op rather than an error).
 *
 * @param {string} cwd
 * @param {Iterable<string>} entries
 * @returns {string[]} the entries actually removed
 */
export function removeGitignoreEntries(cwd, entries) {
  const gi = path.join(cwd, '.gitignore');
  if (!exists(gi)) return [];
  /** @type {Set<string>} */
  const targets = new Set();
  for (const raw of entries) {
    const entry = String(raw).trim();
    if (entry) targets.add(entry);
  }
  if (!targets.size) return [];

  const text = fs.readFileSync(gi, 'utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  // `split` leaves a trailing '' for a newline-terminated file; drop it so it cannot be mistaken
  // for a blank line, and restore the habit on the way out.
  if (endsWithNewline) lines.pop();

  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const kept = [];
  for (const line of lines) {
    if (targets.has(line.trim())) removed.push(line.trim());
    else kept.push(line);
  }
  if (!removed.length) return [];

  // Drop a marker that now labels an empty block (next line is blank, or end-of-file), plus the
  // blank separator line its twin wrote above it. Marking indices and filtering in a second pass,
  // rather than splicing in place: an in-place splice of two lines shifts every index after it,
  // and the walk would then read past the end of its own array.
  /** @type {Set<number>} */
  const orphaned = new Set();
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].trim() !== GITIGNORE_MARKER) continue;
    const next = kept[i + 1];
    if (next !== undefined && next.trim() !== '') continue; // still labelling something — keep it
    orphaned.add(i);
    if (i > 0 && kept[i - 1].trim() === '') orphaned.add(i - 1);
  }
  const final = kept.filter((_, i) => !orphaned.has(i));

  const out = final.length ? final.join('\n') + (endsWithNewline ? '\n' : '') : '';
  fs.writeFileSync(gi, out);
  return removed;
}

/**
 * The `.gitignore` entries wafflestack recommends for a loaded `project` — the baseline offer
 * behind the `--gitignore` flag and the setup playbook. Always the local overlay
 * (`.waffle/waffle.local.yaml`, account-specific config that must never be committed) and its
 * derivative the local lock (`.waffle/waffle.local.lock.json` — this machine's render, written
 * only when the overlay changes an output byte; see LOCAL_LOCK_FILE), plus the resolved
 * `git.worktreesDir` (throwaway working state) when an enabled stack declares that key.
 * Gitignoring the rendered output is a separate opt-in the agent proposes case by
 * case, not part of this baseline — and the render and the lock are two decisions, not one.
 * Ignoring a subset of renders pairs with `doctor --allow-missing`, which relaxes *presence*
 * and never *integrity*, so the gate keeps full strength on what remains; ignoring every
 * render makes `doctor` vacuous (nothing present to check) and the gate becomes
 * `doctor --allow-missing --verify-render`. Gitignoring `.waffle/waffle.lock.json` itself is
 * not an `--allow-missing` pairing at all: a missing lock fails `doctor` before the flag is
 * read (`doctor.mjs`), so that posture simply has no CI drift gate. See `docs/gitignore.md`.
 *
 * @param {Toolkit} toolkit
 * @param {ProjectConfig} project
 * @returns {string[]}
 */
export function recommendedGitignoreEntries(toolkit, project) {
  const entries = [LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE];
  for (const name of project.stacks ?? []) {
    const stack = toolkit.stacks.get(name);
    if (!stack || !('git.worktreesDir' in stack.config)) continue;
    const resolve = makeResolver(stack, project.values ?? {}, project.targets?.[0] ?? 'claude');
    const dir = resolve('git.worktreesDir');
    if (dir) {
      const normalized = `${String(dir).replace(/\/+$/, '')}/`; // dir-only match, no double slash
      if (!entries.includes(normalized)) entries.push(normalized);
    }
    break; // stacks share the one key; a single worktrees dir is enough
  }
  return entries;
}

/**
 * In-place rename of a legacy `bundles:` key to `stacks:` on a parsed YAML Document (the
 * 0.10.0 consumer-config key rename, #59). Mutating the key scalar's value preserves the
 * value node and every attached comment — unlike delete+set, which would drop them. Shared
 * by the 0.10.0 migration and `installRefs` so a plain install and an `upgrade` converge.
 * Idempotent: a no-op returning false when `stacks:` already exists or no `bundles:` pair is
 * present; returns true when it renamed the key.
 *
 * `doc` stays `any` rather than `import('yaml').Document`: the code walks the raw CST-ish
 * `contents.items` pair list, which is not on the public `Node` union, and it already guards
 * every hop with `?.`. Narrowing here would buy nothing but casts.
 *
 * @param {any} doc a parsed YAML Document (from `YAML.parseDocument`)
 * @returns {boolean} true when it renamed the key
 */
export function renameLegacyStacksKey(doc) {
  if (doc.has('stacks') || !doc.has('bundles')) return false;
  const pair = doc.contents?.items?.find((/** @type {any} */ p) => (p.key?.value ?? String(p.key)) === 'bundles');
  if (!pair) return false;
  pair.key.value = 'stacks';
  return true;
}

/**
 * Load `.waffle/waffle.yaml` with the gitignored local overlay merged over it, falling back
 * to the legacy root `.waffle.*` — and then pre-0.6.0 `.wafflestack.*` — names when the
 * current ones are absent. Deprecation notes for any legacy read are pushed onto `notes`
 * (when provided) for the caller to surface.
 *
 * `{ canonical: true }` loads the CANONICAL config instead: committed inputs only, the local
 * overlay deliberately not merged (#317). The overlay is a developer's private tooling — it is
 * gitignored, it differs per machine, and it must never reach a teammate or CI. The lock is
 * shared state, so it records the render the *committed* inputs produce; that render is what
 * this mode loads. `render` calls it for the lock and the ordinary (effective) mode for the
 * bytes it writes to disk, so each developer's tree carries their own overlay values while
 * everyone's committed lock stays byte-identical.
 *
 * @param {string} cwd
 * @param {string[]} [notes] collects deprecation notes for the caller to surface
 * @param {{ canonical?: boolean }} [options] `canonical` skips the local overlay entirely
 * @returns {ProjectConfig}
 */
export function loadProjectConfig(cwd, notes = [], { canonical = false } = {}) {
  const cfgPath = resolveConfigFile(cwd);
  if (!exists(cfgPath.file)) {
    throw new Error(`${CONFIG_FILE} not found in ${cwd} — run \`wafflestack init\` first`);
  }
  if (cfgPath.legacy) notes.push(cfgPath.note);
  let cfg = readYaml(cfgPath.file) ?? {};
  const localPath = resolveLocalConfigFile(cwd);
  if (!canonical && exists(localPath.file)) {
    if (localPath.legacy) notes.push(localPath.note);
    cfg = deepMerge(cfg, readYaml(localPath.file) ?? {});
  }

  // Raw and unvalidated (it is parsed YAML) — the `bad` check on the next line is what actually
  // proves it is a Target[], so it is typed loosely here rather than asserted to be one.
  /** @type {any[]} */
  const targets = cfg.targets ?? VALID_TARGETS;
  const bad = targets.filter((t) => !VALID_TARGETS.includes(t));
  if (bad.length) {
    throw new Error(`invalid targets in ${CONFIG_FILE}: ${bad.join(', ')} (valid: ${VALID_TARGETS.join(', ')})`);
  }

  // The consumer `bundles:` key was renamed to `stacks:` in 0.10.0 (#59). Read the legacy key
  // as a fallback so a repo that has not re-rendered keeps working; `stacks:` wins when both
  // are present. Either legacy read pushes a deprecation note onto `notes` (surfaced as a
  // render warning), pointing at `wafflestack upgrade` which renames the key in place.
  let rawStacks;
  if (cfg.stacks !== undefined) {
    rawStacks = cfg.stacks;
    if (cfg.bundles !== undefined) {
      notes.push(
        `both \`stacks:\` and the legacy \`bundles:\` key are set in ${CONFIG_FILE} — using \`stacks:\`; the \`bundles:\` key is ignored (remove it)`,
      );
    }
  } else if (cfg.bundles !== undefined) {
    rawStacks = cfg.bundles;
    notes.push(
      `legacy \`bundles:\` key in ${CONFIG_FILE} is deprecated — run \`wafflestack upgrade\` to rename it to \`stacks:\``,
    );
  } else {
    rawStacks = [];
  }

  // A `stacks:` entry is either a bare name (a built-in toolkit stack, unchanged) or a
  // `{ name, source, ref }` mapping declaring an external source (#88). Split and validate the
  // two shapes here; `render` resolves each external source to a toolkit root and merges its
  // named stack via `loadToolkitWithSources`.
  const { stacks, externalStacks } = normalizeStackEntries(rawStacks);

  return {
    targets,
    stacks,
    externalStacks,
    include: cfg.include ?? [],
    values: cfg.config ?? {},
    eject: cfg.eject ?? [],
  };
}

// Keys a `{ name, source, ref }` external stack entry may carry. An unknown key is rejected
// (catches a `pin:`/`rev:` typo instead of silently ignoring the pin).
const STACK_ENTRY_KEYS = new Set(['name', 'source', 'ref']);

/**
 * Classify an external stack `source:` string as a `'git'` URL or a local `'path'`. Git when it
 * carries a URL scheme (`https://`, `http://`, `git://`, `ssh://`, …), an scp-style
 * `user@host:owner/repo` address, or a trailing `.git`; anything else (relative or absolute
 * filesystem path) is a local path. Slice 1 only records the classification — nothing is
 * fetched or resolved yet.
 *
 * @param {string} source
 * @returns {'git' | 'path'}
 */
export function classifyStackSource(source) {
  const s = String(source).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return 'git'; // scheme://host/…
  if (/^[^/@\s]+@[^/@\s]+:/.test(s)) return 'git'; // git@host:owner/repo(.git)
  if (/\.git\/?$/.test(s)) return 'git'; // …/repo.git
  return 'path';
}

/**
 * Normalize a raw `stacks:` list into built-in stack names plus external source declarations,
 * validating the shape and failing loudly on a malformed entry (#88, slice 1). Each list item
 * is either:
 *   - a bare string — a built-in toolkit stack (unchanged); or
 *   - a `{ name, source, ref }` mapping — an external source, where `source` is a git URL or a
 *     local path. A git source must be pinned with `ref` (tag/branch/commit) for reproducible
 *     installs; a local-path source must NOT carry a `ref` (it is used as-is).
 *
 * Returns `{ stacks: [name…], externalStacks: [{ name, source, sourceType, ref }] }`. A stack
 * name must be unique across every entry (built-in and external alike) — a collision is an
 * error, not a silent shadow. External sources validate here; `render` then resolves each to a
 * toolkit root and merges its named stack (`loadToolkitWithSources`), where a name that collides
 * with a built-in or another source is likewise a hard error (see #88).
 *
 * @param {any} raw the raw `stacks:` value as parsed from YAML
 * @returns {{ stacks: string[], externalStacks: ExternalStackEntry[] }}
 */
export function normalizeStackEntries(raw) {
  if (raw === undefined || raw === null) return { stacks: [], externalStacks: [] };
  if (!Array.isArray(raw)) {
    throw new Error(
      `\`stacks:\` in ${CONFIG_FILE} must be a list of stack names or { name, source } mappings`,
    );
  }
  /** @type {string[]} */
  const stacks = [];
  /** @type {ExternalStackEntry[]} */
  const externalStacks = [];
  /** @type {Map<string, number>} */
  const seen = new Map(); // stack name -> 1-based entry position, for collision reporting

  raw.forEach((entry, i) => {
    const pos = i + 1;
    let name;
    if (typeof entry === 'string') {
      name = entry.trim();
      if (!name) throw new Error(`stack entry #${pos} in ${CONFIG_FILE} is empty — give it a stack name`);
      stacks.push(name);
    } else if (isPlainObject(entry)) {
      name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name) {
        throw new Error(
          `stack entry #${pos} in ${CONFIG_FILE} is a mapping without a \`name:\` — an external source needs \`{ name, source }\``,
        );
      }
      const unknown = Object.keys(entry).filter((k) => !STACK_ENTRY_KEYS.has(k));
      if (unknown.length) {
        throw new Error(
          `external stack "${name}" in ${CONFIG_FILE} has unknown key(s) ${unknown.join(', ')} — allowed: ${[...STACK_ENTRY_KEYS].join(', ')}`,
        );
      }
      if (typeof entry.source !== 'string' || !entry.source.trim()) {
        throw new Error(
          `external stack "${name}" in ${CONFIG_FILE} must declare a non-empty \`source:\` (a git URL or a local path)`,
        );
      }
      const source = entry.source.trim();
      const sourceType = classifyStackSource(source);

      let ref;
      if (entry.ref !== undefined) {
        if (typeof entry.ref !== 'string' || !entry.ref.trim()) {
          throw new Error(
            `external stack "${name}" in ${CONFIG_FILE} has an empty \`ref:\` — pin it to a tag, branch, or commit, or remove it`,
          );
        }
        ref = entry.ref.trim();
      }
      if (sourceType === 'git') {
        if (!ref) {
          throw new Error(
            `external stack "${name}" in ${CONFIG_FILE} has a git \`source:\` (${source}) but no \`ref:\` — pin it to a tag, branch, or commit for reproducible installs`,
          );
        }
      } else if (ref !== undefined) {
        throw new Error(
          `external stack "${name}" in ${CONFIG_FILE} has a local-path \`source:\` (${source}); \`ref:\` is only valid for a git source — remove it`,
        );
      }
      externalStacks.push({ name, source, sourceType, ref: ref ?? null });
    } else {
      throw new Error(
        `stack entry #${pos} in ${CONFIG_FILE} must be a stack name or a { name, source } mapping (got ${entry === null ? 'null' : typeof entry})`,
      );
    }

    // A name must appear once across ALL entries — built-in or external — so an external source
    // can't silently shadow a built-in (or another source) of the same name.
    if (seen.has(name)) {
      throw new Error(
        `stack "${name}" in ${CONFIG_FILE} is declared more than once (entries #${seen.get(name)} and #${pos}) — each stack name must be unique across all sources`,
      );
    }
    seen.set(name, pos);
  });

  return { stacks, externalStacks };
}

/**
 * Reserved `harness.*` template values, resolved per output target. Not declared in
 * any stack — always available. A project may override any sub-key via
 * `config.harness.<sub>` (a scalar applied to every target, or a per-target map).
 *
 * Typed as the precise per-key shape INTERSECTED with a string index signature: callers reach
 * for both (`HARNESS_BUILTINS.agentsDir` — a per-target map worth keeping precise — and
 * `HARNESS_BUILTINS[sub]` in `makeResolver`/`validate`, where `sub` is an arbitrary string).
 * The intersection serves both without widening the per-target maps to `any`.
 *
 * @type {{
 *   assistantName: Record<Target, string>,
 *   attributionPath: Record<Target, string>,
 *   skillsDir: Record<Target, string>,
 *   agentsDir: Record<Target, string>,
 *   actionRef: string,
 *   actionVersion: string,
 *   apiKeySecret: string,
 * } & Record<string, string | Record<string, string>>}
 */
export const HARNESS_BUILTINS = {
  assistantName: { claude: 'Claude', codex: 'Codex', 'agents-dir': 'Codex' },
  attributionPath: { claude: 'claude-code', codex: 'Codex', 'agents-dir': 'Codex' },
  // Where rendered skills live from that target's point of view, for content that
  // references skill files by path ("read {{harness.skillsDir}}/x/SKILL.md").
  skillsDir: { claude: '.claude/skills', codex: '.agents/skills', 'agents-dir': '.agents/skills' },
  // Where rendered agent definitions live from that target's point of view, for content that
  // reads an agent's frontmatter by path (the delegate skill reads `identity.displayName`).
  //
  // codex points at `.agents/agents`, NOT the `.codex/agents/<name>.toml` its own renderAgent
  // branch emits, for two reasons (#156 review):
  //   1. The TOML carries no `identity` — `agentToml` drops it, there being no shape for it. A
  //      codex-only render therefore has NO file anywhere that answers `identity.displayName`,
  //      and the consuming rule's documented fallback (title-case the slug) is the honest answer.
  //      Naming `.codex/agents` would only point the reader at a `.md` that never exists.
  //   2. `renderSkill` dedupes the shared `.agents/skills/<name>` output across codex and
  //      agents-dir on the premise that their `harness.*` built-ins are IDENTICAL — one shared
  //      file, one unambiguous render. A divergent `agentsDir` would make that file's content
  //      depend on which *other* targets happen to be enabled. Keep the two in lockstep.
  // So: codex + agents-dir → the path exists and carries the field; codex alone → the path is
  // absent and the fallback fires, explicitly rather than by accident.
  agentsDir: { claude: '.claude/agents', codex: '.agents/agents', 'agents-dir': '.agents/agents' },
  // CI workflow dispatcher (#131). The rendered GitHub-workflow files splice one pinned
  // action into their `uses:` / `with:` lines; these built-ins are its default identity, so a
  // consumer can pin a different version, repoint the ref, or rename the API-key secret via
  // `config.harness.*` WITHOUT ejecting the workflow. Target-independent (the same action
  // drives every harness), hence plain scalars rather than per-target maps. The values must
  // reproduce today's pinned action byte-for-byte so `doctor` stays clean for an unconfigured
  // repo; the injection guards below keep an override from corrupting the workflow.
  actionRef: 'anthropics/claude-code-action',
  actionVersion: '6c0083bb7289c31716797a039b6367b3079cc46e # v1.0.162',
  apiKeySecret: 'ANTHROPIC_API_KEY',
};

/**
 * Injection-guard patterns for the reserved `harness.*` keys that render into CI workflow files
 * (#131) or into instructions an agent executes (#156) — the same discipline stack config
 * applies to its other workflow-spliced keys
 * (reject `${{`, quotes, newlines), but attached to the reserved namespace rather than a
 * stack's `config:`. Enforced at render (render.mjs seeds these into the pattern map so every
 * splice is validated) and checked by `validate` (the built-in defaults must satisfy them).
 * Keyed by sub-key; a `harness.<sub>` with no entry here is unguarded, as before.
 *
 * @type {Record<string, string>} sub-key → anchored regex source
 */
export const HARNESS_PATTERNS = {
  // Directory paths spliced into content an agent then *executes against* — `read
  // {{harness.agentsDir}}/<slug>.md` in the delegate skill's identity-derivation rule, and the
  // sibling `skillsDir` in skill-reference prose. Both are documented `config.harness.*`
  // consumer overrides, so guard them as relative repo paths: no spaces, quotes, `$`, `${{`,
  // backticks, `..`-smuggling shell metacharacters, or newlines.
  agentsDir: '^[A-Za-z0-9._/-]+$',
  skillsDir: '^[A-Za-z0-9._/-]+$',
  // `owner/repo[/path]` action slug spliced bare into `uses:`. Strict slug — no `@` (the
  // template supplies it), spaces, quotes, `#`, `${{`, or newlines that could mangle the
  // `uses:` line or inject an expression.
  actionRef: '^[A-Za-z0-9._/-]+$',
  // Git ref (SHA or tag) plus the preserved `# vX.Y.Z` comment, spliced into `uses:` after
  // the `@`. No `${{`, quotes, or newlines; `#`/spaces are allowed so the comment survives.
  actionVersion: "^(?!.*\\$\\{\\{)[^'\"\\r\\n]*$",
  // Secret name spliced INSIDE `${{ secrets.<NAME> }}` — restrict to a GitHub secret
  // identifier so a value can neither close that expression early nor inject another.
  apiKeySecret: '^[A-Za-z_][A-Za-z0-9_]*$',
};

/**
 * Resolver for a stack rendering to `target`:
 * - `harness.<sub>` — project override (scalar for all targets, or per-target map),
 *   falling back to the built-in for `target`.
 * - anything else — project config value, else the stack-declared default.
 *
 * @param {Stack} stack
 * @param {Record<string, any>} values the project `config:` values
 * @param {Target} target
 * @returns {(key: string) => any} resolves a template key to its value (undefined when unset)
 */
export function makeResolver(stack, values, target) {
  return (key) => {
    if (key.startsWith('harness.')) {
      const sub = key.slice('harness.'.length);
      const override = lookupPath(values, key);
      let v;
      if (override !== undefined) {
        v = isPlainObject(override) ? override[target] : override;
      }
      if (v === undefined) {
        // Built-ins are usually a per-target map (Claude vs Codex identity); a
        // target-independent value (e.g. the CI dispatcher pin) is a plain scalar that
        // applies to every target.
        const builtin = HARNESS_BUILTINS[sub];
        v = isPlainObject(builtin) ? builtin[target] : builtin;
      }
      return v;
    }
    const v = lookupPath(values, key);
    if (v !== undefined) return v;
    return stack.config[key]?.default;
  };
}

/**
 * @param {any} v
 * @returns {v is Record<string, any>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
