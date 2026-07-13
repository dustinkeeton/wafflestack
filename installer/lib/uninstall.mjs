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
 * THE SAFETY MODEL, in one sentence: a RENDERED file is deleted if and only if the lock says
 * wafflestack wrote it AND its sha256 still equals what the lock recorded. No globbing of
 * `.claude/**`, no "looks generated" heuristics, no path the lock does not name. This is the
 * toolkit's only destructive command, and rendered output is commonly gitignored, so a file it
 * deletes wrongly may be the consumer's only copy. Hence:
 *
 *   - The lock is the sole source of truth for WHAT is ours (`files{}`: path → sha256).
 *   - The hash is the sole source of truth for whether it is still ours to delete. A DRIFTED file
 *     (present, hash differs) holds the consumer's own edit and is SKIPPED and reported, unless
 *     `--force`. An EJECTED file was deliberately released to the project and is invisible to the
 *     lock by construction — it stays, and we say so.
 *   - Absence is never an error: an already-gone file is simply nothing to do (idempotent).
 *   - It is a DRY RUN until `--yes`. The plan below is computed once and used for both the preview
 *     and the execution, so what you are shown cannot drift from what would be done.
 *
 * THE ONE EXCEPTION, stated plainly rather than buried: `.waffle/` itself. The config, the overlay,
 * the locks and `extensions/` are not rendered output — the lock does not track them and cannot,
 * since `extensions/` holds files the CONSUMER wrote (render.mjs reads them as render *sources*).
 * A full uninstall removes them, `extensions/` recursively, because leaving `.waffle/` behind is
 * leaving the install behind. So they are hash-gated by nothing, and `--keep-config` is how you say
 * "take the rendered output, keep my authored inputs" — the flag the library always had and the CLI
 * did not expose. Both the dry run and the real run name every `.waffle/` path they will remove
 * (`plan.meta`), so it is never a silent delete; it is just not one the lock can vouch for.
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
 *   From `planUninstall` this is the PREDICTION (a skip, or an explicit `keepLock`). From
 *   `uninstall` it is the OUTCOME: a failed removal also keeps the lock, and that is only knowable
 *   after the removals run, so `uninstall` returns the plan with this field reconciled. Read it off
 *   the result, not off a bare plan, if what you mean is "is the lock still there?"
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
 * @param {boolean} [opts.keepConfig] preserve `.waffle/waffle.yaml`, the overlay, `extensions/` —
 *   and the locks with them: the lock carries the half of the selection the config does not (see
 *   `lockRetained` below), so keeping one without the other keeps a selection that no longer renders
 *   the install it describes
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
    if (!exists(abs)) {
      absent.push(rel);
      continue;
    }
    /** @type {Buffer} */
    let body;
    try {
      body = fs.readFileSync(abs);
    } catch (err) {
      // CANNOT READ IT ⇒ CANNOT PROVE IT IS OURS ⇒ DO NOT DELETE IT. An unreadable managed file
      // (chmod 000, a root-owned file — the same list `rollback` enumerates) used to throw a bare
      // errno straight out of the plan, through `uninstall`, into the CLI's blanket catch: the
      // documented "safe, read-only preview" crashed with `error: EACCES … open '…'` and no hint of
      // which command failed or why. But an unverifiable hash is not an exception, it is a
      // DISPOSITION — the drifted one. Keep it, report it, and let `--force` mean here what it means
      // everywhere else: delete it anyway.
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
  //
  // KEEPING THE CONFIG KEEPS THE LOCK, because half a selection is not a selection. The lock is not
  // merely a hash manifest: `computeSelection` keeps an already-poured opt-in ("syrup") `files/` item
  // selected BECAUSE its path is in the lock (`refs.mjs` — `if (stack.optIn.has(...) &&
  // !trackedFiles.has(f.name)) continue`). So a consumer left holding `waffle.yaml` with no lock has
  // a config that no longer describes their install: the next `render` silently comes back without
  // every syrup they had poured. `reinstall` has always known this — its refresh leg keeps both, and
  // the docblock below calls it "load-bearing, not tidy" — but `keepConfig` alone did not, so the
  // `--keep-config` flag whose whole promise is "take the rendered output, keep my authored inputs"
  // walked straight into it. The two flags are one decision, so they are decided in one place.
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
  if (!allowMissing) {
    for (const rel of plan.absent) log(`absent (nothing to do): ${rel}`);
  }

  // The skip messages USED to be emitted here, before the execution block — and that is precisely
  // why they could not tell the truth. They read `plan.lockRetained`, decided at plan time, while a
  // removal failure decides the lock's fate at EXECUTION time. On `--clean` + drift + a failed
  // removal the two disagreed, and the run said both "now project-owned (delete it by hand)" AND
  // "the lock was kept" — telling the consumer to hand-delete a file the tool could still manage.
  // They now live below the execution block, and read the ONE answer it produces.

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

    // A FAILED REMOVAL IS AN INCOMPLETE UNINSTALL — so, exactly like a SKIP, it must not take the
    // lock down with it. `lockRetained` is decided at PLAN time, from `drifted` alone; a removal
    // failure (EACCES on a read-only checkout, a root-owned file, a file held open on Windows, an
    // SMB/NAS mount) happens at EXECUTION time, where no plan can see it. Deleting the lock and the
    // config anyway would strand the very file we could not delete with no record it was ever
    // wafflestack's — #182's opening complaint ("guessing which are wafflestack-managed and which
    // they authored"), produced by the command written to fix it — and it would close the one way
    // back the tool advertises: the `--force` re-run dies on `no .waffle/waffle.lock.json`, and only
    // a full re-install can regenerate a lock. So the meta outlives an error, and says so below.
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
    // Directories, deepest first — and only ones the plan proved empty. The guard is what makes that
    // safe, and it is also why the plan cannot double as the report: a dir the plan expected to empty
    // out but which still holds the file a removal above failed on is SILENTLY skipped here. Collect
    // what actually went.
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

  // DOES THE LOCK SURVIVE THIS RUN? ONE QUESTION, ONE ANSWER, ASKED ONCE — HERE.
  //
  // The rule has been amended three times (a skip keeps it; a failing render leg restores the tree;
  // a failed removal keeps it), and each amendment added a *place* where retention was decided:
  // `lockRetained` at plan time, `metaKeptOnError` at execution time. Two sources of truth is one
  // too many, and the message layer read only the first — so the report contradicted itself on the
  // one path where they disagree. This line is the reconciliation, and everything below it (and the
  // `plan` we return) reads THIS value, never the plan's prediction.
  //
  // It is a plain OR because the two cases cannot conflict: when the plan does NOT retain the lock,
  // the lock is necessarily in `plan.meta` (a lock we read is a lock on disk, so `addMeta` took it),
  // and `metaKeptOnError` is exactly "the meta loop did not run". On a dry run nothing executes, so
  // it collapses to the plan's answer — which is correct, because on a dry run the plan IS the run.
  const lockKept = plan.lockRetained || metaKeptOnError;

  // Only promise the `--force` re-run on a path that can actually honour it — i.e. where the lock
  // survives to tell that run these files were ours. Where it does not (`reinstall --clean`, which
  // opts out via `keepLockOnSkip`), say the true thing instead: they are the project's now.
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

  // REPORT WHAT HAPPENED, NOT WHAT WAS PLANNED. The plan IS the story on a dry run — that is the
  // whole design, and why the preview cannot drift from the execution. But once we have touched
  // disk, replaying it in the past tense tells the consumer their tree is clean when a failed
  // removal left files (and their dirs) behind. On the toolkit's only destructive command the
  // printed report is the consumer's sole audit trail of what became of their files, so it is the
  // one output that must never say `pruned` about a directory still sitting on disk.
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

  // .gitignore last: only wafflestack's own offered lines, matched exactly. Never on a dry run, and
  // never when the config is being kept (the entries still describe a live install) — which now
  // includes the config we kept BECAUSE the run failed: the install is still there, so its ignore
  // lines still describe something true.
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
  // Errors are RETURNED, not logged. The caller prints what it is handed — the CLI sends them to
  // stderr, where an error belongs — and logging them here too would print each one twice: once to
  // stdout via `log`, once to stderr via the caller. That bit `reinstall` (which passes the CLI's
  // `log` straight through) and `uninstall` alike, on any per-file `failed to remove …`.
  //
  // The plan goes back RECONCILED: `lockRetained` is documented as "the lock survives this run", and
  // a caller reading it off the result is asking about the run, not about the forecast. Leaving the
  // plan-time prediction in place would hand them `false` while the lock sits on disk — the same
  // two-sources-of-truth bug as the messages, just exported instead of printed.
  return { ok: errors.length === 0, dryRun, plan: { ...plan, lockRetained: lockKept }, removed, skipped, errors };
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
 * Returns what it COULD NOT read alongside what it could. That used to be a `catch {}` with a
 * comment explaining why it did not matter — and the comment was true when it was written, because
 * an unreadable managed file threw out of `planUninstall` and a refresh died during *planning*,
 * deleting nothing. It stopped being true the moment an unreadable file became a classified,
 * `--force`-deletable one (the refresh passes `force: true`, and `rmSync` needs the parent dir
 * writable, not the file readable): the refresh can now delete a file the snapshot does not hold.
 * A rollback that cannot restore it must SAY so, rather than certify "the tree is as it was".
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
      // Do not abort the refresh over a file we will probably never need to put back — the render leg
      // usually succeeds and rewrites it. But record it, so the one line whose job is to certify a
      // total rollback cannot claim one it did not achieve.
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
      // Still on disk, unchanged: the delete never reached it — a failing uninstall leg stops at the
      // file it could not remove. Nothing to restore, and rewriting it would be a pointless write
      // into the very directory that just refused one. Not counted as restored: it never left.
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
  /** @type {string[]} */
  let unsnapshotable = [];
  if (!clean) {
    const plan = planUninstall({ cwd, toolkitRoot, force: true, keepConfig: true, keepLock: true });
    ({ snapshot, unreadable: unsnapshotable } = snapshotFiles(cwd, [...plan.remove, ...plan.drifted]));
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

  /**
   * Put the tree back and explain — the refresh failed, so it must leave nothing behind.
   *
   * Declared ABOVE the uninstall-leg check, because that leg can fail too and the snapshot is just
   * as load-bearing there: `uninstall` reports a per-file `failed to remove …` (an EACCES on a
   * read-only checkout, a root-owned file, a file held open on Windows, an SMB/NAS mount) only
   * AFTER deleting everything it could. Returning early there would strip the tree and restore
   * nothing — the very invariant the snapshot exists to hold, and worse than the render leg,
   * because nothing has been rendered back either.
   *
   * @param {string[]} errors
   * @param {any} render
   * @param {string} why what failed, for the log line
   */
  const rollback = (errors, render, why) => {
    const { restored, failed } = restoreFiles(snapshot);
    // Certify only what is true. A file the snapshot could not READ (and which the refresh, running
    // `force: true`, may well have deleted anyway) is not restorable here — so this line must not
    // claim the tree is as it was. It is a rendered file, so a later successful `render` rebuilds
    // it; name it, and say that.
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
  // `render.mjs` has no `// @ts-check` pragma yet, so `renderProject`'s `log` infers from its
  // `= () => {}` default as a ZERO-arg `() => void` — which a `(msg: string) => void` cannot be
  // assigned to. The cast says what is actually true (it is called with one string) and costs
  // nothing; it comes out when render.mjs takes the pragma.
  const renderLog = /** @type {(...args: any[]) => void} */ (log);

  let render;
  try {
    render = renderProject({ toolkitRoot, cwd, toolkitVersion, force, log: renderLog });
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
