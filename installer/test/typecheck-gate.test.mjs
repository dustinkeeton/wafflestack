import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the typecheck gate itself (#177): under `checkJs: false`, a deleted `// @ts-check` pragma
// leaves `npm run typecheck` green while checking nothing. Delete this test with the `checkJs: true` flip.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every file migrated so far — repo-relative. Append here as waves land.
const MIGRATED = [
  'installer/lib/util.mjs',
  'installer/lib/toolkit.mjs',
  'installer/lib/refs.mjs',
  'installer/lib/project.mjs',
  'installer/lib/toolkit-ref.mjs',
];

describe('typecheck gate (#177)', () => {
  test('every migrated file carries // @ts-check on line 1', () => {
    for (const rel of MIGRATED) {
      const firstLine = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/, 1)[0];
      assert.equal(firstLine.trim(), '// @ts-check', `${rel} must start with // @ts-check`);
    }
  });

  test('the tsc program actually contains the migrated files', (t) => {
    // tsc is a devDependency agents often run without — skip, never fail; CI installs it, so this runs where it matters.
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
