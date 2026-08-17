import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Comment-hygiene gate — enforces the comments-are-not-spec doctrine (DECISIONS.md #388)
// mechanically. Typed JSDoc blocks never count; everything else is capped per file.
// GRANDFATHERED pins each legacy file's current mass; cleanup PRs delete entries.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_PCT = 15;
const STACKS_MJS_PCT = 20;
const MAX_RUN = 8;
const SMALL_FILE_LINES = 12; // absolute allowance so tiny files aren't ratio-noise
const MAX_SLACK_PCT = 10; // a grandfathered ceiling this far above actual must be tightened

// Measured 2026-08-17 (ratio% + 1, longest run as found). Delete a file's entry when it
// is cleaned; the gate then holds it to the default ceilings above.
const GRANDFATHERED = {
  '.github/workflows/tests.yml': { pct: 61, run: 23 },
  '.github/workflows/waffle-post-merge-hook.yml': { pct: 34, run: 27 },
  '.github/workflows/waffle-release-hook.yml': { pct: 40, run: 15 },
  'installer/cli.mjs': { pct: 28, run: 10 },
  'installer/evals.mjs': { pct: 14, run: 17 },
  'installer/lib/doctor.mjs': { pct: 30, run: 17 },
  'installer/lib/eject.mjs': { pct: 19, run: 11 },
  'installer/lib/evals.mjs': { pct: 25, run: 18 },
  'installer/lib/refs.mjs': { pct: 16, run: 13 },
  'installer/lib/registry.mjs': { pct: 28, run: 43 },
  'installer/lib/render.mjs': { pct: 26, run: 9 },
  'installer/lib/setup.mjs': { pct: 19, run: 10 },
  'installer/lib/sources.mjs': { pct: 19, run: 6 },
  'installer/lib/toolkit.mjs': { pct: 22, run: 16 },
  'installer/lib/uninstall.mjs': { pct: 17, run: 10 },
  'installer/test/content.test.mjs': { pct: 33, run: 32 },
  'installer/test/installer.test.mjs': { pct: 19, run: 35 },
  'installer/test/provenance.test.mjs': { pct: 26, run: 21 },
  'installer/test/registry.test.mjs': { pct: 14, run: 14 },
  'installer/test/telemetry.test.mjs': { pct: 12, run: 15 },
  'installer/test/typecheck-gate.test.mjs': { pct: 25, run: 6 },
  'stacks/github-workflow/files/.github/workflows/waffle-evals.yml': { pct: 29, run: 14 },
  'stacks/github-workflow/files/.github/workflows/waffle-hygiene.yml': { pct: 33, run: 24 },
  'stacks/github-workflow/files/.github/workflows/waffle-label-hook.yml': { pct: 27, run: 23 },
  'stacks/github-workflow/files/.github/workflows/waffle-post-merge-hook.yml': { pct: 34, run: 27 },
  'stacks/github-workflow/files/.github/workflows/waffle-pr-green-hook.yml': { pct: 16, run: 22 },
  'stacks/github-workflow/files/.github/workflows/waffle-pr-response-hook.yml': { pct: 20, run: 15 },
  'stacks/github-workflow/files/.github/workflows/waffle-release-hook.yml': { pct: 40, run: 15 },
  'stacks/orchestration/skills/delegate/checkpoint.mjs': { pct: 17, run: 17 },
  'stacks/orchestration/skills/delegate/identity.mjs': { pct: 30, run: 44 },
  'stacks/orchestration/skills/delegate/memory.mjs': { pct: 30, run: 30 },
};

// Counts `//` lines (minus a line-1 `// @ts-check`) and block-comment lines, excluding
// `/**` blocks that carry a JSDoc `@tag` — typed contracts are the keep-set (#388).
export function classifyMjs(src) {
  const lines = src.split(/\r?\n/);
  let nonBlank = 0;
  let commentLines = 0;
  let maxRun = 0;
  let run = 0;
  let i = 0;
  const endRun = () => {
    if (run > maxRun) maxRun = run;
    run = 0;
  };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') {
      endRun();
      i++;
      continue;
    }
    nonBlank++;
    if (t.startsWith('/*')) {
      const block = [lines[i]];
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) {
        j++;
        if (j < lines.length) block.push(lines[j]);
      }
      const blockNonBlank = block.filter((l) => l.trim() !== '').length;
      nonBlank += blockNonBlank - 1; // first line counted above
      const typedJsdoc = t.startsWith('/**') && block.some((l) => /^\s*\*\s*@\w/.test(l));
      if (typedJsdoc) {
        endRun();
      } else {
        commentLines += blockNonBlank;
        run += blockNonBlank;
        if (run > maxRun) maxRun = run;
      }
      i = j + 1;
      continue;
    }
    if (t.startsWith('//')) {
      if (i === 0 && t === '// @ts-check') {
        endRun();
        i++;
        continue;
      }
      commentLines++;
      run++;
      if (run > maxRun) maxRun = run;
      i++;
      continue;
    }
    endRun();
    i++;
  }
  endRun();
  return { nonBlank, commentLines, maxRun };
}

// A `#` inside a block scalar (`run: |`) is embedded-language content, not YAML comment mass.
export function classifyYaml(src) {
  const lines = src.split(/\r?\n/);
  let nonBlank = 0;
  let commentLines = 0;
  let maxRun = 0;
  let run = 0;
  let blockIndent = null;
  lines.forEach((line, idx) => {
    const t = line.trim();
    const indent = line.length - line.trimStart().length;
    if (t === '') {
      if (run > maxRun) maxRun = run;
      run = 0;
      return;
    }
    if (blockIndent !== null) {
      if (indent > blockIndent) {
        nonBlank++;
        if (run > maxRun) maxRun = run;
        run = 0;
        return;
      }
      blockIndent = null;
    }
    nonBlank++;
    if (t.startsWith('#') && !(idx === 0 && t.startsWith('#!'))) {
      commentLines++;
      run++;
      if (run > maxRun) maxRun = run;
    } else {
      if (/[|>][+-]?\s*$/.test(t)) blockIndent = indent;
      if (run > maxRun) maxRun = run;
      run = 0;
    }
  });
  if (run > maxRun) maxRun = run;
  return { nonBlank, commentLines, maxRun };
}

function* walk(dir, filter) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, filter);
    else if (filter(p)) yield p;
  }
}

// Scope is git-TRACKED files only: gitignored local renders (e.g. this repo's unarmed
// waffle-label-hook.yml) are absent in CI checkouts and worktrees; their stack sources gate them.
function trackedSet() {
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return new Set(res.stdout.split('\0').filter(Boolean));
}

function scopedFiles() {
  const tracked = trackedSet();
  const isTracked = (p) => tracked === null || tracked.has(rel(p));
  const mjs = [
    ...walk(path.join(ROOT, 'installer'), (p) => p.endsWith('.mjs')),
    ...walk(path.join(ROOT, 'stacks'), (p) => p.endsWith('.mjs')),
  ].filter(isTracked);
  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  const yml = [
    ...fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => path.join(workflowsDir, f)),
    ...walk(path.join(ROOT, 'stacks'), (p) => /files[\\/]\.github[\\/]workflows[\\/].+\.yml$/.test(p)),
  ].filter(isTracked);
  return { mjs, yml };
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function ceilingFor(relPath) {
  return relPath.startsWith('stacks/') && relPath.endsWith('.mjs') ? STACKS_MJS_PCT : DEFAULT_PCT;
}

describe('comment gate (DECISIONS.md #388)', () => {
  const { mjs, yml } = scopedFiles();
  const all = [
    ...mjs.map((p) => ({ p, classify: classifyMjs })),
    ...yml.map((p) => ({ p, classify: classifyYaml })),
  ];

  test('every in-scope file is within its comment ceiling', () => {
    for (const { p, classify } of all) {
      const r = rel(p);
      const { nonBlank, commentLines, maxRun } = classify(fs.readFileSync(p, 'utf8'));
      const pct = nonBlank ? (100 * commentLines) / nonBlank : 0;
      const entry = GRANDFATHERED[r];
      if (entry) {
        assert.ok(
          pct <= entry.pct,
          `${r}: comment ratio ${pct.toFixed(1)}% exceeds its grandfathered ceiling ${entry.pct}% — ` +
            `shrink comments, don't grow them (comments are not spec, DECISIONS.md #388)`,
        );
        assert.ok(
          maxRun <= entry.run,
          `${r}: comment run of ${maxRun} lines exceeds its grandfathered max ${entry.run} — ` +
            `shrink comments, don't grow them (comments are not spec, DECISIONS.md #388)`,
        );
        assert.ok(
          entry.pct - pct <= MAX_SLACK_PCT,
          `${r}: ratio is ${pct.toFixed(1)}% but its grandfathered ceiling is ${entry.pct}% — ` +
            `tighten or delete the GRANDFATHERED entry so the ratchet holds`,
        );
      } else {
        assert.ok(
          commentLines <= SMALL_FILE_LINES || pct <= ceilingFor(r),
          `${r}: comment ratio ${pct.toFixed(1)}% exceeds the ${ceilingFor(r)}% ceiling — ` +
            `move rationale to DECISIONS.md, contracts to AGENTS.md, and delete the rest ` +
            `(comments are not spec, DECISIONS.md #388)`,
        );
        assert.ok(
          maxRun <= MAX_RUN,
          `${r}: ${maxRun} consecutive comment lines exceed the ${MAX_RUN}-line cap — ` +
            `an essay is litigation; the code and its tests are the spec (DECISIONS.md #388)`,
        );
      }
    }
  });

  test('GRANDFATHERED lists only files that still exist', () => {
    for (const r of Object.keys(GRANDFATHERED)) {
      assert.ok(
        fs.existsSync(path.join(ROOT, r)),
        `${r} is gone — delete its GRANDFATHERED entry`,
      );
    }
  });
});
