// Upstream-pinned skills (#826): the `upstream:` schema, its loader + lint, registry provenance,
// and the copy-matches-pin gate, over a one-stack fixture toolkit.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadToolkit } from '../lib/toolkit.mjs';
import { validateToolkit, validateRegistry } from '../lib/validate.mjs';
import { renderProject } from '../lib/render.mjs';
import { normalizeUpstream, upstreamHash, UPSTREAM_HASH_RE } from '../lib/upstream.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const ECHO_DIR = 'stacks/vendor/skills/echo';

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const listFiles = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();

const defaultPin = () => ({ repo: 't3dotgg/tstack', path: 'skills/council', commit: COMMIT, license: 'MIT' });

const defaultEntries = () => [
  { name: 'scout', kind: 'agent', stack: 'vendor', path: 'stacks/vendor/agents/scout.md', status: 'stable' },
  { name: 'plain', kind: 'skill', stack: 'vendor', path: 'stacks/vendor/skills/plain', status: 'stable' },
  { name: 'echo', kind: 'skill', stack: 'vendor', path: ECHO_DIR, status: 'stable', upstream: defaultPin() },
];

/**
 * `vendor`: one agent, an unpinned `plain` skill and an upstream-pinned `echo` skill whose hash is
 * computed from its files before stack.yaml is written. `pinPatch` overrides upstream fields
 * (`hash: undefined` is computed); `upstreamRaw` replaces the whole value.
 */
function makeToolkit({ pinPatch = {}, upstreamRaw, entryExtra = {}, entries = defaultEntries(), license = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-upstream-'));
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: upstream fixture\nstacks: [vendor]\n');
  write(root, 'stacks/vendor/agents/scout.md', '---\nname: scout\ndescription: Scout agent.\n---\n\nScout body.\n');
  write(root, 'stacks/vendor/skills/plain/SKILL.md', '---\nname: plain\ndescription: Plain skill.\n---\n\nPlain body.\n');
  write(root, `${ECHO_DIR}/SKILL.md`, '---\nname: echo\ndescription: Echo skill.\n---\n\nEcho body, copied verbatim.\n');
  write(root, `${ECHO_DIR}/notes/extra.md`, 'Extra notes.\n');
  if (license) write(root, `${ECHO_DIR}/LICENSE`, 'MIT License\n\nCopyright (c) upstream\n');
  const hash = upstreamHash(path.join(root, ECHO_DIR), listFiles(path.join(root, ECHO_DIR)));
  const upstream = upstreamRaw !== undefined ? upstreamRaw : { ...defaultPin(), hash, ...pinPatch };
  const manifest = {
    name: 'vendor',
    description: 'Stack vendor.',
    agents: ['scout'],
    skills: ['plain', { name: 'echo', upstream, ...entryExtra }],
  };
  write(root, 'stacks/vendor/stack.yaml', YAML.stringify(manifest));
  if (entries !== null) write(root, 'stacks/registry.yaml', YAML.stringify({ waffles: entries }));
  return root;
}

const entriesWith = (name, patch) => defaultEntries().map((e) => (e.name === name ? { ...e, ...patch } : e));
const upstreamProblems = (root) =>
  validateToolkit(root).filter((p) => /upstream|LICENSE/.test(p) && !p.startsWith('stacks/registry.yaml'));

let roots = [];
const track = (root) => (roots.push(root), root);
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

describe('upstreamHash: the copy content hash (#826)', () => {
  const tmp = () => track(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-hash-')));

  test('pins the algorithm with a known vector', () => {
    const dir = tmp();
    write(dir, 'a.md', 'a\n');
    write(dir, 'sub/b.md', 'b\n');
    assert.equal(
      upstreamHash(dir, listFiles(dir)),
      'sha256:57a5e529f878b7b8012253c3fb3c9d979651faf7844ead6a97575c72254c792d',
    );
  });

  test('is independent of creation and listing order, and well-formed', () => {
    const a = tmp();
    write(a, 'sub/b.md', 'b\n');
    write(a, 'a.md', 'a\n');
    const h = upstreamHash(a, ['a.md', path.join('sub', 'b.md')]);
    assert.equal(h, upstreamHash(a, [path.join('sub', 'b.md'), 'a.md']));
    assert.match(h, UPSTREAM_HASH_RE);
  });

  test('changes on one byte, a rename, or an added file', () => {
    const dir = tmp();
    write(dir, 'a.md', 'a\n');
    const base = upstreamHash(dir, listFiles(dir));
    write(dir, 'a.md', 'a\n ');
    const edited = upstreamHash(dir, listFiles(dir));
    assert.notEqual(edited, base);
    write(dir, 'a.md', 'a\n');
    fs.renameSync(path.join(dir, 'a.md'), path.join(dir, 'z.md'));
    assert.notEqual(upstreamHash(dir, listFiles(dir)), base);
    fs.renameSync(path.join(dir, 'z.md'), path.join(dir, 'a.md'));
    assert.equal(upstreamHash(dir, listFiles(dir)), base);
    write(dir, 'c.md', '');
    assert.notEqual(upstreamHash(dir, listFiles(dir)), base);
  });
});

describe('loader: a skills entry may carry `upstream:` (#826)', () => {
  const skill = (root, name) => loadToolkit(root).stacks.get('vendor').skills.find((s) => s.name === name);

  test('a bare-string skill is unpinned; a mapping entry carries a normalized pin', () => {
    const root = track(makeToolkit({ pinPatch: { repo: '  t3dotgg/tstack  ' } }));
    assert.equal(skill(root, 'plain').upstream, null);
    const pin = skill(root, 'echo').upstream;
    assert.equal(pin.repo, 't3dotgg/tstack');
    assert.equal(pin.commit, COMMIT);
    assert.equal(pin.isMap, true);
    assert.deepEqual(pin.unknownKeys, []);
  });

  test('a mapping entry with no `upstream:` is unpinned', () => {
    const root = track(makeToolkit({ upstreamRaw: null }));
    assert.equal(skill(root, 'echo').upstream, null);
    assert.equal(normalizeUpstream(undefined), null);
  });

  test('throws on an unknown entry key, a missing name, or a path-shaped name', () => {
    const root = track(makeToolkit({ entryExtra: { upstrem: {} } }));
    assert.throws(() => loadToolkit(root), /skills entry has unknown key "upstrem" \(allowed: name, upstream\)/);
    write(root, 'stacks/vendor/stack.yaml', YAML.stringify({ name: 'vendor', description: 'd', skills: [{ upstream: {} }] }));
    assert.throws(() => loadToolkit(root), /mapping skills entry needs a `name:` string/);
    write(root, 'stacks/vendor/stack.yaml', YAML.stringify({ name: 'vendor', description: 'd', skills: [{ name: '../x' }] }));
    assert.throws(() => loadToolkit(root), /must be a bare name with no path separators/);
  });
});

describe('lint: the `upstream:` shape and the upstream LICENSE (#826)', () => {
  test('a valid pinned fixture validates clean', () => {
    assert.deepEqual(validateToolkit(track(makeToolkit())), []);
  });

  const cases = [
    ['not a mapping', { upstreamRaw: 't3dotgg/tstack' }, /upstream: must be a mapping/],
    ['an unknown key', { pinPatch: { ref: 'main' } }, /upstream: has unknown key "ref"/],
    ['a repo with no owner', { pinPatch: { repo: 'tstack' } }, /upstream\.repo must be owner\/name/],
    ['a short commit', { pinPatch: { commit: 'abc123' } }, /upstream\.commit must be a full 40-char/],
    ['an uppercase commit', { pinPatch: { commit: COMMIT.toUpperCase() } }, /upstream\.commit must be a full 40-char/],
    ['a `..` path', { pinPatch: { path: 'skills/../council' } }, /upstream\.path must be a repo-relative POSIX dir/],
    ['an absolute path', { pinPatch: { path: '/skills/council' } }, /upstream\.path must be a repo-relative POSIX dir/],
    ['a missing license', { pinPatch: { license: undefined } }, /upstream\.license is required/],
    ['a malformed hash', { pinPatch: { hash: 'md5:abc' } }, /upstream\.hash must be sha256:/],
    ['no LICENSE file', { license: false }, /ships no LICENSE file in its directory/],
  ];
  for (const [label, opts, re] of cases) {
    test(`reports ${label}, naming the skill`, () => {
      const root = track(makeToolkit(opts));
      const problems = upstreamProblems(root);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0], re);
      assert.match(problems[0], /skill echo/);
    });
  }
});

describe('gate: a pinned copy must still hash to its recorded `hash` (#826)', () => {
  const gate = (root) => validateToolkit(root).filter((p) => /no longer matches its upstream pin/.test(p));

  test('one appended byte fails validate, naming the item and both remedies', () => {
    const root = track(makeToolkit());
    fs.appendFileSync(path.join(root, ECHO_DIR, 'SKILL.md'), 'x');
    const problems = gate(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /skill echo no longer matches its upstream pin t3dotgg\/tstack@0123456789ab/);
    assert.match(problems[0], /project extension \(\.waffle\/extensions\/skills\/echo\.md\)/);
    assert.match(problems[0], /bump the pin/);
    const actual = upstreamHash(path.join(root, ECHO_DIR), listFiles(path.join(root, ECHO_DIR)));
    assert.ok(problems[0].includes(`hash to ${actual}`));
  });

  test('an edited LICENSE or a stray .DS_Store fails it too', () => {
    const root = track(makeToolkit());
    fs.appendFileSync(path.join(root, ECHO_DIR, 'LICENSE'), '\n');
    assert.equal(gate(root).length, 1);
    const root2 = track(makeToolkit());
    write(root2, `${ECHO_DIR}/.DS_Store`, '\0');
    assert.equal(gate(root2).length, 1);
  });

  test('an unpinned skill is never hash-checked', () => {
    const root = track(makeToolkit());
    fs.appendFileSync(path.join(root, 'stacks/vendor/skills/plain/SKILL.md'), 'edited');
    assert.deepEqual(validateToolkit(root), []);
  });
});

describe('registry: upstream provenance reconciles with stack.yaml (#826)', () => {
  const regProblems = (root) => validateRegistry(root, loadToolkit(root));

  test('a matching registry `upstream` is clean and not an unknown key', () => {
    assert.deepEqual(regProblems(track(makeToolkit())), []);
  });

  test('a pin missing from the registry is a problem', () => {
    const root = track(makeToolkit({ entries: entriesWith('echo', { upstream: undefined }) }));
    assert.deepEqual(
      regProblems(root).filter((p) => /registry entry has no `upstream`/.test(p)).length,
      1,
    );
  });

  test('a registry `upstream` on an unpinned skill is a problem', () => {
    const root = track(makeToolkit({ entries: entriesWith('plain', { upstream: defaultPin() }) }));
    assert.match(regProblems(root).join('\n'), /skill "plain" records `upstream` in the registry, but its stacks\/vendor\/stack\.yaml entry declares no/);
  });

  test('a differing field names the field and both values', () => {
    const other = 'f'.repeat(40);
    const root = track(makeToolkit({ entries: entriesWith('echo', { upstream: { ...defaultPin(), commit: other } }) }));
    const problems = regProblems(root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], new RegExp(`upstream\\.commit is "${other}" in the registry but "${COMMIT}" in stacks/vendor/stack\\.yaml`));
  });

  test('a `hash` in the registry `upstream` is an unknown key', () => {
    const root = track(makeToolkit({ entries: entriesWith('echo', { upstream: { ...defaultPin(), hash: 'sha256:x' } }) }));
    assert.match(regProblems(root).join('\n'), /skill "echo" upstream: has unknown key "hash" \(allowed: repo, path, commit, license\)/);
  });

  test('`upstream` on an agent or a tombstone is a problem', () => {
    const agent = track(makeToolkit({ entries: entriesWith('scout', { upstream: defaultPin() }) }));
    assert.match(regProblems(agent).join('\n'), /agent "scout" declares `upstream`, but only skills can be upstream-pinned/);
    const tomb = { name: 'gone', kind: 'skill', status: 'replaced', replacedBy: 'plain', upstream: defaultPin() };
    const root = track(makeToolkit({ entries: [...defaultEntries(), tomb] }));
    assert.match(regProblems(root).join('\n'), /skill "gone" is `replaced`, so it must not declare `upstream`/);
  });
});

describe('render: an external stack with a stale pin fails closed (#826)', () => {
  // Built-in `core` plus a local-path external `acme` whose pinned `echo` skill hashes clean.
  function setup() {
    const builtin = track(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-builtin-')));
    const ext = track(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-ext-')));
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-project-')));
    const cache = track(fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-cache-')));
    write(builtin, 'toolkit.yaml', 'name: builtin\ndescription: built-in fixture\nstacks: [core]\n');
    write(builtin, 'stacks/core/stack.yaml', 'name: core\ndescription: Core stack.\nskills: [alpha]\n');
    write(builtin, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha skill.\n---\n\nAlpha.\n');
    const echo = path.join(ext, 'stacks/acme/skills/echo');
    write(ext, 'stacks/acme/skills/echo/SKILL.md', '---\nname: echo\ndescription: Echo skill.\n---\n\nEcho body.\n');
    write(ext, 'stacks/acme/skills/echo/LICENSE', 'MIT License\n');
    const upstream = { ...defaultPin(), hash: upstreamHash(echo, listFiles(echo)) };
    const manifest = { name: 'acme', description: 'Acme.', skills: [{ name: 'echo', upstream }] };
    write(ext, 'stacks/acme/stack.yaml', YAML.stringify(manifest));
    write(cwd, '.waffle/waffle.yaml', `targets: [claude]\nstacks:\n  - core\n  - name: acme\n    source: ${ext}\nconfig: {}\n`);
    const render = () => renderProject({ toolkitRoot: builtin, cwd, toolkitVersion: '0.0.test', sourceCacheDir: cache });
    return { echo, cwd, render };
  }

  test('a clean pin renders; one appended byte refuses the render, naming the skill', () => {
    const clean = setup();
    assert.equal(clean.render().ok, true);

    const stale = setup();
    fs.appendFileSync(path.join(stale.echo, 'SKILL.md'), 'x');
    const result = stale.render();
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => /external stack "acme"/.test(e) && /skill echo no longer matches its upstream pin/.test(e)),
      JSON.stringify(result.errors),
    );
    assert.equal(fs.existsSync(path.join(stale.cwd, '.waffle/waffle.lock.json')), false, 'no lock written');
  });
});
