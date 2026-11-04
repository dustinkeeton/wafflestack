// Disposable toolkit + git fixtures for prepare-worktree: the test suite and the runtime smoke
// script build the same repositories, so what CI proves is what the harnesses are shown.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderProject } from '../lib/render.mjs';

export const VERSION = '0.0.test';

export function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
export const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
export const git = (cwd, ...args) =>
  spawnSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
export const porcelain = (cwd) => git(cwd, 'status', '--porcelain', '--untracked-files=all').stdout;

/** A one-stack toolkit: an agent, a skill with a helper script, a `.github/` payload, optionally a mod. */
export function makeToolkit(root, { mod = false } = {}) {
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: test fixture\nstacks: [demo]\n');
  write(root, 'package.json', `{"name":"fixture","version":"${VERSION}","repository":"https://github.com/example/fixture.git"}`);
  write(root, 'stacks/demo/stack.yaml', [
    'name: demo', 'description: Demo.', 'agents: [helper]', 'skills: [greet]', 'files: [.github/workflows/demo.yml]',
    ...(mod ? ['mods: [example]'] : []),
    'config:', '  git.botEmail:', '    required: true', '    description: bot email',
    '  waffle.toolkitRef:', '    required: false', '    default: github:example/fixture#v1.0.0', '    description: pin', '',
  ].join('\n'));
  if (mod) write(root, 'stacks/demo/mods/example/.claude-plugin/plugin.json', '{"name":"example","version":"1.0.0","description":"fixture"}');
  write(root, 'stacks/demo/agents/helper.md', '---\nname: helper\ndescription: A helper.\n---\n\nCommit as {{git.botEmail}}.\n');
  write(root, 'stacks/demo/skills/greet/SKILL.md', '---\nname: greet\ndescription: Greets.\n---\n\nSay hi from {{git.botEmail}}.\n');
  write(root, 'stacks/demo/skills/greet/scripts/hello.sh', '#!/bin/sh\necho hi\n');
  write(root, 'stacks/demo/files/.github/workflows/demo.yml', 'name: demo\non: push\n');
}

/** A rendered, committed main checkout under Posture 2b (render gitignored, lock committed). */
export function makeMain({ targets = 'claude, codex', ignore = '.claude/\n.codex/\n.agents/\n', mod = false, custom = false } = {}) {
  const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-toolkit-'));
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-main-'));
  makeToolkit(toolkitRoot, { mod });
  write(main, '.waffle/waffle.yaml', `targets: [${targets}]\nstacks: [demo]\nconfig:\n  git:\n    botEmail: bot@example.com\n`);
  if (custom) {
    ignore = '.claude/skills/*\n!.claude/skills/custom/\n.claude/agents/\n.codex/\n.agents/\n';
    write(main, '.claude/skills/custom/SKILL.md', '---\nname: custom\ndescription: Project-owned custom skill.\n---\n\nCustom.\n');
  }
  write(main, '.gitignore', `${ignore}.waffle/waffle.local.yaml\n.waffle/waffle.local.lock.json\n`);
  git(main, 'init', '-q', '-b', 'main');
  const rendered = renderProject({ toolkitRoot, cwd: main, toolkitVersion: VERSION });
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  return { toolkitRoot, main: fs.realpathSync(main) };
}

/** `git worktree add` with a space in the path, outside the main checkout unless `nested`. */
export function addWorktree(main, { nested = false, name = 'wt one' } = {}) {
  const dir = nested ? path.join(main, '.claude', 'worktrees', name) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-')), name);
  const r = git(main, 'worktree', 'add', '-q', dir, '-b', `feat/${name.replace(/\s/g, '-')}`);
  assert.equal(r.status, 0, r.stderr);
  return fs.realpathSync(dir);
}
