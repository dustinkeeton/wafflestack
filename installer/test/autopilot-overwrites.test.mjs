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
 * merges main in first (a branch that forked before main moved); `editMerge` makes that catch-up merge
 * itself carry `files`; `conflict` merges main after the commit and `rebase` replays the branch onto
 * main, each resolving a stop by keeping the branch's side, or by writing `resolve` (null: git rm).
 * A rebase records `{ before, after, onto }` in `rebased`.
 */
let n = 0;
let rebased;
const tryGit = (...args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir }).status === 0;
const settle = (files, resolve, side) => {
  if (resolve) write(resolve);
  else git('checkout', side, '--', ...Object.keys(files));
  git('add', '-A');
};
const pr = (files, { mv, from = 'main', catchUp = false, editMerge = false, conflict = false, rebase = false, resolve } = {}) => {
  const branch = `pr-${++n}`;
  git('switch', '-q', '-c', branch, from);
  if (catchUp) git('merge', '-q', '--no-ff', 'main', '-m', `catch up ${branch}`);
  if (editMerge) git('merge', '-q', '--no-ff', '--no-commit', 'main');
  if (mv) git('mv', ...mv);
  write(files);
  git('add', '-A');
  git('commit', '-q', ...(editMerge ? ['--no-edit'] : ['-m', branch]));
  if (conflict && !tryGit('merge', '-q', 'main')) {
    settle(files, resolve, '--ours');
    git('commit', '-q', '--no-edit');
  }
  if (rebase) {
    rebased = { before: git('rev-parse', 'HEAD'), onto: git('rev-parse', 'main') };
    if (!tryGit('rebase', '-q', 'main')) {
      settle(files, resolve, '--theirs');
      git('-c', 'core.editor=true', 'rebase', '--continue');
    }
    rebased.after = git('rev-parse', 'HEAD');
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
  git('config', 'commit.gpgsign', 'false');
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
    assert.match(r.out, /^NOTE: a\.txt: #12 rewrote 1 line\(s\) #11 added, in a commit built on #11$/m);
    assert.match(r.out, /1 rewritten by PRs built on them/);
  });

  test('a conflict resolved by rebasing onto the earlier PR reads as built on it: a NOTE, exit 0', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, rebase: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: a\.txt: #2 rewrote 1 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('a file deleted by a PR built on its adder is a NOTE, exit 0', () => {
    const p1 = pr({ 'c.txt': 'x\ny\n' });
    const p2 = pr({ 'c.txt': null });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: c\.txt: #2 rewrote 2 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('a file that is binary at the head is skipped', () => {
    const p1 = pr({ 't.dat': 'x\n' });
    const p2 = pr({ 't.dat': 'y\0z\n' }, { from: base, conflict: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /overwrites: none \(0 added line/);
  });

  test('a group past five findings prints a count of the rest', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nl1\nl2\nl3\nl4\nl5\nl6\nl7\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nX\n' }, { from: base, conflict: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 1);
    assert.equal(r.out.match(/^OVERWRITE: a\.txt: #1 added "l\d"/gm).length, 5);
    assert.match(r.out, /^OVERWRITE: a\.txt: … and 2 more line\(s\) #1 added; removed by #2$/m);
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

  test('a file deleted inside a catch-up merge is one DELETED line naming the deleter', () => {
    const p1 = pr({ 'c.txt': 'x\ny\n' });
    const p2 = pr({ 'c.txt': null }, { from: base, editMerge: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^DELETED: c\.txt: #1 added 2 line\(s\); file deleted by #2$/m);
  });

  test('a file deleted in an ordinary commit after a catch-up merge is a NOTE, exit 0', () => {
    const p1 = pr({ 'c.txt': 'x\ny\n' });
    const p2 = pr({ 'c.txt': null }, { from: base, catchUp: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: c\.txt: #2 rewrote 2 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('#752 repro: an intentional rewrite after a clean catch-up merge is a NOTE, exit 0', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, catchUp: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: a\.txt: #2 rewrote 1 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('a line dropped inside the catch-up merge is a finding, exit 1', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\n' }, { from: base, editMerge: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^OVERWRITE: a\.txt: #1 added "three"; removed by #2$/m);
  });

  test('a rewrite after two clean catch-up merges is still a NOTE', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'late', base);
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up 1');
    const p2 = pr({ 'b.txt': 'bee\n' });
    git('switch', '-q', 'late');
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up 2');
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('commit', '-qam', 'rewrite');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', 'late', '-m', 'merge late');
    const p3 = git('rev-parse', 'HEAD');
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`, '--pr', `3=${p3}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: a\.txt: #3 rewrote 1 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('the walk passes the tip: a rewrite followed by an unrelated commit is a NOTE', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'late', base);
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up');
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('commit', '-qam', 'rewrite');
    write({ 'b.txt': 'bee\n' });
    git('add', '-A');
    git('commit', '-qm', 'unrelated');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', 'late', '-m', 'merge late');
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${git('rev-parse', 'HEAD')}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: a\.txt: #2 rewrote 1 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('the walk passes a clean catch-up merge after the rewrite: a NOTE', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'late', base);
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up 1');
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('commit', '-qam', 'rewrite');
    const p2 = pr({ 'b.txt': 'bee\n' });
    git('switch', '-q', 'late');
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up 2');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', 'late', '-m', 'merge late');
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`, '--pr', `3=${git('rev-parse', 'HEAD')}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: a\.txt: #3 rewrote 1 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test('a rename plus rewrite in one commit after a catch-up is a NOTE at the new path', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\n' });
    const p2 = pr({ 'c.txt': 'one\ntwo\nTHREE\nfour\nfive\nsix\n' }, { from: base, catchUp: true, mv: ['a.txt', 'c.txt'] });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^NOTE: c\.txt: #2 rewrote 1 line\(s\) #1 added, in a commit built on #1$/m);
  });

  test("identical text the remover's branch added and removed before merging #1 is a finding", () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'late', base);
    write({ 'a.txt': 'one\ntwo\nthree\n' });
    git('commit', '-qam', 'same text');
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('commit', '-qam', 'rewrite');
    git('switch', '-q', 'main');
    assert.equal(tryGit('merge', '-q', '--no-ff', 'late', '-m', 'merge late'), false);
    git('checkout', '--theirs', '--', 'a.txt');
    git('add', '-A');
    git('commit', '-q', '--no-edit');
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${git('rev-parse', 'HEAD')}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^OVERWRITE: a\.txt: #1 added "three"; removed by #2$/m);
  });

  test("a line dropped by hand-editing the PR's own merge commit is a finding", () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'evil');
    write({ 'b.txt': 'bee\n' });
    git('add', '-A');
    git('commit', '-qm', 'evil');
    git('switch', '-q', 'main');
    git('merge', '-q', '--no-ff', '--no-commit', 'evil');
    write({ 'a.txt': 'one\ntwo\n' });
    git('add', '-A');
    git('commit', '-qm', 'merge evil');
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${git('rev-parse', 'HEAD')}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^OVERWRITE: a\.txt: #1 added "three"; removed by #2$/m);
  });

  test('--pr order does not matter; a --pr off --head\'s first-parent history exits 2', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, conflict: true });
    const fwd = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(fwd.code, 1);
    assert.deepEqual(run('--head', 'HEAD', '--pr', `2=${p2}`, '--pr', `1=${p1}`), fwd);
    const tip = git('rev-parse', 'pr-1');
    const r = run('--head', 'HEAD', '--pr', `1=${tip}`);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`^ERROR: --pr #1 \\(${tip}\\) is not a merge on --head's first-parent history$`, 'm'));
  });

  test('a built-on edit then a blind delete credits the deleter, not the editor, exit 1', () => {
    const p1 = pr({ 'c.txt': 'x\ny\n' });
    const p2 = pr({ 'c.txt': 'y\n' });
    pr({ 'c.txt': null });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^DELETED: c\.txt: #1 added 2 line\(s\); file deleted outside the run's PRs$/m);
  });

  test('a clean sync merge as both --head and the last --pr exits 0', () => {
    git('switch', '-q', '-c', 'integ');
    git('switch', '-q', '-c', 'f1');
    write({ 'a.txt': 'one\ntwo\nthree\n' });
    git('commit', '-qam', 'f1');
    git('switch', '-q', 'integ');
    git('merge', '-q', '--no-ff', 'f1', '-m', 'merge f1');
    const p1 = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    write({ 'm.txt': 'main\n' });
    git('add', '-A');
    git('commit', '-q', '-m', 'main moves');
    git('switch', '-q', 'integ');
    git('merge', '-q', '--no-ff', 'main', '-m', 'sync');
    const sync = git('rev-parse', 'HEAD');
    const r = run('--head', sync, '--pr', `1=${p1}`, '--pr', `sync=${sync}`);
    assert.equal(r.code, 0, r.out + r.err);
    assert.doesNotMatch(r.out, /OVERWRITE:/);
  });

  test('a squash-merged PR has no fork point, so its removals are findings, exit 1', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'sq');
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('commit', '-qam', 'sq');
    git('switch', '-q', 'main');
    git('merge', '-q', '--squash', 'sq');
    git('commit', '-qm', 'squash sq');
    const p2 = git('rev-parse', 'HEAD');
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^OVERWRITE: a\.txt: #1 added "three"; removed by #2$/m);
  });

  test('a PR that moves a line is not its remover; the later clobber is', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'three\none\ntwo\n' });
    const p3 = pr({ 'a.txt': 'zero\none\ntwo\n' }, { from: base, conflict: true });
    const r = run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`, '--pr', `3=${p3}`);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^OVERWRITE: a\.txt: #1 added "three"; removed by #3$/m);
    assert.doesNotMatch(r.out, /^NOTE: a\.txt: #2 rewrote/m);
  });

  test('renames are followed to the head path', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({}, { mv: ['a.txt', 'moved.txt'] });
    assert.equal(run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`).code, 0);
    const p3 = pr({ 'moved.txt': 'one\ntwo\n' }, { from: base, editMerge: true });
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

describe('overwrites.mjs --rebase (#752)', () => {
  let base;
  beforeEach(() => { base = git('rev-parse', 'HEAD'); });
  const runRebase = (...extra) => run('--rebase', '--before', rebased.before, '--after', rebased.after, '--onto', rebased.onto, ...extra);

  test('a rebase conflict resolved to the branch side drops the upstream line: exit 1, though history mode says NOTE', () => {
    const p1 = pr({ 'a.txt': 'one\ntwo\nthree\n' });
    const p2 = pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, rebase: true });
    assert.equal(run('--head', 'HEAD', '--pr', `1=${p1}`, '--pr', `2=${p2}`).code, 0);
    const r = runRebase();
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^REBASE: a\.txt: upstream added "three"; dropped resolving the rebase$/m);
    assert.match(r.out, /^rebase: 1 of 1 upstream line\(s\) dropped, in 1 file\(s\)$/m);
  });

  test('a resolution that keeps both sides, or a clean rebase, exits 0', () => {
    pr({ 'a.txt': 'one\ntwo\nthree\n' });
    pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, rebase: true, resolve: { 'a.txt': 'one\ntwo\nthree\nTHREE\n' } });
    assert.equal(runRebase().code, 0);
    const mid = git('rev-parse', 'HEAD');
    pr({ 'b.txt': 'bee\n' });
    pr({ 'c.txt': 'sea\n' }, { from: mid, rebase: true });
    const r = runRebase();
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^rebase: none dropped \(1 line\(s\) upstream added since [0-9a-f]{7}\)$/m);
  });

  test('a branch that merged the earlier PR in, then drops its line resolving the rebase, exits 1', () => {
    pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'late', base);
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('commit', '-qam', 'late');
    assert.equal(tryGit('merge', '-q', 'main'), false);
    write({ 'a.txt': 'one\ntwo\nthree\nTHREE\n' });
    git('commit', '-qam', 'catch up');
    rebased = { before: git('rev-parse', 'HEAD'), onto: git('rev-parse', 'main') };
    assert.equal(tryGit('rebase', '-q', 'main'), false);
    write({ 'a.txt': 'one\ntwo\nTHREE\n' });
    git('add', '-A');
    git('-c', 'core.editor=true', 'rebase', '--continue');
    rebased.after = git('rev-parse', 'HEAD');
    const r = runRebase();
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^REBASE: a\.txt: upstream added "three"; dropped resolving the rebase$/m);
    assert.match(r.out, /^rebase: 1 of 1 upstream line\(s\) dropped, in 1 file\(s\)$/m);
  });

  const rebaseLate = (resolve) => {
    git('switch', '-q', 'late');
    rebased = { before: git('rev-parse', 'HEAD'), onto: git('rev-parse', 'main') };
    if (!tryGit('rebase', '-q', 'main')) {
      write(resolve);
      git('add', '-A');
      git('-c', 'core.editor=true', 'rebase', '--continue');
    }
    rebased.after = git('rev-parse', 'HEAD');
    return runRebase();
  };

  test('a line a catch-up merge dropped, dropped again resolving the rebase, exits 1', () => {
    pr({ 'a.txt': 'one\nupstream\n' });
    git('switch', '-q', '-c', 'late', base);
    write({ 'a.txt': 'one\nmine\n' });
    git('commit', '-qam', 'late');
    assert.equal(tryGit('merge', '-q', 'main'), false);
    write({ 'a.txt': 'one\nmine\n' });
    git('commit', '-qam', 'catch up');
    pr({ 'b.txt': 'bee\n' });
    const r = rebaseLate({ 'a.txt': 'one\nmine\n' });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^REBASE: a\.txt: upstream added "upstream"; dropped resolving the rebase$/m);
  });

  test('a deliberate edit after a catch-up, or of a pre-fork line, replayed cleanly exits 0', () => {
    pr({ 'a.txt': 'one\ntwo\nthree\n' });
    git('switch', '-q', '-c', 'late', base);
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up');
    write({ 'a.txt': 'two\nTHREE\n' });
    git('commit', '-qam', 'rewrite');
    pr({ 'b.txt': 'bee\n' });
    const r = rebaseLate({});
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^rebase: none dropped/m);
  });

  test('a line the branch only moved is not its own removal; a deletion before a rename is', () => {
    const six = 'one\ntwo\nthree\nfour\nfive\nsix\n';
    pr({ 'a.txt': six + 'up\n' });
    git('switch', '-q', '-c', 'late', base);
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up');
    write({ 'a.txt': 'up\n' + six });
    git('commit', '-qam', 'move');
    pr({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nup\nmain\n' });
    const moved = rebaseLate({ 'a.txt': 'one\ntwo\nthree\nfour\nfive\nsix\nmain\n' });
    assert.equal(moved.code, 1, moved.out + moved.err);
    assert.match(moved.out, /^REBASE: a\.txt: upstream added "up"; dropped resolving the rebase$/m);
    git('switch', '-q', '-C', 'late', 'pr-1');
    git('merge', '-q', '--no-ff', 'main', '-m', 'catch up');
    write({ 'a.txt': six + 'main\n' });
    git('commit', '-qam', 'drop up');
    git('mv', 'a.txt', 'c.txt');
    git('commit', '-qm', 'rename');
    pr({ 'b.txt': 'bee\n' });
    const renamed = rebaseLate({});
    assert.equal(renamed.code, 0, renamed.out + renamed.err);
  });

  test('a file the branch edits, then deletes, replayed cleanly exits 0', () => {
    git('switch', '-q', '-c', 'late', base);
    write({ 'a.txt': 'one\nTWO\n' });
    git('commit', '-qam', 'edit');
    git('rm', '-q', 'a.txt');
    git('commit', '-qm', 'delete');
    pr({ 'b.txt': 'bee\n' });
    const r = rebaseLate({});
    assert.equal(r.code, 0, r.out + r.err);
  });

  test('an upstream line the branch had also removed is still a finding when the resolution drops it', () => {
    pr({ 'a.txt': 'two\none\n' });
    pr({ 'a.txt': 'TWO\n' }, { from: base, rebase: true });
    const r = runRebase();
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^REBASE: a\.txt: upstream added "one"; dropped resolving the rebase$/m);
    assert.doesNotMatch(r.out, /^NOTE:/m);
  });

  test('a file the branch renamed before the rebase is still checked on both passes', () => {
    const body = (mid, extra = []) => [...Array.from({ length: 20 }, (_, i) => `l${i}`), 'EARLIER', mid, ...extra, ...Array.from({ length: 20 }, (_, i) => `m${i}`)].join('\n') + '\n';
    pr({ 'x.txt': body('a4') });
    const fork = git('rev-parse', 'HEAD');
    pr({ 'x.txt': body('a4-main', ['UPSTREAM']) });
    const kept = body('a4-main', ['a4-branch']).replace('EARLIER\n', '');
    pr({ 'z.txt': body('a4-branch') }, { from: fork, mv: ['x.txt', 'z.txt'], rebase: true, resolve: { 'z.txt': kept } });
    const r = runRebase();
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^REBASE: z\.txt: upstream added "UPSTREAM"; dropped resolving the rebase$/m);
    assert.match(r.out, /^REBASE: z\.txt: upstream added "EARLIER"; dropped resolving the rebase$/m);
  });

  test('a modify/delete resolved by git rm is one DELETED line', () => {
    pr({ 'a.txt': 'one\ntwo\nthree\n' });
    pr({ 'a.txt': null }, { from: base, rebase: true, resolve: { 'a.txt': null } });
    const r = runRebase();
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^DELETED: a\.txt: upstream added 1 line\(s\); file dropped resolving the rebase$/m);
  });

  test('the lock is ignored by default', () => {
    pr({ '.waffle/waffle.lock.json': '{"v":2}\n' });
    pr({ '.waffle/waffle.lock.json': '{"v":3}\n' }, { from: base, rebase: true });
    const r = runRebase();
    assert.equal(r.code, 0, r.out + r.err);
    assert.doesNotMatch(r.out, /waffle\.lock/);
  });

  test('--after not built on --onto, or --rebase with --head or --pr, exits 2', () => {
    pr({ 'a.txt': 'one\ntwo\nthree\n' });
    pr({ 'a.txt': 'one\ntwo\nTHREE\n' }, { from: base, rebase: true });
    const r = run('--rebase', '--before', rebased.before, '--after', rebased.before, '--onto', rebased.onto);
    assert.equal(r.code, 2);
    assert.match(r.err, /^ERROR: --after [0-9a-f]+ does not descend from --onto/);
    assert.equal(runRebase('--head', 'HEAD').code, 2);
    assert.equal(run('--rebase', '--before', rebased.before, '--onto', rebased.onto).code, 2);
    assert.equal(run('--head', 'HEAD', '--pr', `1=${rebased.after}`, '--onto', rebased.onto).code, 2);
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
    assert.match(step4, /run `npm install` in `<gate>`, then apply step 3's check: [^\n]*ls-files --others --exclude-standard` prints anything, \*\*hold\*\*/);
    assert.match(step4, /every `NOTE:` line the detector printed, for the final PR body and the run report/);
    assert.match(step4, /An ordinary commit whose parent already held both the line and #A's merge rewrote it knowingly/);
    assert.match(md, /`Overwrites: clean across <k> PRs` with the detector's `NOTE:` lines/);
  });

  test('#752: a rebase dropping an earlier PR\'s line is checked before the push and stops auto-merge', () => {
    const md = read('.claude/skills/autopilot/SKILL.md');
    const step3 = md.slice(md.indexOf('### Step 3'), md.indexOf('### Step 4'));
    assert.match(step3, /node \.claude\/skills\/autopilot\/overwrites\.mjs --rebase --before <pre> --after <post> --onto <onto>/);
    assert.match(step3, /append `git -C <wt> diff --name-only --diff-filter=U` to the run's conflicted-path record/);
    assert.ok(step3.indexOf('gh pr merge --disable-auto <pr>') < step3.indexOf('gh pr comment <pr> --body-file'));
    assert.match(step3, /starts with `<!-- autopilot:rebase-drop -->`/);
    assert.match(step3, /for each line `<onto>` holds that `<post>` lacks[^\n]*A line a catch-up merge dropped still counts\./);
    assert.match(step3, /a rebase-held PR is \*\*never armed\*\*/);
    assert.match(step3, /With integration mode on and the comment read back, the run PR arms into `<integ>` as usual, and the hold moves to the integration → `main` PR/);
    assert.match(step3, /Read it back with item 4's comments query on `<pr>`\. If that prints no id or errors, the hold is not durable: leave `<pr>` unarmed in either mode/);
    assert.equal(md.match(/and the PR is not rebase-held \(Step 3, item 3: query its marker now\)/g).length, 3);
    assert.match(md, /or, with integration mode off, Step 3 item 3's marker query on it prints an id or errors \(\*\*rebase-held\*\*\), treat it/);
    assert.match(md, /\*\*not armed — #P dropped earlier PRs' lines resolving its pre-gate rebase\*\*/);
    assert.match(md.slice(md.indexOf('## End-of-run housekeeping'), md.indexOf('## Guardrails')), /\*\*rebase-held\*\* with its conflicted paths/);
    assert.match(md.slice(md.indexOf('## Guardrails'), md.indexOf('## Failure handling')), /pre-gate rebase dropped stops auto-merge/);
  });

  test('#765: every non-integration arm re-reads the rebase-drop marker, not run memory', () => {
    const md = read('.claude/skills/autopilot/SKILL.md');
    const at = (h) => md.indexOf(h);
    assert.match(md.slice(at('### Step 3'), at('### Step 4')), /each arm in Steps 5–7, and Step 8's hold check, runs item 4's comments query on `<pr>` at that moment\. Any id, or an error, means it is rebase-held/);
    assert.doesNotMatch(md, /not rebase-held \(Step 3\),/);
    for (const [from, to] of [['### Step 5', '### Step 6'], ['### Step 6', '### Step 7'], ['### Step 7', '### Step 8']]) {
      assert.match(md.slice(at(from), at(to)), /not rebase-held \(Step 3, item 3: query its marker now\), arm/, from);
    }
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
