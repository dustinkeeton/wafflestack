import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newerRelease } from '../lib/toolkit-ref.mjs';
import {
  resolveLatestRelease,
  updateVerdict,
  defaultUpdateCacheFile,
  readUpdateCache,
  NO_UPDATE_VERDICT,
  UPDATE_CACHE_TTL_MS,
  UPDATE_FAIL_TTL_MS,
} from '../lib/update-check.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';

// #608 — the newer-release verdict `upgrade`, `doctor` and `state` share, and the cached,
// time-boxed, fail-silent lookup behind it. Every test injects `lsRemote` and a tmp cache file.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-10-11T00:00:00.000Z');

const forbidNetwork = () => {
  throw new Error('lsRemote was called — this path must not touch the network');
};

function fakeLsRemote(stdout) {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    if (stdout instanceof Error) throw stdout;
    return stdout;
  };
  return Object.assign(fn, { calls });
}

const tags = (...names) => names.map((t) => `${SHA}\trefs/tags/${t}`).join('\n');

const install = (over = {}) => ({
  status: 'unreleased', version: '0.17.2', commit: SHA, tag: null, ref: null, origin: 'npm-install',
  repo: 'dustinkeeton/wafflestack', lockRepo: 'dustinkeeton/wafflestack', latestTag: 'v0.17.2', lookupError: null, ...over,
});

describe('newerRelease (#608)', () => {
  const id = { latestTag: 'v0.18.0', repo: 'o/r', lockRepo: null };
  test('newer → the tag and the pinned remedy', () => {
    assert.deepEqual(newerRelease(id, '0.17.2'), { tag: 'v0.18.0', command: 'npx --yes github:o/r#v0.18.0 upgrade' });
  });
  test('equal, older, or no tag → null', () => {
    assert.equal(newerRelease(id, '0.18.0'), null);
    assert.equal(newerRelease(id, '0.19.0'), null);
    assert.equal(newerRelease({ ...id, latestTag: null }, '0.17.2'), null);
    assert.equal(newerRelease(null, '0.17.2'), null);
    assert.equal(newerRelease(id, null), null);
  });
  test('no repo → command null; `lockRepo` stands in for `repo`', () => {
    assert.deepEqual(newerRelease({ latestTag: 'v0.18.0', repo: null, lockRepo: null }, '0.17.2'), { tag: 'v0.18.0', command: null });
    assert.equal(newerRelease({ latestTag: 'v0.18.0', repo: null, lockRepo: 'l/r' }, '0.17.2').command, 'npx --yes github:l/r#v0.18.0 upgrade');
  });
});

describe('resolveLatestRelease (#608)', () => {
  let tmp;
  let cacheFile;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-'));
    cacheFile = path.join(tmp, 'cache', 'latest-release.json');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const resolve = (opts) => resolveLatestRelease({ identity: install(), cacheFile, now: () => T0, ...opts });

  test('a remote answer is returned and cached', () => {
    const lsRemote = fakeLsRemote(tags('v0.17.2', 'v0.18.0'));
    const r = resolve({ lsRemote });
    assert.deepEqual(r, { latestTag: 'v0.18.0', source: 'remote', checkedAt: '2026-10-11T00:00:00.000Z' });
    assert.deepEqual(lsRemote.calls, ['https://github.com/dustinkeeton/wafflestack.git']);
    assert.deepEqual(readUpdateCache(cacheFile)['dustinkeeton/wafflestack'], { latestTag: 'v0.18.0', checkedAt: '2026-10-11T00:00:00.000Z' });
  });

  test('a fresh cache entry makes zero lookups; an expired one refetches', () => {
    resolve({ lsRemote: fakeLsRemote(tags('v0.18.0')) });
    const hit = resolve({ lsRemote: forbidNetwork, now: () => T0 + UPDATE_CACHE_TTL_MS - 1 });
    assert.deepEqual(hit, { latestTag: 'v0.18.0', source: 'cache', checkedAt: '2026-10-11T00:00:00.000Z' });
    const lsRemote = fakeLsRemote(tags('v0.19.0'));
    const miss = resolve({ lsRemote, now: () => T0 + UPDATE_CACHE_TTL_MS });
    assert.equal(miss.latestTag, 'v0.19.0');
    assert.equal(miss.source, 'remote');
    assert.equal(lsRemote.calls.length, 1);
  });

  test('a failed lookup is silent, falls back to the identity, and is negatively cached for the fail TTL', () => {
    const r = resolve({ lsRemote: fakeLsRemote(new Error('timed out')) });
    assert.deepEqual(r, { latestTag: 'v0.17.2', source: 'changelog', checkedAt: null });
    assert.equal(readUpdateCache(cacheFile)['dustinkeeton/wafflestack'].failed, true);
    assert.equal(resolve({ lsRemote: forbidNetwork, now: () => T0 + UPDATE_FAIL_TTL_MS - 1 }).source, 'changelog');
    const retry = fakeLsRemote(tags('v0.18.0'));
    assert.equal(resolve({ lsRemote: retry, now: () => T0 + UPDATE_FAIL_TTL_MS }).source, 'remote');
    assert.equal(retry.calls.length, 1);
  });

  test('a remote answer of zero tags is no verdict, fresh or cached — never the CHANGELOG tag', () => {
    const identity = install({ latestTag: 'v0.18.0' });
    const fresh = resolve({ identity, lsRemote: fakeLsRemote(tags()) });
    assert.deepEqual(fresh, { latestTag: null, source: 'remote', checkedAt: '2026-10-11T00:00:00.000Z' });
    assert.equal(updateVerdict(identity, '0.17.2', fresh).available, false);
    const cached = resolve({ identity, lsRemote: forbidNetwork });
    assert.deepEqual(cached, { latestTag: null, source: 'cache', checkedAt: '2026-10-11T00:00:00.000Z' });
    assert.equal(updateVerdict(identity, '0.17.2', cached).available, false);
  });

  test('offline reads a fresh cache, but a stale or absent one is neither fetched nor written', () => {
    resolve({ lsRemote: fakeLsRemote(tags('v0.18.0')) });
    assert.equal(resolve({ offline: true, lsRemote: forbidNetwork }).source, 'cache');
    const stale = resolve({ offline: true, lsRemote: forbidNetwork, now: () => T0 + UPDATE_CACHE_TTL_MS });
    assert.deepEqual(stale, { latestTag: 'v0.17.2', source: 'changelog', checkedAt: null });
    fs.rmSync(cacheFile);
    resolve({ offline: true, lsRemote: forbidNetwork });
    assert.equal(fs.existsSync(cacheFile), false, 'offline never writes');
  });

  test('a corrupt cache file is a miss', () => {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, '{not json');
    const lsRemote = fakeLsRemote(tags('v0.18.0'));
    assert.equal(resolve({ lsRemote }).source, 'remote');
    assert.equal(lsRemote.calls.length, 1);
  });

  test('a checkout answers from its local tags and never touches the network or the cache', () => {
    const r = resolve({ identity: install({ origin: 'checkout', latestTag: 'v0.18.0' }), lsRemote: forbidNetwork });
    assert.deepEqual(r, { latestTag: 'v0.18.0', source: 'local-tags', checkedAt: null });
    assert.equal(fs.existsSync(path.dirname(cacheFile)), false);
  });

  test('a checkout with no local tags labels its CHANGELOG fallback `changelog` (#694)', () => {
    const identity = install({ origin: 'checkout', latestTag: 'v0.17.2', latestTagSource: 'changelog' });
    assert.deepEqual(resolve({ identity, lsRemote: forbidNetwork }), { latestTag: 'v0.17.2', source: 'changelog', checkedAt: null });
    assert.equal(fs.existsSync(path.dirname(cacheFile)), false);
  });

  test('no repo, no identity, or an unwritable cache never throws', () => {
    assert.equal(resolve({ identity: install({ repo: null }), lsRemote: forbidNetwork }).source, 'changelog');
    assert.deepEqual(resolve({ identity: null, lsRemote: forbidNetwork }), { latestTag: null, source: null, checkedAt: null });
    fs.writeFileSync(path.join(tmp, 'cache'), 'a file where the dir should be');
    assert.equal(resolve({ lsRemote: fakeLsRemote(tags('v0.18.0')) }).source, 'remote');
  });

  test('defaultUpdateCacheFile honors an absolute XDG_CACHE_HOME only', () => {
    assert.equal(defaultUpdateCacheFile({ XDG_CACHE_HOME: '/x/cache' }), path.join('/x/cache', 'wafflestack', 'latest-release.json'));
    assert.equal(defaultUpdateCacheFile({ XDG_CACHE_HOME: 'rel' }), path.join(os.homedir(), '.cache', 'wafflestack', 'latest-release.json'));
  });
});

describe('updateVerdict (#608)', () => {
  test('judges the resolved tag against the running version', () => {
    const latest = { latestTag: 'v0.18.0', source: /** @type {const} */ ('cache'), checkedAt: 'then' };
    assert.deepEqual(updateVerdict(install(), '0.17.2', latest), {
      latestTag: 'v0.18.0', available: true, command: 'npx --yes github:dustinkeeton/wafflestack#v0.18.0 upgrade', checkedAt: 'then', source: 'cache',
    });
    assert.equal(updateVerdict(install(), '0.18.0', latest).available, false);
    assert.deepEqual(updateVerdict(null, '0.17.2', latest), { ...NO_UPDATE_VERDICT, latestTag: 'v0.18.0', checkedAt: 'then', source: 'cache' });
  });
});

describe('doctor prints the newer-release note, informationally (#608)', () => {
  let toolkitRoot;
  let cwd;
  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-doctor-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'update-doctor-project-'));
    const write = (root, rel, content) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
    write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
    write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nbody\n');
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.17.2' }).ok, true);
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  const update = { latestTag: 'v0.18.0', available: true, command: 'npx --yes github:o/r#v0.18.0 upgrade', checkedAt: null, source: 'cache' };

  test('the note appears, `ok` stays true, and no version-skew note is invented', () => {
    const r = doctor({ cwd, toolkitVersion: '0.17.2', update });
    assert.equal(r.ok, true);
    assert.ok(r.notes.includes('a newer toolkit release exists: v0.18.0 — this CLI is 0.17.2. To move to it, run:\n  npx --yes github:o/r#v0.18.0 upgrade'));
    assert.ok(!r.notes.some((n) => n.startsWith('version skew')));
  });

  test('no command names the tag; no verdict prints nothing', () => {
    assert.ok(doctor({ cwd, toolkitVersion: '0.17.2', update: { ...update, command: null } }).notes.some((n) => /pinned to v0\.18\.0/.test(n)));
    for (const u of [null, NO_UPDATE_VERDICT]) {
      assert.ok(!doctor({ cwd, toolkitVersion: '0.17.2', update: u }).notes.some((n) => /newer toolkit release/.test(n)));
    }
  });
});

describe('the CLI check from this checkout stays offline (#608)', () => {
  test('`doctor` and `state` from a checkout write nothing to the user cache', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'update-xdg-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cli-project-'));
    try {
      fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'targets: [claude]\nstacks: []\nconfig: {}\n');
      assert.equal(renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' }).ok, true);
      const env = { ...process.env, XDG_CACHE_HOME: xdg };
      delete env.WAFFLESTACK_OFFLINE;
      for (const args of [['doctor'], ['state', '--json']]) {
        const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'installer/cli.mjs'), ...args, '--cwd', cwd], { encoding: 'utf8', env, timeout: 60000 });
        assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
      }
      assert.deepEqual(fs.readdirSync(xdg), [], 'a checkout answers from local tags — no cache file');
    } finally {
      for (const d of [xdg, cwd]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
