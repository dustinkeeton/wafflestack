#!/usr/bin/env node
// Runtime acceptance for prepare-worktree (#820): build the test fixtures, prepare a worktree in each
// directory state, and ask the installed harnesses what they discover there. Discovery only — no
// model turn is submitted: Claude is stopped at its `system/init` event, Codex is asked over its
// app-server protocol. Prints one JSON report; exit 1 when a state fails. CI runs it against stub
// runtimes (worktree-smoke.test.mjs); a release records a real run in docs/.
//   WAFFLE_CLAUDE_BIN=claude WAFFLE_CODEX_BIN=codex node installer/smoke/worktree-discovery.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { prepareWorktree } from '../lib/worktree.mjs';
import { makeMain, addWorktree, VERSION } from '../test/prepare-fixture.mjs';

const claude = process.env.WAFFLE_CLAUDE_BIN ?? 'claude';
const codex = process.env.WAFFLE_CODEX_BIN ?? 'codex';
export const STATES = ['absent', 'empty', 'custom-only', 'partial', 'complete'];
const EXPECT = { skills: ['greet'], agents: ['helper'] };

function version(bin) {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch (err) {
    return `unavailable (${err.message.split('\n')[0]})`;
  }
}

/** Lines of JSON on a child's stdout, resolved by `pick`; the child is killed once it answers. */
function jsonLines(bin, args, cwd, { stdin = null, pick, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(bin)} did not answer within ${timeoutMs / 1000}s`)); }, timeoutMs);
    let pending = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => { if (code) { clearTimeout(timer); reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`)); } });
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const answer = pick(message, (/** @type {string} */ text) => child.stdin?.write(`${text}\n`));
        if (answer !== undefined) { clearTimeout(timer); child.kill(); resolve(answer); }
      }
    });
    if (stdin) child.stdin.write(`${stdin}\n`);
  });
}

/** Claude Code: the project skills and agents its startup roster lists for `cwd`. */
export function claudeRoster(cwd) {
  return jsonLines(claude, ['-p', 'Reply with the single word ok.', '--verbose', '--output-format', 'stream-json', '--max-turns', '1', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], cwd, {
    pick: (m) => (m.type === 'system' && m.subtype === 'init' ? { skills: m.skills ?? [], agents: m.agents ?? [] } : undefined),
  });
}

/** Codex: `skills/list` over the app-server protocol, reloaded, for `cwd`; skills with their paths. */
export function codexSkills(cwd) {
  return jsonLines(codex, ['app-server'], cwd, {
    stdin: JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'wafflestack-worktree-smoke', version: VERSION }, capabilities: { experimentalApi: true } } }),
    pick: (m, send) => {
      if (m.id === 1) {
        send(JSON.stringify({ method: 'initialized', params: {} }));
        send(JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } }));
        return undefined;
      }
      if (m.id !== 2) return undefined;
      if (m.error) throw new Error(`skills/list failed: ${JSON.stringify(m.error)}`);
      return (m.result?.data ?? []).flatMap((entry) => (entry.skills ?? []).map((s) => ({ name: s.name, path: s.path ?? null })));
    },
  });
}

/** Lay the fixture out in one of the five states and prepare it; returns the worktree path. */
export function stateWorktree(state) {
  const { toolkitRoot, main } = makeMain({ targets: 'claude, codex', custom: state === 'custom-only' });
  const wt = addWorktree(main, { nested: state === 'empty' });
  if (state === 'empty') fs.mkdirSync(path.join(wt, '.claude/skills'), { recursive: true });
  const prepare = () => prepareWorktree({ cwd: wt, toolkitRoot, toolkitVersion: VERSION });
  if (state === 'partial' || state === 'complete') {
    const r = prepare();
    if (r.status === 'failed') throw new Error(r.errors.join('\n'));
    if (state === 'partial') fs.rmSync(path.join(wt, '.agents/skills/greet/scripts/hello.sh'));
  }
  const r = prepare();
  if (r.status === 'failed') throw new Error(r.errors.join('\n'));
  return { wt, main, toolkitRoot, prepared: r.status };
}

async function main() {
  const report = { date: new Date().toISOString().slice(0, 10), versions: { claude: version(claude), codex: version(codex) }, states: [], ok: true };
  for (const state of STATES) {
    const { wt, prepared } = stateWorktree(state);
    const row = { state, prepared, claude: 'not run', codex: 'not run' };
    try {
      const roster = await claudeRoster(wt);
      const missing = [...EXPECT.skills.filter((s) => !roster.skills.includes(s)), ...EXPECT.agents.filter((a) => !roster.agents.includes(a))];
      row.claude = missing.length ? `FAIL: missing ${missing.join(', ')}` : `pass (${EXPECT.skills.join(', ')}; agent ${EXPECT.agents.join(', ')}${roster.skills.includes('custom') ? '; custom kept' : ''})`;
    } catch (err) {
      row.claude = `FAIL: ${err.message}`;
    }
    try {
      const skills = await codexSkills(wt);
      const inWorktree = skills.filter((s) => EXPECT.skills.includes(s.name) && s.path && fs.realpathSync(s.path).startsWith(wt));
      row.codex = inWorktree.length === EXPECT.skills.length ? `pass (${inWorktree.map((s) => s.name).join(', ')} from the worktree)` : `FAIL: worktree lists ${skills.filter((s) => s.path && fs.realpathSync(s.path).startsWith(wt)).map((s) => s.name).join(', ') || 'nothing'}`;
    } catch (err) {
      row.codex = `FAIL: ${err.message}`;
    }
    if (row.claude.startsWith('FAIL') || row.codex.startsWith('FAIL')) report.ok = false;
    report.states.push(row);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
