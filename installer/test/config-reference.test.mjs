import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CONFIG_REFERENCE, configReferenceYaml, generateConfigReference } from '../lib/config-reference.mjs';
import { configCatalog, mergeCatalog } from '../lib/config-catalog.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { computeSelection } from '../lib/refs.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { deepMerge, lookupPath } from '../lib/util.mjs';

// `.waffle/waffle.reference.yaml` (#703): `## ` lines are notes, `# ` lines are YAML.

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const write = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

/** Strip exactly one leading `# ` from YAML lines; drop `## ` notes. */
const uncomment = (lines) => lines.filter((l) => l.startsWith('# ')).map((l) => l.slice(2)).join('\n');

/** The `# config:` tree split into its top-level blocks, each as lines. */
function blocks(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('# config:');
  assert.ok(start >= 0, 'the file has a `# config:` tree');
  const out = [];
  const topComment = (l) => /^# {3}# /.test(l);
  for (const l of lines.slice(start + 1)) {
    if (!l) continue;
    const top = /^# {3}\S/.test(l) || topComment(l);
    if (!out.length || (top && !topComment(out.at(-1).at(-1)))) out.push([l]);
    else out.at(-1).push(l);
  }
  return out;
}

/** Every scalar/list leaf of a parsed config, as `[dottedKey, value]`. */
function leaves(obj, prefix = '') {
  return Object.entries(obj ?? {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? leaves(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]],
  );
}

const mk = (key, spec, { stacks = ['s'], conflict = false } = {}) => ({
  key,
  required: !!spec.required,
  conflict,
  decls: stacks.map((stackName) => ({ stackName, spec })),
  value: 'NEVER_READ',
  set: true,
  source: 'waffle.local.yaml',
});

describe('configReferenceYaml (formatter)', () => {
  const merged = [
    mk('a.auto', { default: true, modes: [true, false, 'prompt'], configModes: [false, 'prompt'], description: 'Outside.' }),
    mk('a.gate', { default: 'prompt', modes: [true, false, 'prompt'], configModes: [false, 'prompt'], description: 'The gate. More.' }),
    mk('a.long', { default: 'x'.repeat(120), description: 'Long.' }),
    mk('a.lock', { default: 'prompt', modes: [true, false, 'prompt'], lockMode: 'prompt', flag: { on: '+x' }, description: 'Locked.' }),
    mk('a.multi', { default: 'one\ntwo\nthree', description: 'Multi.' }),
    mk('a.need', { required: true, description: 'Needed. Detail.' }, { stacks: ['s', 't'] }),
    mk('a.path', { default: '{{a.dir}}/x', description: 'Templated.' }),
    mk('a.split', { default: 1, description: 'Disagrees.' }, { conflict: true }),
    mk('b', { default: 3, description: 'Leaf and prefix.' }),
    mk('b.c', { default: true, description: 'Child.' }),
    mk('c.list', { default: ['x', 'y'], description: 'List.' }),
    mk('c.none', { description: 'Optional.' }),
    mk('c.odd', { default: { k: undefined }, description: 'No round-trip.' }),
  ];
  const text = configReferenceYaml(merged);

  test('null when no key is in scope', () => {
    assert.equal(configReferenceYaml([]), null);
  });

  test('required keys with no default are listed under Must set, never as values', () => {
    assert.match(text, /^## Must set/m);
    assert.match(text, /^## {3}a\.need — Needed\. \[s, t\]$/m);
    assert.doesNotMatch(text, /^# .*need:/m);
  });

  test('lockMode keys are listed under Locked and left out of the tree', () => {
    assert.match(text, /^## {3}a\.lock = "prompt" \(flag: \+x\) \[s\]$/m);
    assert.doesNotMatch(text, /^# .*\block:/m);
  });

  test('multi-line, conflicting, no-default and leaf-and-prefix keys are comment-only pointers', () => {
    assert.match(text, /^# {5}# multi: \(multi-line default, 3 lines — wafflestack config a\.multi\)$/m);
    assert.match(text, /^# {5}# split: \(declarations disagree — wafflestack config a\.split\)$/m);
    assert.match(text, /^# {5}# none: \(optional, no default — wafflestack config c\.none\)$/m);
    assert.match(text, /^# {3}# b: \(also a prefix of other keys — wafflestack config b\)$/m);
    assert.match(text, /^# {5}# long: \(default is 122 chars — wafflestack config a\.long\)$/m);
    assert.match(text, /^# {5}# odd: \(default does not round-trip as YAML — wafflestack config c\.odd\)$/m);
  });

  test('a default outside configModes is a pointer, never a value doctor would reject', () => {
    assert.match(text, /^# {5}# auto: \(default is outside configModes — wafflestack config a\.auto\)$/m);
    const cfg = YAML.parse(uncomment(text.split('\n'))).config;
    assert.ok(!('auto' in cfg.a));
    assert.ok(!('long' in cfg.a));
    assert.ok(!('odd' in cfg.c));
  });

  test('templated defaults keep the raw template; configModes keys show an accepted value', () => {
    const cfg = YAML.parse(uncomment(text.split('\n'))).config;
    assert.equal(cfg.a.path, '{{a.dir}}/x');
    assert.equal(cfg.a.gate, 'prompt');
    assert.match(text, /config may set: false\|prompt/);
    assert.deepEqual(cfg.c.list, ['x', 'y']);
    assert.equal(cfg.b.c, true);
  });

  test('never reads a resolved value, and is deterministic', () => {
    assert.doesNotMatch(text, /NEVER_READ/);
    assert.equal(configReferenceYaml(merged), text);
  });
});

describe('the real toolkit reference', () => {
  const toolkit = loadToolkit(REPO_ROOT);
  const selection = computeSelection(toolkit, { stacks: [...toolkit.stacks.keys()], include: [], exclude: [] }, new Set());
  const merged = mergeCatalog(configCatalog(selection.items, { values: {}, target: 'claude' }));
  const byKey = new Map(merged.map((k) => [k.key, k]));
  const text = generateConfigReference({ selection, target: 'claude' });

  test('every top-level block, and the whole tree, uncomments to valid YAML of declared defaults', () => {
    const all = blocks(text);
    assert.ok(all.length > 5);
    for (const b of [...all, all.flat()]) {
      const parsed = YAML.parse(uncomment(['# config:', ...b]));
      for (const [key, value] of leaves(parsed?.config)) {
        const k = byKey.get(key);
        assert.ok(k, `${key} is a catalog key`);
        const spec = k.decls[0].spec;
        assert.equal(spec.lockMode, undefined, `${key} is not locked`);
        assert.ok(!(spec.required && spec.default === undefined), `${key} is not must-set`);
        assert.deepEqual(value, spec.default, key);
      }
    }
  });

  test('harness.* is never listed as a key', () => {
    assert.doesNotMatch(text, /^# +harness:/m);
    assert.match(text, /The `harness\.\*` namespace/);
  });
});

describe('uncommenting the tree passes render and doctor', () => {
  test('this repo\'s selection, with each top-level block and then the whole tree merged into its config', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-703-'));
    try {
      const base = fs.readFileSync(path.join(REPO_ROOT, '.waffle/waffle.yaml'), 'utf8');
      write(cwd, '.waffle/waffle.yaml', base);
      const opts = { toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' };
      assert.equal(renderProject(opts).ok, true);
      const ref = fs.readFileSync(path.join(cwd, CONFIG_REFERENCE), 'utf8');
      const all = blocks(ref);
      assert.ok(all.length > 5);

      for (const lines of [...all, all.flat()]) {
        const fromRef = YAML.parse(uncomment(['# config:', ...lines])).config ?? {};
        const doc = YAML.parse(base);
        doc.config = deepMerge(doc.config ?? {}, fromRef);
        write(cwd, '.waffle/waffle.yaml', YAML.stringify(doc));

        const label = lines[0];
        const res = renderProject(opts);
        assert.equal(res.ok, true, `${label}: ${JSON.stringify(res.errors)}`);
        const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
        assert.equal(dr.ok, true, `${label}: ${JSON.stringify(dr)}`);
        assert.deepEqual([dr.modified, dr.missing, dr.configProblems ?? []], [[], [], []], label);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('no config value reaches the reference (#317)', () => {
  test('committed and overlay sentinels are absent, and the bytes match with or without the overlay', () => {
    const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-703-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-703-'));
    try {
      write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: x\nstacks: [a]\n');
      write(toolkitRoot, 'stacks/a/stack.yaml', [
        'name: a',
        'description: Stack A.',
        'skills: [a1]',
        'config:',
        '  a.name:',
        '    required: true',
        '    description: The name.',
        '  a.label:',
        '    required: false',
        '    default: plain',
        '    description: The label.',
        '',
      ].join('\n'));
      write(toolkitRoot, 'stacks/a/skills/a1/SKILL.md', '---\nname: a1\ndescription: Skill a1.\n---\n\n{{a.name}} {{a.label}}\n');
      write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [a]\nconfig:\n  a:\n    name: LEAK_COMMITTED_name\n    label: LEAK_COMMITTED_label\n');
      const opts = { toolkitRoot, cwd, toolkitVersion: '0.0.test' };

      assert.equal(renderProject(opts).ok, true);
      const without = fs.readFileSync(path.join(cwd, CONFIG_REFERENCE), 'utf8');

      write(cwd, '.waffle/waffle.local.yaml', 'config:\n  a:\n    name: LEAK_LOCAL_name\n    label: LEAK_LOCAL_label\n');
      assert.equal(renderProject(opts).ok, true);
      const withOverlay = fs.readFileSync(path.join(cwd, CONFIG_REFERENCE), 'utf8');
      assert.match(fs.readFileSync(path.join(cwd, '.claude/skills/a1/SKILL.md'), 'utf8'), /LEAK_LOCAL_name/, 'the overlay did apply');

      for (const text of [without, withOverlay]) assert.doesNotMatch(text, /LEAK_/);
      assert.equal(withOverlay, without);
      const lock = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
      assert.ok(lookupPath(lock, 'files') && Object.keys(lock.files).some((rel) => rel.endsWith('waffle.reference.yaml')));
    } finally {
      fs.rmSync(toolkitRoot, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
