import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject, renderItemInMemory, failingConfigFor } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { loadProjectConfig } from '../lib/project.mjs';
import { doctor } from '../lib/doctor.mjs';
import { stackConstraintProblems } from '../lib/validate.mjs';
import { constraintProblems, CONSTRAINT_KINDS } from '../lib/template.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SKILL = '.claude/skills/pr-response/SKILL.md';
const DIMS = ['severity', 'reach', 'validity', 'effortRisk', 'alignment'];
const KEYS = DIMS.map((d) => `prResponse.rubric.weights.${d}`);

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// #644 (#630 slice 2): per-dimension weights, a normalized composite, and an anyPositive constraint.
describe('pr-response rubric weights — render and doctor (#644)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-644-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const render = (weights) => {
    write(cwd, '.waffle/waffle.yaml', [
      'targets: [claude]',
      'include: [github-workflow/skills/pr-response]',
      'config:',
      '  project:',
      '    name: demo',
      ...(weights ? ['  prResponse:', '    rubric:', '      weights:', ...weights.map((l) => `        ${l}`)] : []),
      '',
    ].join('\n'));
    return renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
  };
  const md = () => fs.readFileSync(path.join(cwd, SKILL), 'utf8');
  const allZero = DIMS.map((d) => `${d}: 0`);

  test('no config renders weight 1 everywhere and keeps the plain-sum reading', () => {
    const r = render();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const text = md();
    assert.ok(text.includes('Severity **1** · Reach **1** · Validity **1** · Effort/Risk **1** · Alignment **1**'));
    assert.ok(text.includes('the composite is exactly the five scores summed, 0–15'));
    assert.ok(text.includes('≤4 Decline; weights Sev 1 · Reach 1 · Val 1 · E/R 1 · Align 1'));
  });

  test('non-default weights render into the weights line and the footer; the example fence stays at defaults', () => {
    const r = render(['validity: 2', 'effortRisk: 0.5']);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const text = md();
    assert.ok(text.includes('Severity **1** · Reach **1** · Validity **2** · Effort/Risk **0.5** · Alignment **1**'));
    const fence = text.slice(text.indexOf('### Reply format'), text.indexOf('Never copy a verdict'));
    const [, example, after] = fence.split(/```(?:markdown)?\n/);
    assert.ok(!example.includes('Weighted') && !example.includes('weights Sev'), 'the example reply is scored at default weights');
    assert.ok(after.includes('weights Sev 1 · Reach 1 · Val 2 · E/R 0.5 · Align 1'));
    assert.ok(after.includes('add a `Weighted` column after `Score`'));
  });

  test('four zeros and one positive weight render', () => {
    const r = render([...allZero.slice(0, 4), 'alignment: 3']);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(md().includes('E/R 0 · Align 3'));
  });

  test('a quoted decimal string is a number', () => {
    assert.equal(render(['reach: "0.5"']).ok, true);
  });

  for (const [label, lines, re] of [
    ['all-zero', allZero, /weights\.severity \(0\), .*weights\.alignment \(0\): at least one must be greater than 0 — the anyPositive constraint/],
    ['negative', ['reach: -1'], /weights\.reach\}\} is -1, outside its declared range \[0, ∞\]/],
    ['non-numeric', ['validity: heavy'], /weights\.validity\}\} must be a number/],
  ]) {
    test(`an ${label} weight config fails render AND doctor`, () => {
      assert.equal(render().ok, true);
      const r = render(lines);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => re.test(e)), JSON.stringify(r.errors));
      const dr = doctor({ cwd, toolkitVersion: '0.0.test', toolkitRoot: repoRoot });
      assert.equal(dr.ok, false);
      assert.ok(dr.configProblems.some((p) => re.test(p)), JSON.stringify(dr.configProblems));
    });
  }

  test('all-zero weights block the item in memory and name every weight in the list model', () => {
    render(allZero);
    const toolkit = loadToolkit(repoRoot);
    const project = loadProjectConfig(cwd);
    const item = toolkit.stacks.get('github-workflow').skills.find((s) => s.name === 'pr-response');
    const node = { stack: 'github-workflow', kind: 'skills', item };
    assert.equal(renderItemInMemory({ toolkit, project, cwd, node, toolkitVersion: '0.0.test' }), null);
    const { pattern } = failingConfigFor(toolkit, project, [node]);
    for (const k of KEYS) assert.ok(pattern.includes(`config.${k}`), `${k} missing from ${JSON.stringify(pattern)}`);
  });
});

describe('the anyPositive constraint kind and its lint (#644)', () => {
  const resolve = (vals) => (k) => vals[k];
  const stack = { name: 'demo', constraints: [{ kind: 'anyPositive', keys: ['a', 'b', 'c'] }] };

  test('is a declared kind', () => {
    assert.deepEqual(CONSTRAINT_KINDS, ['lessThan', 'anyPositive']);
  });

  test('constraintProblems flags only all-non-positive, numeric, used values', () => {
    assert.deepEqual(constraintProblems(stack, resolve({ a: 0, b: 0, c: 0.1 })), []);
    const [p, ...rest] = constraintProblems(stack, resolve({ a: 0, b: '0', c: 0 }));
    assert.equal(rest.length, 0);
    assert.deepEqual(p.keys, ['a', 'b', 'c']);
    assert.equal(p.problem, 'config a (0), b (0), c (0): at least one must be greater than 0 — the anyPositive constraint declared by stack "demo"');
    assert.deepEqual(constraintProblems(stack, resolve({ a: 0, b: 'x', c: 0 })), [], 'non-numeric is the range guard\'s to report');
    assert.deepEqual(constraintProblems(stack, resolve({ a: 0, b: 0, c: 0 }), new Set(['z'])), [], 'unused keys are not checked');
    assert.equal(constraintProblems(stack, resolve({ a: 0, b: 0, c: 0 }), new Set(['c'])).length, 1, 'one used key is enough');
  });

  test('stackConstraintProblems lints arity, distinctness, ranges, and the defaults', () => {
    const config = { a: { default: 0, range: { min: 0 } }, b: { default: 1, range: { min: 0 } }, z: { default: 0, range: { min: 0 } }, c: { default: 1 } };
    const lint = (keys) => stackConstraintProblems({ config, constraints: [{ kind: 'anyPositive', keys }] });
    assert.deepEqual(lint(['a', 'b']), []);
    assert.deepEqual(lint(['b']), [], 'a single key is a legal anyPositive');
    assert.match(lint([])[0], /\(anyPositive\) `keys` must name one or more distinct config keys/);
    assert.match(lint(['a', 'b', 'a'])[0], /one or more distinct/);
    assert.match(lint(['a', 'c'])[0], /names c, which this stack does not declare with a `range`/);
    assert.match(lint(['a', 'z'])[0], /constraints\[0\] \(anyPositive\) is violated by the defaults: config a \(0\), z \(0\): at least one/);
    assert.match(stackConstraintProblems({ config, constraints: [{ kind: 'nonzero', keys: ['a'] }] })[0], /one of: lessThan, anyPositive/);
  });

  test('the real github-workflow stack declares all five weights under one clean anyPositive', () => {
    const gw = loadToolkit(repoRoot).stacks.get('github-workflow');
    assert.deepEqual(stackConstraintProblems(gw), []);
    const c = gw.constraints.find((x) => x.kind === 'anyPositive');
    assert.deepEqual(c.keys, KEYS);
    for (const k of KEYS) assert.deepEqual([gw.config[k].default, gw.config[k].range], [1, { min: 0 }], k);
  });
});
