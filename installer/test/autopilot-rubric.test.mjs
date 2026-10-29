import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { readRendered } from './self-render.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SKILL = '.claude/skills/autopilot/SKILL.md';
const SOURCE = 'stacks/orchestration/skills/autopilot/SKILL.md';
const read = (rel) => (rel.startsWith('.claude/') ? readRendered(rel) : fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
const section = (md, from, to) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));
const SUB = '### Rubric override — optional, per-run, never stored';
const override = () => section(read(SKILL), SUB, '## Per-issue loop');
const RUBRIC_KEYS = [
  'prResponse.rubric.thresholds.implement',
  'prResponse.rubric.thresholds.decline',
  ...['severity', 'reach', 'validity', 'effortRisk', 'alignment'].map((w) => `prResponse.rubric.weights.${w}`),
];

// #646 (#630 slice 4): autopilot validates a per-run `--rubric` up front and forwards it to its responders.
describe('autopilot --rubric pass-through (#646)', () => {
  test('the argument hint advertises the token after the gate tokens', () => {
    assert.match(read(SKILL), /argument-hint:.*\[\+audit \| -audit\] \[--rubric <key>=<n>,…\] — scope is REQUIRED/);
  });

  test('§1 pulls the token out before scope, with the `=` lookahead', () => {
    const md = section(read(SKILL), '### 1. Issue scope', '### 2.');
    assert.match(md, /Pull out the \*\*rubric override\*\* too: a `--rubric=<spec>` argument, or a bare `--rubric` together with the next argument \*\*when that argument contains `=`\*\*/);
    assert.match(md, /`--rubric bug` is a malformed override, and `bug` stays scope/);
    assert.match(md, /Match whole arguments only: `-qa-blocked` is a label, not `-qa`/);
  });

  test('the subsection sits in the contract, after §5, citing pr-response rather than restating it', () => {
    const md = read(SKILL);
    const at = md.indexOf(SUB);
    assert.ok(at > md.indexOf('### 5. QA-gate consent') && at < md.indexOf('## Per-issue loop'));
    assert.match(md, /Capture \*\*all five\*\* of these/);
    assert.match(md, /One optional run parameter rides with them, the \*\*rubric override\*\*/);
    assert.match(override(), /its §1, \*The rubric run override\*/);
  });

  test('orchestration re-declares the rubric keys and constraints exactly as github-workflow owns them', () => {
    const stacks = loadToolkit(repoRoot).stacks;
    const gw = stacks.get('github-workflow');
    const orch = stacks.get('orchestration');
    for (const key of RUBRIC_KEYS) {
      for (const field of ['required', 'default', 'range']) {
        assert.deepEqual(orch.config[key]?.[field], gw.config[key][field], `${key}.${field} drifted`);
      }
    }
    assert.deepEqual(orch.constraints, gw.constraints);
    const source = read(SOURCE);
    for (const key of RUBRIC_KEYS) assert.ok(source.includes(`{{${key}}}`), key);
    assert.doesNotMatch(read(SKILL), /\{\{prResponse\./);
  });

  test('the rendered base line shows this repo\'s rubric', () => {
    assert.ok(override().includes('Implement ≥ **11** · Decline ≤ **4** · weights Severity **1** · Reach **1** · Validity **1** · Effort/Risk **1** · Alignment **1**'));
  });

  test('validation runs once before any work, merged over the rendered rubric; malformed asks or stops', () => {
    const md = override();
    assert.match(md, /Validate once, up front — before any work/);
    assert.match(md, /\*\*merge over the rendered rubric above\*\*/);
    assert.match(md, /`decline < implement` \(strictly\)/);
    assert.match(md, /\*\*whole token\*\* malformed, never a per-key partial/);
    assert.match(md, /asks with `AskUserQuestion` before any work/);
    assert.match(md, /\*\*stops before any work\*\*/);
    assert.match(md, /deliberately differs from pr-response/);
  });

  test('identical repeats collapse; different specs are a contradiction that stops', () => {
    const md = override();
    assert.match(md, /identical repeats are harmless, different specs stop the run/);
    assert.match(md, /never merge two tokens and never pick one/);
    assert.match(md, /forwards \*\*exactly one\*\* `--rubric`/);
  });

  for (const [name, from, to, agent] of [
    ['Step 5', '### Step 5', '### Step 6', 'respond-qa-pr<N>'],
    ['Step 6', '### Step 6 — Review', '### Step 7', 'respond-rev-pr<N>'],
  ]) {
    test(`${name} forwards the spec on the spawn and re-spawn, never on a resume`, () => {
      const md = section(read(SKILL), from, to);
      assert.ok(md.includes(`Agent(name: "${agent}", …)\` runs \`pr-response <pr> --yes\` — \`pr-response <pr> --yes --rubric <spec>\` when this run carries a rubric override`));
      assert.match(md, /pr-response <pr> --yes/);
      assert.match(md, /Resume messages never carry `--rubric`: the responder keeps the rubric it was spawned with/);
      assert.match(md, /full round-1 prompt(?:\*\*)? \(the run's `--rubric <spec>`, when given, included\)/);
      assert.match(md, /run `pr-response <pr> --yes` \(with this run's `--rubric <spec>` on the spawn, when given\)/);
    });
  }

  test('the re-spawn sentence and the wedge retry keep their counts; retries carry the token', () => {
    const md = read(SKILL);
    assert.equal([...md.matchAll(/you are replacing a vanished loop agent/g)].length, 2);
    assert.equal([...md.matchAll(/retry the round on a fresh spawn\*\* under the same name, with the full round-1 prompt(?:\*\*)? \(the run's `--rubric` included\)/g)].length, 2);
  });

  test('the guardrail and the run report name the override', () => {
    const md = read(SKILL);
    assert.match(md, /- \*\*The rubric override is per-run policy, never stored\.\*\*/);
    assert.match(md, /never read back from a prior run or a prior reply's footer/);
    assert.match(md, /\+ the \*\*rubric\*\*: `config` \(show the rendered cutoffs and weights\), or `run override \(--rubric <spec as given>\)`/);
    assert.match(md, /a pass-through fault/);
  });
});

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('autopilot rubric base line — render (#646)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-646-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const render = (rubric) => {
    write(cwd, '.waffle/waffle.yaml', [
      'targets: [claude]',
      'include: [orchestration/skills/autopilot]',
      'config:',
      '  project: { name: demo, longName: Demo }',
      '  roster:',
      '    classificationTable: "| a | b |"',
      '    labelFallback: "| a | b |"',
      '    rootFiles: "`package.json`"',
      '    sharedModule: "`shared/`"',
      '    moduleDependencies: none',
      '  audit:',
      '    complianceLabel: API',
      '    complianceFrontmatterLabel: API',
      '    complianceTaskLabel: API review',
      '    complianceAgentName: audit-compliance',
      '    complianceDescription: API matches.',
      '    compliancePrompt: "### API (Task 3)"',
      ...(rubric ? ['  prResponse:', '    rubric:', ...rubric.map((l) => `      ${l}`)] : []),
      '',
    ].join('\n'));
    return renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
  };

  test('non-default config renders into the base line', () => {
    const r = render(['thresholds: { implement: 12 }', 'weights: { validity: 2 }']);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const md = fs.readFileSync(path.join(cwd, SKILL), 'utf8');
    assert.ok(md.includes('Implement ≥ **12** · Decline ≤ **4** · weights Severity **1** · Reach **1** · Validity **2**'));
  });

  test('an inverted config fails in the orchestration stack too', () => {
    const r = render(['thresholds: { implement: 5, decline: 5 }']);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /orchestration/.test(e) && /less than/.test(e)), JSON.stringify(r.errors));
  });
});
