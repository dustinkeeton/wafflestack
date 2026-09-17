import fs from 'node:fs';
import YAML from 'yaml';
import { compareVersions, deepMerge, exists, readYaml } from './util.mjs';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  dropIncludeEntries,
  migrateLegacyDotfiles,
  renameLegacyStacksKey,
  resolveConfigFile,
  resolveLocalConfigFile,
} from './project.mjs';
import { includeEjectOverlaps, formatEjectOverlap } from './refs.mjs';

/**
 * Ordered `{ version, description, run(cwd, { log }) }` steps, each keyed by the version that SHIPS
 * the change; every `run` must be idempotent. A key past the package version is PENDING (#501).
 */
export const MIGRATIONS = [
  {
    version: '0.6.0',
    description: 'rename consumer dotfiles .wafflestack.* → .waffle.* (config, local overlay, lock, extensions dir)',
    run(cwd) {
      migrateLegacyDotfiles(cwd);
    },
  },
  {
    version: '0.8.0',
    description: 'move consumer config into .waffle/ (.waffle.yaml → .waffle/waffle.yaml, plus local overlay and lock)',
    run(cwd) {
      // `migrateLegacyDotfiles` chains every legacy generation forward in one pass, so the steps compose in any order.
      migrateLegacyDotfiles(cwd);
    },
  },
  {
    version: '0.10.0',
    description: 'rename consumer config key `bundles:` → `stacks:` in .waffle/waffle.yaml (and the .local overlay)',
    run(cwd) {
      // Move legacy dotfiles first, so config + overlay are at their current paths before the key inside them is renamed.
      migrateLegacyDotfiles(cwd);
      for (const resolve of [resolveConfigFile, resolveLocalConfigFile]) {
        const { file } = resolve(cwd);
        if (!exists(file)) continue;
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        if (renameLegacyStacksKey(doc)) fs.writeFileSync(file, doc.toString());
      }
    },
  },
  {
    version: '0.16.0',
    description: 'drop `include:` entries that `eject:` also names from .waffle/waffle.yaml — the lists are mutually exclusive (#497) and `eject:` was already winning',
    run(cwd, { log = () => {} } = {}) {
      dropIncludeEjectOverlaps(cwd, log);
    },
  },
];

/**
 * The 0.16.0 step (#501): COMMITTED config only. Overlay lists replace the committed ones
 * wholesale, so no overlay edit is behavior-preserving — overlay overlaps are reported (#500).
 */
function dropIncludeEjectOverlaps(cwd, log) {
  const { file } = resolveConfigFile(cwd);
  if (!exists(file)) return;
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors?.length) return; // `render` reports an unparseable config better than this can
  const overlay = readOverlay(cwd);
  const before = overlay ? selectionLists(deepMerge(doc.toJSON(), overlay)) : null;

  const doomed = new Set(includeEjectOverlaps(selectionLists(doc.toJSON())).map((o) => o.include));
  const dropped = dropIncludeEntries(doc, (ref) => doomed.has(ref));
  if (dropped.length) fs.writeFileSync(file, doc.toString());
  for (const ref of dropped) {
    log(`  ${CONFIG_FILE}: dropped \`include:\` entry ${ref} — \`eject:\` names it too, so it was never rendered`);
  }
  if (!overlay) return;

  const rendered = new Set(includeEjectOverlaps(before).map((o) => o.include));
  for (const ref of dropped) {
    if (!before.include.includes(ref) || rendered.has(ref)) continue;
    log(
      `  note: ${LOCAL_CONFIG_FILE} replaces \`eject:\` without ejecting ${ref}, so this machine rendered it ` +
        `through the committed \`include:\` — list it under the overlay's own \`include:\` to keep it here`,
    );
  }
  for (const overlap of includeEjectOverlaps(selectionLists(deepMerge(doc.toJSON(), overlay)))) {
    log(`  NOT migrated — this overlap involves ${LOCAL_CONFIG_FILE}, which \`upgrade\` never edits: ${formatEjectOverlap(overlap)}`);
  }
}

/** A raw parsed config's `include:` / `eject:`, each coerced to a list — a malformed shape is `render`'s to report. */
function selectionLists(cfg) {
  const list = (v) => (Array.isArray(v) ? v : []);
  return { include: list(cfg?.include), eject: list(cfg?.eject) };
}

/** The parsed local overlay, or null when absent or unreadable (`render` reports the latter). */
function readOverlay(cwd) {
  const { file } = resolveLocalConfigFile(cwd);
  if (!exists(file)) return null;
  try {
    return readYaml(file) ?? null;
  } catch {
    return null;
  }
}

/** The newest step version past `version`, else `version` — the ceiling an UNRELEASED toolkit migrates to (#501). */
export function migrationCeiling(version, migrations = MIGRATIONS) {
  return migrations.reduce((top, m) => (compareVersions(m.version, top) > 0 ? m.version : top), version);
}

/** The steps where `fromVersion < step.version <= toVersion`, in ascending version order. */
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) {
  return migrations
    .filter(
      (m) =>
        compareVersions(m.version, fromVersion) > 0 &&
        compareVersions(m.version, toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}

/** Run every applicable migration in order and return the steps that ran; a throwing step aborts the run. */
export function runMigrations({ cwd, fromVersion, toVersion, migrations = MIGRATIONS, log = () => {} }) {
  const steps = applicableMigrations(fromVersion, toVersion, migrations);
  for (const step of steps) {
    log(`migration ${step.version}: ${step.description}`);
    step.run(cwd, { log });
  }
  return steps;
}
