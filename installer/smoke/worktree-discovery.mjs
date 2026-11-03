import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fixture } from '../test/prepare-fixture.mjs';

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
    const codexReply = execFileSync(codex, ['exec', '--ephemeral', '--json', '--sandbox', 'read-only', '-c', `projects.${JSON.stringify(fs.realpathSync(f.wt))}.trust_level="trusted"`, 'Invoke the custom worker agent exactly once with spawn_agent agent_type worker. Ask it to follow its agent instructions and reply with only the requested word. Wait for completion and report its reply. Do not edit files.'], { cwd: f.wt, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(codexReply, /spawn_agent/);
    assert.match(codexReply, /canonical/i);
    report.invocation.codex = 'pass: custom worker spawn and canonical response';
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const fn of cleanup.reverse()) fn();
}
