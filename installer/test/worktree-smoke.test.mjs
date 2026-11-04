import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const smoke = fileURLToPath(new URL('../smoke/worktree-discovery.mjs', import.meta.url));
for (const scenario of ['named-agent', 'generic-fallback', 'wrong-response', 'no-spawn', 'file-access']) test(`runtime smoke validates ${scenario} evidence without model calls`, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-smoke-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, 'runtime.mjs');
  fs.writeFileSync(stub, `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
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
  const definition = fs.readFileSync('.codex/agents/waffle_invocation_probe.toml', 'utf8');
  const response = definition.match(/waffle-proof-[a-f0-9]{32}/)?.[0];
  if (!response || process.argv.some(arg => arg.includes(response))) throw new Error('probe response must come only from the installed agent definition');
  const scenario = ${JSON.stringify(scenario)};
  if (scenario !== 'generic-fallback' && scenario !== 'no-spawn') send({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: ['fixture-child'] } });
  if (scenario === 'file-access') send({ type: 'item.completed', item: { type: 'command_execution', command: 'cat .codex/agents/waffle_invocation_probe.toml' } });
  const text = scenario === 'generic-fallback' ? 'A generic agent replied canonical.' : scenario === 'wrong-response' ? 'canonical' : response;
  send({ type: 'item.completed', item: { type: 'agent_message', text } });
}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [smoke, '--invoke'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, WAFFLE_CODEX_BIN: stub, WAFFLE_CLAUDE_BIN: stub },
  });
  const passes = scenario === 'named-agent';
  assert.equal(result.status, passes ? 0 : 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.match(report.invocation.claude, /^pass:/);
  assert.match(report.invocation.codex, passes ? /^pass:/ : /^failed:/);
  assert.equal(report.invocation.codexProbe.completedSpawn, !['generic-fallback', 'no-spawn'].includes(scenario));
  assert.equal(report.invocation.codexProbe.responseMatched, !['generic-fallback', 'wrong-response'].includes(scenario));
  assert.equal(report.invocation.codexProbe.fileAccessObserved, scenario === 'file-access');
  assert.equal(report.discovery.length, 5);
});
