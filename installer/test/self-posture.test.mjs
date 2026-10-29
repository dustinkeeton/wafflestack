import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #777: this repo is lock-only (Posture 2b) — the .claude/ render is gitignored, its inputs and lock tracked.
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const git = (...args) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const inGit = git('rev-parse', '--is-inside-work-tree').status === 0;
const lsFiles = (...paths) => git('ls-files', '-z', '--', ...paths).stdout.split('\0').filter(Boolean);
const lockKeys = () => Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, '.waffle/waffle.lock.json'), 'utf8')).files);

describe('self-posture: lock-only (#777)', { skip: !inGit && 'not a git checkout' }, () => {
  const rendered = lockKeys().filter((k) => k.startsWith('.claude/'));

  test('the lock manages a .claude/ render', () => assert.ok(rendered.length >= 20, `${rendered.length}`));

  test('no lock-managed .claude/ file is tracked', () => {
    const tracked = new Set(lsFiles('.claude'));
    assert.deepEqual(rendered.filter((k) => tracked.has(k)), [], 'git rm --cached the render; commit only the lock');
  });

  test('every lock-managed .claude/ file is gitignored', () => {
    const r = spawnSync('git', ['-C', ROOT, 'check-ignore', '--no-index', '--stdin'], { input: rendered.join('\n'), encoding: 'utf8' });
    const ignored = new Set(r.stdout.split('\n').filter(Boolean));
    assert.deepEqual(rendered.filter((k) => !ignored.has(k)), []);
  });

  test('config, extensions, and the lock are tracked', () => {
    for (const f of ['.waffle/waffle.yaml', '.waffle/waffle.lock.json', '.claude/settings.json']) assert.deepEqual(lsFiles(f), [f]);
    assert.ok(lsFiles('.waffle/extensions').length > 0, '.waffle/extensions/ is untracked');
  });

  test('every rendered .github/ workflow but the unarmed label hook is tracked', () => {
    const tracked = new Set(lsFiles('.github/workflows'));
    const missing = lockKeys().filter((k) => k.startsWith('.github/workflows/') && !k.endsWith('/waffle-label-hook.yml') && !tracked.has(k));
    assert.deepEqual(missing, []);
  });
});
