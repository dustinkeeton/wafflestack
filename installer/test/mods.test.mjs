// The `mods/` render kind (#560): a Claude Code plugin dir a stack ships, copied verbatim to
// `.claude/mods/<name>/` for the `claude` target only, lock-managed like every other kind.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { eject } from '../lib/eject.mjs';
import { validateToolkit, validateModPlugins, formatModPluginChecks } from '../lib/validate.mjs';
import { toolkitInventory, setupGuide } from '../lib/setup.mjs';
import { loadToolkit, MOD_MANIFEST, MOD_TARGETS, MOD_ENGINE_LAID, isEngineLaid } from '../lib/toolkit.mjs';
import { resolveRef, parseRef, normalizeItemRef, itemOutputMatcher, modOutputDir, computeSelection } from '../lib/refs.mjs';
import { computeListModel, STATUS } from '../lib/list.mjs';
import { WAFFLE_KINDS, refKindOf, waffleKindOf, canonicalWafflePath } from '../lib/registry.mjs';

const MOD_FILES = {
  [MOD_MANIFEST]: '{"name": "viewer", "version": "0.0.1"}\n',
  'hooks/hooks.json': '{"hooks": {"SessionStart": [{"hooks": [{"type": "function", "name": "register"}]}]}}\n',
  // Code, not a template: the `{{…}}` run must survive the render byte-for-byte.
  'hooks/register.tsx': 'export const banner = `{{project.name}} and {{ harness.name }}`;\n',
  'types/index.d.ts': 'export {};\n',
};
const OUT = Object.keys(MOD_FILES).map((rel) => path.join('.claude', 'mods', 'viewer', rel)).sort();

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function writeMod(root, stack, name = 'viewer') {
  for (const [rel, content] of Object.entries(MOD_FILES)) write(root, `stacks/${stack}/mods/${name}/${rel}`, content);
}

function writeStack(root, name, extra = []) {
  write(root, `stacks/${name}/stack.yaml`, [`name: ${name}`, `description: Mod fixture ${name}.`, 'mods: [viewer]', ...extra, ''].join('\n'));
  writeMod(root, name);
}

const project = (lines) => ['config: {}', ...lines, ''].join('\n');

describe('mods/ render kind (#560)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-mods-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mods-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: mods\nstacks: [mb]\n');
    writeStack(toolkitRoot, 'mb');
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude, codex, agents-dir]', 'stacks: [mb]']));
  });

  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
  const lockFiles = () => Object.keys(JSON.parse(read(cwd, '.waffle/waffle.lock.json')).files);
  const modPaths = () => lockFiles().filter((rel) => rel.startsWith(path.join('.claude', 'mods') + path.sep)).sort();

  test('loads as a ModItem: verbatim file list, scoped to claude', () => {
    const [mod] = loadToolkit(toolkitRoot).stacks.get('mb').mods;
    assert.equal(mod.kind, 'mod');
    assert.equal(mod.name, 'viewer');
    assert.equal(mod.dir, path.join(toolkitRoot, 'stacks/mb/mods/viewer'));
    assert.deepEqual(mod.files, Object.keys(MOD_FILES).sort());
    assert.deepEqual(mod.targets, [...MOD_TARGETS]);
    assert.deepEqual(validateToolkit(toolkitRoot), []);
  });

  test('ref grammar and output matcher know the kind', () => {
    assert.equal(normalizeItemRef('mod:viewer'), 'mods/viewer');
    assert.equal(normalizeItemRef('mod/viewer'), 'mods/viewer');
    assert.deepEqual(parseRef('mods/viewer'), { form: 'item', kind: 'mods', name: 'viewer' });
    assert.deepEqual(parseRef('mb/mods/viewer'), { form: 'qualified', stack: 'mb', kind: 'mods', name: 'viewer' });
    const resolved = resolveRef(loadToolkit(toolkitRoot), 'mods/viewer');
    assert.equal(resolved.type, 'item');
    assert.equal(resolved.canonicalRef, 'mods/viewer');
    assert.equal(resolved.item.kind, 'mod');
    assert.equal(modOutputDir('viewer'), path.join('.claude', 'mods', 'viewer'));
    const owns = itemOutputMatcher('mods', 'viewer');
    assert.equal(owns(path.join('.claude', 'mods', 'viewer', 'hooks', 'hooks.json')), true);
    assert.equal(owns(path.join('.claude', 'mods', 'viewer2', 'hooks', 'hooks.json')), false);
    assert.equal(owns(path.join('.claude', 'skills', 'viewer', 'SKILL.md')), false);
  });

  test('the registry vocabulary maps the kind both ways', () => {
    assert.ok(WAFFLE_KINDS.includes('mod'));
    assert.equal(refKindOf('mod'), 'mods');
    assert.equal(waffleKindOf('mods'), 'mod');
    assert.equal(canonicalWafflePath('mb', 'mod', 'viewer'), 'stacks/mb/mods/viewer');
  });

  test('renders verbatim to .claude/mods/<name>/ only, lands in the lock, doctor round-trips', () => {
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    for (const [rel, content] of Object.entries(MOD_FILES)) {
      assert.equal(read(cwd, path.join('.claude', 'mods', 'viewer', rel)), content);
    }
    assert.deepEqual(modPaths(), OUT);
    assert.ok(!result.written.some((rel) => /^\.(codex|agents)\//.test(rel) && rel.includes('viewer')), 'no codex/agents-dir surface');
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('frozen image: a hand-edit is flagged by doctor and restored by render', () => {
    render();
    const file = path.join(cwd, '.claude', 'mods', 'viewer', 'hooks', 'register.tsx');
    fs.appendFileSync(file, '// tampered\n');
    const dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(dr.ok, false);
    assert.deepEqual(dr.modified, [path.join('.claude', 'mods', 'viewer', 'hooks', 'register.tsx')]);
    render();
    assert.equal(fs.readFileSync(file, 'utf8'), MOD_FILES['hooks/register.tsx']);
  });

  test('does not render without the claude target, and disabling claude after a render prunes it', () => {
    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex, agents-dir]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'mods')), false);
    assert.deepEqual(modPaths(), []);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude, codex]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    assert.deepEqual(modPaths(), OUT);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: [mb]']));
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual([...result.removed].sort(), OUT);
    for (const rel of OUT) assert.equal(fs.existsSync(path.join(cwd, rel)), false, rel);
    assert.deepEqual(modPaths(), []);
  });

  test('an explicit include: of a mod with claude disabled is reported, not silently dropped', () => {
    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: []', 'include: [mods/viewer]']));
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(result.warnings.some((w) => /mods\/viewer is scoped to targets \[claude\]/.test(w)), JSON.stringify(result.warnings));
    assert.deepEqual(modPaths(), []);
  });

  test('list classifies the mod by the claude target', () => {
    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: [mb]']));
    const row = () => computeListModel({ toolkitRoot, cwd, toolkitVersion: '0.0.test' }).stacks[0].rows.find((r) => r.kind === 'mods');
    assert.equal(row().ref, 'mods/viewer');
    assert.equal(row().status, STATUS.NOT_INSTALLABLE);
    assert.deepEqual(row().targets, ['claude']);
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb]']));
    assert.equal(row().status, STATUS.OUTDATED, 'selected but never rendered');
    render();
    assert.equal(row().status, STATUS.CURRENT);
  });

  test('eject mods/<name> releases every file and leaves the dir project-owned', () => {
    render();
    const { released } = eject({ cwd, item: 'mods/viewer' });
    assert.deepEqual(released, OUT);
    assert.match(read(cwd, '.waffle/waffle.yaml'), /eject:\n\s+- mods\/viewer/);
    assert.deepEqual(modPaths(), []);

    const file = path.join(cwd, '.claude', 'mods', 'viewer', 'hooks', 'register.tsx');
    fs.appendFileSync(file, '// project-owned\n');
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.match(fs.readFileSync(file, 'utf8'), /project-owned/);
    assert.deepEqual(modPaths(), []);
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('two enabled stacks shipping the same mod name is a hard render error', () => {
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: mods\nstacks: [mb, mb2]\n');
    writeStack(toolkitRoot, 'mb2');
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb, mb2]']));
    const result = render();
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /output conflict: .*\.claude[\\/]mods[\\/]viewer/.test(e)), JSON.stringify(result.errors));
  });

  test('optIn: gates a mod out of stack expansion; include pours it; the lock then keeps it', () => {
    writeStack(toolkitRoot, 'mb', ['optIn: [mods/viewer]']);
    assert.deepEqual(validateToolkit(toolkitRoot), []);
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    assert.deepEqual(modPaths(), []);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb]', 'include: [mods/viewer]']));
    assert.equal(render().ok, true);
    assert.deepEqual(modPaths(), OUT);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    assert.deepEqual(modPaths(), OUT, 'a tracked opt-in mod keeps rendering');
  });

  test('a malformed mods: entry is a load error, never a silent prune', () => {
    const manifest = (body) => write(toolkitRoot, 'stacks/mb/stack.yaml', `name: mb\ndescription: x.\n${body}\n`);
    manifest('mods: viewer');
    assert.throws(() => loadToolkit(toolkitRoot), /`mods:` must be a list/);
    manifest('mods: [../viewer]');
    assert.throws(() => loadToolkit(toolkitRoot), /bare name/);
    manifest('mods: [ghost]');
    assert.throws(() => loadToolkit(toolkitRoot), /mods entry "ghost" has no directory under mods\//);
    manifest('mods: [viewer]');
    fs.rmSync(path.join(toolkitRoot, 'stacks/mb/mods/viewer', MOD_MANIFEST));
    assert.throws(() => loadToolkit(toolkitRoot), /mod viewer has no \.claude-plugin\/plugin\.json/);
    assert.match(validateToolkit(toolkitRoot).join('\n'), /toolkit failed to load/);
  });

  test('validate reconciles mods against the waffle registry, and wip gates them', () => {
    write(toolkitRoot, 'stacks/registry.yaml', 'waffles: []\n');
    const problems = validateToolkit(toolkitRoot);
    assert.ok(problems.some((p) => /lists mods\/viewer in stack\.yaml, but it is not in the waffle registry/.test(p)), JSON.stringify(problems));
    assert.ok(problems.some((p) => /stacks\/mb\/mods\/viewer exists on disk but is not in the waffle registry/.test(p)), JSON.stringify(problems));

    const entry = (status) => `waffles:\n  - name: viewer\n    kind: mod\n    stack: mb\n    path: stacks/mb/mods/viewer\n    status: ${status}\n`;
    write(toolkitRoot, 'stacks/registry.yaml', entry('stable'));
    assert.deepEqual(validateToolkit(toolkitRoot), []);

    write(toolkitRoot, 'stacks/registry.yaml', entry('wip'));
    const toolkit = loadToolkit(toolkitRoot);
    assert.equal(computeSelection(toolkit, { targets: ['claude'], stacks: ['mb'], include: [], eject: [] }).items.length, 0);
    assert.throws(() => resolveRef(toolkit, 'mods/viewer'), /work-in-progress/);
  });

  test('validate reds a mod whose plugin manifest is not JSON', () => {
    write(toolkitRoot, `stacks/mb/mods/viewer/${MOD_MANIFEST}`, 'not json\n');
    assert.ok(validateToolkit(toolkitRoot).some((p) => /mod viewer .*plugin\.json is not valid JSON/.test(p)));
  });

  test('setup inventory offers the mod as a claude-only plugin', () => {
    assert.match(toolkitInventory(loadToolkit(toolkitRoot), '0.0.test'), /- mods \(Claude Code plugins[^)]*\): mods\/viewer/);
  });

  // #564: a `--plugin-dir` load of the SOURCE dir lays per-machine files into it; they never ship.
  test('loadStack skips engine-laid files, so a loaded source dir renders without them', () => {
    assert.deepEqual([...MOD_ENGINE_LAID], ['tsconfig.json', '.claude-plugin/types/']);
    assert.equal(isEngineLaid('tsconfig.json'), true);
    assert.equal(isEngineLaid(path.join('.claude-plugin', 'types', 'dep', 'index.d.ts')), true);
    assert.equal(isEngineLaid(MOD_MANIFEST), false, 'the manifest sits beside types/ and must survive');
    assert.equal(isEngineLaid('hooks/tsconfig.json'), false, 'the file skip is exact, not a basename match');

    write(toolkitRoot, 'stacks/mb/mods/viewer/tsconfig.json', '{"compilerOptions": {}}\n');
    write(toolkitRoot, 'stacks/mb/mods/viewer/.claude-plugin/types/claude-code/index.d.ts', 'export {};\n');
    const [mod] = loadToolkit(toolkitRoot).stacks.get('mb').mods;
    assert.deepEqual(mod.files, Object.keys(MOD_FILES).sort());
    assert.deepEqual(validateToolkit(toolkitRoot), []);

    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(modPaths(), OUT);
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'mods', 'viewer', 'tsconfig.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'mods', 'viewer', '.claude-plugin', 'types')), false);
  });

  test('validateModPlugins runs `claude plugin validate` per mod source dir when the CLI is present', () => {
    const calls = [];
    const run = (cli, dir, timeoutMs) => {
      calls.push({ cli, dir, timeoutMs });
      return { ok: true, output: '✔ Validation passed' };
    };
    const locate = () => ({ path: '/stub/bin/claude', version: '2.1.292' });
    const result = validateModPlugins(toolkitRoot, { locate, run, timeoutMs: 1234 });
    assert.deepEqual(calls, [{ cli: '/stub/bin/claude', dir: path.join(toolkitRoot, 'stacks/mb/mods/viewer'), timeoutMs: 1234 }]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(formatModPluginChecks(result), ['ok: claude plugin validate mb/mods/viewer (claude 2.1.292)']);

    const failing = validateModPlugins(toolkitRoot, {
      locate,
      run: () => ({ ok: false, output: 'Validating plugin manifest\n  ✖ hooks/hooks.json: modules[0] ./missing.tsx not found\n' }),
    });
    assert.equal(failing.problems.length, 1);
    assert.match(failing.problems[0], /stack mb: mod viewer fails `claude plugin validate`:\n\s+Validating plugin manifest\n\s+✖ hooks\/hooks\.json/);
    assert.deepEqual(formatModPluginChecks(failing), ['FAIL: claude plugin validate mb/mods/viewer (claude 2.1.292)']);
  });

  test('validateModPlugins reports a skipped check — not a pass — when the CLI is absent', () => {
    const result = validateModPlugins(toolkitRoot, { locate: () => null, run: () => assert.fail('must not spawn') });
    assert.equal(result.cli, null);
    assert.deepEqual(result.checks, []);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(formatModPluginChecks(result), [
      'skipped: claude plugin validate — `claude` is not on PATH; 1 mod(s) unchecked: mb/mods/viewer',
    ]);

    // A toolkit without mods has nothing to say — no false "skipped" either.
    write(toolkitRoot, 'stacks/mb/stack.yaml', 'name: mb\ndescription: x.\n');
    const none = validateModPlugins(toolkitRoot, { locate: () => assert.fail('no mods, no probe') });
    assert.deepEqual(none.mods, []);
    assert.deepEqual(formatModPluginChecks(none), []);
  });

  test('setup prints how each rendered mod loads, with the CLI probe degrading to a note', () => {
    write(toolkitRoot, 'schema/SETUP.md', '# Setup\n');
    const guide = (locateClaude) => setupGuide(toolkitRoot, '0.0.test', cwd, { locateClaude });

    const current = guide(() => ({ path: '/stub/bin/claude', version: '2.1.292' }));
    assert.match(current, /## Mods \(Claude Code plugins\)/);
    assert.match(current, /### `mods\/viewer` \(mb\) → `\.claude\/mods\/viewer\/`/);
    assert.match(current, /claude plugin validate \.claude\/mods\/viewer/);
    assert.match(current, /claude --plugin-dir "\$PWD\/\.claude\/mods\/viewer"/);
    assert.match(current, /CLAUDE_CODE_PLUGIN_DIRS/);
    assert.match(current, /\/plugin install viewer --marketplace <owner>\/<repo>/);
    assert.match(current, /- test: `claude plugin test \.claude\/mods\/viewer` — runs/);
    assert.match(current, /`\.claude\/mods\/\*\/tsconfig\.json`, `\.claude\/mods\/\*\/\.claude-plugin\/types\/`/);

    const old = guide(() => ({ path: '/stub/bin/claude', version: '2.1.200' }));
    assert.match(old, /`claude plugin test` needs ≥ 2\.1\.291, so skip the test line/);
    assert.match(old, /- test: `claude plugin test \.claude\/mods\/viewer` needs `claude` ≥ 2\.1\.291/);

    const absent = guide(() => null);
    assert.match(absent, /`claude` is not on PATH here/);
    assert.match(absent, /claude --plugin-dir "\$PWD\/\.claude\/mods\/viewer"/, 'the load lines are for the user even when the agent lacks the CLI');

    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: [mb]']));
    assert.doesNotMatch(guide(() => null), /## Mods \(Claude Code plugins\)/, 'no claude target ⇒ no mod renders ⇒ no load block');
  });
});

// The first built-in mod (#562): the toolkit's own `wafflestack` stack ships `mods/waffle-view`.
describe('built-in mod: wafflestack/mods/waffle-view (#562)', () => {
  const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const MOD_DIR = path.join(REPO_ROOT, 'stacks', 'wafflestack', 'mods', 'waffle-view');
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(MOD_DIR, rel), 'utf8'));

  test('loads from the wafflestack stack with the plugin-authoring file set', () => {
    const stack = loadToolkit(REPO_ROOT).stacks.get('wafflestack');
    assert.deepEqual(stack.mods.map((m) => m.name), ['waffle-view']);
    const [mod] = stack.mods;
    assert.equal(mod.kind, 'mod');
    assert.deepEqual(mod.targets, ['claude']);
    for (const rel of [MOD_MANIFEST, 'hooks/hooks.json', 'hooks/register.tsx', 'hooks/state.ts', 'hooks/waffle-view.test.ts', 'types/index.d.ts']) {
      assert.ok(mod.files.includes(rel), `${rel} is part of the mod`);
    }
    assert.deepEqual(validateToolkit(REPO_ROOT), []);
  });

  test('the manifest and hooks.json point at files the mod ships', () => {
    const manifest = readJson(MOD_MANIFEST);
    assert.equal(manifest.name, 'waffle-view');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(fs.existsSync(path.join(MOD_DIR, manifest.types)), `types ${manifest.types} exists`);
    const hooks = readJson('hooks/hooks.json');
    assert.deepEqual(hooks.modules, ['./register.tsx']);
    for (const mod of hooks.modules) assert.ok(fs.existsSync(path.join(MOD_DIR, 'hooks', mod)));
  });

  test('the hooks module reads only through `wafflestack state --json --offline`', () => {
    const register = fs.readFileSync(path.join(MOD_DIR, 'hooks', 'register.tsx'), 'utf8');
    const state = fs.readFileSync(path.join(MOD_DIR, 'hooks', 'state.ts'), 'utf8');
    assert.match(state, /'state', '--json', '--offline'/);
    assert.match(register, /\$\.process\.run\(/);
    assert.doesNotMatch(register, /\$\.fs\.read\(/, 'no direct file parsing: the state CLI is the one read path');
    assert.match(state, /export function selectKeys\(/, 'the #563 context seam is one named function');
  });

  test('renders verbatim into a claude consumer and lands in its lock', () => {
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'project-waffle-view-'));
    try {
      write(consumer, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [wafflestack]']));
      const result = renderProject({ toolkitRoot: REPO_ROOT, cwd: consumer, toolkitVersion: '0.0.test' });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      const lock = JSON.parse(read(consumer, '.waffle/waffle.lock.json'));
      const out = path.join('.claude', 'mods', 'waffle-view');
      for (const rel of ['hooks/register.tsx', 'hooks/waffle-view.test.ts', MOD_MANIFEST]) {
        assert.ok(lock.files[path.join(out, rel)], `${rel} is lock-managed`);
        assert.equal(read(consumer, path.join(out, rel)), fs.readFileSync(path.join(MOD_DIR, rel), 'utf8'), `${rel} is byte-identical`);
      }
      assert.equal(doctor({ cwd: consumer, toolkitVersion: '0.0.test' }).ok, true);
    } finally {
      fs.rmSync(consumer, { recursive: true, force: true });
    }
  });
});
