import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { collectConfig, queryConfig, formatConfig, nearestKey } from '../lib/config.mjs';
import { setupGuide } from '../lib/setup.mjs';
import { scaffoldConfig } from '../lib/eject.mjs';

// `wafflestack config [key-prefix]` (#701): the keys a selection can set, with value, source file,
// default and constraints — from the same catalog `setup` prints, so the two cannot drift.

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'installer', 'cli.mjs');

const write = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const runCli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd, '--offline'], { encoding: 'utf8', timeout: 60000 });
const skill = (name, body) => ['---', `name: ${name}`, `description: Skill ${name}.`, '---', '', body, ''].join('\n');

const LONG_DESC = `Long key. ${'This sentence pads the description well past any single line. '.repeat(6)}`;

function fixtureToolkit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-701-'));
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: x\nstacks: [a, b]\n');
  write(root, 'schema/SETUP.md', '# fixture playbook\n');
  write(root, 'stacks/a/stack.yaml', [
    'name: a',
    'description: Stack A.',
    'skills: [a1, a2]',
    'config:',
    '  shared.name:',
    '    required: true',
    '    description: The shared name.',
    '  a.num:',
    '    required: false',
    '    default: 11',
    '    range: { min: 0, max: 15 }',
    '    description: The upper number.',
    '  a.low:',
    '    required: false',
    '    default: 4',
    '    range: { min: 0, max: 15 }',
    '    description: The lower number.',
    '  a.gate:',
    '    required: false',
    '    default: prompt',
    '    modes: [true, false, prompt]',
    '    configModes: [false, prompt]',
    '    flag: { on: "+g", off: "-g" }',
    '    description: The gate.',
    '  a.long:',
    '    required: false',
    '    default: |-',
    '      line one',
    '      line two',
    '      line three',
    `    description: "${LONG_DESC}"`,
    '  a.tmpl:',
    '    required: false',
    '    default: "x-{{a.num}}"',
    '    description: A templated value.',
    '  a.ver:',
    '    required: false',
    '    default: "v{{harness.toolkitVersion}}"',
    '    description: A value built from the toolkit version.',
    '  a.wide:',
    '    required: false',
    `    default: "${'w'.repeat(120)}"`,
    '    description: A long single-line value.',
    '  a.only2:',
    '    required: false',
    '    default: two',
    '    description: Only a2 uses this.',
    'constraints:',
    '  - kind: lessThan',
    '    keys: [a.low, a.num]',
    '',
  ].join('\n'));
  write(root, 'stacks/a/skills/a1/SKILL.md', skill('a1', '{{shared.name}} {{a.num}} {{a.low}} {{a.gate}} {{a.long}} {{a.tmpl}} {{a.ver}} {{a.wide}}'));
  write(root, 'stacks/a/skills/a2/SKILL.md', skill('a2', '{{a.only2}}'));
  write(root, 'stacks/b/stack.yaml', [
    'name: b',
    'description: Stack B.',
    'skills: [b1]',
    'config:',
    '  shared.name:',
    '    required: false',
    '    default: fallback',
    '    description: A differently worded description.',
    '',
  ].join('\n'));
  write(root, 'stacks/b/skills/b1/SKILL.md', skill('b1', '{{shared.name}}'));
  return root;
}

const WAFFLE = 'targets: [claude]\nstacks: [b]\ninclude: [skills/a1]\n';

describe('config: lookup of keys, values and sources (#701)', () => {
  let toolkitRoot;
  let cwd;
  beforeEach(() => {
    toolkitRoot = fixtureToolkit();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-'));
    write(cwd, '.waffle/waffle.yaml', WAFFLE);
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
  });

  const collect = () => collectConfig({ cwd, toolkitRoot, toolkitVersion: '0.0.test' });
  const keyOf = (model, key) => model.keys.find((k) => k.key === key);
  const run = (arg) => {
    const r = queryConfig(collect(), arg);
    return r.error === undefined ? { out: formatConfig(r) } : { error: r.error };
  };

  test('lists exactly the keys setup scopes for the selection', () => {
    const keys = collect().keys.map((k) => k.key);
    assert.deepEqual(keys, ['a.gate', 'a.long', 'a.low', 'a.num', 'a.tmpl', 'a.ver', 'a.wide', 'shared.name']);
    const guide = setupGuide(toolkitRoot, '0.0.test', cwd);
    const section = guide.slice(guide.indexOf('## Config values'), guide.indexOf('## Required keys still unset'));
    const setupKeys = [...section.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(setupKeys)].sort(), keys);
    assert.ok(!keys.includes('a.only2') && !setupKeys.includes('a.only2'), 'a2 is not selected');
    assert.match(guide, /## Required keys still unset[^]*- ⚠ a: config\.shared\.name/);
  });

  test('source distinguishes default, waffle.yaml and waffle.local.yaml', () => {
    assert.match(run('a').out, /^a\.num = 11 {3}\[default\]$/m);
    write(cwd, '.waffle/waffle.yaml', `${WAFFLE}config:\n  a:\n    num: 9\n`);
    assert.equal(keyOf(collect(), 'a.num').source, 'waffle.yaml');
    assert.match(run('a.num').out, /^source: waffle\.yaml$/m);
    write(cwd, '.waffle/waffle.local.yaml', 'config:\n  a:\n    num: 7\n');
    const both = keyOf(collect(), 'a.num');
    assert.equal(both.value, 7, 'the overlay wins');
    assert.equal(both.source, 'waffle.local.yaml');
    write(cwd, '.waffle/waffle.yaml', WAFFLE);
    assert.match(run('a').out, /^a\.num = 7 {3}\[waffle\.local\.yaml\]$/m);
  });

  test('constraints: range, cross-key, configModes and flag tokens', () => {
    const out = run('a').out;
    assert.match(out, /default: 11 · range: 0–15 · constraint: > a\.low · stack: a/);
    assert.match(out, /range: 0–15 · constraint: < a\.num/);
    assert.match(out, /config may set: false\|prompt · flag: \+g \/ -g/);
    assert.doesNotMatch(out, /modes: true/, 'configModes, not modes, is what config may set');
  });

  test('disagreeing multi-stack declarations are surfaced, unset or set', () => {
    const unset = run('shared.name').out;
    assert.match(unset, /declarations disagree/);
    assert.match(unset, /^ {2}a: required, no default → \(unset\)$/m);
    assert.match(unset, /^ {2}b: optional, default fallback → fallback$/m);
    assert.match(unset, /^required: yes ⚠ \(unset — render blocker\)$/m, 'a cannot render it');
    assert.match(run().out, /^shared\.name = fallback {3}\[required ⚠\]$/m);
    write(cwd, '.waffle/waffle.yaml', `${WAFFLE}config:\n  shared:\n    name: Mine\n`);
    const set = run().out;
    assert.match(set, /^shared\.name = Mine {3}\[waffle\.yaml\]$/m);
    assert.match(set, /declarations disagree/);
  });

  test('declarations differing only in description are not a conflict', () => {
    const yaml = path.join(toolkitRoot, 'stacks/b/stack.yaml');
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8').replace('    required: false\n    default: fallback\n', '    required: true\n'));
    const k = keyOf(collect(), 'shared.name');
    assert.equal(k.conflict, false);
    assert.deepEqual(k.decls.map((d) => d.stackName), ['b', 'a']);
    assert.doesNotMatch(run('shared').out, /disagree/);
  });

  test('a prefix filters at segment boundaries; a near miss gets a hint', () => {
    const out = run('a').out;
    assert.match(out, /^7 config key\(s\) under `a`/);
    assert.doesNotMatch(out, /shared\.name/);
    assert.equal(run('a.n').error, 'unknown config key or prefix `a.n` — did you mean `a.num`?');
    assert.equal(nearestKey('zzzzzz', ['a.num']), null);
    assert.equal(nearestKey('x', ['pm']), null, 'a short query never gets an unrelated key');
    assert.equal(nearestKey('a.', ['pm']), null);
  });

  test('unknown, out-of-scope, harness.* and a leading config. prefix', () => {
    assert.match(run('nope.nothing').error, /^unknown config key or prefix `nope\.nothing`$/);
    assert.match(run('a.only2').error, /declared by stack\(s\) a but nothing in this selection references it/);
    assert.match(run('harness.agentsDir').error, /The `harness\.\*` namespace/);
    assert.match(run('config.a.num').out, /^a\.num\n/);
  });

  test('a templated value shows its expansion', () => {
    assert.match(run('a.tmpl').out, /^expands to: x-11$/m);
    assert.match(run('a.ver').out, /^expands to: v0\.0\.test$/m, 'harness.toolkitVersion resolves');
  });

  test('long text: a one-line summary in the list, the full text on an exact lookup', () => {
    const list = run('a').out;
    const block = list.slice(list.indexOf('a.long ='));
    assert.match(block, /^a\.long = \(multi-line, 3 lines — wafflestack config a\.long\) {3}\[default\]$/m);
    assert.match(list, /^a\.wide = \(120 chars — wafflestack config a\.wide\) {3}\[default\]$/m);
    for (const line of list.split('\n')) assert.ok(line.length <= 112, `too long: ${line}`);
    assert.match(run('a.wide').out, new RegExp(`^value: ${'w'.repeat(120)}$`, 'm'));
    const detail = run('a.long').out;
    assert.match(detail, /^default:\n {4}line one\n {4}line two\n {4}line three$/m);
    assert.ok(detail.replace(/\s+/g, ' ').includes(LONG_DESC.trim()), 'the whole description');
  });
});

describe('config: CLI (#701)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-config-cli-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const snapshot = () => fs.readdirSync(cwd, { recursive: true }).sort();

  test('no waffle.yaml exits 1 pointing at setup, writing nothing', () => {
    const r = runCli(['config'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /setup/);
    assert.deepEqual(snapshot(), []);
  });

  test('lists, looks up and rejects against the real toolkit, read-only', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [harness-architect]\n');
    const before = snapshot();
    const list = runCli(['config'], cwd);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^project\.longName = this project {3}\[default\]$/m);
    const bad = runCli(['config', 'project.longNam'], cwd);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /did you mean `project\.longName`\?/);
    const two = runCli(['config', 'a', 'b'], cwd);
    assert.equal(two.status, 1);
    assert.match(two.stderr, /at most one key or prefix/);
    assert.deepEqual(snapshot(), before, 'config writes nothing');
  });

  test('the starter config points at the command and still parses', () => {
    scaffoldConfig({ cwd });
    const text = fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8');
    assert.match(text, /wafflestack config \[key-prefix\]/);
    assert.equal(YAML.parse(text).config, null);
  });
});
