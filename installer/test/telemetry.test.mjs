import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderProject } from '../lib/render.mjs';

// -----------------------------------------------------------------------------
// #227 (QA follow-up) — EXECUTED tests over the token-spend telemetry programs.
//
// content.test.mjs pins the steps' presence and shape; these run the load-bearing
// jq/bash programs themselves, so a broken accumulation merge, comma/USD renderer,
// or counter math fails CI instead of shipping green behind intact prose. Method:
// render the workflows through the installer's own pipeline (the exact form a
// consumer commits), YAML-parse the rendered file, extract the step's `run` script,
// and execute it with bash against fixture execution logs and a stubbed `gh` on
// PATH that serves canned API responses and records every write payload.
//
// The suite needs bash + jq (the programs' own runtime). jq is a documented
// prerequisite of these workflows but only `recommend`-level for the toolkit, so
// the suite skips — loudly, not silently green — where jq is unavailable.
// -----------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HAS_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
const HAS_BASH = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

// The stub gh: pattern-matches the endpoint each call targets, serves fixtures from
// the per-test state dir, and copies every --input payload aside for assertions.
// Unhandled endpoints fail loudly so a script change cannot silently no-op the test.
const GH_STUB = `#!/usr/bin/env bash
set -u
STATE="\${GH_STUB_STATE:?}"
printf '%s\\n' "$*" >> "$STATE/calls.log"
url=""; method=GET; input=""; jqf=""
prev=""
for a in "$@"; do
  case "$prev" in
    --method) method="$a" ;;
    --input) input="$a" ;;
    --jq) jqf="$a" ;;
  esac
  case "$a" in
    repos/*) url="$a" ;;
  esac
  prev="$a"
done
case "$method $url" in
  "GET "*"/issues/"*"/comments") cat "$STATE/comments.json" 2>/dev/null || echo '[]' ;;
  "PATCH "*"/issues/comments/"*) cp "$input" "$STATE/patch-body.json"; printf '%s\\n' "$url" > "$STATE/patch-url.txt"; echo '{}' ;;
  "POST "*"/issues/"*"/comments") cp "$input" "$STATE/post-body.json"; printf '%s\\n' "$url" > "$STATE/post-url.txt"; echo '{}' ;;
  "GET "*"/git/ref/heads/"*) if [ -f "$STATE/ref-exists" ]; then echo '{"object":{"sha":"seedsha"}}'; else exit 1; fi ;;
  "POST "*"/git/blobs") cp "$input" "$STATE/blob-body.json"; if [ "$jqf" = ".sha" ]; then echo "blobsha"; else echo '{"sha":"blobsha"}'; fi ;;
  "POST "*"/git/trees") cp "$input" "$STATE/tree-body.json"; if [ "$jqf" = ".sha" ]; then echo "treesha"; else echo '{"sha":"treesha"}'; fi ;;
  "POST "*"/git/commits") cp "$input" "$STATE/commit-body.json"; if [ "$jqf" = ".sha" ]; then echo "commitsha"; else echo '{"sha":"commitsha"}'; fi ;;
  "POST "*"/git/refs") cp "$input" "$STATE/ref-body.json"; touch "$STATE/ref-exists"; echo '{}' ;;
  "GET "*"/contents/"*) cat "$STATE/contents-response.json" 2>/dev/null || exit 1 ;;
  "PUT "*"/contents/"*) if [ -f "$STATE/put-fail" ]; then exit 1; fi; cp "$input" "$STATE/put-body.json"; echo '{}' ;;
  *) echo "gh-stub: unhandled: $method $url" >&2; exit 1 ;;
esac
`;

describe('token spend telemetry: the embedded programs execute correctly (#227)', { skip: !HAS_JQ || !HAS_BASH ? 'bash + jq are required to execute the workflow programs' : false }, () => {
  let cwd; // rendered consumer fixture
  let stubDir; // stubbed gh + sleep on PATH
  let recordScript; // pr-green's "Record token spend" run script
  let hygieneScript; // hygiene's variant — target resolved from the result's PR URL
  let implementScript; // label-hook implement's variant — PR URL with fallback to the issue
  let counterScript; // post-merge's "Update global token counter" run script

  const stepRun = (file, jobName, stepName) => {
    const wf = YAML.parse(fs.readFileSync(path.join(cwd, '.github', 'workflows', file), 'utf8'));
    const step = (wf.jobs[jobName].steps || []).find((s) => s.name === stepName);
    assert.ok(step && step.run, `${stepName} run script not found in ${file}`);
    return step.run;
  };

  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-render-'));
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.waffle', 'waffle.yaml'),
      [
        'targets: [claude]',
        'stacks: []',
        'include:',
        '  - files/.github/workflows/waffle-pr-green-hook.yml',
        '  - files/.github/workflows/waffle-hygiene.yml',
        '  - files/.github/workflows/waffle-label-hook.yml',
        '  - files/.github/workflows/waffle-post-merge-hook.yml',
        'config:',
        '  project:',
        '    name: EvalFixture',
        '',
      ].join('\n'),
    );
    const result = renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' });
    assert.ok(result.ok, `render failed: ${JSON.stringify(result.errors)}`);
    recordScript = stepRun('waffle-pr-green-hook.yml', 'adversarial-review', 'Record token spend');
    hygieneScript = stepRun('waffle-hygiene.yml', 'hygiene', 'Record token spend');
    implementScript = stepRun('waffle-label-hook.yml', 'implement', 'Record token spend');
    counterScript = stepRun('waffle-post-merge-hook.yml', 'cleanup', 'Update global token counter');

    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-stub-'));
    fs.writeFileSync(path.join(stubDir, 'gh'), GH_STUB, { mode: 0o755 });
    // Instant sleep so a retry loop entered by mistake cannot stall the suite.
    fs.writeFileSync(path.join(stubDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  });

  after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  const mkState = () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-state-'));
    fs.mkdirSync(path.join(state, 'runner-temp'), { recursive: true });
    return state;
  };

  const runStep = (script, state, extraEnv) => {
    const scriptFile = path.join(state, 'step.sh');
    fs.writeFileSync(scriptFile, script);
    return spawnSync('bash', [scriptFile], {
      encoding: 'utf8',
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        GH_STUB_STATE: state,
        GH_TOKEN: 'stub-token',
        GITHUB_REPOSITORY: 'octo/waffles',
        RUNNER_TEMP: path.join(state, 'runner-temp'),
        GITHUB_STEP_SUMMARY: path.join(state, 'summary.md'),
        ...extraEnv,
      },
    });
  };

  // A representative execution log: the final `result` message is what the step reads.
  const writeLog = (state, { turns = 5, cost, in: inTok, out, cacheRead = 0, finalText = 'done' }) => {
    const file = path.join(state, 'execution-output.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        { type: 'system', subtype: 'init' },
        {
          type: 'result',
          num_turns: turns,
          duration_ms: 1234,
          total_cost_usd: cost,
          result: finalText,
          usage: {
            input_tokens: inTok,
            output_tokens: out,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cacheRead,
          },
        },
      ]),
    );
    return file;
  };

  const parseDataLine = (body) => {
    const line = body.split('\n').find((l) => l.startsWith('<!-- waffle-token-data '));
    assert.ok(line, 'waffle-token-data line missing from the comment body');
    return JSON.parse(line.replace('<!-- waffle-token-data ', '').replace(/ -->\s*$/, ''));
  };

  const readBody = (state, which) =>
    JSON.parse(fs.readFileSync(path.join(state, which), 'utf8')).body;

  // Drives one Record-token-spend execution (pr-green variant: target from TARGET_PR).
  const record = (state, { runKey, log, comments }) => {
    fs.writeFileSync(path.join(state, 'comments.json'), JSON.stringify(comments));
    return runStep(recordScript, state, {
      EXECUTION_FILE: log,
      HOOK: 'review',
      RUN_KEY: runKey,
      RUN_URL: `https://example.test/runs/${runKey}`,
      TARGET_PR: '42',
    });
  };

  const RUN_A = { in: 41230, out: 9812, cacheRead: 1204551, cost: 0.834, turns: 24 };
  const RUN_B = { in: 100, out: 50, cacheRead: 2000, cost: 0.1, turns: 3 };

  test('a first run POSTs the marker comment: correct row, comma grouping, USD rendering', () => {
    const state = mkState();
    const res = record(state, { runKey: '100.1', log: writeLog(state, RUN_A), comments: [] });
    assert.equal(res.status, 0, res.stderr);
    const body = readBody(state, 'post-body.json');
    assert.ok(body.startsWith('<!-- waffle-token-count -->'), 'marker must lead the body');
    const data = parseDataLine(body);
    assert.deepEqual(Object.keys(data.runs), ['100.1']);
    assert.equal(data.runs['100.1'].in, 41230);
    assert.equal(data.runs['100.1'].out, 9812);
    assert.equal(data.runs['100.1'].cacheRead, 1204551);
    assert.equal(data.runs['100.1'].costUsd, 0.834);
    assert.equal(data.runs['100.1'].hook, 'review');
    // The rendered table: comma grouping and 2-decimal USD.
    assert.match(body, /\| \[100\.1\]\(https:\/\/example\.test\/runs\/100\.1\) \| review \| 24 \| 41,230 \| 9,812 \| 1,204,551 \| \$0\.83 \|/);
    assert.match(body, /\| \*\*total\*\* \| \| \| \*\*41,230\*\* \| \*\*9,812\*\* \| \*\*1,204,551\*\* \| \*\*\$0\.83\*\* \|/);
    // Marker-collision guard holds on the EMITTED body, not just the template text.
    assert.ok(!body.includes('waffle-pr-response'));
    assert.ok(!body.includes('waffle-adversarial-review'));
  });

  test('a second run PATCHes the same comment, appends its row, and recomputes totals', () => {
    const state = mkState();
    record(state, { runKey: '100.1', log: writeLog(state, RUN_A), comments: [] });
    const first = readBody(state, 'post-body.json');
    const res = record(state, {
      runKey: '200.1',
      log: writeLog(state, RUN_B),
      comments: [{ id: 7, body: first }],
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(state, 'patch-body.json')), 'expected a PATCH');
    assert.match(fs.readFileSync(path.join(state, 'patch-url.txt'), 'utf8'), /issues\/comments\/7/);
    const body = readBody(state, 'patch-body.json');
    const data = parseDataLine(body);
    assert.deepEqual(Object.keys(data.runs).sort(), ['100.1', '200.1']);
    // Totals are recomputed from the FULL map: 41230+100 / 9812+50 / 1204551+2000 / .834+.1
    assert.match(body, /\| \*\*total\*\* \| \| \| \*\*41,330\*\* \| \*\*9,862\*\* \| \*\*1,206,551\*\* \| \*\*\$0\.93\*\* \|/);
  });

  test('re-recording the same run key replaces its row — never a double count', () => {
    const state = mkState();
    record(state, { runKey: '100.1', log: writeLog(state, RUN_A), comments: [] });
    const first = readBody(state, 'post-body.json');
    record(state, { runKey: '200.1', log: writeLog(state, RUN_B), comments: [{ id: 7, body: first }] });
    const second = readBody(state, 'patch-body.json');
    // A step retry of run 200 reports different numbers; its row must be REPLACED.
    const res = record(state, {
      runKey: '200.1',
      log: writeLog(state, { in: 200, out: 100, cacheRead: 4000, cost: 0.2, turns: 4 }),
      comments: [{ id: 7, body: second }],
    });
    assert.equal(res.status, 0, res.stderr);
    const data = parseDataLine(readBody(state, 'patch-body.json'));
    assert.deepEqual(Object.keys(data.runs).sort(), ['100.1', '200.1']);
    assert.equal(data.runs['200.1'].in, 200);
    assert.equal(data.runs['200.1'].costUsd, 0.2);
    const body = readBody(state, 'patch-body.json');
    assert.match(body, /\| \*\*total\*\* \| \| \| \*\*41,430\*\* \| \*\*9,912\*\* \| \*\*1,208,551\*\* \| \*\*\$1\.03\*\* \|/);
  });

  test('zero usage, a missing log, and a result-less log all exit 0 without an API write', () => {
    for (const log of [
      (state) => writeLog(state, { in: 0, out: 0, cost: 0 }),
      (state) => path.join(state, 'no-such-log.json'),
      (state) => {
        const f = path.join(state, 'execution-output.json');
        fs.writeFileSync(f, '[{"type":"system"}]');
        return f;
      },
    ]) {
      const state = mkState();
      const res = record(state, { runKey: '9.1', log: log(state), comments: [] });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(!fs.existsSync(path.join(state, 'post-body.json')), 'must not POST');
      assert.ok(!fs.existsSync(path.join(state, 'patch-body.json')), 'must not PATCH');
    }
  });

  // ---- target resolution: the hygiene / implement variants --------------------
  // pr-green's target arrives pre-resolved via TARGET_PR; these two resolve it from
  // the result's final text — a PR URL grep SCOPED TO THIS REPO (a cross-repo link
  // must never redirect the comment), with implement falling back to the labeled
  // issue. Executed here so the scoping can't be silently dropped.

  const recordVariant = (script, state, { runKey, log, comments, extraEnv = {} }) => {
    fs.writeFileSync(path.join(state, 'comments.json'), JSON.stringify(comments));
    return runStep(script, state, {
      EXECUTION_FILE: log,
      RUN_KEY: runKey,
      RUN_URL: `https://example.test/runs/${runKey}`,
      ...extraEnv,
    });
  };

  test('hygiene targets the same-repo PR URL in the result text', () => {
    const state = mkState();
    const res = recordVariant(hygieneScript, state, {
      runKey: '300.1',
      log: writeLog(state, { ...RUN_A, finalText: 'Opened https://github.com/octo/waffles/pull/55 (auto-merge armed).' }),
      comments: [],
      extraEnv: { HOOK: 'hygiene' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(fs.readFileSync(path.join(state, 'post-url.txt'), 'utf8'), /issues\/55\/comments/);
    assert.equal(parseDataLine(readBody(state, 'post-body.json')).runs['300.1'].hook, 'hygiene');
  });

  test('hygiene skips on a cross-repo-only PR URL and on no URL at all', () => {
    for (const finalText of [
      'Reviewed https://github.com/other/repo/pull/9 upstream.', // cross-repo: must NOT redirect
      'No drift found; nothing to do.', // no PR opened
    ]) {
      const state = mkState();
      const res = recordVariant(hygieneScript, state, {
        runKey: '301.1',
        log: writeLog(state, { ...RUN_A, finalText }),
        comments: [],
        extraEnv: { HOOK: 'hygiene' },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(!fs.existsSync(path.join(state, 'post-body.json')), `must not POST for: ${finalText}`);
      assert.ok(!fs.existsSync(path.join(state, 'patch-body.json')), `must not PATCH for: ${finalText}`);
      assert.match(fs.readFileSync(path.join(state, 'summary.md'), 'utf8'), /no PR URL/);
    }
  });

  test('implement prefers the same-repo PR URL and falls back to the labeled issue', () => {
    // URL present ⇒ the PR wins over the issue fallback.
    let state = mkState();
    let res = recordVariant(implementScript, state, {
      runKey: '400.1',
      log: writeLog(state, { ...RUN_A, finalText: 'PR: https://github.com/octo/waffles/pull/88' }),
      comments: [],
      extraEnv: { HOOK: 'implement', TARGET_ISSUE: '77' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(fs.readFileSync(path.join(state, 'post-url.txt'), 'utf8'), /issues\/88\/comments/);
    // No same-repo URL (cross-repo only) ⇒ the labeled issue.
    state = mkState();
    res = recordVariant(implementScript, state, {
      runKey: '401.1',
      log: writeLog(state, { ...RUN_A, finalText: 'Blocked; see https://github.com/other/repo/pull/9.' }),
      comments: [],
      extraEnv: { HOOK: 'implement', TARGET_ISSUE: '77' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(fs.readFileSync(path.join(state, 'post-url.txt'), 'utf8'), /issues\/77\/comments/);
    assert.equal(parseDataLine(readBody(state, 'post-body.json')).runs['401.1'].hook, 'implement');
  });

  // ---- the post-merge counter ------------------------------------------------

  const SEED = {
    schemaVersion: 1,
    label: 'claude tokens',
    message: '0',
    color: 'F08A1D',
    labelColor: '241204',
    waffle: { totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCostUsd: 0, prs: {}, updatedAt: '' },
  };

  const counterState = ({ comments, tokens, refExists = true }) => {
    const state = mkState();
    fs.writeFileSync(path.join(state, 'comments.json'), JSON.stringify(comments));
    if (tokens) {
      fs.writeFileSync(
        path.join(state, 'contents-response.json'),
        JSON.stringify({ sha: 's1', content: Buffer.from(JSON.stringify(tokens)).toString('base64') }),
      );
    }
    if (refExists) fs.writeFileSync(path.join(state, 'ref-exists'), '');
    return state;
  };

  const prComment = (state) => {
    // Produce a real accumulated comment body by driving the record step twice.
    record(state, { runKey: '100.1', log: writeLog(state, RUN_A), comments: [] });
    const first = readBody(state, 'post-body.json');
    record(state, { runKey: '200.1', log: writeLog(state, RUN_B), comments: [{ id: 7, body: first }] });
    return readBody(state, 'patch-body.json');
  };

  test('first tick: sums the data line into the counter, records the PR, humanizes the message', () => {
    const scratch = mkState();
    const body = prComment(scratch);
    const state = counterState({ comments: [{ id: 7, body }], tokens: SEED });
    const res = runStep(counterScript, state, { PR_NUMBER: '42' });
    assert.equal(res.status, 0, res.stderr);
    const put = JSON.parse(fs.readFileSync(path.join(state, 'put-body.json'), 'utf8'));
    assert.equal(put.branch, 'waffle-telemetry');
    assert.equal(put.sha, 's1'); // sha-conditional PUT — the optimistic-concurrency handle
    assert.match(put.message, /\+51192 tokens for PR #42/);
    const updated = JSON.parse(Buffer.from(put.content, 'base64').toString('utf8'));
    assert.equal(updated.schemaVersion, 1);
    assert.equal(updated.waffle.inputTokens, 41330);
    assert.equal(updated.waffle.outputTokens, 9862);
    assert.equal(updated.waffle.totalTokens, 51192); // input + output; cache reads excluded
    assert.equal(updated.waffle.totalCostUsd, 0.93);
    assert.deepEqual(updated.waffle.prs['42'], { tokens: 51192, costUsd: 0.93 });
    assert.equal(updated.message, '51.1k'); // shields message = humanized total
  });

  test('an already-recorded PR short-circuits — an idempotent re-run never double-counts', () => {
    const scratch = mkState();
    const body = prComment(scratch);
    const tokens = structuredClone(SEED);
    tokens.waffle.prs['42'] = { tokens: 51192, costUsd: 0.93 };
    const state = counterState({ comments: [{ id: 7, body }], tokens });
    const res = runStep(counterScript, state, { PR_NUMBER: '42' });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(path.join(state, 'put-body.json')), 'must not PUT twice for one PR');
    assert.match(fs.readFileSync(path.join(state, 'summary.md'), 'utf8'), /already in the global token counter/);
  });

  test('a zero-spend merge still bootstraps the orphan branch, then adds nothing', () => {
    const state = counterState({ comments: [], tokens: SEED, refExists: false });
    const res = runStep(counterScript, state, { PR_NUMBER: '43' });
    assert.equal(res.status, 0, res.stderr);
    // Orphan bootstrap: blob → tree (right path) → parentless commit → telemetry ref.
    const blob = JSON.parse(fs.readFileSync(path.join(state, 'blob-body.json'), 'utf8'));
    const seeded = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
    assert.equal(seeded.schemaVersion, 1);
    assert.equal(seeded.message, '0');
    assert.ok(seeded.waffle.updatedAt.length > 0);
    const tree = JSON.parse(fs.readFileSync(path.join(state, 'tree-body.json'), 'utf8'));
    assert.equal(tree.tree[0].path, '.waffle/telemetry/tokens.json');
    const commit = JSON.parse(fs.readFileSync(path.join(state, 'commit-body.json'), 'utf8'));
    assert.deepEqual(commit.parents, []);
    const ref = JSON.parse(fs.readFileSync(path.join(state, 'ref-body.json'), 'utf8'));
    assert.equal(ref.ref, 'refs/heads/waffle-telemetry');
    // Zero recorded spend ⇒ no counter write.
    assert.ok(!fs.existsSync(path.join(state, 'put-body.json')), 'zero spend must not PUT');
  });
});
