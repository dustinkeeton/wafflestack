import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readYaml, parseFrontmatter, exists, deepMerge } from './util.mjs';
import { placeholderKeys } from './template.mjs';
import { renderProject } from './render.mjs';

// -----------------------------------------------------------------------------
// Layer 2 eval harness — the metered, LLM-driven tier. Cases live next to their
// stack at `stacks/<stack>/evals/*.eval.yaml`; the format is in schema/FORMAT.md.
// -----------------------------------------------------------------------------

const CASE_SUFFIX = '.eval.yaml';
const CASE_SUFFIX_YML = '.eval.yml';
const ASSERTION_TYPES = new Set(['includes', 'excludes', 'regex', 'judge']);
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// A stand-in project config so a target renders without the author enumerating every
// transitively-required key; a case's own `config:` is deep-merged over it and wins.
const DEFAULT_EVAL_CONFIG = { project: { name: 'EvalProject' } };

/** A run's metered budget: a hard cap on model calls, enforced BEFORE each call. `null` = unbounded. */
export class Budget {
  constructor(maxCalls = null) {
    this.maxCalls = maxCalls;
    this.calls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
  }

  /** True if another model call is allowed under the cap. */
  canSpend() {
    return this.maxCalls == null || this.calls < this.maxCalls;
  }

  remaining() {
    return this.maxCalls == null ? Infinity : Math.max(0, this.maxCalls - this.calls);
  }

  /** Record a completed call's usage. Call exactly once per model call. */
  record(usage) {
    this.calls += 1;
    this.inputTokens += usage?.input_tokens ?? 0;
    this.outputTokens += usage?.output_tokens ?? 0;
  }
}

/** Thrown when a model call would exceed the run's call budget. */
export class BudgetExceededError extends Error {
  constructor(maxCalls) {
    super(`eval run hit its call budget (${maxCalls}) — raise --max-calls to run more cases`);
    this.name = 'BudgetExceededError';
    this.maxCalls = maxCalls;
  }
}

// -----------------------------------------------------------------------------
// Case discovery + loading
// -----------------------------------------------------------------------------

/** Recursively collect `*.eval.yaml` files under a directory. */
function collectCaseFiles(dir) {
  if (!exists(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? dir, entry.name);
    if (entry.isDirectory()) out.push(...collectCaseFiles(full));
    else if (entry.name.endsWith(CASE_SUFFIX) || entry.name.endsWith(CASE_SUFFIX_YML)) out.push(full);
  }
  return out;
}

/** Discover every eval case (`stacks/<stack>/evals/**\/*.eval.yaml`), loaded and sorted by (stack, name). */
export function discoverCases(toolkitRoot, { onlyStack = null } = {}) {
  const stacksDir = path.join(toolkitRoot, 'stacks');
  if (!exists(stacksDir)) return [];
  const cases = [];
  for (const entry of fs.readdirSync(stacksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stackName = entry.name;
    if (onlyStack && stackName !== onlyStack) continue;
    const evalsDir = path.join(stacksDir, stackName, 'evals');
    for (const file of collectCaseFiles(evalsDir)) {
      cases.push(loadCase(file, stackName));
    }
  }
  return cases.sort((a, b) => a.stack.localeCompare(b.stack) || a.name.localeCompare(b.name));
}

/** Parse and validate a single case file. Throws on a malformed case. */
export function loadCase(file, stackName) {
  let raw;
  try {
    raw = readYaml(file);
  } catch (err) {
    throw new Error(`eval case ${file}: not valid YAML — ${err.message}`);
  }
  const problems = validateCase(raw);
  if (problems.length) {
    throw new Error(`eval case ${file}: ${problems.join('; ')}`);
  }
  return {
    name: String(raw.name),
    description: raw.description ? String(raw.description) : '',
    stack: stackName,
    file,
    target: { kind: raw.target.kind, name: String(raw.target.name) },
    prompt: String(raw.prompt),
    assertions: raw.assert.map(normalizeAssertion),
    config: raw.config ?? {},
    model: raw.model ? String(raw.model) : null,
    maxOutputTokens: raw.maxOutputTokens ?? null,
    dryRunResponse: raw.dryRunResponse != null ? String(raw.dryRunResponse) : null,
  };
}

/** Structural validation of a raw case object. Returns a list of problems. */
export function validateCase(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return ['case must be a YAML mapping'];
  if (!raw.name || typeof raw.name !== 'string') problems.push('missing string `name`');
  if (!raw.prompt || typeof raw.prompt !== 'string') problems.push('missing string `prompt`');
  if (!raw.target || typeof raw.target !== 'object') {
    problems.push('missing `target` mapping ({ kind, name })');
  } else {
    if (raw.target.kind !== 'skill' && raw.target.kind !== 'agent') {
      problems.push('`target.kind` must be "skill" or "agent"');
    }
    if (!raw.target.name || typeof raw.target.name !== 'string') problems.push('missing `target.name`');
  }
  if (!Array.isArray(raw.assert) || raw.assert.length === 0) {
    problems.push('`assert` must be a non-empty list');
  } else {
    raw.assert.forEach((a, i) => problems.push(...validateAssertion(a, i).map((p) => `assert[${i}]: ${p}`)));
  }
  if (raw.config != null && (typeof raw.config !== 'object' || Array.isArray(raw.config))) {
    problems.push('`config` must be a mapping');
  }
  return problems;
}

function validateAssertion(a, _i) {
  const problems = [];
  if (!a || typeof a !== 'object') return ['assertion must be a mapping'];
  if (!ASSERTION_TYPES.has(a.type)) {
    problems.push(`unknown type "${a.type}" (expected ${[...ASSERTION_TYPES].join(' | ')})`);
    return problems;
  }
  if (a.type === 'judge') {
    if (!a.rubric || typeof a.rubric !== 'string') problems.push('judge assertion needs a string `rubric`');
  } else if (!a.value || typeof a.value !== 'string') {
    problems.push(`${a.type} assertion needs a string \`value\``);
  } else if (a.type === 'regex') {
    try {
      new RegExp(a.value);
    } catch (err) {
      problems.push(`invalid regex: ${err.message}`);
    }
  }
  return problems;
}

function normalizeAssertion(a) {
  if (a.type === 'judge') return { type: 'judge', rubric: String(a.rubric) };
  return { type: a.type, value: String(a.value) };
}

// -----------------------------------------------------------------------------
// Rendering the target prompt through the real render pipeline
// -----------------------------------------------------------------------------

/** Render a case's target through the REAL render pipeline, so an eval asserts the artifact a consumer installs. */
export function renderTargetPrompt(toolkitRoot, { stack, target, config = {} }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-eval-'));
  try {
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    const waffleYaml = {
      targets: ['claude'],
      stacks: [],
      include: [`${stack}/${target.kind}s/${target.name}`],
      config: deepMerge(DEFAULT_EVAL_CONFIG, config ?? {}),
    };
    fs.writeFileSync(path.join(cwd, '.waffle', 'waffle.yaml'), yamlDump(waffleYaml));
    const result = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.eval' });
    if (!result.ok) {
      throw new Error(`render failed: ${result.errors.join('; ')}`);
    }
    const rel =
      target.kind === 'skill'
        ? path.join('.claude', 'skills', target.name, 'SKILL.md')
        : path.join('.claude', 'agents', `${target.name}.md`);
    const abs = path.join(cwd, rel);
    if (!exists(abs)) {
      throw new Error(`rendered file not found: ${rel} — is ${target.kind}/${target.name} in stack "${stack}"?`);
    }
    const rendered = fs.readFileSync(abs, 'utf8');
    const { data, body } = parseFrontmatter(rendered);
    // Sanity: a load-bearing config key that survived unsubstituted is an authoring bug.
    const leftover = [...placeholderKeys(body)].filter((k) => k.includes('.') && /^[a-z]/.test(k));
    return { body, description: data.description ?? '', rendered, leftover };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// Minimal YAML emitter for the tiny waffle.yaml we write — only the shapes we
// produce (scalars, string arrays, nested maps), never a general-purpose dumper.
function yamlDump(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${pad}${key}: []`);
      else {
        lines.push(`${pad}${key}:`);
        for (const item of value) lines.push(`${pad}  - ${yamlScalar(item)}`);
      }
    } else if (value && typeof value === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(yamlDump(value, indent + 1));
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join('\n');
}

function yamlScalar(v) {
  if (typeof v === 'string') return JSON.stringify(v); // quote to be safe with any chars
  return String(v);
}

// -----------------------------------------------------------------------------
// Assertion evaluation
// -----------------------------------------------------------------------------

/** Evaluate one assertion; only `judge` spends a metered `callModel` call, and it also returns `usage`. */
export async function evaluateAssertion(assertion, transcript, { callModel } = {}) {
  switch (assertion.type) {
    case 'includes': {
      const pass = transcript.includes(assertion.value);
      return { type: 'includes', pass, detail: pass ? `found "${assertion.value}"` : `missing "${assertion.value}"` };
    }
    case 'excludes': {
      const pass = !transcript.includes(assertion.value);
      return { type: 'excludes', pass, detail: pass ? `absent "${assertion.value}"` : `present "${assertion.value}"` };
    }
    case 'regex': {
      const pass = new RegExp(assertion.value).test(transcript);
      return { type: 'regex', pass, detail: pass ? `matched /${assertion.value}/` : `no match /${assertion.value}/` };
    }
    case 'judge': {
      const verdict = await judge(assertion.rubric, transcript, callModel);
      return { type: 'judge', pass: verdict.pass, detail: verdict.reason, usage: verdict.usage };
    }
    default:
      return { type: assertion.type, pass: false, detail: 'unknown assertion type' };
  }
}

const JUDGE_SYSTEM =
  'You are a strict evaluator. You are given a RUBRIC and a TRANSCRIPT (an assistant\'s response). ' +
  'Decide whether the transcript satisfies the rubric. Respond with a single JSON object and nothing else: ' +
  '{"pass": true|false, "reason": "<one short sentence>"}. Judge only what the transcript actually says.';

async function judge(rubric, transcript, callModel) {
  const user = `RUBRIC:\n${rubric}\n\nTRANSCRIPT:\n${transcript}\n\nReturn the JSON verdict.`;
  const { text, usage } = await callModel({
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 512,
  });
  return { ...parseVerdict(text), usage };
}

/** Lenient parse of a judge verdict — tolerant of prose/code fences around the JSON. */
export function parseVerdict(text) {
  const match = text && text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (typeof obj.pass === 'boolean') return { pass: obj.pass, reason: String(obj.reason ?? '') };
    } catch {
      /* fall through to keyword heuristic */
    }
  }
  // Default to FAIL when ambiguous — an unparseable judge must never silently pass a case.
  if (/\bpass\b/i.test(text || '') && !/\bfail\b/i.test(text || '')) return { pass: true, reason: 'verdict: pass' };
  return { pass: false, reason: `unparseable judge verdict: ${String(text).slice(0, 120)}` };
}

// -----------------------------------------------------------------------------
// Running a case / a whole run
// -----------------------------------------------------------------------------

/** Run a single case. Never throws for an assertion failure, but re-throws `BudgetExceededError`. */
export async function runCase(caseObj, { toolkitRoot, callModel, budget, model = DEFAULT_MODEL }) {
  const rendered = renderTargetPrompt(toolkitRoot, {
    stack: caseObj.stack,
    target: caseObj.target,
    config: caseObj.config,
  });

  const spend = async (opts) => {
    if (!budget.canSpend()) throw new BudgetExceededError(budget.maxCalls);
    const res = await callModel({ ...opts, model: caseObj.model ?? model });
    budget.record(res.usage);
    return res;
  };

  const scenario = await spend({
    system: rendered.body,
    messages: [{ role: 'user', content: caseObj.prompt }],
    maxTokens: caseObj.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  });
  const transcript = scenario.text;

  const assertionResults = [];
  for (const assertion of caseObj.assertions) {
    const result = await evaluateAssertion(assertion, transcript, { callModel: spend });
    assertionResults.push(result);
  }

  const pass = assertionResults.every((r) => r.pass);
  return {
    name: caseObj.name,
    stack: caseObj.stack,
    target: caseObj.target,
    pass,
    assertions: assertionResults,
    transcript,
    stopReason: scenario.stopReason,
  };
}

// Pass `callModel` for one shared model, or `makeCallModel: (caseObj) => callModel` when each case
// needs its own (dry-run feeds each case's `dryRunResponse` that way).
export async function runEvals(cases, { toolkitRoot, callModel, makeCallModel, budget, model = DEFAULT_MODEL, onResult } = {}) {
  const results = [];
  const skipped = [];
  let budgetHit = false;
  for (const caseObj of cases) {
    if (budgetHit) {
      skipped.push({ name: caseObj.name, stack: caseObj.stack, reason: 'budget exhausted' });
      continue;
    }
    try {
      const model$ = makeCallModel ? makeCallModel(caseObj) : callModel;
      const result = await runCase(caseObj, { toolkitRoot, callModel: model$, budget, model });
      results.push(result);
      if (onResult) onResult(result);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetHit = true;
        skipped.push({ name: caseObj.name, stack: caseObj.stack, reason: 'budget exhausted' });
      } else {
        const errored = { name: caseObj.name, stack: caseObj.stack, pass: false, error: err.message, assertions: [] };
        results.push(errored);
        if (onResult) onResult(errored);
      }
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  return {
    results,
    skipped,
    total: cases.length,
    passed,
    failed,
    skippedCount: skipped.length,
    budgetHit,
    usage: { calls: budget.calls, inputTokens: budget.inputTokens, outputTokens: budget.outputTokens, maxCalls: budget.maxCalls },
    ok: failed === 0 && skipped.length === 0,
  };
}

// -----------------------------------------------------------------------------
// Model clients
// -----------------------------------------------------------------------------

/** Anthropic Messages-API client on the global `fetch` — no SDK, keeping the single-dep footprint. */
export function anthropicClient({ apiKey, defaultModel = DEFAULT_MODEL, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for a live eval run (use --dry-run for a no-API smoke test)');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable — Node >= 18 is required');
  return async ({ system, messages, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, model = defaultModel }) => {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage: data.usage, stopReason: data.stop_reason };
  };
}

/** Deterministic mock model for `--dry-run` and tests: no network, no key; judge calls always pass. */
export function mockClient({ scenarioText = null } = {}) {
  return async ({ system, messages }) => {
    const isJudge = typeof system === 'string' && system.startsWith('You are a strict evaluator');
    if (isJudge) {
      return { text: '{"pass": true, "reason": "dry-run mock judge"}', usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const text = scenarioText ?? `[dry-run] mock response for prompt: ${messages?.[0]?.content ?? ''}`.slice(0, 400);
    return { text, usage: { input_tokens: 0, output_tokens: 0 }, stopReason: 'end_turn' };
  };
}
