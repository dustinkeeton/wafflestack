import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCKFILES,
  PACKAGE_MANAGERS,
  parsePackageManagerField,
  packageManagerFrom,
  suggestCommands,
  detectPackageManager,
} from '../lib/package-manager.mjs';
import { setupGuide } from '../lib/setup.mjs';
import { readYaml } from '../lib/util.mjs';
import { compilePattern } from '../lib/template.mjs';

// #729: setup detects the package manager and suggests `project.*Cmd` values, never writing them.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'installer', 'cli.mjs');
const HEADING = '# Detected package manager — suggested commands';
const ALL_SCRIPTS = { test: 't', lint: 'l', typecheck: 'tc', build: 'b' };

const tmpProject = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-pm-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
};

describe('parsePackageManagerField', () => {
  test('accepts each known manager and strips a corepack hash', () => {
    assert.deepEqual(parsePackageManagerField('pnpm@9.1.0'), { name: 'pnpm', version: '9.1.0' });
    assert.deepEqual(parsePackageManagerField('yarn@4.1.0+sha512.abc123'), { name: 'yarn', version: '4.1.0' });
    assert.deepEqual(parsePackageManagerField('bun@1.1.0'), { name: 'bun', version: '1.1.0' });
    assert.deepEqual(parsePackageManagerField('npm@10.2.0'), { name: 'npm', version: '10.2.0' });
  });
  test('rejects unknown, versionless and non-string values', () => {
    for (const v of ['deno@1.0.0', 'pnpm', 'pnpm@', '', 42, null, undefined, { name: 'pnpm' }]) {
      assert.equal(parsePackageManagerField(v), null, String(v));
    }
  });
});

describe('packageManagerFrom', () => {
  test('each lockfile alone maps to its manager', () => {
    for (const [file, name] of LOCKFILES) {
      const d = packageManagerFrom({ packageJson: {}, lockfiles: [file] });
      assert.equal(d?.name, name, file);
      assert.equal(d?.source, 'lockfile');
      assert.equal(d?.lockfile, file);
      assert.deepEqual(d?.conflicts, []);
    }
  });
  test('the packageManager field beats a lockfile and reports the conflict', () => {
    const d = packageManagerFrom({ packageJson: { packageManager: 'yarn@4.1.0' }, lockfiles: ['pnpm-lock.yaml'] });
    assert.deepEqual(d, { name: 'yarn', version: '4.1.0', source: 'packageManager', lockfile: null, conflicts: ['pnpm'] });
  });
  test('an invalid field falls through to the lockfile', () => {
    const d = packageManagerFrom({ packageJson: { packageManager: 'deno@1' }, lockfiles: ['yarn.lock'] });
    assert.equal(d?.name, 'yarn');
    assert.equal(d?.source, 'lockfile');
  });
  test('several lockfiles: precedence order wins, the rest are conflicts', () => {
    const d = packageManagerFrom({ packageJson: {}, lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] });
    assert.equal(d?.name, 'pnpm');
    assert.deepEqual(d?.conflicts, ['yarn', 'npm']);
  });
  test('no package.json → null; no field and no lockfile → no manager', () => {
    assert.equal(packageManagerFrom({ packageJson: null, lockfiles: ['pnpm-lock.yaml'] }), null);
    assert.equal(packageManagerFrom({ packageJson: {}, lockfiles: [] })?.name, null);
  });
});

describe('suggestCommands', () => {
  const expected = {
    npm: ['npm install', 'npm test', 'npm run lint', 'npm run typecheck', 'npm run build'],
    pnpm: ['pnpm install', 'pnpm test', 'pnpm run lint', 'pnpm run typecheck', 'pnpm run build'],
    yarn: ['yarn install', 'yarn test', 'yarn run lint', 'yarn run typecheck', 'yarn run build'],
    bun: ['bun install', 'bun run test', 'bun run lint', 'bun run typecheck', 'bun run build'],
  };
  const keys = ['project.installCmd', 'project.testCmd', 'project.lintCmd', 'project.typecheckCmd', 'project.buildCmd'];
  for (const pm of PACKAGE_MANAGERS) {
    test(`${pm}: every script maps to its command`, () => {
      const got = suggestCommands({ name: pm }, ALL_SCRIPTS);
      assert.deepEqual(got, Object.fromEntries(keys.map((k, i) => [k, expected[pm][i]])));
    });
  }
  test('missing scripts suggest only installCmd; no manager suggests nothing', () => {
    assert.deepEqual(suggestCommands({ name: 'pnpm' }, undefined), { 'project.installCmd': 'pnpm install' });
    assert.deepEqual(suggestCommands({ name: 'pnpm' }, { start: 's' }), { 'project.installCmd': 'pnpm install' });
    assert.deepEqual(suggestCommands({ name: null }, ALL_SCRIPTS), {});
    assert.deepEqual(suggestCommands(null, ALL_SCRIPTS), {});
  });
  test('every suggestion passes the real config guards', () => {
    const cq = readYaml(path.join(REPO_ROOT, 'stacks', 'code-quality', 'stack.yaml')).config;
    const gw = readYaml(path.join(REPO_ROOT, 'stacks', 'github-workflow', 'stack.yaml')).config;
    const cmdGuard = compilePattern(cq['project.testCmd'].pattern);
    const guards = {
      'project.installCmd': compilePattern(gw['project.installCmd'].pattern),
      'project.testCmd': cmdGuard,
      'project.lintCmd': cmdGuard,
      'project.typecheckCmd': cmdGuard,
      'project.buildCmd': cmdGuard,
    };
    for (const pm of PACKAGE_MANAGERS) {
      for (const [key, cmd] of Object.entries(suggestCommands({ name: pm }, ALL_SCRIPTS))) {
        assert.match(cmd, guards[key], `${key} = ${cmd}`);
      }
    }
  });
});

describe('detectPackageManager', () => {
  test('no package.json → null, even beside a lockfile', () => {
    assert.equal(detectPackageManager(tmpProject({ 'pnpm-lock.yaml': '' })), null);
  });
  test('malformed package.json → null, no throw', () => {
    assert.equal(detectPackageManager(tmpProject({ 'package.json': '{ nope' })), null);
  });
  test('reads the field, scripts and lockfiles from disk', () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ packageManager: 'bun@1.1.0', scripts: { test: 'x' } }),
      'bun.lockb': '',
    });
    assert.deepEqual(detectPackageManager(dir), {
      detection: { name: 'bun', version: '1.1.0', source: 'packageManager', lockfile: null, conflicts: [] },
      suggestions: { 'project.installCmd': 'bun install', 'project.testCmd': 'bun run test' },
    });
  });
});

describe('setup: detected package manager section', () => {
  test('fresh project with package.json + pnpm-lock.yaml gets suggestions', () => {
    const dir = tmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'pnpm-lock.yaml': '' });
    const guide = setupGuide(REPO_ROOT, '0.0.test', undefined, { detectDir: dir });
    assert.ok(guide.includes(HEADING));
    assert.ok(guide.includes('detected: pnpm (from `pnpm-lock.yaml`)'));
    assert.ok(guide.includes('- `project.testCmd` → `pnpm test` (default: `npm test`)'));
    assert.ok(guide.includes('Suggestions only — nothing was written.'));
  });
  test('no package.json → no section', () => {
    const guide = setupGuide(REPO_ROOT, '0.0.test', undefined, { detectDir: tmpProject({ 'yarn.lock': '' }) });
    assert.ok(!guide.includes(HEADING));
  });
  test('package.json with no manager evidence → no section', () => {
    const guide = setupGuide(REPO_ROOT, '0.0.test', undefined, { detectDir: tmpProject({ 'package.json': '{}' }) });
    assert.ok(!guide.includes(HEADING));
  });
  test('a key set in waffle.yaml is not suggested; a suggestion equal to the default is dropped', () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ scripts: { test: 'x', build: 'b' } }),
      'pnpm-lock.yaml': '',
      '.waffle/waffle.yaml': 'version: 1\ntargets: [claude]\nstacks: [code-quality]\nconfig:\n  project:\n    testCmd: make test\n',
    });
    const guide = setupGuide(REPO_ROOT, '0.0.test', dir, { detectDir: dir });
    assert.ok(guide.includes('`project.buildCmd` → `pnpm run build`'));
    assert.ok(!guide.includes('`project.testCmd` → '));
    const npm = tmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'package-lock.json': '{}' });
    const npmGuide = setupGuide(REPO_ROOT, '0.0.test', undefined, { detectDir: npm });
    assert.ok(npmGuide.includes('detected: npm (from `package-lock.json`)'));
    assert.ok(npmGuide.includes('nothing to suggest'));
  });
  test('CLI setup prints the section and writes no command into waffle.yaml', () => {
    const dir = tmpProject({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.1.0', scripts: { test: 'x' } }) });
    const r = spawnSync(process.execPath, [CLI, 'setup', '--cwd', dir, '--offline'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(HEADING));
    assert.ok(r.stdout.includes('`project.testCmd` → `yarn test`'));
    const cfg = fs.readFileSync(path.join(dir, '.waffle', 'waffle.yaml'), 'utf8');
    assert.ok(!/yarn/.test(cfg));
  });
});
