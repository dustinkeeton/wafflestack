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

  test('repoSlug reads PROVENANCE before DECLARATION — and the git remote outranks `repository` too', () => {
    // The declared field says what a toolkit CLAIMS to be; `resolved` and `origin` say where it came
    // FROM. A fork inherits the claim verbatim, so preferring it asks the wrong remote — see the
    // fork test in the npm-install suite. Order: npm `resolved` → git `origin` → `repository`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-slug-'));
    try {
      const pkg = { name: 'wafflestack', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } };
      // No lockfile, no .git → the declared field is all there is, and it answers. (Last resort, and
      // a correct one: a vendored copy or a registry tarball has no provenance to read.)
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => null }), { owner: 'dustinkeeton', repo: 'wafflestack' });

      // A CHECKOUT whose `origin` is a fork, still carrying upstream's declared `repository`: the
      // remote wins. This is the toolkit developer working in their own fork.
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => 'git@github.com:acme/wafflestack.git' }), {
        owner: 'acme',
        repo: 'wafflestack',
      });
      // …and with no usable remote, it still falls back to the declaration rather than to nothing.
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => null }), { owner: 'dustinkeeton', repo: 'wafflestack' });

      // This repo really does carry the field (it is what keeps the remedy printable for a toolkit
      // with no provenance to read), and this checkout's own remote agrees with it.
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

  test('A DIRTY TREE ON A RELEASE TAG IS NOT A RELEASE — the tag stops describing what renders', () => {
    // `git describe --exact-match` answers about the COMMIT and ignores the WORKING TREE. So a
    // maintainer who checks out `v0.9.0` to reproduce a consumer issue, edits `stacks/**`, and
    // renders, was classified `release` and handed `ref: github:…#v0.9.0` — a ref that does NOT
    // reproduce what just rendered. An unreleased toolkit landing in `release`: #373's own disease
    // through the checkout door, and once #374 writes `ref` into the lock, a provenance marker
    // naming content it did not produce.
    write(work, 'stacks/x/stack.yaml', 'name: x\ndescription: X.\n');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'stacks');
    git('tag', '-f', 'v0.9.0'); // HEAD is exactly the release tag, tree clean

    const clean = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(clean.status, 'release', 'a CLEAN tree on the tag is still a release — do not over-refuse');
    assert.equal(clean.ref, 'github:acme/toolkit#v0.9.0');

    // An UNTRACKED scratch file is NOT a dirty toolkit: nothing that renders has changed, and
    // refusing here would refuse every maintainer with a note in their tree.
    write(work, 'scratch.txt', 'a note to self');
    const scratched = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(scratched.status, 'release', 'untracked files must NOT trip the dirty check');

    // A TRACKED edit to toolkit content IS: this is what actually renders.
    write(work, 'stacks/x/stack.yaml', 'name: x\ndescription: X, LOCALLY EDITED.\n');
    const dirty = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(dirty.status, 'unreleased', 'the tag no longer describes what would render');
    assert.equal(dirty.ref, null, 'and there is NO ref that reproduces this tree — #374 must not get one');
    assert.equal(dirty.tag, null);
    assert.equal(dirty.latestTag, 'v0.9.0', 'the remedy can still name the release to pin');

    // The refusal must say WHY. "No release tag points here" would be a flat lie — one points here.
    const msg = formatUnreleasedRefusal(dirty, 'render');
    assert.doesNotMatch(msg, /no release tag points here/);
    assert.match(msg, /uncommitted changes to tracked files/);
    assert.match(msg, /HEAD is v0\.9\.0/);
  });

  test('A CHECKOUT NEVER QUERIES THE REMOTE — so the refusal must hedge, never assert', () => {
    // The THIRD state that reaches `latestTag === null`, and the one the `origin === 'npm-install'`
    // conjunct in `provablyNone` exists to catch. A checkout has `lookupError === null` — nothing
    // FAILED; the checkout path simply never asks — so `lookupError` alone does NOT discriminate it.
    // Only `origin` does. Delete that conjunct and this checkout asserts "acme/toolkit has no
    // vX.Y.Z release tags" about a remote it never contacted: the exact over-claim class this PR has
    // now shipped twice (round 1's "a bare `upgrade` would refuse"; round 2's "there is no release
    // to pin to"). Without this test the whole guard rests on one conjunct a refactor can silently
    // drop — and the suite stayed green when I dropped it.
    git('tag', '-d', 'v0.9.0'); // no local release tags…
    write(work, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- work in progress\n'); // …and no `## [X.Y.Z]` to fall back on
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });

    assert.equal(id.status, 'unreleased');
    assert.equal(id.origin, 'checkout');
    assert.equal(id.latestTag, null, 'nothing can name a tag: no local v* tags, no version headings');
    assert.equal(id.lookupError, null, 'and nothing FAILED — which is exactly why `lookupError` cannot discriminate this');

    const msg = formatUnreleasedRefusal(id, 'render');
    assert.doesNotMatch(msg, /has no `vX\.Y\.Z` release tags/, 'a checkout never asked the remote — it cannot say that');
    assert.match(msg, /No `vX\.Y\.Z` release of acme\/toolkit is known to this CLI/);
    assert.match(msg, /there may well be one to pin to that this run cannot see/);
  });

  test('THE CONTRACT #374/#372 REST ON: `status: release` does NOT imply a non-null `ref`', () => {
    // The JSDoc says `ref` is non-null ONLY for a release. True — and one-directional, which is the
    // trap: it does not say non-null WHENEVER. `status` is fixed at 'release' by `git describe`
    // BEFORE the repo slug is consulted, so a release whose slug is unknowable — no `repository` in
    // package.json (this fixture), no npm lockfile, no `origin` remote — is a genuine release with
    // `ref: null`. A consumer that branches on `status === 'release'` and then dereferences `ref`
    // (#374 writes it into the lock; #372 into `doctor.toolkitRef` / `waffle.toolkitRef`) writes a
    // null into a lock the first time someone renders from a bare clone.
    //
    // KEY ON `ref != null`, NOT ON `status === 'release'`. This test is what makes that
    // enforceable rather than merely stated.
    git('remote', 'remove', 'origin');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(id.status, 'release', 'it IS a release — the tag is right there on HEAD');
    assert.equal(id.tag, 'v0.9.0');
    assert.equal(id.repo, null, 'but nothing can say WHICH repo');
    assert.equal(id.ref, null, 'so there is no npx spec that reproduces it — and #374/#372 must handle this');
    assert.equal(formatProvenanceWarning(id), null, 'still a release: nothing to warn about');
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
  const layout = ({ resolved, name = 'wafflestack', lockBody, changelog, repository = { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } }) => {
    toolkitRoot = path.join(tmp, 'node_modules', name);
    write(toolkitRoot, 'package.json', JSON.stringify({
      name,
      version: '0.12.0',
      repository,
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

  test('AN UNEDITED FORK IS ASKED ABOUT ITSELF — provenance beats the declared `repository`', () => {
    // The realistic fork: `gh repo fork`, cut a tag, push, change NOTHING else. It carries UPSTREAM's
    // `repository` field verbatim — nothing prompts anyone to rewrite it (the package is
    // `private: true` and never published; #373 is what introduced the field) — while npm's
    // `resolved` records where this build actually came from.
    //
    // With `repository` consulted first, `ls-remote` went to UPSTREAM, which has never heard of the
    // fork's commit → `unreleased` → a correctly-pinned fork release HARD-REFUSED (the inverse of
    // #373), and the remedy told them to `npx github:dustinkeeton/wafflestack#v0.12.0` — installing a
    // DIFFERENT REPO'S TOOLKIT and rendering upstream content into their repo. #374 would then bake
    // upstream's slug into the fork's lock as provenance.
    const root = layout({
      resolved: `git+ssh://git@github.com/acme/wafflestack.git#${SHA_A}`,
      // repository: left as the default — UPSTREAM's, inherited. This is the whole point.
    });
    /** Answers per-URL, so the test pins WHICH REMOTE WAS ASKED and cannot pass by fixture. */
    const asked = [];
    const lsRemote = (url) => {
      asked.push(url);
      // acme cut its own v1.0.0 at this exact commit. Upstream has never seen the commit.
      return url.includes('acme') ? `${SHA_A}\trefs/tags/v1.0.0` : `${SHA_B}\trefs/tags/v0.12.0`;
    };
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote });

    assert.deepEqual(asked, ['https://github.com/acme/wafflestack.git'], 'ask where the build CAME FROM, not what it declares');
    assert.equal(id.status, 'release', 'a correctly-pinned fork release must NOT be refused');
    assert.equal(id.repo, 'acme/wafflestack');
    assert.equal(id.tag, 'v1.0.0');
    assert.equal(id.ref, 'github:acme/wafflestack#v1.0.0', 'the ref #374 writes must name the fork, not upstream');
  });

  test('the DECLARED `repository` is the last resort — used only when provenance is unknowable', () => {
    // No lockfile and no `.git`: a vendored copy or a registry tarball. Here the declared field is
    // all there is, and it is right to use it — it is only wrong to PREFER it.
    const root = path.join(tmp, 'node_modules', 'wafflestack');
    write(root, 'package.json', JSON.stringify({ name: 'wafflestack', version: '0.12.0', repository: 'github:dustinkeeton/wafflestack' }));
    assert.deepEqual(repoSlug({ toolkitRoot: root, pkg: { name: 'wafflestack', repository: 'github:dustinkeeton/wafflestack' }, runGit: () => null }), {
      owner: 'dustinkeeton',
      repo: 'wafflestack',
    });
  });

  test('a remote with ZERO release tags names no pinned command — it never inherits UPSTREAM\'s tag', () => {
    // A fork or a vendored copy that has cut none of its own tags. `git clone` + push to a new remote
    // carries no tags, so this is the ORDINARY shape of a derivative, not an exotic one — and it is
    // exactly the population `repoSlug` exists to serve ("a fork names ITSELF in the remedy").
    //
    // The lookup SUCCEEDS and returns nothing. That is POSITIVE knowledge that there is nothing to
    // pin — categorically different from "we could not look" — so `latestTag` must not fall back to
    // the tag scraped from the SHIPPED changelog, which came from upstream. Doing so printed
    // `npx …github:acme/wafflestack#v0.12.0`, a ref acme's remote does not have: a refusal whose
    // `Run this instead:` command errors, which is the one thing this message must never do.
    // NOTE the fixture leaves `repository` as UPSTREAM's — the realistic fork, which inherited the
    // field and never rewrote it. Pre-editing it here (as this fixture once did) made the
    // "it asked the FORK" assertion below pass on the FIXTURE rather than on the code: it answered
    // the question before `repoSlug` was asked. The slug must come from `resolved`, i.e. provenance.
    const root = layout({
      resolved: `git+ssh://git@github.com/acme/wafflestack.git#${SHA_B}`,
      changelog: '# Changelog\n\n## [Unreleased]\n\n- fork work\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n',
    });
    const lsRemote = fakeLsRemote([]); // ls-remote ran fine; the remote simply has no release tags
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote });

    assert.deepEqual(lsRemote.calls, ['https://github.com/acme/wafflestack.git'], 'it asked the FORK, not upstream');
    assert.equal(id.status, 'unreleased');
    assert.equal(id.repo, 'acme/wafflestack');
    assert.equal(id.latestTag, null, "the shipped CHANGELOG says v0.12.0 — but that is UPSTREAM's tag, not acme's");

    const msg = formatUnreleasedRefusal(id, 'render');
    assert.doesNotMatch(msg, /#v0\.12\.0/, 'never name a ref the remote does not have');
    assert.doesNotMatch(msg, /#<latest release tag>/, 'nor a placeholder command that cannot resolve');
    // We LOOKED and there is nothing there, so the strong claim is licensed here — and only here.
    assert.match(msg, /acme\/wafflestack has no `vX\.Y\.Z` release tags/);
    assert.match(msg, /--allow-unreleased/, 'lead with the hatch — here it is the only path that works');
    // The warning printed by the ungated commands must not invent a pin either.
    assert.match(formatProvenanceWarning(id) ?? '', /cannot name a pin/);
  });

  test('a lookup that NEVER RAN must not claim the remote has no tags — hedge, do not assert', () => {
    // The same `latestTag: null` state, reached from ignorance instead of knowledge (#373 review).
    // `corroborate()` tightens to `unreleased` off the shipped changelog after `ls-remote` THREW, and
    // with no `## [X.Y.Z]` headings in that changelog there is no tag to name — but WE NEVER ASKED
    // THE REMOTE. Asserting "acme has no release tags" here is exactly the over-claim that was
    // rejected in round 1, and it is not harmless: it tells a fork's user that `--allow-unreleased`
    // is their only path, when a perfectly good release tag may exist that this run merely could not
    // see. `lookupError` is the discriminator, and it is already on the contract: null on exactly the
    // paths where a lookup ran and SUCCEEDED.
    const root = layout({
      resolved: `git+ssh://git@github.com/acme/wafflestack.git#${SHA_B}`,
      repository: 'github:acme/wafflestack',
      changelog: '# Changelog\n\n## [Unreleased]\n\n- fork work\n', // entries, but no release headings
    });
    const id = resolveToolkitIdentity({
      toolkitRoot: root,
      lsRemote: () => { throw new Error('Could not resolve host: github.com'); },
    });
    assert.equal(id.status, 'unreleased', 'the changelog corroborates it…');
    assert.equal(id.latestTag, null, '…but nothing can name a tag');
    assert.notEqual(id.lookupError, null, 'and THIS is what says we never looked');

    const msg = formatUnreleasedRefusal(id, 'render');
    assert.doesNotMatch(msg, /has no `vX\.Y\.Z` release tags/, 'we did not look — we cannot say that');
    assert.match(msg, /No `vX\.Y\.Z` release of acme\/wafflestack is known to this CLI/);
    assert.match(msg, /there may well be one to pin to that this run cannot see/);
    assert.match(msg, /--allow-unreleased/, 'the hatch is still offered — just not as the ONLY path');
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

  test('the sha and the slug are read from the SAME lockfile entry — one lookup, two callers', () => {
    // `commitFromNpmLockfile` (the sha) and `repoSlug` (the owner/repo) both need npm's hidden
    // lockfile, and they must never disagree about WHICH package entry they are reading. Two copies
    // of the key lookup is a divergence hazard: change the fallback key in one and the other keeps
    // the old behaviour silently. They now share one resolver, and this pins both ends of it.
    const root = layout({
      resolved: `git+ssh://git@github.com/acme/forked.git#${SHA_A}`,
      repository: null, // no usable `repository` field → the slug MUST come from the lockfile
    });
    assert.deepEqual(repoSlug({ toolkitRoot: root, pkg: { name: 'wafflestack' }, runGit: () => null }), { owner: 'acme', repo: 'forked' });
    assert.equal(commitFromNpmLockfile(root, 'wafflestack'), SHA_A);
    // …and the identity agrees with both, having asked the fork's own remote.
    const lsRemote = fakeLsRemote([`${SHA_A}\trefs/tags/v1.0.0`]);
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote });
    assert.equal(id.repo, 'acme/forked');
    assert.equal(id.commit, SHA_A);
    assert.equal(id.ref, 'github:acme/forked#v1.0.0');
    assert.deepEqual(lsRemote.calls, ['https://github.com/acme/forked.git']);
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

  test('an empty Keep-a-Changelog SCAFFOLD is not evidence either — it must not refuse a real release', () => {
    // The three shapes a release process routinely LEAVES BEHIND under `## [Unreleased]`. Reading
    // any of them as an entry lets `corroborate()` tighten a GENUINELY TAGGED release to
    // `unreleased` — and `unreleased` REFUSES. So a derivative whose release process leaves the
    // scaffold ships a real release whose own CHANGELOG testifies against it, and the first lookup
    // failure (git egress blocked while the registry is not — a common CI shape) hard-refuses a
    // correctly-pinned consumer. Bricking a legitimate consumer is NOT "wrong in the safe
    // direction"; the accepted false positive is a default branch that matches the tag, which is a
    // much more benign thing than a release.
    for (const scaffold of [
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n',
      '# Changelog\n\n## [Unreleased]\n\n_Nothing yet._\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n',
      '# Changelog\n\n## [Unreleased]\n\n<!-- add entries here -->\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n',
    ]) {
      const id = resolveToolkitIdentity({ toolkitRoot: npmLayout(scaffold), lsRemote: failedLookup });
      assert.equal(id.status, 'unverified', `a scaffold must fail OPEN, never refuse:\n${scaffold}`);
    }
  });

  test('a real entry UNDER a scaffold heading is still an entry — the guard must not go blind', () => {
    const id = resolveToolkitIdentity({
      toolkitRoot: npmLayout('# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- something on main\n\n## [0.12.0] - 2026-07-11\n'),
      lsRemote: failedLookup,
    });
    assert.equal(id.status, 'unreleased', 'stripping the scaffold must not strip what is under it');
  });

  test('an EMPHASIZED entry is an entry — stripping it would fail OPEN, which is #373 itself', () => {
    // The scaffold-stripper's dangerous edge. `**Breaking: …**` and `_Support for pnpm added._` are
    // real, substantive entries that happen to be emphasized. Eating them leaves `unverified`, and
    // `unverified` PROCEEDS — so an unpinned default-branch fetch would render straight into the
    // consumer's lock, which is the exact bug this whole PR exists to prevent. F8's defect was
    // fail-CLOSED (a recoverable refusal); its first fix traded it for fail-OPEN, which by this
    // module's own stated ordering is the strictly worse direction. Both edges are now pinned.
    for (const entry of ['**Breaking: render now refuses.**', '_Support for pnpm added._']) {
      const id = resolveToolkitIdentity({
        toolkitRoot: npmLayout(`# Changelog\n\n## [Unreleased]\n\n${entry}\n\n## [0.12.0] - 2026-07-11\n`),
        lsRemote: failedLookup,
      });
      assert.equal(id.status, 'unreleased', `an emphasized entry must still corroborate: ${entry}`);
    }
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
    // ── EDGE 1, fail-CLOSED: the SCAFFOLD a release leaves behind. None of these is an entry.
    // Reading one AS an entry refuses a genuine release (F8). Recoverable — the refusal names the
    // pin — but wrong.
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n### Added\n\n### Fixed\n'), false, 'empty sub-headings');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n_Nothing yet._\n'), false, 'emphasis-only placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n**No changes.**\n'), false, 'bold placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n*None.*\n'), false);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n_TBD_\n'), false);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n<!-- add entries\n     here -->\n'), false, 'HTML comment, even across lines');

    // ── EDGE 2, fail-OPEN: THE DANGEROUS DIRECTION — and the one the F8 fix itself got wrong (F11).
    // Missing a real entry leaves `unverified`, which PROCEEDS: a default branch renders into a
    // consumer's lock, silently. That is issue #373, reintroduced through the back door. An
    // emphasized line is an ENTRY unless its WORDS say otherwise — the filter keys on placeholder
    // vocabulary, never on emphasis, because shape is the vocabulary of entries.
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n### Added\n\n**Breaking: render now refuses.**\n'), true, 'a BOLD entry is still an entry');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n_Support for pnpm added._\n'), true, 'an ITALIC entry is still an entry');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n**Nothing is broken by this release.**\n'), true, 'opens with "Nothing" — but it is prose, not a placeholder');
    // …and everything that always was an entry still reads as one.
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n### Added\n\n- a real entry\n'), true, 'an entry under a sub-heading');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n* an asterisk bullet\n'), true, 'a bullet is not a placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n* a *bold* asterisk bullet\n'), true);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n- **Fixed** a thing (#1)\n'), true);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\nprose, no bullet\n'), true);
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

  test('with NO release tag known, it says so — it does not print a command that cannot resolve', () => {
    // This used to print `npx …#<latest release tag> render`, a shaped placeholder, on the theory
    // that a shape beats a dead end. It does not: a `Run this instead:` block whose command errors
    // is worse than the refusal it decorates, and the whole justification for failing closed is that
    // the message hands back something that WORKS. When there is no release to pin to, the only
    // command that works is the hatch — so lead with it and say plainly why.
    // `lookupError: null` + `origin: 'npm-install'` on this fixture ⇒ the lookup RAN and succeeded,
    // so the strong claim is licensed. (The hedged twin is pinned in the npm-install suite above.)
    const msg = formatUnreleasedRefusal({ ...unreleased, latestTag: null }, 'render');
    assert.doesNotMatch(msg, /#<latest release tag>/);
    assert.match(msg, /latest release: none known for dustinkeeton\/wafflestack/);
    assert.match(msg, /dustinkeeton\/wafflestack has no `vX\.Y\.Z` release tags/);
    assert.match(msg, /npx --yes github:dustinkeeton\/wafflestack render --allow-unreleased/);
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

  test('an UNRELEASED CLI prints the pinned command, not the bare `upgrade` that resolves main', () => {
    // #372's "self-defeating remedy": doctor said "run `wafflestack upgrade`", which for most
    // people IS the unpinned `npx github:…` — the command that fetches the default branch, and the
    // one the gate now refuses. Sending the reader there would be handing them a loop.
    const out = notes(identityAt('unreleased'));
    assert.match(out, /version skew/);
    assert.match(out, /npx --yes github:dustinkeeton\/wafflestack#v0\.12\.0 upgrade/);
    assert.match(out, /a bare `upgrade` re-fetches the default branch/, 'say what is TRUE of a bare upgrade…');
    assert.doesNotMatch(out, /would refuse/, '…not a prediction about the gate, which this note cannot make');
  });

  test('THE NOTE MUST NOT PREDICT THE GATE — a release-pinned npx install is told no such thing', () => {
    // The note reasons from the identity plain `doctor` is handed, which is the OFFLINE one — and
    // offline, an npx install can NEVER reach `release`: the lookup is short-circuited (`noNetwork`)
    // and `corroborate()` only ever tightens toward `unreleased`. So this fixture — a consumer
    // pinned at an exact release tag, the most common shape there is — reports `unverified`.
    //
    // Meanwhile `requireRelease()` refuses ONLY on `unreleased`, and it resolves its OWN networked
    // identity, which classifies this very commit as `release` and proceeds. The old text said
    // "this CLI is unverified, so a bare `upgrade` would refuse": false in both directions at once.
    // An offline status is structurally incapable of predicting what the gate will do — so the note
    // states what the CLI IS, and lets the gate speak for itself.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-skew-npx-'));
    try {
      const root = path.join(tmp, 'node_modules', 'wafflestack');
      write(root, 'package.json', JSON.stringify({ name: 'wafflestack', version: '0.12.0', repository: 'github:dustinkeeton/wafflestack' }));
      // A RELEASE's changelog: `## [Unreleased]` stamped down, nothing under it.
      write(root, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n');
      write(tmp, 'node_modules/.package-lock.json', JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/wafflestack': { resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${SHA_A}` } },
      }));

      // Exactly what cli.mjs's `offlineIdentity()` builds for plain `doctor` — the shipped,
      // unpinned-by-default check every consumer runs on every PR.
      const offline = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork, offline: true });
      assert.equal(offline.status, 'unverified', 'the offline path cannot see the tag — that IS the design');
      // …and the same commit, classified WITH the network (what the gate does), is a release:
      const networked = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`]) });
      assert.equal(networked.status, 'release', 'so `upgrade` would PROCEED, not refuse');

      const out = notes(offline);
      assert.match(out, /version skew/);
      assert.doesNotMatch(out, /would refuse/, 'the gate does not refuse an `unverified` CLI — it warns and proceeds');
      assert.match(out, /npx --yes github:dustinkeeton\/wafflestack#v0\.12\.0 upgrade/, 'the pinned command is still the right advice');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a RELEASE CLI (and an absent identity) keep the remedy exactly as it always read', () => {
    assert.match(notes(identityAt('release')), /version skew — run `wafflestack upgrade`/);
    assert.match(notes(null), /version skew — run `wafflestack upgrade`/);
  });
});
