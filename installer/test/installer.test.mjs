import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { substitute, formatValue } from '../lib/template.mjs';
import { parseFrontmatter, stringifyFrontmatter, deepMerge, lookupPath } from '../lib/util.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { eject } from '../lib/eject.mjs';
import { validateToolkit } from '../lib/validate.mjs';

describe('template', () => {
  const declared = new Set(['git.botEmail', 'project.testCmd']);
  const resolve = (key) => ({ 'git.botEmail': 'bot@example.com' }[key]);

  test('substitutes declared keys', () => {
    const errors = [];
    const out = substitute('commit as {{git.botEmail}}', resolve, declared, errors, 't');
    assert.equal(out, 'commit as bot@example.com');
    assert.equal(errors.length, 0);
  });

  test('leaves undeclared braces alone (bash, mustache)', () => {
    const errors = [];
    const text = 'run ${HOME}/x and {{ unrelated.thing }} and {{name}}';
    assert.equal(substitute(text, resolve, declared, errors, 't'), text);
    assert.equal(errors.length, 0);
  });

  test('missing declared value reports error, keeps placeholder', () => {
    const errors = [];
    const out = substitute('test via {{project.testCmd}}', resolve, declared, errors, 'ctx');
    assert.equal(out, 'test via {{project.testCmd}}');
    assert.match(errors[0], /ctx.*project\.testCmd/);
  });

  test('formatValue joins string arrays, yamls objects', () => {
    assert.equal(formatValue(['a', 'b']), 'a, b');
    assert.match(formatValue({ x: 1 }), /x: 1/);
  });
});

describe('util', () => {
  test('frontmatter round trip', () => {
    const src = '---\nname: a\ndescription: b\n---\n\nBody text.\n';
    const { data, body } = parseFrontmatter(src);
    assert.deepEqual(data, { name: 'a', description: 'b' });
    assert.equal(body, 'Body text.\n');
    assert.equal(stringifyFrontmatter(data, body), src);
  });

  test('deepMerge: local overlay wins, objects merge, arrays replace', () => {
    const merged = deepMerge(
      { a: { x: 1, y: 1 }, list: [1, 2], keep: 'k' },
      { a: { y: 2 }, list: [3] },
    );
    assert.deepEqual(merged, { a: { x: 1, y: 2 }, list: [3], keep: 'k' });
  });

  test('lookupPath resolves dotted keys', () => {
    assert.equal(lookupPath({ a: { b: 'v' } }, 'a.b'), 'v');
    assert.equal(lookupPath({ a: {} }, 'a.b.c'), undefined);
  });
});

describe('end to end', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
    makeFixtureToolkit(toolkitRoot);
    fs.writeFileSync(path.join(cwd, '.agent-toolkit.yaml'), [
      '# project config comment',
      'targets: [claude, codex, agents-dir]',
      'bundles: [demo]',
      'config:',
      '  git:',
      '    botEmail: bot@example.com',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });

  test('renders all targets, lock verifies, doctor round-trips', () => {
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const claudeAgent = read(cwd, '.claude/agents/helper.md');
    assert.match(claudeAgent, /^---\nname: helper\ndescription: A helper\.\nskills:\n {2}- demo-skill\nallowed-tools: Read, Bash\n---\n/);
    assert.match(claudeAgent, /Commit as bot@example\.com\./);

    const toml = read(cwd, '.codex/agents/helper.toml');
    assert.match(toml, /^name = "helper"\ndescription = "A helper\."\ndeveloper_instructions = """\n/);
    assert.match(toml, /Commit as bot@example\.com\./);
    assert.doesNotMatch(toml, /allowed-tools/);

    assert.equal(read(cwd, '.claude/skills/demo-skill/SKILL.md'), read(cwd, '.agents/skills/demo-skill/SKILL.md'));
    assert.equal(read(cwd, '.claude/skills/demo-skill/ref/data.json'), '{"n": 1}\n');
    assert.match(read(cwd, '.claude/skills/demo-skill/SKILL.md'), /\$\{HOME\}\/x stays/);

    const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(dr.ok, true, JSON.stringify(dr));

    // env prerequisite for codex warned (no .codex/config.toml in fixture project)
    assert.ok(result.warnings.some((w) => /DEMO_FLAG/.test(w)), JSON.stringify(result.warnings));
  });

  test('frozen image: local edit flagged by doctor, restored by render, stale files removed', () => {
    render();
    const file = path.join(cwd, '.claude/skills/demo-skill/SKILL.md');
    const original = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, 'local drift\n');
    const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(dr.ok, false);
    assert.deepEqual(dr.modified, ['.claude/skills/demo-skill/SKILL.md']);

    render();
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    // drop the bundle -> all its files are cleaned up
    fs.writeFileSync(path.join(cwd, '.agent-toolkit.yaml'), 'targets: [claude]\nbundles: []\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(cwd, '.codex/agents/helper.toml')), false);
  });

  test('missing required config fails with actionable error', () => {
    fs.writeFileSync(path.join(cwd, '.agent-toolkit.yaml'), 'bundles: [demo]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /config\.git\.botEmail/);
  });

  test('local overlay wins over committed config', () => {
    fs.writeFileSync(path.join(cwd, '.agent-toolkit.local.yaml'), 'config:\n  git:\n    botEmail: local@example.com\n');
    render();
    assert.match(read(cwd, '.claude/agents/helper.md'), /local@example\.com/);
  });

  test('extensions are appended with markers', () => {
    fs.mkdirSync(path.join(cwd, '.agent-toolkit/extensions/skills'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent-toolkit/extensions/skills/demo-skill.md'), 'Project-specific addendum.\n');
    render();
    const skill = read(cwd, '.claude/skills/demo-skill/SKILL.md');
    assert.match(skill, /BEGIN project extension: \.agent-toolkit\/extensions\/skills\/demo-skill\.md/);
    assert.match(skill, /Project-specific addendum\./);
    assert.match(skill, /END project extension/);
    // extension applies to both skill targets
    assert.equal(skill, read(cwd, '.agents/skills/demo-skill/SKILL.md'));
  });

  test('eject releases files, preserves config comments, render skips item', () => {
    render();
    const { released } = eject({ cwd, item: 'skills/demo-skill' });
    assert.ok(released.includes(path.join('.claude', 'skills', 'demo-skill', 'SKILL.md')));
    const cfgText = read(cwd, '.agent-toolkit.yaml');
    assert.match(cfgText, /# project config comment/);
    assert.match(cfgText, /eject:/);

    fs.appendFileSync(path.join(cwd, '.claude/skills/demo-skill/SKILL.md'), 'now project-owned\n');
    const result = render();
    assert.equal(result.ok, true);
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
    assert.match(read(cwd, '.claude/skills/demo-skill/SKILL.md'), /now project-owned/);
  });

  test('validate flags undeclared dotted placeholders and unused keys', () => {
    const skillMd = path.join(toolkitRoot, 'bundles/demo/skills/demo-skill/SKILL.md');
    fs.appendFileSync(skillMd, '\nUses {{made.up.key}}.\n');
    const problems = validateToolkit(toolkitRoot);
    assert.ok(problems.some((p) => /made\.up\.key/.test(p)), JSON.stringify(problems));
  });
});

function read(cwd, rel) {
  return fs.readFileSync(path.join(cwd, rel), 'utf8');
}

function makeFixtureToolkit(root) {
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: test fixture\nbundles: [demo]\n');
  write(root, 'bundles/demo/bundle.yaml', [
    'name: demo',
    'description: Demo bundle.',
    'agents: [helper]',
    'skills: [demo-skill]',
    'config:',
    '  git.botEmail:',
    '    required: true',
    '    description: bot email',
    'env:',
    '  DEMO_FLAG: "1"',
    '',
  ].join('\n'));
  write(root, 'bundles/demo/agents/helper.md', [
    '---',
    'name: helper',
    'description: A helper.',
    'skills:',
    '  - demo-skill',
    'claude:',
    '  allowed-tools: Read, Bash',
    '---',
    '',
    'You are a helper. Commit as {{git.botEmail}}.',
    '',
  ].join('\n'));
  write(root, 'bundles/demo/skills/demo-skill/SKILL.md', [
    '---',
    'name: demo-skill',
    'description: A demo skill.',
    '---',
    '',
    '# Demo',
    '',
    'Email {{git.botEmail}}; bash ${HOME}/x stays.',
    '',
  ].join('\n'));
  write(root, 'bundles/demo/skills/demo-skill/ref/data.json', '{"n": 1}\n');
}

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
