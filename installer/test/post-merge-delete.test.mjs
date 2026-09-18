import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderProject } from '../lib/render.mjs';

// #212 — EXECUTED tests over the post-merge hook's branch-delete step: only a confirmed 404 on the
// confirmation probe may report "already gone"; any other probe failure lands in the warn path.

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HAS_BASH = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

// Stub gh: DELETE always fails (the double-fault premise); the GET probe replays $STATE/probe.
const GH_STUB = `#!/usr/bin/env bash
set -u
STATE="\${GH_STUB_STATE:?}"
printf '%s\\n' "$*" >> "$STATE/calls.log"
case "$*" in
  *"--method DELETE "*) echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1 ;;
  *"/git/ref/heads/"*) bash "$STATE/probe" ;;
  *) echo "gh-stub: unhandled: $*" >&2; exit 1 ;;
esac
`;

describe('post-merge hook: the branch-delete probe distinguishes a confirmed 404 from a failed check (#212)', { skip: !HAS_BASH ? 'bash is required to execute the workflow program' : false }, () => {
  let cwd;
  let stubDir;
  let deleteScript;

  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'post-merge-render-'));
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.waffle', 'waffle.yaml'),
      ['targets: [claude]', 'stacks: []', 'include:', '  - files/.github/workflows/waffle-post-merge-hook.yml', 'config:', '  project:', '    name: EvalFixture', ''].join('\n'),
    );
    const result = renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' });
    assert.ok(result.ok, `render failed: ${JSON.stringify(result.errors)}`);
    const wf = YAML.parse(fs.readFileSync(path.join(cwd, '.github', 'workflows', 'waffle-post-merge-hook.yml'), 'utf8'));
    const step = wf.jobs.cleanup.steps.find((s) => s.name === 'Delete the merged head branch');
    assert.ok(step && step.run, 'Delete the merged head branch run script not found');
    deleteScript = step.run;
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-merge-stub-'));
    fs.writeFileSync(path.join(stubDir, 'gh'), GH_STUB, { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  const runDelete = (probe) => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'post-merge-state-'));
    fs.writeFileSync(path.join(state, 'probe'), probe);
    fs.writeFileSync(path.join(state, 'step.sh'), deleteScript);
    const r = spawnSync('bash', [path.join(state, 'step.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        GH_STUB_STATE: state,
        GH_TOKEN: 'stub-token',
        GITHUB_REPOSITORY: 'octo/waffles',
        GITHUB_STEP_SUMMARY: path.join(state, 'summary.md'),
        BRANCH: 'feat/issue-212',
        PR_NUMBER: '212',
      },
    });
    const calls = fs.readFileSync(path.join(state, 'calls.log'), 'utf8');
    fs.rmSync(state, { recursive: true, force: true });
    return { ...r, calls };
  };

  test('a confirmed 404 on the probe reports "already gone" and exits 0', () => {
    const r = runDelete("echo 'gh: Not Found (HTTP 404)' >&2; exit 1\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /was already gone/);
    assert.doesNotMatch(r.stdout, /::warning/);
    assert.match(r.calls, /^api --method DELETE repos\/octo\/waffles\/git\/refs\/heads\/feat\/issue-212$/m);
    assert.match(r.calls, /^api repos\/octo\/waffles\/git\/ref\/heads\/feat\/issue-212$/m);
  });

  for (const [label, probe] of [
    ['a 5xx', "echo 'gh: Bad Gateway (HTTP 502)' >&2; exit 1\n"],
    ['a rate-limit 403', "echo 'gh: API rate limit exceeded (HTTP 403)' >&2; exit 1\n"],
    ['a network failure with no HTTP status', "echo 'gh: error connecting to api.github.com' >&2; exit 1\n"],
    ['a 404 mentioned only in the JSON body (stdout), not by gh', "echo '{\"message\":\"HTTP 404\"}'; exit 1\n"],
  ]) {
    test(`${label} on the probe is a failed check: the warn path fires, the run still exits 0`, () => {
      const r = runDelete(probe);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /::warning title=waffle-post-merge-hook::Could not delete remote branch 'feat\/issue-212'/);
      assert.doesNotMatch(r.stdout, /already gone/);
    });
  }

  test('a probe that finds the branch still present is the warn path', () => {
    const r = runDelete("echo '{\"ref\":\"refs/heads/feat/issue-212\"}'; exit 0\n");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::warning/);
    assert.doesNotMatch(r.stdout, /already gone/);
  });
});
