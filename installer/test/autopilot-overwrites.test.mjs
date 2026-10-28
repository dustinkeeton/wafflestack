import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

// #748 (slice B of #732): overwrites.mjs runs against real merge commits in throwaway repos.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(repoRoot, 'stacks/orchestration/skills/autopilot/overwrites.mjs');

let dir;
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const write = (files) => {
  for (const [p, body] of Object.entries(files)) {
    const abs = path.join(dir, p);
    if (body === null) fs.rmSync(abs);
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
  }
};
/**
 * Land one "PR" with --no-ff; returns the merge SHA. `from` is where its branch forks; `catchUp`
 * merges main in first (a branch that forked before main moved); `conflict` resolves by keeping ours.
 */
let n = 0;
const pr = (files, { mv, from = 'main', catchUp = false, conflict = false } = {}) => {
  const branch = `pr-${++n}`;
  git('switch', '-q', '-c', branch, from);
  if (catchUp) git('merge', '-q', '--no-ff', 'main', '-m', `catch up ${branch}`);
  if (mv) git('mv', ...mv);
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', branch);
  if (conflict) {
    spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '-q', 'main'], { cwd: dir });
    git('checkout', '--ours', '--', ...Object.keys(files));
    git('add', '-A');
    git('commit', '-q', '--no-edit');
  }
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', branch, '-m', `merge ${branch}`);
  return git('rev-parse', 'HEAD');
};
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overwrites-748-'));
  git('init', '-q', '-b', 'main');
  write({ 'a.txt': 'one\ntwo\n', '.waffle/waffle.lock.json': '{"v":1}\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  n = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('overwrites.mjs (#748)', () => {
  let base;
  beforeEach(() => { base = git('rev-parse', 'HEAD'); });

  test('clean: every added line survives, exit 0', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'b.txt': 'bee\n' });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /overwrites: none \(2 added line\(s\) across 2 PR\(s\); 0 rewritten by PRs built on them\)/);
  });

  test('a PR forked before another merged and clobbering its line in a conflict is flagged, exit 1', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, conflict: true });
    const r = run('--head', 'HEAD', '--pr', `11=${p1}`, '--pr', `12=${p2}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^OVERWRITE: a\.txt: #11 added "three"; removed by #12$/m);
    assert.match(r.out, /overwrites: 1 of 2 added line\(s\) missing, in 1 file\(s\)/);
  });

  test('a PR built on the earlier one rewriting its line is a NOTE, exit 0', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nTHREE\n' });
    const r = run('--head', 'HEAD', '--pr', `11=${p1}`, '--pr', `12=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: a\.txt: #12 rewrote 1 line\(s\) #11 added, on a branch built on #11$/m);
    assert.match(r.out, /1 rewritten by PRs built on them/);
  });

  test('a non-numeric label (the sync) prints as given', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const sync = pr({ 'a.txt': 'one\ntwo\nmain\n' }, { from: base, conflict: true });
    const r = run('--head', sync, '--pr', `1=${p1}`, '--pr', `sync=${sync}`);
    assert.equal(r.code, 1);
    assert.match(r.out, /OVERWRITE: a\.txt: #1 added "three"; removed by sync/);
  });

  test('a removal no listed PR made reads as outside the run', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    pr({ 'a.txt': 'one\n' });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`);
    assert.equal(r.code, 1);
    assert.match(r.out, /OVERWRITE: a\.txt: #1 added "three"; removed outside the run's PRs/);
  });

  test('a deleted file is one DELETED line naming the deleter', () => {
    const p1 = pr({ 'c.txt': 'x\ny\n' });
    const p2 = pr({ 'c.txt': null }, { from: base, catchUp: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 1);
    assert.match(r.out, /^DELETED: c\.txt: #1 added 2 line\(s\); file deleted by #2$/m);
  });

  test('renames are followed to the head path', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({}, { mv: ['a.txt', 'moved.txt'] });
    assert.equal(run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`).code, 0);
    const p3 = pr({ 'moved.txt': 'one\ntwo\n' }, { from: base, catchUp: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`, '--pr', `3=${p3}`);
    assert.equal(r.code, 1);
    assert.match(r.out, /OVERWRITE: moved\.txt: #1 added "three"; removed by #3/);
  });

  test('blank lines are never findings', () => {
    const p1 = pr({ 'a.txt': 'one\n\n   \ntwo\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\n' }, { from: base, catchUp: true });
    assert.equal(run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`).code, 0);
  });

  test('the lock is ignored by default; --ignore adds paths', () => {
    const p1 = pr({ '.waffle/waffle.lock.json': '{"v":2}\n', 'gen.txt': 'g1\n' });
    const p2 = pr({ '.waffle/waffle.lock.json': '{"v":3}\n', 'gen.txt': 'g2\n' }, { from: base, conflict: true });
    const prs = ['--pr', `1=${p1}`, '--pr', `2=${p2}`];
    const r = run('--head', 'HEAD', ...prs);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /waffle\.lock/);
    assert.equal(run('--head', 'HEAD', ...prs, '--ignore', 'gen.txt').code, 0);
  });

  test('bad arguments and unknown SHAs exit 2', () => {
    const p1 = pr({ 'b.txt': 'bee\n' });
    assert.equal(run().code, 2);
    assert.equal(run('--head', 'HEAD').code, 2);
    assert.equal(run('--head', 'HEAD', '--pr', p1).code, 2);
    assert.equal(run('--head', 'HEAD', '--bogus', 'x', '--pr', `1=${p1}`).code, 2);
    const r = run('--head', 'HEAD', '--pr', `1=${'f'.repeat(40)}`);
    assert.equal(r.code, 2);
    assert.match(r.err, /^ERROR: git rev-parse/);
  });
});

describe('autopilot gate step 4 wires the checks (#748)', () => {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  test('the rendered skill invokes the rendered script and lists this repo\'s checks', () => {
    const md = read('.claude/skills/autopilot/SKILL.md');
    assert.match(md, /node \.claude\/skills\/autopilot\/overwrites\.mjs --head <gateHead>/);
    assert.match(md, /^- `env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer\/cli\.mjs doctor --allow-missing --verify-render`$/m);
    assert.match(md, /^- `node --test installer\/test\/comment-gate\.test\.mjs`$/m);
    assert.equal(read('.claude/skills/autopilot/overwrites.mjs'), read('stacks/orchestration/skills/autopilot/overwrites.mjs'));
    assert.doesNotMatch(read('stacks/orchestration/skills/autopilot/overwrites.mjs'), /\{\{/);
    const step4 = md.slice(md.indexOf('4. **Checks.**'), md.indexOf('5. **Open the sync PR.**'));
    assert.match(step4, /Any nonzero exit stops the gate: \*\*hold\*\*/);
  });

  test('a consumer render defaults to doctor --allow-missing through waffleCmd', () => {
    const orch = loadToolkit(repoRoot).stacks.get('orchestration');
    assert.deepEqual(orch.config['autopilot.integrationChecks'].default, ['{{autopilot.waffleCmd}} doctor --allow-missing']);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-748-'));
    try {
      fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), [
        'targets: [claude]',
        'include: [orchestration/skills/autopilot]',
        'config:',
        '  project: { name: P748 }',
        '  roster: { classificationTable: "| S | A |", labelFallback: "| L | A |", rootFiles: package.json, sharedModule: lib/, moduleDependencies: none }',
        '  audit: { complianceLabel: I, complianceFrontmatterLabel: i, complianceTaskLabel: I, complianceAgentName: i, complianceDescription: D., compliancePrompt: R. }',
        '',
      ].join('\n'));
      const r = renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const md = fs.readFileSync(path.join(cwd, '.claude/skills/autopilot/SKILL.md'), 'utf8');
      assert.match(md, /^- `npx --yes github:dustinkeeton\/wafflestack#v0\.0\.test doctor --allow-missing`$/m);
      assert.ok(fs.existsSync(path.join(cwd, '.claude/skills/autopilot/overwrites.mjs')));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
