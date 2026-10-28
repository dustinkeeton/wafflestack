// Stale installed mods (#730): doctor names the `claude plugin update` that moves an old install forward.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPluginsDir, readInstalledPlugins, staleMods, formatStaleMod } from '../lib/installed-mods.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { upgrade } from '../lib/upgrade.mjs';
import { MARKETPLACE_FILE } from '../lib/marketplace.mjs';
import { MOD_MANIFEST } from '../lib/toolkit.mjs';
import { pluginKey, marketplaceKey } from '../lib/settings.mjs';

const ID = 'viewer@fixture';
const SETTINGS = { [marketplaceKey('fixture')]: { source: { source: 'github', repo: 'acme/fixture' }, autoUpdate: true }, [pluginKey(ID)]: true };

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('stale installed mods (#730)', () => {
  let toolkitRoot;
  let cwd;
  let pluginsDir;
  const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

  beforeEach(() => {
    toolkitRoot = tmp('toolkit-mods-');
    cwd = tmp('project-mods-');
    pluginsDir = tmp('plugins-');
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\nstacks: [mb]\n');
    write(toolkitRoot, 'package.json', '{"repository": "github:acme/fixture"}\n');
    write(toolkitRoot, 'stacks/mb/stack.yaml', 'name: mb\ndescription: Mod fixture.\nmods: [viewer]\n');
    write(toolkitRoot, `stacks/mb/mods/viewer/${MOD_MANIFEST}`, '{"name": "viewer", "version": "0.8.1"}\n');
    write(toolkitRoot, MARKETPLACE_FILE, JSON.stringify({ name: 'fixture', owner: { name: 'x' }, plugins: [{ name: 'viewer', source: './stacks/mb/mods/viewer' }] }));
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd, pluginsDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const installed = (records) => write(pluginsDir, 'installed_plugins.json', JSON.stringify({ version: 2, plugins: { [ID]: records } }));
  const stale = (over = {}) => staleMods({ cwd, settings: SETTINGS, toolkitRoot, pluginsDir, ...over });

  test('a user-scope install older than the shipped version yields one update command', () => {
    installed([{ scope: 'user', version: '0.2.1' }]);
    const found = stale();
    assert.deepEqual(found, [{ id: ID, scope: 'user', installed: '0.2.1', source: '0.8.1', command: `claude plugin update ${ID} --scope user` }]);
    assert.match(formatStaleMod(found[0]), /installed at 0\.2\.1 \(user scope\) but this toolkit ships 0\.8\.1 — run: claude plugin update viewer@fixture --scope user/);
  });

  test('project/local records count only for this repo, matched through realpath', () => {
    const other = tmp('elsewhere-');
    try {
      installed([
        { scope: 'project', projectPath: path.join(cwd, '.', ''), version: '0.2.1' },
        { scope: 'local', projectPath: other, version: '0.2.1' },
      ]);
      const found = stale();
      assert.deepEqual(found.map((m) => m.command), [`claude plugin update ${ID} --scope project`]);
      assert.match(formatStaleMod(found[0]), /run \(from this repo\):/);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('equal, newer, and unparseable (SHA) versions are not stale', () => {
    installed([{ scope: 'user', version: '0.8.1' }, { scope: 'user', version: '0.9.0' }, { scope: 'user', version: 'a1b2c3d4e5f6' }]);
    assert.deepEqual(stale(), []);
  });

  test('missing, corrupt, or misshapen install records are silence, never a throw', () => {
    assert.deepEqual(stale(), [], 'no installed_plugins.json');
    write(pluginsDir, 'installed_plugins.json', '{not json');
    assert.equal(readInstalledPlugins(pluginsDir), null);
    assert.deepEqual(stale(), []);
    write(pluginsDir, 'installed_plugins.json', '{"plugins": []}');
    assert.deepEqual(stale(), []);
    assert.deepEqual(stale({ pluginsDir: null }), []);
    assert.deepEqual(stale({ settings: {} }), [], 'a lock with no mods');
  });

  test('defaultPluginsDir honors the cache-dir and config-dir overrides', () => {
    assert.equal(defaultPluginsDir({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/x/cache' }), path.resolve('/x/cache'));
    assert.equal(defaultPluginsDir({ CLAUDE_CONFIG_DIR: '/x/conf' }), path.join(path.resolve('/x/conf'), 'plugins'));
    assert.equal(defaultPluginsDir({}), path.join(os.homedir(), '.claude', 'plugins'));
  });

  test('doctor and upgrade report the stale mod as a note without flipping ok', () => {
    write(cwd, '.waffle/waffle.yaml', 'config: {}\ntargets: [claude]\nstacks: [mb]\n');
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' }).ok, true);
    installed([{ scope: 'user', version: '0.2.1' }]);

    const plain = doctor({ cwd, toolkitVersion: '0.0.test', toolkitRoot });
    assert.deepEqual(plain.staleMods, [], 'no pluginsDir, no lookup');
    const dr = doctor({ cwd, toolkitVersion: '0.0.test', toolkitRoot, pluginsDir });
    assert.equal(dr.ok, true);
    assert.equal(dr.staleMods.length, 1);
    assert.ok(dr.notes.some((n) => n.includes(`claude plugin update ${ID} --scope user`)));

    const up = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.0.test', pluginsDir });
    assert.equal(up.doctor.staleMods.length, 1);
  });
});
