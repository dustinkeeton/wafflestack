import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { collectState, formatStateText, STATE_SHAPE_VERSION } from '../lib/state.mjs';
import { sha256 } from '../lib/util.mjs';

// `wafflestack state` (#561): resolved behavioral keys (value, layer, tokens), delegate run files,
// lock status and drift, in one read-only document. The invariants: the layer is reported
// truthfully, the canonical value never carries the overlay, and tree facts come from the tree lock.

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'installer', 'cli.mjs');

const write = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const runCli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd, '--offline'], { encoding: 'utf8', timeout: 60000 });

function fixtureToolkit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-561-'));
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: x\nstacks: [demo]\n');
  write(root, 'stacks/demo/stack.yaml', [
    'name: demo',
    'description: Demo.',
    'skills: [gated]',
    'config:',
    '  demo.gate:',
    '    required: false',
    '    default: true',
    '    modes: [true, false, prompt]',
    '    nonInteractive: false',
    '    flag: { on: "--confirm", off: "--yes" }',
    '    description: >-',
    '      Whether the gated skill pauses. Second sentence stays in the manifest.',
    '  demo.consent:',
    '    required: false',
    '    default: prompt',
    '    modes: [true, false, prompt]',
    '    lockMode: prompt',
    '    nonInteractive: false',
    '    flag: { on: "+go" }',
    '    description: Per-run consent.',
    '  demo.plain:',
    '    required: false',
    '    default: text',
    '    description: Not behavioral.',
    '  git.worktreesDir:',
    '    required: false',
    '    default: .claude/worktrees',
    '    description: Worktrees.',
    '  delegate.checkpointDir:',
    '    required: false',
    '    default: "{{git.worktreesDir}}/.delegate"',
    '    description: Checkpoints.',
    '  delegate.memoryFile:',
    '    required: false',
    '    default: "{{delegate.checkpointDir}}/memory.md"',
    '    description: Memory.',
    '  delegate.memoryMaxBytes:',
    '    required: false',
    '    default: 32',
    '    description: Cap.',
    '',
  ].join('\n'));
  write(root, 'stacks/demo/skills/gated/SKILL.md', [
    '---', 'name: gated', 'description: A gated skill.', '---', '',
    'Gate {{demo.gate}} ({{demo.gate.flag.on}}/{{demo.gate.flag.off}}), consent {{demo.consent}} ({{demo.consent.flag.on}}),',
    'plain {{demo.plain}}, dir {{delegate.checkpointDir}}, memory {{delegate.memoryFile}} ({{delegate.memoryMaxBytes}}), wt {{git.worktreesDir}}.', '',
  ].join('\n'));
  return root;
}

describe('state: behavioral keys, run files, locks, drift (#561)', () => {
  let toolkitRoot;
  let cwd;
  beforeEach(() => {
    toolkitRoot = fixtureToolkit();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-'));
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [demo]\n');
    const result = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  const collect = () => collectState({ cwd, toolkitRoot, toolkitVersion: '0.0.test' });
  const keyOf = (state, key) => state.keys.find((k) => k.key === key);

  test('a key nobody sets resolves to the stack default, with its tokens and modes', () => {
    const state = collect();
    assert.equal(state.version, STATE_SHAPE_VERSION);
    assert.deepEqual(state.keys.map((k) => k.key), ['demo.consent', 'demo.gate'], 'only modes:/flag: keys, sorted');
    const gate = keyOf(state, 'demo.gate');
    assert.equal(gate.value, true);
    assert.equal(gate.source, 'stack-default');
    assert.equal(gate.canonical, true);
    assert.deepEqual(gate.flag, { on: '--confirm', off: '--yes' });
    assert.deepEqual(gate.modes, [true, false, 'prompt']);
    assert.equal(gate.prompt, false);
    assert.equal(gate.nonInteractive, false);
    assert.equal(gate.lockMode, null);
    assert.deepEqual(gate.stacks, ['demo']);
    assert.equal(gate.description, 'Whether the gated skill pauses.');
    const consent = keyOf(state, 'demo.consent');
    assert.equal(consent.prompt, true);
    assert.equal(consent.lockMode, 'prompt');
    assert.deepEqual(consent.flag, { on: '+go', off: null });
  });

  test('a committed value reports the waffle.yaml layer', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [demo]\nconfig:\n  demo:\n    gate: false\n');
    const gate = keyOf(collect(), 'demo.gate');
    assert.equal(gate.value, false);
    assert.equal(gate.source, 'waffle.yaml');
    assert.equal(gate.canonical, false);
  });

  test('an overlay value wins, reports local-overlay, and never reaches the canonical value', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [demo]\nconfig:\n  demo:\n    gate: false\n');
    write(cwd, '.waffle/waffle.local.yaml', 'config:\n  demo:\n    gate: prompt\n');
    const state = collect();
    const gate = keyOf(state, 'demo.gate');
    assert.equal(gate.value, 'prompt');
    assert.equal(gate.prompt, true);
    assert.equal(gate.source, 'local-overlay');
    assert.equal(gate.canonical, false, 'the committed-inputs value must exclude the overlay');
    assert.equal(state.project.localOverlay, true);
  });

  test('run files: an absent checkpoint dir and memory file are reported, paths fully expanded', () => {
    const d = collect().runFiles.delegate;
    assert.equal(d.checkpoints.path, '.claude/worktrees/.delegate');
    assert.equal(d.checkpoints.exists, false);
    assert.equal(d.checkpoints.runs, 0);
    assert.equal(d.checkpoints.latest, null);
    assert.deepEqual(d.memory, { path: '.claude/worktrees/.delegate/memory.md', exists: false, bytes: 0, maxBytes: 32, overCap: false });
  });

  test('run files: the newest checkpoint is picked and its last PRESENT phase named; memory bytes are checked against the cap', () => {
    const dir = '.claude/worktrees/.delegate';
    const doc = (runId, extra) => JSON.stringify({ version: 1, runId, scope: { mode: 'all-open' }, issues: [{ number: 1 }], ...extra });
    write(cwd, `${dir}/delegate-old.json`, doc('delegate-old', {}));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(cwd, dir, 'delegate-old.json'), old, old);
    write(cwd, `${dir}/delegate-new.json`, doc('delegate-new', { classification: [], plan: { groups: [] } }));
    write(cwd, `${dir}/memory.md`, 'x'.repeat(40));

    const d = collect().runFiles.delegate;
    assert.equal(d.checkpoints.exists, true);
    assert.equal(d.checkpoints.runs, 2);
    assert.equal(d.checkpoints.latest.file, `${dir}/delegate-new.json`);
    assert.equal(d.checkpoints.latest.runId, 'delegate-new');
    assert.equal(d.checkpoints.latest.lastPhase, 'plan');
    assert.deepEqual(d.checkpoints.latest.sections, ['scope', 'issues', 'classification', 'plan']);
    assert.equal(d.checkpoints.latest.parseError, null);
    assert.equal(d.memory.exists, true);
    assert.equal(d.memory.bytes, 40);
    assert.equal(d.memory.overCap, true);
  });

  test('run files: a skipped phase stops the phase walk; an unparseable checkpoint is reported, not thrown', () => {
    const dir = '.claude/worktrees/.delegate';
    write(cwd, `${dir}/a.json`, JSON.stringify({ version: 1, runId: 'a', scope: {}, issues: [], plan: {} }));
    assert.equal(collect().runFiles.delegate.checkpoints.latest.lastPhase, 'fetch', 'plan without classification does not count');
    write(cwd, `${dir}/b.json`, '{ nope');
    const latest = collect().runFiles.delegate.checkpoints.latest;
    assert.equal(latest.file, `${dir}/b.json`);
    assert.equal(latest.lastPhase, null);
    assert.match(latest.parseError, /JSON/);
  });

  test('run files: null when no selected stack declares delegate.checkpointDir', () => {
    write(toolkitRoot, 'stacks/demo/stack.yaml', fs.readFileSync(path.join(toolkitRoot, 'stacks/demo/stack.yaml'), 'utf8')
      .replace(/  delegate\.checkpointDir:[\s\S]*?description: Cap\.\n/, '')
      .replace(/, dir \{\{delegate\.checkpointDir\}\}.*\)/, ''));
    write(toolkitRoot, 'stacks/demo/skills/gated/SKILL.md', '---\nname: gated\ndescription: A gated skill.\n---\n\nGate {{demo.gate}} {{demo.consent}}.\n');
    assert.equal(collect().runFiles.delegate, null);
  });

  test('locks: committed only → tree is committed, no divergence; a local lock → tree is local with per-file divergence', () => {
    let locks = collect().locks;
    assert.equal(locks.committed.present, true);
    assert.equal(locks.committed.toolkitVersion, '0.0.test');
    assert.equal(locks.committed.toolkitStatus, null, 'no identity was threaded into this render, so none is recorded');
    assert.ok(locks.committed.files > 0);
    assert.equal(locks.local.present, false);
    assert.equal(locks.tree, 'committed');
    assert.equal(locks.inSync, null);
    assert.equal(locks.divergence, null);

    const committed = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    const [first] = Object.keys(committed.files);
    const local = { ...committed, files: { ...committed.files, [first]: sha256('other'), 'extra.md': sha256('x') } };
    write(cwd, '.waffle/waffle.local.lock.json', JSON.stringify(local));
    locks = collect().locks;
    assert.equal(locks.tree, 'local');
    assert.equal(locks.local.present, true);
    assert.equal(locks.inSync, true, 'same toolkit version and commit');
    assert.deepEqual(locks.divergence, { changed: 1, onlyLocal: 1, onlyCommitted: 0 });
  });

  test('drift: a hand-edit is reported; the check reads through the TREE lock, so a local lock matching the disk is clean', () => {
    const rel = '.claude/skills/gated/SKILL.md';
    fs.appendFileSync(path.join(cwd, rel), '\nhand edit\n');
    let drift = collect().drift;
    assert.equal(drift.ok, false);
    assert.deepEqual(drift.modified, [rel]);

    const committed = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    const local = { ...committed, files: { ...committed.files, [rel]: sha256(fs.readFileSync(path.join(cwd, rel))) } };
    write(cwd, '.waffle/waffle.local.lock.json', JSON.stringify(local));
    drift = collect().drift;
    assert.equal(drift.ok, true, JSON.stringify(drift));
    assert.deepEqual(drift.modified, []);
  });

  test('the skills slot is reserved and empty (#563)', () => {
    assert.deepEqual(collect().skills, {});
  });

  test('the text rendering names each key with its layer and tokens', () => {
    const text = formatStateText(collect());
    assert.match(text, /demo\.gate: true \(stack-default\) — --confirm forces, --yes skips/);
    assert.match(text, /demo\.consent: "prompt" \(stack-default, locked to "prompt"\) — \+go forces/);
    assert.match(text, /checkpoints: \.claude\/worktrees\/\.delegate — absent/);
  });
});

describe('state: CLI surface (#561)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-state-cli-'));
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [github-workflow]\nconfig:\n  project:\n    name: StateFixture\n');
    const result = renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  test('`state --json` is a parseable document with the documented top-level keys and exits 0 even on red drift', () => {
    fs.appendFileSync(path.join(cwd, '.claude/skills/issue/SKILL.md'), '\nhand edit\n');
    const r = runCli(['state', '--json'], cwd);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(doc), ['version', 'cli', 'project', 'keys', 'runFiles', 'locks', 'drift', 'skills']);
    const gate = doc.keys.find((k) => k.key === 'issue.confirmGate');
    assert.deepEqual(gate.flag, { on: '--confirm', off: '--yes' });
    assert.equal(gate.source, 'stack-default');
    assert.equal(doc.drift.ok, false);
    assert.deepEqual(doc.drift.modified, ['.claude/skills/issue/SKILL.md']);
    assert.equal(doc.runFiles.delegate, null, 'github-workflow alone declares no delegate keys');
  });

  test('bare `state` prints the text form; a positional ref is refused', () => {
    const r = runCli(['state'], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wafflestack state — \.waffle\/waffle\.yaml\n/);
    assert.match(r.stdout, /issue\.confirmGate: true \(stack-default\)/);
    const bad = runCli(['state', 'skills/issue'], cwd);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /state takes no refs/);
  });
});
