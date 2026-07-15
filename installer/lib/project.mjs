// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
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
// The gitignored twin of the lock (#317): the frozen-image bookkeeping for the EFFECTIVE render
// (canonical + local overlay) actually on disk — which files this machine wrote and their hashes —
// since `LOCK_FILE` records the shared CANONICAL render. Written only when the overlay moves a byte,
// removed when it stops; account-specific, so never committed (`recommendedGitignoreEntries` offers it).
export const LOCAL_LOCK_FILE = '.waffle/waffle.local.lock.json';
export const EXTENSIONS_DIR = path.join('.waffle', 'extensions');

// Legacy (0.6.0–0.7.x) repo-root dot-paths (#17), moved into `.waffle/` by 0.8.0 (#43); still read
// as a fallback, migrated forward by a plain `render`/`upgrade`.
export const LEGACY_ROOT_CONFIG_FILE = '.waffle.yaml';
export const LEGACY_ROOT_LOCAL_CONFIG_FILE = '.waffle.local.yaml';
export const LEGACY_ROOT_LOCK_FILE = '.waffle.lock.json';

// Legacy (pre-0.6.0) consumer dot-paths, read as a last fallback; `migrateLegacyDotfiles` chains
// them through the 0.6.0 rename (#17) all the way into `.waffle/` in one pass.
export const LEGACY_CONFIG_FILE = '.wafflestack.yaml';
export const LEGACY_LOCAL_CONFIG_FILE = '.wafflestack.local.yaml';
export const LEGACY_LOCK_FILE = '.wafflestack.lock.json';
export const LEGACY_EXTENSIONS_DIR = path.join('.wafflestack', 'extensions');

/** @type {Target[]} */
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'];

/**
 * Resolve a consumer dot-path under `cwd`, preferring the current `.waffle/` name but falling back
 * through `legacyNames` (newest first). Returns `{ file, legacy, note }` — `file` is the current name
 * when nothing exists (so "not found" errors name it), `note` a deprecation message to surface.
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
 * Move any legacy consumer dot-paths under `cwd` to their current `.waffle/` locations, in place.
 * Idempotent, oldest-generation-first so a pre-0.6.0 repo chains all the way into `.waffle/` in one
 * pass. Shared by the 0.6.0/0.8.0 migrations and the top of every `render`.
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
    // … then root `.waffle.*` → inside the `.waffle/` directory (#43); mkdir is recursive-safe.
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
 * Which legacy paths a repo's `.gitignore` still lists (stale root `.waffle.*` and pre-0.6.0
 * `.wafflestack.*` lines). The CLI never edits `.gitignore` unasked, so this just reminds; self-
 * clearing once the stale lines are gone.
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
 * Is `entry` named anywhere in the repo's `.gitignore`? A deliberately literal basename-substring
 * test (no glob semantics), which is the safe direction for its only caller: `render` reminding a
 * repo to ignore the local lock it wrote (#317). A warning, never a gate.
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
 * Idempotently append consumer-approved `.gitignore` entries — the one place the CLI writes
 * `.gitignore`, refining "never edits it" to "never edits it *unasked*". Append-only and non-
 * destructive (existing content verbatim, marker written once); creates the file when absent.
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
 * The exact inverse of `ensureGitignoreEntries` — strip the entries wafflestack offered, for
 * `uninstall` (#182). As literal as its twin: only a line EXACTLY equal to one of `entries` is
 * removed (no marker-to-blank heuristic — the marker doesn't bound the block). The marker goes only
 * when left labelling nothing; every other byte, including the file's EOL habit (CRLF stays CRLF), survives.
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
  // Rejoin with the terminator the file ACTUALLY uses: `split(/\r?\n/)` drops the `\r`, so a bare
  // `join('\n')` rewrote a CRLF `.gitignore` to LF — a whole-file diff in a file we don't own. The
  // FIRST terminator wins (the file's habit), not the majority (an append leaves LF the majority).
  const eol = text.match(/\r\n|\n/)?.[0] === '\r\n' ? '\r\n' : '\n';
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

  // Drop a marker now labelling an empty block (next line blank or EOF), plus the blank separator
  // above it. Marked and filtered in a second pass so an in-place splice can't shift indices mid-walk.
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

  const out = final.length ? final.join(eol) + (endsWithNewline ? eol : '') : '';
  fs.writeFileSync(gi, out);
  return removed;
}

/**
 * The `.gitignore` entries wafflestack recommends for a `project` — the baseline behind `--gitignore`
 * and the setup playbook: always the local overlay and its derivative local lock, plus the resolved
 * `git.worktreesDir` when a stack declares it. Ignoring rendered output is a separate case-by-case
 * opt-in that pairs with `doctor --allow-missing` (presence, never integrity). See `docs/gitignore.md`.
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
 * In-place rename of a legacy `bundles:` key to `stacks:` on a parsed YAML Document (#59); mutating
 * the key scalar preserves its value node and comments. Idempotent (false when nothing to rename).
 * `doc` stays `any` — the code walks the raw CST-ish `contents.items` list, `?.`-guarding every hop.
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
 * BYTE-VERBATIM update of an EXISTING scalar at `keyPath` in a YAML file's raw TEXT — the value-side
 * twin of `renameLegacyStacksKey`, and the only sanctioned write to `.waffle/waffle.yaml`. It never
 * CREATES anything and splices only the scalar's own bytes, because `doc.setIn` would reflow the whole
 * file and create a pin the consumer never chose (#372; #386 F2 — creation, not comment-loss, is why).
 * Quoting style survives; a block scalar that can't splice safely falls back to a full re-serialize.
 *
 * @param {string} source the raw text of a YAML file
 * @param {(string|number)[]} keyPath e.g. `['config', 'doctor', 'toolkitRef']`
 * @param {string} value
 * @returns {string|null} the rewritten text, or null when not one byte may change
 */
export function setScalarIn(source, keyPath, value) {
  const doc = YAML.parseDocument(source);
  if (doc.errors?.length) return null; // a config that does not parse is not one we may half-write
  const node = doc.getIn(keyPath, true);
  // Duck-typed, exactly like `renameLegacyStacksKey`: a Scalar carries `value`; a YAMLMap/YAMLSeq
  // carries `items` (and would be a config shape we must not flatten into a string).
  if (!node || typeof node !== 'object' || !('value' in node) || 'items' in node) return null;
  if (node.value === value) return null;

  const spliced = spliceScalar(source, node, keyPath, value);
  if (spliced !== null) return spliced;

  node.value = value; // the fallback: the right value, in a file the serializer has reflowed
  return doc.toString();
}

/**
 * Replace ONLY `node`'s own source bytes with `value` in its existing scalar style, proving the result
 * re-parses to that value at that path (null when it can't — the caller re-serializes). `node.range`'s
 * `valueEnd` ends the token before any trailing comment, so the splice can't touch a comment or line.
 *
 * @param {string} source
 * @param {any} node the live Scalar at `keyPath`
 * @param {(string|number)[]} keyPath
 * @param {string} value
 * @returns {string|null}
 */
function spliceScalar(source, node, keyPath, value) {
  const [start, valueEnd] = node.range ?? [];
  if (typeof start !== 'number' || typeof valueEnd !== 'number') return null;
  // `yaml` re-quotes when the style can't hold the value (a `PLAIN` `yes`) — a quote we then WANT.
  const token = YAML.stringify(value, { defaultStringType: node.type, lineWidth: 0 }).trimEnd();
  const next = `${source.slice(0, start)}${token}${source.slice(valueEnd)}`;
  // RE-PARSING IS THE PROOF, and the ONE gate: a block scalar's multi-line token trips it and falls
  // back to a re-serialize. Deliberately NO cheap pre-check — it would reject exactly these inputs and
  // could never fail alone, the branch-that-cannot-fail defect #386 exists to remove.
  const check = YAML.parseDocument(next);
  return !check.errors?.length && check.getIn(keyPath) === value ? next : null;
}

/**
 * Load `.waffle/waffle.yaml` with the gitignored local overlay merged over it, falling back through
 * the legacy names; legacy reads push deprecation notes onto `notes`. `{ canonical: true }` skips the
 * overlay (#317) — committed inputs only, the render the shared lock records. See the render docblock.
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

  // Raw and unvalidated (parsed YAML); the `bad` check below is what proves it a Target[].
  /** @type {any[]} */
  const targets = cfg.targets ?? VALID_TARGETS;
  const bad = targets.filter((t) => !VALID_TARGETS.includes(t));
  if (bad.length) {
    throw new Error(`invalid targets in ${CONFIG_FILE}: ${bad.join(', ')} (valid: ${VALID_TARGETS.join(', ')})`);
  }

  // The consumer `bundles:` key was renamed to `stacks:` in 0.10.0 (#59); read the legacy key as a
  // fallback (`stacks:` wins), pushing a deprecation note pointing at `wafflestack upgrade`.
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

  // A `stacks:` entry is either a bare built-in name or a `{ name, source, ref }` external source
  // (#88); split and validate here, `render` resolves each via `loadToolkitWithSources`.
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

// Keys a `{ name, source, ref }` external stack entry may carry; an unknown key is rejected (typo-catch).
const STACK_ENTRY_KEYS = new Set(['name', 'source', 'ref']);

/**
 * Classify an external stack `source:` as a `'git'` URL (scheme, scp-style `user@host:…`, or a
 * trailing `.git`) or a local `'path'`. Records the classification only — nothing is fetched yet.
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
 * Normalize a raw `stacks:` list into built-in names plus external `{ name, source, ref }` sources,
 * failing loudly on a malformed entry (#88): a git source must be pinned with `ref`, a local path must
 * not. Stack names must be unique across all entries; `render` resolves each via `loadToolkitWithSources`.
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
 * Reserved `harness.*` template values, resolved per output target. Not declared in any stack; a
 * project may override any sub-key via `config.harness.<sub>`. Typed as the precise per-key shape
 * INTERSECTED with a string index signature so both keyed and `[sub]` access stay typed.
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
  // Where rendered skills live from that target's POV, for path-referencing content.
  skillsDir: { claude: '.claude/skills', codex: '.agents/skills', 'agents-dir': '.agents/skills' },
  // Where rendered agent definitions live from that target's POV. codex points at `.agents/agents`,
  // NOT the `.codex/agents/<name>.toml` it emits (#156): the TOML carries no `identity`, and keeping
  // codex/agents-dir in lockstep lets `renderSkill` dedupe their shared `.agents/skills` output.
  agentsDir: { claude: '.claude/agents', codex: '.agents/agents', 'agents-dir': '.agents/agents' },
  // CI workflow dispatcher (#131): the default identity spliced into rendered GitHub-workflow
  // `uses:`/`with:` lines, overridable via `config.harness.*` without ejecting. Target-independent
  // scalars; the values reproduce today's pinned action byte-for-byte so `doctor` stays clean.
  actionRef: 'anthropics/claude-code-action',
  actionVersion: '6c0083bb7289c31716797a039b6367b3079cc46e # v1.0.162',
  apiKeySecret: 'ANTHROPIC_API_KEY',
};

/**
 * Injection-guard patterns for reserved `harness.*` keys rendering into CI workflows (#131) or agent
 * instructions (#156): reject `${{`, quotes, newlines. Enforced at render and checked by `validate`.
 * Keyed by sub-key; a `harness.<sub>` with no entry is unguarded.
 *
 * @type {Record<string, string>} sub-key → anchored regex source
 */
export const HARNESS_PATTERNS = {
  // Relative repo paths spliced into content an agent executes against: no spaces, quotes, `${{`, or `..`.
  agentsDir: '^[A-Za-z0-9._/-]+$',
  skillsDir: '^[A-Za-z0-9._/-]+$',
  // `owner/repo[/path]` slug spliced bare into `uses:`: strict, no `@`/`${{`/quotes.
  actionRef: '^[A-Za-z0-9._/-]+$',
  // Git ref + preserved `# vX.Y.Z` comment after the `@`: no `${{`/quotes; `#`/spaces allowed.
  actionVersion: "^(?!.*\\$\\{\\{)[^'\"\\r\\n]*$",
  // Secret name inside `${{ secrets.<NAME> }}`: a GitHub identifier, so it can't close/inject.
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
        // Built-ins are usually a per-target map (Claude vs Codex); a target-independent value
        // (the CI dispatcher pin) is a plain scalar applying to every target.
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
