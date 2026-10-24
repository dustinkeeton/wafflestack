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
  {
    version: '0.18.0',
    description: 'replace the prose `docs.voiceGuardrailSection` with the `docs.protectedDocs` path list in .waffle/waffle.yaml (#612)',
    run(cwd, { log = () => {} } = {}) {
      migrateProtectedDocs(cwd, log);
    },
  },
];

const OLD_GUARDRAIL = ['config', 'docs', 'voiceGuardrailSection'];
const PROTECTED_DOCS = ['config', 'docs', 'protectedDocs'];

// 0.18.0 stack defaults, frozen: a migration is pinned to the version that shipped it.
const DOC_SET_DEFAULTS_0_18 = {
  machineDocSet: 'a root `AGENTS.md`, plus a per-feature `AGENTS.md` in each `src/<feature>/` directory where the codebase is organized that way',
  humanDocSet: '`DECISIONS.md`, `STATUS.md`, and `ARCHITECTURE.md` at the repo root',
};

// Extensionless mixed-case filenames kept as paths (#655); any other capitalized word is prose, like `Never`.
const EXTENSIONLESS_FILES_0_18 = new Set(['Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Justfile', 'Vagrantfile', 'Brewfile', 'Podfile', 'Jenkinsfile', 'Caddyfile', 'Guardfile', 'Berksfile', 'Capfile', 'Snakefile']);

/** @param {string} token @returns {string | null} why the token is not a path, or null when it is one */
function notAPath(token) {
  if (/^docs\.[a-z]+[A-Z][A-Za-z0-9]*$/.test(token)) return 'config key';
  if (!/^[\w.*?/@+~{}[\],!-]+$/.test(token)) return 'not a path';
  if (/[./]/.test(token) || EXTENSIONLESS_FILES_0_18.has(token)) return null;
  return /^[A-Z][A-Z0-9_-]+$/.test(token) || /^_[\w-]+$/.test(token) ? null : 'not a path';
}

/**
 * The backticked paths the retired prose named, in order and deduped, plus every token it skipped.
 * @param {string} text
 * @param {{ exclude?: string[] }} [opts] paths to skip as the agent-managed doc set
 * @returns {{ paths: string[], skipped: { token: string, why: string }[] }}
 */
export function protectedPathsFromProse(text, { exclude = [] } = {}) {
  const paths = [];
  const skipped = [];
  const seen = new Set();
  for (const [, token] of String(text).matchAll(/`([^`]+)`/g)) {
    if (seen.has(token)) continue;
    seen.add(token);
    const why = exclude.includes(token) ? 'agent-managed doc set' : notAPath(token);
    if (why) skipped.push({ token, why });
    else paths.push(token);
  }
  return { paths, skipped };
}

/** @param {YAML.Document} doc @returns {string[]} the doc-set paths the generated section carves out */
function docSetPaths(doc) {
  return Object.entries(DOC_SET_DEFAULTS_0_18).flatMap(([key, fallback]) => {
    const phrase = doc.getIn(['config', 'docs', key]);
    return protectedPathsFromProse(typeof phrase === 'string' ? phrase : fallback).paths;
  });
}

/** The 0.18.0 step (#612): COMMITTED config only, like 0.16.0; an overlay still setting the key is reported. */
function migrateProtectedDocs(cwd, log) {
  const { file } = resolveConfigFile(cwd);
  if (exists(file)) {
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    if (!doc.errors?.length && doc.hasIn(OLD_GUARDRAIL)) migrateGuardrailIn(doc, file, log);
  }
  const overlay = readOverlay(cwd);
  if (overlay?.config?.docs?.voiceGuardrailSection !== undefined) {
    log(`  NOT migrated — ${LOCAL_CONFIG_FILE} sets docs.voiceGuardrailSection, and \`upgrade\` never edits it: replace it with \`docs.protectedDocs\` by hand`);
  }
}

function migrateGuardrailIn(doc, file, log) {
  const old = doc.getIn(OLD_GUARDRAIL);
  const drop = (why) => {
    doc.deleteIn(OLD_GUARDRAIL);
    fs.writeFileSync(file, doc.toString());
    log(`  ${CONFIG_FILE}: ${why}`);
  };
  if (doc.hasIn(PROTECTED_DOCS)) return drop('dropped docs.voiceGuardrailSection — docs.protectedDocs is already set');
  if (typeof old !== 'string' || !old.trim()) {
    doc.setIn(PROTECTED_DOCS, doc.createNode([]));
    return drop('docs.voiceGuardrailSection was empty → docs.protectedDocs: [] (still no guardrail)');
  }
  const { paths, skipped } = protectedPathsFromProse(old, { exclude: docSetPaths(doc) });
  if (skipped.length) {
    const list = skipped.map(({ token, why }) => `\`${token}\` (${why})`).join(', ');
    log(`  docs.voiceGuardrailSection: not carried — ${list}; add any real path to docs.protectedDocs by hand`);
  }
  if (!paths.length) {
    log(`  NOT migrated — ${CONFIG_FILE} docs.voiceGuardrailSection names no backticked paths; replace it with a \`docs.protectedDocs\` list by hand`);
    return;
  }
  doc.setIn(PROTECTED_DOCS, doc.createNode(paths));
  drop(`docs.voiceGuardrailSection → docs.protectedDocs [${paths.join(', ')}] — review it: custom wording is not carried, the section is now generated`);
}

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
