import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitute, formatValue } from '../lib/template.mjs';
import { parseFrontmatter, stringifyFrontmatter, deepMerge, lookupPath } from '../lib/util.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { eject, installRefs } from '../lib/eject.mjs';
import { validateToolkit } from '../lib/validate.mjs';
import { setupGuide, toolkitInventory } from '../lib/setup.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { resolveRef, closureDeps, computeSelection } from '../lib/refs.mjs';

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

describe('setup guide', () => {
  test('real toolkit: playbook + generated inventory assemble', () => {
    const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
    const guide = setupGuide(repoRoot, '0.0.test');
    assert.match(guide, /# wafflestack setup — agent playbook/);
    assert.match(guide, /# Toolkit inventory — wafflestack v0\.0\.test/);
    assert.match(guide, /## bundle: github-workflow/);
    assert.match(guide, /- `project\.name` \(required\)/);
    // multi-line defaults are shown in a 4-backtick fence (they may contain ``` themselves)
    assert.match(guide, /````\n {2}\| Intent \| Label \|/);
    assert.match(guide, /### setup notes/);
  });

  test('fixture inventory: env prerequisites and setup notes surface', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-setup-'));
    try {
      makeFixtureToolkit(root);
      fs.appendFileSync(
        path.join(root, 'bundles/demo/bundle.yaml'),
        'setup: |-\n  Create the demo webhook first.\n',
      );
      const inventory = toolkitInventory(loadToolkit(root), '9.9.9');
      assert.match(inventory, /## bundle: demo/);
      assert.match(inventory, /- skills: skills\/demo-skill/);
      assert.match(inventory, /- agents: agents\/helper/);
      assert.match(inventory, /- env prerequisites: DEMO_FLAG=1/);
      assert.match(inventory, /- `git\.botEmail` \(required\) — bot email/);
      assert.match(inventory, /### setup notes\n\nCreate the demo webhook first\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('refs: resolution and dependency closure', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-refs-')); makeRefFixture(root); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('the ref fixture is itself a valid toolkit', () => {
    assert.deepEqual(validateToolkit(root), []);
  });

  test('resolves a bundle name', () => {
    assert.deepEqual(resolveRef(loadToolkit(root), 'orch'), { type: 'bundle', name: 'orch' });
  });

  test('resolves an unambiguous item to its bundle, canonical unqualified', () => {
    const r = resolveRef(loadToolkit(root), 'skills/git');
    assert.equal(r.type, 'item');
    assert.equal(r.bundle, 'base');
    assert.equal(r.canonicalRef, 'skills/git');
  });

  test('normalizes item-ref prefixes (skill:/agent/)', () => {
    const toolkit = loadToolkit(root);
    assert.equal(resolveRef(toolkit, 'skill:git').canonicalRef, 'skills/git');
    assert.equal(resolveRef(toolkit, 'agent/pm').canonicalRef, 'agents/pm');
  });

  test('ambiguous item errors, listing bundle-qualified candidates', () => {
    assert.throws(
      () => resolveRef(loadToolkit(root), 'skills/dupe'),
      /ambiguous.*alt\/skills\/dupe.*alt2\/skills\/dupe/s,
    );
  });

  test('bundle-qualified form disambiguates; canonical stays qualified', () => {
    const r = resolveRef(loadToolkit(root), 'alt2/skills/dupe');
    assert.equal(r.bundle, 'alt2');
    assert.equal(r.canonicalRef, 'alt2/skills/dupe');
  });

  test('unknown bundle / item error and list what exists', () => {
    const toolkit = loadToolkit(root);
    assert.throws(() => resolveRef(toolkit, 'nope'), /no such bundle/);
    assert.throws(() => resolveRef(toolkit, 'skills/nope'), /no skill "nope".*Available/s);
  });

  test('agent closure: frontmatter skills + transitive requires, external skill skipped', () => {
    const toolkit = loadToolkit(root);
    // pm frontmatter: [deleg, git, ghost]; deleg requires gpm; ghost is external → dropped.
    assert.deepEqual(closureDeps(toolkit, resolveRef(toolkit, 'agents/pm')), [
      'skills/deleg', 'skills/git', 'skills/gpm',
    ]);
  });

  test('skill closure follows requires across bundles', () => {
    const toolkit = loadToolkit(root);
    assert.deepEqual(closureDeps(toolkit, resolveRef(toolkit, 'skills/deleg')), ['skills/gpm']);
  });
});

describe('render selection: include, closure, scoping, eject', () => {
  let root;
  let cwd;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-sel-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-sel-'));
    makeRefFixture(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const writeConfig = (lines) => fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), `${lines.join('\n')}\n`);
  const render = () => renderProject({ toolkitRoot: root, cwd, toolkitVersion: '0.0.test' });
  const has = (rel) => fs.existsSync(path.join(cwd, rel));

  test('include renders an item and its full closure from non-enabled bundles', () => {
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [agents/pm]', 'config:', '  orch: {who: X, roster: R}']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(has('.claude/agents/pm.md'));
    assert.ok(has('.claude/skills/deleg/SKILL.md'));
    assert.ok(has('.claude/skills/git/SKILL.md'));
    assert.ok(has('.claude/skills/gpm/SKILL.md'), 'transitive requires dep rendered');
    // env prerequisite for orch still fires because orch items rendered
    assert.ok(result.warnings.some((w) => /ORCH_FLAG/.test(w)), JSON.stringify(result.warnings));
  });

  test('required config is scoped: installing skills/git demands nothing', () => {
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [skills/git]', 'config: {}']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(has('.claude/skills/git/SKILL.md'));
    assert.ok(!has('.claude/skills/issue/SKILL.md'));
  });

  test('include does not demand a non-selected sibling item\'s required key', () => {
    // pm pulls base git+gpm (no config) but not base issue → base.botEmail not required.
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [agents/pm]', 'config:', '  orch: {who: X, roster: R}']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  test('a scoped required key that IS used still fails helpfully', () => {
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [skills/issue]', 'config: {}']);
    const result = render();
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /config\.base\.botEmail/);
  });

  test('bundle-qualified include resolves the ambiguous item', () => {
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [alt2/skills/dupe]', 'config: {}']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.match(read(cwd, '.claude/skills/dupe/SKILL.md'), /variant alt2/);
  });

  test('an unqualified ambiguous include entry is a render error', () => {
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [skills/dupe]', 'config: {}']);
    const result = render();
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /ambiguous/.test(e)), JSON.stringify(result.errors));
  });

  test('eject wins over include (item filtered from the selection)', () => {
    writeConfig(['targets: [claude]', 'bundles: []', 'include: [skills/git]', 'eject: [skills/git]', 'config: {}']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(!has('.claude/skills/git/SKILL.md'));
    assert.deepEqual(computeSelection(loadToolkit(root), {
      targets: ['claude'], bundles: [], include: ['skills/git'], eject: ['skills/git'], values: {},
    }).items, []);
  });
});

describe('install: persistence and eject include-cleanup', () => {
  let root;
  let cwd;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-ins-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-ins-'));
    makeRefFixture(root);
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), [
      '# fixture config comment',
      'targets: [claude]',
      'bundles: [base]',
      'config: {}',
      '',
    ].join('\n'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const install = (refs, log) => installRefs({ toolkitRoot: root, cwd, refs, log });

  test('bundle refs append to bundles:, item refs to include:, comments preserved', () => {
    install(['orch', 'alt/skills/dupe']);
    const cfg = read(cwd, '.wafflestack.yaml');
    assert.match(cfg, /# fixture config comment/);
    assert.match(cfg, /- base/);
    assert.match(cfg, /- orch/);
    // ambiguous item persisted in bundle-qualified canonical form
    assert.match(cfg, /include:/);
    assert.match(cfg, /- alt\/skills\/dupe/);
  });

  test('unambiguous item persists unqualified', () => {
    install(['skills/issue']);
    assert.match(read(cwd, '.wafflestack.yaml'), /include:\n\s*- skills\/issue/);
  });

  test('reports the dependency closure', () => {
    const logs = [];
    install(['agents/pm'], (m) => logs.push(m));
    assert.ok(
      logs.some((l) => /installing agents\/pm \(\+3 deps: skills\/deleg, skills\/git, skills\/gpm\)/.test(l)),
      logs.join('\n'),
    );
  });

  test('unknown ref throws and persists nothing', () => {
    const before = read(cwd, '.wafflestack.yaml');
    assert.throws(() => install(['skills/nope']), /unknown ref/);
    assert.equal(read(cwd, '.wafflestack.yaml'), before);
  });

  test('already-selected refs are idempotent (config untouched)', () => {
    const before = read(cwd, '.wafflestack.yaml');
    install(['base']);
    assert.equal(read(cwd, '.wafflestack.yaml'), before);
  });

  test('eject removes a matching include entry, qualified or not', () => {
    install(['alt/skills/dupe']);
    assert.match(read(cwd, '.wafflestack.yaml'), /alt\/skills\/dupe/);
    eject({ cwd, item: 'skills/dupe' });
    const cfg = read(cwd, '.wafflestack.yaml');
    assert.doesNotMatch(cfg, /alt\/skills\/dupe/);
    assert.match(cfg, /eject:/);
  });

  test('install requires an existing config file', () => {
    fs.rmSync(path.join(cwd, '.wafflestack.yaml'));
    assert.throws(() => install(['base']), /run `wafflestack init`/);
  });
});

describe('validate: agent skills and requires refs', () => {
  const withToolkit = (files, fn) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-val-'));
    try {
      for (const [rel, content] of Object.entries(files)) write(root, rel, content);
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test('flags an unresolvable requires dependency', () => {
    withToolkit({
      'toolkit.yaml': 'name: f\ndescription: d\nbundles: [b]\n',
      'bundles/b/bundle.yaml': ['name: b', 'description: B.', 'skills: [x]', 'requires:', '  skills/x:', '    - skills/missing', ''].join('\n'),
      'bundles/b/skills/x/SKILL.md': '---\nname: x\ndescription: X.\n---\n\nbody\n',
    }, (root) => {
      const problems = validateToolkit(root);
      assert.ok(problems.some((p) => /requires\[skills\/x\].*cannot resolve.*skills\/missing/.test(p)), JSON.stringify(problems));
    });
  });

  test('flags a requires key that is not an item in the bundle', () => {
    withToolkit({
      'toolkit.yaml': 'name: f\ndescription: d\nbundles: [b]\n',
      'bundles/b/bundle.yaml': ['name: b', 'description: B.', 'skills: [x]', 'requires:', '  skills/ghost:', '    - skills/x', ''].join('\n'),
      'bundles/b/skills/x/SKILL.md': '---\nname: x\ndescription: X.\n---\n\nbody\n',
    }, (root) => {
      const problems = validateToolkit(root);
      assert.ok(problems.some((p) => /requires key "skills\/ghost" does not match/.test(p)), JSON.stringify(problems));
    });
  });

  test('flags an ambiguous agent skill (name in multiple bundles)', () => {
    withToolkit({
      'toolkit.yaml': 'name: f\ndescription: d\nbundles: [a1, a2, agt]\n',
      'bundles/a1/bundle.yaml': 'name: a1\ndescription: A1.\nskills: [dupe]\n',
      'bundles/a1/skills/dupe/SKILL.md': '---\nname: dupe\ndescription: D1.\n---\n\nx\n',
      'bundles/a2/bundle.yaml': 'name: a2\ndescription: A2.\nskills: [dupe]\n',
      'bundles/a2/skills/dupe/SKILL.md': '---\nname: dupe\ndescription: D2.\n---\n\nx\n',
      'bundles/agt/bundle.yaml': 'name: agt\ndescription: Agt.\nagents: [u]\n',
      'bundles/agt/agents/u.md': '---\nname: u\ndescription: U.\nskills:\n  - dupe\n---\n\nbody\n',
    }, (root) => {
      const problems = validateToolkit(root);
      assert.ok(problems.some((p) => /agent u skill "dupe" is ambiguous/.test(p)), JSON.stringify(problems));
    });
  });

  test('allows an agent skill that is absent from the toolkit (external pointer)', () => {
    withToolkit({
      'toolkit.yaml': 'name: f\ndescription: d\nbundles: [b]\n',
      'bundles/b/bundle.yaml': 'name: b\ndescription: B.\nagents: [u]\n',
      'bundles/b/agents/u.md': '---\nname: u\ndescription: U.\nskills:\n  - external-only\n---\n\nbody\n',
    }, (root) => {
      assert.ok(!validateToolkit(root).some((p) => /external-only/.test(p)), 'external agent skill must not be flagged');
    });
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

/**
 * A multi-bundle fixture exercising per-item install:
 *   base — git, gpm (no config); issue uses base.botEmail (required)
 *   orch — pm agent (skills: deleg, git, ghost[external]); deleg requires gpm; env ORCH_FLAG
 *   alt / alt2 — both define skill `dupe` (ambiguous unless bundle-qualified)
 */
function makeRefFixture(root) {
  write(root, 'toolkit.yaml', 'name: reffix\ndescription: ref fixture\nbundles: [base, orch, alt, alt2]\n');

  write(root, 'bundles/base/bundle.yaml', [
    'name: base',
    'description: Base skills.',
    'skills: [git, gpm, issue]',
    'config:',
    '  base.botEmail:',
    '    required: true',
    '    description: bot email',
    '',
  ].join('\n'));
  write(root, 'bundles/base/skills/git/SKILL.md', '---\nname: git\ndescription: Git skill.\n---\n\nBranch and commit.\n');
  write(root, 'bundles/base/skills/gpm/SKILL.md', '---\nname: gpm\ndescription: Project mgmt.\n---\n\nGraphQL catalog.\n');
  write(root, 'bundles/base/skills/issue/SKILL.md', '---\nname: issue\ndescription: Issue skill.\n---\n\nFile as {{base.botEmail}}.\n');

  write(root, 'bundles/orch/bundle.yaml', [
    'name: orch',
    'description: Orchestration.',
    'agents: [pm]',
    'skills: [deleg]',
    'requires:',
    '  skills/deleg:',
    '    - skills/gpm',
    'config:',
    '  orch.who:',
    '    required: true',
    '    description: who',
    '  orch.roster:',
    '    required: true',
    '    description: roster',
    'env:',
    '  ORCH_FLAG: "1"',
    '',
  ].join('\n'));
  write(root, 'bundles/orch/agents/pm.md', [
    '---',
    'name: pm',
    'description: PM agent.',
    'skills:',
    '  - deleg',
    '  - git',
    '  - ghost',
    '---',
    '',
    'You are PM for {{orch.who}}.',
    '',
  ].join('\n'));
  write(root, 'bundles/orch/skills/deleg/SKILL.md', '---\nname: deleg\ndescription: Delegate.\n---\n\nRoster: {{orch.roster}}. See the gpm skill.\n');

  for (const b of ['alt', 'alt2']) {
    write(root, `bundles/${b}/bundle.yaml`, `name: ${b}\ndescription: Bundle ${b}.\nskills: [dupe]\n`);
    write(root, `bundles/${b}/skills/dupe/SKILL.md`, `---\nname: dupe\ndescription: Dupe from ${b}.\n---\n\nvariant ${b}\n`);
  }
}

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
