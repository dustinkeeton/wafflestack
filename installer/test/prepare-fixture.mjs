import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { prepareWorktree } from '../lib/prepare-worktree.mjs';
import { renderProject } from '../lib/render.mjs';
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const write = (root, p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
export function fixture(t, nested = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'main');
  const toolkit = path.join(dir, 'toolkit');
  fs.mkdirSync(root);
  write(toolkit, 'toolkit.yaml', 'name: fixture\nstacks: [demo]\n');
  write(toolkit, 'package.json', '{"name":"fixture","version":"1.0.0"}');
  write(toolkit, 'stacks/demo/stack.yaml', 'name: demo\nskills: [hello]\nagents: [worker]\nfiles: [".github/workflows/fixture.yml"]\nconfig:\n  greeting:\n    default: canonical\n');
  write(toolkit, 'stacks/demo/skills/hello/SKILL.md', '---\nname: hello\ndescription: A fixture skill\n---\n{{greeting}}\n');
  write(toolkit, 'stacks/demo/skills/hello/helper.mjs', 'export const hello = 1;\n');
  write(toolkit, 'stacks/demo/agents/worker.md', '---\nname: worker\ndescription: A fixture agent\n---\nSay {{greeting}}.\n');
  write(toolkit, 'stacks/demo/files/.github/workflows/fixture.yml', 'fixture: untouched\n');
  write(root, '.waffle/waffle.yaml', 'targets: [claude, codex, agents-dir]\nstacks: [demo]\n');
  write(root, '.gitignore', '.claude/skills/*\n!.claude/skills/custom/\n.claude/agents/*\n!.claude/agents/custom.md\n.agents/\n.codex/agents/\n.waffle/waffle.local.yaml\n.waffle/waffle.local.lock.json\nworktrees/\n');
  write(root, '.claude/skills/custom/SKILL.md', 'custom skill');
  write(root, '.claude/agents/custom.md', 'custom agent');
  git(root, 'init');
  const rendered = renderProject({ cwd: root, toolkitRoot: toolkit, toolkitVersion: '1.0.0' });
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  const wt = nested ? path.join(root, 'worktrees', 'with spaces') : path.join(dir, 'external with spaces');
  git(root, 'worktree', 'add', '-b', 'task', wt);
  const run = (extra = {}) => prepareWorktree({ cwd: wt, toolkitRoot: toolkit, resolveToolkit: () => ({ root: toolkit, pin: 'fixture#v1.0.0', version: '1.0.0' }), ...extra });
  return { root, toolkit, wt, run, dir };
}

