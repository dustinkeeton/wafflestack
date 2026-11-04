import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fixture, git, write } from '../test/prepare-fixture.mjs';
import { renderProject } from '../lib/render.mjs';

const codex = process.env.WAFFLE_CODEX_BIN ?? 'codex';
const claude = process.env.WAFFLE_CLAUDE_BIN ?? 'claude';
const cleanup = [];
const t = { after: (fn) => cleanup.push(fn) };
const report = { date: new Date().toISOString().slice(0, 10), versions: {}, discovery: [], invocation: {} };

function rpcSkills(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(codex, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex discovery timed out')); }, 30000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`runtime exited with code ${code}`)); } });
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } }) + '\n');
        }
        if (message.id === 2) { clearTimeout(timer); child.kill(); message.error ? reject(new Error('Codex skills/list failed')) : resolve(message.result); }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'waffle-worktree-smoke', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
  });
}

function claudeInit(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(claude, ['--print', 'Reply OK.', '--verbose', '--output-format', 'stream-json', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude startup timed out')); }, 30000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`runtime exited with code ${code}`)); } });
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'system' && message.subtype === 'init') { clearTimeout(timer); child.kill(); resolve(message); }
      }
    });
  });
}

try {
  report.versions.codex = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
  report.versions.claude = execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim();
  for (const state of ['absent', 'empty', 'custom-only', 'partial', 'complete']) {
    const f = fixture(t, state === 'empty');
    if (state === 'absent' || state === 'empty') {
      fs.rmSync(path.join(f.wt, '.claude'), { recursive: true });
      if (state === 'empty') fs.mkdirSync(path.join(f.wt, '.claude/skills'), { recursive: true });
    }
    if (state === 'partial' || state === 'complete') {
      assert.equal(f.run().status, 'ready');
      if (state === 'partial') fs.unlinkSync(path.join(f.wt, '.agents/skills/hello/helper.mjs'));
    }
    assert.notEqual(f.run().status, 'failed');
    const skills = await rpcSkills(f.wt);
    assert.ok(skills.data.some((entry) => entry.skills.some((skill) => skill.name === 'hello' && fs.realpathSync(skill.path).startsWith(fs.realpathSync(f.wt)))));
    const init = await claudeInit(f.wt);
    assert.ok(init.slash_commands.includes('hello'));
    assert.ok(init.agents.includes('worker'));
    report.discovery.push({ state, codexSkills: 'pass', claudeSkillsAndAgentRoster: 'pass' });
  }
  report.invocation = { claude: 'not run (startup discovery only)', codex: 'not run (skills/list is not agent invocation)' };
  if (process.argv.includes('--invoke')) {
    const f = fixture(t);
    assert.equal(f.run().status, 'ready');
    const claudeReply = execFileSync(claude, ['--print', 'Follow your agent instructions. Reply with only the requested word.', '--agent', 'worker', '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', ''], { cwd: f.wt, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(claudeReply, /canonical/i);
    report.invocation.claude = 'pass: --agent worker returned canonical';
    const name = 'waffle_invocation_probe';
    const nonce = `waffle-proof-${randomBytes(16).toString('hex')}`;
    const manifest = path.join(f.toolkit, 'stacks/demo/stack.yaml');
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('agents: [worker]', `agents: [${name}]`));
    write(f.toolkit, `stacks/demo/agents/${name}.md`, `---\nname: ${name}\ndescription: A named agent for verifying worktree preparation.\n---\nRespond with exactly ${nonce} and nothing else. Do not use tools or read files.\n`);
    const rendered = renderProject({ cwd: f.wt, toolkitRoot: f.toolkit, toolkitVersion: '1.0.0' });
    assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
    git(f.wt, 'add', '.waffle/waffle.lock.json'); git(f.wt, 'commit', '-m', 'pin unique probe agent');
    for (const dir of ['.claude/agents', '.codex/agents', '.agents/agents']) fs.rmSync(path.join(f.wt, dir), { recursive: true, force: true });
    assert.equal(f.run().status, 'ready');
    const prompt = `Use the installed custom agent named ${name} for one task: ask it to follow its configured instructions and return its response. Wait for it to finish and report its response verbatim. Use the normal named-agent workflow available in this client; no particular tool or parameter is prescribed. Do not read files, run shell commands, or copy agent instructions into the task. Do not substitute a generic agent. If the named agent cannot be invoked, explain what prevented it.`;
    const codexReply = execFileSync(codex, ['exec', '--json', '--sandbox', 'read-only', '-c', `projects.${JSON.stringify(fs.realpathSync(f.wt))}.trust_level="trusted"`, prompt], { cwd: f.wt, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
    const events = codexReply.trim().split('\n').map((line) => JSON.parse(line));
    const completed = events.filter((event) => event.type === 'item.completed').map((event) => event.item);
    const spawned = completed.some((item) => item.type === 'collab_tool_call' && item.tool === 'spawn_agent' && item.status === 'completed' && item.receiver_thread_ids?.length);
    const replied = completed.some((item) => item.type === 'agent_message' && item.text.includes(nonce));
    const fileAccess = completed.some((item) => ['command_execution', 'mcp_tool_call', 'file_change'].includes(item.type));
    report.invocation.codexProbe = { agentName: name, method: 'natural-language named-agent request; no prescribed tool parameter', expectedResponse: nonce, completedSpawn: spawned, responseMatched: replied, fileAccessObserved: fileAccess };
    if (spawned && replied && !fileAccess) report.invocation.codex = 'pass: named custom agent spawned and returned its private response string';
    else {
      report.invocation.codex = 'failed: no verified named-agent invocation in the tested CLI configuration';
      report.invocation.codexProbe.runtimeResponse = completed.filter((item) => item.type === 'agent_message').map((item) => item.text).join('\n');
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const fn of cleanup.reverse()) fn();
}
