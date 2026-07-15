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
 * SAFETY MODEL: a rendered file is deleted iff the lock names it AND its sha256 still matches. A
 * DRIFTED file (present, hash differs) is skipped and reported unless `--force`; an EJECTED file is
 * invisible to the lock and stays; absence is idempotent; it is a DRY RUN until `--yes` (one plan
 * drives both preview and execution). The one exception is `.waffle/` itself — config, overlay,
 * locks, `extensions/` are authored inputs the lock cannot track, so a full uninstall removes them
 * and `--keep-config` preserves them; every `.waffle/` path removed is still named (`plan.meta`).
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
 * @property {boolean} lockRetained the lock survives this run (so `--force` can re-reach skipped
 *   files). From `planUninstall` it is the PREDICTION; from `uninstall` the reconciled OUTCOME (a
 *   failed removal also keeps it) — read it off the result, not a bare plan.
 * @property {string[]} notes
 */

/** posix-ise a path for display, so messages read the same on every platform. */
const posix = (/** @type {string} */ p) => p.split(path.sep).join('/');

/**
 * Resolve a lock key to an absolute path, refusing anything that escapes `cwd` (#182).
 *
 * Two guards, because a hostile/hand-edited lock could name `../../.ssh/id_rsa`: refuse lexical
 * `../` escapes, AND resolve symlinks on the deepest existing ancestor (the leaf's PARENT, since a
 * managed file may itself be a symlink safe to unlink) and require the real path to stay inside the
 * real `cwd` — lexical containment alone is defeated by an in-tree symlinked parent. Re-checked at
 * delete time too, which narrows the TOCTOU window.
 *
 * @param {string} cwd
 * @param {string} rel
 * @returns {string | null} the absolute path, or null when it is not strictly inside `cwd`
 */
function resolveInside(cwd, rel) {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel);
  if (abs === root || !abs.startsWith(root + path.sep)) return null;

  // Lexical check passed; now defeat symlink escape by canonicalising the deepest existing ancestor
  // of `abs` and re-attaching the missing tail — an ancestor linking out lands outside `realRoot`.
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null; // cannot even canonicalise cwd — cannot prove anything is inside it
  }
  /** @type {string[]} */
  const tail = [];
  let probe = path.dirname(abs); // the leaf may be a symlink we intend to unlink — resolve its PARENT
  while (probe !== path.dirname(probe)) {
    if (exists(probe)) break; // deepest existing ancestor found
    tail.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  let realProbe;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    return null;
  }
  const realAbs = path.resolve(realProbe, ...tail, path.basename(abs));
  if (realAbs !== realRoot && realAbs.startsWith(realRoot + path.sep)) return abs;
  return null;
}

/**
 * Which directories are left empty once `removing` is gone — computed WITHOUT deleting, so the dry
 * run and the real run (which share this) cannot disagree (#182).
 *
 * `removing` are the only paths counted as "gone"; `candidates` (every lock-tracked path, including
 * already-absent ones) is only where to start looking. The emptiness test is the sole authority to
 * prune, so seeding from an already-empty orphan is safe and a dir holding anything unmanaged (or a
 * KEPT drifted file) survives. Bounded strictly below `cwd` — the repo root is never a candidate.
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
 * Classify every path the lock tracks (and everything else uninstall touches) WITHOUT writing disk.
 * `uninstall` is this plan plus `fs` calls; the dry run is this plan plus `console.log`.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string | null} [opts.toolkitRoot] needed only to compute the `.gitignore` offer
 * @param {boolean} [opts.force] drifted files will be deleted too — affects which dirs empty out
 * @param {boolean} [opts.keepConfig] preserve `.waffle/waffle.yaml`, the overlay, `extensions/` —
 *   and the locks with them (a config without its lock is half a selection; see `lockRetained`)
 * @param {boolean} [opts.keepLock] preserve both lock files (implied by `keepConfig`)
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

  // The lock describing the files ON DISK — local when an overlay shaped this render, else committed
  // (#317). NOT `readLock`: on an overlay machine canonical hashes would mark every overlay-touched
  // file hand-edited and skip it. Same lock `doctor` drift-checks, for the same reason.
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

  // Compute the .gitignore offer BEFORE deleting: it reads the config we may remove. Degrade to the
  // baseline entries if the config is unreadable — a partial strip beats a crash mid-uninstall.
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
    if (!exists(abs)) {
      absent.push(rel);
      continue;
    }
    /** @type {Buffer} */
    let body;
    try {
      body = fs.readFileSync(abs);
    } catch (err) {
      // CANNOT READ IT ⇒ CANNOT PROVE IT IS OURS ⇒ DO NOT DELETE IT (#182). An unverifiable hash is
      // a DISPOSITION (drifted), not an exception to throw: keep it, report it, `--force` deletes.
      drifted.push(rel);
      notes.push(
        `could not read ${rel} to check it against ${lockFile} (${/** @type {Error} */ (err).message}) — treated as hand-edited and left in place`,
      );
      continue;
    }
    if (sha256(body) !== hash) drifted.push(rel); // the same compare doctor makes
    else remove.push(rel);
  }
  remove.sort();
  drifted.sort();
  absent.sort();

  // Ejected items are project-owned: `eject` drops them from `lock.files` but leaves the files, so
  // uninstall cannot see them and must announce them or the consumer is left with orphans (#182).
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
  // THE LOCK OUTLIVES A SKIP (#182): a kept drifted file is still ours, and the lock is the only
  // record that says so, which `--force` re-reads — so a skip means the uninstall is INCOMPLETE and
  // the lock stays. `keepLockOnSkip: false` opts out (reinstall's `--clean` leg, where nothing
  // restores the file). KEEPING THE CONFIG KEEPS THE LOCK: `computeSelection` keeps an already-poured
  // opt-in selected BECAUSE its path is in the lock, so a config with no lock is half a selection.
  const lockRetained = keepLock || keepConfig || (keepLockOnSkip && !force && drifted.length > 0);
  if (!lockRetained) {
    addMeta(resolveLockFile(cwd).file, 'file');
    addMeta(localLockPath(cwd), 'file');
  }
  if (!keepConfig) {
    addMeta(resolveConfigFile(cwd).file, 'file');
    addMeta(resolveLocalConfigFile(cwd).file, 'file');
    addMeta(path.join(cwd, EXTENSIONS_DIR), 'dir');
  }

  // `removing` = what actually goes (drifted only under --force); `candidates` = where to look for
  // an emptied dir = every lock-tracked path, absent ones included.
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
 * `dryRun: !--yes` (it is deliberately non-interactive, so a flag is the consent, not a prompt).
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string | null} [opts.toolkitRoot]
 * @param {boolean} [opts.force] also delete drifted (hand-edited) files
 * @param {boolean} [opts.allowMissing] silence the per-file "already absent" lines
 * @param {boolean} [opts.keepConfig] preserve the config, overlay and `extensions/` — and the locks
 *   with them (a config without its lock is half a selection; see planUninstall)
 * @param {boolean} [opts.keepLock] preserve both locks (implied by `keepConfig`)
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
  // Deleting is opt-in at the library boundary too: this is the one function that destroys consumer
  // files, so the safe default is the one that fails loudly. Both real callers pass it explicitly.
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
  if (!allowMissing) {
    for (const rel of plan.absent) log(`absent (nothing to do): ${rel}`);
  }

  // Skip messages live BELOW the execution block (not here): a removal failure decides the lock's
  // fate at execution time, so emitting them at plan time made the report contradict itself.

  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {MetaTarget[]} */
  const removedMeta = [];
  /** @type {string[]} */
  const prunedDirs = [];
  // The `.waffle/` meta survived because the run could not FINISH — not because a flag asked for it.
  let metaKeptOnError = false;

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

    // A FAILED REMOVAL IS AN INCOMPLETE UNINSTALL — like a skip, it must not take the lock/config
    // down with it (that would strand the undeletable file with no record), so the meta outlives an
    // error and says so below (#182). Decided at EXECUTION time, where the plan-time `lockRetained` cannot see it.
    metaKeptOnError = errors.length > 0 && plan.meta.length > 0;
    if (!metaKeptOnError) {
      for (const m of plan.meta) {
        try {
          if (exists(m.abs)) fs.rmSync(m.abs, m.type === 'dir' ? { recursive: true, force: true } : {});
          removedMeta.push(m);
          removed.push(m.rel);
        } catch (err) {
          errors.push(`failed to remove ${m.rel}: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
    // Prune only dirs the plan proved empty AND that are still empty now — a dir still holding a file
    // a removal above failed on is silently skipped, so collect what ACTUALLY went (not the plan).
    for (const rel of plan.prunedDirs) {
      const abs = path.join(cwd, rel);
      try {
        if (exists(abs) && !fs.readdirSync(abs).length) {
          fs.rmdirSync(abs);
          prunedDirs.push(rel);
        }
      } catch (err) {
        errors.push(`failed to prune ${rel}: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  // Does the lock survive this run? Reconciled ONCE here, from the plan-time prediction and the
  // execution-time `metaKeptOnError` — everything below (and the returned `plan`) reads THIS, not the
  // prediction. Plain OR: the two cannot conflict, and on a dry run it collapses to the plan's answer.
  const lockKept = plan.lockRetained || metaKeptOnError;

  // Only promise the `--force` re-run where the lock survives to honour it; where it does not
  // (`reinstall --clean`), say the true thing — the skipped files are the project's now.
  for (const rel of skipped) {
    log(
      lockKept
        ? `skipped (modified): ${rel} — hand-edited since it was rendered; re-run with --force to delete it`
        : `skipped (modified): ${rel} — hand-edited since it was rendered; left in place and now project-owned (delete it by hand)`,
    );
  }
  if (skipped.length && lockKept) {
    log(
      `${skipped.length} file(s) kept, so ${plan.lockFile} was kept too — it is the only record that they are wafflestack's. Re-run with --force to remove them and finish the uninstall.`,
    );
  }

  // Report what HAPPENED, not what was planned: on a dry run the plan is the story, but once disk is
  // touched a failed removal means the report must never say `pruned` about a dir still on disk.
  const reportMeta = dryRun ? plan.meta : removedMeta;
  const reportPruned = dryRun ? plan.prunedDirs : prunedDirs;
  if (reportMeta.length) {
    log(`${dryRun ? 'would remove' : 'removed'} ${reportMeta.map((m) => m.rel).join(', ')}`);
  }
  if (metaKeptOnError) {
    log(
      `${errors.length} file(s) could not be removed, so ${plan.meta.map((m) => m.rel).join(', ')} ${plan.meta.length === 1 ? 'was' : 'were'} kept — the lock is the only record that what is left is wafflestack's. Fix the error(s) above and re-run to finish the uninstall.`,
    );
  }
  if (keepConfig) log(`preserved ${CONFIG_FILE} and ${EXTENSIONS_DIR}/ — your selection and your authored inputs`);
  if (reportPruned.length) {
    log(`${dryRun ? 'would prune' : 'pruned'} empty dir(s): ${reportPruned.join(', ')}`);
  }

  // .gitignore last: only wafflestack's offered lines, matched exactly. Skipped on a dry run or when
  // the config is kept (incl. kept-on-error) — the entries still describe a live install.
  /** @type {string[]} */
  let unignored = [];
  if (!keepConfig && !metaKeptOnError && plan.gitignore.length) {
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
  // Errors are RETURNED, not logged — the caller prints them (to stderr), so logging here would
  // double each one. The plan goes back RECONCILED (`lockRetained: lockKept`) so a caller reading it
  // off the result gets the run's outcome, not the plan-time forecast.
  return { ok: errors.length === 0, dryRun, plan: { ...plan, lockRetained: lockKept }, removed, skipped, errors };
}

/**
 * @typedef {object} Snapshot
 * @property {string} rel
 * @property {string} abs
 * @property {Buffer} body
 */

/**
 * Read the bytes of every path a refresh is about to delete (in memory), so a failing render leg can
 * restore them. Returns what it COULD NOT read alongside what it could — the refresh runs
 * `force: true`, so it can delete a file the snapshot does not hold, and a rollback must say so.
 *
 * @param {string} cwd
 * @param {string[]} rels
 * @returns {{ snapshot: Snapshot[], unreadable: string[] }}
 */
function snapshotFiles(cwd, rels) {
  /** @type {Snapshot[]} */
  const snapshot = [];
  /** @type {string[]} */
  const unreadable = [];
  for (const rel of rels) {
    const abs = resolveInside(cwd, rel);
    if (!abs || !exists(abs)) continue;
    try {
      snapshot.push({ rel, abs, body: fs.readFileSync(abs) });
    } catch {
      // Don't abort the refresh (the render leg usually rewrites it), but record it so the rollback
      // cannot certify a total restore it did not achieve.
      unreadable.push(rel);
    }
  }
  return { snapshot, unreadable: unreadable.sort() };
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
      // Still on disk unchanged (the delete never reached it): nothing to restore, and it never left.
      if (exists(abs) && fs.readFileSync(abs).equals(body)) continue;
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
 * Re-lay a wafflestack install (#182). TWO shapes:
 *   - default (refresh in place) — remove every managed file, then re-render the SAME selection.
 *     Config/overlay/`extensions/` and both locks are kept: `computeSelection` keeps an already-
 *     poured opt-in selected because its path is in the lock, so dropping it would silently lose
 *     syrup. No `--yes` needed — every removed file is written back by the render that follows.
 *   - --clean (wipe to empty) — remove everything incl. the config, then scaffold a starter one;
 *     nothing to render. Destroys authored input, so the CLI gates it behind `--yes`.
 *
 * `--force` overrides whichever safety refusal is live on the path, and exactly one is on each: on a
 * REFRESH, uninstall's drift skip is vacuous (render's clobber guard rewrites the managed path
 * anyway) so `--force` flows to the render leg; on `--clean` there is no render, so the drift skip
 * stands and `--force` carries uninstall's sense.
 *
 * @param {object} opts
 * @param {string} opts.toolkitRoot
 * @param {string} opts.cwd
 * @param {string} opts.toolkitVersion
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} [opts.toolkitIdentity] what the running
 *   CLI IS (#373) — release/unreleased/unverified, plus the ref that reproduces it. Threaded to the
 *   render leg's lock write site so a re-laid install records the toolkit that laid it, not merely a
 *   version number. `reinstall` is a gated command, so the CLI always has one; null off the CLI path.
 * @param {boolean} [opts.clean]
 * @param {boolean} [opts.force] override whichever safety refusal is live on this path (above)
 * @param {(msg: string) => void} [opts.log]
 * @returns {ReinstallResult}
 */
export function reinstall({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, clean = false, force = false, log = () => {} }) {
  // CRASH-SAFETY ON THE REFRESH PATH (delete-THEN-render): a failing render leg would leave the tree
  // stripped and (rendered output being gitignored) git may not restore it, so snapshot the bytes
  // before deleting and put them back on failure. Nothing to do on `--clean` — the wipe IS the point.
  //
  // ONE options object shared by the snapshot's plan and the uninstall leg, because the snapshot is
  // only a rollback if it covers EXACTLY the files that leg removes — stating them twice invites drift.
  const unOpts = {
    cwd,
    toolkitRoot,
    // Refresh: every managed file is about to be rewritten, so drift protection buys nothing and
    // costs a false warning. Clean: nothing will restore it, so the drift skip stands (see above).
    force: clean ? force : true,
    keepConfig: !clean,
    keepLock: !clean,
    // On `--clean` the lock must go even when a drifted file is skipped: keeping it would leave
    // render's stale-prune (no hash check) armed against that very file on the next render. The
    // kept files are announced as project-owned instead — uninstall says so when the lock goes.
    keepLockOnSkip: false,
  };

  /** @type {Snapshot[]} */
  let snapshot = [];
  /** @type {string[]} */
  let unsnapshotable = [];
  if (!clean) {
    // `remove` + `drifted` is every file this leg will delete: the refresh runs `force: true`, so
    // the drifted ones go too — which is precisely why they must be snapshotted with the rest.
    const plan = planUninstall(unOpts);
    ({ snapshot, unreadable: unsnapshotable } = snapshotFiles(cwd, [...plan.remove, ...plan.drifted]));
  }

  const un = uninstall({
    ...unOpts,
    allowMissing: true, // a missing file is exactly what a reinstall is here to put back
    dryRun: false,
    log,
  });

  /**
   * Put the tree back and explain — the refresh failed, so it must leave nothing behind. Declared
   * ABOVE the uninstall-leg check because that leg can fail too (a per-file `failed to remove …`
   * AFTER deleting all it could), and returning early there would strip the tree and restore nothing.
   *
   * @param {string[]} errors
   * @param {any} render
   * @param {string} why what failed, for the log line
   */
  const rollback = (errors, render, why) => {
    const { restored, failed } = restoreFiles(snapshot);
    // Certify only what is true: a file the snapshot could not READ may be gone and is not restorable
    // here, so name it rather than claim the tree is as it was (a later `render` rebuilds it).
    const lost = unsnapshotable.filter((rel) => !exists(path.join(cwd, rel)));
    if (restored.length) {
      log(
        lost.length
          ? `${why} — restored the ${restored.length} file(s) the refresh could put back, but ${lost.length} unreadable file(s) could NOT be snapshotted and are gone: ${lost.join(', ')}. Fix the error above and re-run, or run \`wafflestack render\` to rebuild them.`
          : `${why} — restored the ${restored.length} file(s) the refresh had removed; the tree is as it was. Fix the error above and re-run.`,
      );
    }
    // `failed` is returned, not logged: the caller prints what it is handed (see uninstall).
    return { ok: false, uninstall: un, render, initialized: false, restored, errors: [...errors, ...failed] };
  };

  // A failing uninstall leg gets the same restore as a failing render leg. On `--clean` the
  // snapshot is empty by construction, so this correctly restores nothing.
  if (!un.ok) return rollback(un.errors, null, 'the refresh could not remove every managed file, and did not re-render');

  if (clean) {
    const file = init({ cwd });
    log(`wrote ${file} — pick stacks in it, then run \`wafflestack render\``);
    return { ok: true, uninstall: un, render: null, initialized: true, restored: [], errors: [] };
  }

  log('re-rendering the current selection…');
  // render.mjs is un-pragma'd, so `renderProject`'s `log` infers as zero-arg `() => void`, which a
  // `(msg: string) => void` cannot satisfy. The cast states the truth (called with one string).
  const renderLog = /** @type {(...args: any[]) => void} */ (log);

  let render;
  try {
    // `toolkitIdentity` (#373): what the CLI that authorized this reinstall IS — threaded to the
    // lock write site so the re-laid install records the toolkit that laid it, not just a version.
    render = renderProject({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity, force, log: renderLog });
  } catch (err) {
    // renderProject reports its known failures as `ok: false`, but an unexpected throw must not be
    // the one path that leaves the tree stripped.
    return rollback([`the re-render failed: ${/** @type {Error} */ (err).message}`], null, 'the re-render failed');
  }
  if (!render.ok) return rollback(render.errors, render, 'the re-render failed');

  return {
    ok: true,
    uninstall: un,
    render,
    initialized: false,
    restored: [],
    errors: [],
  };
}
