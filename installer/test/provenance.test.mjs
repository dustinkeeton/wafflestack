import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveToolkitIdentity,
  commitFromNpmLockfile,
  shaFromResolved,
  parseLsRemoteTags,
  latestReleaseTag,
  toolkitRef,
  repoSlug,
  parseRepoSlug,
  httpsUrl,
  changelogHasUnreleasedEntries,
  changelogLatestRelease,
  formatUnreleasedRefusal,
  formatProvenanceWarning,
} from '../lib/toolkit-ref.mjs';
import { renderProject } from '../lib/render.mjs';
import { upgrade } from '../lib/upgrade.mjs';
import { doctor } from '../lib/doctor.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// #373 — toolkit provenance: what am I, and what ref reproduces me?
//
// The bug: `npx github:dustinkeeton/wafflestack <cmd>` with no `#ref` resolves the DEFAULT BRANCH.
// It renders unreleased content while stamping the last released version number into the
// consumer's lock, so `doctor --verify-render` (which renders through a PINNED ref) goes red on a
// lock that is, from the consumer's side, perfectly correct. The fix: the CLI works out whether
// the code it is running is a RELEASED commit, and the write path refuses when it provably is not.
//
// This file owns that contract end to end — identity resolution (both origins), the ls-remote
// parse, the offline CHANGELOG corroborator, the `ref` STRING FORMAT (#372 writes it into
// waffle.yaml; #374 writes it into the lock — both are pinned here), and the per-command gate
// matrix, driven by spawning the real CLI. #374 and #372 extend this file rather than growing
// installer.test.mjs, which is already ~12k lines.
//
// NOTHING here touches the network. Every test either injects `lsRemote`/`runGit`, or drives an
// origin that resolves offline by construction (a checkout: `git describe` answers it).
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const gitOk = spawnSync('git', ['--version']).status === 0;

/** An `lsRemote` that fails the test if it is ever called. The offline property, made assertable. */
const forbidNetwork = () => {
  throw new Error('lsRemote was called — this path must resolve OFFLINE');
};

/** An `lsRemote` that records its calls and answers from a fixture tag map. */
function fakeLsRemote(lines) {
  /** @type {string[]} */
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    return lines.join('\n');
  };
  return Object.assign(fn, { calls });
}

const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TAG_OBJECT_SHA = 'c'.repeat(40); // the tag OBJECT of an annotated tag — never a commit

// ─────────────────────────────────────────────────────────────────────────────
// ls-remote parsing — lightweight vs annotated tags, and the non-semver filter
// ─────────────────────────────────────────────────────────────────────────────

describe('parseLsRemoteTags (#373)', () => {
  test('a lightweight tag maps its single line straight to the commit', () => {
    const { byCommit, tags, latest } = parseLsRemoteTags([`${SHA_A}\trefs/tags/v0.12.0`].join('\n'));
    assert.equal(byCommit.get(SHA_A), 'v0.12.0');
    assert.deepEqual(tags, ['v0.12.0']);
    assert.equal(latest, 'v0.12.0');
  });

  test('an annotated tag indexes the PEELED commit, not the tag object', () => {
    // git emits both lines for an annotated tag. The unpeeled one points at the tag OBJECT, which
    // is not any commit a fetch ever lands on — indexing it would make a genuine release look
    // unreleased. The `^{}` line is the commit, and it must win in EITHER arrival order.
    const peeledLast = parseLsRemoteTags(
      [`${TAG_OBJECT_SHA}\trefs/tags/v1.0.0`, `${SHA_A}\trefs/tags/v1.0.0^{}`].join('\n'),
    );
    assert.equal(peeledLast.byCommit.get(SHA_A), 'v1.0.0');
    assert.equal(peeledLast.byCommit.has(TAG_OBJECT_SHA), false);

    const peeledFirst = parseLsRemoteTags(
      [`${SHA_A}\trefs/tags/v1.0.0^{}`, `${TAG_OBJECT_SHA}\trefs/tags/v1.0.0`].join('\n'),
    );
    assert.equal(peeledFirst.byCommit.get(SHA_A), 'v1.0.0');
    assert.equal(peeledFirst.byCommit.has(TAG_OBJECT_SHA), false);
  });

  test('non-release tag names are filtered out — they are not something a consumer can pin', () => {
    const { byCommit, tags } = parseLsRemoteTags(
      [
        `${SHA_A}\trefs/tags/nightly`,
        `${SHA_B}\trefs/tags/v1.2`, // two-part: not a release tag
        `${'d'.repeat(40)}\trefs/tags/v1.2.3-rc.1`, // pre-release: not a release tag
        `${'e'.repeat(40)}\trefs/tags/v0.1.0`,
      ].join('\n'),
    );
    assert.deepEqual(tags, ['v0.1.0']);
    assert.equal(byCommit.size, 1);
    assert.equal(byCommit.get('e'.repeat(40)), 'v0.1.0');
  });

  test('`latest` is semver-ordered, not string-ordered (v0.9.0 must not outrank v0.10.0)', () => {
    const { latest } = parseLsRemoteTags(
      [`${SHA_A}\trefs/tags/v0.9.0`, `${SHA_B}\trefs/tags/v0.10.0`].join('\n'),
    );
    assert.equal(latest, 'v0.10.0');
    assert.equal(latestReleaseTag(['v0.9.0', 'v0.10.0', 'nightly']), 'v0.10.0');
    assert.equal(latestReleaseTag(['nightly', 'main']), null);
  });

  test('garbage lines are skipped, never thrown on', () => {
    const { tags } = parseLsRemoteTags(`not a ref line\n\n   \n${SHA_A}\trefs/heads/main\n${SHA_B}\trefs/tags/v2.0.0\n`);
    assert.deepEqual(tags, ['v2.0.0']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The `ref` string — THE CONTRACT. #372 writes it into `.waffle/waffle.yaml`
// (`doctor.toolkitRef` / `waffle.toolkitRef`) and #374 writes it into the lock.
// ─────────────────────────────────────────────────────────────────────────────

describe('the toolkit ref string is exactly `github:<owner>/<repo>#<tag>` (#373 → #372/#374)', () => {
  test('toolkitRef() renders the npx spec, and nothing else', () => {
    assert.equal(toolkitRef({ owner: 'dustinkeeton', repo: 'wafflestack' }, 'v0.12.0'), 'github:dustinkeeton/wafflestack#v0.12.0');
    // Null unless BOTH halves are known — a half-formed ref in a lock is worse than none.
    assert.equal(toolkitRef({ owner: 'o', repo: 'r' }, null), null);
    assert.equal(toolkitRef(null, 'v1.0.0'), null);
  });

  test('a fork names ITSELF, so its users are not sent to pin upstream', () => {
    assert.equal(toolkitRef({ owner: 'someone-else', repo: 'wafflestack' }, 'v1.0.0'), 'github:someone-else/wafflestack#v1.0.0');
  });

  test('parseRepoSlug reads every form a GitHub repo is written in', () => {
    const want = { owner: 'dustinkeeton', repo: 'wafflestack' };
    // npm records the resolved URL in this shape — it is the one that MUST parse.
    assert.deepEqual(parseRepoSlug('git+ssh://git@github.com/dustinkeeton/wafflestack.git#' + SHA_A), want);
    assert.deepEqual(parseRepoSlug('git+https://github.com/dustinkeeton/wafflestack.git'), want);
    assert.deepEqual(parseRepoSlug('https://github.com/dustinkeeton/wafflestack'), want);
    assert.deepEqual(parseRepoSlug('git@github.com:dustinkeeton/wafflestack.git'), want);
    assert.deepEqual(parseRepoSlug('github:dustinkeeton/wafflestack'), want);
    assert.deepEqual(parseRepoSlug('dustinkeeton/wafflestack'), want);
    assert.equal(parseRepoSlug(null), null);
    assert.equal(parseRepoSlug(''), null);
    // A relative path must NEVER be mistaken for `owner/repo` — that would point ls-remote at
    // a nonsense URL and turn a resolvable identity into an `unverified` one.
    assert.equal(parseRepoSlug('../elsewhere'), null);
    assert.equal(parseRepoSlug('./x'), null);
  });

  test('httpsUrl normalizes to an unauthenticated fetch — an ssh URL would demand a key on CI', () => {
    assert.equal(httpsUrl({ owner: 'o', repo: 'r' }), 'https://github.com/o/r.git');
  });

  test("repoSlug prefers package.json's `repository` — the canonical, offline answer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-slug-'));
    try {
      const pkg = { name: 'wafflestack', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } };
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => null }), { owner: 'dustinkeeton', repo: 'wafflestack' });
      // …and this repo really does carry the field (it is what makes the remedy printable offline).
      const real = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
      assert.deepEqual(repoSlug({ toolkitRoot: REPO_ROOT, pkg: real, runGit: () => null }), {
        owner: 'dustinkeeton',
        repo: 'wafflestack',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// origin: 'checkout' — toolkit development. `git describe` answers it, OFFLINE.
// ─────────────────────────────────────────────────────────────────────────────

describe('identity from a git checkout (#373)', { skip: gitOk ? false : 'git not available' }, () => {
  let work;

  /** A real temp git repo laid out as a toolkit root: package.json, CHANGELOG, one commit, one tag. */
  const git = (...a) => {
    const r = spawnSync('git', ['-C', work, ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  };

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-checkout-'));
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work]).status, 0);
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('remote', 'add', 'origin', 'https://github.com/acme/toolkit.git');
    write(work, 'package.json', JSON.stringify({ name: 'wafflestack', version: '0.9.0' }));
    // No `## [Unreleased]` entries: a release stamps them down. This fixture IS the tag.
    write(work, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-01-01\n\n- shipped it\n');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'release');
    git('tag', 'v0.9.0');
  });

  afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

  const advance = (msg) => {
    write(work, 'NOTES.md', msg);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
  };
  const head = () => spawnSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  test('AT a release tag → `release`, with the ref that reproduces it — and NO network call', () => {
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(id.status, 'release');
    assert.equal(id.origin, 'checkout');
    assert.equal(id.tag, 'v0.9.0');
    assert.equal(id.commit, head());
    assert.equal(id.version, '0.9.0');
    // The repo comes from the git remote here (no `repository` in the fixture's package.json).
    assert.equal(id.repo, 'acme/toolkit');
    assert.equal(id.ref, 'github:acme/toolkit#v0.9.0');
    assert.equal(id.lookupError, null);
    // A released toolkit has nothing to warn about — its version number identifies it completely.
    assert.equal(formatProvenanceWarning(id), null);
  });

  test('ONE COMMIT PAST the tag → `unreleased`, with no ref, and still no network call', () => {
    advance('unreleased work');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(id.status, 'unreleased');
    assert.equal(id.origin, 'checkout');
    assert.equal(id.tag, null);
    assert.equal(id.ref, null, 'ref is non-null ONLY for a release — this is what #374 writes into the lock');
    assert.equal(id.commit, head());
    // The remedy names the latest LOCAL tag: the checkout knows its own tags, so it never has to ask.
    assert.equal(id.latestTag, 'v0.9.0');
    assert.match(formatProvenanceWarning(id) ?? '', /NOT a release/);
  });

  test('the remedy names the latest tag by SEMVER, not the most recently created one', () => {
    advance('more');
    git('tag', 'v0.10.0');
    advance('yet more');
    git('tag', 'v0.9.1'); // created LAST, but older by semver
    advance('past every tag');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(id.status, 'unreleased');
    assert.equal(id.latestTag, 'v0.10.0');
  });

  test('a non-release tag on HEAD is not a release (only `vX.Y.Z` counts)', () => {
    advance('rc');
    git('tag', 'v1.0.0-rc.1');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(id.status, 'unreleased');
    assert.equal(id.ref, null);
  });

  test('`--allow-unreleased` suppresses the REFUSAL, never the TRUTH', () => {
    advance('unreleased work');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork, allowUnreleased: true });
    // Still `unreleased` — this is what keeps the lock #374 writes honest rather than merely permitted.
    assert.equal(id.status, 'unreleased');
    assert.equal(id.ref, null);
    assert.equal(id.commit, head());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// origin: 'npm-install' — the `npx github:` consumer path. No `.git`; npm's hidden
// lockfile records the SHA it cloned, and ONE ls-remote classifies it.
// ─────────────────────────────────────────────────────────────────────────────

describe('identity from an npm-install layout (#373)', () => {
  let tmp;
  let toolkitRoot;

  // The real shape, verified against a live `~/.npm/_npx/<hash>/` cache during planning:
  //   <tmp>/node_modules/wafflestack/          ← the toolkit (no .git)
  //   <tmp>/node_modules/.package-lock.json    ← npm's hidden lockfile, with the resolved SHA
  const layout = ({ resolved, name = 'wafflestack', lockBody, changelog }) => {
    toolkitRoot = path.join(tmp, 'node_modules', name);
    write(toolkitRoot, 'package.json', JSON.stringify({
      name,
      version: '0.12.0',
      repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' },
    }));
    if (changelog !== null) write(toolkitRoot, 'CHANGELOG.md', changelog ?? '# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n');
    if (lockBody !== undefined) {
      write(tmp, 'node_modules/.package-lock.json', lockBody);
    } else if (resolved !== undefined) {
      write(tmp, 'node_modules/.package-lock.json', JSON.stringify({
        name: 'consumer',
        lockfileVersion: 3,
        packages: { [`node_modules/${name}`]: { version: '0.12.0', resolved } },
      }));
    }
    return toolkitRoot;
  };

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-npm-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('the fetched SHA IS a release tag → `release`, ref populated', () => {
    const root = layout({ resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    const lsRemote = fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`, `${SHA_B}\trefs/tags/v0.11.0`]);
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote });

    assert.equal(id.status, 'release');
    assert.equal(id.origin, 'npm-install');
    assert.equal(id.commit, SHA_A);
    assert.equal(id.tag, 'v0.12.0');
    assert.equal(id.ref, 'github:dustinkeeton/wafflestack#v0.12.0');
    // ONE lookup, and against HTTPS — npm records `git+ssh://`, and an unauthenticated ls-remote
    // against THAT demands an ssh key, which a CI runner does not have.
    assert.deepEqual(lsRemote.calls, ['https://github.com/dustinkeeton/wafflestack.git']);
  });

  test('the fetched SHA is NOT any tag (the unpinned default branch) → `unreleased`', () => {
    // This is issue #373 itself: `npx github:dustinkeeton/wafflestack render`, no `#ref`.
    const root = layout({ resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${SHA_B}` });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`]) });

    assert.equal(id.status, 'unreleased');
    assert.equal(id.origin, 'npm-install');
    assert.equal(id.commit, SHA_B);
    assert.equal(id.tag, null);
    assert.equal(id.ref, null);
    assert.equal(id.latestTag, 'v0.12.0', 'the remedy must name the release to pin');
  });

  test('a pinned NON-release ref (a branch) refuses too — that IS unreleased content', () => {
    // `npx github:…/wafflestack#some-branch`. The invariant is not "was a #ref typed" but "is the
    // code I am running a released commit" — which also catches a re-cut or force-pushed tag.
    const root = layout({ resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${'f'.repeat(40)}` });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`]) });
    assert.equal(id.status, 'unreleased');
  });

  test('an annotated release tag still resolves — the peeled commit is what npm cloned', () => {
    const root = layout({ resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    const id = resolveToolkitIdentity({
      toolkitRoot: root,
      lsRemote: fakeLsRemote([`${TAG_OBJECT_SHA}\trefs/tags/v0.12.0`, `${SHA_A}\trefs/tags/v0.12.0^{}`]),
    });
    assert.equal(id.status, 'release');
    assert.equal(id.ref, 'github:dustinkeeton/wafflestack#v0.12.0');
  });

  test('no lockfile at all → `unverified`, never a throw (npm internals may change shape)', () => {
    // Note the changelog: `## [Unreleased]` present but EMPTY, which a release leaves behind. So
    // the corroborator has nothing to say and the verdict stays honestly ignorant.
    const root = layout({ changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n' });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork });
    assert.equal(id.status, 'unverified');
    assert.equal(id.origin, 'unknown');
    assert.equal(id.commit, null);
    assert.equal(id.ref, null);
    assert.match(id.lookupError ?? '', /lockfile/i);
    // Fails OPEN: the command proceeds, with a warning that says exactly what we could not learn.
    assert.match(formatProvenanceWarning(id) ?? '', /could not verify/i);
  });

  test('a garbage lockfile → `unverified`, never a throw', () => {
    const root = layout({ lockBody: '{ not json at all', changelog: '# Changelog\n\n## [Unreleased]\n' });
    assert.equal(resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork }).status, 'unverified');
  });

  test('a lockfile with no resolvable 40-char SHA → `unverified`', () => {
    // A registry install (no `#sha`), and a truncated sha — neither is provenance.
    for (const resolved of ['https://registry.npmjs.org/wafflestack/-/wafflestack-0.12.0.tgz', 'git+ssh://git@github.com/o/r.git#abc123']) {
      const root = layout({ resolved, changelog: '# Changelog\n\n## [Unreleased]\n' });
      assert.equal(resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork }).status, 'unverified', resolved);
      fs.rmSync(path.join(tmp, 'node_modules'), { recursive: true, force: true });
    }
  });

  test('THE LOOKUP THROWS (offline, GitHub blip) → `unverified` + lookupError, and we proceed', () => {
    // Fail OPEN on ignorance. Failing closed here would make every consumer's CI depend on OUR
    // reachability — a far worse bug than the one being fixed. Fail-closed applies only to a
    // lookup that SUCCEEDED and said "not a release".
    const root = layout({
      resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}`,
      changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n',
    });
    const id = resolveToolkitIdentity({
      toolkitRoot: root,
      lsRemote: () => { throw new Error('Could not resolve host: github.com'); },
    });
    assert.equal(id.status, 'unverified');
    assert.equal(id.origin, 'npm-install');
    assert.equal(id.commit, SHA_A, 'the SHA is read OFFLINE — a failed lookup does not lose it');
    assert.equal(id.ref, null);
    assert.match(id.lookupError ?? '', /Could not resolve host/);
    // The remedy still has a tag to name: the SHIPPED changelog's newest released heading.
    assert.equal(id.latestTag, 'v0.12.0');
  });

  test('`--allow-unreleased` short-circuits the network — this is what keeps `npm test` offline', () => {
    const root = layout({ resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork, allowUnreleased: true });
    assert.equal(id.commit, SHA_A);
    assert.notEqual(id.status, 'release', 'the escape hatch must never MANUFACTURE a release verdict');
  });

  test('`offline: true` (plain doctor, the banner) also skips the lookup', () => {
    const root = layout({ resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork, offline: true });
    assert.equal(id.commit, SHA_A);
    assert.match(id.lookupError ?? '', /skipped/);
  });

  test('commitFromNpmLockfile / shaFromResolved read only a full 40-char sha', () => {
    const root = layout({ resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    assert.equal(commitFromNpmLockfile(root, 'wafflestack'), SHA_A);
    assert.equal(commitFromNpmLockfile(root, 'not-the-package'), SHA_A, 'falls back to the entry at our own dir name');
    assert.equal(shaFromResolved(`git+ssh://git@github.com/o/r.git#${SHA_A}`), SHA_A);
    assert.equal(shaFromResolved('git+ssh://git@github.com/o/r.git#v0.12.0'), null);
    assert.equal(shaFromResolved(null), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The offline corroborator. The CHANGELOG *ships* (package.json `files`), and a release stamps
// `## [Unreleased]` down into `## [X.Y.Z]`. So a shipped changelog carrying a non-empty
// `## [Unreleased]` section is proof — needing no network — that this build is not a release.
// ─────────────────────────────────────────────────────────────────────────────

describe('the CHANGELOG corroborator tightens `unverified` → `unreleased` (#373)', () => {
  let tmp;
  let root;
  const npmLayout = (changelog) => {
    root = path.join(tmp, 'node_modules', 'wafflestack');
    write(root, 'package.json', JSON.stringify({
      name: 'wafflestack',
      version: '0.12.0',
      repository: 'github:dustinkeeton/wafflestack',
    }));
    write(root, 'CHANGELOG.md', changelog);
    write(tmp, 'node_modules/.package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/wafflestack': { resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` } },
    }));
    return root;
  };

  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-changelog-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const failedLookup = () => { throw new Error('offline'); };

  test('a NON-EMPTY `## [Unreleased]` section + a failed lookup → `unreleased`', () => {
    const id = resolveToolkitIdentity({
      toolkitRoot: npmLayout('# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- something on main\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n'),
      lsRemote: failedLookup,
    });
    assert.equal(id.status, 'unreleased', 'the shipped changelog proves this build is past the tag');
    assert.equal(id.commit, SHA_A);
    assert.match(id.lookupError ?? '', /shipped CHANGELOG\.md carries an unreleased section/);
    assert.equal(id.latestTag, 'v0.12.0');
  });

  test('an EMPTY `## [Unreleased]` heading (what a release leaves behind) is NOT evidence', () => {
    const id = resolveToolkitIdentity({
      toolkitRoot: npmLayout('# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n'),
      lsRemote: failedLookup,
    });
    assert.equal(id.status, 'unverified', 'ignorance must stay ignorance — this fails OPEN');
  });

  test('the corroborator never OVERRIDES a successful lookup that said `release`', () => {
    // main's changelog shape, but the SHA really is the tag: the network wins, every time.
    const id = resolveToolkitIdentity({
      toolkitRoot: npmLayout('# Changelog\n\n## [Unreleased]\n\n- entries\n\n## [0.12.0] - 2026-07-11\n'),
      lsRemote: fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`]),
    });
    assert.equal(id.status, 'release');
  });

  test('changelogHasUnreleasedEntries / changelogLatestRelease, directly', () => {
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n- a thing\n'), true);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n## [1.0.0] - 2026\n'), false);
    assert.equal(changelogHasUnreleasedEntries('## Unreleased\n\n- a thing\n'), true, 'the brackets are optional');
    assert.equal(changelogHasUnreleasedEntries(null), false);
    assert.equal(changelogLatestRelease('## [0.9.0] - x\n## [0.10.0] - y\n'), 'v0.10.0', 'semver order, not file order');
    assert.equal(changelogLatestRelease('## [Unreleased]\n'), null);
    assert.equal(changelogLatestRelease(null), null);
  });

  test('THIS repo\'s own shipped CHANGELOG is the live case — main carries unreleased entries', () => {
    // Not a fixture: the real file. It is what lets a consumer who fetched the default branch be
    // told the truth even when GitHub is unreachable. If a release ever ships with a non-empty
    // `## [Unreleased]`, this module would call it `unreleased` — the safe direction to be wrong in.
    const real = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    assert.equal(changelogHasUnreleasedEntries(real), true, 'main must carry unreleased entries — it is 70+ commits past the tag');
    assert.match(changelogLatestRelease(real) ?? '', /^v\d+\.\d+\.\d+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusal message. This IS the feature: the whole value of failing closed over
// silently rendering the default branch is the copy-pasteable command it hands back.
// ─────────────────────────────────────────────────────────────────────────────

describe('formatUnreleasedRefusal (#373)', () => {
  /** @type {any} */
  const unreleased = {
    status: 'unreleased',
    version: '0.12.0',
    commit: 'fae04ff' + '0'.repeat(33),
    tag: null,
    ref: null,
    origin: 'npm-install',
    repo: 'dustinkeeton/wafflestack',
    latestTag: 'v0.12.0',
    lookupError: null,
  };

  test('names the exact pinned command to run instead', () => {
    const msg = formatUnreleasedRefusal(unreleased, 'upgrade');
    assert.match(msg, /refusing to run `upgrade` from an unreleased toolkit/);
    assert.match(msg, /npx --yes github:dustinkeeton\/wafflestack#v0\.12\.0 upgrade/);
    assert.match(msg, /toolkitRef: github:dustinkeeton\/wafflestack#v0\.12\.0/);
    assert.match(msg, /--allow-unreleased/, 'the toolkit developer must be told their way through');
    assert.match(msg, /fae04ff/, 'name the commit we actually landed on');
  });

  test('with no known tag it still prints a shaped command rather than a dead end', () => {
    const msg = formatUnreleasedRefusal({ ...unreleased, latestTag: null }, 'render');
    assert.match(msg, /npx --yes github:dustinkeeton\/wafflestack#<latest release tag> render/);
  });

  test('a fork is told to pin ITSELF', () => {
    const msg = formatUnreleasedRefusal({ ...unreleased, repo: 'acme/forked' }, 'render');
    assert.match(msg, /npx --yes github:acme\/forked#v0\.12\.0 render/);
    assert.doesNotMatch(msg, /npx --yes github:dustinkeeton/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE GATE MATRIX — one assertion per command, driven through the real CLI.
//
// The toolkit under test is THIS checkout, which is `unreleased` by construction: a feature
// branch (or, in CI, an `actions/checkout` that fetches no tags at all). That resolves OFFLINE
// via `git describe`, so these spawns make zero network calls. The one case that would not is a
// checkout sitting exactly ON a release tag — rare, but real during a release — so the refusal
// half is skipped there rather than asserted falsely.
// ─────────────────────────────────────────────────────────────────────────────

describe('the gate matrix: which commands refuse an unreleased toolkit (#373)', () => {
  let cwd;

  // CI sets WAFFLESTACK_ALLOW_UNRELEASED=1 at the job level (tests.yml) and installer.test.mjs sets
  // it process-wide — both correct for suites that need to RENDER. This suite asserts the gate, so
  // it must run with the hatch CLOSED. Strip it per spawn rather than trusting the ambient env.
  const gated = (args) => {
    const env = { ...process.env };
    delete env.WAFFLESTACK_ALLOW_UNRELEASED;
    return spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd], { encoding: 'utf8', env, timeout: 30000 });
  };
  const allowed = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd], {
      encoding: 'utf8',
      env: { ...process.env, WAFFLESTACK_ALLOW_UNRELEASED: '1', ...extraEnv },
      timeout: 30000,
    });

  // The identity of the checkout the CLI will resolve for itself — computed the same way it does.
  const selfIdentity = resolveToolkitIdentity({ toolkitRoot: REPO_ROOT, offline: true });
  const isUnreleased = selfIdentity.status === 'unreleased';
  const skipUnlessUnreleased = isUnreleased
    ? false
    : `this checkout resolves as \`${selfIdentity.status}\` (not \`unreleased\`), so there is no refusal to assert — ` +
      'run the suite from a branch, as CI does';

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-gate-'));
    // A minimal but VALID project, so a command that gets past the gate fails (if at all) on its
    // own merits rather than on a missing config — otherwise "did not refuse" proves nothing.
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\nconfig: {}\n');
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const REFUSAL = /refusing to run `[^`]+` from an unreleased toolkit/;

  // Every command that WRITES FILES FROM TOOLKIT CONTENT.
  for (const args of [['render'], ['bake'], ['install'], ['upgrade'], ['reinstall'], ['doctor', '--verify-render']]) {
    test(`\`${args.join(' ')}\` REFUSES: exit 1, and names the pinned command`, { skip: skipUnlessUnreleased }, () => {
      const r = gated(args);
      assert.equal(r.status, 1, `expected a refusal, got:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, REFUSAL);
      // The refusal must be actionable, or failing closed is just breakage.
      assert.match(r.stderr, /Run this instead:/);
      assert.match(r.stderr, new RegExp(`npx --yes github:\\S+#v\\d+\\.\\d+\\.\\d+ ${args[0]}\\b`));
      assert.match(r.stderr, /--allow-unreleased/);
      // …and it must refuse BEFORE doing anything: nothing rendered, nothing written.
      assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), false, 'a refused command must write nothing');
    });
  }

  // `install <ref>` must refuse BEFORE persisting the selection — a consumer left holding a
  // selection they were never able to render is worse than a clean refusal.
  test('`install <ref>` refuses without persisting the ref into waffle.yaml', { skip: skipUnlessUnreleased }, () => {
    const before = fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8');
    const r = gated(['install', 'stacks/github-workflow']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, REFUSAL);
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), before, 'waffle.yaml must be untouched');
  });

  // Everything that does NOT write files from toolkit content. These may still exit non-zero on
  // their own merits (a `doctor` with no lock, an `eject` of a nonexistent item) — what is asserted
  // is that they never REFUSE. Gating them would be the outage: plain `doctor` is the drift check
  // every consumer runs on every PR, off the unpinned default `doctor.toolkitRef`.
  for (const args of [['doctor'], ['doctor', '--allow-missing'], ['list'], ['setup'], ['init'], ['eject', 'skills/nope'], ['uninstall'], ['validate'], ['help']]) {
    test(`\`${args.join(' ')}\` is NOT gated — it never refuses`, () => {
      const r = gated(args);
      assert.doesNotMatch(r.stderr, REFUSAL, `\`${args.join(' ')}\` must not be gated:\n${r.stderr}`);
      assert.doesNotMatch(r.stdout, REFUSAL);
    });
  }

  test('plain `doctor` and `help` stay green — the gate must not red the shipped CI check', () => {
    // `render` first (through the hatch) so there is a lock to doctor against.
    assert.equal(allowed(['render']).status, 0);
    const dr = gated(['doctor']);
    assert.equal(dr.status, 0, `plain doctor must pass from an unreleased toolkit:\n${dr.stdout}\n${dr.stderr}`);
    assert.equal(gated(['help']).status, 0);
  });

  test('`list` and `setup` WARN instead of refusing, and name the release to pin', { skip: skipUnlessUnreleased }, () => {
    for (const cmd of ['list', 'setup']) {
      const r = gated([cmd]);
      assert.doesNotMatch(r.stderr, REFUSAL);
      assert.match(r.stderr, /NOT a release/, `${cmd} must say what it is`);
      assert.match(r.stderr, /Pin to `github:\S+#v\d+\.\d+\.\d+`/, `${cmd} must name the pin`);
    }
  });

  test('`--allow-unreleased` bypasses the refusal — and `render` then actually renders', () => {
    const r = gated(['render', '--allow-unreleased']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, REFUSAL);
    assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), true);
  });

  test('WAFFLESTACK_ALLOW_UNRELEASED=1 is the env twin, and it bypasses too', () => {
    const r = allowed(['render']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, REFUSAL);
    assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), true);
  });

  test('the escape hatch suppresses the refusal but NOT the warning — the truth still gets said', { skip: skipUnlessUnreleased }, () => {
    const r = allowed(['render']);
    assert.match(r.stderr, /NOT a release/, 'a permitted unreleased render must still announce itself');
  });

  test('`--allow-unreleased` is accepted by every command, not just the gated ones', () => {
    // The flag is stripped globally, before any "takes no refs" guard runs — otherwise it would be
    // rejected as a stray ref by exactly the commands that need it least.
    for (const cmd of ['render', 'upgrade', 'reinstall', 'list', 'doctor']) {
      const r = allowed([cmd, '--allow-unreleased']);
      assert.doesNotMatch(r.stderr, /takes no refs/, `${cmd} must not treat --allow-unreleased as a ref`);
    }
  });

  test('the help text documents the flag and its env twin', () => {
    const r = gated(['help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--allow-unreleased/);
    assert.match(r.stdout, /WAFFLESTACK_ALLOW_UNRELEASED=1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The identity object reaches the write site — #374 writes it into the lock, #372 into
// waffle.yaml. Neither can, if `renderProject`/`upgrade` never see it.
// ─────────────────────────────────────────────────────────────────────────────

describe('the identity is threaded to the render/upgrade write sites (#373 → #374/#372)', () => {
  test('renderProject echoes the identity it was handed back on its result', () => {
    const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-thread-toolkit-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-thread-project-'));
    try {
      write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
      write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
      write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nbody\n');
      write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');

      const identity = /** @type {any} */ ({
        status: 'release',
        version: '0.12.0',
        commit: SHA_A,
        tag: 'v0.12.0',
        ref: 'github:dustinkeeton/wafflestack#v0.12.0',
        origin: 'npm-install',
        repo: 'dustinkeeton/wafflestack',
        latestTag: 'v0.12.0',
        lookupError: null,
      });
      const result = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test', toolkitIdentity: identity });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      assert.equal(result.identity?.ref, 'github:dustinkeeton/wafflestack#v0.12.0');

      // …and the lock is UNCHANGED by it. Writing the field is #374's issue, deliberately not this
      // one: doing it here would rewrite every consumer's lock bytes in a change about the GATE.
      const lock = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
      assert.equal(lock.toolkitVersion, '0.0.test');
      assert.equal('toolkitRef' in lock, false, 'the lock field is #374 — this PR only makes the value reachable');

      // Absent, everything behaves exactly as it always did (evals.mjs and most tests render this way).
      const bare = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
      assert.equal(bare.ok, true);
      assert.equal(bare.identity, null);
    } finally {
      for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('upgrade returns the identity that performed it — #372 reads it to bump the pins', () => {
    const toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-up-toolkit-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-up-project-'));
    try {
      write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
      write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
      write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nbody\n');
      write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');

      const identity = /** @type {any} */ ({
        status: 'release',
        version: '0.13.0',
        commit: SHA_A,
        tag: 'v0.13.0',
        ref: 'github:dustinkeeton/wafflestack#v0.13.0',
        origin: 'npm-install',
        repo: 'dustinkeeton/wafflestack',
        latestTag: 'v0.13.0',
        lookupError: null,
      });
      const result = upgrade({ toolkitRoot, cwd, toolkitVersion: '0.13.0', toolkitIdentity: identity, changelog: '# Changelog\n', migrations: [] });
      // `toVersion` finally MEANS something: a gated upgrade can only run at a release, so the
      // number it announces names a tag whose content is exactly what it just rendered.
      assert.equal(result.toVersion, '0.13.0');
      assert.equal(result.identity?.ref, 'github:dustinkeeton/wafflestack#v0.13.0');
    } finally {
      for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doctor's version-skew remedy must not send the reader into the refusal it just built.
// ─────────────────────────────────────────────────────────────────────────────

describe('the version-skew remedy names a command that WORKS (#373 / #372)', () => {
  let cwd;
  let toolkitRoot;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-skew-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-skew-project-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
    write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
    write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nbody\n');
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.11.0' }); // the lock says 0.11.0…
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  // …and the running CLI says 0.12.0 → version skew. The note is the thing under test.
  const notes = (toolkitIdentity) =>
    doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity, toolkitRoot }).notes.join('\n');

  /** @type {any} */
  const identityAt = (status) => ({
    status,
    version: '0.12.0',
    commit: SHA_A,
    tag: status === 'release' ? 'v0.12.0' : null,
    ref: status === 'release' ? 'github:dustinkeeton/wafflestack#v0.12.0' : null,
    origin: 'npm-install',
    repo: 'dustinkeeton/wafflestack',
    latestTag: 'v0.12.0',
    lookupError: null,
  });

  test('an UNRELEASED CLI prints the pinned command, not the bare `upgrade` that would refuse', () => {
    // #372's "self-defeating remedy": doctor said "run `wafflestack upgrade`", which for most
    // people IS the unpinned `npx github:…` — the exact command the gate now refuses. Sending the
    // reader there would be handing them a loop.
    const out = notes(identityAt('unreleased'));
    assert.match(out, /version skew/);
    assert.match(out, /npx --yes github:dustinkeeton\/wafflestack#v0\.12\.0 upgrade/);
    assert.match(out, /would refuse/);
  });

  test('a RELEASE CLI (and an absent identity) keep the remedy exactly as it always read', () => {
    assert.match(notes(identityAt('release')), /version skew — run `wafflestack upgrade`/);
    assert.match(notes(null), /version skew — run `wafflestack upgrade`/);
  });
});
