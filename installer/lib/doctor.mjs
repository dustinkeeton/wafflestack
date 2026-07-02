import fs from 'node:fs';
import path from 'node:path';
import { sha256, exists } from './util.mjs';
import { readLock } from './render.mjs';
import { LOCK_FILE } from './project.mjs';

/**
 * Compare managed files against the lock manifest.
 * Returns { ok, modified, missing, notes }.
 */
export function doctor({ cwd, toolkitVersion }) {
  const lock = readLock(cwd);
  if (!lock) {
    return { ok: false, modified: [], missing: [], notes: [`${LOCK_FILE} not found — run \`agent-toolkit render\` first`] };
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
    notes.push('managed files have local edits; move changes into .agent-toolkit/extensions/ or config, then re-render');
  }

  return { ok: modified.length === 0 && missing.length === 0, modified, missing, notes };
}
