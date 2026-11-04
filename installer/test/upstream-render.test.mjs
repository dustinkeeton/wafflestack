// Upstream-pinned skills render verbatim and carry provenance in the lock (#827, part of #825):
// render, lock block, doctor, eject, report, upgrade, state/config/validate over a fixture toolkit.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { validateToolkit } from '../lib/validate.mjs';
import { renderProject, readLock, readLocalLock } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { eject } from '../lib/eject.mjs';
import { collectReport, formatReportMarkdown, redact } from '../lib/report.mjs';
import { upgrade, diffUpstream } from '../lib/upgrade.mjs';
import { collectState } from '../lib/state.mjs';
import { collectConfig } from '../lib/config.mjs';
import { upstreamHash, upstreamLockEntries } from '../lib/upstream.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BUMPED = 'fedcba9876543210fedcba9876543210fedcba98';
const VERSION = '0.0.test';
const ITEM = 'vendor/skills/echo';
const ECHO = 'stacks/vendor/skills/echo';
// Each would fail an ordinary render: undeclared-flag token, required key, harness built-in.
const LITERALS = ['{{not.a.key}}', '{{harness.skillsDir}}', '{{vendor.mode.flag.on}}', '{{vendor.required}}'];
const ECHO_SKILL = `---\nname: echo\ndescription: Echo {{not.a.key}} skill.\n---\n\nEcho body: ${LITERALS.join(' ')}\n`;

let roots = [];
const track = (root) => (roots.push(root), root);
const tmp = (prefix) => track(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const listFiles = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();

/** Write (or re-write, for a bump) the `vendor` stack.yaml + registry with `echo` pinned at `commit`. */
function writeManifest(root, { commit = COMMIT, pinned = true } = {}) {
  const pin = { repo: 't3dotgg/tstack', path: 'skills/echo', commit, license: 'MIT' };
  const hash = upstreamHash(path.join(root, ECHO), listFiles(path.join(root, ECHO)));
  const manifest = {
    name: 'vendor',
    description: 'Stack vendor.',
    agents: ['scout'],
    skills: ['plain', pinned ? { name: 'echo', upstream: { ...pin, hash } } : 'echo'],
    config: {
      'vendor.mode': { description: 'A mode.', default: 'fast' },
      'vendor.required': { description: 'Needed.', required: true },
    },
  };
  write(root, 'stacks/vendor/stack.yaml', YAML.stringify(manifest));
  const entry = (name, kind, rel, extra = {}) => ({ name, kind, stack: 'vendor', path: rel, status: 'stable', ...extra });
  const waffles = [
    entry('scout', 'agent', 'stacks/vendor/agents/scout.md'),
    entry('plain', 'skill', 'stacks/vendor/skills/plain'),
    entry('echo', 'skill', ECHO, pinned ? { upstream: pin } : {}),
  ];
  write(root, 'stacks/registry.yaml', YAML.stringify({ waffles }));
}

function makeToolkit(opts) {
  const root = tmp('toolkit-upstream-render-');
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: upstream render fixture\nstacks: [vendor]\n');
  write(root, 'stacks/vendor/agents/scout.md', '---\nname: scout\ndescription: Scout agent.\n---\n\nScout needs {{vendor.required}}.\n');
  write(root, 'stacks/vendor/skills/plain/SKILL.md', '---\nname: plain\ndescription: Plain skill.\n---\n\nPlain {{vendor.mode}} in {{harness.skillsDir}}.\n');
  write(root, `${ECHO}/SKILL.md`, ECHO_SKILL);
  write(root, `${ECHO}/notes/extra.md`, 'Extra {{not.a.key}} notes.\n');
  write(root, `${ECHO}/run.sh`, '#!/bin/sh\necho "{{vendor.mode}}"\n');
  write(root, `${ECHO}/LICENSE`, 'MIT License\n\nCopyright (c) upstream\n');
  writeManifest(root, opts);
  return root;
}

function makeProject(config) {
  const cwd = tmp('project-upstream-render-');
  write(cwd, '.waffle/waffle.yaml', YAML.stringify({ targets: ['claude'], stacks: ['vendor'], config: { vendor: { required: 'yes' } }, ...config }));
  return cwd;
}

const render = (toolkitRoot, cwd) => renderProject({ toolkitRoot, cwd, toolkitVersion: VERSION });
const read = (root, rel) => fs.readFileSync(path.join(root, rel));
const ECHO_FILES = ['LICENSE', 'SKILL.md', path.join('notes', 'extra.md'), 'run.sh'];

describe('render: an upstream-pinned skill renders verbatim (#827)', () => {
  test('every rendered file equals the copy on both targets; an unpinned sibling still substitutes', () => {
    const toolkit = makeToolkit();
    const cwd = makeProject({ targets: ['claude', 'agents-dir'] });
    const result = render(toolkit, cwd);
    assert.equal(result.ok, true, result.errors?.join('\n'));
    for (const dir of ['.claude/skills/echo', '.agents/skills/echo']) {
      for (const rel of ECHO_FILES) assert.ok(read(cwd, path.join(dir, rel)).equals(read(toolkit, path.join(ECHO, rel))), `${dir}/${rel}`);
    }
    const skill = read(cwd, '.claude/skills/echo/SKILL.md').toString();
    for (const literal of LITERALS) assert.ok(skill.includes(literal), literal);
    assert.match(read(cwd, '.claude/skills/plain/SKILL.md').toString(), /Plain fast in \.claude\/skills\./);
  });

  test('a pinned skill demands no config; the same text unpinned fails the render (control)', () => {
    const cwd = makeProject({ stacks: [], include: ['skills/echo'], config: {} });
    assert.equal(render(makeToolkit(), cwd).ok, true);
    const control = render(makeToolkit({ pinned: false }), makeProject({ stacks: [], include: ['skills/echo'], config: {} }));
    assert.equal(control.ok, false);
    assert.match(control.errors.join('\n'), /needs config values: config\.vendor\.required/);
  });

  test('a project extension still appends inside its markers; other files stay byte-equal', () => {
    const toolkit = makeToolkit();
    const cwd = makeProject();
    write(cwd, '.waffle/extensions/skills/echo.md', 'Local {{vendor.mode}} note.\n');
    assert.equal(render(toolkit, cwd).ok, true);
    const skill = read(cwd, '.claude/skills/echo/SKILL.md').toString();
    const [before, after] = skill.split('<!-- BEGIN project extension: .waffle/extensions/skills/echo.md -->');
    assert.equal(before.trimEnd(), ECHO_SKILL.trimEnd());
    assert.match(after, /Local \{\{vendor\.mode\}\} note\.\n\n<!-- END project extension -->\n$/);
    assert.ok(read(cwd, '.claude/skills/echo/notes/extra.md').equals(read(toolkit, `${ECHO}/notes/extra.md`)));
  });

  test('skills.modelInvocation patches the claude SKILL.md only; the cross-tool copy stays verbatim', () => {
    const toolkit = makeToolkit();
    const cwd = makeProject({ targets: ['claude', 'agents-dir'], skills: { modelInvocation: { disabled: ['echo'] } } });
    assert.equal(render(toolkit, cwd).ok, true);
    assert.match(read(cwd, '.claude/skills/echo/SKILL.md').toString(), /disable-model-invocation: true/);
    assert.ok(read(cwd, '.agents/skills/echo/SKILL.md').equals(read(toolkit, `${ECHO}/SKILL.md`)));
  });

  test('the waffledocs overview quotes the pinned description raw', () => {
    const cwd = makeProject();
    assert.equal(render(makeToolkit(), cwd).ok, true);
    assert.match(read(cwd, '.waffle/CHEATSHEET.md').toString(), /Echo \{\{not\.a\.key\}\} skill\./);
  });
});

describe('lock: the `upstream` provenance block (#827)', () => {
  const expected = (files) => [{ item: ITEM, repo: 't3dotgg/tstack', path: 'skills/echo', commit: COMMIT, files }];

  test('records { item, repo, path, commit, files } after `sources` and before `files`, byte-stable', () => {
    const toolkit = makeToolkit();
    const cwd = makeProject({ targets: ['claude', 'agents-dir'] });
    assert.equal(render(toolkit, cwd).ok, true);
    const files = ['.agents', '.claude'].flatMap((d) => ECHO_FILES.map((f) => path.join(d, 'skills', 'echo', f))).sort((a, b) => a.localeCompare(b));
    const lock = readLock(cwd);
    assert.deepEqual(lock.upstream, expected(files));
    const keys = Object.keys(lock);
    assert.equal(keys.indexOf('upstream') + 1, keys.indexOf('files'));
    const bytes = read(cwd, '.waffle/waffle.lock.json');
    assert.equal(render(toolkit, cwd).ok, true);
    assert.ok(read(cwd, '.waffle/waffle.lock.json').equals(bytes));
  });

  test('absent when no pinned skill is selected', () => {
    const cwd = makeProject({ stacks: [], include: ['skills/plain'] });
    assert.equal(render(makeToolkit(), cwd).ok, true);
    assert.equal('upstream' in readLock(cwd), false);
  });

  test('a no-op overlay writes no local lock; one that moves a byte writes the same block there', () => {
    const toolkit = makeToolkit();
    const cwd = makeProject();
    write(cwd, '.waffle/waffle.local.yaml', YAML.stringify({ config: { vendor: { required: 'yes' } } }));
    assert.equal(render(toolkit, cwd).ok, true);
    assert.equal(readLocalLock(cwd), null);
    write(cwd, '.waffle/waffle.local.yaml', YAML.stringify({ config: { vendor: { mode: 'slow' } } }));
    assert.equal(render(toolkit, cwd).ok, true);
    assert.deepEqual(readLocalLock(cwd).upstream, readLock(cwd).upstream);
  });

  test('upstreamLockEntries skips a pin missing its repo, path or commit, and an item with no files', () => {
    const groups = new Map([['s', { stack: { name: 's' }, items: [
      { kind: 'skills', item: { name: 'a', upstream: { isMap: true, repo: 'o/r', path: 'p', commit: null } } },
      { kind: 'skills', item: { name: 'b', upstream: { isMap: true, repo: 'o/r', path: 'p', commit: COMMIT } } },
      { kind: 'skills', item: { name: 'c', upstream: null } },
    ] }]]);
    const producedBy = new Map([['x/a', 's/skills/a'], ['x/c', 's/skills/c']]);
    assert.deepEqual(upstreamLockEntries(groups, producedBy, { 'x/a': 'h', 'x/c': 'h' }), []);
  });
});

describe('doctor: upstream provenance surfaces and verify-render reproduces it (#827)', () => {
  const setup = () => {
    const toolkitRoot = makeToolkit();
    const cwd = makeProject();
    assert.equal(render(toolkitRoot, cwd).ok, true);
    const run = (opts = {}) => doctor({ cwd, toolkitVersion: VERSION, toolkitRoot, ...opts });
    const editLock = (fn) => {
      const lock = readLock(cwd);
      fn(lock);
      write(cwd, '.waffle/waffle.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    };
    return { toolkitRoot, cwd, run, editLock };
  };

  test('an informational note that never flips ok, and the entries on the result', () => {
    const { run } = setup();
    const result = run();
    assert.equal(result.ok, true, result.notes.join('\n'));
    assert.ok(result.notes.includes(`upstream-pinned: ${ITEM} — copied from t3dotgg/tstack/skills/echo @ ${COMMIT.slice(0, 12)}`));
    assert.equal(result.upstream[0].item, ITEM);
  });

  test('a hand-edited pinned file is modified and attributed to its upstream', () => {
    const { cwd, run } = setup();
    fs.appendFileSync(path.join(cwd, '.claude/skills/echo/SKILL.md'), 'edit');
    const result = run();
    assert.equal(result.ok, false);
    const rel = path.join('.claude', 'skills', 'echo', 'SKILL.md');
    assert.deepEqual(result.modified, [rel]);
    assert.equal(result.attribution[rel], `upstream t3dotgg/tstack@${COMMIT.slice(0, 12)}`);
  });

  test('--verify-render is clean, and flags a tampered, deleted or invented entry', () => {
    const { cwd, run, editLock } = setup();
    const verify = () => run({ verifyRender: true }).render;
    assert.equal(verify().ok, true, JSON.stringify(verify()));
    const key = `upstream:${ITEM}`;
    editLock((l) => { l.upstream[0].commit = BUMPED; });
    assert.deepEqual(verify().stale, [key]);
    editLock((l) => { l.upstream[0].commit = COMMIT; l.upstream.push({ ...l.upstream[0], item: 'vendor/skills/ghost' }); });
    assert.deepEqual(verify().absent, ['upstream:vendor/skills/ghost']);
    editLock((l) => { delete l.upstream; });
    const result = verify();
    assert.deepEqual(result.unexpected, [key]);
    assert.equal(result.checked, Object.keys(readLock(cwd).files).length, 'pseudo-keys are not counted as files');
  });

  test('eject drops the entry from both locks, so verify-render finds no absent pin', () => {
    const { toolkitRoot, cwd, run } = setup();
    write(cwd, '.waffle/waffle.local.yaml', YAML.stringify({ config: { vendor: { mode: 'slow' } } }));
    assert.equal(render(toolkitRoot, cwd).ok, true);
    eject({ cwd, item: 'skills/echo' });
    assert.equal('upstream' in readLock(cwd), false);
    assert.equal('upstream' in readLocalLock(cwd), false);
    // eject is render-free (#497): only the overview docs go stale, never the dropped provenance.
    assert.deepEqual(run({ verifyRender: true }).render.absent, []);
    assert.equal(render(toolkitRoot, cwd).ok, true);
    assert.equal(run({ verifyRender: true }).render.ok, true);
  });
});

describe('report and upgrade surface upstream provenance (#827)', () => {
  test('report: lock.upstream, an unredacted repo, and a markdown line only when present', () => {
    const toolkitRoot = makeToolkit();
    const cwd = makeProject();
    assert.equal(render(toolkitRoot, cwd).ok, true);
    const bundle = collectReport({ cwd, toolkitRoot, toolkitVersion: VERSION });
    assert.deepEqual(bundle.lock.upstream, [{ item: ITEM, repo: 't3dotgg/tstack', path: 'skills/echo', commit: COMMIT }]);
    assert.equal(redact('t3dotgg/tstack', { cwd, home: os.homedir() }), 't3dotgg/tstack');
    assert.match(formatReportMarkdown(bundle), /- \*\*upstream-pinned\*\*: vendor\/skills\/echo \(t3dotgg\/tstack\/skills\/echo @ 0123456\)/);
    const plain = makeProject({ stacks: [], include: ['skills/plain'] });
    assert.equal(render(toolkitRoot, plain).ok, true);
    assert.doesNotMatch(formatReportMarkdown(collectReport({ cwd: plain, toolkitRoot, toolkitVersion: VERSION })), /upstream-pinned/);
  });

  test('diffUpstream: added, moved, repointed, removed; an unchanged pin is no move', () => {
    const e = (item, commit, extra = {}) => ({ item, repo: 'o/r', path: 'p', commit, files: [], ...extra });
    const old = new Map([['s/skills/same', e('s/skills/same', COMMIT)], ['s/skills/bump', e('s/skills/bump', COMMIT)],
      ['s/skills/move', e('s/skills/move', COMMIT)], ['s/skills/gone', e('s/skills/gone', COMMIT)]]);
    const next = [e('s/skills/same', COMMIT), e('s/skills/bump', BUMPED), e('s/skills/move', COMMIT, { repo: 'o/other' }), e('s/skills/new', BUMPED)];
    assert.deepEqual(diffUpstream(old, next).map((m) => [m.item, m.status, m.from, m.to]), [
      ['s/skills/bump', 'moved', COMMIT, BUMPED],
      ['s/skills/gone', 'removed', COMMIT, null],
      ['s/skills/move', 'repointed', COMMIT, COMMIT],
      ['s/skills/new', 'added', null, BUMPED],
    ]);
  });

  test('upgrade names a commit-only bump between the old and new lock', () => {
    const toolkitRoot = makeToolkit();
    const cwd = makeProject();
    assert.equal(render(toolkitRoot, cwd).ok, true);
    writeManifest(toolkitRoot, { commit: BUMPED });
    const logs = [];
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: VERSION, changelog: '', log: (l) => logs.push(l) });
    assert.equal(result.ok, true, JSON.stringify(result.render.errors));
    assert.deepEqual(result.upstreamMoves.map((m) => m.status), ['moved']);
    assert.ok(logs.includes(`upstream ${ITEM} (t3dotgg/tstack skills/echo) moved ${COMMIT.slice(0, 12)} → ${BUMPED.slice(0, 12)}`), logs.join('\n'));
    assert.equal(readLock(cwd).upstream[0].commit, BUMPED);
  });
});

describe('state, config and validate read no config from a pinned copy (#827)', () => {
  test('state lists no keys for echo; config omits a key only echo mentions', () => {
    const toolkitRoot = makeToolkit();
    const cwd = makeProject({ stacks: [], include: ['skills/echo'], config: {} });
    assert.equal(render(toolkitRoot, cwd).ok, true);
    assert.deepEqual(collectState({ cwd, toolkitRoot, toolkitVersion: VERSION }).skills.echo.keys, []);
    assert.deepEqual(collectConfig({ cwd, toolkitRoot, toolkitVersion: VERSION }).keys.map((k) => k.key), []);
  });

  test('validate reports no placeholder problem for the copy; the unpinned control does', () => {
    assert.deepEqual(validateToolkit(makeToolkit()), []);
    assert.match(validateToolkit(makeToolkit({ pinned: false })).join('\n'), /vendor\.mode\.flag\.on/);
  });
});
