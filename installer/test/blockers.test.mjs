import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeListModel, formatListTable, selectableChoices, describeBlockers } from '../lib/list.mjs';
import { renderProject, summarizeConfigKeys } from '../lib/render.mjs';
import { validateToolkit } from '../lib/validate.mjs';
import { reconcileToolkitRefPins, staleTagMentions } from '../lib/upgrade.mjs';

const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

// `orch` is enabled; its `autopilot` requires `qa` from the disabled `cq`, whose `arch` skill needs config.
function fixture(toolkitRoot) {
  write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: blockers\nstacks: [orch, cq]\n');
  write(toolkitRoot, 'stacks/orch/stack.yaml', [
    'name: orch',
    'description: Orchestration.',
    'skills: [autopilot]',
    'requires:',
    '  skills/autopilot:',
    '    - skills/qa',
    '',
  ].join('\n'));
  write(toolkitRoot, 'stacks/orch/skills/autopilot/SKILL.md', '---\nname: autopilot\ndescription: Runs.\n---\n\nUses qa.\n');
  write(toolkitRoot, 'stacks/cq/stack.yaml', [
    'name: cq',
    'description: Code quality.',
    'skills: [qa, arch]',
    'files: [plain.txt, templ.txt]',
    'config:',
    '  arch.layers:',
    '    required: true',
    '    description: Layers.',
    '  arch.modules:',
    '    required: true',
    '    description: Modules.',
    '  note.text:',
    '    default: hi',
    '    description: A defaulted key.',
    '',
  ].join('\n'));
  write(toolkitRoot, 'stacks/cq/skills/qa/SKILL.md', '---\nname: qa\ndescription: QA.\n---\n\nNo config.\n');
  write(toolkitRoot, 'stacks/cq/skills/arch/SKILL.md', '---\nname: arch\ndescription: Arch.\n---\n\n{{arch.layers}} {{arch.modules}}\n');
  write(toolkitRoot, 'stacks/cq/files/plain.txt', 'verbatim\n');
  write(toolkitRoot, 'stacks/cq/files/templ.txt', 'say {{note.text}}\n');
}

describe('picker blockers and the cheaper dependency fix (#549)', () => {
  let toolkitRoot;
  let cwd;
  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-blockers-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-blockers-'));
    fixture(toolkitRoot);
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [orch]\nconfig: {}\n');
  });
  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const model = () => computeListModel({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
  const row = (m, ref) => m.stacks.flatMap((s) => s.rows).find((r) => r.ref === ref);

  test('the fixture validates clean', () => {
    assert.deepEqual(validateToolkit(toolkitRoot), []);
  });

  test('a row needing unset required config is marked, collapsed to its prefix', () => {
    const m = model();
    assert.deepEqual(row(m, 'skills/arch').blockers, { config: ['config.arch.layers', 'config.arch.modules'], unmanaged: [] });
    assert.deepEqual(describeBlockers(row(m, 'skills/arch').blockers), ['needs config.arch.*']);
    assert.equal(row(m, 'skills/qa').blockers, null, 'qa needs nothing');
    assert.equal(row(m, 'files/templ.txt').blockers, null, 'a defaulted key is not a blocker');
    assert.match(formatListTable(m), /skills\/arch {2}— needs config\.arch\.\*/);
    const choice = selectableChoices(m).find((c) => c.ref === 'skills/arch');
    assert.deepEqual(choice.blockers, ['needs config.arch.*']);
  });

  test('setting the config clears the blocker', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [orch]\nconfig:\n  arch:\n    layers: a\n    modules: b\n');
    assert.equal(row(model(), 'skills/arch').blockers, null);
  });

  test('an untracked file at a target path is marked; a byte-identical verbatim file is not', () => {
    write(cwd, '.claude/skills/qa/SKILL.md', 'hand-written\n');
    write(cwd, 'plain.txt', 'verbatim\n');
    write(cwd, 'templ.txt', 'say hi\n');
    const m = model();
    assert.deepEqual(row(m, 'skills/qa').blockers.unmanaged, [path.join('.claude', 'skills', 'qa', 'SKILL.md')]);
    assert.deepEqual(describeBlockers(row(m, 'skills/qa').blockers), [`unmanaged file at ${path.join('.claude', 'skills', 'qa', 'SKILL.md')} (needs --force)`]);
    assert.equal(row(m, 'files/plain.txt').blockers, null, 'identical verbatim bytes are adopted silently by render');
    assert.deepEqual(row(m, 'files/templ.txt').blockers.unmanaged, ['templ.txt'], 'a templated file cannot be compared cheaply');
    write(cwd, 'plain.txt', 'edited\n');
    assert.deepEqual(row(model(), 'files/plain.txt').blockers.unmanaged, ['plain.txt']);
  });

  test("a dependency's blockers surface on the dependent's row", () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\nconfig: {}\n');
    write(cwd, '.claude/skills/qa/SKILL.md', 'hand-written\n');
    assert.deepEqual(row(model(), 'skills/autopilot').blockers.unmanaged, [path.join('.claude', 'skills', 'qa', 'SKILL.md')]);
  });

  test('the disabled-stack warning leads with install and names what each route needs', () => {
    const result = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const w = result.warnings.find((x) => /requires skills\/qa/.test(x));
    assert.ok(w, JSON.stringify(result.warnings));
    assert.match(w, /Cheapest fix: run `wafflestack install skills\/qa` .* it needs no config values\. Or add "cq" to `stacks:`.* needs config\.arch\.\*\./);
  });

  test('summarizeConfigKeys keeps a lone key whole', () => {
    assert.equal(summarizeConfigKeys(['config.data.brief']), 'config.data.brief');
    assert.equal(summarizeConfigKeys(['config.a.x', 'config.a.y', 'config.b']), 'config.a.*, config.b');
  });
});

describe('upgrade names stale tag mentions it does not rewrite (#549)', () => {
  const moves = [{ key: 'doctor.toolkitRef', from: 'github:o/r#v0.15.0', to: 'github:o/r#v0.16.1', action: 'bumped' }];

  test('lines still carrying the old tag are named; look-alike tags are not', () => {
    const text = '# npx github:o/r#v0.15.0 render\n# #v0.15.01 is not it\ndoctor:\n  toolkitRef: github:o/r#v0.16.1\n# see #v0.15.0.\n';
    const [note, ...rest] = staleTagMentions(text, moves);
    assert.deepEqual(rest, []);
    assert.match(note, /still mentions #v0\.15\.0 on lines 1, 5 .*change it to #v0\.16\.1.*"the tag in doctor\.toolkitRef"/);
  });

  test('nothing to say when the tag is gone, or when nothing was bumped', () => {
    assert.deepEqual(staleTagMentions('doctor:\n  toolkitRef: github:o/r#v0.16.1\n', moves), []);
    assert.deepEqual(staleTagMentions('# #v0.15.0\n', [{ ...moves[0], action: 'unchanged' }]), []);
  });

  test('reconcileToolkitRefPins logs the note and leaves the comment untouched', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-staletag-'));
    try {
      const config = '# npx github:dustinkeeton/wafflestack#v0.15.0 render\ntargets: [claude]\nconfig:\n  doctor:\n    toolkitRef: github:dustinkeeton/wafflestack#v0.15.0\n';
      write(cwd, '.waffle/waffle.yaml', config);
      const logged = [];
      const identity = /** @type {any} */ ({
        status: 'release', version: '0.16.1', commit: 'a'.repeat(40), tag: 'v0.16.1',
        ref: 'github:dustinkeeton/wafflestack#v0.16.1', origin: 'npm-install', repo: 'dustinkeeton/wafflestack',
        latestTag: 'v0.16.1', lookupError: null,
      });
      const result = reconcileToolkitRefPins({ cwd, identity, log: (m) => logged.push(m) });
      assert.deepEqual(result.map((m) => m.action), ['bumped']);
      const after = fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8');
      assert.match(after, /^# npx github:dustinkeeton\/wafflestack#v0\.15\.0 render$/m, 'the comment is never rewritten');
      assert.match(after, /toolkitRef: github:dustinkeeton\/wafflestack#v0\.16\.1/);
      assert.ok(logged.some((m) => /still mentions #v0\.15\.0 on line 1 /.test(m)), JSON.stringify(logged));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
