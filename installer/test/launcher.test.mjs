import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findLock, readPin, normalizeSource, trustedSources, releaseTagFor, readCacheEntry, fetchToolkit,
  readApprovals, recordApproval, decideFollow, followLock, isInteractive, exitCodeOf,
  defaultLauncherCacheDir, defaultLauncherConfigFile, LAUNCHER_RECORD, LAUNCHED_ENV, DEFAULT_TRUSTED_SOURCES, MIN_FOLLOW_RELEASE,
} from '../lib/launcher.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const UPSTREAM = 'github:dustinkeeton/wafflestack';
const UPSTREAM_URL = 'https://github.com/dustinkeeton/wafflestack.git';
const FORK_URL = 'https://github.com/forker/wafflestack.git';

function write(dir, rel, text) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function writeLock(dir, toolkit, rel = '.waffle/waffle.lock.json') {
  return write(dir, rel, JSON.stringify({ toolkitVersion: '0.18.0', ...(toolkit === undefined ? {} : { toolkit }), files: {} }));
}

const releasePin = (commit = SHA_B, source = UPSTREAM, ref = 'v0.18.0') => ({ source, sourceType: 'git', ref, commit, status: 'release' });

function seedCache(root, sha, cliBody = 'process.exit(0);\n', extra = {}) {
  const dir = path.join(root, 'toolkits', sha);
  write(dir, 'node_modules/wafflestack/installer/cli.mjs', cliBody);
  write(dir, LAUNCHER_RECORD, JSON.stringify({ schema: 1, source: UPSTREAM, commit: sha, tag: 'v0.18.0', trust: 'tagged', version: '0.18.0', resolved: null, toolkitRoot: 'node_modules/wafflestack', fetchedAt: 'x', fetchedBy: null, ...extra }));
  return dir;
}

/** A fake `npm install --prefix <tmp> … github:o/r#<sha>` that lays out the npx-shaped tree. */
function fakeNpm(calls, { resolvedSha = null, name = 'wafflestack', status = 0 } = {}) {
  return (args) => {
    calls.push(args);
    if (status !== 0) return { status, stderr: 'boom' };
    const prefix = args[args.indexOf('--prefix') + 1];
    const sha = resolvedSha ?? args.at(-1).split('#')[1];
    write(prefix, 'node_modules/wafflestack/package.json', JSON.stringify({ name, version: '0.18.0' }));
    write(prefix, 'node_modules/wafflestack/installer/cli.mjs', 'process.exit(0);\n');
    write(prefix, 'node_modules/.package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/wafflestack': { version: '0.18.0', resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${sha}` } },
    }));
    write(prefix, 'package.json', '{}');
    return { status: 0, stderr: '' };
  };
}

function fakeSpawn(calls, code = 7) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    process.nextTick(() => child.emit('exit', code, null));
    return child;
  };
}

/** ls-remote stub keyed by URL; counts calls. */
function lsRemoteFrom(calls, byUrl) {
  return (url) => {
    calls.push(url);
    if (!(url in byUrl)) throw new Error(`no remote ${url}`);
    return byUrl[url];
  };
}

let tmp;
let consumer;
let root;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  consumer = path.join(tmp, 'repo');
  root = path.join(tmp, 'cache', 'wafflestack');
  fs.mkdirSync(consumer, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function harness(over = {}) {
  const calls = { ls: [], npm: [], spawn: [], said: [], prompts: [] };
  const ctx = {
    command: 'doctor', argv: ['doctor'], cwd: consumer, env: {}, noFollow: false, offline: false, interactive: false, root,
    version: '0.20.0',
    identity: () => ({ origin: 'npm-install', commit: SHA_A, version: '0.20.0' }),
    trusted: () => ({ sources: [...DEFAULT_TRUSTED_SOURCES], warning: null }),
    lsRemote: lsRemoteFrom(calls.ls, { [UPSTREAM_URL]: `${SHA_B}\trefs/tags/v0.18.0\n` }),
    runNpm: fakeNpm(calls.npm),
    spawnChild: fakeSpawn(calls.spawn),
    prompt: async (q) => { calls.prompts.push(q); throw new Error('must not prompt'); },
    stderr: (s) => calls.said.push(s),
    ...over,
  };
  return { ctx, calls };
}

describe('findLock / readPin / normalizeSource', () => {
  test('finds the lock in cwd, two levels up, under legacy names; ignores the local lock', () => {
    assert.equal(findLock(consumer), null);
    write(consumer, '.waffle/waffle.local.lock.json', '{}');
    assert.equal(findLock(consumer), null, 'the local lock is never the pin');
    const deep = path.join(consumer, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    writeLock(consumer, releasePin());
    assert.equal(findLock(deep).dir, consumer);
    fs.rmSync(path.join(consumer, '.waffle'), { recursive: true });
    write(consumer, '.waffle.lock.json', '{}');
    assert.equal(findLock(deep).file, path.join(consumer, '.waffle.lock.json'));
  });

  test('a release block is a pin; a non-release or null block is none; a bad sha/source is malformed', () => {
    assert.deepEqual(readPin(writeLock(consumer, releasePin())), { kind: 'pin', source: UPSTREAM, commit: SHA_B, ref: 'v0.18.0', version: '0.18.0' });
    assert.equal(readPin(writeLock(consumer, { ...releasePin(), status: 'unreleased', commit: null })).kind, 'none');
    assert.match(readPin(writeLock(consumer, { ...releasePin(), status: 'unverified' })).reason, /unverified/);
    assert.equal(readPin(writeLock(consumer, { ...releasePin(), commit: null })).kind, 'none');
    assert.equal(readPin(writeLock(consumer, undefined)).kind, 'none');
    assert.equal(readPin(writeLock(consumer, releasePin('abc'))).kind, 'malformed');
    assert.equal(readPin(writeLock(consumer, releasePin(SHA_B, 'https://evil.example/x'))).kind, 'malformed');
    assert.equal(readPin(writeLock(consumer, releasePin(SHA_B, 'github:-x/y'))).kind, 'malformed');
    assert.equal(readPin(write(consumer, '.waffle/waffle.lock.json', '{not json')).kind, 'malformed');
  });

  test('normalizeSource lowercases a github slug and rejects everything else', () => {
    assert.equal(normalizeSource('github:DustinKeeton/WaffleStack'), UPSTREAM);
    assert.equal(normalizeSource('dustinkeeton/wafflestack'), null);
    assert.equal(normalizeSource('github:a/b;rm'), null);
  });
});

describe('trustedSources', () => {
  test('default only; a user file adds; a malformed file falls back with a warning', () => {
    const file = path.join(tmp, 'cfg', 'config.json');
    assert.deepEqual(trustedSources({ file }).sources, [UPSTREAM]);
    write(tmp, 'cfg/config.json', JSON.stringify({ trustedSources: ['github:Me/Fork'] }));
    assert.deepEqual(trustedSources({ file }).sources, [UPSTREAM, 'github:me/fork']);
    write(tmp, 'cfg/config.json', JSON.stringify({ trustedSources: 'github:me/fork' }));
    const bad = trustedSources({ file });
    assert.deepEqual(bad.sources, [UPSTREAM]);
    assert.match(bad.warning, /must be an array/);
  });

  test('repo config can never extend the list — only the user config file is read', () => {
    write(consumer, '.waffle/waffle.yaml', 'trustedSources: [github:evil/wafflestack]\n');
    const read = [];
    trustedSources({ file: path.join(tmp, 'none.json'), readFile: (p) => { read.push(p); throw new Error('ENOENT'); } });
    assert.deepEqual(read, [path.join(tmp, 'none.json')]);
  });

  test('config and cache dirs follow absolute XDG values only', () => {
    assert.equal(defaultLauncherCacheDir({ XDG_CACHE_HOME: '/x/c' }), path.join('/x/c', 'wafflestack'));
    assert.equal(defaultLauncherCacheDir({ XDG_CACHE_HOME: 'rel' }), path.join(os.homedir(), '.cache', 'wafflestack'));
    assert.equal(defaultLauncherConfigFile({ XDG_CONFIG_HOME: '/x/g' }), path.join('/x/g', 'wafflestack', 'config.json'));
  });
});

describe('releaseTagFor', () => {
  test('asks the source itself and answers only for that exact commit', () => {
    const ls = [];
    const lsRemote = lsRemoteFrom(ls, { [UPSTREAM_URL]: `${SHA_B}\trefs/tags/v0.18.0\n${SHA_C}\trefs/tags/v0.17.0\n${SHA_A}\trefs/tags/nightly\n` });
    assert.equal(releaseTagFor(UPSTREAM, SHA_B, { lsRemote }), 'v0.18.0');
    assert.equal(releaseTagFor(UPSTREAM, SHA_A, { lsRemote }), null, 'a non-release tag is no release');
    assert.deepEqual(ls, [UPSTREAM_URL, UPSTREAM_URL]);
    assert.throws(() => releaseTagFor('github:x/y', SHA_B, { lsRemote }), /no remote/);
  });
});

describe('decideFollow / followLock — the decision table', () => {
  test('older pinned release, trusted + tagged: fetch once, run the cached CLI with the same argv, pass its exit code through (AC1)', async () => {
    writeLock(consumer, releasePin());
    const { ctx, calls } = harness({ argv: ['doctor', '--cwd', consumer, '--no-follow-lock-not'] });
    const r = await followLock(ctx);
    assert.deepEqual(r, { action: 'exit', code: 7 });
    assert.equal(calls.npm.length, 1);
    assert.equal(calls.npm[0].at(-1), `github:dustinkeeton/wafflestack#${SHA_B}`);
    assert.ok(calls.npm[0].includes('--ignore-scripts'));
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.spawn[0].args[0], path.join(root, 'toolkits', SHA_B, 'node_modules', 'wafflestack', 'installer', 'cli.mjs'));
    assert.deepEqual(calls.spawn[0].args.slice(1), ['doctor', '--cwd', consumer, '--no-follow-lock-not']);
    assert.equal(calls.spawn[0].opts.env[LAUNCHED_ENV], SHA_B);
    const rec = JSON.parse(fs.readFileSync(path.join(root, 'toolkits', SHA_B, LAUNCHER_RECORD), 'utf8'));
    assert.equal(rec.trust, 'tagged');
    assert.equal(rec.tag, 'v0.18.0');
    assert.equal(rec.fetchedBy, '0.20.0');
    assert.match(rec.resolved, new RegExp(`#${SHA_B}$`));

    const again = harness();
    assert.deepEqual(await followLock(again.ctx), { action: 'exit', code: 7 });
    assert.equal(again.calls.npm.length, 0, 'a cached commit is never fetched twice');
    assert.equal(again.calls.ls.length, 0, 'a cache hit costs no network');
  });

  test('no lock: continue in-process with one note naming the installed version (AC2)', async () => {
    const { ctx, calls } = harness();
    assert.deepEqual(await followLock(ctx), { action: 'continue' });
    assert.equal(calls.said.length, 1);
    assert.match(calls.said[0], /no \.waffle\/waffle\.lock\.json .* running installed wafflestack 0\.20\.0/);
  });

  test('a null pin continues with a note naming the version and the reason', async () => {
    writeLock(consumer, { ...releasePin(), status: 'unreleased', commit: null, ref: null });
    const { ctx, calls } = harness();
    assert.deepEqual(await followLock(ctx), { action: 'continue' });
    assert.match(calls.said[0], /status unreleased — running installed wafflestack 0\.20\.0/);
  });

  test('a re-exec\'d child never launches again, even on a mismatching pin (AC3)', async () => {
    writeLock(consumer, releasePin());
    const { ctx, calls } = harness({ env: { [LAUNCHED_ENV]: SHA_C } });
    assert.deepEqual(await followLock(ctx), { action: 'continue' });
    assert.deepEqual([calls.said.length, calls.spawn.length, calls.npm.length, calls.ls.length], [0, 0, 0, 0]);
  });

  test('a tag re-cut upstream does not change what runs: the cached commit runs, no lookup (AC4)', async () => {
    writeLock(consumer, releasePin());
    seedCache(root, SHA_B);
    const { ctx, calls } = harness({ lsRemote: lsRemoteFrom([], { [UPSTREAM_URL]: `${SHA_C}\trefs/tags/v0.18.0\n` }) });
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 7 });
    assert.equal(calls.spawn[0].opts.env[LAUNCHED_ENV], SHA_B);
    assert.equal(calls.npm.length, 0);
  });

  test('an untagged sha from the trusted source is refused without fetching', async () => {
    writeLock(consumer, releasePin(SHA_C));
    const { ctx, calls } = harness();
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 1 });
    assert.match(calls.said[0], /no release tag in github:dustinkeeton\/wafflestack points at cccccccccccc/);
    assert.match(calls.said[0], /--no-follow-lock/);
    assert.doesNotMatch(calls.said[0], /trustedSources/, 'never suggest trusting an already-trusted source');
    assert.match(calls.said[0], /re-run the command in a terminal/);
    assert.deepEqual([calls.npm.length, calls.spawn.length], [0, 0]);
  });

  test('a sha tagged only on a fork, pinned through the upstream source, is refused without fetching', async () => {
    writeLock(consumer, releasePin(SHA_C));
    const { ctx, calls } = harness({
      lsRemote: lsRemoteFrom([], { [UPSTREAM_URL]: `${SHA_B}\trefs/tags/v0.18.0\n`, [FORK_URL]: `${SHA_C}\trefs/tags/v0.18.1\n` }),
    });
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 1 });
    assert.deepEqual([calls.npm.length, calls.spawn.length], [0, 0]);
  });

  test('an untrusted source is refused without a lookup or a fetch', async () => {
    writeLock(consumer, releasePin(SHA_B, 'github:evil/wafflestack'));
    const { ctx, calls } = harness();
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 1 });
    assert.match(calls.said[0], /github:evil\/wafflestack is not a trusted source/);
    assert.match(calls.said[0], /trustedSources/);
    assert.deepEqual([calls.ls.length, calls.npm.length, calls.spawn.length], [0, 0, 0]);
  });

  test('a lookup failure refuses (cannot verify) without fetching', async () => {
    writeLock(consumer, releasePin());
    const { ctx, calls } = harness({ lsRemote: () => { throw new Error('network down'); } });
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 1 });
    assert.match(calls.said[0], /could not list .* network down/);
    assert.doesNotMatch(calls.said[0], /trustedSources/, 'never suggest trusting an already-trusted source');
    assert.equal(calls.npm.length, 0);
  });

  test('a malformed user config is named on stderr, not silently dropped', async () => {
    writeLock(consumer, releasePin(SHA_B, 'github:me/fork'));
    const file = path.join(tmp, 'cfg', 'config.json');
    write(tmp, 'cfg/config.json', JSON.stringify({ trustedSources: 'github:me/fork' }));
    const { ctx, calls } = harness({ trusted: () => trustedSources({ file }) });
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 1 });
    assert.equal(calls.said.length, 2);
    assert.match(calls.said[0], /^wafflestack: warning: ignoring .*cfg[\\/]config\.json: trustedSources must be an array/);
    assert.match(calls.said[1], /github:me\/fork is not a trusted source/);
  });

  test('never prompts when not interactive: CI, --yes, --untrusted-config, or no TTY', () => {
    const tty = { stdinTTY: true, stderrTTY: true };
    assert.equal(isInteractive({ argv: ['render'], env: {}, ...tty }), true);
    assert.equal(isInteractive({ argv: ['render'], env: { CI: 'true' }, ...tty }), false);
    assert.equal(isInteractive({ argv: ['uninstall', '--yes'], env: {}, ...tty }), false);
    assert.equal(isInteractive({ argv: ['render', '--untrusted-config'], env: {}, ...tty }), false);
    assert.equal(isInteractive({ argv: ['render'], env: {}, stdinTTY: false, stderrTTY: true }), false);
  });

  test(`a release older than ${MIN_FOLLOW_RELEASE} from the trusted source is never auto-followed (F4)`, async () => {
    assert.equal(MIN_FOLLOW_RELEASE, 'v0.15.0');
    writeLock(consumer, releasePin(SHA_C, UPSTREAM, 'v0.14.0'));
    const old = { [UPSTREAM_URL]: `${SHA_C}\trefs/tags/v0.14.0\n${SHA_B}\trefs/tags/v0.15.0\n` };
    const ci = harness({ env: { CI: 'true' }, lsRemote: lsRemoteFrom([], old) });
    assert.deepEqual(await followLock(ci.ctx), { action: 'exit', code: 1 });
    assert.match(ci.calls.said[0], /tags cccccccccccc as v0\.14\.0, older than v0\.15\.0/);
    assert.deepEqual([ci.calls.npm.length, ci.calls.spawn.length], [0, 0]);

    const asked = harness({ interactive: true, lsRemote: lsRemoteFrom([], old), prompt: async (q) => { asked.calls.prompts.push(q); return false; } });
    assert.deepEqual(await followLock(asked.ctx), { action: 'exit', code: 1 });
    assert.equal(asked.calls.prompts.length, 1, 'below the floor asks instead of fetching');
    assert.match(asked.calls.prompts[0], /older than v0\.15\.0/);
    assert.doesNotMatch(asked.calls.prompts[0], /NOT a verified release/, 'an old release is still a verified release');
    assert.deepEqual([asked.calls.npm.length, readApprovals(root).length], [0, 0]);

    writeLock(consumer, releasePin(SHA_B, UPSTREAM, 'v0.15.0'));
    const atFloor = harness({ lsRemote: lsRemoteFrom([], old) });
    assert.deepEqual(await followLock(atFloor.ctx), { action: 'exit', code: 7 });
    assert.equal(atFloor.calls.npm.length, 1, 'the floor release itself is followed');
  });

  test('the prompt for an untagged sha says it is unverified and may be a fork commit (F6)', async () => {
    writeLock(consumer, releasePin(SHA_C));
    const { ctx, calls } = harness({ interactive: true, prompt: async (q) => { calls.prompts.push(q); return false; } });
    await followLock(ctx);
    assert.match(calls.prompts[0], /github:dustinkeeton\/wafflestack@c{40}, which is NOT a verified release/);
    assert.match(calls.prompts[0], /any fork of github:dustinkeeton\/wafflestack .* may be anyone's code/);
  });

  test('interactive yes records the approval and fetches; the same pair is never asked again', async () => {
    writeLock(consumer, releasePin(SHA_C, 'github:me/fork'));
    const first = harness({ interactive: true, prompt: async (q) => { first.calls.prompts.push(q); return true; } });
    assert.deepEqual(await followLock(first.ctx), { action: 'exit', code: 7 });
    assert.equal(first.calls.prompts.length, 1);
    assert.match(first.calls.prompts[0], /github:me\/fork@c{40}/);
    assert.deepEqual(readApprovals(root).map((a) => [a.source, a.commit]), [['github:me/fork', SHA_C]]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'toolkits', SHA_C, LAUNCHER_RECORD), 'utf8')).trust, 'approved');

    fs.rmSync(path.join(root, 'toolkits'), { recursive: true });
    const second = harness({ interactive: true });
    assert.deepEqual(await followLock(second.ctx), { action: 'exit', code: 7 });
    assert.equal(second.calls.prompts.length, 0, 'an approved pair is not asked twice');
    assert.equal(second.calls.npm.length, 1);
  });

  test('interactive no refuses and records nothing', async () => {
    writeLock(consumer, releasePin(SHA_C));
    const { ctx, calls } = harness({ interactive: true, prompt: async () => false });
    assert.deepEqual(await followLock(ctx), { action: 'exit', code: 1 });
    assert.deepEqual(readApprovals(root), []);
    assert.equal(calls.npm.length, 0);
  });

  test('offline: an uncached pin is refused without fetching; a cached one runs', async () => {
    writeLock(consumer, releasePin());
    const miss = harness({ offline: true });
    assert.deepEqual(await followLock(miss.ctx), { action: 'exit', code: 1 });
    assert.match(miss.calls.said[0], /not cached, and --offline is set/);
    assert.deepEqual([miss.calls.ls.length, miss.calls.npm.length], [0, 0]);
    seedCache(root, SHA_B);
    const hit = harness({ offline: true });
    assert.deepEqual(await followLock(hit.ctx), { action: 'exit', code: 7 });
  });

  test('--no-follow-lock (flag or env twin, resolved by the caller) continues; the child never sees the flag', async () => {
    writeLock(consumer, releasePin());
    const { ctx, calls } = harness({ noFollow: true });
    assert.deepEqual(await followLock(ctx), { action: 'continue' });
    assert.equal(calls.spawn.length, 0);
    seedCache(root, SHA_B);
    const passed = harness({ argv: ['doctor', '--no-follow-lock'] });
    await followLock(passed.ctx);
    assert.deepEqual(passed.calls.spawn[0].args.slice(1), ['doctor']);
  });

  test('upgrade, help, validate, avatars, prepare-worktree, --help and unknown commands never follow', () => {
    writeLock(consumer, releasePin());
    for (const [command, argv] of [['upgrade'], ['help'], ['validate'], ['avatars'], ['prepare-worktree'], [undefined, []], ['nope'], ['render', ['render', '--help']]]) {
      const { ctx } = harness({ command, argv: argv ?? [command], identity: () => { throw new Error('identity not needed'); } });
      assert.deepEqual(decideFollow(ctx), { action: 'continue', note: null }, String(command));
    }
  });

  test('a toolkit checkout never follows; a matching commit continues silently', () => {
    writeLock(consumer, releasePin());
    assert.deepEqual(decideFollow(harness({ identity: () => ({ origin: 'checkout', commit: SHA_C, version: 'x' }) }).ctx), { action: 'continue', note: null });
    assert.deepEqual(decideFollow(harness({ identity: () => ({ origin: 'npm-install', commit: SHA_B, version: 'x' }) }).ctx), { action: 'continue', note: null });
  });

  test('a malformed pin refuses rather than running another version', () => {
    writeLock(consumer, releasePin('nothex'));
    const d = decideFollow(harness().ctx);
    assert.equal(d.action, 'refuse');
  });

  test('a tag that differs from the lock ref still runs, with a note', async () => {
    writeLock(consumer, releasePin(SHA_B, UPSTREAM, 'v0.17.9'));
    const { ctx, calls } = harness();
    await followLock(ctx);
    assert.match(calls.said[0], /names v0\.17\.9, but .* as v0\.18\.0/);
  });

  test('exitCodeOf maps a signal to 128 + its number', () => {
    assert.equal(exitCodeOf({ code: 3, signal: null }), 3);
    assert.equal(exitCodeOf({ code: null, signal: 'SIGINT' }), 128 + os.constants.signals.SIGINT);
  });
});

describe('reexec signal forwarding (F5)', () => {
  test('SIGTERM to the launcher ends the child, and the launcher exits 143', { skip: process.platform === 'win32' }, async () => {
    const child = write(tmp, 'child.mjs', "process.stdout.write('ready\\n');\nsetTimeout(() => {}, 20000);\n");
    const parent = write(tmp, 'parent.mjs', [
      `import { reexec, exitCodeOf } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'installer', 'lib', 'launcher.mjs')).href)};`,
      `const r = await reexec({ entry: { cli: ${JSON.stringify(child)}, commit: 'x' }, argv: [], env: process.env });`,
      'process.exit(exitCodeOf(r));',
    ].join('\n'));
    const started = Date.now();
    const proc = spawn(process.execPath, [parent], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => proc.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(undefined); }));
    proc.kill('SIGTERM');
    const code = await new Promise((resolve) => proc.on('exit', (c) => resolve(c)));
    assert.equal(code, 128 + os.constants.signals.SIGTERM);
    assert.ok(Date.now() - started < 15000, 'the child did not run to completion');
  });
});

describe('fetchToolkit', () => {
  test('writes launcher.json last into toolkits/<sha>/ and returns the entry', () => {
    const calls = [];
    const entry = fetchToolkit({ root, source: UPSTREAM, commit: SHA_B, tag: 'v0.18.0', trust: 'tagged', runNpm: fakeNpm(calls) });
    assert.equal(entry.dir, path.join(root, 'toolkits', SHA_B));
    assert.deepEqual(Object.keys(entry).filter((k) => !['dir', 'cli'].includes(k)).sort(),
      ['commit', 'fetchedAt', 'fetchedBy', 'resolved', 'schema', 'source', 'tag', 'toolkitRoot', 'trust', 'version']);
    assert.equal(entry.toolkitRoot, 'node_modules/wafflestack');
    assert.deepEqual(readCacheEntry(root, SHA_B)?.commit, SHA_B);
    assert.deepEqual(fs.readdirSync(path.join(root, 'toolkits')), [SHA_B], 'no tmp dir left behind');
  });

  test('a resolved-sha mismatch, a non-wafflestack package or an npm failure throws and leaves no entry', () => {
    for (const opts of [{ resolvedSha: SHA_C }, { name: 'other' }, { status: 1 }]) {
      assert.throws(() => fetchToolkit({ root, source: UPSTREAM, commit: SHA_B, tag: null, trust: 'approved', runNpm: fakeNpm([], opts) }));
      assert.equal(readCacheEntry(root, SHA_B), null);
      assert.deepEqual(fs.readdirSync(path.join(root, 'toolkits')), []);
    }
  });

  test('a concurrent winner is kept and the loser discards its tmp; a half-written final dir is replaced', () => {
    seedCache(root, SHA_B, 'winner\n');
    const entry = fetchToolkit({ root, source: UPSTREAM, commit: SHA_B, tag: 'v0.18.0', trust: 'tagged', runNpm: fakeNpm([]) });
    assert.equal(fs.readFileSync(entry.cli, 'utf8'), 'winner\n');
    assert.deepEqual(fs.readdirSync(path.join(root, 'toolkits')), [SHA_B]);

    write(path.join(root, 'toolkits', SHA_C), 'partial', 'x');
    const fresh = fetchToolkit({ root, source: UPSTREAM, commit: SHA_C, tag: null, trust: 'approved', runNpm: fakeNpm([]) });
    assert.equal(fresh.commit, SHA_C);
    assert.equal(fs.existsSync(path.join(fresh.dir, 'partial')), false);
  });

  test('approvals round-trip and dedupe', () => {
    recordApproval(root, { source: 'github:me/fork', commit: SHA_C });
    recordApproval(root, { source: 'github:me/fork', commit: SHA_C });
    assert.equal(readApprovals(root).length, 1);
  });
});

describe('the CLI follows the lock end to end (#726)', () => {
  let dir;
  let fabCli;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-cli-'));
    const layoutRoot = path.join(dir, 'install', 'node_modules', 'wafflestack');
    for (const entry of ['installer', 'stacks', 'schema', 'toolkit.yaml', 'package.json', 'CHANGELOG.md']) {
      fs.cpSync(path.join(REPO_ROOT, entry), path.join(layoutRoot, entry), { recursive: true });
    }
    fs.cpSync(path.join(REPO_ROOT, 'node_modules', 'yaml'), path.join(layoutRoot, 'node_modules', 'yaml'), { recursive: true });
    write(dir, 'install/node_modules/.package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/wafflestack': { version: '0.20.0', resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` } },
    }));
    fabCli = path.join(layoutRoot, 'installer', 'cli.mjs');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const spawnCli = (args, env = {}) => {
    const full = { ...process.env, XDG_CACHE_HOME: path.join(dir, 'xdg-cache'), XDG_CONFIG_HOME: path.join(dir, 'xdg-config'), WAFFLESTACK_OFFLINE: '1', ...env };
    delete full[LAUNCHED_ENV];
    delete full.WAFFLESTACK_NO_FOLLOW_LOCK;
    Object.assign(full, env);
    return spawnSync(process.execPath, [fabCli, ...args], { encoding: 'utf8', env: full, timeout: 30000 });
  };

  test('a pinned, cached commit runs in place of the installed CLI; the guard and the hatch keep it in-process', () => {
    const repo = path.join(dir, 'repo');
    write(repo, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\nconfig: {}\n');
    writeLock(repo, releasePin());
    seedCache(path.join(dir, 'xdg-cache', 'wafflestack'), SHA_B,
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), launched: process.env.${LAUNCHED_ENV} }));\nprocess.exit(7);\n`);

    const r = spawnCli(['doctor', '--cwd', repo, '--no-color']);
    assert.equal(r.status, 7, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { argv: ['doctor', '--cwd', repo, '--no-color'], launched: SHA_B });

    const guarded = spawnCli(['doctor', '--cwd', repo], { [LAUNCHED_ENV]: SHA_B });
    assert.doesNotMatch(guarded.stdout, /"launched"/, 'a launched child dispatches in-process');
    const hatch = spawnCli(['doctor', '--cwd', repo, '--no-follow-lock']);
    assert.doesNotMatch(hatch.stdout, /"launched"/);
    const envHatch = spawnCli(['doctor', '--cwd', repo], { WAFFLESTACK_NO_FOLLOW_LOCK: '1' });
    assert.doesNotMatch(envHatch.stdout, /"launched"/);

    writeLock(repo, releasePin(SHA_C));
    const uncached = spawnCli(['doctor', '--cwd', repo]);
    assert.equal(uncached.status, 1);
    assert.match(uncached.stderr, /not cached, and --offline is set/);
  });
});
