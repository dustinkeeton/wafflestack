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
 * Returns a structured result; the CLI is responsible for presentation.
 */
export function upgrade({
  toolkitRoot,
  cwd,
  toolkitVersion,
  migrations = MIGRATIONS,
  changelog, // optional raw markdown override; defaults to reading toolkitRoot/CHANGELOG.md
  log = () => {},
}) {
  const notes = [];
  const lock = readLock(cwd);
  const fromVersion = lock?.toolkitVersion ?? null;
  const toVersion = toolkitVersion;

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

  // Re-render, then doctor.
  const render = renderProject({ toolkitRoot, cwd, toolkitVersion, log });
  if (!render.ok) {
    return { ok: false, status, fromVersion, toVersion, changelogDelta, migrationsRun, render, doctor: null, notes };
  }
  const dr = doctor({ cwd, toolkitVersion });

  return {
    ok: render.ok && dr.ok,
    status,
    fromVersion,
    toVersion,
    changelogDelta,
    migrationsRun,
    render,
    doctor: dr,
    notes,
  };
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
