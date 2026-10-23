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
import { rangeKeyProblems, stackConstraintProblems } from '../lib/validate.mjs';
import { rangeProblem, toRangeNumber, constraintProblems } from '../lib/template.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SKILL = '.claude/skills/pr-response/SKILL.md';

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// #630 slice 1: the pr-response Implement/Decline cutoffs are config, guarded by `range:` + a `lessThan` constraint.
describe('pr-response rubric thresholds — render and doctor (#630)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-630-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const render = (thresholds) => {
    write(cwd, '.waffle/waffle.yaml', [
      'targets: [claude]',
      'include: [github-workflow/skills/pr-response]',
      'config:',
      '  project:',
      '    name: demo',
      ...(thresholds ? ['  prResponse:', '    rubric:', '      thresholds:', ...thresholds.map((l) => `        ${l}`)] : []),
      '',
    ].join('\n'));
    return renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
  };
  const md = () => fs.readFileSync(path.join(cwd, SKILL), 'utf8');

  test('no config renders the v3 cutoffs', () => {
    const r = render();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(md().includes('| **≥ 11** | **Implement** |'));
    assert.ok(md().includes('≥11 Implement · >4 and <11 Defer · ≤4 Decline'));
  });

  test('non-default cutoffs render into the table, the footer, and the override rule', () => {
    const r = render(['implement: 12', 'decline: 3']);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const text = md();
    assert.ok(text.includes('| **≥ 12** | **Implement** |'));
    assert.ok(text.includes('| **> 3 and < 12** | **Defer** |'));
    assert.ok(text.includes('| **≤ 3** | **Decline** |'));
    assert.ok(text.includes('≥12 Implement · >3 and <12 Defer · ≤3 Decline'));
    assert.ok(text.includes('threshold (12). Note the override'));
  });

  for (const [label, lines, re] of [
    ['out of range', ['implement: 16'], /thresholds\.implement\}\} is 16, outside its declared range \[0, 15\]/],
    ['non-numeric', ['decline: "four"'], /thresholds\.decline\}\} must be a number/],
    ['inverted', ['implement: 5', 'decline: 5'], /thresholds\.decline \(5\) must be less than prResponse\.rubric\.thresholds\.implement \(5\)/],
  ]) {
    test(`an ${label} threshold fails render AND doctor`, () => {
      assert.equal(render().ok, true);
      const r = render(lines);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => re.test(e)), JSON.stringify(r.errors));
      const dr = doctor({ cwd, toolkitVersion: '0.0.test', toolkitRoot: repoRoot });
      assert.equal(dr.ok, false);
      assert.ok(dr.configProblems.some((p) => re.test(p)), JSON.stringify(dr.configProblems));
    });
  }

  test('a quoted decimal string is a number', () => {
    assert.equal(render(['implement: "10.5"']).ok, true);
  });

  test('adjacent cutoffs pass: lessThan allows an empty integer Defer band', () => {
    const r = render(['implement: 11', 'decline: 10']);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(md().includes('| **> 10 and < 11** | **Defer** |'));
  });

  test('an inverted config blocks the item in memory and in the list model', () => {
    render(['implement: 5', 'decline: 12']);
    const toolkit = loadToolkit(repoRoot);
    const project = loadProjectConfig(cwd);
    const item = toolkit.stacks.get('github-workflow').skills.find((s) => s.name === 'pr-response');
    const node = { stack: 'github-workflow', kind: 'skills', item };
    assert.equal(renderItemInMemory({ toolkit, project, cwd, node, toolkitVersion: '0.0.test' }), null);
    const { pattern } = failingConfigFor(toolkit, project, [node]);
    assert.ok(pattern.includes('config.prResponse.rubric.thresholds.decline'), JSON.stringify(pattern));
    assert.ok(pattern.includes('config.prResponse.rubric.thresholds.implement'), JSON.stringify(pattern));
  });
});

describe('range: and constraints: — the guard helpers and their lint (#630)', () => {
  const guards = { ranges: new Map([['k', [{ min: 0, max: 15, source: 'stack "demo"' }]]]) };

  test('toRangeNumber admits finite numbers and decimal strings only', () => {
    assert.equal(toRangeNumber(3), 3);
    assert.equal(toRangeNumber('2.5'), 2.5);
    for (const v of ['', ' 3', '1e3', 'NaN', Infinity, true, null, [1]]) assert.equal(toRangeNumber(v), null, String(v));
  });

  test('rangeProblem is inclusive and a no-op when unguarded', () => {
    assert.equal(rangeProblem(guards, 'k', 0), null);
    assert.equal(rangeProblem(guards, 'k', 15), null);
    assert.match(rangeProblem(guards, 'k', -1), /outside its declared range \[0, 15\] \(declared by stack "demo"\)/);
    assert.equal(rangeProblem(guards, 'other', 'x'), null);
  });

  test('constraintProblems flags only a violated, used lessThan', () => {
    const stack = { name: 'demo', constraints: [{ kind: 'lessThan', keys: ['a', 'b'] }] };
    const resolve = (vals) => (k) => vals[k];
    assert.deepEqual(constraintProblems(stack, resolve({ a: 1, b: 2 })), []);
    assert.equal(constraintProblems(stack, resolve({ a: 2, b: 2 })).length, 1);
    assert.deepEqual(constraintProblems(stack, resolve({ a: 2, b: 2 }), new Set(['z'])), [], 'unused keys are not checked');
    assert.deepEqual(constraintProblems(stack, resolve({ a: 'x', b: 2 })), [], 'non-numeric is the range guard\'s to report');
  });

  test('rangeKeyProblems lints the declaration', () => {
    assert.deepEqual(rangeKeyProblems({ default: 4, range: { min: 0, max: 15 } }), []);
    assert.deepEqual(rangeKeyProblems({ default: 4 }), []);
    assert.match(rangeKeyProblems({ range: { lo: 0 } })[0], /must be a map of `min` and\/or `max`/);
    assert.match(rangeKeyProblems({ range: { min: '0' } })[0], /`range\.min` must be a number/);
    assert.match(rangeKeyProblems({ range: { min: 5, max: 1 } })[0], /greater than/);
    assert.match(rangeKeyProblems({ range: { min: 0 }, pattern: '\\d+' })[0], /both `range` and `pattern`/);
    assert.match(rangeKeyProblems({ default: 20, range: { max: 15 } })[0], /default 20 is 20, outside/);
  });

  test('stackConstraintProblems lints kind, keys, and the defaults', () => {
    const config = { a: { default: 1, range: { min: 0 } }, b: { default: 2, range: { min: 0 } }, c: { default: 0 } };
    const lint = (constraints) => stackConstraintProblems({ config, constraints });
    assert.deepEqual(lint([{ kind: 'lessThan', keys: ['a', 'b'] }]), []);
    assert.match(lint({})[0], /must be a list/);
    assert.match(lint([{ kind: 'moreThan', keys: ['a', 'b'] }])[0], /one of: lessThan/);
    assert.match(lint([{ kind: 'lessThan', keys: ['a', 'a'] }])[0], /two distinct config keys/);
    assert.match(lint([{ kind: 'lessThan', keys: ['a', 'c'] }])[0], /names c, which this stack does not declare with a `range`/);
    assert.match(lint([{ kind: 'lessThan', keys: ['b', 'a'] }])[0], /violated by the defaults/);
  });
});
