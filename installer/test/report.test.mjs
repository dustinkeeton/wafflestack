import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { collectReport, formatReportMarkdown, keyPaths, scrub, redact } from '../lib/report.mjs';

// `wafflestack report` (#473): a redacted diagnostics bundle for an upstream bug report. The
// invariants under test — the overlay and local lock are NEVER read, config values never appear,
// absolute paths are scrubbed, doctor red does not change the exit code.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'installer', 'cli.mjs');
const OVERLAY_SECRET = 'OVERLAY-ONLY-VALUE-7f3a9c';
const COMMITTED_SECRET = 'COMMITTED-VALUE-1b2c3d';

const write = (cwd, rel, content) => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const runCli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd, '--offline'], { encoding: 'utf8', timeout: 60000 });

describe('report: bundle collection and redaction (#473)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-report-'));
    write(cwd, '.waffle/waffle.yaml', [
      'targets: [claude]',
      'stacks: [wafflestack]',
      'config:',
      '  git:',
      `    botEmail: ${COMMITTED_SECRET}@example.com`,
      '  project:',
      '    name: ReportFixture',
      '',
    ].join('\n'));
    const result = renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    // Written AFTER the render so the canonical lock is the only lock — then poisoned: an overlay
    // holding a sentinel, and a local lock that is not even JSON. Reading either would show.
    write(cwd, '.waffle/waffle.local.yaml', `config:\n  git:\n    botEmail: ${OVERLAY_SECRET}\n  secret:\n    token: ${OVERLAY_SECRET}\n`);
    write(cwd, '.waffle/waffle.local.lock.json', '{ this is not json');
  });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  const collect = () => collectReport({ cwd, toolkitRoot: REPO_ROOT, toolkitVersion: '0.0.test' });

  test('the overlay value and the overlay-only key never reach the bundle; the local lock is never parsed', () => {
    const bundle = collect();
    const text = JSON.stringify(bundle) + formatReportMarkdown(bundle);
    assert.ok(!text.includes(OVERLAY_SECRET), 'overlay value leaked');
    assert.ok(!bundle.config.configKeys.includes('secret.token'), 'overlay-only key leaked — the overlay was merged');
    assert.ok(!/doctor could not run/.test(text), 'the unparseable local lock was opened');
    assert.equal(bundle.environment.localOverlay, true, 'presence IS reported');
    assert.equal(bundle.environment.localLock, true);
  });

  test('config keys are present, config values are absent', () => {
    const bundle = collect();
    assert.ok(bundle.config.configKeys.includes('git.botEmail'));
    assert.ok(bundle.config.configKeys.includes('project.name'));
    const text = JSON.stringify(bundle) + formatReportMarkdown(bundle);
    assert.ok(!text.includes(COMMITTED_SECRET), 'a committed config value leaked');
    assert.ok(!text.includes('ReportFixture'), 'project.name value leaked');
  });

  test('the lock summary carries version, toolkit block, targets, stacks, and a file COUNT — never file paths', () => {
    const bundle = collect();
    assert.equal(bundle.lock.toolkitVersion, '0.0.test');
    assert.deepEqual(bundle.lock.targets, ['claude']);
    assert.deepEqual(bundle.lock.stacks, ['wafflestack']);
    assert.ok(bundle.lock.trackedFiles > 0);
    assert.ok(!JSON.stringify(bundle.lock).includes('SKILL.md'), 'tracked file paths are summarized as a count');
    assert.ok('source' in bundle.lock.toolkit && 'status' in bundle.lock.toolkit);
  });

  test('the home directory and the repo path are scrubbed from every string', () => {
    const home = os.homedir();
    const bundle = collectReport({ cwd, toolkitRoot: REPO_ROOT, toolkitVersion: '0.0.test', home });
    const text = JSON.stringify(bundle) + formatReportMarkdown(bundle);
    assert.ok(!text.includes(home), 'home directory leaked');
    assert.ok(!text.includes(cwd), 'repo path leaked');
  });

  test('a red doctor is reported, not fatal: modified counts appear and collection still succeeds', () => {
    fs.appendFileSync(path.join(cwd, '.claude/skills/waffle-doctor/SKILL.md'), '\nhand edit\n');
    const bundle = collect();
    assert.equal(bundle.health.ok, false);
    assert.equal(bundle.health.modified, 1);
    assert.match(formatReportMarkdown(bundle), /NOT ok — 1 modified/);
  });

  test('an unrendered repo (no lock) and an unconfigured dir still produce a bundle', () => {
    fs.rmSync(path.join(cwd, '.waffle/waffle.lock.json'));
    let bundle = collect();
    assert.equal(bundle.lock, null);
    assert.equal(bundle.config.present, true);
    assert.match(formatReportMarkdown(bundle), /lock\*\*: none/);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'project-report-bare-'));
    try {
      bundle = collectReport({ cwd: bare, toolkitRoot: REPO_ROOT, toolkitVersion: '0.0.test' });
      assert.equal(bundle.config.present, false);
      assert.equal(bundle.lock, null);
      assert.match(formatReportMarkdown(bundle), /no `\.waffle\/waffle\.yaml`/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('the Markdown block is a collapsed <details> section', () => {
    const md = formatReportMarkdown(collect());
    assert.match(md, /^<details>\n<summary>/);
    assert.match(md, /<\/details>\n$/);
    assert.match(md, /\*\*config keys\*\* \(values withheld\)/);
  });
});

describe('report: CLI surface (#473)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-report-cli-'));
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [wafflestack]\nconfig: {}\n');
    assert.equal(renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' }).ok, true);
    write(cwd, '.waffle/waffle.local.yaml', `config:\n  git:\n    botEmail: ${OVERLAY_SECRET}\n`);
  });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  test('`report --json` prints parseable JSON on stdout and exits 0', () => {
    const r = runCli(['report', '--json'], cwd);
    assert.equal(r.status, 0, r.stderr);
    const bundle = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(bundle), ['cli', 'lock', 'config', 'environment', 'health']);
    assert.ok(!r.stdout.includes(OVERLAY_SECRET));
    assert.ok(!r.stdout.includes(os.homedir()), 'home directory in the JSON');
  });

  test('`report` exits 0 even when doctor is red — the report describes a broken repo, it does not gate on one', () => {
    fs.appendFileSync(path.join(cwd, '.claude/skills/waffle-render/SKILL.md'), '\nhand edit\n');
    assert.notEqual(runCli(['doctor'], cwd).status, 0, 'precondition: doctor is red');
    const r = runCli(['report'], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<details>/);
    assert.match(r.stdout, /NOT ok — 1 modified/);
  });

  test('`report` takes no refs', () => {
    const r = runCli(['report', 'skills/waffle-doctor'], cwd);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /report takes no refs/);
  });

  test('`report` is not release-gated: an unreleased checkout warns on stderr and still prints', () => {
    const r = runCli(['report'], cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /<details>/);
    assert.doesNotMatch(r.stdout, /refus/i);
  });
});

describe('report: scrub + projection helpers (#473)', () => {
  test('scrub rewrites cwd, home, emails, and git remotes to stable placeholders', () => {
    const home = path.join(os.tmpdir(), 'home-jane');
    const cwd = path.join(home, 'dev', 'private-app');
    const text = [
      `modified: ${cwd}/.claude/skills/x/SKILL.md`,
      `cache at ${home}/.cache/wafflestack`,
      'author jane.doe@corp.example.com and bot+x@wafflenet.io',
      'remote git@github.com:acme-private/app.git and https://gitlab.example.com/acme/app.git',
      'ssh://git@bitbucket.org/acme/app',
      'toolkit github:dustinkeeton/wafflestack#v0.15.0 stays',
    ].join('\n');
    const out = scrub(text, { cwd, home });
    assert.ok(!out.includes(home) && !out.includes(cwd));
    assert.match(out, /modified: <repo>\/\.claude\/skills\/x\/SKILL\.md/);
    assert.match(out, /cache at ~\/\.cache\/wafflestack/);
    assert.ok(!out.includes('jane.doe') && !out.includes('wafflenet.io'), 'email leaked');
    assert.ok(!out.includes('acme-private') && !out.includes('gitlab.example.com') && !out.includes('bitbucket.org'), 'remote leaked');
    assert.match(out, /github:dustinkeeton\/wafflestack#v0\.15\.0 stays/, 'the npx toolkit spec is the report destination and survives');
  });

  test('redact walks nested objects and arrays, keys included', () => {
    const home = '/home/jane';
    const out = redact({ [`${home}/k`]: [`${home}/a`, { n: `${home}/b`, x: 1 }] }, { home });
    assert.deepEqual(out, { '~/k': ['~/a', { n: '~/b', x: 1 }] });
  });

  test('keyPaths projects dotted key names only; arrays and scalars are leaves', () => {
    assert.deepEqual(keyPaths({ git: { botEmail: 'x', cmd: 'y' }, release: { versionFiles: ['a'] }, flat: 1 }), [
      'flat', 'git.botEmail', 'git.cmd', 'release.versionFiles',
    ]);
    assert.deepEqual(keyPaths(null), []);
  });
});
