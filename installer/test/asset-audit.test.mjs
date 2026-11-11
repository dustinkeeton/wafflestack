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
import { resolveAssetAuditSettings, ASSET_AUDIT_ENV, TOP_FINDINGS } from '../lib/asset-audit.mjs';

// The opt-in large-asset audit in `doctor`: off unless `doctor.assetAudit.script` (or the
// WAFFLESTACK_ASSET_AUDIT env override) names a script; advisory unless strict; a missing script,
// missing Python or a failed audit is a one-line note, never a crash. The audit itself is a STUB
// Python script printing fixture JSON, so nothing here needs the studios checkout.

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
function stubScript(file, { report = fixtureReport(), stdout = null, code = 0, sleep = 0, stderr = '' } = {}) {
  const body = stdout ?? JSON.stringify(report);
  write(file, [
    'import json, sys, time',
    `time.sleep(${sleep})`,
    `out = ${JSON.stringify(body)}`,
    "out = out.replace('ARGV', ' '.join(sys.argv[1:]).replace('\\\\', '/'))",
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

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-assets-'));
    tools = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-audit-stub-'));
    config();
    const result = renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
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

  test('enabled through config: summary, top findings with fix hints, exit code unchanged', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    config('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`);
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
    // The audit ran read-only against the project root, as JSON.
    const realCwd = fs.realpathSync(cwd).replace(/\\/g, '/');
    const argv = /error lfs\.unhydrated-pointer: assets\/hero\.png — (.*)$/m.exec(r.stdout)[1];
    assert.match(argv, /^audit .+ --json$/);
    assert.ok(argv.includes(cwd.replace(/\\/g, '/')) || argv.includes(realCwd), argv);
  });

  test('the env override enables the check and wins over the configured script', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    config('doctor:', '  assetAudit:', '    script: ./does-not-exist.py');
    const r = runCli(['doctor'], cwd, { [ASSET_AUDIT_ENV]: script });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^asset audit: 1 error\(s\), 6 warning\(s\)/m);
  });

  test('strict with errors: doctor exits non-zero (config value and CLI flag)', needsPython, () => {
    const script = stubScript(path.join(tools, 'asset_audit.py'));
    config('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`, '    strict: true');
    const viaConfig = runCli(['doctor'], cwd);
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
    const r = doctor({ cwd, toolkitVersion: '0.0.test', assetAudit: { strict: true, env: { [ASSET_AUDIT_ENV]: script }, python: path.join(tools, 'no-python3') } });
    assert.equal(r.ok, true, 'strict cannot fail an audit that never ran');
    assert.equal(r.assetAudit.ran, false);
    assert.match(r.assetAudit.notes.join('\n'), /asset audit not run: .*no-python3 not found on PATH/);
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
    config('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`, '    timeoutSeconds: 1');
    const started = Date.now();
    const r = runCli(['doctor'], cwd);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /asset audit not run: timed out after 1s/);
    assert.ok(Date.now() - started < 20000, 'the timeout did not stop the audit');
  });

  test('settings problems are notes: misplaced under config:, unknown keys, bad values', () => {
    config('config:', '  doctor:', '    assetAudit:', '      script: x.py');
    let s = resolveAssetAuditSettings({ cwd, env: {} });
    assert.equal(s.enabled, false);
    assert.match(s.notes.join('\n'), /`config\.doctor\.assetAudit` .* is ignored/);

    config('doctor:', '  assetAudit:', '    script: ~/studios/asset_audit.py', '    strict: yes-please', '    timeoutSeconds: -1', '    scirpt: typo');
    s = resolveAssetAuditSettings({ cwd, env: {}, home: '/home/u' });
    assert.equal(s.enabled, true);
    assert.equal(s.script, path.join('/home/u', 'studios/asset_audit.py'));
    assert.equal(s.strict, false);
    assert.equal(s.timeoutMs, 120000);
    const text = s.notes.join('\n');
    assert.match(text, /unknown key\(s\) .* scirpt/);
    assert.match(text, /strict` must be true or false/);
    assert.match(text, /timeoutSeconds` must be a positive number/);

    config('doctor:', '  assetAudit:', '    script: tools/asset_audit.py');
    assert.equal(resolveAssetAuditSettings({ cwd, env: {} }).script, path.join(cwd, 'tools/asset_audit.py'));
  });

  test('report: asset counts in the health summary, never finding paths; absent when disabled', needsPython, () => {
    const collect = () => collectReport({ cwd, toolkitRoot: REPO_ROOT, toolkitVersion: '0.0.test' });
    const saved = process.env[ASSET_AUDIT_ENV];
    delete process.env[ASSET_AUDIT_ENV];
    try {
      const off = collect();
      assert.equal('assets' in off.health, false);
      assert.doesNotMatch(formatReportMarkdown(off), /asset audit/);

      const script = stubScript(path.join(tools, 'asset_audit.py'));
      config('doctor:', '  assetAudit:', `    script: ${JSON.stringify(script)}`);
      const on = collect();
      assert.deepEqual(
        { ran: on.health.assets.ran, errors: on.health.assets.errors, warnings: on.health.assets.warnings, info: on.health.assets.info },
        { ran: true, errors: 1, warnings: 6, info: 1 },
      );
      const text = JSON.stringify(on) + formatReportMarkdown(on);
      assert.match(formatReportMarkdown(on), /- \*\*asset audit\*\*: 1 error\(s\), 6 warning\(s\), 1 info \(advisory\)/);
      assert.doesNotMatch(text, /hero\.png|run-0\.log/, 'a finding path reached the report');
    } finally {
      if (saved === undefined) delete process.env[ASSET_AUDIT_ENV];
      else process.env[ASSET_AUDIT_ENV] = saved;
    }
  });
});
