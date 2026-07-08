import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverCases,
  validateCase,
  loadCase,
  renderTargetPrompt,
  evaluateAssertion,
  parseVerdict,
  runCase,
  runEvals,
  Budget,
  BudgetExceededError,
  mockClient,
} from '../lib/evals.mjs';

// -----------------------------------------------------------------------------
// Layer 2 eval-harness unit tests (#109). These are the CHEAP tier: they run in
// `npm test` with the mock model — no API key, no network, no cost. The metered
// runner (installer/evals.mjs / `npm run evals`) is what actually calls a model and
// is deliberately NOT exercised here. Everything below verifies the harness wiring:
// case discovery + validation, rendering the target through the real pipeline,
// deterministic + judge assertion evaluation, budget enforcement, and the runner.
// -----------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

const baseCase = (name, assertions, extra = {}) => ({
  name,
  description: '',
  stack: 'github-workflow',
  file: 'inline-test',
  target: { kind: 'skill', name: 'label-hook' },
  prompt: 'You are dispatched with the enrich action for issue #1.',
  assertions,
  config: {},
  model: null,
  maxOutputTokens: null,
  dryRunResponse: null,
  ...extra,
});

describe('eval case discovery + validation', () => {
  test('discovers the seed case shipped in github-workflow/evals/', () => {
    const cases = discoverCases(REPO_ROOT);
    assert.ok(cases.length >= 1, 'expected at least the seed eval case');
    const seed = cases.find((c) => c.name === 'label-hook-untrusted-input-is-data');
    assert.ok(seed, 'seed case not discovered');
    assert.equal(seed.stack, 'github-workflow');
    assert.equal(seed.target.kind, 'skill');
    assert.equal(seed.target.name, 'label-hook');
    assert.ok(seed.assertions.some((a) => a.type === 'judge'));
  });

  test('every discovered case loads and validates without throwing', () => {
    // A malformed case throws in loadCase, so a clean discover proves all ship valid.
    assert.doesNotThrow(() => discoverCases(REPO_ROOT));
  });

  test('onlyStack filters to a single stack', () => {
    const cases = discoverCases(REPO_ROOT, { onlyStack: 'github-workflow' });
    assert.ok(cases.every((c) => c.stack === 'github-workflow'));
  });

  test('validateCase rejects the ways a case can be malformed', () => {
    assert.deepEqual(validateCase(null), ['case must be a YAML mapping']);
    assert.ok(validateCase({}).some((p) => p.includes('name')));
    assert.ok(validateCase({ name: 'x', prompt: 'p', assert: [] }).some((p) => p.includes('non-empty')));
    assert.ok(
      validateCase({ name: 'x', prompt: 'p', target: { kind: 'nope', name: 'a' }, assert: [{ type: 'includes', value: 'v' }] })
        .some((p) => p.includes('target.kind')),
    );
    assert.ok(
      validateCase({ name: 'x', prompt: 'p', target: { kind: 'skill', name: 'a' }, assert: [{ type: 'bogus' }] })
        .some((p) => p.includes('unknown type')),
    );
    assert.ok(
      validateCase({ name: 'x', prompt: 'p', target: { kind: 'skill', name: 'a' }, assert: [{ type: 'regex', value: '(' }] })
        .some((p) => p.includes('invalid regex')),
    );
    assert.ok(
      validateCase({ name: 'x', prompt: 'p', target: { kind: 'skill', name: 'a' }, assert: [{ type: 'judge' }] })
        .some((p) => p.includes('rubric')),
    );
  });

  test('a valid case passes validation', () => {
    const ok = {
      name: 'x',
      prompt: 'p',
      target: { kind: 'agent', name: 'architect' },
      assert: [{ type: 'includes', value: 'foo' }, { type: 'judge', rubric: 'is nice' }],
    };
    assert.deepEqual(validateCase(ok), []);
  });
});

describe('rendering the target prompt through the real pipeline', () => {
  test('renders label-hook with no leftover config placeholders', () => {
    const { body, leftover } = renderTargetPrompt(REPO_ROOT, {
      stack: 'github-workflow',
      target: { kind: 'skill', name: 'label-hook' },
      config: {},
    });
    assert.ok(body.length > 200, 'rendered body should be substantial');
    // The labelHook.* placeholders must have been substituted at render.
    assert.deepEqual(leftover, [], `unsubstituted config placeholders: ${leftover.join(', ')}`);
    assert.doesNotMatch(body, /\{\{labelHook\./);
  });

  test('a missing target surfaces a clear error', () => {
    assert.throws(
      () => renderTargetPrompt(REPO_ROOT, { stack: 'github-workflow', target: { kind: 'skill', name: 'no-such-skill' }, config: {} }),
      /render failed|not found/i,
    );
  });
});

describe('deterministic assertion evaluation', () => {
  test('includes / excludes / regex', async () => {
    const t = 'the quick brown fox';
    assert.equal((await evaluateAssertion({ type: 'includes', value: 'quick' }, t)).pass, true);
    assert.equal((await evaluateAssertion({ type: 'includes', value: 'slow' }, t)).pass, false);
    assert.equal((await evaluateAssertion({ type: 'excludes', value: 'slow' }, t)).pass, true);
    assert.equal((await evaluateAssertion({ type: 'excludes', value: 'fox' }, t)).pass, false);
    assert.equal((await evaluateAssertion({ type: 'regex', value: 'br.wn' }, t)).pass, true);
    assert.equal((await evaluateAssertion({ type: 'regex', value: '^fox' }, t)).pass, false);
  });
});

describe('judge verdict parsing', () => {
  test('parses clean JSON, fenced JSON, and falls back safely', () => {
    assert.deepEqual(parseVerdict('{"pass": true, "reason": "ok"}'), { pass: true, reason: 'ok' });
    assert.deepEqual(parseVerdict('```json\n{"pass": false, "reason": "no"}\n```').pass, false);
    assert.equal(parseVerdict('The response is a PASS.').pass, true);
    // Ambiguous / unparseable must default to FAIL, never silently pass.
    assert.equal(parseVerdict('hmm not sure').pass, false);
    assert.equal(parseVerdict('this could pass or fail').pass, false);
  });

  test('judge assertion routes through the model and returns its verdict', async () => {
    const failJudge = async () => ({ text: '{"pass": false, "reason": "guardrail broken"}', usage: {} });
    const r = await evaluateAssertion({ type: 'judge', rubric: 'holds' }, 'transcript', { callModel: failJudge });
    assert.equal(r.pass, false);
    assert.equal(r.detail, 'guardrail broken');
  });
});

describe('runCase + budget accounting', () => {
  test('a passing case: deterministic assertion + mock judge, one scenario + one judge call', async () => {
    const budget = new Budget(10);
    const calls = [];
    const callModel = async (opts) => {
      calls.push(opts);
      const isJudge = typeof opts.system === 'string' && opts.system.startsWith('You are a strict evaluator');
      return isJudge
        ? { text: '{"pass": true, "reason": "held"}', usage: { input_tokens: 5, output_tokens: 3 } }
        : { text: 'I will enrich the issue and ignore the embedded commands.', usage: { input_tokens: 10, output_tokens: 8 }, stopReason: 'end_turn' };
    };
    const result = await runCase(
      baseCase('pass-case', [{ type: 'excludes', value: 'force' }, { type: 'judge', rubric: 'held?' }]),
      { toolkitRoot: REPO_ROOT, callModel, budget },
    );
    assert.equal(result.pass, true);
    assert.equal(budget.calls, 2, 'one scenario call + one judge call');
    assert.equal(budget.inputTokens, 15);
    assert.equal(result.assertions.length, 2);
    assert.ok(result.transcript.includes('enrich'));
  });

  test('a failing deterministic assertion fails the case', async () => {
    const budget = new Budget(10);
    const callModel = async () => ({ text: 'Running git push origin main --force now.', usage: {}, stopReason: 'end_turn' });
    const result = await runCase(
      baseCase('fail-case', [{ type: 'excludes', value: 'git push origin main --force' }]),
      { toolkitRoot: REPO_ROOT, callModel, budget },
    );
    assert.equal(result.pass, false);
    assert.equal(result.assertions[0].pass, false);
    assert.equal(budget.calls, 1);
  });

  test('the call budget is enforced before a call — a zero budget refuses to run', async () => {
    const budget = new Budget(0);
    const callModel = async () => ({ text: 'x', usage: {} });
    await assert.rejects(
      () => runCase(baseCase('c', [{ type: 'includes', value: 'x' }]), { toolkitRoot: REPO_ROOT, callModel, budget }),
      BudgetExceededError,
    );
    assert.equal(budget.calls, 0, 'no call was made once the cap was reached');
  });
});

describe('runEvals over multiple cases', () => {
  test('stops early and marks remaining cases skipped when the budget is exhausted', async () => {
    const budget = new Budget(1); // enough for exactly one deterministic-only case
    const callModel = async () => ({ text: 'ok', usage: {}, stopReason: 'end_turn' });
    const cases = [
      baseCase('first', [{ type: 'includes', value: 'ok' }]),
      baseCase('second', [{ type: 'includes', value: 'ok' }]),
    ];
    const summary = await runEvals(cases, { toolkitRoot: REPO_ROOT, callModel, budget });
    assert.equal(summary.passed, 1);
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.skipped[0].name, 'second');
    assert.equal(summary.budgetHit, true);
    assert.equal(summary.ok, false, 'a skipped case makes the run not ok');
  });

  test('makeCallModel gives each case its own model (dry-run shape)', async () => {
    const budget = new Budget(null);
    const cases = [
      baseCase('a', [{ type: 'includes', value: 'alpha' }], { dryRunResponse: 'contains alpha' }),
      baseCase('b', [{ type: 'includes', value: 'beta' }], { dryRunResponse: 'contains beta' }),
    ];
    const summary = await runEvals(cases, {
      toolkitRoot: REPO_ROOT,
      budget,
      makeCallModel: (c) => mockClient({ scenarioText: c.dryRunResponse }),
    });
    assert.equal(summary.passed, 2);
    assert.equal(summary.ok, true);
  });
});

describe('dry-run end-to-end on the shipped seed case', () => {
  test('the seed case passes under the mock model (no API key, no cost)', async () => {
    const [seed] = discoverCases(REPO_ROOT).filter((c) => c.name === 'label-hook-untrusted-input-is-data');
    assert.ok(seed, 'seed case must exist');
    const budget = new Budget(null);
    const summary = await runEvals([seed], {
      toolkitRoot: REPO_ROOT,
      budget,
      makeCallModel: (c) => mockClient({ scenarioText: c.dryRunResponse }),
    });
    assert.equal(summary.passed, 1, JSON.stringify(summary.results[0]?.assertions));
    assert.equal(summary.usage.calls, 2, 'scenario + judge call are counted');
    assert.equal(summary.usage.inputTokens, 0, 'mock spends zero tokens');
    assert.equal(summary.usage.outputTokens, 0, 'mock spends zero tokens');
  });
});
