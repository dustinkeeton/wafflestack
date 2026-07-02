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
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), [
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
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude]\nbundles: []\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(cwd, '.codex/agents/helper.toml')), false);
  });

  test('missing required config fails with actionable error', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'bundles: [demo]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /config\.git\.botEmail/);
  });

  test('local overlay wins over committed config', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.local.yaml'), 'config:\n  git:\n    botEmail: local@example.com\n');
    render();
    assert.match(read(cwd, '.claude/agents/helper.md'), /local@example\.com/);
  });

  test('extensions are appended with markers', () => {
    fs.mkdirSync(path.join(cwd, '.wafflestack/extensions/skills'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.wafflestack/extensions/skills/demo-skill.md'), 'Project-specific addendum.\n');
    render();
    const skill = read(cwd, '.claude/skills/demo-skill/SKILL.md');
    assert.match(skill, /BEGIN project extension: \.wafflestack\/extensions\/skills\/demo-skill\.md/);
    assert.match(skill, /Project-specific addendum\./);
    assert.match(skill, /END project extension/);
    // extension applies to both skill targets
    assert.equal(skill, read(cwd, '.agents/skills/demo-skill/SKILL.md'));
  });

  test('eject releases files, preserves config comments, render skips item', () => {
    render();
    const { released } = eject({ cwd, item: 'skills/demo-skill' });
    assert.ok(released.includes(path.join('.claude', 'skills', 'demo-skill', 'SKILL.md')));
    const cfgText = read(cwd, '.wafflestack.yaml');
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

describe('harness.* namespace', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-hz-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-hz-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: hz\nbundles: [hz]\n');
    write(toolkitRoot, 'bundles/hz/bundle.yaml', [
      'name: hz',
      'description: Harness fixture.',
      'agents: [attr]',
      'skills: [attr-skill]',
      'config:',
      '  project.name:',
      '    required: false',
      '    default: Fixtureproj',
      '    description: bare project name',
      '',
    ].join('\n'));
    write(toolkitRoot, 'bundles/hz/agents/attr.md', [
      '---',
      'name: attr',
      'description: Attr agent for {{project.name}}, signed by {{harness.assistantName}}.',
      'claude:',
      '  allowed-tools: Read',
      '---',
      '',
      'Attributed to {{harness.assistantName}} via {{harness.attributionPath}}.',
      '',
    ].join('\n'));
    write(toolkitRoot, 'bundles/hz/skills/attr-skill/SKILL.md', [
      '---',
      'name: attr-skill',
      'description: Attr skill.',
      '---',
      '',
      'Signed by {{harness.assistantName}}.',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const writeConfig = (configLines = ['config: {}']) => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), [
      'targets: [claude, codex, agents-dir]',
      'bundles: [hz]',
      ...configLines,
      '',
    ].join('\n'));
  };
  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });

  test('built-ins resolve per target: Claude in .claude, Codex in .codex/.agents', () => {
    writeConfig();
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    assert.match(read(cwd, '.claude/agents/attr.md'), /Attributed to Claude via claude-code\./);
    assert.match(read(cwd, '.codex/agents/attr.toml'), /Attributed to Codex via Codex\./);
    assert.match(read(cwd, '.claude/skills/attr-skill/SKILL.md'), /Signed by Claude\./);
    assert.match(read(cwd, '.agents/skills/attr-skill/SKILL.md'), /Signed by Codex\./);
  });

  test('agent frontmatter description is substituted per target', () => {
    writeConfig();
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    assert.match(
      read(cwd, '.claude/agents/attr.md'),
      /^---\nname: attr\ndescription: Attr agent for Fixtureproj, signed by Claude\.\n/,
    );
    assert.match(
      read(cwd, '.codex/agents/attr.toml'),
      /\ndescription = "Attr agent for Fixtureproj, signed by Codex\."\n/,
    );
  });

  test('scalar override applies to every target', () => {
    writeConfig(['config:', '  harness:', '    assistantName: Aider']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    assert.match(read(cwd, '.claude/skills/attr-skill/SKILL.md'), /Signed by Aider\./);
    assert.match(read(cwd, '.agents/skills/attr-skill/SKILL.md'), /Signed by Aider\./);
    assert.match(read(cwd, '.codex/agents/attr.toml'), /Attributed to Aider via Codex\./);
    // unoverridden sub-key still uses the per-target built-in
    assert.match(read(cwd, '.claude/agents/attr.md'), /Attributed to Aider via claude-code\./);
  });

  test('per-target map override, missing target falls back to built-in', () => {
    writeConfig([
      'config:',
      '  harness:',
      '    attributionPath:',
      '      claude: my-tool',
      '      agents-dir: my-tool',
    ]);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    assert.match(read(cwd, '.claude/agents/attr.md'), /Attributed to Claude via my-tool\./);
    // codex not in the map -> built-in "Codex"
    assert.match(read(cwd, '.codex/agents/attr.toml'), /Attributed to Codex via Codex\./);
  });
});

describe('nested substitution', () => {
  const declared = new Set(['git.coAuthorTrailer', 'git.cmd', 'a.b']);
  const values = {
    'git.coAuthorTrailer': 'Co-Authored-By: {{harness.assistantName}} <bot@example.com>',
    'git.cmd': 'git -c user.email={{git.localOnly}}',
    'git.localOnly': 'secret@example.com', // present in config but NOT declared (local-overlay pattern)
    'harness.assistantName': 'Claude',
    'a.b': 'loop {{a.b}}',
    'secrets.X': 'should-never-appear',
  };
  const resolve = (key) => values[key];

  test('placeholders inside values expand, including undeclared config-present keys', () => {
    const errors = [];
    const out = substitute('{{git.coAuthorTrailer}} via {{git.cmd}}', resolve, declared, errors, 't');
    assert.equal(out, 'Co-Authored-By: Claude <bot@example.com> via git -c user.email=secret@example.com');
    assert.equal(errors.length, 0);
  });

  test('canonical undeclared braces stay verbatim even when the key would resolve', () => {
    const errors = [];
    const text = 'uses ${{ secrets.X }} in CI';
    assert.equal(substitute(text, resolve, declared, errors, 't'), text);
  });

  test('self-referential value is depth-capped, does not hang', () => {
    const errors = [];
    const out = substitute('{{a.b}}', resolve, declared, errors, 't');
    assert.match(out, /^(loop )+\{\{a\.b\}\}$/);
  });

  test('unresolvable nested placeholder passes through silently', () => {
    const errors = [];
    const vals = { 'git.cmd': 'echo {{not.real}}' };
    const out = substitute('{{git.cmd}}', (k) => vals[k], new Set(['git.cmd']), errors, 't');
    assert.equal(out, 'echo {{not.real}}');
    assert.equal(errors.length, 0);
  });
});

describe('output conflicts and skillsDir', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-x-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-x-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: x\nbundles: [one, two]\n');
    for (const b of ['one', 'two']) {
      write(toolkitRoot, `bundles/${b}/bundle.yaml`, [
        `name: ${b}`,
        `description: Bundle ${b}.`,
        'skills: [dup-skill]',
        '',
      ].join('\n'));
      write(toolkitRoot, `bundles/${b}/skills/dup-skill/SKILL.md`, [
        '---',
        'name: dup-skill',
        `description: Variant ${b}.`,
        '---',
        '',
        `Variant ${b}. Read {{harness.skillsDir}}/dup-skill/SKILL.md.`,
        '',
      ].join('\n'));
    }
  });

  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });

  test('same item from two bundles is a render error', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude]\nbundles: [one, two]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => /output conflict:.*dup-skill/.test(e) && /one\/skills\/dup-skill/.test(e) && /two\/skills\/dup-skill/.test(e)),
      JSON.stringify(result.errors),
    );
  });

  test('harness.skillsDir resolves per target', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude, agents-dir]\nbundles: [one]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.match(read(cwd, '.claude/skills/dup-skill/SKILL.md'), /Read \.claude\/skills\/dup-skill\/SKILL\.md\./);
    assert.match(read(cwd, '.agents/skills/dup-skill/SKILL.md'), /Read \.agents\/skills\/dup-skill\/SKILL\.md\./);
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
