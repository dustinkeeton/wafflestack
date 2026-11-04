// The shipped `tstack` stack (#828, part of #825): `council` is upstream's bytes, renders byte-equal
// on every target, records its provenance in the lock, and stays clear of the #445 tool roster.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderProject, readLock } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { upstreamHash } from '../lib/upstream.mjs';
import { pinnedSkills, textAttrNotUnset } from '../lib/upstream-sync.mjs';
import { HARNESS_TOOLS, unknownToolCalls } from '../lib/harness-tools.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const COUNCIL = path.join(ROOT, 'stacks/tstack/skills/council');
const PIN = {
  repo: 't3dotgg/tstack',
  path: 'skills/council',
  commit: '1085050f3baed1ac724caa4a8166145fb2ac88af',
  license: 'MIT',
  hash: 'sha256:0335b6d2537bfda4f071e1213dc57af1c17d92a43d0562f5da0ebafe33dd86ed',
};
const FILES = ['LICENSE', 'SKILL.md'];

let roots = [];
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function project(extension) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tstack-render-'));
  roots.push(cwd);
  fs.mkdirSync(path.join(cwd, '.waffle/extensions/skills'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), YAML.stringify({ targets: ['claude', 'codex'], stacks: ['tstack'] }));
  if (extension) fs.writeFileSync(path.join(cwd, '.waffle/extensions/skills/council.md'), extension);
  const result = renderProject({ toolkitRoot: ROOT, cwd, toolkitVersion: '0.0.test', toolkitIdentity: null });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  return cwd;
}

const src = (rel) => fs.readFileSync(path.join(COUNCIL, rel));

describe('tstack stack: council ships upstream bytes (#828)', () => {
  test('the copy is exactly LICENSE + SKILL.md and hashes to the stack.yaml pin', () => {
    assert.deepEqual(fs.readdirSync(COUNCIL).sort(), FILES);
    const stack = loadToolkit(ROOT).stacks.get('tstack');
    const council = stack.skills.find((s) => s.name === 'council');
    const { isMap, unknownKeys, raw, ...pin } = council.upstream;
    assert.deepEqual(pin, PIN);
    assert.equal(upstreamHash(COUNCIL, council.files), PIN.hash);
  });

  test('the registry records the same provenance (no hash)', () => {
    const entry = YAML.parse(fs.readFileSync(path.join(ROOT, 'stacks/registry.yaml'), 'utf8')).waffles.find((e) => e.name === 'council');
    const { hash, ...identity } = PIN;
    assert.deepEqual(entry, { name: 'council', kind: 'skill', stack: 'tstack', path: 'stacks/tstack/skills/council', status: 'stable', upstream: identity });
  });

  test('renders byte-equal on claude and the cross-tool dir; the lock records the pin', () => {
    const cwd = project();
    for (const dir of ['.claude/skills/council', '.agents/skills/council']) {
      for (const rel of FILES) assert.ok(fs.readFileSync(path.join(cwd, dir, rel)).equals(src(rel)), `${dir}/${rel}`);
    }
    const files = ['.agents/skills/council/LICENSE', '.agents/skills/council/SKILL.md', '.claude/skills/council/LICENSE', '.claude/skills/council/SKILL.md'];
    const { hash, license, ...lockPin } = PIN;
    assert.deepEqual(readLock(cwd).upstream, [{ item: 'tstack/skills/council', ...lockPin, files }]);
  });

  test('a project extension appends after the exact copy bytes; LICENSE stays byte-equal', () => {
    const cwd = project('Local council note.\n');
    const skill = fs.readFileSync(path.join(cwd, '.claude/skills/council/SKILL.md'));
    assert.ok(skill.subarray(0, src('SKILL.md').length).equals(src('SKILL.md')));
    assert.match(skill.subarray(src('SKILL.md').length).toString(), /<!-- BEGIN project extension: [^\n]*council\.md -->\n[\s\S]*Local council note\.\n[\s\S]*<!-- END project extension -->\n$/);
    assert.ok(fs.readFileSync(path.join(cwd, '.claude/skills/council/LICENSE')).equals(src('LICENSE')));
  });

  test('the rendered council calls no tool outside the claude roster (#445)', () => {
    const cwd = project();
    assert.deepEqual(unknownToolCalls(fs.readFileSync(path.join(cwd, '.claude/skills/council/SKILL.md'), 'utf8'), HARNESS_TOOLS.claude), []);
  });

  test('every pinned copy is `-text` in .gitattributes, so git never eol-converts it', (t) => {
    const inTree = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    if (inTree.status !== 0) return t.skip('not a git work tree');
    for (const p of pinnedSkills(ROOT)) {
      const rel = p.files.map((f) => path.relative(ROOT, path.join(p.dir, f)).split(path.sep).join('/'));
      const dir = path.relative(ROOT, p.dir).split(path.sep).join('/');
      assert.deepEqual(textAttrNotUnset(ROOT, rel), [], `add \`${dir}/** -text\` to .gitattributes: ${p.ref} is hashed as raw bytes`);
    }
  });
});
