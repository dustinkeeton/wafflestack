import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { resolveSource } from '../lib/sources.mjs';
import { VERSION, write, read, git, porcelain, makeMain, addWorktree } from './prepare-fixture.mjs';
import { doctor } from '../lib/doctor.mjs';
import { prepareWorktree, resolvePinnedToolkit, checkoutInfo, resolveOverlayPolicy, isHarnessPath, expectedHarnessPaths, formatPrepareResult, PREPARE_LOCK, PREPARED_MANIFEST, PREPARE_WORKTREE_SINCE } from '../lib/worktree.mjs';
import { parseVersion, compareVersions } from '../lib/util.mjs';

// #820: provision a checkout's harness resources from its own lock before a session starts there.

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const HELPER = '.claude/agents/helper.md';
const SKILL = '.claude/skills/greet/SKILL.md';
const SKILL_SCRIPT = '.claude/skills/greet/scripts/hello.sh';
const CODEX_AGENT = '.codex/agents/helper.toml';
const AGENTS_SKILL = '.agents/skills/greet/SKILL.md';
const WORKFLOW = '.github/workflows/demo.yml';

const prepare = (cwd, toolkitRoot, extra = {}) => prepareWorktree({ cwd, toolkitRoot, toolkitVersion: VERSION, ...extra });

describe('checkoutInfo', () => {
  let main;
  let toolkitRoot;
  beforeEach(() => ({ main, toolkitRoot } = makeMain()));
  afterEach(() => fs.rmSync(main, { recursive: true, force: true }));

  test('resolves a linked worktree back to its main checkout, external and nested alike', () => {
    for (const nested of [false, true]) {
      const wt = addWorktree(main, { nested, name: nested ? 'nested one' : 'ext one' });
      const info = checkoutInfo(wt);
      assert.equal(info.linked, true);
      assert.equal(info.mainCheckout, main);
      assert.equal(info.toplevel, wt);
    }
    const info = checkoutInfo(main);
    assert.equal(info.linked, false);
    assert.equal(info.mainCheckout, main);
  });

  test('a directory outside git is an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-nogit-'));
    assert.match(checkoutInfo(dir).error, /not inside a git work tree/);
    assert.equal(prepare(dir, toolkitRoot).status, 'failed');
  });
});

describe('resolveOverlayPolicy', () => {
  test('flag, then the main overlay, then the destination overlay, then config, then local', () => {
    assert.deepEqual(resolveOverlayPolicy({}), { mode: 'local', source: 'default' });
    assert.deepEqual(resolveOverlayPolicy({ projectRaw: { worktrees: { overlay: 'none' } } }), { mode: 'none', source: 'config' });
    assert.deepEqual(resolveOverlayPolicy({ projectRaw: { worktrees: { overlay: 'none' } }, destOverlayRaw: { worktrees: { overlay: 'local' } } }), { mode: 'local', source: 'config' });
    assert.match(resolveOverlayPolicy({ projectRaw: { worktrees: { overlay: 'main' } } }).error, /accepted only from the main checkout's own/);
    assert.match(resolveOverlayPolicy({ destOverlayRaw: { worktrees: { overlay: 'main' } } }).error, /accepted only from/);
    assert.deepEqual(resolveOverlayPolicy({ mainOverlayRaw: { worktrees: { overlay: 'main' } }, projectRaw: { worktrees: { overlay: 'none' } } }), { mode: 'main', source: 'main-overlay' });
    assert.deepEqual(resolveOverlayPolicy({ flag: 'none', mainOverlayRaw: { worktrees: { overlay: 'main' } } }), { mode: 'none', source: 'flag' });
    assert.match(resolveOverlayPolicy({ flag: 'all' }).error, /--overlay must be one of local, main, none/);
    assert.match(resolveOverlayPolicy({ projectRaw: { worktrees: { overlay: true } } }).error, /worktrees\.overlay/);
  });
});

describe('isHarnessPath', () => {
  test('follows the enabled targets; settings keys are judged by their file', () => {
    assert.equal(isHarnessPath(HELPER, ['claude']), true);
    assert.equal(isHarnessPath(HELPER, ['codex']), false);
    assert.equal(isHarnessPath(CODEX_AGENT, ['codex']), true);
    assert.equal(isHarnessPath(AGENTS_SKILL, ['codex']), true);
    assert.equal(isHarnessPath(AGENTS_SKILL, ['agents-dir']), true);
    assert.equal(isHarnessPath(WORKFLOW, ['claude', 'codex', 'agents-dir']), false);
    assert.equal(isHarnessPath('.waffle/CHEATSHEET.md', ['claude']), false);
    assert.equal(isHarnessPath('.claude/settings.json#/enabledPlugins/x@y', ['claude']), true);
  });
});

describe('prepareWorktree: a fresh worktree', () => {
  let main;
  let toolkitRoot;
  beforeEach(() => ({ main, toolkitRoot } = makeMain()));
  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  test('absent directories: every harness resource for the enabled targets lands, nothing else does', () => {
    const wt = addWorktree(main);
    const before = porcelain(wt);
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.deepEqual(r.generated, [AGENTS_SKILL, '.agents/skills/greet/scripts/hello.sh', HELPER, SKILL, SKILL_SCRIPT, CODEX_AGENT].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(r.targets, ['claude', 'codex']);
    assert.equal(r.overlay.effective, 'canonical');
    assert.equal(read(wt, HELPER), read(main, HELPER));
    assert.equal(read(wt, SKILL_SCRIPT), read(main, SKILL_SCRIPT));
    assert.ok(!r.generated.includes('.waffle/CHEATSHEET.md') && !r.generated.includes(WORKFLOW), 'generated docs and .github/ payloads are not harness resources');
    assert.equal(read(wt, '.waffle/waffle.lock.json'), read(main, '.waffle/waffle.lock.json'), 'the committed lock is untouched');
    assert.equal(porcelain(wt), before, 'the render is gitignored, so the index and status are unchanged');
    assert.equal(fs.existsSync(path.join(wt, '.waffle/waffle.local.lock.json')), false);
    const d = doctor({ cwd: wt, toolkitVersion: VERSION, allowMissing: true });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.deepEqual(expectedHarnessPaths(JSON.parse(read(wt, '.waffle/waffle.lock.json')), ['claude', 'codex']), r.generated);
  });

  test('a second preparation is a no-op with no content or index drift', () => {
    const wt = addWorktree(main, { nested: true });
    assert.equal(prepare(wt, toolkitRoot).status, 'ready');
    const snapshot = Object.fromEntries([HELPER, SKILL, SKILL_SCRIPT, CODEX_AGENT, AGENTS_SKILL].map((p) => [p, read(wt, p)]));
    const status = porcelain(wt);
    const again = prepare(wt, toolkitRoot);
    assert.equal(again.status, 'no-op', JSON.stringify(again.errors));
    assert.deepEqual(again.generated, []);
    assert.equal(again.present, 6);
    for (const [p, c] of Object.entries(snapshot)) assert.equal(read(wt, p), c);
    assert.equal(porcelain(wt), status);
  });

  test('an empty or partial harness directory is completed per file, helpers included', () => {
    const wt = addWorktree(main);
    fs.mkdirSync(path.join(wt, '.claude/skills'), { recursive: true });
    fs.mkdirSync(path.join(wt, '.claude/agents'), { recursive: true });
    const first = prepare(wt, toolkitRoot);
    assert.equal(first.status, 'ready');
    assert.ok(first.generated.includes(SKILL) && first.generated.includes(HELPER));
    fs.rmSync(path.join(wt, SKILL_SCRIPT));
    fs.rmSync(path.join(wt, CODEX_AGENT));
    const partial = prepare(wt, toolkitRoot);
    assert.equal(partial.status, 'ready');
    assert.deepEqual(partial.generated, [SKILL_SCRIPT, CODEX_AGENT].sort((a, b) => a.localeCompare(b)));
    assert.equal(partial.present, 4);
  });

  test('committed custom skills and agents stay, and the generated ones join them', () => {
    const custom = '.claude/skills/custom/SKILL.md';
    write(main, '.gitignore', '.claude/skills/*\n!.claude/skills/custom/\n.claude/agents/\n.codex/\n.agents/\n.waffle/waffle.local.yaml\n.waffle/waffle.local.lock.json\n');
    write(main, custom, '---\nname: custom\ndescription: Ours.\n---\n\nProject-owned.\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'custom skill');
    const wt = addWorktree(main);
    assert.equal(read(wt, custom), read(main, custom));
    const before = porcelain(wt);
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.equal(read(wt, custom), read(main, custom), 'the custom skill is untouched');
    assert.ok(fs.existsSync(path.join(wt, SKILL)));
    assert.equal(porcelain(wt), before);
    assert.deepEqual(r.ignore.uncovered, []);
  });

  test('a fully rendered checkout (the main checkout itself) is a no-op', () => {
    const r = prepare(main, toolkitRoot);
    assert.equal(r.status, 'no-op', JSON.stringify(r.errors));
    assert.equal(r.checkout.linked, false);
  });

  test('a fresh clone with no render is provisioned the same way', () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-clone-'));
    git(clone, 'clone', '-q', main, 'repo');
    const dir = fs.realpathSync(path.join(clone, 'repo'));
    assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
    const r = prepare(dir, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.equal(r.checkout.linked, false);
    assert.ok(fs.existsSync(path.join(dir, SKILL)));
  });

  test('targets decide which output dirs are provisioned', () => {
    fs.rmSync(main, { recursive: true, force: true });
    ({ main, toolkitRoot } = makeMain({ targets: 'agents-dir' }));
    const wt = addWorktree(main);
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.deepEqual(r.generated, ['.agents/agents/helper.md', AGENTS_SKILL, '.agents/skills/greet/scripts/hello.sh'].sort((a, b) => a.localeCompare(b)));
    assert.equal(fs.existsSync(path.join(wt, '.claude')), false);
  });
});

describe('prepareWorktree: refusals', () => {
  let main;
  let toolkitRoot;
  beforeEach(() => ({ main, toolkitRoot } = makeMain()));
  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  test('a hand-edited managed file is a conflict: nothing is written, every missing file stays missing', () => {
    const wt = addWorktree(main);
    write(wt, HELPER, 'edited by hand\n');
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.conflicts.map((c) => c.path), [HELPER]);
    assert.match(r.conflicts[0].reason, /managed file with local edits/);
    assert.match(r.errors[0], /1 conflict\(s\) — nothing was written/);
    assert.equal(read(wt, HELPER), 'edited by hand\n');
    assert.equal(fs.existsSync(path.join(wt, SKILL)), false);
    assert.deepEqual(r.generated, []);
  });

  test('an unmanaged file at a rendered path is a conflict that names the path', () => {
    const wt = addWorktree(main);
    write(wt, '.agents/skills/greet/scripts/hello.sh', 'mine\n');
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.conflicts.map((c) => c.path), ['.agents/skills/greet/scripts/hello.sh']);
    assert.match(r.conflicts[0].reason, /managed file with local edits/);
    const text = formatPrepareResult(r);
    assert.match(text, /^prepare-worktree: failed/);
    assert.match(text, /hello\.sh: a managed file/);
  });

  test('a render this command wrote for an older pin is refreshed, not refused; a render nobody recorded is', () => {
    const wt = addWorktree(main);
    assert.equal(prepare(wt, toolkitRoot).status, 'ready');
    const manifest = path.resolve(wt, git(wt, 'rev-parse', '--git-path', PREPARED_MANIFEST).stdout.trim());
    assert.ok(fs.existsSync(manifest), 'the written hashes are recorded in the git dir, never in the tree');
    // Rewrite config + lock in main (a new pin's content), bring the worktree's branch up to date.
    write(main, '.waffle/waffle.yaml', 'targets: [claude, codex]\nstacks: [demo]\nconfig:\n  git:\n    botEmail: new@example.com\n');
    assert.equal(renderProject({ toolkitRoot, cwd: main, toolkitVersion: VERSION }).ok, true);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'new email');
    git(wt, 'merge', '-q', 'main');
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.ok(r.refreshed.includes(HELPER), JSON.stringify(r.refreshed));
    assert.match(read(wt, HELPER), /new@example\.com/);
    fs.rmSync(manifest);
    write(wt, HELPER, read(main, HELPER).replace('new@', 'bot@'));
    const unknown = prepare(wt, toolkitRoot);
    assert.equal(unknown.status, 'failed', 'without the record, an older render reads as a local edit');
    assert.deepEqual(unknown.conflicts.map((c) => c.path), [HELPER]);
  });

  test('a symlink that leaves the checkout is refused', () => {
    const wt = addWorktree(main);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-outside-'));
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.symlinkSync(outside, path.join(wt, '.claude/skills'));
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'failed');
    assert.ok(r.conflicts.some((c) => c.path === SKILL && /symlink/.test(c.reason)), JSON.stringify(r.conflicts));
    assert.equal(fs.readdirSync(outside).length, 0, 'nothing was written through the link');
  });

  test('a symlinked local lock that leaves the checkout is refused before any write', () => {
    const wt = addWorktree(main);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-outside-'));
    fs.symlinkSync(path.join(outside, 'local.lock.json'), path.join(wt, '.waffle/waffle.local.lock.json'));
    write(main, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: private@example.com\n');
    const r = prepare(wt, toolkitRoot, { overlay: 'main' });
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.conflicts.map((c) => c.path), ['.waffle/waffle.local.lock.json']);
    assert.match(r.conflicts[0].reason, /symlink/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through either link');
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
  });

  test('a missing lock, a missing config, and a stale lock each fail with a repair instruction', () => {
    const wt = addWorktree(main);
    fs.rmSync(path.join(wt, '.waffle/waffle.lock.json'));
    assert.match(prepare(wt, toolkitRoot).errors[0], /waffle\.lock\.json not found.*run `wafflestack render` in the main checkout/);
    git(wt, 'checkout', '-q', '--', '.waffle/waffle.lock.json');
    write(wt, '.waffle/waffle.yaml', 'targets: [claude, codex]\nstacks: [demo]\nconfig:\n  git:\n    botEmail: other@example.com\n');
    const stale = prepare(wt, toolkitRoot);
    assert.equal(stale.status, 'failed');
    assert.match(stale.errors[0], /does not match what \.waffle\/waffle\.yaml .* renders/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
    fs.rmSync(path.join(wt, '.waffle/waffle.yaml'));
    assert.match(prepare(wt, toolkitRoot).errors[0], /waffle\.yaml not found/);
  });

  test('a lock from another toolkit version is never provisioned by this CLI', () => {
    const wt = addWorktree(main);
    const lockFile = path.join(wt, '.waffle/waffle.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, toolkitVersion: '0.0.older', toolkit: { source: 'github:o/r', sourceType: 'git', ref: 'v0.0.older', commit: 'a'.repeat(40), status: 'release' } }, null, 2));
    const pinned = prepare(wt, toolkitRoot, { offline: true });
    assert.equal(pinned.status, 'failed');
    assert.match(pinned.errors[0], /rendered by 0\.0\.older/);
    assert.match(pinned.errors[0], new RegExp(`npx --yes github:o/r#v0\\.0\\.older prepare-worktree --cwd "${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.deepEqual(pinned.pin, { version: '0.0.older', ref: 'github:o/r#v0.0.older', status: 'release', from: null });
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, toolkitVersion: '0.0.older', toolkit: { ...lock.toolkit, status: 'unreleased', ref: null, commit: null } }, null, 2));
    const unpinned = prepare(wt, toolkitRoot);
    assert.match(unpinned.errors[0], /records no release pin.*wafflestack upgrade/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
  });

  test('a concurrent preparation is refused while its holder is alive, and taken over when it is not', () => {
    const wt = addWorktree(main);
    const lockFile = path.resolve(wt, git(wt, 'rev-parse', '--git-path', PREPARE_LOCK).stdout.trim());
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: 'now' }));
    const busy = prepare(wt, toolkitRoot);
    assert.equal(busy.status, 'failed');
    assert.match(busy.errors[0], /another preparation is running/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'long ago' }));
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.equal(fs.existsSync(lockFile), false, 'the lock is released');
  });

  test('a tracked rendered path that the overlay would change is refused; the committed render stays', () => {
    fs.rmSync(main, { recursive: true, force: true });
    ({ main, toolkitRoot } = makeMain({ ignore: '' }));
    write(main, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: private@example.com\n');
    const wt = addWorktree(main);
    assert.equal(read(wt, HELPER), read(main, HELPER), 'Posture 1: the render is committed');
    const canonical = prepare(wt, toolkitRoot);
    assert.equal(canonical.status, 'no-op', JSON.stringify(canonical.errors));
    assert.ok(canonical.notes.some((n) => /main checkout .* has a private .waffle\/waffle\.local\.yaml/.test(n)));
    const r = prepare(wt, toolkitRoot, { overlay: 'main' });
    assert.equal(r.status, 'failed');
    assert.ok(r.conflicts.every((c) => /tracked by git, and the private overlay/.test(c.reason)), JSON.stringify(r.conflicts));
    assert.ok(r.conflicts.some((c) => c.path === HELPER));
    assert.doesNotMatch(read(wt, HELPER), /private@example\.com/);
    assert.doesNotMatch(JSON.stringify(r), /private@example\.com/, 'no overlay value in the result');
  });
});

describe('prepareWorktree: settings entries, rollback and the pin (review findings on #822)', () => {
  const PLUGIN_KEY = '.claude/settings.json#/enabledPlugins/example@fixture';
  const SETTINGS = '.claude/settings.json';
  let main;
  let toolkitRoot;
  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  test('a lock-managed settings entry with a local edit is a conflict, not restored; a recorded value is refreshed', () => {
    ({ main, toolkitRoot } = makeMain({ mod: true, ignore: '.claude/skills/\n.claude/agents/\n.codex/\n.agents/\n' }));
    const wt = addWorktree(main);
    assert.ok(JSON.parse(read(wt, SETTINGS)).enabledPlugins['example@fixture'], 'Posture 1 for settings: committed with the entry');
    const first = prepare(wt, toolkitRoot);
    assert.equal(first.status, 'ready', JSON.stringify(first.errors));
    const settings = JSON.parse(read(wt, SETTINGS));
    settings.enabledPlugins['example@fixture'] = false;
    settings.permissions = { allow: ['Read'] };
    write(wt, SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
    const edited = prepare(wt, toolkitRoot);
    assert.equal(edited.status, 'failed');
    assert.deepEqual(edited.conflicts.map((c) => c.path), [PLUGIN_KEY]);
    assert.match(edited.conflicts[0].reason, /lock-managed settings entry with local edits/);
    assert.equal(JSON.parse(read(wt, SETTINGS)).enabledPlugins['example@fixture'], false, 'the edit stands');
    settings.enabledPlugins['example@fixture'] = true;
    write(wt, SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
    const back = prepare(wt, toolkitRoot);
    assert.equal(back.status, 'no-op', JSON.stringify(back.errors));
    assert.deepEqual(JSON.parse(read(wt, SETTINGS)).permissions, { allow: ['Read'] }, 'unrelated settings untouched');
  });

  test('an overlay-derived settings change never lands in a tracked settings file', () => {
    ({ main, toolkitRoot } = makeMain({ mod: true, ignore: '.claude/skills/\n.claude/agents/\n.codex/\n.agents/\n' }));
    write(main, '.waffle/waffle.local.yaml', 'config:\n  waffle:\n    toolkitRef: github:example/fixture#v2.0.0\n');
    const wt = addWorktree(main);
    const before = read(wt, SETTINGS);
    const r = prepare(wt, toolkitRoot, { overlay: 'main' });
    assert.equal(r.status, 'failed');
    assert.ok(r.conflicts.some((c) => c.path.startsWith('.claude/settings.json#') && /tracked by git, and the private overlay/.test(c.reason)), JSON.stringify(r.conflicts));
    assert.equal(read(wt, SETTINGS), before);
    assert.doesNotMatch(JSON.stringify(r), /v2\.0\.0/, 'no overlay value in the result');
  });

  test('--untrusted-config refuses overlay policy main before anything is staged', () => {
    ({ main, toolkitRoot } = makeMain());
    write(main, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: private@example.com\n');
    const wt = addWorktree(main);
    const r = prepare(wt, toolkitRoot, { overlay: 'main', untrustedConfig: true });
    assert.equal(r.status, 'failed');
    assert.match(r.errors[0], /--untrusted-config refuses overlay policy `main`/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
    assert.equal(prepare(wt, toolkitRoot, { overlay: 'none', untrustedConfig: true }).status, 'ready');
  });

  test('a write that fails part-way restores every path the run touched', () => {
    ({ main, toolkitRoot } = makeMain());
    const wt = addWorktree(main);
    fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.claude/agents'), 'a file where a directory must go\n');
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'failed');
    assert.match(r.errors[0], /writing failed .* were restored as found/);
    assert.deepEqual(r.generated, []);
    assert.equal(fs.existsSync(path.join(wt, AGENTS_SKILL)), false, 'the earlier .agents/ writes are rolled back');
    assert.equal(read(wt, '.claude/agents'), 'a file where a directory must go\n');
    fs.rmSync(path.join(wt, '.claude/agents'));
    assert.equal(prepare(wt, toolkitRoot).status, 'ready');
  });

  test('a release CLI at the same version but another tag or commit never provisions the lock', () => {
    ({ main, toolkitRoot } = makeMain());
    const wt = addWorktree(main);
    const lockFile = path.join(wt, '.waffle/waffle.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const commit = 'a'.repeat(40);
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, toolkit: { source: 'github:example/fixture', sourceType: 'git', ref: 'v0.0.test', commit, status: 'release' } }, null, 2));
    const identity = (tag, sha) => ({ status: 'release', version: VERSION, tag, commit: sha, ref: `github:example/fixture#${tag}`, origin: 'npm-install', repo: 'example/fixture', lockRepo: 'example/fixture', latestTag: tag, lookupError: null });
    const other = prepare(wt, toolkitRoot, { toolkitIdentity: identity('v0.0.test', 'b'.repeat(40)), offline: true });
    assert.equal(other.status, 'failed');
    assert.match(other.errors[0], /offline, and the pinned release is not in the source cache/);
    assert.match(other.errors[0], /npx --yes github:example\/fixture#v0\.0\.test prepare-worktree/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
    const same = prepare(wt, toolkitRoot, { toolkitIdentity: identity('v0.0.test', commit) });
    assert.equal(same.status, 'ready', JSON.stringify(same.errors));
  });
});

describe('prepareWorktree: the lock pin picks the toolkit (ported from #821)', () => {
  let main;
  let toolkitRoot;
  let repo;
  let cache;
  let other;
  afterEach(() => {
    for (const d of [main, toolkitRoot, repo, cache, other]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });
  /** The fixture toolkit as a tagged git repo standing in for github.com/example/fixture. */
  function pinToRepo(wt, { commit }) {
    const lockFile = path.join(wt, '.waffle/waffle.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    fs.writeFileSync(lockFile, `${JSON.stringify({ ...lock, toolkit: { source: 'github:example/fixture', sourceType: 'git', ref: 'v0.0.test', commit, status: 'release' } }, null, 2)}\n`);
  }
  const viaRepo = (ext, opts) => resolveSource({ ...ext, source: repo }, opts);

  beforeEach(() => {
    ({ main, toolkitRoot } = makeMain());
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-repo-'));
    fs.cpSync(toolkitRoot, repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'v0.0.test');
    git(repo, 'tag', 'v0.0.test');
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cache-'));
    // The running CLI: another version, with different content, so a render from it would not match the lock.
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-other-'));
    fs.cpSync(toolkitRoot, other, { recursive: true });
    write(other, 'package.json', '{"name":"fixture","version":"0.0.newer"}');
    write(other, 'stacks/demo/agents/helper.md', '---\nname: helper\ndescription: A newer helper.\n---\n\nNewer.\n');
  });

  test('a newer CLI fetches the pinned release once, then serves it from the cache, offline too', () => {
    const wt = addWorktree(main);
    pinToRepo(wt, { commit: git(repo, 'rev-parse', 'HEAD').stdout.trim() });
    const run = (extra = {}) => prepareWorktree({ cwd: wt, toolkitRoot: other, toolkitVersion: '0.0.newer', sourceCacheDir: cache, resolve: viaRepo, ...extra });
    const first = run();
    assert.equal(first.status, 'ready', JSON.stringify(first.errors));
    assert.equal(first.pin.from, 'fetch');
    assert.match(read(wt, HELPER), /A helper\./, 'rendered by the pinned toolkit, not the newer running one');
    assert.ok(first.notes.some((n) => /pinned release github:example\/fixture#v0\.0\.test, fetched into the source cache/.test(n)));
    const again = run({ offline: true });
    assert.equal(again.status, 'no-op', JSON.stringify(again.errors));
    assert.equal(again.pin.from, 'cache');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(path.join(wt, HELPER));
    const miss = run({ offline: true });
    assert.equal(miss.status, 'failed');
    assert.match(miss.errors[0], /offline, and the pinned release is not in the source cache/);
    assert.match(miss.errors[0], /go online once .* or run the pinned toolkit yourself:\n {2}npx --yes github:example\/fixture#v0\.0\.test prepare-worktree/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
  });

  test('a moved tag or an inconsistent version at the tag is refused, not rendered', () => {
    const wt = addWorktree(main);
    pinToRepo(wt, { commit: 'c'.repeat(40) });
    const moved = prepareWorktree({ cwd: wt, toolkitRoot: other, toolkitVersion: '0.0.newer', sourceCacheDir: cache, resolve: viaRepo });
    assert.equal(moved.status, 'failed');
    assert.match(moved.errors[0], /the tag moved/);
    write(repo, 'package.json', '{"name":"fixture","version":"0.0.wrong"}');
    git(repo, 'commit', '-q', '-am', 'wrong version');
    git(repo, 'tag', '-f', 'v0.0.test');
    pinToRepo(wt, { commit: git(repo, 'rev-parse', 'HEAD').stdout.trim() });
    fs.rmSync(cache, { recursive: true, force: true });
    const wrong = prepareWorktree({ cwd: wt, toolkitRoot: other, toolkitVersion: '0.0.newer', sourceCacheDir: cache, resolve: viaRepo });
    assert.equal(wrong.status, 'failed');
    assert.match(wrong.errors[0], /the toolkit at that tag is version 0\.0\.wrong/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
  });

  test('resolvePinnedToolkit: the running CLI wins only at the pinned tag and commit', () => {
    const lock = { toolkitVersion: '0.0.test', toolkit: { source: 'github:example/fixture', ref: 'v0.0.test', commit: 'a'.repeat(40), status: 'release' } };
    const identity = (tag, commit) => ({ status: 'release', version: '0.0.test', tag, commit });
    assert.equal(resolvePinnedToolkit({ lock, cwd: '/x', toolkitRoot: '/tk', toolkitVersion: '0.0.test', toolkitIdentity: identity('v0.0.test', 'a'.repeat(40)) }).from, 'running');
    assert.equal(resolvePinnedToolkit({ lock, cwd: '/x', toolkitRoot: '/tk', toolkitVersion: '0.0.test', toolkitIdentity: { status: 'unreleased', version: '0.0.test' } }).from, 'running');
    const r = resolvePinnedToolkit({ lock, cwd: '/x', toolkitRoot: '/tk', toolkitVersion: '0.0.test', toolkitIdentity: identity('v0.0.test', 'b'.repeat(40)), offline: true });
    assert.match(r.error, /offline, and the pinned release is not in the source cache/);
    assert.equal(resolvePinnedToolkit({ lock: { toolkitVersion: '0.0.test' }, cwd: '/x', toolkitRoot: '/tk', toolkitVersion: '0.0.other' }).error.includes('records no release pin'), true);
  });
});

describe('prepareWorktree: a changed selection prunes what an earlier run wrote; ejected and sourced items', () => {
  let main;
  let toolkitRoot;
  beforeEach(() => ({ main, toolkitRoot } = makeMain()));
  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  test('dropping a target removes the files this command wrote for it, and leaves an edited one as a conflict', () => {
    const wt = addWorktree(main);
    assert.equal(prepare(wt, toolkitRoot).status, 'ready');
    write(main, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [demo]\nconfig:\n  git:\n    botEmail: bot@example.com\n');
    assert.equal(renderProject({ toolkitRoot, cwd: main, toolkitVersion: VERSION }).ok, true);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'claude only');
    git(wt, 'merge', '-q', 'main');
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.deepEqual(r.pruned, [AGENTS_SKILL, '.agents/skills/greet/scripts/hello.sh', CODEX_AGENT].sort((a, b) => a.localeCompare(b)));
    assert.equal(fs.existsSync(path.join(wt, '.agents')), false, 'emptied directories go too');
    assert.equal(fs.existsSync(path.join(wt, '.codex')), false);
    assert.ok(fs.existsSync(path.join(wt, HELPER)));
    assert.equal(prepare(wt, toolkitRoot).status, 'no-op');
    // The other way round, with an edit in the way: nothing is pruned, the edit is named.
    write(main, '.waffle/waffle.yaml', 'targets: [codex]\nstacks: [demo]\nconfig:\n  git:\n    botEmail: bot@example.com\n');
    assert.equal(renderProject({ toolkitRoot, cwd: main, toolkitVersion: VERSION }).ok, true);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'codex only');
    git(wt, 'merge', '-q', 'main');
    write(wt, HELPER, 'edited after preparation\n');
    const edited = prepare(wt, toolkitRoot);
    assert.equal(edited.status, 'failed');
    assert.deepEqual(edited.conflicts.map((c) => c.path), [HELPER]);
    assert.match(edited.conflicts[0].reason, /written by an earlier preparation, no longer rendered/);
    assert.equal(fs.existsSync(path.join(wt, AGENTS_SKILL)), false, 'nothing was written');
  });

  test('an ejected item stays project-owned through a preparation', () => {
    const wt = addWorktree(main);
    assert.equal(prepare(wt, toolkitRoot).status, 'ready');
    fs.appendFileSync(path.join(main, '.waffle/waffle.yaml'), 'eject: [skills/greet]\n');
    assert.equal(renderProject({ toolkitRoot, cwd: main, toolkitVersion: VERSION }).ok, true);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'eject greet');
    git(wt, 'merge', '-q', 'main');
    write(wt, SKILL, 'project-owned now\n');
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'failed', 'the ejected copy this command once wrote was edited: it must not be pruned or overwritten');
    assert.deepEqual(r.conflicts.map((c) => c.path), [SKILL]);
    assert.equal(read(wt, SKILL), 'project-owned now\n');
  });

  test('a relative external source and an extension resolve against the destination checkout', () => {
    write(main, 'vendor/extra/stack.yaml', 'name: extra\ndescription: Destination fixture.\nskills: [local]\n');
    write(main, 'vendor/extra/skills/local/SKILL.md', '---\nname: local\ndescription: Destination source.\n---\n\nDestination bytes.\n');
    write(main, '.waffle/extensions/skills/local.md', 'Destination extension.\n');
    write(main, '.waffle/waffle.yaml', 'targets: [claude, codex]\nstacks:\n  - demo\n  - name: extra\n    source: ./vendor/extra\nconfig:\n  git:\n    botEmail: bot@example.com\n');
    assert.equal(renderProject({ toolkitRoot, cwd: main, toolkitVersion: VERSION }).ok, true);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'local source');
    const wt = addWorktree(main);
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.match(read(wt, '.claude/skills/local/SKILL.md'), /Destination bytes[\s\S]*Destination extension/);
    assert.equal(fs.existsSync(path.join(wt, 'vendor/extra/stack.yaml')), true, 'the source the worktree rendered from is its own copy');
  });
});

describe('t3.json dogfood', () => {
  test('this repo prepares its own T3 worktrees synchronously with the worktree installer', () => {
    const t3 = JSON.parse(fs.readFileSync(new URL('../../t3.json', import.meta.url), 'utf8'));
    const script = t3.scripts.find((s) => /prepare-worktree/.test(s.command));
    assert.ok(script, JSON.stringify(t3));
    assert.equal(script.runOnWorktreeCreate, true);
    assert.equal(script.async, false);
    assert.match(script.command, /npm ci --ignore-scripts && env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer\/cli\.mjs prepare-worktree --cwd "\$PWD"$/);
  });
});

describe('prepareWorktree: overlay policy', () => {
  let main;
  let toolkitRoot;
  beforeEach(() => {
    ({ main, toolkitRoot } = makeMain());
    write(main, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: private@example.com\n');
  });
  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  test('default policy renders the committed inputs and names the omitted main overlay without printing values', () => {
    const wt = addWorktree(main);
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.equal(r.overlay.mode, 'local');
    assert.equal(r.overlay.effective, 'canonical');
    assert.match(read(wt, HELPER), /bot@example\.com/);
    const note = r.notes.find((n) => /leaves it out/.test(n));
    assert.ok(note, JSON.stringify(r.notes));
    assert.match(note, /--overlay main/);
    assert.doesNotMatch(JSON.stringify(r), /private@example\.com/);
    assert.doesNotMatch(formatPrepareResult(r), /private@example\.com/);
    assert.equal(fs.existsSync(path.join(wt, '.waffle/waffle.local.lock.json')), false);
  });

  test('--overlay main renders with the main checkout overlay and writes only the gitignored local lock', () => {
    const wt = addWorktree(main);
    const before = porcelain(wt);
    const r = prepare(wt, toolkitRoot, { overlay: 'main' });
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.equal(r.overlay.effective, 'overlay');
    assert.equal(r.overlay.file, path.join(main, '.waffle/waffle.local.yaml'));
    assert.match(read(wt, HELPER), /private@example\.com/);
    assert.equal(read(wt, '.waffle/waffle.lock.json'), read(main, '.waffle/waffle.lock.json'), 'the committed lock is untouched');
    const local = JSON.parse(read(wt, '.waffle/waffle.local.lock.json'));
    assert.notEqual(local.files[HELPER], JSON.parse(read(wt, '.waffle/waffle.lock.json')).files[HELPER]);
    assert.equal(porcelain(wt), before, 'nothing untracked or staged');
    assert.equal(doctor({ cwd: wt, toolkitVersion: VERSION, allowMissing: true }).ok, true);
    assert.equal(prepare(wt, toolkitRoot, { overlay: 'main' }).status, 'no-op');
    // Back to canonical: the overlay-fed files are refreshed and the local lock removed.
    const back = prepare(wt, toolkitRoot, { overlay: 'none' });
    assert.equal(back.status, 'ready');
    assert.ok(back.refreshed.includes(HELPER));
    assert.equal(fs.existsSync(path.join(wt, '.waffle/waffle.local.lock.json')), false);
    assert.match(read(wt, HELPER), /bot@example\.com/);
  });

  test('the opt-in persists in the main overlay; the destination overlay wins over main when present', () => {
    fs.appendFileSync(path.join(main, '.waffle/waffle.local.yaml'), 'worktrees:\n  overlay: main\n');
    const wt = addWorktree(main);
    const r = prepare(wt, toolkitRoot);
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.deepEqual([r.overlay.mode, r.overlay.source, r.overlay.effective], ['main', 'main-overlay', 'overlay']);
    write(wt, '.waffle/waffle.local.yaml', 'config:\n  git:\n    botEmail: mine@example.com\n');
    const own = prepare(wt, toolkitRoot);
    assert.equal(own.status, 'ready');
    assert.equal(own.overlay.file, path.join(wt, '.waffle/waffle.local.yaml'));
    assert.match(read(wt, HELPER), /mine@example\.com/);
  });

  test('the main checkout itself under --overlay main uses its own overlay', () => {
    const r = prepare(main, toolkitRoot, { overlay: 'main' });
    assert.equal(r.status, 'ready', JSON.stringify(r.errors));
    assert.equal(r.overlay.file, path.join(main, '.waffle/waffle.local.yaml'));
    assert.match(read(main, HELPER), /private@example\.com/);
  });
});

describe('prepareWorktree: ignore coverage', () => {
  test('generated paths that git would show as untracked are reported, and .gitignore is never edited', () => {
    const { main, toolkitRoot } = makeMain();
    try {
      const wt = addWorktree(main);
      // The branch stops ignoring .codex/ and .agents/, so their render would show as untracked there.
      write(wt, '.gitignore', '.claude/\n.waffle/waffle.local.yaml\n.waffle/waffle.local.lock.json\n');
      git(wt, 'commit', '-q', '-am', 'narrower ignore');
      const gi = read(wt, '.gitignore');
      const r = prepare(wt, toolkitRoot);
      assert.equal(r.status, 'ready', JSON.stringify(r.errors));
      assert.equal(r.ignore.checked, true);
      assert.deepEqual(r.ignore.uncovered, [AGENTS_SKILL, '.agents/skills/greet/scripts/hello.sh', CODEX_AGENT]);
      const w = r.warnings.find((x) => /neither tracked nor gitignored/.test(x));
      assert.match(w, /info\/exclude`, which every linked worktree of this repository shares/);
      assert.match(w, /nothing was added for you/);
      assert.equal(read(wt, '.gitignore'), gi);
      assert.match(porcelain(wt), /\?\? \.codex\/agents\/helper\.toml/);
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(toolkitRoot, { recursive: true, force: true });
    }
  });
});

describe('prepare-worktree CLI', () => {
  let main;
  let toolkitRoot;
  beforeEach(() => ({ main, toolkitRoot } = makeMain()));
  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, WAFFLESTACK_ALLOW_UNRELEASED: '1', WAFFLESTACK_OFFLINE: '1' } });

  test('help lists the command and its flags; refs are rejected before anything runs', () => {
    const help = run('help').stdout;
    assert.match(help, /prepare-worktree  provision a checkout/);
    assert.match(help, /--overlay MODE/);
    assert.match(help, /prepare-worktree\|upgrade/);
    const wt = addWorktree(main);
    const refused = run('prepare-worktree', 'skills/greet', '--cwd', wt);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /takes no refs/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
  });

  test('exit 1 with the mismatched toolkit version (the real CLI against a 0.0.test lock), --json carries the document', () => {
    const wt = addWorktree(main);
    const r = run('prepare-worktree', '--cwd', wt, '--json');
    assert.equal(r.status, 1, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.status, 'failed');
    assert.match(doc.errors[0], /rendered by 0\.0\.test/);
    const text = run('prepare-worktree', '--cwd', wt);
    assert.equal(text.status, 1);
    assert.match(text.stderr, /^prepare-worktree: failed/m);
    assert.match(text.stderr, /checkout: linked worktree of/);
  });

  test('an invalid --overlay value and a missing value both exit 1 before any write', () => {
    const wt = addWorktree(main);
    assert.match(run('prepare-worktree', '--cwd', wt, '--overlay', 'all').stderr, /--overlay must be one of/);
    assert.match(run('prepare-worktree', '--cwd', wt, '--overlay').stderr, /--overlay requires a value/);
    assert.equal(fs.existsSync(path.join(wt, HELPER)), false);
  });
});

describe('PREPARE_WORKTREE_SINCE', () => {
  test('is a release the toolkit has reached or is about to cut', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.ok(parseVersion(PREPARE_WORKTREE_SINCE));
    const [[aMajor, aMinor], [bMajor, bMinor]] = [parseVersion(pkg.version), parseVersion(PREPARE_WORKTREE_SINCE)];
    assert.ok(compareVersions(PREPARE_WORKTREE_SINCE, pkg.version) >= 0 ? aMajor === bMajor && bMinor <= aMinor + 1 : true, `${pkg.version} vs ${PREPARE_WORKTREE_SINCE}`);
  });
});
