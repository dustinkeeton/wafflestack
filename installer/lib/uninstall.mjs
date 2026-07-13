// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { exists, sha256 } from './util.mjs';
import { readLocalLock, readTreeLock, renderProject } from './render.mjs';
import { init } from './eject.mjs';
import { loadToolkit } from './toolkit.mjs';
import {
  loadProjectConfig,
  recommendedGitignoreEntries,
  removeGitignoreEntries,
  resolveConfigFile,
  resolveLocalConfigFile,
  resolveLockFile,
  localLockPath,
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  LOCAL_LOCK_FILE,
  LOCK_FILE,
  EXTENSIONS_DIR,
} from './project.mjs';

/**
 * `uninstall` / `reinstall` (#182) — removing a wafflestack install from a consumer repo.
 *
 * THE SAFETY MODEL, in one sentence: a file is deleted if and only if the lock says wafflestack
 * wrote it AND its sha256 still equals what the lock recorded. Nothing else is ever deleted —
 * no globbing of `.claude/**`, no "looks generated" heuristics, no path the lock does not name.
 * This is the toolkit's only destructive command, and rendered output is commonly gitignored, so
 * a file it deletes wrongly may be the consumer's only copy. Hence:
 *
 *   - The lock is the sole source of truth for WHAT is ours (`files{}`: path → sha256).
 *   - The hash is the sole source of truth for whether it is still ours to delete. A DRIFTED file
 *     (present, hash differs) holds the consumer's own edit and is SKIPPED and reported, unless
 *     `--force`. An EJECTED file was deliberately released to the project and is invisible to the
 *     lock by construction — it stays, and we say so.
 *   - Absence is never an error: an already-gone file is simply nothing to do (idempotent).
 *   - It is a DRY RUN until `--yes`. The plan below is computed once and used for both the preview
 *     and the execution, so what you are shown cannot drift from what would be done.
 */

/** @typedef {'canonical' | 'local'} LockKind */

/**
 * @typedef {object} MetaTarget
 * @property {string} rel repo-relative path (posix separators, for display)
 * @property {string} abs absolute path
 * @property {'file' | 'dir'} type
 */

/**
 * @typedef {object} UninstallPlan
 * @property {LockKind | null} lock which lock answered — null when there is none (hard failure)
 * @property {string} lockFile the lock's repo-relative path, for messages
 * @property {string[]} remove managed paths present and matching their lock hash — safe to delete
 * @property {string[]} drifted managed paths present but hand-edited since they were rendered
 * @property {string[]} absent managed paths already gone — nothing to do
 * @property {string[]} refused lock keys that escape `cwd` (`../…`) — never touched, always loud
 * @property {MetaTarget[]} meta `.waffle/` config + lock state the flags say to remove
 * @property {string[]} prunedDirs directories left empty once `remove`/`meta` are gone
 * @property {string[]} gitignore `.gitignore` lines wafflestack offered and would strip
 * @property {string[]} ejected item refs the project owns — left in place, announced
 * @property {boolean} lockRetained the lock survives this run — so a `--force` re-run can still
 *   find the files we skipped. False means the lock goes, and skipped files become project-owned.
 * @property {string[]} notes
 */

/** posix-ise a path for display, so messages read the same on every platform. */
const posix = (/** @type {string} */ p) => p.split(path.sep).join('/');

/**
 * Resolve a lock key to an absolute path, refusing anything that escapes `cwd`.
 *
 * A lock is JSON on disk: a hand-edited or hostile one could name `../../.ssh/id_rsa`, and this
 * function is the only thing between that string and an `fs.rmSync`. Treat `../` as hostile and
 * return null rather than trusting the file we are about to obey.
 *
 * @param {string} cwd
 * @param {string} rel
 * @returns {string | null} the absolute path, or null when it is not strictly inside `cwd`
 */
function resolveInside(cwd, rel) {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel);
  return abs !== root && abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * Which directories are left empty once `removing` is gone — computed WITHOUT deleting anything,
 * by subtracting the pending removals from each parent's listing and walking upward.
 *
 * Shared by the dry run and the real run (which calls this before it deletes), which is the point:
 * the preview and the execution cannot disagree, because they are the same computation.
 *
 * Two separate inputs, and the distinction matters. `removing` is what will actually be deleted —
 * only these count as "gone" when testing a directory for emptiness. `candidates` is merely where
 * to START looking, and takes EVERY path the lock tracks: a skill dir the consumer had already
 * emptied by hand is an orphan we should still sweep (#182 names those empty dirs specifically),
 * and it will never appear under `removing` precisely because its file is already absent. Seeding
 * a walk from it cannot make a delete unsafe — the emptiness test below is the only thing that
 * authorises a prune, and a directory survives the moment it holds anything we are not removing.
 * So a `.claude/` still holding the consumer's `settings.json` or a `worktrees/` is never touched,
 * and a drifted file we chose to KEEP holds its own directory open. The walk is bounded strictly
 * below `cwd`: the repo root itself is never a prune candidate.
 *
 * @param {string} cwd
 * @param {string[]} removing absolute paths about to be removed — the only paths counted as gone
 * @param {string[]} candidates absolute paths whose parent dirs are worth testing
 * @returns {string[]} absolute directory paths, deepest first
 */
function planPrunedDirs(cwd, removing, candidates) {
  const root = path.resolve(cwd);
  const gone = new Set(removing.map((p) => path.resolve(p)));
  /** @type {Set<string>} */
  const pruned = new Set();
  const isGone = (/** @type {string} */ p) => gone.has(p) || pruned.has(p);

  const starts = [...new Set(candidates.map((p) => path.dirname(path.resolve(p))))].sort(
    (a, b) => b.length - a.length, // deepest first, so a parent sees its pruned children
  );
  for (const start of starts) {
    let dir = start;
    while (dir !== root && dir.startsWith(root + path.sep)) {
      if (!exists(dir)) {
        dir = path.dirname(dir);
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        break; // unreadable — leave it alone
      }
      const survivors = entries.map((e) => path.join(dir, e)).filter((e) => !isGone(e));
      if (survivors.length) break; // something the consumer owns lives here
      pruned.add(dir);
      dir = path.dirname(dir);
    }
  }
  return [...pruned].sort((a, b) => b.length - a.length);
}

/**
 * Classify every path the lock tracks, and everything else the uninstall would touch, WITHOUT
 * writing to disk. `uninstall` is this plan plus `fs` calls; the dry run is this plan plus
 * `console.log`.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string | null} [opts.toolkitRoot] needed only to compute the `.gitignore` offer
 * @param {boolean} [opts.force] drifted files will be deleted too — affects which dirs empty out
 * @param {boolean} [opts.keepConfig] preserve `.waffle/waffle.yaml`, the overlay, `extensions/`
 * @param {boolean} [opts.keepLock] preserve both lock files
 * @param {boolean} [opts.keepLockOnSkip] when drifted files are SKIPPED, keep the lock anyway so the
 *   `--force` re-run we advertise can still reach them (default true) — see `lockRetained` below
 * @returns {UninstallPlan}
 */
export function planUninstall({
  cwd,
  toolkitRoot = null,
  force = false,
  keepConfig = false,
  keepLock = false,
  keepLockOnSkip = true,
}) {
  /** @type {string[]} */
  const notes = [];

  // The lock that describes the files ON DISK — the local one when a `.waffle/waffle.local.yaml`
  // overlay shaped this machine's render, else the committed one (#317). NOT `readLock`: on an
  // overlay machine the canonical hashes do not describe the bytes on disk, so every file the
  // overlay touched would read as hand-edited and be skipped — an uninstall that silently removes
  // nothing. Exactly the lock `doctor` drift-checks against, for exactly the same reason.
  const tree = readTreeLock(cwd);
  if (!tree) {
    return {
      lock: null,
      lockFile: LOCK_FILE,
      remove: [], drifted: [], absent: [], refused: [], meta: [], prunedDirs: [], gitignore: [], ejected: [],
      lockRetained: false,
      notes,
    };
  }
  const local = readLocalLock(cwd) !== null;
  const lockFile = local ? LOCAL_LOCK_FILE : posix(path.relative(path.resolve(cwd), resolveLockFile(cwd).file));
  if (local) {
    notes.push(
      `${LOCAL_CONFIG_FILE} shaped this machine's render, so the files on disk were checked against ${LOCAL_LOCK_FILE} (this machine's render), not ${LOCK_FILE}`,
    );
  }

  // The .gitignore offer must be computed BEFORE anything is deleted: it reads the config we are
  // (possibly) about to remove. Degrade to the two entries every install is offered if the config
  // is unreadable — better a partial strip than a crash mid-uninstall.
  /** @type {string[]} */
  let gitignore = [];
  try {
    if (!toolkitRoot) throw new Error('no toolkit root');
    gitignore = recommendedGitignoreEntries(loadToolkit(toolkitRoot), loadProjectConfig(cwd));
  } catch {
    gitignore = [LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE];
    notes.push(`could not read ${CONFIG_FILE} to compute the full .gitignore offer — falling back to the baseline entries`);
  }

  /** @type {string[]} */
  const remove = [];
  /** @type {string[]} */
  const drifted = [];
  /** @type {string[]} */
  const absent = [];
  /** @type {string[]} */
  const refused = [];
  for (const [rel, hash] of Object.entries(tree.files ?? {})) {
    const abs = resolveInside(cwd, rel);
    if (!abs) {
      refused.push(rel);
      continue;
    }
    if (!exists(abs)) absent.push(rel);
    else if (sha256(fs.readFileSync(abs)) !== hash) drifted.push(rel); // the same compare doctor makes
    else remove.push(rel);
  }
  remove.sort();
  drifted.sort();
  absent.sort();

  // Ejected items are project-owned: `eject` drops their paths from `lock.files` while leaving the
  // files on disk, so an uninstall cannot see them — and must say so, or the consumer is left with
  // orphans they have no record of. (#182's documented edge case.)
  /** @type {string[]} */
  let ejected = [];
  try {
    ejected = loadProjectConfig(cwd).eject ?? [];
  } catch {
    ejected = [];
  }

  /** @type {MetaTarget[]} */
  const meta = [];
  const addMeta = (/** @type {string} */ abs, /** @type {'file' | 'dir'} */ type) => {
    if (!exists(abs)) return;
    meta.push({ rel: posix(path.relative(path.resolve(cwd), abs)), abs, type });
  };
  // THE LOCK OUTLIVES A SKIP. A drifted file we keep is still ours, and the lock is the ONLY record
  // saying so — `--force` re-reads it to find that file again. Deleting the lock in the very run
  // that skips a file therefore strands the file with no record it was ever wafflestack's (#182's
  // opening complaint: "leaves orphans… guessing which are wafflestack-managed and which they
  // authored") AND closes the one recovery path the skip message names: the advertised `--force`
  // re-run dies on `no .waffle/waffle.lock.json`. It bites the workflow the README recommends —
  // preview bare, then apply — hardest of all. So a skip means the uninstall is INCOMPLETE, and the
  // lock stays behind to say so.
  //
  // `keepLockOnSkip: false` opts out, and reinstall's `--clean` leg needs it to: there, a retained
  // lock would arm render's stale-prune (a lock-tracked path this render no longer produces is
  // deleted, with NO hash check — render.mjs) against the very hand-edited file we just kept. On
  // that path nothing can restore the file, so the lock goes and the file is announced as
  // project-owned instead — the promise is dropped rather than broken.
  const lockRetained = keepLock || (keepLockOnSkip && !force && drifted.length > 0);
  if (!lockRetained) {
    addMeta(resolveLockFile(cwd).file, 'file');
    addMeta(localLockPath(cwd), 'file');
  }
  if (!keepConfig) {
    addMeta(resolveConfigFile(cwd).file, 'file');
    addMeta(resolveLocalConfigFile(cwd).file, 'file');
    addMeta(path.join(cwd, EXTENSIONS_DIR), 'dir');
  }

  // What will actually go (drifted files only under --force) vs. where it is worth looking for a
  // dir left empty — which is every path the lock ever tracked, including the already-absent ones.
  const removing = [
    ...(force ? [...remove, ...drifted] : remove).map((rel) => path.join(cwd, rel)),
    ...meta.map((m) => m.abs),
  ];
  const candidates = [
    ...[...remove, ...drifted, ...absent].map((rel) => path.join(cwd, rel)),
    ...meta.map((m) => m.abs),
  ];
  const prunedDirs = planPrunedDirs(cwd, removing, candidates);

  return {
    lock: local ? 'local' : 'canonical',
    lockFile,
    remove, drifted, absent, refused, meta,
    prunedDirs: prunedDirs.map((d) => `${posix(path.relative(path.resolve(cwd), d))}/`),
    gitignore,
    ejected,
    lockRetained,
    notes,
  };
}

/**
 * @typedef {object} UninstallResult
 * @property {boolean} ok
 * @property {boolean} dryRun
 * @property {UninstallPlan} plan
 * @property {string[]} removed paths actually deleted (empty on a dry run)
 * @property {string[]} skipped drifted paths left in place
 * @property {string[]} errors
 */

/**
 * Remove a wafflestack install from `cwd`. A DRY RUN unless `dryRun: false` — the CLI passes
 * `dryRun: !--yes`, which makes the bare command a preview and `--yes` the consent. (The CLI is
 * deliberately non-interactive — see the `--interactive` note in cli.mjs — so there is no prompt
 * to answer; for the agent and CI callers that drive this toolkit a flag is strictly safer.)
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string | null} [opts.toolkitRoot]
 * @param {boolean} [opts.force] also delete drifted (hand-edited) files
 * @param {boolean} [opts.allowMissing] silence the per-file "already absent" lines
 * @param {boolean} [opts.keepConfig] preserve the config, overlay and `extensions/`
 * @param {boolean} [opts.keepLock] preserve both locks
 * @param {boolean} [opts.keepLockOnSkip] keep the lock when drifted files are skipped, so `--force`
 *   can still reach them (default true — see planUninstall)
 * @param {boolean} [opts.dryRun] report what would happen; touch nothing. DEFAULTS TRUE — see below
 * @param {(msg: string) => void} [opts.log]
 * @returns {UninstallResult}
 */
export function uninstall({
  cwd,
  toolkitRoot = null,
  force = false,
  allowMissing = false,
  keepConfig = false,
  keepLock = false,
  keepLockOnSkip = true,
  // Deleting is opt-in at the LIBRARY boundary too, not just behind the CLI's `--yes`. The usual
  // convention would be `dryRun = false` — an explicit call means do the thing — but this is the
  // one function in the toolkit that destroys consumer files, and the cost of the two defaults is
  // wildly asymmetric: forget the flag with `false` and a caller silently deletes someone's repo;
  // forget it with `true` and they get a report and a bug they notice immediately. The safe
  // default is the one that fails loudly. Both real callers pass it explicitly regardless.
  dryRun = true,
  log = () => {},
}) {
  const plan = planUninstall({ cwd, toolkitRoot, force, keepConfig, keepLock, keepLockOnSkip });

  // No lock, no uninstall. Without it we have no record of what is ours, and guessing is the one
  // thing this command must never do.
  if (!plan.lock) {
    return {
      ok: false,
      dryRun,
      plan,
      removed: [],
      skipped: [],
      errors: [
        `no ${LOCK_FILE} — nothing here is tracked as wafflestack-managed, so there is nothing safe to remove. Nothing was deleted.`,
      ],
    };
  }
  // A lock naming a path outside the repo is not a file to delete, it is a lock to distrust.
  if (plan.refused.length) {
    return {
      ok: false,
      dryRun,
      plan,
      removed: [],
      skipped: [],
      errors: [
        `${plan.lockFile} tracks ${plan.refused.length} path(s) outside the project directory: ${plan.refused.join(', ')} — refusing to touch anything. Nothing was deleted.`,
      ],
    };
  }

  const doomed = force ? [...plan.remove, ...plan.drifted].sort() : plan.remove;
  const skipped = force ? [] : plan.drifted;

  log(
    dryRun
      ? 'uninstall (dry run — nothing has been removed; re-run with --yes to apply)'
      : 'uninstall',
  );
  log(
    `${dryRun ? 'would remove' : 'removing'} ${doomed.length} managed file(s) tracked by ${plan.lockFile}`,
  );
  // Only promise the `--force` re-run on the path that can actually honour it — i.e. where the lock
  // survives to tell that run these files were ours. Where it does not (reinstall --clean), say the
  // true thing instead: they are the project's now.
  for (const rel of skipped) {
    log(
      plan.lockRetained
        ? `skipped (modified): ${rel} — hand-edited since it was rendered; re-run with --force to delete it`
        : `skipped (modified): ${rel} — hand-edited since it was rendered; left in place and now project-owned (delete it by hand)`,
    );
  }
  if (skipped.length && plan.lockRetained) {
    log(
      `${skipped.length} file(s) kept, so ${plan.lockFile} was kept too — it is the only record that they are wafflestack's. Re-run with --force to remove them and finish the uninstall.`,
    );
  }
  if (!allowMissing) {
    for (const rel of plan.absent) log(`absent (nothing to do): ${rel}`);
  }

  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const errors = [];

  if (!dryRun) {
    // The `exists()`-guarded rmSync of render's stale-prune loop: tolerant of an already-absent
    // path, loud about anything else.
    for (const rel of doomed) {
      const abs = resolveInside(cwd, rel);
      if (!abs) continue; // unreachable — refused above; belt and braces before an rmSync
      try {
        if (exists(abs)) fs.rmSync(abs);
        removed.push(rel);
      } catch (err) {
        errors.push(`failed to remove ${rel}: ${/** @type {Error} */ (err).message}`);
      }
    }
    for (const m of plan.meta) {
      try {
        if (exists(m.abs)) fs.rmSync(m.abs, m.type === 'dir' ? { recursive: true, force: true } : {});
        removed.push(m.rel);
      } catch (err) {
        errors.push(`failed to remove ${m.rel}: ${/** @type {Error} */ (err).message}`);
      }
    }
    // Directories, deepest first — and only ones the plan proved empty.
    for (const rel of plan.prunedDirs) {
      const abs = path.join(cwd, rel);
      try {
        if (exists(abs) && !fs.readdirSync(abs).length) fs.rmdirSync(abs);
      } catch (err) {
        errors.push(`failed to prune ${rel}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  if (plan.meta.length) {
    log(`${dryRun ? 'would remove' : 'removed'} ${plan.meta.map((m) => m.rel).join(', ')}`);
  }
  if (keepConfig) log(`preserved ${CONFIG_FILE} and ${EXTENSIONS_DIR}/ — your selection and your authored inputs`);
  if (plan.prunedDirs.length) {
    log(`${dryRun ? 'would prune' : 'pruned'} empty dir(s): ${plan.prunedDirs.join(', ')}`);
  }

  // .gitignore last: only wafflestack's own offered lines, matched exactly. Never on a dry run,
  // and never when the config is being kept (the entries still describe a live install).
  /** @type {string[]} */
  let unignored = [];
  if (!keepConfig && plan.gitignore.length) {
    if (dryRun) {
      log(`would strip wafflestack's .gitignore entries: ${plan.gitignore.join(', ')}`);
    } else {
      unignored = removeGitignoreEntries(cwd, plan.gitignore);
      if (unignored.length) log(`.gitignore: removed ${unignored.join(', ')}`);
    }
  }

  if (plan.ejected.length) {
    log(
      `note: ${plan.ejected.length} ejected item(s) (${plan.ejected.join(', ')}) are project-owned and were left in place — the lock stopped tracking them when they were ejected`,
    );
  }
  for (const n of plan.notes) log(`note: ${n}`);
  for (const e of errors) log(`error: ${e}`);

  return { ok: errors.length === 0, dryRun, plan, removed, skipped, errors };
}

/**
 * @typedef {object} Snapshot
 * @property {string} rel
 * @property {string} abs
 * @property {Buffer} body
 */

/**
 * Read the bytes of every path a refresh is about to delete, so a failing render leg can put them
 * back. In memory on purpose: these are the toolkit's own rendered text files (skills, agents,
 * workflows) — small, and already fully in hand — and a temp-dir staging area would only add a
 * second thing that can fail halfway.
 *
 * @param {string} cwd
 * @param {string[]} rels
 * @returns {Snapshot[]}
 */
function snapshotFiles(cwd, rels) {
  /** @type {Snapshot[]} */
  const snap = [];
  for (const rel of rels) {
    const abs = resolveInside(cwd, rel);
    if (!abs || !exists(abs)) continue;
    try {
      snap.push({ rel, abs, body: fs.readFileSync(abs) });
    } catch {
      // Unreadable now means unrestorable later, and there is nothing useful to do about it here:
      // the render leg is overwhelmingly likely to succeed and rewrite it anyway. Skip it rather
      // than abort a refresh over a file we may never need to put back.
    }
  }
  return snap;
}

/**
 * Put a snapshot back, recreating any parent directory the uninstall pruned.
 *
 * @param {Snapshot[]} snapshot
 * @returns {{ restored: string[], failed: string[] }}
 */
function restoreFiles(snapshot) {
  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const failed = [];
  for (const { rel, abs, body } of snapshot) {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      restored.push(rel);
    } catch (err) {
      failed.push(`failed to restore ${rel}: ${/** @type {Error} */ (err).message}`);
    }
  }
  return { restored: restored.sort(), failed };
}

/**
 * @typedef {object} ReinstallResult
 * @property {boolean} ok
 * @property {UninstallResult} uninstall
 * @property {any} render the `renderProject` result, or null on `--clean` (nothing is selected yet)
 * @property {boolean} initialized true when `--clean` scaffolded a fresh config
 * @property {string[]} restored files put back after a failing render leg (see reinstall)
 * @property {string[]} errors
 */

/**
 * Re-lay a wafflestack install. TWO shapes, and the default is the one people actually want:
 *
 *   default (refresh in place) — remove every managed file, then re-render the SAME selection.
 *     The config, the overlay and `.waffle/extensions/` are the consumer's authored inputs: a
 *     refresh must not destroy the selection it is about to re-render. Both locks are kept too,
 *     and that is load-bearing rather than tidy: `computeSelection` keeps an already-poured opt-in
 *     ("syrup") `files/` item selected BECAUSE its path is in the lock (refs.mjs). Delete the lock
 *     first and the re-render silently drops every syrup file not also named in `include:`. Render
 *     rewrites both locks anyway, so keeping them costs nothing and saves that.
 *     No `--yes` is required: every file it removes is written back by the render that follows.
 *
 *   --clean (wipe to empty) — the reporter's literal "uninstall then init": remove everything
 *     including the config, then scaffold a starter one. There is nothing to render (the selection
 *     is empty), so it does not. This one destroys authored input, so the CLI gates it behind
 *     `--yes`.
 *
 * WHAT `--force` MEANS HERE. There are two safety refusals it could be overriding — uninstall's
 * (skip a drifted, hand-edited file) and render's (refuse to clobber a pre-existing *unmanaged*
 * file) — and the happy accident of this command is that exactly one of them is live on each path,
 * so `--force` is never ambiguous:
 *
 *   - On a REFRESH, uninstall's refusal is vacuous. A managed path is already in the lock, so
 *     render's clobber guard waves it through and rewrites it whatever its hash: a hand-edit to a
 *     rendered file does not survive a plain `render` today (the frozen-image contract) and cannot
 *     survive a `reinstall` either. Skipping it, then overwriting it from the render two lines
 *     later, would preserve nothing and print a "re-run with --force" that was never true — so the
 *     refresh deletes drifted files unconditionally, and `--force` flows to the render leg, where
 *     it means what it always means. Left off, the clobber guard still stands between this command
 *     and a file wafflestack never wrote, which is the file that actually needs protecting.
 *   - On `--clean`, render's refusal is vacuous — there is no render. And now the drift skip is the
 *     one that bites hardest: nothing will restore a hand-edited file after this, so it is kept and
 *     reported exactly as `uninstall` would keep it, and `--force` carries uninstall's sense.
 *
 * @param {object} opts
 * @param {string} opts.toolkitRoot
 * @param {string} opts.cwd
 * @param {string} opts.toolkitVersion
 * @param {boolean} [opts.clean]
 * @param {boolean} [opts.force] override whichever safety refusal is live on this path (above)
 * @param {(msg: string) => void} [opts.log]
 * @returns {ReinstallResult}
 */
export function reinstall({ toolkitRoot, cwd, toolkitVersion, clean = false, force = false, log = () => {} }) {
  // CRASH-SAFETY ON THE REFRESH PATH, which is delete-THEN-render.
  //
  // `render` validates its whole selection before it writes a byte: a bad stack name, an unset
  // required config value, a `pattern:` guard, an unresolvable `source:` pin — each returns
  // `ok: false` with the tree untouched. A refresh must not be MORE destructive than the render it
  // wraps, least of all while deliberately asking for no `--yes` (see the docblock above). But it
  // deletes first, so a render leg that fails would leave the tree stripped and restore nothing —
  // and rendered output is commonly gitignored, so git may not put it back either. The user reaches
  // for `reinstall` precisely when they have been editing `waffle.yaml`, which is exactly when the
  // render is most likely to fail.
  //
  // So: snapshot the bytes before deleting, and put them back if the render leg fails. Nothing to do
  // on `--clean` — there is no render that could fail, and the wipe IS the point.
  /** @type {Snapshot[]} */
  let snapshot = [];
  if (!clean) {
    const plan = planUninstall({ cwd, toolkitRoot, force: true, keepConfig: true, keepLock: true });
    snapshot = snapshotFiles(cwd, [...plan.remove, ...plan.drifted]);
  }

  const un = uninstall({
    cwd,
    toolkitRoot,
    // Refresh: every managed file is about to be rewritten, so drift protection buys nothing and
    // costs a false warning. Clean: nothing will restore it, so the drift skip stands (see above).
    force: clean ? force : true,
    allowMissing: true, // a missing file is exactly what a reinstall is here to put back
    keepConfig: !clean,
    keepLock: !clean,
    // On `--clean` the lock must go even when a drifted file is skipped: keeping it would leave
    // render's stale-prune (no hash check) armed against that very file on the next render. The
    // kept files are announced as project-owned instead — uninstall says so when the lock goes.
    keepLockOnSkip: false,
    dryRun: false,
    log,
  });
  if (!un.ok) {
    return { ok: false, uninstall: un, render: null, initialized: false, restored: [], errors: un.errors };
  }

  if (clean) {
    const file = init({ cwd });
    log(`wrote ${file} — pick stacks in it, then run \`wafflestack render\``);
    return { ok: true, uninstall: un, render: null, initialized: true, restored: [], errors: [] };
  }

  log('re-rendering the current selection…');
  // `render.mjs` has no `// @ts-check` pragma yet, so `renderProject`'s `log` infers from its
  // `= () => {}` default as a ZERO-arg `() => void` — which a `(msg: string) => void` cannot be
  // assigned to. The cast says what is actually true (it is called with one string) and costs
  // nothing; it comes out when render.mjs takes the pragma.
  const renderLog = /** @type {(...args: any[]) => void} */ (log);

  /** Put the tree back and explain — the refresh failed, so it must leave nothing behind. */
  const rollback = (/** @type {string[]} */ errors, /** @type {any} */ render) => {
    const { restored, failed } = restoreFiles(snapshot);
    if (restored.length) {
      log(
        `the re-render failed — restored the ${restored.length} file(s) the refresh had removed; the tree is as it was. Fix ${CONFIG_FILE} and re-run.`,
      );
    }
    for (const f of failed) log(`error: ${f}`);
    return { ok: false, uninstall: un, render, initialized: false, restored, errors: [...errors, ...failed] };
  };

  let render;
  try {
    render = renderProject({ toolkitRoot, cwd, toolkitVersion, force, log: renderLog });
  } catch (err) {
    // renderProject reports its known failures as `ok: false`, but an unexpected throw must not be
    // the one path that leaves the tree stripped.
    return rollback([`the re-render failed: ${/** @type {Error} */ (err).message}`], null);
  }
  if (!render.ok) return rollback(render.errors, render);

  return {
    ok: true,
    uninstall: un,
    render,
    initialized: false,
    restored: [],
    errors: [],
  };
}
