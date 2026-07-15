import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// Guards pre-flight ↔ CI parity (#375). The rendered git-workflow pre-flight is a
// hand-configured list (`project.*Cmd` in .waffle/waffle.yaml) of what CI's required `test`
// job runs — and it drifted: `typecheckCmd: npm run validate` meant no pre-flight ran
// `npm run typecheck`, so PR #370 (commit 46293cc) went red on a step no pre-flight named.
// This test fails whenever a command in tests.yml's `test` job is missing from the rendered
// pre-flight (with one level of npm-script expansion), so the drift can't recur silently.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// CI steps that are environment setup, not checks a pre-flight could mirror.
const CI_EXCLUSIONS = ['npm ci'];

function ciCommands() {
  const workflow = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8'));
  const steps = workflow?.jobs?.test?.steps ?? [];
  return steps
    .flatMap((step) => (typeof step.run === 'string' ? step.run.split(/\r?\n/) : []))
    .map((line) => line.trim())
    .filter(Boolean);
}

function preflightCommands() {
  const skill = fs.readFileSync(path.join(ROOT, '.claude/skills/git-workflow/SKILL.md'), 'utf8');
  const match = skill.match(/^## Pre-flight Checklist$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(match, 'rendered git-workflow SKILL.md has no "## Pre-flight Checklist" section');
  const commands = [];
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\d+\.\s+`([^`]+)`/);
    if (item) commands.push(item[1]);
  }
  return commands;
}

describe('pre-flight mirrors CI required test job (#375)', () => {
  test('every check command in tests.yml appears in the rendered pre-flight', () => {
    const ci = ciCommands();
    // Anchor: fail loudly if the job is renamed or emptied rather than silently guarding nothing.
    assert.ok(ci.length > 0, 'tests.yml jobs.test.steps yielded no run commands');
    assert.ok(ci.includes('npm test'), 'tests.yml test job no longer runs `npm test` — update this guard');

    const preflight = preflightCommands();
    assert.ok(preflight.length >= 4, `expected ≥4 pre-flight commands, got ${preflight.length}: ${preflight.join(', ')}`);

    // One-level npm-script expansion: `npm test` / `npm run <script>` cover their script body too.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const coverage = preflight.map((cmd) => {
      const script = cmd === 'npm test' ? 'test' : cmd.match(/^npm run (\S+)/)?.[1];
      const body = script && pkg.scripts?.[script] ? ` ${pkg.scripts[script]}` : '';
      return cmd + body;
    });

    for (const cmd of ci) {
      if (CI_EXCLUSIONS.includes(cmd)) continue;
      assert.ok(
        coverage.some((text) => text.includes(cmd)),
        `CI test-job command "${cmd}" is not covered by any rendered pre-flight step ` +
          `(${preflight.join(' | ')}). Fix config.project.*Cmd in .waffle/waffle.yaml and re-render.`,
      );
    }
  });
});
