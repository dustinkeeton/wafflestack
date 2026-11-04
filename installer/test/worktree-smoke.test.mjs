import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const smoke = fileURLToPath(new URL('../smoke/worktree-discovery.mjs', import.meta.url));
for (const generic of [false, true]) test(`runtime smoke ${generic ? 'rejects generic fallback' : 'accepts completed spawn evidence'} without model calls`, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-smoke-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'runtime.mjs');
  fs.writeFileSync(stub, `#!/usr/bin/env node
import readline from 'node:readline';
const send = (v) => console.log(JSON.stringify(v));
if (process.argv.includes('--version')) console.log('fixture-runtime 1');
else if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === 1) send({ id: 1, result: {} });
    if (request.id === 2) send({ id: 2, result: { data: [{ skills: [{ name: 'hello', path: process.cwd() + '/.agents/skills/hello/SKILL.md' }] }] } });
  });
} else if (process.argv.includes('stream-json')) {
  send({ type: 'system', subtype: 'init', slash_commands: ['hello'], agents: ['worker'] });
} else if (process.argv.includes('--agent')) console.log('canonical');
else if (process.argv.includes('exec')) {
  if (!${generic}) send({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['fixture-child'] } });
  send({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(generic ? 'The tool has no agent_type selector; a generic spawn_agent replied canonical.' : 'canonical')} } });
}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [smoke, '--invoke'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, WAFFLE_CODEX_BIN: stub, WAFFLE_CLAUDE_BIN: stub },
  });
  assert.equal(result.status, generic ? 1 : 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.invocation.claude, /^pass:/);
  assert.match(report.invocation.codex, generic ? /^failed:/ : /^pass:/);
  assert.equal(report.discovery.length, 5);
});
