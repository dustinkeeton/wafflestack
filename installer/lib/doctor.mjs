import fs from 'node:fs';
import path from 'node:path';
import { sha256, exists } from './util.mjs';
import { readLock } from './render.mjs';
import { LOCK_FILE, resolveLockFile } from './project.mjs';

/**
 * Compare managed files against the lock manifest.
 * Returns { ok, modified, missing, notes, attribution, allowMissing }.
 *
 * `allowMissing` turns doctor into a CI-friendly drift gate: absent managed files are
 * reported informationally instead of failing the check, for repos that deliberately
 * gitignore some renders (so those files are legitimately absent in a fresh CI checkout).
 * Modified files are still an error, and a missing lock is still an error — the repo never
 * rendered, which the flag must not mask.
 *
 * `attribution` maps each externally-sourced file to a human label for the source it came from
 * (#125), so a drift report names which external source a modified/missing file belongs to.
 * Built-in files have no entry (attributed to the toolkit); a pre-#125 lock with no `sources`
 * block yields an empty map — doctor then behaves exactly as before.
 */
export function doctor({ cwd, toolkitVersion, allowMissing = false }) {
  const lock = readLock(cwd);
  if (!lock) {
    return { ok: false, modified: [], missing: [], notes: [`${LOCK_FILE} not found — run \`wafflestack render\` first`], attribution: {}, allowMissing };
  }

  const attribution = {};
  for (const src of lock.sources ?? []) {
    const label = sourceLabel(src);
    for (const rel of src.files ?? []) attribution[rel] = label;
  }

  const modified = [];
  const missing = [];
  for (const [rel, hash] of Object.entries(lock.files)) {
    const abs = path.join(cwd, rel);
    if (!exists(abs)) {
      missing.push(rel);
    } else if (sha256(fs.readFileSync(abs)) !== hash) {
      modified.push(rel);
    }
  }

  const notes = [];
  // A repo still on the legacy lock name reads fine (readLock falls back) but should migrate.
  const lockPath = resolveLockFile(cwd);
  if (lockPath.legacy) notes.push(lockPath.note);
  // Always report which toolkit version the tree was rendered from, so a drift report
  // says what a repo is sitting on — not just when it happens to skew from the CLI.
  const rendered = lock.toolkitVersion ?? 'unknown (pre-versioned lock)';
  notes.push(
    toolkitVersion
      ? `rendered by toolkit ${rendered}; installed CLI is ${toolkitVersion}`
      : `rendered by toolkit ${rendered}`,
  );
  if (toolkitVersion && lock.toolkitVersion && toolkitVersion !== lock.toolkitVersion) {
    notes.push(`version skew — run \`wafflestack upgrade\` to apply migrations and re-render`);
  }
  if (modified.length) {
    notes.push('managed files have local edits; move changes into .waffle/extensions/ or config, then re-render');
  }
  if (allowMissing && missing.length) {
    notes.push(`${missing.length} managed file(s) absent but tolerated (--allow-missing) — expected when a repo gitignores some renders (partial/CI checkout)`);
  }

  // With --allow-missing, only *modified* files count as drift; absent files are informational.
  const ok = allowMissing ? modified.length === 0 : modified.length === 0 && missing.length === 0;
  return { ok, modified, missing, notes, attribution, allowMissing };
}

/**
 * Human label for a lock `sources` entry, used to attribute drift. A git source reads as
 * "<name> @ <short-commit>" (falling back to the ref when a pre-#125-ish lock recorded no
 * commit); a local-path source as "<name> (<path>)".
 */
function sourceLabel(src) {
  if (src.sourceType === 'git') {
    const at = src.commit ? String(src.commit).slice(0, 12) : (src.ref ?? 'unknown');
    return `${src.name} @ ${at}`;
  }
  return `${src.name} (${src.source})`;
}
