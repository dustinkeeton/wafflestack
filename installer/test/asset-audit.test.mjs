import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { collectReport, formatReportMarkdown } from '../lib/report.mjs';
import { resolveAssetAuditSettings, safePathEntries, auditEnv, ASSET_AUDIT_ENV, TOP_FINDINGS } from '../lib/asset-audit.mjs';

// The opt-in large-asset audit in `doctor`: off unless WAFFLESTACK_ASSET_AUDIT or the UNTRACKED
// local overlay names a script outside the repo (the committed waffle.yaml never chooses code to
// run); advisory unless strict; a missing script, missing Python or a failed audit is a one-line
// note, never a crash; `report` never runs it. The audit itself is a STUB Python script printing
// fixture JSON, so nothing here needs the studios checkout.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'installer', 'cli.mjs');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const needsPython = { skip: hasPython ? false : 'python3 is not on PATH' };

const write = (abs, content) => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

/** An env without any inherited asset-audit override. */
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  if (!(ASSET_AUDIT_ENV in extra)) delete env[ASSET_AUDIT_ENV];
  return env;
};
const runCli = (args, cwd, extraEnv = {}) =>
  spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd, '--offline'], { encoding: 'utf8', timeout: 60000, env: cleanEnv(extraEnv) });

const finding = (severity, id, p) => ({ id, category: id.split('.')[0], severity, path: p, message: `${id} at ${p}`, fix: `fix ${id}` });

/** A version-1 report: 1 error, 6 warnings, 1 info. */
function fixtureReport() {
  const findings = [
    finding('error', 'lfs.unhydrated-pointer', 'assets/hero.png'),
    ...Array.from({ length: 6 }, (_, i) => finding('warning', 'size.log-in-git', `logs/run-${i}.log`)),
    finding('info', 'lfs.binary-not-in-lfs', 'waived.bin'),
  ];
  findings[0].message = 'ARGV';
  findings[1].message = 'CWD';
  findings[2].message = 'ENVKEYS';
  return {
    kind: 'asset-audit-report',
    schema_version: '1.0.0',
    tool: { name: 'asset-audit', version: '1.0.0', contract_version: '1.0.0' },
    mode: 'advisory',
    exit_code: 0,
    summary: { error: 1, warning: 6, info: 1, result: 'findings' },
    findings,
  };
}

/** A stub `asset_audit.py`: prints `stdout` (the fixture JSON by default), then exits `code`. */
function stubScript(file, { report = fixtureReport(), stdout = null, code = 0, sleep = 0, stderr = '', marker = null } = {}) {
  const body = stdout ?? JSON.stringify(report);
  write(file, [
    'import json, sys, time',
    `time.sleep(${sleep})`,
    `out = ${JSON.stringify(body)}`,
    "import os",
    "out = out.replace('ARGV', ' '.join(sys.argv[1:]).replace('\\\\', '/'))",
    "out = out.replace('CWD', os.getcwd().replace('\\\\', '/'))",
    "out = out.replace('ENVKEYS', ','.join(sorted(k for k in os.environ if k not in ('__CF_USER_TEXT_ENCODING', 'LC_CTYPE'))))",
    `marker = ${JSON.stringify(marker ?? '')}`,
    "if marker: open(marker, 'w').write('ran')",
    `sys.stderr.write(${JSON.stringify(stderr)})`,
    'sys.stdout.write(out)',
    `sys.exit(${code})`,
    '',
  ].join('\n'));
  return file;
}

describe('doctor: opt-in large-asset audit', () => {
  let cwd;
  let tools;
  const BASE = ['targets: [claude]', 'stacks: [wafflestack]'];
  const config = (...lines) => write(path.join(cwd, '.waffle/waffle.yaml'), [...BASE, ...lines, ''].join('\n'));
  const local = (...lines) => write(path.join(cwd, '.waffle/waffle.local.yaml'), [...lines, ''].join('\n'));

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-assets-'));
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-audit-stub-'));
    config();
    const result = renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    // A git work tree, so doctor can confirm the local overlay is untracked.
    assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(tools, { recursive: true, force: true });
  });

  test('disabled: no config, no env — doctor output and exit code are unchanged', () => {
    const plain = runCli(['doctor'], cwd);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.doesNotMatch(plain.stdout, /asset/i);
    // An empty override is "unset", so the output is byte-identical.
    const empty = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: '' });
    assert.equal(empty.stdout, plain.stdout);
    assert.equal(empty.status, 0);
    // The strict flag alone turns nothing on.
    const strictOnly = runCli(['doctor', '--asset-audit-strict'], cwd);
    assert.equal(strictOnly.stdout, plain.stdout);
    assert.equal(strictOnly.status, 0);
    // A library caller that does not ask for the audit (upgrade does not) never runs it.
    const r = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(r.ok, true);
    assert.equal(r.assetAudit.enabled, false);
  });

  test('enabled through the local overlay: summary, top findings with fix hints, exit code unchanged', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    local('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`);
    const r = runCli(['doctor'], cwd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^asset audit: 1 error\(s\), 6 warning\(s\), 1 info \(advisory — does not change the exit code\)$/m);
    assert.match(r.stdout, /^ {2}error lfs\.unhydrated-pointer: assets\/hero\.png — /m);
    assert.match(r.stdout, /^ {4}fix: fix lfs\.unhydrated-pointer$/m);
    const listed = r.stdout.split('\n').filter((l) => /^ {2}(error|warning) /.test(l));
    assert.equal(listed.length, TOP_FINDINGS);
    assert.match(r.stdout, /… and 2 more; full report: python3 /);
    assert.doesNotMatch(r.stdout, /waived\.bin/, 'info findings are not listed');
    assert.match(r.stdout, /all managed files match the lock manifest/);
    // The audit got the project root as an argument, as JSON, without --allow-unhydrated.
    const realCwd = fs.realpathSync(cwd).replace(/\\/g, '/');
    const argv = /error lfs\.unhydrated-pointer: assets\/hero\.png — (.*)$/m.exec(r.stdout)[1];
    assert.match(argv, /^audit .+ --json$/);
    assert.ok(argv.includes(cwd.replace(/\\/g, '/')) || argv.includes(realCwd), argv);
  });

  test('the audit runs from the temp dir with a minimal env', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    const r = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: script, SECRET_TOKEN: 'do-not-pass', LANG: 'en_US.UTF-8' });
    const line = (p) => new RegExp(`warning size\\.log-in-git: logs/${p} — (.*)$`, 'm').exec(r.stdout)[1];
    assert.equal(fs.realpathSync(line('run-0\\.log')), fs.realpathSync(os.tmpdir()));
    const keys = line('run-1\\.log').split(',').filter(Boolean);
    assert.ok(!keys.includes('SECRET_TOKEN'), keys.join(','));
    assert.ok(!keys.includes(ASSET_AUDIT_ENV), keys.join(','));
    for (const k of keys) assert.ok(['PATH', 'HOME', 'GIT_OPTIONAL_LOCKS', 'LANG'].includes(k) || k.startsWith('LC_'), `unexpected env var ${k}`);
    assert.ok(keys.includes('GIT_OPTIONAL_LOCKS') && keys.includes('PATH'));
  });

  test('PATH entries inside the project are never used to find python3', () => {
    const planted = path.join(cwd, 'bin');
    fs.mkdirSync(planted);
    assert.deepEqual(safePathEntries([planted, 'relative/bin', '', '/usr/bin'].join(path.delimiter), cwd), ['/usr/bin']);
    const env = auditEnv({ PATH: 'x', HOME: '/h', LANG: 'C', LC_ALL: 'C', SECRET: 's' }, ['/usr/bin']);
    assert.deepEqual(env, { PATH: '/usr/bin', GIT_OPTIONAL_LOCKS: '0', HOME: '/h', LANG: 'C', LC_ALL: 'C' });
    // A repo-planted python3 that is the ONLY one on PATH is not found, so the audit is not run.
    write(path.join(planted, 'python3'), '#!/bin/sh\necho planted\n');
    fs.chmodSync(path.join(planted, 'python3'), 0o755);
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    const r = doctor({ cwd, toolkitVersion: '0.0.test', assetAudit: { env: { PATH: planted, [ASSET_AUDIT_ENV]: script } } });
    assert.equal(r.assetAudit.ran, false);
    assert.match(r.assetAudit.notes.join('\n'), /python3 not found on PATH \(outside the project/);
  });

  test('the committed waffle.yaml cannot choose the script: ignored with a note', needsPython, () => {
    const marker = path.join(tools, 'ran.txt');
    const script = stubScript(path.join(tools, 'asset_audit.py'), { marker });
    config('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`, '    strict: true');
    const r = runCli(['doctor'], cwd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(marker), false, 'a script named by the committed config ran');
    assert.match(r.stdout, /`doctor\.assetAudit\.script` in \.waffle\/waffle\.yaml is ignored — a committed file must not choose code for doctor to run; set it in \.waffle\/waffle\.local\.yaml \(gitignored\) or the WAFFLESTACK_ASSET_AUDIT environment variable/);
    assert.doesNotMatch(r.stdout, /^asset audit: \d/m);
  });

  test('a TRACKED local overlay cannot choose the script either', needsPython, () => {
    const marker = path.join(tools, 'ran.txt');
    const script = stubScript(path.join(tools, 'asset_audit.py'), { marker });
    local('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`);
    assert.equal(spawnSync('git', ['-C', cwd, 'add', '-f', '.waffle/waffle.local.yaml']).status, 0);
    const r = runCli(['doctor'], cwd);
    assert.equal(fs.existsSync(marker), false, 'a script named by a tracked overlay ran');
    assert.match(r.stdout, /in \.waffle\/waffle\.local\.yaml is ignored — that file is tracked by git/);
  });

  test('a script inside the project root is refused', needsPython, () => {
    const marker = path.join(tools, 'ran.txt');
    const inside = stubScript(path.join(cwd, 'tools', 'asset_audit.py'), { marker });
    for (const env of [{ [ASSET_AUDIT_ENV]: inside }, { [ASSET_AUDIT_ENV]: 'tools/asset_audit.py' }]) {
      const r = runCli(['doctor', '--asset-audit-strict'], cwd, env);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /asset audit not run: refusing script .*asset_audit\.py \(from WAFFLESTACK_ASSET_AUDIT\) — it is inside the project being audited/);
    }
    // A symlink from outside that points back into the repo is refused too.
    const link = path.join(tools, 'link.py');
    fs.symlinkSync(inside, link);
    const r = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: link });
    assert.match(r.stdout, /refusing script/);
    assert.equal(fs.existsSync(marker), false);
  });

  test('the env override enables the check and wins over the overlay script', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    local('doctor:', '  assetAudit:', '    script: /does/not/exist.py');
    const r = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^asset audit: 1 error\(s\), 6 warning\(s\)/m);
  });

  test('strict with errors: doctor exits non-zero (committed config value and CLI flag)', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    config('doctor:', '  assetAudit:', '    strict: true');
    const viaConfig = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(viaConfig.status, 1, viaConfig.stdout);
    assert.match(viaConfig.stdout, /\(strict — errors and warnings fail doctor\)/);
    assert.match(viaConfig.stdout, /^asset audit failed doctor \(strict mode is on\)$/m);

    config();
    const viaFlag = runCli(['doctor', '--asset-audit-strict'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(viaFlag.status, 1, viaFlag.stdout);
  });

  test('strict with a clean audit: exit 0', needsPython, () => {
    const report = { ...fixtureReport(), summary: { error: 0, warning: 0, info: 1, result: 'clean' }, findings: [finding('info', 'lfs.binary-not-in-lfs', 'w.bin')] };
    const script = stubScript(path.join(tools, 'asset_audit.py'), { report });
    const r = runCli(['doctor', '--asset-audit-strict'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^asset audit: 0 error\(s\), 0 warning\(s\), 1 info/m);
  });

  test('allowUnhydrated (committed config or CLI flag) passes --allow-unhydrated', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    const argv = (r) => /error lfs\.unhydrated-pointer: assets\/hero\.png — (.*)$/m.exec(r.stdout)[1];
    const viaFlag = runCli(['doctor', '--asset-audit-allow-unhydrated'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.match(argv(viaFlag), / --json --allow-unhydrated$/);
    config('doctor:', '  assetAudit:', '    allowUnhydrated: true');
    const viaConfig = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.match(argv(viaConfig), / --json --allow-unhydrated$/);
  });

  test('script missing: a one-line note, no crash, exit code unchanged', () => {
    const r = runCli(['doctor', '--asset-audit-strict'], cwd, { [ASSET_AUDIT_ENV]: path.join(tools, 'nope.py') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const notes = r.stdout.split('\n').filter((l) => /asset audit/.test(l));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^asset audit not run: script not found at .*nope\.py \(from WAFFLESTACK_ASSET_AUDIT\)$/);
    assert.equal(r.stderr, '');
  });

  test('Python missing: a note, no crash', () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    const r = doctor({ cwd, toolkitVersion: '0.0.test', assetAudit: { strict: true, env: { PATH: process.env.PATH, [ASSET_AUDIT_ENV]: script }, python: path.join(tools, 'no-python3') } });
    assert.equal(r.ok, true, 'strict cannot fail an audit that never ran');
    assert.equal(r.assetAudit.ran, false);
    assert.match(r.assetAudit.notes.join('\n'), /asset audit not run: .*no-python3 not found/);
  });

  test('audit exit 2, non-JSON output, a foreign report kind, a newer major: each a note', needsPython, () => {
    const cases = [
      [{ code: 2, stdout: '', stderr: 'Traceback…\nasset_audit: not a git checkout\n' }, /could not run \(exit 2\): asset_audit: not a git checkout/],
      [{ stdout: 'not json' }, /did not print a JSON report/],
      [{ report: { ...fixtureReport(), kind: 'something-else' } }, /unexpected report kind "something-else"/],
      [{ report: { ...fixtureReport(), schema_version: '2.0.0' } }, /unsupported report schema_version "2\.0\.0"/],
    ];
    for (const [opts, expected] of cases) {
      const script = stubScript(path.join(tools, 'asset_audit.py'), opts);
      const r = runCli(['doctor', '--asset-audit-strict'], cwd, { [ASSET_AUDIT_ENV]: script });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, expected);
      assert.doesNotMatch(r.stdout, /^asset audit: \d/m);
    }
  });

  test('a slow audit times out into a note', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'), { sleep: 30 });
    config('doctor:', '  assetAudit:', '    timeoutSeconds: 1');
    const started = Date.now();
    const r = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /asset audit not run: timed out after 1s/);
    assert.ok(Date.now() - started < 20000, 'the timeout did not stop the audit');
  });

  test('settings problems are notes: misplaced under config:, unknown keys, bad values', () => {
    config('config:', '  doctor:', '    assetAudit:', '      script: x.py');
    let s = resolveAssetAuditSettings({ cwd, env: {} });
    assert.equal(s.enabled, false);
    assert.match(s.notes.join('\n'), /`config\.doctor\.assetAudit` .* is ignored/);

    config();
    local('doctor:', '  assetAudit:', '    script: ~/studios/asset_audit.py', '    strict: yes-please', '    timeoutSeconds: -1', '    scirpt: typo');
    s = resolveAssetAuditSettings({ cwd, env: {}, home: '/home/u' });
    assert.equal(s.enabled, true);
    assert.equal(s.scriptSource, 'local');
    assert.equal(s.script, path.join('/home/u', 'studios/asset_audit.py'));
    assert.equal(s.strict, false);
    assert.equal(s.timeoutMs, 120000);
    const text = s.notes.join('\n');
    assert.match(text, /unknown key\(s\) .* scirpt/);
    assert.match(text, /strict` in .* must be true or false/);
    assert.match(text, /timeoutSeconds` in .* must be a positive number/);
  });

  test('report never runs the audit and carries no asset line', needsPython, () => {
    const marker = path.join(tools, 'ran.txt');
    const script = stubScript(path.join(tools, 'asset_audit.py'), { marker });
    local('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`);
    const saved = process.env[ASSET_AUDIT_ENV];
    process.env[ASSET_AUDIT_ENV] = script;
    try {
      const bundle = collectReport({ cwd, toolkitRoot: REPO_ROOT, toolkitVersion: '0.0.test' });
      assert.doesNotMatch(JSON.stringify(bundle) + formatReportMarkdown(bundle), /asset audit/);
    } finally {
      if (saved === undefined) delete process.env[ASSET_AUDIT_ENV];
      else process.env[ASSET_AUDIT_ENV] = saved;
    }
    const r = runCli(['report'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /asset audit/);
    assert.equal(fs.existsSync(marker), false, 'report spawned the audit');
  });
});
