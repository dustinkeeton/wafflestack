import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #820: the runtime smoke script runs in CI against stub harnesses, so its fixtures, its protocol
// handling and its pass/fail reading stay exercised without a model call.
const SMOKE = fileURLToPath(new URL('../smoke/worktree-discovery.mjs', import.meta.url));

function stub(dir, { claudeSkills, codexSkills }) {
  const bin = path.join(dir, 'runtime.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import readline from 'node:readline';
const out = (v) => console.log(JSON.stringify(v));
if (process.argv.includes('--version')) console.log('stub-runtime 1');
else if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const req = JSON.parse(line);
    if (req.id === 1) out({ id: 1, result: {} });
    if (req.id === 2) out({ id: 2, result: { data: [{ skills: ${JSON.stringify(codexSkills)}.map((name) => ({ name, path: process.cwd() + '/.agents/skills/' + name + '/SKILL.md' })) }] } });
  });
} else out({ type: 'system', subtype: 'init', skills: ${JSON.stringify(claudeSkills)}, agents: ['helper'] });
`, { mode: 0o755 });
  return bin;
}

describe('worktree-discovery smoke script (#820)', () => {
  for (const good of [true, false]) {
    test(`${good ? 'passes when both harnesses list the prepared skills' : 'fails when a harness misses one'}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-smoke-'));
      try {
        const bin = stub(dir, { claudeSkills: good ? ['greet', 'custom'] : ['custom'], codexSkills: ['greet'] });
        const r = spawnSync(process.execPath, [SMOKE], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, WAFFLE_CLAUDE_BIN: bin, WAFFLE_CODEX_BIN: bin } });
        assert.equal(r.status, good ? 0 : 1, r.stderr);
        const report = JSON.parse(r.stdout);
        assert.equal(report.ok, good);
        assert.deepEqual(report.states.map((s) => s.state), ['absent', 'empty', 'custom-only', 'partial', 'complete']);
        assert.ok(report.states.every((s) => s.codex.startsWith('pass')), JSON.stringify(report.states));
        assert.ok(report.states.every((s) => s.claude.startsWith(good ? 'pass' : 'FAIL: missing greet')), JSON.stringify(report.states));
        assert.equal(report.states[3].prepared, 'ready', 'partial: the helper was re-laid');
        assert.equal(report.states[4].prepared, 'no-op', 'complete: nothing to do');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
