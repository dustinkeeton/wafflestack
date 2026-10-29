import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject, overlayDivergentFiles, overlayLeaks, overlayLeakWarnings } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { upgrade } from '../lib/upgrade.mjs';
import { gitIgnoreStatus } from '../lib/project.mjs';

// #614: an overlay-fed render git would let you commit.

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const HELPER = '.claude/agents/helper.md';

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });

function makeToolkit(root) {
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: test fixture\nstacks: [demo]\n');
  write(root, 'stacks/demo/stack.yaml', 'name: demo\ndescription: Demo.\nagents: [helper]\nskills: []\nconfig:\n  git.botEmail:\n    required: true\n    description: bot email\n');
  write(root, 'stacks/demo/agents/helper.md', '---\nname: helper\ndescription: A helper.\n---\n\nCommit as {{git.botEmail}}.\n');
}

describe('overlayDivergentFiles', () => {
  test('lists differing and effective-only paths, sorted; skips equal and canonical-only', () => {
    assert.deepEqual(overlayDivergentFiles({ a: '1' }, { a: '1' }), []);
    assert.deepEqual(
      overlayDivergentFiles({ b: '1', a: '1', gone: '9' }, { b: '2', a: '1', z: '3', c: '4' }),
      ['b', 'c', 'z'],
    );
  });
});

describe('gitIgnoreStatus', () => {
  let cwd;
  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-status-')); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  test('null outside a git work tree', () => {
    assert.equal(gitIgnoreStatus(cwd, ['a.md']), null);
  });

  test('null when git is unavailable', () => {
    const missing = () => ({ status: null, stdout: '', error: new Error('ENOENT') });
    assert.equal(gitIgnoreStatus(cwd, ['a.md'], missing), null);
  });

  test('reports ignored (incl. directory patterns) and tracked paths', () => {
    git(cwd, 'init', '-q');
    write(cwd, '.gitignore', 'ignored.md\nsub/\n');
    for (const f of ['ignored.md', 'open.md', 'sub/x.md', 'kept.md']) write(cwd, f, 'x\n');
    git(cwd, 'add', 'kept.md');
    const status = gitIgnoreStatus(cwd, ['ignored.md', 'open.md', 'sub/x.md', 'kept.md']);
    assert.deepEqual([...status.ignored].sort(), ['ignored.md', 'sub/x.md']);
    assert.deepEqual([...status.tracked], ['kept.md']);
  });
});

describe('overlay leak warning (#614)', () => {
  let toolkitRoot;
  let cwd;
  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
    makeToolkit(toolkitRoot);
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude, codex]\nstacks: [demo]\nconfig:\n  git:\n    botEmail: bot@example.com\n');
    write(cwd, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: local@example.com\n');
    write(cwd, '.gitignore', '.waffle/waffle.local.yaml\n.waffle/waffle.local.lock.json\n');
  });
  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('render warns per leaked path plus a Posture 2b remedy; silent once gitignored', () => {
    git(cwd, 'init', '-q');
    const first = render();
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    assert.deepEqual(first.overlayLeaks, [HELPER, '.codex/agents/helper.toml']);
    assert.ok(first.warnings.some((w) => w.startsWith(`${HELPER} embeds`) && /not gitignored/.test(w)));
    assert.ok(first.warnings.some((w) => /Posture 2b/.test(w) && /--verify-render/.test(w)));

    fs.appendFileSync(path.join(cwd, '.gitignore'), '.claude/\n.codex/\n');
    const second = render();
    assert.deepEqual(second.overlayLeaks, []);
    assert.ok(!second.warnings.some((w) => /Posture 2b/.test(w)));
  });

  test('a tracked overlay render is flagged even when gitignored', () => {
    git(cwd, 'init', '-q');
    render();
    git(cwd, 'add', HELPER);
    fs.appendFileSync(path.join(cwd, '.gitignore'), '.claude/\n.codex/\n');
    const result = render();
    assert.deepEqual(result.overlayLeaks, [HELPER]);
    assert.ok(result.warnings.some((w) => w.includes(`git rm --cached ${HELPER}`)));
    const summary = result.warnings.find((w) => /not safe to commit/.test(w));
    assert.ok(summary && !/render --gitignore/.test(summary), summary);
  });

  test('no warning without an overlay, or outside a git work tree', () => {
    const outside = render();
    assert.deepEqual(outside.overlayLeaks, []);
    git(cwd, 'init', '-q');
    fs.rmSync(path.join(cwd, '.waffle/waffle.local.yaml'));
    const noOverlay = render();
    assert.deepEqual(noOverlay.overlayLeaks, []);
    assert.ok(!noOverlay.warnings.some((w) => /embeds/.test(w)));
  });

  test('doctor reports leaks without flipping ok; canonical and opt-out skip it', () => {
    git(cwd, 'init', '-q');
    render();
    const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(dr.ok, true, JSON.stringify(dr.notes));
    assert.deepEqual(dr.overlayLeaks, [HELPER, '.codex/agents/helper.toml']);
    assert.ok(dr.notes.some((n) => /not gitignored/.test(n) && /Posture 2b/.test(n)));
    assert.deepEqual(doctor({ cwd, toolkitVersion: '0.0.test', canonical: true }).overlayLeaks, []);
    assert.deepEqual(doctor({ cwd, toolkitVersion: '0.0.test', checkOverlayLeaks: false }).overlayLeaks, []);
  });

  test('doctor notes when git cannot answer', () => {
    render();
    const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.ok(dr.notes.some((n) => /could not check whether overlay-fed renders are gitignored/.test(n)));
    assert.deepEqual(dr.overlayLeaks, []);
  });

  test('upgrade surfaces the leak once — in render warnings, not doctor notes', () => {
    git(cwd, 'init', '-q');
    render();
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.0.test', changelog: '' });
    assert.ok(result.render.warnings.some((w) => /Posture 2b/.test(w)));
    assert.ok(!result.doctor.notes.some((n) => /Posture 2b/.test(n)));
  });

  test('overlayLeaks returns null without git; warnings are empty for no leaks', () => {
    assert.equal(overlayLeaks(cwd, { a: '1' }, { a: '2' }), null);
    assert.deepEqual(overlayLeakWarnings([]), []);
  });
});

describe('render --gitignore offers overlay-fed renders (#614)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-gi-leak-'));
    git(cwd, 'init', '-q');
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\ninclude: [skills/git-workflow]\nconfig:\n  project:\n    name: demo\n  git:\n    botName: Bot\n    botEmail: bot@example.com\n');
  });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });
  const run = () => spawnSync(process.execPath, [CLI, 'render', '--gitignore', '--allow-unreleased', '--cwd', cwd], { encoding: 'utf8' });
  const runDoctor = () => spawnSync(process.execPath, [CLI, 'doctor', '--cwd', cwd], { encoding: 'utf8' });
  const gi = () => fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8');

  test('adds the exact leaked paths, idempotently; unchanged output without an overlay', () => {
    const plain = run();
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.doesNotMatch(gi(), /SKILL\.md/);

    write(cwd, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: local@example.com\n');
    const first = run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stderr, /not gitignored/);
    assert.match(gi(), /^\.claude\/skills\/git-workflow\/SKILL\.md$/m);

    const again = run();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /already lists the recommended entries/);
    assert.doesNotMatch(again.stderr, /not gitignored/);
  });

  test('doctor CLI prints each leaked path until it is gitignored', () => {
    write(cwd, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: local@example.com\n');
    const rendered = spawnSync(process.execPath, [CLI, 'render', '--allow-unreleased', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stdout + rendered.stderr);
    const before = runDoctor();
    assert.equal(before.status, 0, before.stdout + before.stderr);
    assert.match(before.stdout, /^not gitignored \(embeds local overlay\): \.claude\/skills\/git-workflow\/SKILL\.md/m);

    fs.appendFileSync(path.join(cwd, '.gitignore'), '.claude/\n');
    const after = runDoctor();
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.doesNotMatch(after.stdout, /embeds local overlay/);
  });

  test('a tracked leak: doctor labels it tracked, and --gitignore does not add it', () => {
    write(cwd, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: local@example.com\n');
    const leaked = '.claude/skills/git-workflow/SKILL.md';
    const first = spawnSync(process.execPath, [CLI, 'render', '--allow-unreleased', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    git(cwd, 'add', leaked);
    const again = run();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.doesNotMatch(gi(), /SKILL\.md/);
    fs.appendFileSync(path.join(cwd, '.gitignore'), '.claude/\n');
    const dr = runDoctor();
    assert.equal(dr.status, 0, dr.stdout + dr.stderr);
    assert.match(dr.stdout, /^tracked by git \(embeds local overlay\): \.claude\/skills\/git-workflow\/SKILL\.md/m);
    assert.doesNotMatch(dr.stdout, /^not gitignored \(embeds local overlay\)/m);
  });
});
