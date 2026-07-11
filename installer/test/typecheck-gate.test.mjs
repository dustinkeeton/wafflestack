import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the JSDoc typecheck gate itself (#177, PR #293 review F1). The gate's design —
// `checkJs: false` with per-file `// @ts-check` pragmas — has exactly one silent failure
// mode: a deleted pragma (or a broken `include` glob) leaves `npm run typecheck` green while
// checking nothing. This test pins both halves so the net can't quietly go empty during the
// wave-by-wave migration. Each wave appends its files to MIGRATED; the close-out PR that
// flips `checkJs: true` and deletes the pragmas deletes this test with them.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every file migrated so far — repo-relative. Append here as waves land.
const MIGRATED = [
  'installer/lib/util.mjs',
  'installer/lib/toolkit.mjs',
  'installer/lib/refs.mjs',
  'installer/lib/project.mjs',
];

describe('typecheck gate (#177)', () => {
  test('every migrated file carries // @ts-check on line 1', () => {
    for (const rel of MIGRATED) {
      const firstLine = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/, 1)[0];
      assert.equal(firstLine.trim(), '// @ts-check', `${rel} must start with // @ts-check`);
    }
  });

  test('the tsc program actually contains the migrated files', (t) => {
    // `typescript` is a devDependency, and `npm test` deliberately does not require it —
    // harness agents run the suite in checkouts without devDependencies installed. Skip
    // (never fail) when tsc is absent; CI always installs it via `npm ci`, so the gate
    // half of this test always runs where it matters.
    const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tscBin)) {
      t.skip('typescript devDependency not installed — tsc program check runs in CI');
      return;
    }
    const res = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json', '--listFilesOnly'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `tsc --listFilesOnly failed:\n${res.stderr}`);
    const listed = new Set(
      res.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((p) => path.relative(ROOT, path.resolve(p)).split(path.sep).join('/')),
    );
    for (const rel of MIGRATED) {
      assert.ok(listed.has(rel), `${rel} is not in the tsc program — check tsconfig.json "include"`);
    }
  });
});
