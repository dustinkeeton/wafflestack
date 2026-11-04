import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareWorktree, resolvePreparationToolkit } from '../lib/prepare-worktree.mjs';
import { renderProject, readLock } from '../lib/render.mjs';
import { resolveToolkitIdentity } from '../lib/toolkit-ref.mjs';
import { sha256 } from '../lib/util.mjs';

import { fixture, git, write } from './prepare-fixture.mjs';

for (const nested of [false, true]) test(`mixed custom resources, all targets, helpers, repeated and partial preparation (${nested ? 'nested' : 'external'})`, (t) => {
  const f = fixture(t, nested);
  const before = git(f.root, 'status', '--porcelain');
  const index = git(f.wt, 'ls-files', '--stage');
  const lock = fs.readFileSync(path.join(f.wt, '.waffle/waffle.lock.json'));
  let result = f.run();
  assert.equal(result.status, 'ready', JSON.stringify(result));
  for (const [rel, hash] of Object.entries(readLock(f.wt).files)) if (/^\.(claude|agents|codex)\//.test(rel)) assert.equal(sha256(fs.readFileSync(path.join(f.wt, rel))), hash);
  assert.equal(fs.readFileSync(path.join(f.wt, '.claude/skills/custom/SKILL.md'), 'utf8'), 'custom skill');
  assert.equal(git(f.root, 'status', '--porcelain'), before);
  assert.equal(git(f.wt, 'ls-files', '--stage'), index);
  assert.deepEqual(fs.readFileSync(path.join(f.wt, '.waffle/waffle.lock.json')), lock);
  const file = path.join(f.wt, '.agents/skills/hello/helper.mjs');
  const mtime = fs.statSync(file).mtimeMs;
  assert.equal(f.run().status, 'no-op'); assert.equal(fs.statSync(file).mtimeMs, mtime);
  fs.unlinkSync(file); result = f.run();
  assert.equal(result.status, 'ready'); assert.deepEqual(result.generatedPaths, ['.agents/skills/hello/helper.mjs']);
});

for (const state of ['absent', 'empty']) test(`${state} directories receive a complete render`, (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.wt, '.claude'), { recursive: true });
  if (state === 'empty') fs.mkdirSync(path.join(f.wt, '.claude/skills'), { recursive: true });
  assert.equal(f.run().status, 'ready');
  assert.ok(fs.existsSync(path.join(f.wt, '.claude/agents/worker.md')));
});

test('unmanaged collisions and edited managed files fail before any writes', (t) => {
  const f = fixture(t);
  write(f.wt, '.claude/skills/hello/SKILL.md', 'user edit');
  let result = f.run();
  assert.equal(result.status, 'failed'); assert.ok(result.conflicts.includes('.claude/skills/hello/SKILL.md'));
  assert.equal(fs.existsSync(path.join(f.wt, '.agents/skills/hello/helper.mjs')), false);
  fs.unlinkSync(path.join(f.wt, '.claude/skills/hello/SKILL.md')); assert.equal(f.run().status, 'ready');
  write(f.wt, '.agents/skills/hello/helper.mjs', 'edited helper');
  assert.equal(f.run().status, 'failed');
});

test('unsafe symlinks never write into main', (t) => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, '.agents'), path.join(f.wt, '.agents'));
  const result = f.run();
  assert.equal(result.status, 'failed'); assert.match(result.errors.join(), /symlink/);
});

test('interrupted writes roll back; concurrent prepare fails closed', (t) => {
  const f = fixture(t); let n = 0;
  const result = f.run({ beforeWrite: () => {
    if (++n === 2) { assert.equal(f.run().status, 'failed'); throw new Error('injected write failure'); }
  } });
  assert.equal(result.status, 'failed');
  assert.equal(fs.existsSync(path.join(f.wt, '.claude/agents/worker.md')), false);
  assert.equal(f.run().status, 'ready');
});

test('canonical, destination and persisted main overlay policy with private-output gate', (t) => {
  const f = fixture(t);
  write(f.root, '.waffle/waffle.local.yaml', 'config:\n  greeting: PRIVATE_MARKER\n');
  let result = f.run();
  assert.equal(result.status, 'ready'); assert.match(result.notices.join(), /omits/);
  git(f.root, 'config', '--local', 'wafflestack.worktreeOverlay', 'main');
  result = f.run();
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(result.overlayMode, 'main-overlay');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MARKER/);
  assert.match(fs.readFileSync(path.join(f.wt, '.claude/skills/hello/SKILL.md'), 'utf8'), /PRIVATE_MARKER/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.wt, '.waffle/waffle.lock.json'), 'utf8'), /PRIVATE_MARKER/);
  assert.equal(f.run().status, 'no-op');
  write(f.wt, '.waffle/waffle.local.yaml', 'config:\n  greeting: DESTINATION\n');
  result = f.run(); assert.equal(result.overlayMode, 'destination-overlay'); assert.equal(result.status, 'ready');
  assert.equal(f.run({ untrustedConfig: true }).status, 'failed');
});

test('private changes to tracked output fail without leaking values', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 'ready');
  git(f.wt, 'add', '-f', '.claude/agents/worker.md');
  write(f.wt, '.waffle/waffle.local.yaml', 'config:\n  greeting: PRIVATE_MARKER\n');
  const result = f.run();
  assert.equal(result.status, 'failed'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MARKER/);
});

test('config/lock mismatch and missing release provenance have repair instructions', (t) => {
  const f = fixture(t);
  write(f.toolkit, 'stacks/demo/skills/hello/helper.mjs', 'changed toolkit');
  assert.match(f.run().errors.join(), /config\/lock\/pinned toolkit mismatch/);
  assert.throws(() => resolvePreparationToolkit({ lock: readLock(f.wt), toolkitRoot: f.toolkit, cwd: f.wt, offline: true }), /upgrade/);
});

test('offline cached worktree pin wins over a different running toolkit; cache misses fail explicitly', (t) => {
  const f = fixture(t);
  git(f.toolkit, 'init'); git(f.toolkit, 'add', '.'); git(f.toolkit, 'commit', '-m', 'version one'); git(f.toolkit, 'tag', 'v1.0.0');
  const commit = git(f.toolkit, 'rev-parse', 'HEAD');
  const cache = path.join(f.dir, 'cache');
  const source = 'https://github.com/example/fixture.git';
  const cached = path.join(cache, sha256(`${source}@${commit}`).slice(0, 24));
  fs.cpSync(f.toolkit, cached, { recursive: true }); git(cached, 'remote', 'add', 'origin', source);
  const lock = readLock(f.wt);
  lock.toolkit = { source: 'github:example/fixture', ref: 'v1.0.0', commit, status: 'release', sourceType: 'git' };
  write(f.wt, '.waffle/waffle.lock.json', JSON.stringify(lock));
  git(f.wt, 'add', '.waffle/waffle.lock.json'); git(f.wt, 'commit', '-m', 'pin toolkit');
  write(f.toolkit, 'stacks/demo/skills/hello/helper.mjs', 'a different main toolkit');
  const options = { cwd: f.wt, toolkitRoot: f.toolkit, offline: true, sourceCacheDir: cache };
  const result = prepareWorktree(options);
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(result.pin, 'github:example/fixture#v1.0.0');
  assert.equal(fs.readFileSync(path.join(f.wt, '.agents/skills/hello/helper.mjs'), 'utf8'), 'export const hello = 1;\n');
  fs.rmSync(cached, { recursive: true });
  assert.match(prepareWorktree(options).errors.join(), /offline cache miss/);
});

test('settings entries merge without changing unrelated settings or project workflows', (t) => {
  const f = fixture(t);
  write(f.toolkit, 'stacks/demo/mods/example/.claude-plugin/plugin.json', JSON.stringify({ name: 'example', version: '1.0.0', description: 'fixture' }));
  fs.appendFileSync(path.join(f.toolkit, 'stacks/demo/stack.yaml'), 'mods: [example]\n');
  write(f.toolkit, 'package.json', '{"name":"fixture","version":"1.0.0","repository":"https://github.com/example/fixture.git"}');
  const rendered = renderProject({ cwd: f.wt, toolkitRoot: f.toolkit, toolkitVersion: '1.0.0' });
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  git(f.wt, 'add', '.waffle/waffle.lock.json'); git(f.wt, 'commit', '-m', 'select mod');
  write(f.wt, '.claude/settings.json', '{"permissions":{"allow":["Read"]}}\n');
  write(f.wt, '.github/workflows/fixture.yml', 'user workflow edits');
  const result = f.run(); assert.equal(result.status, 'ready', JSON.stringify(result));
  const settings = JSON.parse(fs.readFileSync(path.join(f.wt, '.claude/settings.json')));
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.equal(settings.enabledPlugins['example@fixture'], true);
  assert.equal(fs.readFileSync(path.join(f.wt, '.github/workflows/fixture.yml'), 'utf8'), 'user workflow edits');
});

test('untrusted configuration rejects external sources without running checks', (t) => {
  const f = fixture(t);
  write(f.wt, '.waffle/waffle.yaml', 'stacks:\n  - name: demo\n    source: ../private-source\n');
  git(f.wt, 'add', '.waffle/waffle.yaml'); git(f.wt, 'commit', '-m', 'external source');
  const result = f.run({ untrustedConfig: true });
  assert.equal(result.status, 'failed'); assert.match(result.errors.join(), /external source or trust failure/);
});

test('relative external sources and extensions resolve from the destination', (t) => {
  const f = fixture(t);
  write(f.wt, 'vendor/extra/stack.yaml', 'name: extra\ndescription: Destination fixture\nskills: [local]\n');
  write(f.wt, 'vendor/extra/skills/local/SKILL.md', '---\nname: local\ndescription: Destination source\n---\nDestination bytes.\n');
  write(f.wt, '.waffle/extensions/skills/local.md', 'Destination extension.\n');
  write(f.wt, '.waffle/waffle.yaml', 'targets: [claude, codex]\nstacks:\n  - demo\n  - name: extra\n    source: ./vendor/extra\n');
  const rendered = renderProject({ cwd: f.wt, toolkitRoot: f.toolkit, toolkitVersion: '1.0.0' });
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  git(f.wt, 'add', 'vendor', '.waffle/waffle.yaml', '.waffle/waffle.lock.json', '.waffle/extensions'); git(f.wt, 'commit', '-m', 'destination source');
  fs.rmSync(path.join(f.wt, '.agents/skills/local'), { recursive: true });
  const result = f.run(); assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.match(fs.readFileSync(path.join(f.wt, '.agents/skills/local/SKILL.md'), 'utf8'), /Destination extension/);
  assert.equal(fs.existsSync(path.join(f.root, 'vendor')), false);
});

test('ignore gaps are reported without modifying ignore files; an interrupted mutex blocks readiness', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.wt, '.gitignore'), '');
  const result = f.run(); assert.equal(result.status, 'ready'); assert.ok(result.missingIgnore.includes('.agents/skills/hello/SKILL.md'));
  assert.equal(fs.readFileSync(path.join(f.wt, '.gitignore'), 'utf8'), '');
  const mutex = path.join(git(f.wt, 'rev-parse', '--absolute-git-dir'), 'wafflestack-prepare');
  fs.mkdirSync(mutex);
  assert.match(f.run().errors.join(), /active or interrupted/);
});

test('rollback preserves concurrent edits and leaves the recovery barrier', (t) => {
  const f = fixture(t); let first;
  const result = f.run({ beforeWrite: (rel) => {
    if (!first) first = rel;
    else { write(f.wt, first, 'concurrent user edit'); throw new Error('stop write'); }
  } });
  assert.equal(result.status, 'failed'); assert.match(result.errors.join(), /rollback incomplete/);
  assert.equal(fs.readFileSync(path.join(f.wt, first), 'utf8'), 'concurrent user edit');
  assert.match(f.run().errors.join(), /active or interrupted/);
});

test('ejected resources remain project-owned after a selection change', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 'ready');
  fs.appendFileSync(path.join(f.wt, '.waffle/waffle.yaml'), 'eject: [skills/hello]\n');
  assert.equal(renderProject({ cwd: f.wt, toolkitRoot: f.toolkit, toolkitVersion: '1.0.0' }).ok, true);
  write(f.wt, '.claude/skills/hello/SKILL.md', 'project-owned ejected content');
  git(f.wt, 'add', '.waffle/waffle.yaml', '.waffle/waffle.lock.json'); git(f.wt, 'commit', '-m', 'eject hello');
  const result = f.run(); assert.notEqual(result.status, 'failed', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(f.wt, '.claude/skills/hello/SKILL.md'), 'utf8'), 'project-owned ejected content');
});


test('per-run overlay choices override persisted policy without changing it', (t) => {
  const f = fixture(t);
  write(f.root, '.waffle/waffle.local.yaml', 'config:\n  greeting: MAIN_PRIVATE\n');
  git(f.root, 'config', '--local', 'wafflestack.worktreeOverlay', 'main');
  assert.equal(f.run({ overlay: 'local' }).overlayMode, 'canonical');
  write(f.wt, '.waffle/waffle.local.yaml', 'config:\n  greeting: DEST_PRIVATE\n');
  const canonical = f.run({ overlay: 'none', untrustedConfig: true });
  assert.equal(canonical.status, 'no-op', JSON.stringify(canonical));
  assert.equal(canonical.overlayMode, 'canonical');
  assert.doesNotMatch(fs.readFileSync(path.join(f.wt, '.claude/skills/hello/SKILL.md'), 'utf8'), /PRIVATE/);
  assert.equal(f.run({ overlay: 'local' }).overlayMode, 'destination-overlay');
  assert.equal(git(f.root, 'config', '--local', '--get', 'wafflestack.worktreeOverlay'), 'main');
  assert.equal(f.run({ overlay: 'main', untrustedConfig: true }).status, 'failed');
  // Disabling overlays does not silently discard a previous private render/local lock.
  const disabled = f.run({ overlay: 'none' });
  assert.equal(disabled.status, 'failed');
  assert.match(disabled.errors.join(), /stale local lock/);
  assert.match(fs.readFileSync(path.join(f.wt, '.claude/skills/hello/SKILL.md'), 'utf8'), /DEST_PRIVATE/);
});

test('none skips malformed private YAML; local reports a safe syntax diagnosis', (t) => {
  const f = fixture(t);
  write(f.wt, '.waffle/waffle.local.yaml', 'config: [PRIVATE_SECRET');
  assert.equal(f.run({ overlay: 'none' }).status, 'ready');
  const result = f.run({ overlay: 'local' });
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join(), /invalid configuration syntax/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
});

test('missing required configuration reports a repair category without raw values', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.toolkit, 'stacks/demo/stack.yaml'), '  missing.value:\n    required: true\n');
  write(f.toolkit, 'stacks/demo/skills/hello/SKILL.md', '---\nname: hello\ndescription: fixture\n---\n{{missing.value}}\n');
  const result = f.run();
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join(), /missing required configuration/);
  assert.equal(fs.existsSync(path.join(f.wt, '.agents/skills/hello/SKILL.md')), false);
});

test('main overlay flag preserves tracked-output and ignore safeguards', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 'ready');
  git(f.wt, 'add', '-f', '.claude/skills/hello/SKILL.md');
  git(f.wt, 'commit', '-m', 'track generated output');
  write(f.root, '.waffle/waffle.local.yaml', 'config:\n  greeting: PRIVATE_FLAG\n');
  const result = f.run({ overlay: 'main' });
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join(), /tracked or exposed/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FLAG/);
});


test('the delegate recipe runs the actual development CLI inside the destination', (t) => {
  const f = fixture(t);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  fs.cpSync(f.toolkit, f.wt, { recursive: true });
  fs.cpSync(path.join(repo, 'installer/lib'), path.join(f.wt, 'installer/lib'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'installer/cli.mjs'), path.join(f.wt, 'installer/cli.mjs'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(f.wt, 'node_modules'));
  const rendered = renderProject({ cwd: f.wt, toolkitRoot: f.wt, toolkitVersion: '1.0.0', toolkitIdentity: resolveToolkitIdentity({ toolkitRoot: f.wt, offline: true }) });
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  git(f.wt, 'add', '.waffle/waffle.lock.json', 'package.json', 'toolkit.yaml', 'stacks'); git(f.wt, 'commit', '-m', 'destination toolkit');
  fs.rmSync(path.join(f.wt, '.agents'), { recursive: true });
  const skill = fs.readFileSync(path.join(repo, 'stacks/orchestration/skills/delegate/SKILL.md'), 'utf8');
  const recipe = skill.split('\n').find(line => line.startsWith('(cd "$WORKTREE_PATH" &&'));
  assert.ok(recipe);
  const command = recipe.replace('{{autopilot.waffleCmd}}', 'env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs');
  const run = (extra = '') => spawnSync('sh', ['-c', command.replace(' --json)', ` --json ${extra})`)], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, WORKTREE_PATH: f.wt, WAFFLESTACK_OFFLINE: '1' },
  });
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'ready');
  assert.ok(fs.existsSync(path.join(f.wt, '.agents/skills/hello/helper.mjs')));
  const second = run('--overlay none');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'no-op');
  for (const flag of ['--overlay', '--overlay invalid', '--overlay local --overlay main', '--overlay ,']) {
    const invalid = run(flag);
    assert.equal(invalid.status, 1, flag);
    assert.match(invalid.stderr, /--overlay requires/);
  }
});
