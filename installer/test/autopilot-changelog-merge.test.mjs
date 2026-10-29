import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

// #759: changelog-merge.mjs classifies a real stage 1 sync conflict in throwaway repos.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(repoRoot, 'stacks/orchestration/skills/autopilot/changelog-merge.mjs');
const LOCK = '.waffle/waffle.lock.json';
const BASE = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- base added',
  '',
  '### Fixed',
  '',
  '- base fixed',
  '',
  '## [0.1.0] - 2026-01-01',
  '',
  '- shipped',
  '',
].join('\n');

let dir;
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const write = (files) => {
  for (const [p, body] of Object.entries(files)) {
    if (body === null) fs.rmSync(path.join(dir, p));
    else {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), body);
    }
  }
};
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
/** An edit that inserts `add` lines after the line `after`. */
const ins = (after, ...add) => (s) => s.replace(`${after}\n`, `${[after, ...add].join('\n')}\n`);
/** An edit that inserts `add` lines directly above the line `line`. */
const above = (line, ...add) => (s) => s.replace(`\n${line}\n`, `\n${[...add, line].join('\n')}\n`);
/** Commit each side off the base (a function edits the file, null deletes it), then merge main into integ; asserts it conflicts. */
const sync = ({ main = {}, integ = {} }) => {
  for (const [branch, files] of [['main', main], ['integ', integ]]) {
    git('switch', '-q', branch);
    write(Object.fromEntries(Object.entries(files).map(([p, f]) => [p, typeof f === 'function' ? f(read(p)) : f])));
    git('add', '-A');
    git('commit', '-q', '-m', branch);
  }
  git('switch', '-q', 'integ');
  const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', '--no-ff', 'main', '-m', 'sync'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'the sync merge should conflict');
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-merge-'));
  git('init', '-q', '-b', 'main');
  write({ 'CHANGELOG.md': BASE, 'a.txt': 'one\n', [LOCK]: '{"v":1}\n' });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('branch', 'integ');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('changelog-merge.mjs resolves additive-only [Unreleased] conflicts (#759)', () => {
  test('both sides adding at the same point resolve, main first, and the merge commits', () => {
    sync({ main: { 'CHANGELOG.md': ins('- base added', '- from main') }, integ: { 'CHANGELOG.md': ins('- base added', '- from integ') } });
    const dry = run('-C', dir);
    assert.equal(dry.code, 0, dry.out + dry.err);
    assert.match(dry.out, /^resolvable: /);
    assert.match(read('CHANGELOG.md'), /^<{7}/m, 'a dry run leaves the tree alone');
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out, 'resolved: CHANGELOG.md additive conflict auto-resolved (1 main line(s), 1 integ line(s))\n');
    assert.equal(read('CHANGELOG.md'), ins('- base added', '- from main', '- from integ')(BASE));
    git('add', 'CHANGELOG.md');
    git('commit', '-q', '--no-edit', '--cleanup=strip');
  });

  test('additions in different ### subsections of [Unreleased] are allowed', () => {
    const main = (s) => ins('- base fixed', '- main fixed')(ins('- base added', '- main added')(s));
    sync({ main: { 'CHANGELOG.md': main }, integ: { 'CHANGELOG.md': ins('- base added', '- integ added', '', '- integ spaced') } });
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 0, r.out + r.err);
    const want = ins('- base fixed', '- main fixed')(ins('- base added', '- main added', '- integ added', '', '- integ spaced')(BASE));
    assert.equal(read('CHANGELOG.md'), want);
  });

  test('appending right before the next ## heading, the last legal point, resolves', () => {
    sync({ main: { 'CHANGELOG.md': above('## [0.1.0] - 2026-01-01', '- from main') }, integ: { 'CHANGELOG.md': above('## [0.1.0] - 2026-01-01', '- from integ') } });
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(read('CHANGELOG.md'), above('## [0.1.0] - 2026-01-01', '- from main', '- from integ')(BASE));
  });

  test('a user diff.interHunkContext does not fuse nearby insertions into a false hold', () => {
    git('config', 'diff.interHunkContext', '5');
    sync({ main: { 'CHANGELOG.md': (s) => ins('### Fixed', '- main near')(ins('- base added', '- from main')(s)) }, integ: { 'CHANGELOG.md': ins('- base added', '- from integ') } });
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(read('CHANGELOG.md'), ins('### Fixed', '- main near')(ins('- base added', '- from main', '- from integ')(BASE)));
  });

  test('a line both sides add identically at the same point is kept once, as git keeps it', () => {
    const side = (who) => (s) => ins('- base fixed', '- same')(ins('- base added', `- ${who}`)(s));
    sync({ main: { 'CHANGELOG.md': side('main') }, integ: { 'CHANGELOG.md': side('integ') } });
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(read('CHANGELOG.md'), ins('- base fixed', '- same')(ins('- base added', '- main', '- integ')(BASE)));
  });

  test('CHANGELOG.md plus the lock is eligible; the lock is left for its own path', () => {
    sync({
      main: { 'CHANGELOG.md': ins('- base added', '- from main'), [LOCK]: '{"v":2}\n' },
      integ: { 'CHANGELOG.md': ins('- base added', '- from integ'), [LOCK]: '{"v":3}\n' },
    });
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(read(LOCK), /^<{7}/m);
  });
});

describe('changelog-merge.mjs holds everything else (#759)', () => {
  const hold = (sides, reason) => {
    sync(sides);
    const before = read('CHANGELOG.md');
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, reason);
    assert.equal(read('CHANGELOG.md'), before, 'a hold never writes');
  };
  const integ = { 'CHANGELOG.md': ins('- base added', '- from integ') };
  /** Main's `edit` plus a bullet at integ's insertion point, so the sync conflicts. */
  const main = (edit) => ({ 'CHANGELOG.md': (s) => edit(ins('- base added', '- from main')(s)) });

  test('a release rename of [Unreleased] holds', () => {
    hold({ main: main((s) => s.replace('## [Unreleased]', '## [0.2.0] - 2026-02-01')), integ }, /^HOLD: main removes or edits a line of CHANGELOG\.md/);
  });

  test('a release that adds a fresh [Unreleased] above the old section holds on the added heading', () => {
    hold({ main: main(ins('## [Unreleased]', '', '## [0.2.0] - 2026-02-01')), integ }, /^HOLD: main adds a heading to CHANGELOG\.md: "## \[0\.2\.0\]/);
  });

  test('a deleted line holds', () => {
    hold({ main: main((s) => s.replace('- base fixed\n', '')), integ }, /^HOLD: main removes or edits a line/);
  });

  test('an edited line holds', () => {
    hold({ main: integ, integ: { 'CHANGELOG.md': (s) => s.replace('- base added', '- base added, reworded') } }, /^HOLD: integ removes or edits a line/);
  });

  test('an addition under a different ## heading holds', () => {
    hold({ main: { 'CHANGELOG.md': ins('- shipped', '- late note') }, integ: { 'CHANGELOG.md': ins('- shipped', '- other note') } }, /^HOLD: main adds lines outside "## \[Unreleased\]"/);
  });

  test('an addition directly under the next ## heading holds', () => {
    const under = (line) => ({ 'CHANGELOG.md': ins('## [0.1.0] - 2026-01-01', line) });
    hold({ main: under('- m'), integ: under('- i') }, /^HOLD: main adds lines outside "## \[Unreleased\]" \(after base line 13\)/);
  });

  test('an addition directly above ## [Unreleased] holds', () => {
    hold({ main: { 'CHANGELOG.md': above('## [Unreleased]', '- m') }, integ: { 'CHANGELOG.md': above('## [Unreleased]', '- i') } }, /^HOLD: main adds lines outside "## \[Unreleased\]" \(after base line 2\)/);
  });

  test('an added ### heading inside [Unreleased] holds', () => {
    hold({ main: main(ins('- base fixed', '', '### Changed', '', '- x')), integ }, /^HOLD: main adds a heading/);
  });

  test('a side adding a conflict-marker-shaped line holds', () => {
    hold({ main: main((s) => s), integ: { 'CHANGELOG.md': ins('- base added', '<<<<<<< HEAD') } }, /^HOLD: a side adds a conflict-marker-shaped line to CHANGELOG\.md$/m);
  });

  test('CHANGELOG.md plus another non-lock path holds', () => {
    hold({ main: { 'CHANGELOG.md': ins('- base added', '- from main'), 'a.txt': 'main\n' }, integ: { ...integ, 'a.txt': 'integ\n' } }, /^HOLD: other conflicting path\(s\): a\.txt$/m);
  });

  test('a base without exactly one [Unreleased] holds', () => {
    write({ 'CHANGELOG.md': BASE.replace('## [Unreleased]', '## [0.2.0]') });
    git('commit', '-q', '-am', 'no unreleased');
    git('branch', '-f', 'integ');
    hold({ main: { 'CHANGELOG.md': ins('- base added', '- m') }, integ: { 'CHANGELOG.md': ins('- base added', '- i') } }, /^HOLD: the merge base has 0 "## \[Unreleased\]" headings, not 1/);
  });
});

describe('changelog-merge.mjs usage (#759)', () => {
  test('no conflict holds, a missing stage holds, bad arguments exit 2', () => {
    const r = run('-C', dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /^HOLD: CHANGELOG\.md is not conflicted/);
    assert.equal(run('--nope').code, 2);
    assert.match(run('-C').err, /^ERROR: -C needs a value/);
    assert.equal(run('--help').code, 0);
    assert.equal(run('-C', path.join(dir, 'missing')).code, 2);
  });

  test('a modify/delete conflict has no stage to merge and holds', () => {
    sync({ main: { 'CHANGELOG.md': ins('- base added', '- m') }, integ: { 'CHANGELOG.md': null } });
    const r = run('-C', dir, '--write');
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /^HOLD: CHANGELOG\.md has no stage 2/);
  });
});

describe('changelog-merge.mjs renders next to the skill (#759)', () => {
  const src = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  test('the rendered script equals its source, which carries no placeholder', () => {
    assert.equal(src('.claude/skills/autopilot/changelog-merge.mjs'), src('stacks/orchestration/skills/autopilot/changelog-merge.mjs'));
    assert.doesNotMatch(src('stacks/orchestration/skills/autopilot/changelog-merge.mjs'), /\{\{/);
  });
});
