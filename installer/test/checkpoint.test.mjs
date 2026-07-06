import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The delegate checkpoint validator (checkpoint.mjs) lives beside its SKILL.md in the
// orchestration stack and is copied verbatim into a consumer's .claude/skills/delegate/.
// These tests exercise the source script directly: they prove that a well-formed
// checkpoint passes for its phase and that each corruption class the issue names — a
// dropped field, a missing section, a hallucinated branch — stops the run (exit 1).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../stacks/orchestration/skills/delegate/checkpoint.mjs');

const BASE = {
  version: 1,
  runId: 'delegate-1720000000',
  scope: { mode: 'current-milestone', description: 'v1.1 (#5) — 2 open', milestone: { number: 5, title: 'v1.1' } },
  issues: [
    { number: 3, title: 'Fix UI hang', labels: ['bug'] },
    { number: 5, title: 'Folder picker', labels: ['bug'], milestone: 'v1.1' },
  ],
  classification: [
    { number: 3, agent: 'plugin-architect', area: 'summarize', touchesRoot: false, touchesShared: false },
    { number: 5, agent: 'lead-engineer', area: 'shared', touchesShared: true },
  ],
  plan: {
    confirmed: true,
    groups: [
      { id: 'A', mode: 'parallel', assignments: [{ number: 3, agent: 'plugin-architect', branch: 'fix/issue-3-ui-hang', worktree: '/repo/.claude/worktrees/issue-3' }] },
      { id: 'B', mode: 'serial', assignments: [{ number: 5, agent: 'lead-engineer', branch: 'fix/issue-5-folder-picker', worktree: null }] },
    ],
  },
  execution: [
    { number: 3, agent: 'plugin-architect', branch: 'fix/issue-3-ui-hang', status: 'done', pr: '#6' },
    { number: 5, agent: 'lead-engineer', branch: 'fix/issue-5-folder-picker', status: 'done', pr: '#7' },
  ],
  report: { build: 'passing' },
};

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

describe('delegate checkpoint validator', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (doc, phase) => {
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
    return spawnSync(process.execPath, [SCRIPT, '--file', file, '--phase', phase], { encoding: 'utf8' });
  };

  test('a complete checkpoint passes every phase', () => {
    for (const phase of ['fetch', 'classify', 'plan', 'execute', 'report']) {
      const r = run(BASE, phase);
      assert.equal(r.status, 0, `phase ${phase} should pass:\n${r.stderr}`);
      assert.match(r.stdout, /is valid for phase/);
    }
  });

  test('missing required section for the phase stops the run', () => {
    const doc = clone(BASE);
    delete doc.report;
    const r = run(doc, 'report');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires section "report"/);
  });

  test('a dropped/renamed field is caught by additionalProperties + required', () => {
    const doc = clone(BASE);
    doc.issues[0].titel = doc.issues[0].title; // typo the field name
    delete doc.issues[0].title;
    const r = run(doc, 'fetch');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required property "title"/);
    assert.match(r.stderr, /unexpected property "titel"/);
  });

  test('a hallucinated branch name is caught at the execute boundary', () => {
    const doc = clone(BASE);
    doc.execution[0].branch = 'fix/issue-3-something-else';
    const r = run(doc, 'execute');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /branch mismatch/);
  });

  test('an unclassified fetched issue stops the classify boundary', () => {
    const doc = clone(BASE);
    doc.classification = doc.classification.filter((c) => c.number !== 5);
    const r = run(doc, 'classify');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /issue #5 was fetched but never classified/);
  });

  test('a parallel assignment without a worktree stops the plan boundary', () => {
    const doc = clone(BASE);
    doc.plan.groups[0].assignments[0].worktree = null;
    const r = run(doc, 'plan');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /parallel group A but has no worktree path/);
  });

  test('an enum violation (bad branch prefix) fails schema validation', () => {
    const doc = clone(BASE);
    doc.plan.groups[1].assignments[0].branch = 'wip/issue-5-folder-picker';
    const r = run(doc, 'plan');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match pattern/);
  });

  test('approval-gate fields: an approved push and a rejected push both pass execute', () => {
    const doc = clone(BASE);
    doc.execution[0] = { number: 3, agent: 'plugin-architect', branch: 'fix/issue-3-ui-hang', status: 'done', pr: '#6', approval: 'approved', approvedBy: 'dustin' };
    doc.execution[1] = { number: 5, agent: 'lead-engineer', branch: 'fix/issue-5-folder-picker', status: 'skipped', pr: null, approval: 'rejected', approvedBy: 'dustin' };
    const r = run(doc, 'execute');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /is valid for phase/);
  });

  test('a rejected push that still claims a PR is caught at the execute boundary', () => {
    const doc = clone(BASE);
    doc.execution[1] = { number: 5, agent: 'lead-engineer', branch: 'fix/issue-5-folder-picker', status: 'skipped', pr: '#7', approval: 'rejected', approvedBy: 'dustin' };
    const r = run(doc, 'execute');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /rejected at the approval gate but has a PR/);
  });

  test('a rejected push whose status is not "skipped" is caught at the execute boundary', () => {
    const doc = clone(BASE);
    doc.execution[1] = { number: 5, agent: 'lead-engineer', branch: 'fix/issue-5-folder-picker', status: 'done', pr: '#7', approval: 'rejected', approvedBy: 'dustin' };
    const r = run(doc, 'execute');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a rejected push must be "skipped"/);
  });

  test('approvedBy without an approval decision is caught at the execute boundary', () => {
    const doc = clone(BASE);
    doc.execution[0].approvedBy = 'dustin';
    const r = run(doc, 'execute');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /records approvedBy but no approval decision/);
  });

  test('an unknown approval value fails schema validation', () => {
    const doc = clone(BASE);
    doc.execution[0].approval = 'maybe';
    const r = run(doc, 'execute');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not one of/);
  });

  test('malformed JSON produces a clean error, not a stack trace', () => {
    const r = run('{ "version": 1, ', 'fetch');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read\/parse/);
    assert.doesNotMatch(r.stderr, /at Object\.<anonymous>/); // no raw stack trace
  });

  test('an unknown phase is rejected', () => {
    const r = run(BASE, 'bogus');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown phase/);
  });
});
