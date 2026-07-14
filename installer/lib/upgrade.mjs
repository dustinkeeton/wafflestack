import fs from 'node:fs';
import path from 'node:path';
import { exists, compareVersions, parseVersion } from './util.mjs';
import { readLock, renderProject } from './render.mjs';
import { doctor } from './doctor.mjs';
import { MIGRATIONS, runMigrations } from './migrations.mjs';
import { LOCK_FILE } from './project.mjs';

const CHANGELOG_FILE = 'CHANGELOG.md';

/**
 * Move a consumer repo from the toolkit version its lock records to the toolkit version
 * being invoked. The flow, in order:
 *   1. read the lock's `toolkitVersion` (the "from" version);
 *   2. print what changed between then and now (from CHANGELOG.md, degrading gracefully
 *      when the file is absent);
 *   3. run any registered migrations whose version is in `(from, to]`, in order;
 *   4. re-render every managed file for the current config;
 *   5. run `doctor` and fold its result into the outcome.
 *
 * Migrations run BEFORE render so a step that changes file layout (a rename, a moved
 * config key) leaves the tree in the shape render expects. A missing lock or a lock with
 * no `toolkitVersion` is reported clearly and degrades to "render + doctor, no migrations"
 * rather than erroring — there is simply no known baseline to migrate from.
 *
 * External sources are re-resolved per pin (`refreshSources`): the re-render re-fetches each git
 * source so a MOVED ref (e.g. a branch that advanced) is observed rather than served stale from
 * the session cache, and the resolved commits are diffed against the lock's recorded provenance
 * to report per-source version moves (#125). `sourceMoves` carries that diff.
 *
 * Returns a structured result; the CLI is responsible for presentation.
 */
export function upgrade({
  toolkitRoot,
  cwd,
  toolkitVersion,
  toolkitIdentity = null, // #373: what the running CLI IS (release/unreleased/unverified + the ref)
  migrations = MIGRATIONS,
  changelog, // optional raw markdown override; defaults to reading toolkitRoot/CHANGELOG.md
  sourceCacheDir, // optional cache dir override (threaded to render); default keeps prod behavior
  log = () => {},
}) {
  const notes = [];
  const lock = readLock(cwd);
  const fromVersion = lock?.toolkitVersion ?? null;
  // `toVersion` is the running CLI's own package.json version, and #373 is what finally makes that
  // honest: the CLI now REFUSES to upgrade from a toolkit that is not a release, so by the time we
  // are here, `toolkitVersion` names a tag whose content is exactly what we are about to render. It
  // used to be a number the default branch merely carried around.
  const toVersion = toolkitVersion;
  // Snapshot the pre-render per-source provenance so we can diff resolved commits after re-render.
  const oldSources = new Map((lock?.sources ?? []).map((s) => [s.name, s]));

  // Decide whether we have a baseline to migrate from, and describe the move.
  let status;
  let migrate = false;
  if (!lock) {
    status = 'no-lock';
    notes.push(`no ${LOCK_FILE} found — nothing to upgrade from; running a fresh render`);
  } else if (!fromVersion) {
    status = 'no-version';
    notes.push(
      `${LOCK_FILE} records no toolkitVersion (rendered by an older toolkit) — skipping migrations and changelog; re-rendering will stamp ${toVersion}`,
    );
  } else {
    const cmp = compareVersions(fromVersion, toVersion);
    if (cmp < 0) {
      status = 'upgrade';
      migrate = true;
      notes.push(`upgrading ${fromVersion} → ${toVersion}`);
    } else if (cmp === 0) {
      status = 'current';
      notes.push(`already on toolkit ${toVersion} — re-rendering to confirm the tree is in sync`);
    } else {
      status = 'downgrade';
      notes.push(
        `lock is toolkit ${fromVersion}, newer than this CLI (${toVersion}) — re-rendering to the older version; no migrations run`,
      );
    }
  }

  // Changelog delta (only meaningful for a real forward move with a known baseline).
  let changelogDelta = null;
  if (status === 'upgrade') {
    const text = changelog ?? readChangelog(toolkitRoot);
    if (text == null) {
      notes.push(`no ${CHANGELOG_FILE} shipped with this toolkit — skipping the change summary`);
    } else {
      changelogDelta = changelogBetween(text, fromVersion, toVersion);
      if (!changelogDelta) {
        notes.push(`no ${CHANGELOG_FILE} entries between ${fromVersion} and ${toVersion}`);
      }
    }
  }

  // Emit the narrative up front — what's moving and what changed — before the mechanical
  // migration/render logs, so a consumer reads the changelog before it's applied.
  for (const n of notes) log(n);
  if (changelogDelta) {
    log('\nchanges since the version this repo last rendered from:\n');
    log(changelogDelta);
    log('');
  }

  // Migrations.
  let migrationsRun = [];
  if (migrate) {
    migrationsRun = runMigrations({ cwd, fromVersion, toVersion, migrations, log }).map((m) => ({
      version: m.version,
      description: m.description,
    }));
    if (!migrationsRun.length) log(`no migrations registered between ${fromVersion} and ${toVersion}`);
  }

  // Re-render (re-resolving each external source at its pin — refreshSources re-fetches git
  // sources so a moved ref is observed, not served from the session cache), then doctor.
  const render = renderProject({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity, sourceCacheDir, refreshSources: true, log });
  if (!render.ok) {
    return { ok: false, status, fromVersion, toVersion, identity: toolkitIdentity, changelogDelta, migrationsRun, render, doctor: null, sourceMoves: [], notes };
  }

  // Per-source version moves: diff the freshly-resolved commits against the lock's recorded ones.
  const sourceMoves = diffSources(oldSources, render.sources ?? []);
  for (const move of sourceMoves) log(describeSourceMove(move));

  const dr = doctor({ cwd, toolkitVersion, toolkitIdentity, toolkitRoot });

  return {
    ok: render.ok && dr.ok,
    status,
    fromVersion,
    toVersion,
    // The resolved identity of the toolkit that did the upgrade — `{ ref, commit, tag }`. #372
    // consumes it to bump `doctor.toolkitRef` / `waffle.toolkitRef` to the ref that just rendered,
    // which is the pin a consumer's CI must use if it is to reproduce this render.
    identity: toolkitIdentity,
    changelogDelta,
    migrationsRun,
    render,
    doctor: dr,
    sourceMoves,
    notes,
  };
}

/**
 * Diff the lock's recorded per-source provenance (`oldSources`, name → entry) against the
 * freshly-resolved sources from a re-render. Reports a git source whose resolved commit moved
 * (a ref that advanced), plus sources added since / removed since the last lock. A local-path
 * source (no commit) never reports a "moved". Sorted by name for deterministic output.
 */
export function diffSources(oldSources, newSources) {
  const moves = [];
  const newByName = new Map(newSources.map((s) => [s.name, s]));
  for (const s of newSources) {
    const prev = oldSources.get(s.name);
    if (!prev) {
      moves.push({ name: s.name, ref: s.ref ?? null, sourceType: s.sourceType, from: null, to: s.commit ?? null, status: 'added' });
    } else if (s.sourceType === 'git' && (prev.commit ?? null) !== (s.commit ?? null)) {
      moves.push({ name: s.name, ref: s.ref ?? null, sourceType: s.sourceType, from: prev.commit ?? null, to: s.commit ?? null, status: 'moved' });
    }
  }
  for (const [name, prev] of oldSources) {
    if (!newByName.has(name)) {
      moves.push({ name, ref: prev.ref ?? null, sourceType: prev.sourceType, from: prev.commit ?? null, to: null, status: 'removed' });
    }
  }
  return moves.sort((a, b) => a.name.localeCompare(b.name));
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : 'unknown';
}

function describeSourceMove(move) {
  const at = move.ref ? ` (ref ${move.ref})` : '';
  if (move.status === 'moved') return `source ${move.name}${at} moved ${shortSha(move.from)} → ${shortSha(move.to)}`;
  if (move.status === 'added') {
    return `source ${move.name} added${move.sourceType === 'git' ? ` at ${shortSha(move.to)}${at}` : ' (local path)'}`;
  }
  return `source ${move.name} removed${move.sourceType === 'git' ? ` (was ${shortSha(move.from)})` : ''}`;
}

function readChangelog(toolkitRoot) {
  if (!toolkitRoot) return null;
  const file = path.join(toolkitRoot, CHANGELOG_FILE);
  return exists(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Extract the changelog sections for every released version in `(fromVersion, toVersion]`,
 * newest first, as raw markdown. Sections are `## [X.Y.Z] …` blocks (Keep a Changelog
 * style); an `## [Unreleased]` block (or any non-semver heading) is skipped, since the
 * target is always a concrete version. Returns null when nothing in range is found.
 */
export function changelogBetween(text, fromVersion, toVersion) {
  const sections = [];
  // Split on level-2 headings, keeping each heading with its body.
  const parts = String(text).split(/^(?=## )/m);
  for (const part of parts) {
    const head = /^##\s+\[?([^\]\s]+)\]?/.exec(part);
    if (!head) continue;
    const version = head[1];
    if (!parseVersion(version)) continue; // skips "Unreleased" and other non-semver headings
    if (compareVersions(version, fromVersion) > 0 && compareVersions(version, toVersion) <= 0) {
      sections.push({ version, body: part.trim() });
    }
  }
  if (!sections.length) return null;
  sections.sort((a, b) => compareVersions(b.version, a.version));
  return sections.map((s) => s.body).join('\n\n');
}
