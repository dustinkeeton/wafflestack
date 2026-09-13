import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSource, defaultSourceCacheDir, checkoutMatches } from '../lib/sources.mjs';
import { sha256 } from '../lib/util.mjs';

const SOURCE = 'https://example.invalid/org/toolkit.git';
const REF = 'v1.0.0';
const HEAD = 'a'.repeat(40);
const ext = { name: 'pinned', source: SOURCE, sourceType: 'git', ref: REF };

describe('external stack sources: cache location + checkout verification (#460)', () => {
  let cacheDir;
  let dest;
  const gitOk = spawnSync('git', ['--version']).status === 0;

  beforeEach(() => {
    cacheDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'src-cache-460-')), 'sources');
    dest = path.join(cacheDir, sha256(`${SOURCE}@${REF}`).slice(0, 24));
  });

  afterEach(() => {
    fs.rmSync(path.dirname(cacheDir), { recursive: true, force: true });
  });

  // A fake "clone": the marker `.git` plus a body file, so the test can tell a served cache from a re-fetch.
  const seed = (body) => {
    fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'BODY'), body);
  };
  const fetchStub = () => {
    const calls = [];
    const gitFetch = (source, ref, d) => {
      calls.push({ source, ref, dest: d });
      fs.mkdirSync(path.join(d, '.git'), { recursive: true });
      fs.writeFileSync(path.join(d, 'BODY'), 'FRESH');
    };
    return { calls, gitFetch };
  };
  const goodGit = {
    gitResolveCommit: () => HEAD,
    gitOriginUrl: () => SOURCE,
    gitRefCommit: (_dir, ref) => (ref === REF ? HEAD : null),
  };

  test('default cache dir is per-user: honours an absolute $XDG_CACHE_HOME, else ~/.cache', () => {
    assert.equal(defaultSourceCacheDir({ XDG_CACHE_HOME: '/xdg/cache' }), path.join('/xdg/cache', 'wafflestack', 'sources'));
    assert.equal(defaultSourceCacheDir({}), path.join(os.homedir(), '.cache', 'wafflestack', 'sources'));
    assert.equal(defaultSourceCacheDir({ XDG_CACHE_HOME: '' }), path.join(os.homedir(), '.cache', 'wafflestack', 'sources'));
    assert.equal(defaultSourceCacheDir({ XDG_CACHE_HOME: 'relative/dir' }), path.join(os.homedir(), '.cache', 'wafflestack', 'sources'), 'a relative XDG_CACHE_HOME is ignored per the spec');
    assert.ok(!defaultSourceCacheDir({}).startsWith(os.tmpdir()), 'never under the shared tmpdir');
  });

  test('the cache dir is created user-only (0700) when absent', { skip: process.platform === 'win32' }, () => {
    const { gitFetch } = fetchStub();
    assert.ok(!fs.existsSync(cacheDir));
    resolveSource(ext, { cacheDir, gitFetch, ...goodGit });
    assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700);
  });

  test('a valid cached checkout is served without re-fetching', () => {
    seed('CACHED');
    const { calls, gitFetch } = fetchStub();
    const r = resolveSource(ext, { cacheDir, gitFetch, ...goodGit });
    assert.equal(r.root, dest);
    assert.equal(r.commit, HEAD);
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(path.join(dest, 'BODY'), 'utf8'), 'CACHED');
  });

  test('a pre-seeded checkout with a foreign origin is discarded and re-fetched', () => {
    seed('PLANTED');
    const { calls, gitFetch } = fetchStub();
    const r = resolveSource(ext, { cacheDir, gitFetch, ...goodGit, gitOriginUrl: () => 'https://attacker.invalid/evil.git' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { source: SOURCE, ref: REF, dest });
    assert.equal(r.root, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'BODY'), 'utf8'), 'FRESH', 'planted content never served');
  });

  test('a pre-seeded directory with no valid HEAD is discarded and re-fetched', () => {
    seed('PLANTED');
    const { calls, gitFetch } = fetchStub();
    const noHead = () => { throw new Error('fatal: not a git repository'); };
    resolveSource(ext, { cacheDir, gitFetch, ...goodGit, gitResolveCommit: noHead });
    assert.equal(calls.length, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'BODY'), 'utf8'), 'FRESH');
    // An empty/null HEAD is treated the same as a throwing one.
    seed('PLANTED');
    resolveSource(ext, { cacheDir, gitFetch, ...goodGit, gitResolveCommit: () => null });
    assert.equal(calls.length, 2);
  });

  test('a checkout whose HEAD is not the pinned ref’s commit is discarded and re-fetched', () => {
    seed('PLANTED');
    const { calls, gitFetch } = fetchStub();
    resolveSource(ext, { cacheDir, gitFetch, ...goodGit, gitRefCommit: () => 'b'.repeat(40) });
    assert.equal(calls.length, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'BODY'), 'utf8'), 'FRESH');
  });

  test('checkoutMatches is false on any thrown git error rather than propagating', () => {
    const boom = () => { throw new Error('boom'); };
    assert.equal(checkoutMatches('/nowhere', ext, { ...goodGit, gitOriginUrl: boom }), false);
    assert.equal(checkoutMatches('/nowhere', ext, { ...goodGit, gitRefCommit: boom }), false);
    assert.equal(checkoutMatches('/nowhere', ext, goodGit), true);
  });

  test('real git: a planted clone of a different repo at the derived path is replaced by the pinned source', { skip: gitOk ? false : 'git not available' }, () => {
    const mkRepo = (label) => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `src-460-${label}-`));
      const git = (...a) => {
        const r = spawnSync('git', ['-C', work, ...a], { encoding: 'utf8' });
        assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
      };
      assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      fs.writeFileSync(path.join(work, 'BODY'), label);
      git('add', '-A');
      git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', label);
      git('tag', REF);
      return work;
    };
    const good = mkRepo('GOOD');
    const evil = mkRepo('EVIL');
    const realExt = { ...ext, source: `file://${good}` };
    const realDest = path.join(cacheDir, sha256(`${realExt.source}@${REF}`).slice(0, 24));
    // Attacker pre-seeds the derivable path with a clone of THEIR repo, tag and all.
    fs.mkdirSync(cacheDir, { recursive: true });
    assert.equal(spawnSync('git', ['clone', '--quiet', '--', `file://${evil}`, realDest]).status, 0);
    assert.equal(fs.readFileSync(path.join(realDest, 'BODY'), 'utf8'), 'EVIL');

    const r = resolveSource(realExt, { cacheDir });
    assert.equal(r.root, realDest);
    assert.equal(fs.readFileSync(path.join(realDest, 'BODY'), 'utf8'), 'GOOD', 'foreign-origin clone was not served');
    const headOfGood = spawnSync('git', ['-C', good, 'rev-parse', REF], { encoding: 'utf8' }).stdout.trim();
    assert.equal(r.commit, headOfGood);
    // Second resolve: the now-valid checkout is served as-is (no clobber).
    fs.writeFileSync(path.join(realDest, 'MARK'), '1');
    resolveSource(realExt, { cacheDir });
    assert.ok(fs.existsSync(path.join(realDest, 'MARK')), 'valid cache served without re-clone');
    for (const d of [good, evil]) fs.rmSync(d, { recursive: true, force: true });
  });
});
