// `upstream:check` / `upstream:bump` (#828, part of #825) over a fixture toolkit and an in-memory
// fake of the `gh api` endpoints. No test reaches the network: the fake rejects any other endpoint.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { checkUpstream, bumpUpstream, addChangelogLine, pinnedSkills } from '../lib/upstream-sync.mjs';
import { upstreamHash } from '../lib/upstream.mjs';
import { validateToolkit } from '../lib/validate.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const sha = (n) => String(n).repeat(40).slice(0, 40);
const [C1, C2, C3] = [sha('a'), sha('b'), sha('c')];
const MIT = 'MIT License\n\nCopyright (c) upstream\n';
const SKILL_V1 = '---\nname: echo\ndescription: Echo skill.\n---\n\nEcho v1.\n';
const SKILL_V2 = '---\nname: echo\ndescription: Echo skill.\n---\n\nEcho v2 {{literal}}.\n';
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **Something.**\n\n### Changed\n\n- **Older change.**\n\n## [0.1.0]\n\n- old\n';

let roots = [];
const tmp = (prefix) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

/** Every file under `root`, rel → bytes, for "nothing was written" assertions. */
function snapshot(root) {
  const out = {};
  for (const e of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[path.relative(root, path.join(e.parentPath ?? e.path, e.name))] = fs.readFileSync(path.join(e.parentPath ?? e.path, e.name)).toString('base64');
  }
  return out;
}

/**
 * A fake upstream: `commits` in branch order, each a full `{ path: content }` tree (plus optional raw
 * `entries`); `diverged` shas compare as diverged. Records every call; any other endpoint throws.
 */
function fakeGh({ repo = 'acme/tools', commits, license = 'MIT', diverged = [], fail = [] }) {
  const calls = [];
  const blobs = new Map();
  const blobSha = (content) => {
    const id = crypto.createHash('sha1').update(content).digest('hex');
    blobs.set(id, content);
    return id;
  };
  const idx = (s) => commits.findIndex((c) => c.sha === s);
  const touches = (c, p) => {
    const prev = commits[idx(c.sha) - 1];
    const pick = (t) => JSON.stringify(Object.entries(t?.files ?? {}).filter(([k]) => k === p || k.startsWith(`${p}/`)).sort());
    return !prev || pick(c) !== pick(prev);
  };
  const gh = (args) => {
    calls.push(args.join(' '));
    assert.equal(args.length, 1, `unexpected gh args: ${args.join(' ')}`);
    const url = new URL(args[0], 'https://api.invalid/');
    const p = url.pathname.slice(1);
    const r = fail.find((f) => p.startsWith(`repos/${f}`));
    if (r) throw new Error(`gh api ${p}: HTTP 404: Not Found`);
    if (p === `repos/${repo}`) return { default_branch: 'main', license: { spdx_id: license } };
    if (p === `repos/${repo}/commits`) {
      assert.equal(url.searchParams.get('sha'), 'main');
      const hit = [...commits].reverse().find((c) => touches(c, url.searchParams.get('path')));
      return hit ? [{ sha: hit.sha }] : [];
    }
    let m = p.match(new RegExp(`^repos/${repo}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`));
    if (m) {
      if (diverged.includes(m[1]) || diverged.includes(m[2])) return { status: 'diverged' };
      const d = idx(m[2]) - idx(m[1]);
      return { status: d > 0 ? 'ahead' : d < 0 ? 'behind' : 'identical' };
    }
    m = p.match(new RegExp(`^repos/${repo}/git/trees/([0-9a-f]{40})$`));
    if (m) {
      const c = commits[idx(m[1])];
      assert.ok(c, `unknown commit ${m[1]}`);
      const tree = Object.entries(c.files).map(([fp, content]) => ({ path: fp, mode: '100644', type: 'blob', sha: blobSha(content) }));
      return { truncated: false, tree: [...tree, ...(c.entries ?? [])] };
    }
    m = p.match(new RegExp(`^repos/${repo}/git/blobs/([0-9a-f]{40})$`));
    if (m && blobs.has(m[1])) return { encoding: 'base64', content: Buffer.from(blobs.get(m[1])).toString('base64') };
    throw new Error(`fake gh: unrecognized endpoint ${args[0]}`);
  };
  gh.calls = calls;
  return gh;
}

const V1 = { 'LICENSE': MIT, 'skills/echo/SKILL.md': SKILL_V1, 'skills/echo/old.md': 'old\n', 'README.md': 'r1\n' };

/** A fixture toolkit with `echo` (repo acme/tools) pinned at `commit`, copied from `files`. */
function makeToolkit({ commit = C1, files = V1, extra = [], changelog = CHANGELOG } = {}) {
  const root = tmp('upstream-sync-');
  const skills = [{ name: 'echo', repo: 'acme/tools', commit, files }, ...extra];
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: upstream sync fixture\nstacks: [up]\n');
  const waffles = [];
  const entries = [];
  for (const s of skills) {
    const dir = `stacks/up/skills/${s.name}`;
    for (const [fp, content] of Object.entries(s.files)) {
      if (fp === 'LICENSE') write(root, `${dir}/LICENSE`, content);
      else if (fp.startsWith(`skills/${s.name}/`)) write(root, `${dir}/${fp.slice(`skills/${s.name}/`.length)}`, content);
    }
    const listed = fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(path.join(root, dir), path.join(e.parentPath ?? e.path, e.name)));
    const pin = { repo: s.repo, path: `skills/${s.name}`, commit: s.commit, license: 'MIT' };
    entries.push({ name: s.name, upstream: { ...pin, hash: upstreamHash(path.join(root, dir), listed) } });
    waffles.push({ name: s.name, kind: 'skill', stack: 'up', path: dir, status: 'stable', upstream: pin });
  }
  write(root, 'stacks/up/stack.yaml', `# a comment that must survive\nname: up\ndescription: Stack up.\n${YAML.stringify({ skills: entries })}`);
  write(root, 'stacks/registry.yaml', `# registry comment\n${YAML.stringify({ waffles })}`);
  write(root, 'CHANGELOG.md', changelog);
  return root;
}

const status = (root, gh) => checkUpstream({ toolkitRoot: root, gh }).items.map((i) => [i.ref, i.status, i.latest, i.licenseChanged]);

describe('upstream:check (#828)', () => {
  test('current when upstream has nothing newer for the path or the LICENSE', () => {
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }] });
    assert.deepEqual(status(makeToolkit(), gh), [['up/skills/echo', 'current', C1, false]]);
  });

  test('behind when a later commit touches the path; latest names it', () => {
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: { ...V1, 'skills/echo/SKILL.md': SKILL_V2 } }] });
    assert.deepEqual(status(makeToolkit(), gh), [['up/skills/echo', 'behind', C2, false]]);
  });

  test('a LICENSE-only change is behind with licenseChanged', () => {
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: { ...V1, LICENSE: `${MIT}more\n` } }] });
    assert.deepEqual(status(makeToolkit(), gh), [['up/skills/echo', 'behind', C2, true]]);
  });

  test('a pin taken at a later unrelated commit is current, not behind', () => {
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: { ...V1, 'README.md': 'r2\n' } }] });
    assert.deepEqual(status(makeToolkit({ commit: C2 }), gh), [['up/skills/echo', 'current', C2, false]]);
  });

  test('both path and LICENSE moved: latest is the newer of the two', () => {
    const v2 = { ...V1, 'skills/echo/SKILL.md': SKILL_V2 };
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: v2 }, { sha: C3, files: { ...v2, LICENSE: `${MIT}x\n` } }] });
    assert.deepEqual(status(makeToolkit(), gh), [['up/skills/echo', 'behind', C3, true]]);
  });

  test('a pin off the default branch is diverged', () => {
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: { ...V1, 'skills/echo/SKILL.md': SKILL_V2 } }], diverged: [C1] });
    assert.equal(status(makeToolkit(), gh)[0][1], 'diverged');
  });

  test('a gh error on one item is reported as error; the other items are still checked', () => {
    const other = { name: 'gone', repo: 'acme/gone', commit: C1, files: { LICENSE: MIT, 'skills/gone/SKILL.md': '---\nname: gone\ndescription: G.\n---\n' } };
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }], fail: ['acme/gone'] });
    const items = checkUpstream({ toolkitRoot: makeToolkit({ extra: [other] }), gh }).items;
    assert.deepEqual(items.map((i) => [i.ref, i.status]), [['up/skills/echo', 'current'], ['up/skills/gone', 'error']]);
    assert.match(items[1].error, /HTTP 404/);
  });

  test('pinnedSkills lists only pinned skills with their stack.yaml index', () => {
    assert.deepEqual(pinnedSkills(makeToolkit()).map((p) => [p.ref, p.index, p.pin.commit]), [['up/skills/echo', 0, C1]]);
  });
});

const V2 = { LICENSE: MIT, 'skills/echo/SKILL.md': SKILL_V2, 'skills/echo/notes/new.md': 'new\n', 'README.md': 'r1\n' };

describe('upstream:bump (#828)', () => {
  test('rewrites the copy, the pin + hash, the registry commit and a CHANGELOG line; validate is green', () => {
    const root = makeToolkit();
    const stackBefore = fs.readFileSync(path.join(root, 'stacks/up/stack.yaml'), 'utf8');
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }] });
    const { items } = bumpUpstream({ toolkitRoot: root, gh });
    assert.deepEqual(items.map((i) => [i.status, i.from, i.to, i.error]), [['bumped', C1, C2, null]]);
    const dir = path.join(root, 'stacks/up/skills/echo');
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), ['LICENSE', 'SKILL.md', 'notes', path.join('notes', 'new.md')]);
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), SKILL_V2);
    const hash = upstreamHash(dir, ['LICENSE', 'SKILL.md', 'notes/new.md']);
    const stackAfter = fs.readFileSync(path.join(root, 'stacks/up/stack.yaml'), 'utf8');
    const oldHash = YAML.parse(stackBefore).skills[0].upstream.hash;
    assert.equal(stackAfter, stackBefore.replace(C1, C2).replace(oldHash, hash));
    assert.match(fs.readFileSync(path.join(root, 'stacks/registry.yaml'), 'utf8'), new RegExp(`^# registry comment\\n[\\s\\S]*commit: ${C2}`));
    const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(log.includes(`### Changed\n\n- **Bump upstream-pinned \`echo\` to acme/tools@bbbbbbbbbbbb (from aaaaaaaaaaaa).**\n\n  **Consumer impact:**`));
    assert.ok(log.indexOf('Bump upstream-pinned') < log.indexOf('Older change'));
    assert.deepEqual(validateToolkit(root), []);
  });

  test('a second bump is a no-op: nothing written, no CHANGELOG bullet', () => {
    const root = makeToolkit();
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }] });
    bumpUpstream({ toolkitRoot: root, gh });
    const before = snapshot(root);
    const { items } = bumpUpstream({ toolkitRoot: root, gh });
    assert.equal(items[0].status, 'unchanged');
    assert.deepEqual(snapshot(root), before);
  });

  test('--commit with a ref bumps to that exact commit', () => {
    const root = makeToolkit();
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }, { sha: C3, files: { ...V2, 'skills/echo/SKILL.md': SKILL_V1 } }] });
    const { items } = bumpUpstream({ toolkitRoot: root, gh, ref: 'skills/echo', commit: C2 });
    assert.equal(items[0].to, C2);
    assert.equal(YAML.parse(fs.readFileSync(path.join(root, 'stacks/up/stack.yaml'), 'utf8')).skills[0].upstream.commit, C2);
  });

  test('creates `### Changed` after `### Added` when absent', () => {
    const root = makeToolkit({ changelog: '# C\n\n## [Unreleased]\n\n### Added\n\n- **A.**\n\n## [0.1.0]\n' });
    bumpUpstream({ toolkitRoot: root, gh: fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }] }) });
    assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /^# C\n\n## \[Unreleased\]\n\n### Added\n\n- \*\*A\.\*\*\n\n### Changed\n\n- \*\*Bump upstream-pinned `echo`[^\n]*\n\n {2}\*\*Consumer impact:\*\*[^\n]*\n[^\n]*\n\n## \[0\.1\.0\]\n$/);
  });

  const refusals = [
    ['a symlink', { ...V2 }, [{ path: 'skills/echo/link', mode: '120000', type: 'blob', sha: sha('d') }], /symlink/],
    ['a submodule', { ...V2 }, [{ path: 'skills/echo/sub', mode: '160000', type: 'commit', sha: sha('e') }], /submodule/],
    ['no root LICENSE', Object.fromEntries(Object.entries(V2).filter(([k]) => k !== 'LICENSE')), [], /no root LICENSE/],
    ['a LICENSE inside the path', { ...V2, 'skills/echo/LICENSE': 'x\n' }, [], /collides/],
  ];
  for (const [what, files, entries, re] of refusals) {
    test(`refuses ${what} and writes nothing`, () => {
      const root = makeToolkit();
      const before = snapshot(root);
      const { items } = bumpUpstream({ toolkitRoot: root, gh: fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files, entries }] }) });
      assert.equal(items[0].status, 'error');
      assert.match(items[0].error, re);
      assert.deepEqual(snapshot(root), before);
    });
  }

  test('refuses an upstream relicense and writes nothing', () => {
    const root = makeToolkit();
    const before = snapshot(root);
    const { items } = bumpUpstream({ toolkitRoot: root, gh: fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }], license: 'GPL-3.0' }) });
    assert.match(items[0].error, /licensed GPL-3\.0.*human decision/);
    assert.deepEqual(snapshot(root), before);
  });

  test('refuses a copy that no longer matches its pin (a stray file) and writes nothing', () => {
    const root = makeToolkit();
    write(root, 'stacks/up/skills/echo/.DS_Store', 'junk');
    const before = snapshot(root);
    const { items } = bumpUpstream({ toolkitRoot: root, gh: fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }] }) });
    assert.match(items[0].error, /no longer matches its pin/);
    assert.deepEqual(snapshot(root), before);
  });

  test('a diverged pin is not bumped without --commit', () => {
    const root = makeToolkit();
    const before = snapshot(root);
    const { items } = bumpUpstream({ toolkitRoot: root, gh: fakeGh({ commits: [{ sha: C1, files: V1 }, { sha: C2, files: V2 }], diverged: [C1] }) });
    assert.match(items[0].error, /diverged/);
    assert.deepEqual(snapshot(root), before);
  });

  test('an unknown ref throws before any gh call', () => {
    const gh = fakeGh({ commits: [] });
    assert.throws(() => bumpUpstream({ toolkitRoot: makeToolkit(), gh, ref: 'skills/nope' }), /no upstream-pinned skill skills\/nope/);
    assert.deepEqual(gh.calls, []);
  });

  test('the fake records every call and rejects any endpoint it does not serve', () => {
    const gh = fakeGh({ commits: [{ sha: C1, files: V1 }] });
    checkUpstream({ toolkitRoot: makeToolkit(), gh });
    assert.ok(gh.calls.length > 0 && gh.calls.every((c) => c.startsWith('repos/acme/tools')));
    assert.throws(() => gh(['user']), /unrecognized endpoint/);
  });
});

describe('addChangelogLine (#828)', () => {
  test('prepends under an existing `### Changed`', () => {
    assert.equal(addChangelogLine(CHANGELOG, '- **New.**'), CHANGELOG.replace('### Changed\n\n', '### Changed\n\n- **New.**\n\n'));
  });

  test('creates `### Changed` directly under `## [Unreleased]` when it has no subsections', () => {
    assert.equal(addChangelogLine('## [Unreleased]\n\n## [0.1.0]\n', '- **New.**'), '## [Unreleased]\n\n### Changed\n\n- **New.**\n\n## [0.1.0]\n');
  });

  test('throws without `## [Unreleased]`', () => {
    assert.throws(() => addChangelogLine('# C\n', '- x'), /no `## \[Unreleased\]`/);
  });
});

describe('installer/upstream.mjs runner (#828)', () => {
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(ROOT, 'installer/upstream.mjs'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: tmp('no-gh-') },
    });

  for (const args of [[], ['frobnicate'], ['check', 'extra'], ['bump', '--commit', 'nope'], ['bump', 'a', 'b']]) {
    test(`\`${args.join(' ') || '(no args)'}\` exits 2 with usage before reaching gh`, () => {
      const res = run(...args);
      assert.equal(res.status, 2, res.stderr);
      assert.match(res.stderr, /usage: node installer\/upstream\.mjs check/);
      assert.doesNotMatch(res.stderr, /gh api repos/);
    });
  }

  test('--help prints usage and exits 0', () => {
    const res = run('--help');
    assert.equal(res.status, 0);
    assert.match(res.stdout, /upstream\.mjs bump \[<ref>\] \[--commit <sha>\]/);
  });
});
