import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { validateToolkit } from '../lib/validate.mjs';
import { makeResolver } from '../lib/project.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SKILL = '.claude/skills/autopilot/SKILL.md';
const SOURCE = 'stacks/orchestration/skills/autopilot/SKILL.md';
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const section = (md, from, to) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));
const orchestration = () => loadToolkit(repoRoot).stacks.get('orchestration');

// #731 (slice 1 of #720): integration mode routes run PRs into a per-run branch; the final PR is never armed.
describe('autopilot.integration declaration and resolution (#731)', () => {
  let cwd;
  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-731-')); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  const renderWith = (value) => {
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), [
      'targets: [claude]',
      'include: [orchestration/skills/autopilot]',
      'config:',
      '  project:',
      '    name: Integ731',
      '  roster:',
      '    classificationTable: "| Signal | Agent |"',
      '    labelFallback: "| Label | Agent |"',
      '    rootFiles: package.json',
      '    sharedModule: lib/',
      '    moduleDependencies: none',
      '  audit:',
      '    complianceLabel: Integrity',
      '    complianceFrontmatterLabel: integrity',
      '    complianceTaskLabel: Integrity check',
      '    complianceAgentName: integrity',
      '    complianceDescription: Validates the thing.',
      '    compliancePrompt: Run the checks.',
      ...(value === undefined ? [] : ['  autopilot:', `    integration: ${value}`]),
      '',
    ].join('\n'));
    const r = renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
    const md = r.ok ? fs.readFileSync(path.join(cwd, SKILL), 'utf8') : '';
    return { r, md };
  };

  test('a two-mode routing key: default false, +/- tokens, no lock, no configModes, no nonInteractive', () => {
    const spec = orchestration().config['autopilot.integration'];
    assert.deepEqual(spec.modes, [true, false]);
    assert.equal(spec.default, false);
    assert.deepEqual(spec.flag, { on: '+integration', off: '-integration' });
    for (const field of ['lockMode', 'configModes', 'nonInteractive']) assert.equal(spec[field], undefined, field);
    assert.deepEqual(validateToolkit(repoRoot).filter((p) => /autopilot\.integration/.test(p)), []);
  });

  test('config may set it either way, and the render carries the value (default off)', () => {
    for (const [value, shown] of [[undefined, 'false'], ['true', 'true'], ['false', 'false']]) {
      const { r, md } = renderWith(value);
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.ok(md.includes(`**Rendered value for this repo: \`${shown}\`**`), `${value} → ${shown}`);
    }
  });

  test('prompt is not one of its modes', () => {
    const { r } = renderWith('prompt');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /\{\{autopilot\.integration\}\} is not one of its declared modes/.test(e)), JSON.stringify(r.errors));
  });

  test('the token placeholders resolve from the stack, never from project config', () => {
    const resolve = makeResolver(orchestration(), { autopilot: { integration: { flag: { on: '+smuggled' } } } }, 'claude');
    assert.equal(resolve('autopilot.integration.flag.on'), '+integration');
    assert.equal(resolve('autopilot.integration.flag.off'), '-integration');
  });

  test('the ruleset prerequisite is a recommend-level setting scoped to autopilot', () => {
    const p = orchestration().prerequisites.find((x) => x.name === 'integration-required-status-check');
    assert.ok(p, 'declared');
    assert.equal(p.kind, 'setting');
    assert.equal(p.level, 'recommend');
    assert.deepEqual(p.items, ['skills/autopilot']);
    assert.match(p.check, /rules\/branches\/autopilot\/integration\/.*required_status_checks/);
  });
});

describe('autopilot SKILL.md wires integration mode (#731)', () => {
  test('the source uses placeholders, never literal tokens; the render resolves them', () => {
    const src = read(SOURCE);
    for (const k of ['autopilot.integration', 'autopilot.integration.flag.on', 'autopilot.integration.flag.off']) {
      assert.ok(src.includes(`{{${k}}}`), k);
    }
    assert.doesNotMatch(src, /[+-]integration\b/);
    assert.doesNotMatch(read(SKILL), /\{\{autopilot\.integration/);
  });

  test('the argument hint advertises both tokens after +automerge and keeps the rubric adjacency', () => {
    const md = read(SKILL);
    assert.match(md, /argument-hint:.*\[\+automerge\] \[\+integration \| -integration\] \[\+qa/);
    assert.match(md, /argument-hint:.*\[\+audit \| -audit\] \[--rubric <key>=<n>,…\] — scope is REQUIRED/);
  });

  test('the contract subsection: token beats config, not a consent, final PR never armed', () => {
    const md = section(read(SKILL), '### Integration mode', '## Integration branch');
    assert.match(md, /per-run token beats config, off by default/);
    assert.match(md, /A routing mode, not a consent/);
    assert.match(md, /\*\*Contradictions stop the run\.\*\*/);
    assert.match(md, /`\+integration` \| On for this run\./);
    assert.match(md, /The rendered value — never asked\./);
    assert.match(md, /The integration → `main` PR is \*\*never armed\*\*, even with `\+automerge`/);
  });

  test('the branch section: cut before Step 1, never fall back to main, no final PR while a run PR is open', () => {
    const md = section(read(SKILL), '## Integration branch', '## Per-issue loop');
    assert.match(md, /autopilot\/integration\/<UTC yyyymmdd-HHMMSS>/);
    assert.match(md, /`git push origin <sha>:refs\/heads\/<name>`/);
    assert.match(md, /never fall back to `main` silently/);
    assert.match(md, /`gh pr create --base <integ>`/);
    assert.match(md, /## Base branch/);
    assert.match(md, /First wait out every \*\*armed\*\* run PR, including the last serial one and each parallel-group PR/);
    assert.match(md, /Do not wait on unarmed PRs/);
    assert.match(md, /\*\*no run PR is still open against `<integ>`\*\*/);
    assert.match(md, /Delete the branch only when \*\*no run PR is open against `<integ>`\*\*/);
    assert.doesNotMatch(md, /If none merged and `origin\/<integ>` still equals the cut SHA, delete/);
    assert.match(md, /\*\*Never arm it\*\* in this release/);
  });

  test('Steps 3, 4, 8, 9 and the guardrails carry the integration-mode rules', () => {
    const md = read(SKILL);
    assert.match(section(md, '### Step 3', '### Step 4'), /\*\*With integration mode on\*\*, `delegate\.autoMerge` is off for the delegate run even with every gate off/);
    assert.match(section(md, '### Step 4', '### Step 5'), /`gh pr view <pr> --json baseRefName -q \.baseRefName` must equal `<integ>`; if not, `gh pr edit <pr> --base <integ>`/);
    assert.match(section(md, '### Step 4', '### Step 5'), /arm here — `gh pr merge --auto --merge <pr>`, then on a successful arm label it `gh pr edit <pr> --add-label "waffle:auto-merged"`/);
    assert.match(section(md, '### Step 8', '### Step 9'), /`MERGED` means merged into `<integ>`/);
    assert.match(section(md, '### Step 9', '## End-of-run'), /\*\*Integration mode on:\*\* skip items 1 and 2/);
    const guard = section(md, '## Guardrails', '## Failure handling');
    assert.match(guard, /Its only direct pushes are creating its own integration branch/);
    assert.match(guard, /when nothing merged into it and no run PR is open against it, deleting it/);
    assert.match(guard, /The integration → `main` PR is never armed in this release/);
    assert.match(guard, /Integration mode is a routing mode, not a consent, so config may set it\./);
  });
});
