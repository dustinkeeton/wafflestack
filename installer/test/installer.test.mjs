import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { substitute, formatValue, placeholderKeys } from '../lib/template.mjs';
import { parseFrontmatter, stringifyFrontmatter, deepMerge, lookupPath, sha256, parseVersion, compareVersions } from '../lib/util.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { eject, installRefs, init } from '../lib/eject.mjs';
import { validateToolkit } from '../lib/validate.mjs';
import { setupGuide, toolkitInventory } from '../lib/setup.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { resolveRef, closureDeps, computeSelection } from '../lib/refs.mjs';
import { applicableMigrations, runMigrations, MIGRATIONS } from '../lib/migrations.mjs';
import { upgrade, changelogBetween } from '../lib/upgrade.mjs';
import { loadProjectConfig, migrateLegacyDotfiles, staleGitignoreEntries } from '../lib/project.mjs';

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

  test('GitHub Actions ${{ ... }} is never substituted, even for a declared key', () => {
    const errors = [];
    const out = substitute('token ${{ git.botEmail }}, commit {{git.botEmail}}', resolve, declared, errors, 't');
    assert.equal(out, 'token ${{ git.botEmail }}, commit bot@example.com');
    assert.equal(errors.length, 0);
  });

  test('placeholderKeys ignores ${{ ... }} so validate does not police workflow expressions', () => {
    assert.deepEqual([...placeholderKeys('deploy {{project.name}} at ${{ github.sha }}')], ['project.name']);
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
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
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
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: []\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.join(cwd, '.codex/agents/helper.toml')), false);
  });

  test('missing required config fails with actionable error', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'bundles: [demo]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /config\.git\.botEmail/);
  });

  test('local overlay wins over committed config', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.local.yaml'), 'config:\n  git:\n    botEmail: local@example.com\n');
    render();
    assert.match(read(cwd, '.claude/agents/helper.md'), /local@example\.com/);
  });

  test('extensions are appended with markers', () => {
    fs.mkdirSync(path.join(cwd, '.waffle/extensions/skills'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.waffle/extensions/skills/demo-skill.md'), 'Project-specific addendum.\n');
    render();
    const skill = read(cwd, '.claude/skills/demo-skill/SKILL.md');
    assert.match(skill, /BEGIN project extension: \.waffle\/extensions\/skills\/demo-skill\.md/);
    assert.match(skill, /Project-specific addendum\./);
    assert.match(skill, /END project extension/);
    // extension applies to both skill targets
    assert.equal(skill, read(cwd, '.agents/skills/demo-skill/SKILL.md'));
  });

  test('eject releases files, preserves config comments, render skips item', () => {
    render();
    const { released } = eject({ cwd, item: 'skills/demo-skill' });
    assert.ok(released.includes(path.join('.claude', 'skills', 'demo-skill', 'SKILL.md')));
    const cfgText = read(cwd, '.waffle.yaml');
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
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
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
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: [one, two]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => /output conflict:.*dup-skill/.test(e) && /one\/skills\/dup-skill/.test(e) && /two\/skills\/dup-skill/.test(e)),
      JSON.stringify(result.errors),
    );
  });

  test('harness.skillsDir resolves per target', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude, agents-dir]\nbundles: [one]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.match(read(cwd, '.claude/skills/dup-skill/SKILL.md'), /Read \.claude\/skills\/dup-skill\/SKILL\.md\./);
    assert.match(read(cwd, '.agents/skills/dup-skill/SKILL.md'), /Read \.agents\/skills\/dup-skill\/SKILL\.md\./);
  });
});

describe('unmanaged collision guard (#25)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-col-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-col-'));
    makeFixtureToolkit(toolkitRoot);
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
      'targets: [claude]',
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

  const render = (opts = {}) => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test', ...opts });
  const SKILL = '.claude/skills/demo-skill/SKILL.md';
  const AGENT = '.claude/agents/helper.md';
  const seed = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  };

  test('refuses to clobber a pre-existing unmanaged file, leaving the tree untouched', () => {
    // A hand-written consumer file at a path the render targets, on a repo that never
    // rendered (no lock) — the exact silent-overwrite case #25 is about.
    const handwritten = '---\nname: demo-skill\ndescription: mine\n---\n\nMy own content.\n';
    seed(SKILL, handwritten);

    const result = render();
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes(SKILL) && /refusing to overwrite/.test(e) && /--force/.test(e)),
      JSON.stringify(result.errors),
    );
    // the offending file is byte-for-byte untouched...
    assert.equal(fs.readFileSync(path.join(cwd, SKILL), 'utf8'), handwritten);
    // ...and nothing else was written: no partial render, no lock stamped.
    assert.equal(fs.existsSync(path.join(cwd, AGENT)), false, 'no partial render');
    assert.equal(fs.existsSync(path.join(cwd, '.waffle.lock.json')), false, 'no lock on refusal');
  });

  test('--force overwrites the unmanaged file and records it in the lock', () => {
    const handwritten = 'mine\n';
    seed(SKILL, handwritten);

    const result = render({ force: true });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.notEqual(fs.readFileSync(path.join(cwd, SKILL), 'utf8'), handwritten, 'overwritten by the render');
    const lock = JSON.parse(read(cwd, '.waffle.lock.json'));
    assert.ok(SKILL in lock.files, JSON.stringify(lock.files));
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('a content-identical pre-existing file is adopted silently, no --force needed', () => {
    // Learn the exact bytes the toolkit produces, then simulate a fresh (lock-less) repo
    // that already holds that identical file.
    assert.equal(render().ok, true);
    fs.rmSync(path.join(cwd, '.waffle.lock.json')); // drop the lock → files now "unmanaged"

    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const lock = JSON.parse(read(cwd, '.waffle.lock.json'));
    assert.ok(SKILL in lock.files, 'identical file taken under lock management');
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('a managed file (in the lock) re-renders normally — never a collision', () => {
    assert.equal(render().ok, true); // establishes the lock
    // Local edit to a MANAGED file: the frozen-image contract restores it; the collision
    // guard must not mistake it for an unmanaged pre-existing file.
    fs.appendFileSync(path.join(cwd, SKILL), 'local drift\n');
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.doesNotMatch(fs.readFileSync(path.join(cwd, SKILL), 'utf8'), /local drift/);
  });

  test('names every colliding path; --force renders them all', () => {
    seed(SKILL, 'mine skill\n');
    seed(AGENT, 'mine agent\n');
    const refused = render();
    assert.equal(refused.ok, false);
    assert.equal(refused.errors.length, 2, JSON.stringify(refused.errors));
    assert.ok(refused.errors.some((e) => e.includes(SKILL)) && refused.errors.some((e) => e.includes(AGENT)));

    const forced = render({ force: true });
    assert.equal(forced.ok, true, JSON.stringify(forced.errors));
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('CLI: --force is a recognized render/install flag, not mistaken for a ref', () => {
    // The real CLI resolves the real toolkit, so drive it with an empty selection — it
    // renders against any toolkit with zero config (same trick the #14/upgrade CLI tests
    // use). This exercises the real arg parsing: `--force` must be consumed before the
    // "render takes no refs" guard, and dispatch must exit cleanly.
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: []\nconfig: {}\n');
    const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

    const render = spawnSync(process.execPath, [cli, 'render', '--force', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(render.status, 0, render.stdout + render.stderr);
    assert.doesNotMatch(render.stderr, /takes no refs/);

    const install = spawnSync(process.execPath, [cli, 'install', '--force', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(install.status, 0, install.stdout + install.stderr);
  });
});

describe('files/ payload', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-files-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-files-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: files\nbundles: [fb]\n');
    write(toolkitRoot, 'bundles/fb/bundle.yaml', [
      'name: fb',
      'description: Files fixture.',
      'files:',
      '  - .github/workflows/ci.yml',
      '  - scripts/logo.png',
      'config:',
      '  project.name:',
      '    required: true',
      '    description: project name',
      '',
    ].join('\n'));
    write(toolkitRoot, 'bundles/fb/files/.github/workflows/ci.yml', [
      'name: CI for {{project.name}}',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "sha ${{ github.sha }}"',
      '      - run: echo "token ${{ secrets.GITHUB_TOKEN }}"',
      '',
    ].join('\n'));
    // Binary payload: PNG signature + a NUL byte (so isBinary sniffs it as binary) plus a
    // `{{x}}`-looking byte run, to prove binaries are copied byte-for-byte, never templated.
    fs.mkdirSync(path.join(toolkitRoot, 'bundles/fb/files/scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(toolkitRoot, 'bundles/fb/files/scripts/logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x7b, 0x7b, 0x78, 0x7d, 0x7d]),
    );
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
      '# files fixture comment',
      'targets: [claude, codex, agents-dir]',
      'bundles: [fb]',
      'config:',
      '  project:',
      '    name: Waffle',
      '',
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });

  test('the files fixture is a valid toolkit (GitHub Actions ${{ }} is not flagged)', () => {
    assert.deepEqual(validateToolkit(toolkitRoot), []);
  });

  test('setup inventory lists the bundle files', () => {
    const inv = toolkitInventory(loadToolkit(toolkitRoot), '0.0.test');
    assert.match(inv, /- files: files\/\.github\/workflows\/ci\.yml, files\/scripts\/logo\.png/);
  });

  test('renders text with substitution, preserves ${{ }}, byte-copies binary, doctor round-trips', () => {
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const wf = read(cwd, '.github/workflows/ci.yml');
    assert.match(wf, /name: CI for Waffle/); // {{project.name}} substituted
    assert.match(wf, /sha \$\{\{ github\.sha \}\}/); // GHA expression preserved verbatim
    assert.match(wf, /token \$\{\{ secrets\.GITHUB_TOKEN \}\}/);

    // binary copied byte-for-byte (the embedded {{x}} bytes are untouched)
    const src = fs.readFileSync(path.join(toolkitRoot, 'bundles/fb/files/scripts/logo.png'));
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'scripts/logo.png')), src);

    // both outputs tracked in the lock at their repo-relative paths
    const lock = JSON.parse(read(cwd, '.waffle.lock.json'));
    assert.ok('.github/workflows/ci.yml' in lock.files, JSON.stringify(lock.files));
    assert.ok('scripts/logo.png' in lock.files, JSON.stringify(lock.files));

    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('frozen image: local edit to a files output flagged by doctor, restored, pruned on removal', () => {
    render();
    const wf = path.join(cwd, '.github/workflows/ci.yml');
    const original = fs.readFileSync(wf, 'utf8');
    fs.appendFileSync(wf, '\n# tampered\n');
    const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(dr.ok, false);
    assert.deepEqual(dr.modified, ['.github/workflows/ci.yml']);

    render();
    assert.equal(fs.readFileSync(wf, 'utf8'), original);

    // dropping the bundle cleans up every files output it produced
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: []\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(wf), false);
    assert.equal(fs.existsSync(path.join(cwd, 'scripts/logo.png')), false);
  });

  test('eject files/<path> releases it, preserves config comments, render leaves it project-owned', () => {
    render();
    const { released } = eject({ cwd, item: 'files/.github/workflows/ci.yml' });
    assert.deepEqual(released, ['.github/workflows/ci.yml']);
    const cfg = read(cwd, '.waffle.yaml');
    assert.match(cfg, /# files fixture comment/);
    assert.match(cfg, /eject:/);
    assert.match(cfg, /files\/\.github\/workflows\/ci\.yml/);

    // now project-owned: a hand edit survives re-render and doctor stays clean, while the
    // non-ejected binary remains managed
    fs.appendFileSync(path.join(cwd, '.github/workflows/ci.yml'), '\n# project-owned\n');
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.match(read(cwd, '.github/workflows/ci.yml'), /# project-owned/);
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
    assert.ok(fs.existsSync(path.join(cwd, 'scripts/logo.png')), 'non-ejected binary still managed');
  });

  test('validate flags an undeclared {{key}} in a text files payload', () => {
    const wf = path.join(toolkitRoot, 'bundles/fb/files/.github/workflows/ci.yml');
    fs.appendFileSync(wf, '\n# uses {{made.up.key}}\n');
    const problems = validateToolkit(toolkitRoot);
    assert.ok(problems.some((p) => /made\.up\.key/.test(p)), JSON.stringify(problems));
  });

  test('a required key used only in a files payload is demanded when missing', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: [fb]\nconfig: {}\n');
    const result = render();
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /config\.project\.name/);
  });
});

// The real github-workflow bundle ships a doctor CI workflow as a files/ payload (#14).
// These render THAT actual payload (not a fixture) to prove the shipped artifact is correct.
describe('github-workflow: waffle-doctor CI payload (#14)', () => {
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const REL = '.github/workflows/waffle-doctor.yml';
  const REF = `files/${REL}`;
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-doctor-ci-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const writeConfig = (yaml) => fs.writeFileSync(path.join(cwd, '.waffle.yaml'), yaml);
  const render = () => renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });

  test('per-item install renders the workflow — default toolkitRef, ${{ }} passthrough, SHA-pinned, lock-tracked', () => {
    // The payload references only the optional (defaulted) doctor.toolkitRef plus GitHub
    // Actions ${{ }} expressions, so a bare per-item install needs zero config.
    writeConfig(`targets: [claude]\ninclude: [${REF}]\nconfig: {}\n`);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    // (a) lands at the repo-relative workflow path
    assert.ok(fs.existsSync(path.join(cwd, REL)), 'workflow rendered to its .github path');
    const wf = read(cwd, REL);

    // (b, default) {{doctor.toolkitRef}} → bundle default; {{doctor.flags}} → empty (its
    // default), so the invocation is behaviorally unchanged from today. No leftover placeholders.
    assert.match(wf, /run: npx --yes github:dustinkeeton\/wafflestack doctor/);
    assert.doesNotMatch(wf, /\{\{\s*doctor\.toolkitRef\s*\}\}/);
    assert.doesNotMatch(wf, /\{\{\s*doctor\.flags\s*\}\}/);
    assert.doesNotMatch(wf, /doctor --/); // empty flags default adds no flag

    // (c) GitHub Actions ${{ }} expressions pass through the renderer verbatim
    assert.match(wf, /group: waffle-doctor-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
    assert.match(wf, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);

    // security posture ships intact: 40-char SHA-pinned actions (with a # vX.Y.Z comment),
    // least-privilege token, Node 20 — dogfoods the security-audit CI guidance.
    assert.match(wf, /uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    assert.match(wf, /uses: actions\/setup-node@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    assert.match(wf, /permissions:\n {2}contents: read/);
    assert.match(wf, /node-version: 20/);

    // (d) byte-tracked in the lock at its repo-relative path (hash === sha256 of the bytes),
    // and doctor round-trips clean against that lock.
    const lock = JSON.parse(read(cwd, '.waffle.lock.json'));
    assert.ok(REL in lock.files, JSON.stringify(lock.files));
    assert.equal(lock.files[REL], sha256(wf));
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('doctor.toolkitRef override flows into the npx invocation (pin a release tag)', () => {
    writeConfig(
      `targets: [claude]\ninclude: [${REF}]\n` +
        "config:\n  doctor:\n    toolkitRef: github:dustinkeeton/wafflestack#v0.5.0\n",
    );
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const wf = read(cwd, REL);
    assert.match(wf, /run: npx --yes github:dustinkeeton\/wafflestack#v0\.5\.0 doctor/);
    // ${{ }} expressions remain untouched regardless of the override
    assert.match(wf, /\$\{\{ github\.workflow \}\}/);
  });

  test('doctor.flags override appends to the doctor invocation and stays managed (--allow-missing)', () => {
    // Acceptance case for #30: a repo that gitignores some renders sets doctor.flags rather
    // than ejecting the workflow — the file stays lock-tracked and doctor-clean.
    writeConfig(
      `targets: [claude]\ninclude: [${REF}]\n` +
        'config:\n  doctor:\n    flags: --allow-missing\n',
    );
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const wf = read(cwd, REL);

    // the flag lands after the doctor subcommand, alongside the default toolkitRef
    assert.match(wf, /run: npx --yes github:dustinkeeton\/wafflestack doctor --allow-missing/);
    assert.doesNotMatch(wf, /\{\{\s*doctor\.flags\s*\}\}/);
    // ${{ }} expressions still pass through untouched
    assert.match(wf, /\$\{\{ github\.workflow \}\}/);

    // managed: byte-tracked in the lock and doctor round-trips clean (no drift, no eject)
    const lock = JSON.parse(read(cwd, '.waffle.lock.json'));
    assert.equal(lock.files[REL], sha256(wf));
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('rendered workflow is valid YAML with the required GitHub Actions keys', () => {
    writeConfig(`targets: [claude]\ninclude: [${REF}]\nconfig: {}\n`);
    assert.equal(render().ok, true);
    const parsed = YAML.parse(read(cwd, REL)); // throws on invalid YAML

    assert.ok(parsed.on, 'workflow declares on: triggers');
    assert.deepEqual(parsed.on.push.branches, ['main']);
    assert.ok('pull_request' in parsed.on && 'workflow_dispatch' in parsed.on);
    assert.equal(parsed.permissions.contents, 'read');
    assert.equal(parsed.jobs.doctor['runs-on'], 'ubuntu-latest');
    assert.ok(Array.isArray(parsed.jobs.doctor.steps) && parsed.jobs.doctor.steps.length >= 3);
    // the doctor step actually invokes the toolkit
    assert.ok(parsed.jobs.doctor.steps.some((s) => /\bdoctor\b/.test(s.run ?? '')));
  });
});

describe('doctor --allow-missing (CI drift gate)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-am-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-am-'));
    makeFixtureToolkit(toolkitRoot);
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
      'targets: [claude]',
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
  const SKILL = '.claude/skills/demo-skill/SKILL.md';
  const AGENT = '.claude/agents/helper.md';

  test('missing managed file: fails without the flag, tolerated (exit ok) with it', () => {
    assert.equal(render().ok, true);
    fs.rmSync(path.join(cwd, SKILL));

    const strict = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(strict.ok, false);
    assert.deepEqual(strict.modified, []);
    assert.ok(strict.missing.includes(SKILL), JSON.stringify(strict.missing));

    const lenient = doctor({ cwd, toolkitVersion: '0.0.test', allowMissing: true });
    assert.equal(lenient.ok, true, JSON.stringify(lenient));
    assert.deepEqual(lenient.modified, []);
    // absent file is still surfaced, informationally — never silently swallowed
    assert.ok(lenient.missing.includes(SKILL), JSON.stringify(lenient.missing));
    assert.ok(lenient.notes.some((n) => /tolerated/.test(n)), JSON.stringify(lenient.notes));
  });

  test('a modified file still fails with --allow-missing', () => {
    assert.equal(render().ok, true);
    fs.appendFileSync(path.join(cwd, SKILL), 'local drift\n');

    const lenient = doctor({ cwd, toolkitVersion: '0.0.test', allowMissing: true });
    assert.equal(lenient.ok, false);
    assert.deepEqual(lenient.modified, [SKILL]);
  });

  test('modified dominates: a modified file fails even when another is missing', () => {
    assert.equal(render().ok, true);
    fs.appendFileSync(path.join(cwd, AGENT), 'drift\n');
    fs.rmSync(path.join(cwd, SKILL));

    const lenient = doctor({ cwd, toolkitVersion: '0.0.test', allowMissing: true });
    assert.equal(lenient.ok, false);
    assert.deepEqual(lenient.modified, [AGENT]);
    assert.ok(lenient.missing.includes(SKILL), JSON.stringify(lenient.missing));
  });

  test('a missing lock is still an error with --allow-missing (repo never rendered)', () => {
    // no render → no lock file; the flag must not mask this
    const lenient = doctor({ cwd, toolkitVersion: '0.0.test', allowMissing: true });
    assert.equal(lenient.ok, false);
    assert.ok(lenient.notes.some((n) => /not found/.test(n)), JSON.stringify(lenient.notes));
  });

  test('CLI: --allow-missing flips the exit code on an absent render', () => {
    assert.equal(render().ok, true);
    fs.rmSync(path.join(cwd, SKILL));
    const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
    const run = (extra) => spawnSync(process.execPath, [cli, 'doctor', ...extra, '--cwd', cwd], { encoding: 'utf8' });

    const strict = run([]);
    assert.equal(strict.status, 1, strict.stdout + strict.stderr);
    assert.match(strict.stdout, /missing:.*demo-skill\/SKILL\.md/);

    const lenient = run(['--allow-missing']);
    assert.equal(lenient.status, 0, lenient.stdout + lenient.stderr);
    assert.match(lenient.stdout, /missing \(tolerated\):.*demo-skill\/SKILL\.md/);
    assert.match(lenient.stdout, /tolerated/);
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

  const writeConfig = (lines) => fs.writeFileSync(path.join(cwd, '.waffle.yaml'), `${lines.join('\n')}\n`);
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
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
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
    const cfg = read(cwd, '.waffle.yaml');
    assert.match(cfg, /# fixture config comment/);
    assert.match(cfg, /- base/);
    assert.match(cfg, /- orch/);
    // ambiguous item persisted in bundle-qualified canonical form
    assert.match(cfg, /include:/);
    assert.match(cfg, /- alt\/skills\/dupe/);
  });

  test('unambiguous item persists unqualified', () => {
    install(['skills/issue']);
    assert.match(read(cwd, '.waffle.yaml'), /include:\n\s*- skills\/issue/);
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
    const before = read(cwd, '.waffle.yaml');
    assert.throws(() => install(['skills/nope']), /unknown ref/);
    assert.equal(read(cwd, '.waffle.yaml'), before);
  });

  test('already-selected refs are idempotent (config untouched)', () => {
    const before = read(cwd, '.waffle.yaml');
    install(['base']);
    assert.equal(read(cwd, '.waffle.yaml'), before);
  });

  test('eject removes a matching include entry, qualified or not', () => {
    install(['alt/skills/dupe']);
    assert.match(read(cwd, '.waffle.yaml'), /alt\/skills\/dupe/);
    eject({ cwd, item: 'skills/dupe' });
    const cfg = read(cwd, '.waffle.yaml');
    assert.doesNotMatch(cfg, /alt\/skills\/dupe/);
    assert.match(cfg, /eject:/);
  });

  test('install requires an existing config file', () => {
    fs.rmSync(path.join(cwd, '.waffle.yaml'));
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

describe('semver helpers', () => {
  test('parseVersion extracts the X.Y.Z core, tolerating v-prefix and pre-release', () => {
    assert.deepEqual(parseVersion('0.5.0'), [0, 5, 0]);
    assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseVersion('0.6.0-rc.1'), [0, 6, 0]);
    assert.equal(parseVersion('nope'), null);
    assert.equal(parseVersion(undefined), null);
  });

  test('compareVersions is numeric (not lexical); unparseable sorts low', () => {
    assert.equal(compareVersions('0.5.0', '0.6.0'), -1);
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1); // 10 > 9 numerically
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions(null, '0.1.0'), -1);
    assert.equal(compareVersions('0.1.0', null), 1);
    assert.equal(compareVersions(undefined, null), 0);
  });
});

describe('migrations: applicability, ordering, idempotency', () => {
  const steps = [
    { version: '0.6.0', description: 'six', run() {} },
    { version: '0.7.0', description: 'seven', run() {} },
    { version: '0.8.0', description: 'eight', run() {} },
  ];

  test('applicable window is (from, to], ascending; endpoints handled', () => {
    assert.deepEqual(applicableMigrations('0.5.0', '0.7.0', steps).map((s) => s.version), ['0.6.0', '0.7.0']);
    // from is exclusive, to is inclusive
    assert.deepEqual(applicableMigrations('0.6.0', '0.8.0', steps).map((s) => s.version), ['0.7.0', '0.8.0']);
    assert.deepEqual(applicableMigrations('0.8.0', '0.8.0', steps).map((s) => s.version), []);
    assert.deepEqual(applicableMigrations('0.9.0', '0.10.0', steps).map((s) => s.version), []);
  });

  test('runMigrations runs ascending regardless of input order and reports what ran', () => {
    const order = [];
    const unsorted = [
      { version: '0.7.0', description: 'b', run: () => order.push('b') },
      { version: '0.6.0', description: 'a', run: () => order.push('a') },
    ];
    const ran = runMigrations({ cwd: '/x', fromVersion: '0.5.0', toVersion: '0.7.0', migrations: unsorted });
    assert.deepEqual(order, ['a', 'b']);
    assert.deepEqual(ran.map((r) => r.version), ['0.6.0', '0.7.0']);
  });
});

describe('changelogBetween', () => {
  const text = [
    '# Changelog', '',
    '## [Unreleased]', '- wip', '',
    '## [0.7.0] - 2026-08-01', '### Consumer impact', '- rename', '',
    '## [0.6.0] - 2026-07-15', '### Added', '- thing', '',
    '## [0.5.0] - 2026-07-01', '### Added', '- setup', '',
  ].join('\n');

  test('extracts (from, to] sections, newest first, skipping Unreleased and the from version', () => {
    const delta = changelogBetween(text, '0.5.0', '0.7.0');
    assert.match(delta, /## \[0\.7\.0\]/);
    assert.match(delta, /## \[0\.6\.0\]/);
    assert.doesNotMatch(delta, /## \[0\.5\.0\]/); // from is exclusive
    assert.doesNotMatch(delta, /Unreleased/); // non-semver heading skipped
    assert.ok(delta.indexOf('0.7.0') < delta.indexOf('0.6.0'), 'newest first');
  });

  test('returns null when nothing falls in range', () => {
    assert.equal(changelogBetween(text, '0.7.0', '0.7.0'), null);
  });
});

describe('upgrade: end-to-end across a synthetic breaking change', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-up-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-up-'));
    makeFixtureToolkit(toolkitRoot);
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), [
      'targets: [claude]',
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

  const LOCK = '.waffle.lock.json';
  const legacy = () => path.join(cwd, 'LEGACY_MARKER');
  // Stands in for a real breaking change (#17's dotfile rename is the first): drop a legacy
  // artifact the old toolkit left behind. Idempotent — a missing marker is a no-op.
  const migrations = [
    {
      version: '0.6.0',
      description: 'remove the legacy marker file',
      run: (dir) => {
        const f = path.join(dir, 'LEGACY_MARKER');
        if (fs.existsSync(f)) fs.rmSync(f);
      },
    },
  ];
  const lockVersion = () => JSON.parse(read(cwd, LOCK)).toolkitVersion;

  test('runs the migration, prints the delta, re-renders, re-stamps, doctor clean', () => {
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.5.0' }).ok, true);
    fs.writeFileSync(legacy(), 'stale\n');
    assert.equal(lockVersion(), '0.5.0');

    const changelog = '# Changelog\n\n## [0.6.0] - 2026-08-01\n### Consumer impact\n- drop legacy marker\n';
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.6.0', migrations, changelog });

    assert.equal(result.ok, true, JSON.stringify(result.notes));
    assert.equal(result.status, 'upgrade');
    assert.equal(result.fromVersion, '0.5.0');
    assert.equal(result.toVersion, '0.6.0');
    assert.deepEqual(result.migrationsRun.map((m) => m.version), ['0.6.0']);
    assert.match(result.changelogDelta, /drop legacy marker/);
    assert.equal(fs.existsSync(legacy()), false, 'migration side effect applied');
    assert.equal(lockVersion(), '0.6.0', 'lock re-stamped to the target version');
    assert.equal(result.doctor.ok, true, JSON.stringify(result.doctor));
    assert.ok(
      result.doctor.notes.some((n) => /rendered by toolkit 0\.6\.0/.test(n)),
      JSON.stringify(result.doctor.notes),
    );
  });

  test('idempotent: re-running at the same version applies no migrations (status current)', () => {
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.6.0' }).ok, true);
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.6.0', migrations });
    assert.equal(result.status, 'current');
    assert.deepEqual(result.migrationsRun, []);
    assert.equal(result.ok, true);
  });

  test('downgrade: lock newer than CLI runs no migrations but still renders + doctors', () => {
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.7.0' }).ok, true);
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.6.0', migrations });
    assert.equal(result.status, 'downgrade');
    assert.deepEqual(result.migrationsRun, []);
    assert.equal(lockVersion(), '0.6.0');
    assert.ok(result.notes.some((n) => /newer than this CLI/.test(n)), JSON.stringify(result.notes));
  });

  test('missing lock: degrades to render + doctor with a clear note, no migrations', () => {
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.6.0', migrations });
    assert.equal(result.status, 'no-lock');
    assert.deepEqual(result.migrationsRun, []);
    assert.equal(result.ok, true);
    assert.ok(result.notes.some((n) => /nothing to upgrade from/.test(n)), JSON.stringify(result.notes));
    assert.equal(lockVersion(), '0.6.0'); // fresh render created + stamped the lock
  });

  test('lock without toolkitVersion: skips migrations, notes it, re-stamps on render', () => {
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.5.0' }).ok, true);
    const lockPath = path.join(cwd, LOCK);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    delete lock.toolkitVersion;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    fs.writeFileSync(legacy(), 'stale\n');

    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.6.0', migrations });
    assert.equal(result.status, 'no-version');
    assert.deepEqual(result.migrationsRun, []);
    assert.equal(fs.existsSync(legacy()), true, 'migrations skipped when baseline unknown');
    assert.equal(lockVersion(), '0.6.0');
    assert.ok(result.notes.some((n) => /no toolkitVersion/i.test(n)), JSON.stringify(result.notes));
  });

  test('CLI: upgrade on a current, freshly-rendered repo exits 0; rejects positional refs', () => {
    const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
    // Empty selection renders against any toolkit (incl. the real one the CLI resolves),
    // so this exercises the real dispatch + pkg.version without needing bundle config.
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: []\nconfig: {}\n');
    const render = spawnSync(process.execPath, [cli, 'render', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(render.status, 0, render.stdout + render.stderr);

    const up = spawnSync(process.execPath, [cli, 'upgrade', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(up.status, 0, up.stdout + up.stderr);
    assert.match(up.stdout, /already on toolkit/);
    assert.match(up.stdout, /upgrade complete/);

    const bad = spawnSync(process.execPath, [cli, 'upgrade', 'skills/foo', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /takes no refs/);
  });
});

describe('legacy .wafflestack.* → .waffle.* rename (#17)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-r17-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-r17-'));
    makeFixtureToolkit(toolkitRoot);
  });
  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const LEGACY_CFG = 'targets: [claude]\nbundles: [demo]\nconfig:\n  git:\n    botEmail: bot@example.com\n';

  test('loadProjectConfig falls back to a legacy .wafflestack.yaml (+ .local) with deprecation notes', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude]\nbundles: [demo]\nconfig: {}\n');
    fs.writeFileSync(path.join(cwd, '.wafflestack.local.yaml'), 'config:\n  git:\n    botEmail: local@example.com\n');
    const notes = [];
    const cfg = loadProjectConfig(cwd, notes);
    assert.deepEqual(cfg.targets, ['claude']);
    assert.deepEqual(cfg.bundles, ['demo']);
    assert.equal(cfg.values.git.botEmail, 'local@example.com', 'legacy local overlay still merges and wins');
    assert.ok(notes.some((n) => /legacy \.wafflestack\.yaml is deprecated/.test(n)), JSON.stringify(notes));
    assert.ok(notes.some((n) => /legacy \.wafflestack\.local\.yaml is deprecated/.test(n)), JSON.stringify(notes));
  });

  test('a fresh .waffle.yaml is read with no deprecation note', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), 'targets: [claude]\nbundles: [demo]\nconfig: {}\n');
    const notes = [];
    loadProjectConfig(cwd, notes);
    assert.deepEqual(notes, []);
  });

  test('render migrates a legacy repo: renames dotfiles, moves extensions, warns about .gitignore, doctor clean', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), LEGACY_CFG);
    fs.mkdirSync(path.join(cwd, '.wafflestack/extensions/skills'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.wafflestack/extensions/skills/demo-skill.md'), 'Legacy addendum.\n');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.wafflestack.local.yaml\n.wafflestack.lock.json\n');

    const logs = [];
    const result = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.6.0', log: (m) => logs.push(m) });
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    // dotfiles renamed to the new names; legacy names gone
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.yaml')));
    assert.ok(!fs.existsSync(path.join(cwd, '.wafflestack.yaml')));
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.lock.json')));
    // extensions dir moved AND its content is applied to the render
    assert.ok(fs.existsSync(path.join(cwd, '.waffle/extensions/skills/demo-skill.md')));
    assert.ok(!fs.existsSync(path.join(cwd, '.wafflestack')), 'emptied legacy .wafflestack/ dir removed');
    assert.match(read(cwd, '.claude/skills/demo-skill/SKILL.md'), /Legacy addendum\./);
    // rename logged; .gitignore reminder surfaced (CLI never edits .gitignore)
    assert.ok(logs.some((l) => /renamed legacy \.wafflestack\.yaml → \.waffle\.yaml/.test(l)), logs.join('\n'));
    assert.ok(
      result.warnings.some((w) => /\.gitignore still lists .*\.waffle\.\* names/.test(w)),
      JSON.stringify(result.warnings),
    );
    assert.equal(doctor({ cwd, toolkitVersion: '0.6.0' }).ok, true);
  });

  test('the registered 0.6.0 migration renames legacy dotfiles and is idempotent', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude]\n');
    fs.writeFileSync(path.join(cwd, '.wafflestack.lock.json'), '{"toolkitVersion":"0.5.0","files":{}}\n');
    const step = MIGRATIONS.find((m) => m.version === '0.6.0');
    assert.ok(step, 'a real 0.6.0 migration step is registered');

    step.run(cwd);
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.yaml')));
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.lock.json')));
    assert.ok(!fs.existsSync(path.join(cwd, '.wafflestack.yaml')));

    // idempotent: a second run neither throws nor clobbers the migrated files
    const migrated = read(cwd, '.waffle.yaml');
    step.run(cwd);
    assert.equal(read(cwd, '.waffle.yaml'), migrated);
  });

  test('runMigrations applies the real 0.6.0 step across the 0.5.0 → 0.6.0 window, not at/below 0.6.0', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude]\n');
    const ran = runMigrations({ cwd, fromVersion: '0.5.0', toVersion: '0.6.0' }); // real MIGRATIONS default
    assert.deepEqual(ran.map((s) => s.version), ['0.6.0']);
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.yaml')));
    // from is exclusive: a repo already on 0.6.0 does not re-run the step
    assert.deepEqual(applicableMigrations('0.6.0', '0.6.0').map((s) => s.version), []);
  });

  test('upgrade() carries a legacy 0.5.0-rendered repo across the rename via the real migration', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), LEGACY_CFG);
    // Render at 0.5.0, then fake the pre-rename layout a 0.5.0 toolkit would have left on disk.
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.5.0' }).ok, true);
    fs.renameSync(path.join(cwd, '.waffle.yaml'), path.join(cwd, '.wafflestack.yaml'));
    fs.renameSync(path.join(cwd, '.waffle.lock.json'), path.join(cwd, '.wafflestack.lock.json'));

    const changelog = '# Changelog\n\n## [0.6.0] - 2026-07-02\n### Consumer impact\n- dotfile rename\n';
    const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.6.0', changelog });
    assert.equal(result.ok, true, JSON.stringify(result.notes));
    assert.equal(result.fromVersion, '0.5.0');
    assert.deepEqual(result.migrationsRun.map((m) => m.version), ['0.6.0']);

    assert.ok(fs.existsSync(path.join(cwd, '.waffle.yaml')));
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.lock.json')));
    assert.ok(!fs.existsSync(path.join(cwd, '.wafflestack.yaml')));
    assert.ok(!fs.existsSync(path.join(cwd, '.wafflestack.lock.json')));
    assert.equal(JSON.parse(read(cwd, '.waffle.lock.json')).toolkitVersion, '0.6.0', 're-stamped to the target');
    assert.equal(result.doctor.ok, true, JSON.stringify(result.doctor));
  });

  test('doctor on a legacy lock reads it (fallback) and flags the deprecation', () => {
    fs.writeFileSync(path.join(cwd, '.waffle.yaml'), LEGACY_CFG);
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.6.0' }).ok, true);
    fs.renameSync(path.join(cwd, '.waffle.lock.json'), path.join(cwd, '.wafflestack.lock.json'));

    const dr = doctor({ cwd, toolkitVersion: '0.6.0' });
    assert.equal(dr.ok, true, JSON.stringify(dr));
    assert.ok(dr.notes.some((n) => /legacy \.wafflestack\.lock\.json is deprecated/.test(n)), JSON.stringify(dr.notes));
  });

  test('init refuses to scaffold over a legacy .wafflestack.yaml', () => {
    fs.writeFileSync(path.join(cwd, '.wafflestack.yaml'), 'targets: [claude]\n');
    assert.throws(() => init({ cwd }), /\.wafflestack\.yaml already exists.*render/s);
    assert.ok(!fs.existsSync(path.join(cwd, '.waffle.yaml')), 'no duplicate config written');
  });

  test('staleGitignoreEntries reports legacy lines and self-clears once updated', () => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n.wafflestack.local.yaml\n.wafflestack.lock.json\n');
    assert.deepEqual(staleGitignoreEntries(cwd), ['.wafflestack.local.yaml', '.wafflestack.lock.json']);
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules/\n.waffle.local.yaml\n.waffle.lock.json\n');
    assert.deepEqual(staleGitignoreEntries(cwd), []);
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
