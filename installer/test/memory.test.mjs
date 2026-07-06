import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The delegate run-memory validator (memory.mjs) lives beside its SKILL.md in the
// orchestration stack and is copied verbatim into a consumer's .claude/skills/delegate/.
// These tests exercise the source script directly: they prove a well-formed, within-cap
// doc passes, that a missing doc is valid (fresh repo), and that each thing the doc must
// guarantee — staying under the byte cap, and every entry carrying its Why / Since / Area —
// stops the run (exit 1) when violated.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../stacks/orchestration/skills/delegate/memory.mjs');

const BASE = `# Delegate run memory — testrepo

> Curated, capped (see delegate.memoryMaxBytes). Prune stale entries; never blind-append.

## Setup step \`npm run seed\` flakes on a cold checkout
- **Why:** Agents burn a cycle when it fails; re-running once clears it.
- **Since:** #42 — the summarize agent hit it twice.
- **Area:** summarize

## Issues touching \`shared/\` must serialize behind the config refactor
- **Why:** Parallel edits collide on the same export map.
- **Since:** #55, PR #61 — two worktrees conflicted.
- **Area:** shared
`;

describe('delegate run-memory validator', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Runs the validator. `doc === null` means "don't create the file" (missing-file case).
  const run = (doc, { maxBytes, file } = {}) => {
    const target = file || path.join(dir, 'memory.md');
    if (doc !== null) fs.writeFileSync(target, doc);
    const args = [SCRIPT, '--file', target];
    if (maxBytes !== undefined) args.push('--max-bytes', String(maxBytes));
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
  };

  test('a well-formed, within-cap doc passes and reports its entry count', () => {
    const r = run(BASE, { maxBytes: 4096 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /is valid — 2 entries/);
  });

  test('a missing doc is valid (fresh repo, nothing learned yet)', () => {
    const r = run(null, { maxBytes: 4096, file: path.join(dir, 'does-not-exist.md') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /does not exist yet/);
  });

  test('an empty doc is valid (header-only, zero entries)', () => {
    const r = run('# Delegate run memory\n\n> nothing yet\n', { maxBytes: 4096 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0 entries/);
  });

  test('exceeding the byte cap stops the run', () => {
    const r = run(BASE, { maxBytes: 200 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /over the size cap/);
    assert.match(r.stderr, /exceeds the 200-byte limit/);
  });

  test('an entry missing **Why** stops the run', () => {
    const doc = BASE.replace('- **Why:** Agents burn a cycle when it fails; re-running once clears it.\n', '');
    const r = run(doc, { maxBytes: 4096 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required field \*\*Why:\*\*/);
  });

  test('an entry missing **Since** stops the run', () => {
    const doc = BASE.replace('- **Since:** #42 — the summarize agent hit it twice.\n', '');
    const r = run(doc, { maxBytes: 4096 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required field \*\*Since:\*\*/);
  });

  test('an entry missing **Area** stops the run', () => {
    const doc = BASE.replace('- **Area:** summarize\n', '');
    const r = run(doc, { maxBytes: 4096 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing required field \*\*Area:\*\*/);
  });

  test('a **Since** with no #N anchor stops the run (staleness must be judgeable)', () => {
    const doc = BASE.replace('- **Since:** #42 — the summarize agent hit it twice.', '- **Since:** learned a while ago');
    const r = run(doc, { maxBytes: 4096 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must reference the issue\/PR that taught it/);
  });

  test('an empty field value stops the run', () => {
    const doc = BASE.replace('- **Why:** Agents burn a cycle when it fails; re-running once clears it.', '- **Why:**');
    const r = run(doc, { maxBytes: 4096 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\*\*Why:\*\* is empty/);
  });

  test('H3 sub-headings are not mistaken for entries', () => {
    // A #### note inside an entry must not start a new (fieldless) entry.
    const doc = `# Memory

## A real lesson
- **Why:** it matters.
- **Since:** #7.
- **Area:** core

### a sub-note, not an entry
some prose
`;
    const r = run(doc, { maxBytes: 4096 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 entry,/);
  });

  test('defaults to a 4096-byte cap when --max-bytes is omitted', () => {
    const r = run(BASE);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\/4096 bytes/);
  });

  test('a non-numeric --max-bytes is rejected', () => {
    const r = run(BASE, { maxBytes: 'lots' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--max-bytes must be a positive integer/);
  });

  test('--file is required', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--max-bytes', '4096'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--file is required/);
  });

  test('an unknown argument is rejected', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--file', 'x', '--bogus'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown argument/);
  });
});
