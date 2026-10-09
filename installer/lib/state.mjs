// @ts-check
// `wafflestack state` (#561, part of #552): ONE read-only view of a consumer repo's resolved
// behavioral keys, run files, and locks, so a mod (the waffle-view pane) or an agent needs no
// second resolver. Reads the overlay ONLY to say which layer a value came from; every tree
// question goes through `readTreeLock` (#317).

import fs from 'node:fs';
import path from 'node:path';
import { loadToolkitWithSources } from './toolkit.mjs';
import { defaultSourceCacheDir } from './sources.mjs';
import { computeSelection } from './refs.mjs';
import { readLock, readLocalLock, readTreeLock, collectUsedKeys } from './render.mjs';
import { lockKeys } from './settings.mjs';
import { doctor } from './doctor.mjs';
import { substitute, PROMPT_MODE, modeMatches, parseFlagPlaceholder } from './template.mjs';
import {
  loadProjectConfig,
  makeResolver,
  resolveLocalConfigFile,
  LOCK_FILE,
  LOCAL_LOCK_FILE,
  LOCAL_CONFIG_FILE,
  CONFIG_FILE,
} from './project.mjs';
import { exists, readYaml, lookupPath } from './util.mjs';

/** @import { Stack, Toolkit } from './toolkit.mjs' */
/** @import { ProjectConfig, Target } from './project.mjs' */

/** The document shape version; bump only on a breaking change to the keys below. */
export const STATE_SHAPE_VERSION = 1;

/** Resolution layers, highest precedence first (FORMAT.md "Behavioral keys"). */
export const LAYERS = /** @type {const} */ (['local-overlay', 'waffle.yaml', 'stack-default']);

/**
 * Delegate checkpoint phases in order, each with the sections its validator requires — mirrors
 * `x-phaseSections` in the delegate skill's `checkpoint.schema.json`.
 */
/** @type {ReadonlyArray<readonly [string, ReadonlyArray<string>]>} */
export const CHECKPOINT_PHASES = [
  ['fetch', ['scope', 'issues']],
  ['classify', ['classification']],
  ['plan', ['plan']],
  ['execute', ['execution']],
  ['report', ['report']],
];

/** @type {ReadonlyArray<'on'|'off'>} the two sides of a `flag:` map, in display order */
const FLAG_SIDES = ['on', 'off'];

const CHECKPOINT_DIR_KEY = 'delegate.checkpointDir';
const MEMORY_FILE_KEY = 'delegate.memoryFile';
const MEMORY_CAP_KEY = 'delegate.memoryMaxBytes';

/**
 * The run files a skill WRITES, as the config keys naming their paths (#563). No manifest
 * declares this, so it is a table: a skill absent here writes none the pane should show. The
 * delegate entry is joined by its newest checkpoint file at collection time.
 */
/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
export const SKILL_RUN_FILE_KEYS = {
  delegate: [CHECKPOINT_DIR_KEY, MEMORY_FILE_KEY],
  autopilot: ['autopilot.planDir'],
};

/**
 * @typedef {typeof LAYERS[number]} Layer
 *
 * @typedef {object} BehavioralKey one `modes:`/`flag:` config key, resolved
 * @property {string} key the dotted config key
 * @property {string[]} stacks the selected stacks declaring it
 * @property {any} value the effective mode (overlay included — what this machine's render uses)
 * @property {Layer} source the layer `value` came from
 * @property {any} canonical the committed-inputs mode (overlay excluded — what the shared lock renders)
 * @property {any} default the stack's `default:`
 * @property {any[]} modes the closed `modes:` list, or `[]` for a `flag:`-only key
 * @property {boolean} prompt whether `value` is the reserved `prompt` mode
 * @property {any} nonInteractive the `nonInteractive:` fallback, or null when the key is not promptable
 * @property {any} lockMode the `lockMode:` pin, or null
 * @property {{ on: string|null, off: string|null } | null} flag the invocation tokens, or null when the key has no `flag:`
 * @property {string} description the key's `description:`, one line
 *
 * @typedef {object} CheckpointFacts the newest `<runId>.json` under `delegate.checkpointDir`
 * @property {string} file repo-relative path
 * @property {string} runId the document's `runId`, or the file's basename when unparseable
 * @property {string} mtime ISO timestamp
 * @property {string|null} lastPhase the last phase whose required sections are all PRESENT (shape only — the skill's `checkpoint.mjs` is what validates)
 * @property {string[]} sections the top-level section names present
 * @property {string|null} parseError set when the file is not JSON; `lastPhase` and `sections` are then empty
 *
 * @typedef {object} DelegateFacts
 * @property {{ path: string, exists: boolean, runs: number, latest: CheckpointFacts|null }} checkpoints
 * @property {{ path: string, exists: boolean, bytes: number, maxBytes: number|null, overCap: boolean }} memory
 *
 * @typedef {object} LockFacts
 * @property {string} path repo-relative
 * @property {boolean} present
 * @property {string|null} toolkitVersion
 * @property {string|null} toolkitStatus the lock's `toolkit.status` (`release` / `unreleased` / `unverified`), null when unrecorded
 * @property {string|null} toolkitRef the lock's `toolkit.ref` pin, null unless a release
 * @property {number} files tracked-file count
 *
 * @typedef {object} StateBundle
 * @property {number} version STATE_SHAPE_VERSION
 * @property {{ version: string, status: string, commit: string|null }} cli the CLI that collected this
 * @property {{ targets: Target[], stacks: string[], include: string[], eject: string[], localOverlay: boolean, errors: string[] }} project
 * @property {BehavioralKey[]} keys sorted by key
 * @property {{ delegate: DelegateFacts|null }} runFiles `delegate` is null when no selected stack declares `delegate.checkpointDir`
 * @property {{ committed: LockFacts, local: LockFacts, tree: 'local'|'committed'|null, inSync: boolean|null, divergence: { changed: number, onlyLocal: number, onlyCommitted: number } | null }} locks
 * @property {{ ok: boolean, modified: string[], missing: string[], absentDocs: string[], notes: string[] }} drift the plain `doctor` verdict against the tree lock
 * @property {Record<string, ConfigValue>} config every declared key across the selected stacks, resolved (#563); `keys` is the behavioral subset with its mode machinery
 * @property {Record<string, SkillContext>} skills per selected skill: the declared keys its files reference and the run files it writes (#563)
 *
 * @typedef {object} ConfigValue one declared config key, resolved
 * @property {any} value the effective value, nested `{{…}}` expanded (overlay included); null when unset
 * @property {Layer} source the layer `value` came from
 * @property {string[]} stacks the selected stacks declaring it
 *
 * @typedef {object} SkillContext what one skill cares about
 * @property {string[]} keys the declared keys the skill's files reference (flag placeholders fold onto their key), sorted
 * @property {string[]} files repo-relative run files the skill writes (`SKILL_RUN_FILE_KEYS`, expanded; delegate adds its newest checkpoint)
 */

/**
 * Collect the state. Throws when `.waffle/waffle.yaml` is absent — with no config there is no state.
 *
 * @param {{ cwd: string, toolkitRoot: string, toolkitVersion: string, toolkitIdentity?: import('./toolkit-ref.mjs').ToolkitIdentity|null, sourceCacheDir?: string }} opts
 * @returns {StateBundle}
 */
export function collectState({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity = null, sourceCacheDir = defaultSourceCacheDir() }) {
  const project = loadProjectConfig(cwd);
  const overlayFile = resolveLocalConfigFile(cwd).file;
  const localOverlay = exists(overlayFile);
  const canonical = localOverlay ? loadProjectConfig(cwd, [], { canonical: true }) : project;
  const overlayValues = localOverlay ? (readYaml(overlayFile)?.config ?? {}) : {};

  const toolkit = loadToolkitWithSources({
    builtinRoot: toolkitRoot,
    externalStacks: project.externalStacks ?? [],
    cwd,
    cacheDir: sourceCacheDir,
    refreshSources: false,
  });
  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const trackedFiles = new Set(lockKeys(readTreeLock(cwd)));
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);

  /** @type {Map<string, Stack>} selected stacks, in selection order */
  const stacks = new Map();
  for (const sel of selection.items) if (!stacks.has(sel.stackName)) stacks.set(sel.stackName, sel.stack);
  const target = project.targets[0] ?? 'claude';
  const delegate = delegateFacts(cwd, stacks, project, target);

  return {
    version: STATE_SHAPE_VERSION,
    cli: { version: toolkitVersion, status: toolkitIdentity?.status ?? 'unverified', commit: toolkitIdentity?.commit ?? null },
    project: {
      targets: project.targets,
      stacks: enabledStacks,
      include: project.include,
      eject: project.eject,
      localOverlay,
      errors: selection.errors,
    },
    keys: resolveBehavioralKeys(stacks, { project, canonical, overlayValues, target }),
    runFiles: { delegate },
    locks: lockFacts(cwd),
    drift: driftFacts(cwd, toolkitVersion, toolkitIdentity),
    config: resolveConfig(stacks, { project, overlayValues, canonical, target }),
    skills: resolveSkills(selection.items, { project, target, delegate }),
  };
}

/**
 * Every declared key across the selected stacks, resolved through the same layers as `keys`.
 *
 * @param {Map<string, Stack>} stacks
 * @param {{ project: ProjectConfig, canonical: ProjectConfig, overlayValues: Record<string, any>, target: Target }} ctx
 * @returns {Record<string, ConfigValue>}
 */
export function resolveConfig(stacks, { project, canonical, overlayValues, target }) {
  /** @type {Map<string, ConfigValue>} */
  const byKey = new Map();
  for (const [stackName, stack] of stacks) {
    const resolve = makeResolver(stack, project.values, target);
    for (const key of Object.keys(stack.config ?? {})) {
      const existing = byKey.get(key);
      if (existing) {
        existing.stacks.push(stackName);
        continue;
      }
      const raw = resolve(key);
      const value = typeof raw === 'string' ? expandKey(stack, project, target, key) ?? raw : raw ?? null;
      byKey.set(key, { value, source: layerOf(key, overlayValues, canonical.values), stacks: [stackName] });
    }
  }
  return Object.fromEntries([...byKey].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The per-skill context map: keys from the placeholders the skill's own files reference (what
 * `render` would substitute into it), files from `SKILL_RUN_FILE_KEYS`. A skill name selected
 * from two stacks merges.
 *
 * @param {import('./refs.mjs').SelectionItem[]} items
 * @param {{ project: ProjectConfig, target: Target, delegate: DelegateFacts|null }} ctx
 * @returns {Record<string, SkillContext>}
 */
export function resolveSkills(items, { project, target, delegate }) {
  /** @type {Map<string, { keys: Set<string>, files: Set<string> }>} */
  const bySkill = new Map();
  for (const sel of items) {
    if (sel.kind !== 'skills') continue;
    const { stack } = sel;
    const entry = bySkill.get(sel.item.name) ?? { keys: new Set(), files: new Set() };
    bySkill.set(sel.item.name, entry);
    for (const used of collectUsedKeys([sel])) {
      const key = parseFlagPlaceholder(used)?.key ?? used;
      if (stack.declared.has(key)) entry.keys.add(key);
    }
    for (const key of SKILL_RUN_FILE_KEYS[sel.item.name] ?? []) {
      if (!stack.declared.has(key)) continue;
      const rel = expandKey(stack, project, target, key);
      if (rel) entry.files.add(rel);
      if (key === CHECKPOINT_DIR_KEY && delegate?.checkpoints.latest) entry.files.add(delegate.checkpoints.latest.file);
    }
  }
  return Object.fromEntries(
    [...bySkill]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, { keys, files }]) => [name, { keys: [...keys].sort(), files: [...files] }]),
  );
}

/**
 * Every `modes:`/`flag:` key across the selected stacks, one entry per key.
 *
 * @param {Map<string, Stack>} stacks
 * @param {{ project: ProjectConfig, canonical: ProjectConfig, overlayValues: Record<string, any>, target: Target }} ctx
 * @returns {BehavioralKey[]}
 */
export function resolveBehavioralKeys(stacks, { project, canonical, overlayValues, target }) {
  /** @type {Map<string, BehavioralKey>} */
  const byKey = new Map();
  for (const [stackName, stack] of stacks) {
    const resolve = makeResolver(stack, project.values, target);
    const resolveCanonical = makeResolver(stack, canonical.values, target);
    for (const [key, spec] of Object.entries(stack.config ?? {})) {
      if (!isBehavioral(spec)) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.stacks.push(stackName);
        continue;
      }
      const value = resolve(key);
      const flag = spec.flag && typeof spec.flag === 'object' && !Array.isArray(spec.flag)
        ? { on: spec.flag.on ?? null, off: spec.flag.off ?? null }
        : null;
      byKey.set(key, {
        key,
        stacks: [stackName],
        value,
        source: layerOf(key, overlayValues, canonical.values),
        canonical: resolveCanonical(key),
        default: spec.default,
        modes: Array.isArray(spec.modes) ? spec.modes : [],
        prompt: modeMatches(PROMPT_MODE, value),
        nonInteractive: spec.nonInteractive ?? null,
        lockMode: spec.lockMode ?? null,
        flag,
        description: firstSentence(spec.description),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The first sentence of a `description:`, whitespace-collapsed — the full prose stays in `stack.yaml`.
 * @param {unknown} text
 */
function firstSentence(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat);
  return m ? m[1] : flat;
}

/** @param {any} spec */
function isBehavioral(spec) {
  return Boolean(spec) && typeof spec === 'object' && (Array.isArray(spec.modes) || (spec.flag && typeof spec.flag === 'object'));
}

/**
 * @param {string} key
 * @param {Record<string, any>} overlayValues
 * @param {Record<string, any>} committedValues
 * @returns {Layer}
 */
function layerOf(key, overlayValues, committedValues) {
  if (lookupPath(overlayValues, key) !== undefined) return 'local-overlay';
  if (lookupPath(committedValues, key) !== undefined) return 'waffle.yaml';
  return 'stack-default';
}

/**
 * Fully expand a config key through nested `{{…}}` substitution (a default such as
 * `{{git.worktreesDir}}/.delegate` composes), returning null when it cannot resolve.
 *
 * @param {Stack} stack
 * @param {ProjectConfig} project
 * @param {Target} target
 * @param {string} key
 * @returns {string|null}
 */
function expandKey(stack, project, target, key) {
  /** @type {string[]} */
  const errors = [];
  const out = substitute(`{{${key}}}`, makeResolver(stack, project.values, target), stack.declared, errors, 'state', undefined);
  return errors.length || out === `{{${key}}}` ? null : out;
}

/**
 * @param {string} cwd
 * @param {Map<string, Stack>} stacks
 * @param {ProjectConfig} project
 * @param {Target} target
 * @returns {DelegateFacts|null}
 */
function delegateFacts(cwd, stacks, project, target) {
  const stack = [...stacks.values()].find((s) => CHECKPOINT_DIR_KEY in (s.config ?? {}));
  if (!stack) return null;
  const dirRel = expandKey(stack, project, target, CHECKPOINT_DIR_KEY) ?? '';
  const memoryRel = expandKey(stack, project, target, MEMORY_FILE_KEY) ?? path.posix.join(dirRel, 'memory.md');
  const capRaw = makeResolver(stack, project.values, target)(MEMORY_CAP_KEY);
  const maxBytes = Number.isInteger(Number(capRaw)) && Number(capRaw) > 0 ? Number(capRaw) : null;

  const dirAbs = path.join(cwd, dirRel);
  const dirExists = dirRel !== '' && exists(dirAbs) && fs.statSync(dirAbs).isDirectory();
  /** @type {{ name: string, mtimeMs: number }[]} */
  const runs = dirExists
    ? fs.readdirSync(dirAbs)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dirAbs, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    : [];
  const newest = runs[0];

  const memoryAbs = path.join(cwd, memoryRel);
  const memoryExists = exists(memoryAbs) && fs.statSync(memoryAbs).isFile();
  const bytes = memoryExists ? fs.statSync(memoryAbs).size : 0;
  return {
    checkpoints: {
      path: dirRel,
      exists: dirExists,
      runs: runs.length,
      latest: newest ? checkpointFacts(path.join(dirAbs, newest.name), path.posix.join(dirRel, newest.name), newest.mtimeMs) : null,
    },
    memory: { path: memoryRel, exists: memoryExists, bytes, maxBytes, overCap: maxBytes !== null && bytes > maxBytes },
  };
}

/**
 * @param {string} abs
 * @param {string} rel
 * @param {number} mtimeMs
 * @returns {CheckpointFacts}
 */
function checkpointFacts(abs, rel, mtimeMs) {
  const base = { file: rel, runId: path.basename(rel, '.json'), mtime: new Date(mtimeMs).toISOString() };
  /** @type {any} */
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { ...base, lastPhase: null, sections: [], parseError: err instanceof Error ? err.message : String(err) };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ...base, lastPhase: null, sections: [], parseError: 'checkpoint is not a JSON object' };
  }
  const sections = Object.keys(doc).filter((k) => CHECKPOINT_PHASES.some(([, s]) => s.includes(k)));
  /** @type {string|null} */
  let lastPhase = null;
  for (const [phase, required] of CHECKPOINT_PHASES) {
    if (!required.every((s) => s in doc)) break;
    lastPhase = phase;
  }
  return { ...base, runId: typeof doc.runId === 'string' ? doc.runId : base.runId, lastPhase, sections, parseError: null };
}

/** @param {string} cwd @returns {StateBundle['locks']} */
function lockFacts(cwd) {
  const committedDoc = readLock(cwd);
  const localDoc = readLocalLock(cwd);
  const committed = describeLock(LOCK_FILE, committedDoc);
  const local = describeLock(LOCAL_LOCK_FILE, localDoc);
  const tree = localDoc ? 'local' : committedDoc ? 'committed' : null;
  if (!localDoc || !committedDoc) return { committed, local, tree, inSync: null, divergence: null };

  const a = committedDoc.files ?? {};
  const b = localDoc.files ?? {};
  const divergence = { changed: 0, onlyLocal: 0, onlyCommitted: 0 };
  for (const rel of Object.keys(a)) {
    if (!(rel in b)) divergence.onlyCommitted++;
    else if (a[rel] !== b[rel]) divergence.changed++;
  }
  for (const rel of Object.keys(b)) if (!(rel in a)) divergence.onlyLocal++;
  const inSync = committed.toolkitVersion === local.toolkitVersion && (committedDoc.toolkit?.commit ?? null) === (localDoc.toolkit?.commit ?? null);
  return { committed, local, tree, inSync, divergence };
}

/** @param {string} rel @param {any} doc @returns {LockFacts} */
function describeLock(rel, doc) {
  if (!doc) return { path: rel, present: false, toolkitVersion: null, toolkitStatus: null, toolkitRef: null, files: 0 };
  return {
    path: rel,
    present: true,
    toolkitVersion: doc.toolkitVersion ?? null,
    toolkitStatus: doc.toolkit?.status ?? null,
    toolkitRef: doc.toolkit?.ref ?? null,
    files: Object.keys(doc.files ?? {}).length,
  };
}

/**
 * Plain `doctor` (no toolkit root): drift only, no prerequisite probes, no shelling out.
 *
 * @param {string} cwd
 * @param {string} toolkitVersion
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} toolkitIdentity
 * @returns {StateBundle['drift']}
 */
function driftFacts(cwd, toolkitVersion, toolkitIdentity) {
  try {
    const r = doctor({ cwd, toolkitVersion, toolkitIdentity });
    return { ok: r.ok, modified: r.modified, missing: r.missing, absentDocs: r.absentDocs, notes: r.notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, modified: [], missing: [], absentDocs: [], notes: [`doctor could not run: ${message}`] };
  }
}

/**
 * The human-readable default. Ends in a newline.
 *
 * @param {StateBundle} s
 * @returns {string}
 */
export function formatStateText(s) {
  const lines = [`wafflestack state — ${CONFIG_FILE}${s.project.localOverlay ? ` + ${LOCAL_CONFIG_FILE}` : ''}`];
  lines.push(`  targets: ${s.project.targets.join(', ') || '(none)'}`);
  lines.push(`  stacks:  ${s.project.stacks.join(', ') || '(none)'}`);
  if (s.project.include.length) lines.push(`  include: ${s.project.include.join(', ')}`);
  for (const err of s.project.errors) lines.push(`  selection problem: ${err}`);

  lines.push('', 'behavioral keys:');
  if (!s.keys.length) lines.push('  (none declared by the selected stacks)');
  for (const k of s.keys) {
    const flag = k.flag;
    const tokens = flag ? FLAG_SIDES.filter((side) => flag[side]).map((side) => `${flag[side]} ${side === 'on' ? 'forces' : 'skips'}`).join(', ') : '';
    const locked = k.lockMode !== null ? `, locked to ${JSON.stringify(k.lockMode)}` : '';
    lines.push(`  ${k.key}: ${JSON.stringify(k.value)} (${k.source}${locked})${tokens ? ` — ${tokens}` : ''}`);
  }

  const d = s.runFiles.delegate;
  lines.push('', 'run files:');
  if (!d) lines.push('  (no selected stack declares delegate.checkpointDir)');
  else {
    const c = d.checkpoints;
    lines.push(`  checkpoints: ${c.path} — ${c.exists ? `${c.runs} run file(s)` : 'absent'}`);
    if (c.latest) {
      lines.push(`    latest: ${c.latest.file} — ${c.latest.parseError ? `unparseable (${c.latest.parseError})` : `last phase present: ${c.latest.lastPhase ?? 'none'}`}`);
    }
    lines.push(`  memory: ${d.memory.path} — ${d.memory.exists ? `${d.memory.bytes}/${d.memory.maxBytes ?? '?'} bytes${d.memory.overCap ? ' OVER CAP' : ''}` : 'absent'}`);
  }

  lines.push('', 'locks:');
  for (const l of [s.locks.committed, s.locks.local]) {
    lines.push(`  ${l.path}: ${l.present ? `${l.files} files, toolkit ${l.toolkitVersion ?? '?'} (${l.toolkitStatus ?? 'unrecorded'})` : 'absent'}`);
  }
  if (s.locks.divergence) {
    const v = s.locks.divergence;
    lines.push(`  overlay render ${s.locks.inSync ? 'in sync with' : 'OUT OF SYNC with'} the committed lock — ${v.changed} changed, ${v.onlyLocal} local-only, ${v.onlyCommitted} committed-only`);
  }

  lines.push('', `drift: ${s.drift.ok ? 'clean' : 'RED'} — ${s.drift.modified.length} modified, ${s.drift.missing.length} missing, ${s.drift.absentDocs.length} absent generated docs`);
  for (const f of s.drift.modified) lines.push(`  modified: ${f}`);
  for (const f of s.drift.missing) lines.push(`  missing:  ${f}`);
  lines.push(`cli: ${s.cli.version} (${s.cli.status})`);
  return `${lines.join('\n')}\n`;
}
