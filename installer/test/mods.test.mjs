// The `mods/` render kind (#560): a Claude Code plugin dir a stack ships, rendered for the `claude`
// target as project-scope `.claude/settings.json` entries (#594), lock-managed like every other kind.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { uninstall } from '../lib/uninstall.mjs';
import { doctor } from '../lib/doctor.mjs';
import { eject } from '../lib/eject.mjs';
import { validateToolkit, validateModPlugins, formatModPluginChecks } from '../lib/validate.mjs';
import { toolkitInventory, setupGuide } from '../lib/setup.mjs';
import { loadToolkit, MOD_MANIFEST, MOD_TARGETS, MOD_ENGINE_LAID, isEngineLaid } from '../lib/toolkit.mjs';
import { resolveRef, parseRef, normalizeItemRef, itemOutputMatcher, legacyModDir, computeSelection } from '../lib/refs.mjs';
import { computeListModel, STATUS } from '../lib/list.mjs';
import { WAFFLE_KINDS, refKindOf, waffleKindOf, canonicalWafflePath } from '../lib/registry.mjs';
import { MARKETPLACE_FILE, validateMarketplace, marketplacePluginId } from '../lib/marketplace.mjs';
import { SETTINGS_FILE, settingsKey, parseSettingsKey, marketplaceKey, pluginKey } from '../lib/settings.mjs';

const MOD_FILES = {
  [MOD_MANIFEST]: '{"name": "viewer", "version": "0.0.1"}\n',
  'hooks/hooks.json': '{"hooks": {"SessionStart": [{"hooks": [{"type": "function", "name": "register"}]}]}}\n',
  // Code, not a template: the `{{…}}` run must survive the render byte-for-byte.
  'hooks/register.tsx': 'export const banner = `{{project.name}} and {{ harness.name }}`;\n',
  'types/index.d.ts': 'export {};\n',
};
const LEGACY_OUT = Object.keys(MOD_FILES).map((rel) => path.join('.claude', 'mods', 'viewer', rel)).sort();
const MARKET = marketplaceKey('fixture');
const PLUGIN = pluginKey('viewer@fixture');
const ENTRIES = { [MARKET]: { source: { source: 'github', repo: 'acme/fixture' } }, [PLUGIN]: true };
const OUT = Object.keys(ENTRIES).sort();

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

const writeMarketplace = (root, plugins = [{ name: 'viewer', source: './stacks/mb/mods/viewer' }]) =>
  write(root, MARKETPLACE_FILE, JSON.stringify({ name: 'fixture', owner: { name: 'x' }, plugins }));

const project = (lines) => ['config: {}', ...lines, ''].join('\n');

describe('mods/ render kind (#560)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-mods-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mods-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: mods\nstacks: [mb]\n');
    writeStack(toolkitRoot, 'mb');
    writeMarketplace(toolkitRoot);
    write(toolkitRoot, 'package.json', JSON.stringify({ name: 'fixture', repository: { url: 'git+https://github.com/acme/fixture.git' } }));
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude, codex, agents-dir]', 'stacks: [mb]']));
  });

  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
  const lock = () => JSON.parse(read(cwd, '.waffle/waffle.lock.json'));
  const modPaths = () => Object.keys(lock().settings ?? {}).sort();
  const settings = () => JSON.parse(read(cwd, SETTINGS_FILE));
  const noModsDir = () => assert.equal(fs.existsSync(path.join(cwd, '.claude', 'mods')), false, 'no .claude/mods/');

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
    assert.equal(legacyModDir('viewer'), path.join('.claude', 'mods', 'viewer'));
    const owns = itemOutputMatcher('mods', 'viewer');
    assert.equal(owns(PLUGIN), true);
    assert.equal(owns(pluginKey('viewer2@fixture')), false);
    assert.equal(owns(MARKET), false, 'the marketplace entry belongs to no single mod');
    assert.equal(owns(path.join('.claude', 'mods', 'viewer', 'hooks', 'hooks.json')), true, 'a pre-#594 lock still counts as poured');
    assert.equal(owns(path.join('.claude', 'mods', 'viewer2', 'hooks', 'hooks.json')), false);
    assert.equal(owns(path.join('.claude', 'skills', 'viewer', 'SKILL.md')), false);
  });

  test('the registry vocabulary maps the kind both ways', () => {
    assert.ok(WAFFLE_KINDS.includes('mod'));
    assert.equal(refKindOf('mod'), 'mods');
    assert.equal(waffleKindOf('mods'), 'mod');
    assert.equal(canonicalWafflePath('mb', 'mod', 'viewer'), 'stacks/mb/mods/viewer');
  });

  test('pointer keys escape per RFC 6901 and round-trip', () => {
    const key = settingsKey(['enabledPlugins', 'a/b~c@m']);
    assert.equal(key, `${SETTINGS_FILE}#/enabledPlugins/a~1b~0c@m`);
    assert.deepEqual(parseSettingsKey(key), { file: SETTINGS_FILE, segments: ['enabledPlugins', 'a/b~c@m'] });
  });

  test('renders settings entries — never .claude/mods/ — lands in the lock, doctor round-trips', () => {
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    noModsDir();
    assert.deepEqual(settings(), {
      extraKnownMarketplaces: { fixture: { source: { source: 'github', repo: 'acme/fixture' } } },
      enabledPlugins: { 'viewer@fixture': true },
    });
    assert.deepEqual(lock().settings, ENTRIES);
    assert.ok(!Object.keys(lock().files).some((rel) => rel.includes('viewer')), 'no file is rendered for a mod');
    assert.ok(!result.written.some((rel) => /^\.(codex|agents)\//.test(rel) && rel.includes('viewer')), 'no codex/agents-dir surface');
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
    const again = render();
    assert.deepEqual(again.removed, [], 'a re-render is a no-op');
  });

  const pinned = (ref) => write(cwd, '.waffle/waffle.yaml', [
    'config:', '  waffle:', `    toolkitRef: ${ref}`, 'targets: [claude]', 'stacks: [mb]', ''].join('\n'));
  const marketSource = () => settings().extraKnownMarketplaces.fixture.source;

  test('the marketplace source pins waffle.toolkitRef\'s tag; an unpinned or non-GitHub value omits ref (#595)', () => {
    pinned('github:acme/fixture#v1.2.3');
    assert.equal(render().ok, true);
    assert.deepEqual(marketSource(), { source: 'github', repo: 'acme/fixture', ref: 'v1.2.3' });
    assert.deepEqual(lock().settings[MARKET], { source: { source: 'github', repo: 'acme/fixture', ref: 'v1.2.3' } });
    for (const unpinned of ['github:acme/fixture', './local/toolkit']) {
      pinned(unpinned);
      assert.equal(render().ok, true);
      assert.deepEqual(marketSource(), ENTRIES[MARKET].source, `${unpinned} tracks the default branch`);
    }
  });

  test('a pin that disagrees with the rendered ref is drift; a re-render rolls it forward (#595)', () => {
    pinned('github:acme/fixture#v1.2.3');
    render();
    write(cwd, SETTINGS_FILE, JSON.stringify({ ...settings(), extraKnownMarketplaces: { fixture: { source: { ...marketSource(), ref: 'v9.9.9' } } } }));
    assert.deepEqual(doctor({ cwd, toolkitVersion: '0.0.test' }).modified, [MARKET], 'a hand-edited ref is an edit');
    render();

    pinned('github:acme/fixture#v1.3.0');
    const verify = () => doctor({ cwd, toolkitRoot, toolkitVersion: '0.0.test', verifyRender: true });
    assert.deepEqual(verify().render.stale, [MARKET], 'a moved pin leaves the committed ref stale');
    const result = render();
    assert.equal(result.ok, true, 'a managed key rolls forward without a collision');
    assert.equal(marketSource().ref, 'v1.3.0');
    assert.equal(verify().ok, true);
  });

  test('a pin naming another repo still sets ref, with a warning (#595)', () => {
    pinned('github:fork/fixture#v1.2.3');
    const result = render();
    assert.equal(marketSource().ref, 'v1.2.3');
    assert.ok(result.warnings.some((w) => /pins fork\/fixture, but mods install from the acme\/fixture marketplace/.test(w)));
  });

  test('merges beside the consumer\'s own keys and never overwrites them', () => {
    const own = {
      env: { FOO: '1' },
      enabledPlugins: { 'other@elsewhere': true },
      extraKnownMarketplaces: { elsewhere: { source: { source: 'github', repo: 'x/y' } } },
      permissions: { allow: ['Bash(ls)'] },
    };
    write(cwd, SETTINGS_FILE, `${JSON.stringify(own, null, 2)}\n`);
    assert.equal(render().ok, true);
    assert.deepEqual(settings(), {
      ...own,
      enabledPlugins: { 'other@elsewhere': true, 'viewer@fixture': true },
      extraKnownMarketplaces: { ...own.extraKnownMarketplaces, fixture: ENTRIES[MARKET] },
    });

    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: [mb]']));
    const result = render();
    assert.deepEqual([...result.removed].sort(), OUT);
    assert.deepEqual(settings(), own, 'the prune takes only our keys back out');
    assert.equal(lock().settings, undefined);
  });

  test('an unmanaged key holding a different value is refused; an identical one is adopted', () => {
    write(cwd, SETTINGS_FILE, JSON.stringify({ enabledPlugins: { 'viewer@fixture': false } }));
    const refused = render();
    assert.equal(refused.ok, false);
    assert.match(refused.errors.join('\n'), /refusing to overwrite settings entry .*viewer@fixture/);
    assert.deepEqual(settings(), { enabledPlugins: { 'viewer@fixture': false } }, 'a refusal writes nothing');
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test', force: true }).ok, true);
    assert.equal(settings().enabledPlugins['viewer@fixture'], true);

    fs.rmSync(path.join(cwd, '.waffle', 'waffle.lock.json'));
    assert.equal(render().ok, true, 'identical bytes are adopted silently');

    write(cwd, SETTINGS_FILE, '{ not json');
    const bad = render();
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('\n'), /settings\.json is not valid JSON/);
  });

  test('frozen image: doctor flags an edited or removed entry, and render restores it', () => {
    render();
    write(cwd, SETTINGS_FILE, JSON.stringify({ ...settings(), enabledPlugins: { 'viewer@fixture': false } }));
    let dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.equal(dr.ok, false);
    assert.deepEqual(dr.modified, [PLUGIN]);

    const { extraKnownMarketplaces, ...rest } = settings();
    write(cwd, SETTINGS_FILE, JSON.stringify(rest));
    dr = doctor({ cwd, toolkitVersion: '0.0.test', allowMissing: true });
    assert.equal(dr.ok, false, 'a key dropped from a present file is an edit, not a partial checkout');
    assert.deepEqual(dr.modified.sort(), OUT);

    fs.rmSync(path.join(cwd, SETTINGS_FILE));
    dr = doctor({ cwd, toolkitVersion: '0.0.test' });
    assert.deepEqual(dr.missing.sort(), OUT, 'an absent settings file reads as a partial checkout');

    render();
    assert.deepEqual(settings().enabledPlugins, { 'viewer@fixture': true });
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('migration: a pre-#594 lock\'s .claude/mods/ files are pruned and the entries written', () => {
    for (const [rel, content] of Object.entries(MOD_FILES)) write(cwd, path.join(legacyModDir('viewer'), rel), content);
    write(cwd, path.join(legacyModDir('viewer'), 'tsconfig.json'), '{}\n'); // engine-laid, unmanaged
    const files = Object.fromEntries(LEGACY_OUT.map((rel) => [rel, 'stale-hash']));
    write(cwd, '.waffle/waffle.lock.json', JSON.stringify({ toolkitVersion: '0.0.old', files }));

    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.removed.filter((r) => r.startsWith(legacyModDir('viewer'))).sort(), LEGACY_OUT);
    for (const rel of LEGACY_OUT) assert.equal(fs.existsSync(path.join(cwd, rel)), false, rel);
    assert.ok(!Object.keys(lock().files).some((rel) => rel.startsWith(path.join('.claude', 'mods'))), 'the lock forgets the files');
    assert.deepEqual(lock().settings, ENTRIES);
    assert.equal(fs.existsSync(path.join(cwd, legacyModDir('viewer'), 'hooks')), false, 'emptied dirs go too');
    assert.equal(fs.existsSync(path.join(cwd, legacyModDir('viewer'), 'tsconfig.json')), true, 'an unmanaged file survives');

    fs.rmSync(path.join(cwd, '.claude', 'mods'), { recursive: true });
    write(toolkitRoot, 'stacks/mb/stack.yaml', 'name: mb\ndescription: x.\nmods: [viewer]\noptIn: [mods/viewer]\n');
    write(cwd, '.waffle/waffle.lock.json', JSON.stringify({ toolkitVersion: '0.0.old', files }));
    assert.equal(render().ok, true);
    assert.deepEqual(lock().settings, ENTRIES, 'an opt-in mod poured under the old lock stays poured');
    noModsDir();
  });

  test('does not render without the claude target, and disabling claude after a render prunes it', () => {
    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex, agents-dir]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    assert.equal(fs.existsSync(path.join(cwd, SETTINGS_FILE)), false);
    assert.deepEqual(modPaths(), []);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude, codex]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    assert.deepEqual(modPaths(), OUT);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: [mb]']));
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual([...result.removed].sort(), OUT);
    assert.deepEqual(settings(), {});
    assert.deepEqual(modPaths(), []);
  });

  test('a mod the local overlay adds stays out of the committed lock (#317)', () => {
    write(toolkitRoot, 'stacks/mb/stack.yaml', 'name: mb\ndescription: x.\nmods: [viewer]\noptIn: [mods/viewer]\n');
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb]']));
    write(cwd, '.waffle/waffle.local.yaml', 'include: [mods/viewer]\n');
    assert.equal(render().ok, true);
    assert.equal(lock().settings, undefined, 'canonical lock: no overlay entries');
    assert.deepEqual(JSON.parse(read(cwd, '.waffle/waffle.local.lock.json')).settings, ENTRIES);
    assert.equal(settings().enabledPlugins['viewer@fixture'], true);
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);
  });

  test('a toolkit with no known GitHub repo cannot enable a mod', () => {
    fs.rmSync(path.join(toolkitRoot, 'package.json'));
    const result = render();
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /cannot enable mods\/viewer: no GitHub repository is known for the "fixture" marketplace/);
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

  test('eject mods/<name> removes its entries and the lock forgets them; uninstall removes the rest', () => {
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: mods\nstacks: [mb]\n');
    write(toolkitRoot, 'stacks/mb/stack.yaml', 'name: mb\ndescription: x.\nmods: [viewer, pane]\n');
    writeMod(toolkitRoot, 'mb', 'pane');
    write(toolkitRoot, `stacks/mb/mods/pane/${MOD_MANIFEST}`, '{"name": "pane"}\n');
    writeMarketplace(toolkitRoot, [{ name: 'viewer', source: './stacks/mb/mods/viewer' }, { name: 'pane', source: './stacks/mb/mods/pane' }]);
    write(cwd, SETTINGS_FILE, JSON.stringify({ env: { KEEP: '1' } }));
    assert.equal(render().ok, true);
    const PANE = pluginKey('pane@fixture');

    const { released } = eject({ cwd, item: 'mods/viewer' });
    assert.deepEqual(released, [PLUGIN]);
    assert.match(read(cwd, '.waffle/waffle.yaml'), /eject:\n\s+- mods\/viewer/);
    assert.deepEqual(modPaths(), [MARKET, PANE].sort());
    assert.deepEqual(settings().enabledPlugins, { 'pane@fixture': true });

    assert.equal(render().ok, true);
    assert.deepEqual(settings().enabledPlugins, { 'pane@fixture': true }, 'an ejected mod is not re-enabled');
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);

    assert.deepEqual(eject({ cwd, item: 'mods/pane' }).released, [MARKET, PANE].sort(), 'the last mod out takes the marketplace');
    assert.deepEqual(settings(), { env: { KEEP: '1' } });
    assert.equal(lock().settings, undefined);
    assert.equal(doctor({ cwd, toolkitVersion: '0.0.test' }).ok, true);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb]']));
    assert.equal(render().ok, true);
    const result = uninstall({ cwd, toolkitRoot, dryRun: false });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok([MARKET, PLUGIN, PANE].every((k) => result.removed.includes(k)), JSON.stringify(result.removed));
    assert.deepEqual(settings(), { env: { KEEP: '1' } }, 'uninstall leaves foreign keys');
  });

  test('two enabled stacks shipping the same mod name is a hard render error', () => {
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: mods\nstacks: [mb, mb2]\n');
    writeStack(toolkitRoot, 'mb2');
    write(cwd, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [mb, mb2]']));
    const result = render();
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /output conflict: mods\/viewer is shipped by both mb and mb2/.test(e)), JSON.stringify(result.errors));
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

  test('validate reds a mod whose plugin name is not its directory name', () => {
    write(toolkitRoot, `stacks/mb/mods/viewer/${MOD_MANIFEST}`, '{"name": "renamed"}\n');
    assert.ok(validateToolkit(toolkitRoot).some((p) => /mod viewer .*plugin\.json names it "renamed" — it must equal the directory name/.test(p)));
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
    noModsDir();
  });

  test('validateModPlugins runs `claude plugin validate` per mod source dir when the CLI is present', () => {
    const calls = [];
    const run = (cli, dir, timeoutMs) => {
      calls.push({ cli, dir, timeoutMs });
      return { ok: true, output: '✔ Validation passed' };
    };
    const locate = () => ({ path: '/stub/bin/claude', version: '2.1.292' });
    const result = validateModPlugins(toolkitRoot, { locate, run, timeoutMs: 1234 });
    assert.deepEqual(calls, [
      { cli: '/stub/bin/claude', dir: toolkitRoot, timeoutMs: 1234 },
      { cli: '/stub/bin/claude', dir: path.join(toolkitRoot, 'stacks/mb/mods/viewer'), timeoutMs: 1234 },
    ]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(formatModPluginChecks(result), [
      `ok: claude plugin validate ${MARKETPLACE_FILE} (claude 2.1.292)`,
      'ok: claude plugin validate mb/mods/viewer (claude 2.1.292)',
    ]);

    const failing = validateModPlugins(toolkitRoot, {
      locate,
      run: () => ({ ok: false, output: 'Validating plugin manifest\n  ✖ hooks/hooks.json: modules[0] ./missing.tsx not found\n' }),
    });
    assert.equal(failing.problems.length, 2);
    assert.match(failing.problems[0], /marketplace\.json fails `claude plugin validate`/);
    assert.match(failing.problems[1], /stack mb: mod viewer fails `claude plugin validate`:\n\s+Validating plugin manifest\n\s+✖ hooks\/hooks\.json/);
    assert.deepEqual(formatModPluginChecks(failing), [
      `FAIL: claude plugin validate ${MARKETPLACE_FILE} (claude 2.1.292)`,
      'FAIL: claude plugin validate mb/mods/viewer (claude 2.1.292)',
    ]);
  });

  // #593: the repo root is a plugin marketplace listing every mod at its source dir.
  test('validate keeps the marketplace in lockstep with the stack mods', () => {
    const check = () => validateMarketplace(toolkitRoot, loadToolkit(toolkitRoot));
    assert.deepEqual(check(), []);
    assert.equal(marketplacePluginId('viewer', 'fixture'), 'viewer@fixture');

    writeMarketplace(toolkitRoot, []);
    assert.ok(check().some((p) => /mod mb\/mods\/viewer is not listed \(add source "\.\/stacks\/mb\/mods\/viewer"\)/.test(p)));

    writeMarketplace(toolkitRoot, [{ name: 'viewer', source: './stacks/mb/mods/viewer' }, { name: 'ghost', source: './stacks/mb/mods/ghost' }]);
    assert.deepEqual(check(), [`${MARKETPLACE_FILE}: plugin "ghost" points at nonexistent ./stacks/mb/mods/ghost`]);

    writeMarketplace(toolkitRoot, [{ name: 'renamed', source: './stacks/mb/mods/viewer' }]);
    assert.match(check().join('\n'), /is named "renamed" but its .*plugin\.json says "viewer"/);

    writeMarketplace(toolkitRoot, [{ name: 'viewer', source: './stacks/mb/mods/viewer' }, { name: 'viewer', source: './stacks/mb' }]);
    const dup = check();
    assert.ok(dup.some((p) => /plugin name "viewer" is listed twice/.test(p)), JSON.stringify(dup));
    assert.ok(dup.some((p) => /\.\/stacks\/mb, which is not a declared stack mod/.test(p)), JSON.stringify(dup));

    write(toolkitRoot, MARKETPLACE_FILE, JSON.stringify({ name: 'other', plugins: [{ name: 'viewer', source: './stacks/mb/mods/viewer' }] }));
    assert.deepEqual(check(), [`${MARKETPLACE_FILE}: name "other" must equal toolkit.yaml name "fixture"`]);

    fs.rmSync(path.join(toolkitRoot, MARKETPLACE_FILE));
    assert.ok(validateToolkit(toolkitRoot).some((p) => /marketplace\.json is missing but the toolkit ships 1 mod/.test(p)));
    write(toolkitRoot, 'stacks/mb/stack.yaml', 'name: mb\ndescription: x.\n');
    assert.deepEqual(check(), [], 'no mods, no marketplace needed');
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

  test('setup says each mod is enabled through settings, with the CLI probe degrading to a note', () => {
    write(toolkitRoot, 'schema/SETUP.md', '# Setup\n');
    const guide = (locateClaude) => setupGuide(toolkitRoot, '0.0.test', cwd, { locateClaude });

    const current = guide(() => ({ path: '/stub/bin/claude', version: '2.1.292' }));
    assert.match(current, /## Mods \(Claude Code plugins\) — enabled through `\.claude\/settings\.json`/);
    assert.match(current, /`extraKnownMarketplaces\.fixture`/);
    assert.match(current, /### `mods\/viewer` \(mb\) → `enabledPlugins\["viewer@fixture"\]`/);
    assert.match(current, /`\/plugin install viewer@fixture`/);
    assert.match(current, /`claude` 2\.1\.292 is on PATH/);
    assert.doesNotMatch(current, /\.claude\/mods|--plugin-dir/);

    assert.match(guide(() => null), /`claude` is not on PATH here/);

    write(cwd, '.waffle/waffle.yaml', project(['targets: [codex]', 'stacks: [mb]']));
    assert.doesNotMatch(guide(() => null), /## Mods \(Claude Code plugins\)/, 'no claude target ⇒ no mod renders ⇒ no block');
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

  test('renders as wafflestack marketplace entries in a claude consumer and lands in its lock', () => {
    const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'project-waffle-view-'));
    try {
      write(consumer, '.waffle/waffle.yaml', project(['targets: [claude]', 'stacks: [wafflestack]']));
      const result = renderProject({ toolkitRoot: REPO_ROOT, cwd: consumer, toolkitVersion: '0.0.test' });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      const lock = JSON.parse(read(consumer, '.waffle/waffle.lock.json'));
      const id = marketplacePluginId('waffle-view', loadToolkit(REPO_ROOT).name);
      assert.equal(id, 'waffle-view@wafflestack');
      assert.equal(lock.settings[pluginKey(id)], true);
      assert.deepEqual(
        lock.settings[marketplaceKey('wafflestack')],
        { source: { source: 'github', repo: 'dustinkeeton/wafflestack', ref: 'v0.0.test' } },
        'the stack default pins waffle.toolkitRef to the rendering release',
      );
      assert.equal(JSON.parse(read(consumer, SETTINGS_FILE)).enabledPlugins[id], true);
      assert.equal(fs.existsSync(path.join(consumer, '.claude', 'mods')), false);
      assert.equal(doctor({ cwd: consumer, toolkitVersion: '0.0.test' }).ok, true);
    } finally {
      fs.rmSync(consumer, { recursive: true, force: true });
    }
  });
});
