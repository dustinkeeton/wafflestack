import fs from 'node:fs';
import path from 'node:path';
import { sha256, exists } from './util.mjs';
import { readLock } from './render.mjs';
import { LOCK_FILE } from './project.mjs';

/**
 * Compare managed files against the lock manifest.
 * Returns { ok, modified, missing, notes, allowMissing }.
 *
 * `allowMissing` turns doctor into a CI-friendly drift gate: absent managed files are
 * reported informationally instead of failing the check, for repos that deliberately
 * gitignore some renders (so those files are legitimately absent in a fresh CI checkout).
 * Modified files are still an error, and a missing lock is still an error — the repo never
 * rendered, which the flag must not mask.
 */
export function doctor({ cwd, toolkitVersion, allowMissing = false }) {
  const lock = readLock(cwd);
  if (!lock) {
    return { ok: false, modified: [], missing: [], notes: [`${LOCK_FILE} not found — run \`wafflestack render\` first`], allowMissing };
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
  if (toolkitVersion && lock.toolkitVersion && toolkitVersion !== lock.toolkitVersion) {
    notes.push(`lock was rendered by toolkit ${lock.toolkitVersion}, installed CLI is ${toolkitVersion} — re-render to update`);
  }
  if (modified.length) {
    notes.push('managed files have local edits; move changes into .wafflestack/extensions/ or config, then re-render');
  }
  if (allowMissing && missing.length) {
    notes.push(`${missing.length} managed file(s) absent but tolerated (--allow-missing) — expected when a repo gitignores some renders (partial/CI checkout)`);
  }

  // With --allow-missing, only *modified* files count as drift; absent files are informational.
  const ok = allowMissing ? modified.length === 0 : modified.length === 0 && missing.length === 0;
  return { ok, modified, missing, notes, allowMissing };
}
