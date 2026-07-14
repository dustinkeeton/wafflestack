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
  toolkitSource,
  toolkitLockEntry,
  toolkitPinFromLock,
  describeToolkitProvenance,
  repoSlug,
  lockRepoSlug,
  parseRepoSlug,
  httpsUrl,
  changelogHasUnreleasedEntries,
  changelogLatestRelease,
  formatUnreleasedRefusal,
  formatProvenanceWarning,
} from '../lib/toolkit-ref.mjs';
import { renderProject } from '../lib/render.mjs';
import { upgrade, diffToolkit } from '../lib/upgrade.mjs';
import { doctor } from '../lib/doctor.mjs';
import { reinstall } from '../lib/uninstall.mjs';
import { eject } from '../lib/eject.mjs';

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

  test('lockRepoSlug asks the LOCK\'s question — the pin, never `remote.origin.url` (#384 F2)', () => {
    // `repoSlug` answers "which remote do I ASK about tags?" — origin-first, and right (#373 F14).
    // The LOCK asks a different question: "which toolkit is this, GIVEN THE PIN?" On a checkout,
    // `origin` is a property of the clone the renderer happened to use — not of the pin, the commit,
    // or the rendered bytes — and it must never reach a committed artifact (#317).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-lockslug-'));
    try {
      const pkg = { name: 'wafflestack', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } };
      const fork = () => 'git@github.com:contributor/wafflestack.git';
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });

      // THE DIVERGENCE, on one line: same checkout, same bytes, two different questions.
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: fork }), { owner: 'contributor', repo: 'wafflestack' });
      assert.deepEqual(lockRepoSlug({ toolkitRoot: root, pkg }), { owner: 'dustinkeeton', repo: 'wafflestack' });

      // It takes no `runGit` AT ALL — the origin step cannot be reached even by accident.
      assert.equal(lockRepoSlug.length, 1, 'one arg: there is no git seam to consult');

      // #373 F14 is carried entirely by step 1, which `lockRepoSlug` KEEPS: npm's `resolved` is not
      // machine state, it is the pin the operator typed. `npx github:acme/wafflestack#v1.0.0`
      // resolves to acme on every machine — so a fork still names ITSELF in its own lock. (And an
      // npm-installed toolkit has no `.git`, which is why removing the origin step cannot regress
      // the npx path: it never ran there.)
      const npm = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-lockslug-npm-'));
      try {
        // The real npx layout: the toolkit lives INSIDE node_modules, beside the hidden lockfile.
        const installed = path.join(npm, 'node_modules/wafflestack');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(
          path.join(npm, 'node_modules/.package-lock.json'),
          JSON.stringify({ packages: { 'node_modules/wafflestack': { resolved: `git+ssh://git@github.com/acme/wafflestack.git#${SHA_A}` } } }),
        );
        assert.deepEqual(lockRepoSlug({ toolkitRoot: installed, pkg }), { owner: 'acme', repo: 'wafflestack' }, 'the fork names itself');
      } finally {
        fs.rmSync(npm, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolveToolkitIdentity: the reviewer\'s repro — two clones, one commit, one lock block (#384 F2)', () => {
    // The live path, end to end, stubbing ONLY `runGit` (the module's own injection seam) exactly as
    // the review did. Everything else is real: a checkout, an untagged HEAD, a declared `repository`.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-clone-'));
    try {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'wafflestack', version: '0.12.0', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } }),
      );
      const clone = (originUrl) => (_cwd, args) => {
        if (args[0] === 'config') return originUrl;
        if (args[0] === 'rev-parse') return SHA_A; // the SAME commit in both clones
        if (args[0] === 'describe') return null; // untagged → unreleased
        return null;
      };
      const blockFor = (originUrl) =>
        toolkitLockEntry(
          resolveToolkitIdentity({ toolkitRoot: root, runGit: clone(originUrl), allowUnreleased: true }),
          { toolkitVersion: '0.12.0' },
        );

      const upstream = blockFor('https://github.com/dustinkeeton/wafflestack.git');
      const forked = blockFor('git@github.com:contributor/wafflestack.git');

      assert.deepEqual(forked, upstream, 'the committed lock cannot depend on which clone rendered it');
      assert.equal(upstream.source, 'github:dustinkeeton/wafflestack');
      // …while the value the NETWORK path needs still tracks the clone in hand (#373 F14 intact).
      assert.equal(resolveToolkitIdentity({ toolkitRoot: root, runGit: clone('git@github.com:contributor/wafflestack.git'), allowUnreleased: true }).repo, 'contributor/wafflestack');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a checkout on a RELEASE TAG asks NO remote — so its `source` cannot be the clone (#384 F11)', () => {
    // The counted stub is the whole point. The `release` carve-out was justified by "`ls-remote` asked
    // THAT remote"; this proves no remote is asked at all on a checkout — `git describe --exact-match`
    // decides it offline and `resolveToolkitIdentity` returns before the lookup. An unverified value
    // must not reach a committed artifact, so the lock records the declared repo here as well.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-relclone-'));
    try {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'wafflestack', version: '0.12.0', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } }),
      );
      let lsRemoteCalls = 0;
      const lsRemote = () => {
        lsRemoteCalls++;
        return '';
      };
      const clone = (originUrl) => (_cwd, args) => {
        if (args[0] === 'config') return originUrl;
        if (args[0] === 'rev-parse') return SHA_A; // the SAME commit…
        if (args[0] === 'describe') return 'v0.12.0'; // …sitting on the SAME release tag
        if (args[0] === 'tag') return 'v0.12.0';
        return null;
      };
      const blockFor = (originUrl) => {
        const id = resolveToolkitIdentity({ toolkitRoot: root, runGit: clone(originUrl), lsRemote });
        assert.equal(id.status, 'release', 'a clean checkout on a release tag IS a release…');
        assert.equal(id.origin, 'checkout');
        return toolkitLockEntry(id, { toolkitVersion: '0.12.0' });
      };

      const upstream = blockFor('https://github.com/dustinkeeton/wafflestack.git');
      const forked = blockFor('git@github.com:contributor/wafflestack.git');

      assert.equal(lsRemoteCalls, 0, '…decided with ZERO ls-remote calls: nothing was corroborated');
      assert.deepEqual(forked, upstream, 'so two clones of one tagged commit write a byte-identical lock');
      assert.equal(upstream.source, 'github:dustinkeeton/wafflestack');
      assert.equal(upstream.commit, SHA_A);
      assert.equal(upstream.ref, 'v0.12.0', 'the release block is still fully recorded');
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

      // …and #374 lands it in the lock. `toolkitVersion` is untouched — the block ADDS identity, it
      // replaces nothing (it is still `upgrade`'s migration baseline and `list`'s skew signal).
      const lock = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
      assert.equal(lock.toolkitVersion, '0.0.test');
      assert.equal(lock.toolkit.ref, 'v0.12.0', 'the PIN, not the npx spec — `sources[].ref` shape');
      assert.equal(lock.toolkit.commit, SHA_A);

      // Absent, everything behaves exactly as it always did (evals.mjs and most tests render this way).
      const bare = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
      assert.equal(bare.ok, true);
      assert.equal(bare.identity, null);
      assert.equal(bare.toolkit, null);
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

// ═════════════════════════════════════════════════════════════════════════════
// #374 — THE LOCK RECORDS WHICH TOOLKIT PRODUCED THE RENDER
//
// `toolkitVersion: "0.12.0"` does not identify content: the default branch and the tag 74 commits
// behind it both carry that string. So the lock gains a top-level `toolkit` block, keyed exactly
// like a `sources[]` entry (the external-stack prior art, #125) plus a `status` field `sources`
// cannot need — because an external source's `ref` is AUTHORED and mandatory, while the built-in
// toolkit's is DISCOVERED at runtime, so a null there is ambiguous without a reason attached.
//
// Two invariants carry the whole design, and both are load-bearing enough to be stated here:
//
//   1. **NO FIELD IS A FUNCTION OF A MOVING HEAD.** `commit` is recorded IF AND ONLY IF
//      `status === 'release'`. A HEAD-derived SHA in a self-rendering repo's committed lock is
//      self-referential (it names the commit BEFORE the one containing it), false whenever the tree
//      is dirty, and would churn the lock on every single commit — reddening the documented
//      `render` + `git diff --exit-code` recipe forever, for a change that moved no rendered byte.
//   2. **DOCTOR'S CHECK IS A WARNING.** `doctor.toolkitRef` ships UNPINNED and `waffle-doctor.yml`
//      runs on every consumer PR, so an error would red the entire install base the moment anything
//      merges to this repo's `main` — and it would catch only mismatches whose rendered bytes are
//      identical, i.e. ones that provably did not matter. `--verify-render` is the content gate.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A synthetic release identity — the shape `resolveToolkitIdentity` hands back.
 *
 * `lockRepo` is deliberately ABSENT from the defaults, and `origin` is `npm-install`: there, `repo`
 * and `lockRepo` are computed from the same npm `resolved` URL and are always identical (`repoSlug`'s
 * origin step is `.git`-gated), so a fixture that overrides `repo` alone still models a real npx
 * toolkit — a fork's `repo: 'acme/…'` records acme, as it must (#373 F14). Defaulting `lockRepo` to
 * upstream would silently bake upstream's slug into every such fixture, which is the very failure F14
 * exists to stop. A CHECKOUT fixture is the one that must state both (see `unreleasedIdentity`).
 */
const releaseIdentity = (over = {}) => /** @type {any} */ ({
  status: 'release',
  version: '0.12.0',
  commit: SHA_A,
  tag: 'v0.12.0',
  ref: 'github:dustinkeeton/wafflestack#v0.12.0',
  origin: 'npm-install',
  repo: 'dustinkeeton/wafflestack',
  latestTag: 'v0.12.0',
  lookupError: null,
  ...over,
});

/**
 * The same, for a toolkit that is provably NOT a release — no tag, no ref, but a real commit.
 *
 * A checkout, so it states BOTH slugs: this is the one origin where they can differ (`repoSlug` reads
 * `remote.origin.url` only when `.git` exists), and a real checkout of a toolkit that declares
 * `repository` — as this one does — resolves `lockRepo` from it. Tests that model a divergent clone
 * pass the two explicitly; the one that models a toolkit declaring NO `repository` drops `lockRepo`.
 */
const unreleasedIdentity = (over = {}) =>
  releaseIdentity({ status: 'unreleased', tag: null, ref: null, origin: 'checkout', lockRepo: 'dustinkeeton/wafflestack', ...over });

/** …and for one we could not classify (a blip, the hatch, a `dlx` install — #383). */
const unverifiedIdentity = (over = {}) =>
  releaseIdentity({ status: 'unverified', tag: null, ref: null, lookupError: 'lookup skipped', ...over });

const RELEASE_BLOCK = {
  source: 'github:dustinkeeton/wafflestack',
  sourceType: 'git',
  ref: 'v0.12.0',
  commit: SHA_A,
  status: 'release',
};

// ─────────────────────────────────────────────────────────────────────────────
// The shape, unit-tested against synthetic identities — no git, no network, no render.
// ─────────────────────────────────────────────────────────────────────────────

describe('toolkitLockEntry — the block\'s shape (#374)', () => {
  test('a RELEASE identity records the full block: source, pinned ref, and the commit', () => {
    assert.deepEqual(toolkitLockEntry(releaseIdentity()), RELEASE_BLOCK);
  });

  test('an UNRELEASED identity records nulls and a status that says WHY — never HEAD\'s sha', () => {
    // The identity HAS a commit (a checkout always knows its HEAD). The block still records null:
    // that SHA does not identify what rendered (the tree may be dirty, and in this repo it is dirty
    // by definition — rendering uncommitted stacks/** edits is the point of a local render).
    const identity = unreleasedIdentity({ commit: SHA_A });
    assert.equal(identity.commit, SHA_A, 'the identity knows HEAD…');
    assert.deepEqual(toolkitLockEntry(identity), {
      source: 'github:dustinkeeton/wafflestack',
      sourceType: 'git',
      ref: null,
      commit: null, // …and the lock deliberately does not record it
      status: 'unreleased',
    });
  });

  test('an UNVERIFIED identity with no prior lock records nulls and says `unverified`', () => {
    assert.deepEqual(toolkitLockEntry(unverifiedIdentity()), {
      source: 'github:dustinkeeton/wafflestack',
      sourceType: 'git',
      ref: null,
      commit: null,
      status: 'unverified',
    });
  });

  test('NO identity → NO block. The library caller\'s lock is byte-identical to the pre-#374 shape', () => {
    // ~50 existing `renderProject({ toolkitVersion: '0.0.test' })` call sites, plus evals.mjs, pass
    // no identity. Omitting the block is what keeps every one of them green — and it is honest: a
    // block asserting provenance nobody supplied would be a lie.
    assert.equal(toolkitLockEntry(null), null);
  });

  test('a release whose repo slug is unknowable records source: null — and no pin can be built', () => {
    // #373's contract, verbatim: `status: 'release'` does NOT imply a non-null ref. A bare clone with
    // no `origin`, no npm lockfile and no `repository` field is a release nobody can name.
    const entry = toolkitLockEntry(releaseIdentity({ repo: null, ref: null }));
    assert.deepEqual(entry, { source: null, sourceType: 'git', ref: 'v0.12.0', commit: SHA_A, status: 'release' });
    assert.equal(toolkitPinFromLock({ toolkit: entry }), null, 'no slug → no reproducible npx spec');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The `unverified` carry-forward — the fix for the one real compat hazard.
// ─────────────────────────────────────────────────────────────────────────────

describe('the `unverified` carry-forward (#374)', () => {
  const FILES = { 'a.md': 'hash-a', 'b.md': 'hash-b' };
  const prevLock = { toolkitVersion: '0.12.0', toolkit: RELEASE_BLOCK, files: FILES };

  test('a network blip does NOT churn a good release block to nulls', () => {
    // Without this, an `unverified` render (a GitHub blip, a proxy, the hatch, a `dlx` install)
    // would rewrite a full release block to nulls — so two teammates on the SAME pinned toolkit
    // commit two different locks, and the documented `render` + `git diff --exit-code` CI gate goes
    // red with no content change anywhere.
    const entry = toolkitLockEntry(unverifiedIdentity(), {
      prevLock,
      newFiles: { ...FILES },
      toolkitVersion: '0.12.0',
    });
    // #384 F9: the guarantee is REPRODUCIBILITY, not attribution. The recorded toolkit still produces
    // these exact bytes — it is not a claim that it is the toolkit that PERFORMED this render (an
    // unverified CLI knows its own commit; it just could not classify it). Keep the block for the
    // former, and do not let the assertion message promise the latter.
    assert.deepEqual(entry, RELEASE_BLOCK, 'the recorded toolkit still reproduces these exact bytes — keep it');
  });

  test('the carry-forward\'s guarantee is REPRODUCIBILITY, not attribution (#384 F9)', () => {
    // The doc used to promise the carried-forward block is "still exactly true". It is not: this
    // render was performed at commit B, and the block it writes names commit A. That is CORRECT
    // behavior — A still reproduces these bytes, and churning to nulls on a blip is the bug this
    // guards — but the claim had to be narrowed to what actually holds. This test pins the gap the
    // doc now describes, so nobody "fixes" the behavior to match the old, wrong sentence.
    const ranAtB = unverifiedIdentity({ commit: SHA_B }); // an unverified CLI KNOWS its own commit
    const entry = toolkitLockEntry(ranAtB, { prevLock, newFiles: { ...FILES }, toolkitVersion: '0.12.0' });
    assert.equal(entry.commit, SHA_A, 'the block names A…');
    assert.equal(ranAtB.commit, SHA_B, '…while B is what actually rendered');
    assert.equal(entry.status, 'release', 'and the good block is preserved, which is the point');
  });

  test('…but only when it asserts NOTHING NEW: different content rewrites the block honestly', () => {
    // The carry-forward is airtight, not a guess: it fires only when the freshly rendered bytes are
    // IDENTICAL to the bytes the recorded provenance already describes. Move a byte and the old
    // block would be a claim about content that no longer exists.
    const entry = toolkitLockEntry(unverifiedIdentity(), {
      prevLock,
      newFiles: { ...FILES, 'b.md': 'hash-b-CHANGED' },
      toolkitVersion: '0.12.0',
    });
    assert.equal(entry.status, 'unverified');
    assert.equal(entry.commit, null);
  });

  test('…and only at the SAME version: a version move rewrites the block honestly', () => {
    const entry = toolkitLockEntry(unverifiedIdentity({ version: '0.13.0' }), {
      prevLock,
      newFiles: { ...FILES },
      toolkitVersion: '0.13.0', // the lock says 0.12.0 — different toolkit, so different provenance
    });
    assert.equal(entry.status, 'unverified');
    assert.equal(entry.commit, null);
  });

  test('an added or removed file is caught even when every surviving hash matches', () => {
    // `sameFiles` must compare the key SETS, not just the shared keys — a subset would carry a
    // release block forward across a render that added or dropped an output.
    const added = toolkitLockEntry(unverifiedIdentity(), {
      prevLock,
      newFiles: { ...FILES, 'c.md': 'hash-c' },
      toolkitVersion: '0.12.0',
    });
    assert.equal(added.commit, null, 'an added file is a content move');
    const removed = toolkitLockEntry(unverifiedIdentity(), {
      prevLock,
      newFiles: { 'a.md': 'hash-a' },
      toolkitVersion: '0.12.0',
    });
    assert.equal(removed.commit, null, 'a removed file is a content move');
  });

  test('UNRELEASED never carries forward — it is a POSITIVE determination, not an absence', () => {
    // Two people rendering the same unreleased toolkit compute the same nulls offline, so there is
    // nothing to protect. Carrying forward here would preserve a release block for a render that
    // provably was NOT that release.
    const entry = toolkitLockEntry(unreleasedIdentity(), {
      prevLock,
      newFiles: { ...FILES },
      toolkitVersion: '0.12.0',
    });
    assert.equal(entry.status, 'unreleased');
    assert.equal(entry.commit, null, 'a KNOWN non-release must never inherit a release SHA');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #372's read-back. The triple equality IS the contract, and it stops the lock's pin format and
// `toolkitRef()`'s from drifting apart.
// ─────────────────────────────────────────────────────────────────────────────

describe('toolkitPinFromLock — #372 reads the pin back out (#374)', () => {
  test('THE TRIPLE EQUALITY: lock pin === toolkitRef(slug, tag) === identity.ref', () => {
    const slug = { owner: 'dustinkeeton', repo: 'wafflestack' };
    const identity = releaseIdentity();
    const lock = { toolkitVersion: '0.12.0', toolkit: toolkitLockEntry(identity) };

    assert.equal(toolkitPinFromLock(lock), 'github:dustinkeeton/wafflestack#v0.12.0');
    assert.equal(toolkitPinFromLock(lock), toolkitRef(slug, 'v0.12.0'));
    assert.equal(toolkitPinFromLock(lock), identity.ref);
    // …and it is a spec `npx` accepts: base + '#' + pin, with the pin held separately in the lock
    // exactly as `sources[].ref` holds an external stack's.
    assert.equal(`${toolkitSource(identity.repo)}#${lock.toolkit.ref}`, identity.ref);
  });

  test('a non-release lock, and a lock predating the block, both yield null — never a guess', () => {
    assert.equal(toolkitPinFromLock({ toolkit: toolkitLockEntry(unreleasedIdentity()) }), null);
    assert.equal(toolkitPinFromLock({ toolkit: toolkitLockEntry(unverifiedIdentity()) }), null);
    assert.equal(toolkitPinFromLock({ toolkitVersion: '0.12.0', files: {} }), null, 'a pre-#374 lock');
    assert.equal(toolkitPinFromLock(null), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The lock, written for real — including THE ANTI-CHURN TEST, the non-negotiable regression guard.
// ─────────────────────────────────────────────────────────────────────────────

describe('the lock records the toolkit that produced the render (#374)', () => {
  let toolkitRoot;
  let cwd;
  const lockPath = () => path.join(cwd, '.waffle/waffle.lock.json');
  const readLockJson = () => JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  const lockBytes = () => fs.readFileSync(lockPath(), 'utf8');

  const writeToolkit = (body = 'body') => {
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
    write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
    write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', `---\nname: alpha\ndescription: Alpha.\n---\n\n${body}\n`);
  };

  const render = (toolkitIdentity, toolkitVersion = '0.12.0') =>
    renderProject({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity });

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-project-'));
    writeToolkit();
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  test('a RELEASE render records source + pinned ref + commit, and leaves toolkitVersion alone', () => {
    const result = render(releaseIdentity());
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const lock = readLockJson();
    assert.deepEqual(lock.toolkit, RELEASE_BLOCK);
    // The block ADDS identity; it replaces nothing. `toolkitVersion` is still `upgrade`'s migration
    // baseline and `list`'s skew signal, and no existing reader changes behavior.
    assert.equal(lock.toolkitVersion, '0.12.0');
    // …and the render surfaces the block it wrote, which is what `upgrade` diffs against.
    assert.deepEqual(result.toolkit, RELEASE_BLOCK);
    // Placement: immediately after `toolkitVersion`, before `targets`.
    assert.deepEqual(Object.keys(lock).slice(0, 3), ['toolkitVersion', 'toolkit', 'targets']);
  });

  test('an UNRELEASED render records `{ ref: null, commit: null, status: "unreleased" }`', () => {
    // This is THIS REPO's own lock, on every render, forever: an untagged checkout of the toolkit.
    assert.equal(render(unreleasedIdentity()).ok, true);
    assert.deepEqual(readLockJson().toolkit, {
      source: 'github:dustinkeeton/wafflestack',
      sourceType: 'git',
      ref: null,
      commit: null,
      status: 'unreleased',
    });
  });

  test('NO identity → the lock has NO `toolkit` key at all (the pre-#374 shape, byte for byte)', () => {
    assert.equal(renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' }).ok, true);
    assert.equal('toolkit' in readLockJson(), false);
  });

  test('THE ANTI-CHURN TEST — two unreleased toolkits, different commits, BYTE-IDENTICAL lock', () => {
    // THE non-negotiable regression guard. If a future change ever records HEAD's sha for a checkout
    // render, this test fails — and it must, because that lock would churn on every single commit to
    // `main`, conflict on every long-lived branch, and permanently red the documented
    // `render` + `git diff --exit-code .waffle/waffle.lock.json` recipe for a no-op change.
    //
    // The two identities differ in the ONE field a naive implementation would reach for.
    assert.equal(render(unreleasedIdentity({ commit: SHA_A })).ok, true);
    const first = lockBytes();
    assert.equal(render(unreleasedIdentity({ commit: SHA_B })).ok, true);
    const second = lockBytes();
    assert.equal(first, second, 'a moving HEAD must not move a single byte of the lock');
    assert.equal(JSON.parse(second).toolkit.commit, null);
  });

  test('THE DETERMINISM TEST — two clones, different `origin`, BYTE-IDENTICAL lock (#384 F2)', () => {
    // THE ANTI-CHURN TEST's sibling, and the gap it structurally could not see: it varies `commit`,
    // so a moving value that arrives through `repo` sails straight past it.
    //
    // `identity.repo` is origin-first (#373 F14) — correct for "which remote do I ASK about tags",
    // and machine state on a checkout. Two contributors on the SAME commit rendering the SAME bytes
    // (one cloned upstream, one cloned their fork) wrote different `source` values into the COMMITTED
    // lock, churning it back and forth and redding `render` + `git diff --exit-code` for a change
    // that moved no rendered byte. `lockRepo` is the pin-derived answer, and it is what the lock
    // records.
    const upstreamClone = unreleasedIdentity({ repo: 'dustinkeeton/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });
    const forkClone = unreleasedIdentity({ repo: 'contributor/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });

    assert.equal(render(upstreamClone).ok, true);
    const first = lockBytes();
    assert.equal(render(forkClone).ok, true);
    const second = lockBytes();

    assert.equal(first, second, 'the renderer\'s clone must not move a single byte of the lock');
    assert.equal(JSON.parse(second).toolkit.source, 'github:dustinkeeton/wafflestack');
  });

  test('a RELEASE is NOT an exception — the checkout path is deterministic too (#384 F11)', () => {
    // This test previously asserted the OPPOSITE, and it pinned a bug. F2's first fix carved `release`
    // out of the rule "the lock records the pin, not the clone", on the reasoning that `identity.repo`
    // had been "corroborated" by `ls-remote`. On a CHECKOUT that is false: `release` is decided offline
    // by `git describe --exact-match` and the function returns before any lookup — ZERO ls-remote calls
    // (pinned directly in the `resolveToolkitIdentity` suite). So the carve-out let a clean checkout on
    // a release tag write the CLONE'S origin into the committed lock: same commit, same tag, same
    // bytes, byte-DIFFERENT locks.
    //
    // `repo` and `lockRepo` can only differ on a checkout (the origin step is gated on `.git`), and
    // there nothing is verified. So there is no status for which `repo` is the right answer.
    const fromUpstreamClone = releaseIdentity({ repo: 'dustinkeeton/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });
    const fromForkClone = releaseIdentity({ repo: 'contributor/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });

    assert.equal(render(fromUpstreamClone).ok, true);
    const first = lockBytes();
    assert.equal(render(fromForkClone).ok, true);
    const second = lockBytes();

    assert.equal(first, second, 'a release checkout must not record the clone either');
    assert.deepEqual(JSON.parse(second).toolkit, RELEASE_BLOCK);
  });

  test('…and #373 F14 still holds where it actually lives: the NPX path names the fork', () => {
    // The direction a naive fix breaks — a fork must name ITSELF — but pinned on the path F14 is
    // about. On npm/npx there is no `.git`, so `repoSlug`'s origin step cannot fire and BOTH slugs are
    // computed from npm's `resolved` URL: `repo === lockRepo === acme`. `resolved` is not machine
    // state, it is the pin the operator typed (`npx github:acme/wafflestack#v1.0.0`), so the fork's
    // lock names the fork on every machine — deterministic AND self-naming, no exception needed.
    const forkViaNpx = releaseIdentity({
      origin: 'npm-install',
      repo: 'acme/wafflestack',
      lockRepo: 'acme/wafflestack', // what resolveToolkitIdentity computes: both from `resolved`
      ref: 'github:acme/wafflestack#v0.12.0',
    });
    assert.equal(render(forkViaNpx).ok, true);
    const block = readLockJson().toolkit;
    assert.equal(block.source, 'github:acme/wafflestack', 'the fork names ITSELF, not upstream');
    assert.equal(toolkitPinFromLock({ toolkit: block }), 'github:acme/wafflestack#v0.12.0', 'and the pin reproduces the fork');
  });

  test('the FALLBACK cannot reopen the hole: an unknown repo is recorded as unknown, never as the clone (#384 F11)', () => {
    // `lockSourceRepo`'s tail (`?? identity.repo`) is where the fix could have leaked straight back
    // out. A toolkit checkout whose `package.json` declares NO `repository` has `lockRepo: null` and
    // `repo:` whatever `remote.origin.url` said — so an ungated fallback writes the CLONE into the
    // committed lock, which is F11 again through a side door. The tail is therefore gated on the same
    // fact that makes it safe elsewhere: `repoSlug`'s origin step is `.git`-gated, so on npm-install
    // `repo` IS the pin-derived slug (the test above depends on that), and on a checkout it is not.
    //
    // The honest answer is `null` — "an unknown toolkit", which `toolkitPinFromLock` already declines
    // to pin. Determinism is preserved by recording nothing, not by recording a guess.
    const upstreamClone = unreleasedIdentity({ repo: 'dustinkeeton/wafflestack', lockRepo: null });
    const forkClone = unreleasedIdentity({ repo: 'contributor/wafflestack', lockRepo: null });

    assert.equal(render(upstreamClone).ok, true);
    const first = lockBytes();
    assert.equal(render(forkClone).ok, true);
    const second = lockBytes();

    assert.equal(first, second, 'two clones, no declared repository — still one lock');
    assert.equal(JSON.parse(second).toolkit.source, null, 'and it says UNKNOWN, not `contributor`');
    assert.equal(toolkitPinFromLock(JSON.parse(second)), null, 'an unknown source pins nothing, honestly');
  });

  test('carry-forward, end to end: a blip after a release render preserves the release block', () => {
    assert.equal(render(releaseIdentity()).ok, true);
    const afterRelease = lockBytes();
    // Same toolkit, same content — but this run could not reach GitHub.
    assert.equal(render(unverifiedIdentity()).ok, true);
    assert.equal(lockBytes(), afterRelease, 'the lock does not move: the old provenance is still true');
    assert.deepEqual(readLockJson().toolkit, RELEASE_BLOCK);
  });

  test('…and content that actually moved rewrites the block to honest nulls', () => {
    assert.equal(render(releaseIdentity()).ok, true);
    writeToolkit('DIFFERENT BODY'); // the toolkit's content changed under us
    assert.equal(render(unverifiedIdentity()).ok, true);
    const lock = readLockJson();
    assert.equal(lock.toolkit.status, 'unverified');
    assert.equal(lock.toolkit.commit, null, 'the release block described bytes that no longer exist');
  });

  test('backward compat: a lock with no `toolkit` block doctors CLEAN, with a note (mirrors #125)', () => {
    // The prior art, pinned: `installer.test.mjs` — "a lock with no `sources` block doctors clean".
    // Additive key + tolerant readers, no lock-format version bump, no migration.
    assert.equal(render(releaseIdentity()).ok, true);
    const lock = readLockJson();
    delete lock.toolkit;
    fs.writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`);

    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    assert.equal(dr.ok, true, JSON.stringify(dr.notes));
    assert.equal(dr.toolkitProvenance.status, 'not-recorded');
    assert.match(dr.notes.join('\n'), /records no toolkit provenance/);
  });

  test('eject round-trips the block — it survives an operation that rewrites the lock', () => {
    assert.equal(render(releaseIdentity()).ok, true);
    eject({ cwd, item: 'skills/alpha' });
    assert.deepEqual(readLockJson().toolkit, RELEASE_BLOCK, 'eject rewrites `files`, and preserves the rest');
  });

  test('reinstall preserves the block — an un-threaded caller would silently strip it', () => {
    assert.equal(render(releaseIdentity()).ok, true);
    const result = reinstall({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(readLockJson().toolkit, RELEASE_BLOCK);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// doctor: the headline capability — and the four ways it must NOT go red.
// ─────────────────────────────────────────────────────────────────────────────

describe('doctor reports the toolkit that produced the render, and WARNS on a mismatch (#374)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-dr-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-dr-project-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
    write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
    write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nbody\n');
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  test('NO LOCK: `toolkitProvenance` is part of the RETURN SHAPE — reading it must not throw (#384 F5)', () => {
    // The no-lock early return omitted the key entirely, so `doctor(…).toolkitProvenance.status` —
    // which #372 is specced to read — threw a TypeError on a repo that has never rendered. A field
    // that exists only on the happy path is not a contract; every consumer would need a guard the
    // docs never mention. `not-recorded` is the honest status: no lock records no provenance.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-nolock-'));
    try {
      const dr = doctor({ cwd: fresh, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
      assert.equal(dr.ok, false);
      assert.equal(dr.toolkitProvenance.status, 'not-recorded', 'the field is THERE, and it is honest');
      assert.deepEqual(dr.toolkitProvenance.notes, [], 'and it adds no note — `notes` already says the lock is missing');
      assert.match(dr.notes.join('\n'), /not found/);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('a matching release reads back as a match, naming the pin and the commit', () => {
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity(), toolkitRoot });
    assert.equal(dr.ok, true);
    assert.equal(dr.toolkitProvenance.status, 'match');
    assert.match(dr.notes.join('\n'), /github:dustinkeeton\/wafflestack#v0\.12\.0 @ aaaaaaaaaaaa.*matches this CLI/);
  });

  test('THE CONSUMER-SAFETY TEST: a provenance mismatch is a WARNING — `ok` stays TRUE', () => {
    // If this ever flips to false, EVERY consumer's required `waffle-doctor` check goes red the
    // moment anything merges to this repo's `main`: `doctor.toolkitRef` ships UNPINNED by default
    // (stacks/github-workflow/stack.yaml) and `waffle-doctor.yml` runs on every consumer PR, so that
    // CLI's commit differs from every consumer's lock by construction. Fatal. Ends the discussion.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.11.0', toolkitIdentity: releaseIdentity({ version: '0.11.0', tag: 'v0.11.0', commit: SHA_A, ref: 'github:dustinkeeton/wafflestack#v0.11.0' }) });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_B }), toolkitRoot });
    assert.equal(dr.ok, true, 'a provenance mismatch MUST NOT fail the gate');
    assert.equal(dr.toolkitProvenance.status, 'mismatch');
    const out = dr.notes.join('\n');
    assert.match(out, /toolkit provenance mismatch/);
    assert.match(out, /aaaaaaaaaaaa/, 'names the lock\'s commit');
    assert.match(out, /bbbbbbbbbbbb/, 'names this CLI\'s commit');
  });

  test('THE HEADLINE: same version, DIFFERENT commit — the case a version string cannot express', () => {
    // A re-cut or force-pushed tag. `"0.12.0"` on both sides: the version-skew note is SILENT, and
    // before #374 the lock had nothing else to say. This is the entire point of the issue.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_A }) });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_B }), toolkitRoot });
    assert.equal(dr.ok, true, 'still a warning');
    assert.equal(dr.toolkitProvenance.status, 'recut');
    const out = dr.notes.join('\n');
    assert.doesNotMatch(out, /version skew/, 'the versions MATCH — only the commits differ');
    assert.match(out, /both report version 0\.12\.0 from the same repository but resolve to DIFFERENT commits/);
    assert.match(out, /re-cut or force-pushed/);
    // #384 F3: the note now shows its WORK. `recut` asserts a cause — a moved tag — and the reader
    // must be able to see the evidence it rests on: the same repo on both sides, and the two commits.
    assert.match(out, /aaaaaaaaaaaa/, 'names the lock\'s commit');
    assert.match(out, /bbbbbbbbbbbb/, 'names this CLI\'s commit');
    assert.match(out, /github:dustinkeeton\/wafflestack/, 'and names the repository it checked');
  });

  test('THE GATE-DOESN\'T-GO-RED TEST: --verify-render with different provenance, identical content', () => {
    // `--verify-render`'s comparison is `files`-only, deliberately (see the comment at the site).
    // Extending it to provenance is the single most natural-looking future change that would
    // red-gate the entire install base — this test is what stops it.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_A }) });
    const dr = doctor({
      cwd,
      toolkitVersion: '0.12.0',
      toolkitIdentity: releaseIdentity({ commit: SHA_B }), // a DIFFERENT toolkit commit…
      toolkitRoot, // …rendering byte-identical content
      verifyRender: true,
    });
    assert.equal(dr.render.evaluated, true);
    assert.equal(dr.render.ok, true, 'the content reproduces the lock — that is the question asked');
    assert.deepEqual(dr.render.stale, []);
    assert.equal(dr.ok, true, 'and the gate stays green');
    assert.equal(dr.toolkitProvenance.status, 'recut', 'while the NOTE still says the commits differ');
  });

  test('an UNRELEASED lock + an unidentifiable CLI: informational, no comparison, ok (this repo)', () => {
    // Exactly `waffle-doctor.yml` running on THIS repo: our lock says `unreleased`/null, and the
    // unpinned CI doctor is some other unreleased commit. Mismatch by construction, every run.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: unreleasedIdentity() });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: null, toolkitRoot });
    assert.equal(dr.ok, true);
    assert.equal(dr.toolkitProvenance.status, 'unpinnable');
    const out = dr.notes.join('\n');
    // "marked UNRELEASED", not "an UNRELEASED toolkit" — the article could not be right for every
    // status, and the same line printed `an RELEASE` / `an UNDEFINED` (#384 F7).
    assert.match(out, /rendered by a toolkit marked UNRELEASED/);
    assert.doesNotMatch(out, /provenance mismatch/, 'there is nothing to compare — do not invent a mismatch');
  });

  test('a release lock + an offline (unverified) CLI is NOT a mismatch — it is an unknown', () => {
    // The normal state for plain `doctor` on an npx install: it resolves its identity OFFLINE, which
    // structurally cannot reach `release` (#373). Calling that a mismatch would cry wolf on the most
    // common consumer path there is.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: unverifiedIdentity(), toolkitRoot });
    assert.equal(dr.ok, true);
    assert.equal(dr.toolkitProvenance.status, 'unverifiable');
    assert.doesNotMatch(dr.notes.join('\n'), /provenance mismatch/);
  });

  test('THE OVERLAY-MUST-NOT-PROPAGATE TEST: provenance is read from the CANONICAL lock, never the local one', () => {
    // doctor reads `lock.toolkit`, NOT `tree.toolkit` — a deliberate choice reasoned out at the call
    // site, and until now pinned by nothing: flipping it to `tree.toolkit ?? lock.toolkit` left the
    // whole suite green (#384 review, F1). This test is what makes the comment an invariant.
    //
    // The two blocks genuinely CAN diverge — canonical carries forward against `canonicalFiles`, the
    // local one against `effectiveFiles` — so a content-changing overlay can leave canonical holding
    // a `release` block while local holds `unverified` nulls. Reading `tree` would then report a
    // MACHINE-PRIVATE provenance no teammate can be told about: the exact "local overlay must not
    // propagate" class this repo was bitten by in #317. Provenance is a property of the COMMITTED
    // render — an overlay changes VALUES, never which toolkit produced them.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    const canonical = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    assert.deepEqual(canonical.toolkit, RELEASE_BLOCK, 'precondition: the committed block is a release');

    // This machine's private render: same files, but a provenance block that says something else.
    const local = { ...canonical, toolkit: { ...RELEASE_BLOCK, ref: null, commit: null, status: 'unverified' } };
    fs.writeFileSync(path.join(cwd, '.waffle/waffle.local.lock.json'), `${JSON.stringify(local, null, 2)}\n`);

    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity(), toolkitRoot });
    assert.equal(dr.ok, true);
    assert.equal(
      dr.toolkitProvenance.status,
      'match',
      'doctor must compare the CLI against the COMMITTED block (`match`); reading the local lock would report `unpinnable`',
    );
    const out = dr.notes.join('\n');
    assert.match(out, /github:dustinkeeton\/wafflestack#v0\.12\.0 @ aaaaaaaaaaaa.*matches this CLI/);
    assert.doesNotMatch(out, /rendered by an UNVERIFIED toolkit/, 'the local block must not reach the report');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upgrade: report the actual commit move, as it already does for external sources.
// ─────────────────────────────────────────────────────────────────────────────

describe('upgrade reports the toolkit\'s commit move (#374)', () => {
  let toolkitRoot;
  let cwd;
  let logged;
  const log = (line) => logged.push(String(line));

  beforeEach(() => {
    logged = [];
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-up-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov374-up-project-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
    write(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [alpha]\n');
    write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nbody\n');
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\nconfig: {}\n');
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  const runUpgrade = (toolkitIdentity, toolkitVersion) =>
    upgrade({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity, changelog: '# Changelog\n', migrations: [], log });

  test('a real version move reports both the version and the commits', () => {
    const from = releaseIdentity({ version: '0.11.0', tag: 'v0.11.0', commit: SHA_A, ref: 'github:dustinkeeton/wafflestack#v0.11.0' });
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.11.0', toolkitIdentity: from });

    const result = runUpgrade(releaseIdentity({ commit: SHA_B }), '0.12.0');
    assert.equal(result.toolkitMove.status, 'moved');
    assert.equal(result.toolkitMove.from, SHA_A);
    assert.equal(result.toolkitMove.to, SHA_B);
    assert.equal(result.toolkitMove.fromRef, 'v0.11.0');
    assert.equal(result.toolkitMove.toRef, 'v0.12.0');
    assert.match(logged.join('\n'), /toolkit moved 0\.11\.0 \(v0\.11\.0 @ aaaaaaaaaaaa\) → 0\.12\.0 \(v0\.12\.0 @ bbbbbbbbbbbb\)/);
  });

  test('SAME VERSION, different commit — still reported. This is #372\'s self-upgrade trap', () => {
    // `toVersion === lock.toolkitVersion` → `status: 'current'` → "already on toolkit X" → upgrade
    // falls silent on a toolkit that genuinely moved. Now it says so.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_A }) });

    const result = runUpgrade(releaseIdentity({ commit: SHA_B }), '0.12.0');
    assert.equal(result.status, 'current', 'upgrade\'s own status enum is UNCHANGED — #372 branches on it');
    assert.equal(result.toolkitMove.status, 'moved');
    const out = logged.join('\n');
    assert.match(out, /already on toolkit 0\.12\.0/, 'the old, blind line still prints…');
    assert.match(out, /toolkit 0\.12\.0 is unchanged by version, but its commit moved aaaaaaaaaaaa → bbbbbbbbbbbb/);
    assert.match(out, /the tag was re-cut/);
    // #384 F4: the line used to also offer "…or one of the two renders used an unreleased toolkit".
    // That cause is STRUCTURALLY IMPOSSIBLE on this branch — `moved` requires both commits non-null,
    // and `toolkitLockEntry` writes `commit` IFF `status === 'release'` (the anti-churn invariant),
    // so an unreleased render lands in `unknown`, never `moved`. A test pinned the false clause;
    // this one pins its absence.
    assert.doesNotMatch(out, /unreleased toolkit/, 'a cause this branch cannot have');
  });

  test('a REPO SWAP is not a re-cut tag at the second site either (#384 F3)', () => {
    // `describeToolkitMove` compared commits alone — the same unasked question, in `upgrade`. A lock
    // rendered by a fork's v0.12.0, upgraded with an upstream CLI reporting v0.12.0, was told its tag
    // had been re-cut. `diffToolkit` now carries the two sources so the line can tell them apart.
    renderProject({
      toolkitRoot,
      cwd,
      toolkitVersion: '0.12.0',
      toolkitIdentity: releaseIdentity({ commit: SHA_A, repo: 'acme/wafflestack', ref: 'github:acme/wafflestack#v0.12.0' }),
    });

    const result = runUpgrade(releaseIdentity({ commit: SHA_B }), '0.12.0'); // upstream CLI
    assert.equal(result.toolkitMove.status, 'moved');
    assert.equal(result.toolkitMove.fromSource, 'github:acme/wafflestack');
    assert.equal(result.toolkitMove.toSource, 'github:dustinkeeton/wafflestack');
    const out = logged.join('\n');
    assert.match(out, /DIFFERENT REPOSITORIES/);
    assert.match(out, /github:acme\/wafflestack @ aaaaaaaaaaaa → github:dustinkeeton\/wafflestack @ bbbbbbbbbbbb/);
    // The line may *deny* a re-cut ("neither tag need have been re-cut"); what it must never do is
    // ASSERT one. Pin the assertion, not the word.
    assert.doesNotMatch(out, /the tag was re-cut/, 'a cause it never checked');
  });

  test('an UNKNOWN source is not a re-cut either — the three-state rule holds at BOTH sites (#384 F12)', () => {
    // F3's fix taught this line to compare sources, but `differentRepos` is false when a source is
    // merely NULL — so a lock whose `source` was never recorded (a bare clone; any lock written before
    // #374 gained the field) fell into the strong arm and was told its tag had been RE-CUT OR
    // FORCE-PUSHED. That is an assertion about a remote nobody queried, from evidence that does not
    // exist — F3's own defect, surviving inside F3's fix. Same / different / UNKNOWN.
    renderProject({
      toolkitRoot,
      cwd,
      toolkitVersion: '0.12.0',
      // `repo: null` ⇒ `source: null` in the committed block — the bare-clone lock, which
      // `toolkitLockEntry` demonstrably emits.
      toolkitIdentity: releaseIdentity({ commit: SHA_A, repo: null, lockRepo: null }),
    });

    const result = runUpgrade(releaseIdentity({ commit: SHA_B }), '0.12.0'); // a CLI that DOES know its repo
    assert.equal(result.toolkitMove.status, 'moved');
    assert.equal(result.toolkitMove.fromSource, null, 'one side is unknown…');
    assert.equal(result.toolkitMove.toSource, 'github:dustinkeeton/wafflestack');
    const out = logged.join('\n');
    assert.doesNotMatch(out, /— the tag was re-cut or force-pushed/, '…so the strong cause is NOT asserted…');
    assert.doesNotMatch(out, /DIFFERENT REPOSITORIES/, '…and neither is its opposite…');
    assert.match(out, /at least one source is unrecorded/, '…it says exactly what it does not know…');
    assert.match(out, /may be a re-cut or force-pushed tag, or two different repositories/, '…and hedges the cause');
  });

  test('NO commit on the previous side: provenance is FILLED IN, never "moved 0.12.0 → 0.12.0" (#384 F8)', () => {
    // The `unknown` branch's `to`-truthy arm — which had NO test at all: gutting the line left the
    // whole suite green. Its own comment says "no move can be honestly claimed", and the next line
    // claimed one: `toolkit moved 0.12.0 → 0.12.0`.
    //
    // Not exotic. A first render lands `unverified` on any network blip — and per #383 a pnpm/yarn
    // `dlx` consumer has no npm lockfile, so it is `unverified` ALWAYS. The moment they upgrade on a
    // CLI that does resolve a release at the same version, they hit exactly this.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: unverifiedIdentity() });
    const written = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8')).toolkit;
    assert.equal(written.commit, null, 'the previous render recorded no commit');

    const result = runUpgrade(releaseIdentity({ commit: SHA_A }), '0.12.0'); // same version, now a release
    assert.equal(result.toolkitMove.status, 'unknown', 'no move can be honestly claimed…');
    const out = logged.join('\n');
    assert.doesNotMatch(out, /moved 0\.12\.0 → 0\.12\.0/, '…so it must not claim one');
    assert.match(out, /toolkit 0\.12\.0 is now pinned to v0\.12\.0 @ aaaaaaaaaaaa/, 'it was FILLED IN');
    assert.match(out, /no move can be reported/);
  });

  test('…while a genuine CROSS-VERSION fill-in still reads as a move', () => {
    // The other arm of the same ternary must keep its wording: the versions really did move, even
    // though the previous side recorded no commit to move FROM.
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.11.0', toolkitIdentity: unverifiedIdentity({ version: '0.11.0' }) });
    const result = runUpgrade(releaseIdentity({ commit: SHA_A }), '0.12.0');
    assert.equal(result.toolkitMove.status, 'unknown');
    assert.match(logged.join('\n'), /toolkit moved 0\.11\.0 → 0\.12\.0 \(v0\.12\.0 @ aaaaaaaaaaaa\); the previous render recorded no commit/);
  });

  test('a lock with NO `toolkit` block does not crash — the move reads `added`', () => {
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.11.0' }); // pre-#374 lock: no identity, no block
    assert.equal('toolkit' in JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8')), false);

    const result = runUpgrade(releaseIdentity(), '0.12.0');
    assert.equal(result.ok, true, JSON.stringify(result.doctor?.notes));
    assert.equal(result.toolkitMove.status, 'added');
    assert.equal(result.toolkitMove.to, SHA_A);
    assert.match(logged.join('\n'), /the previous render recorded no toolkit provenance/);
  });

  test('an unreleased toolkit reports no move — because it recorded no commit to move', () => {
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_A }) });
    const result = runUpgrade(unreleasedIdentity({ version: '0.12.0' }), '0.12.0');
    assert.equal(result.toolkitMove.status, 'unknown', 'no commit on one side → no move can be asserted');
    assert.match(logged.join('\n'), /no commit recorded, so no move can be reported/);
  });

  test('diffToolkit: an unchanged commit says nothing at all', () => {
    const block = { ...RELEASE_BLOCK };
    const move = diffToolkit(block, { ...block }, { fromVersion: '0.12.0', toVersion: '0.12.0' });
    assert.equal(move.status, 'unchanged');
    // …and `null` when neither side ever recorded provenance: no move, and no absence worth a line.
    assert.equal(diffToolkit(null, null, {}), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describeToolkitProvenance, direct — the note wording is a proposal, but the STATUS is a contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('describeToolkitProvenance (#374)', () => {
  test('every state produces exactly one note, and the note SAYS THE RIGHT THING (#384 F10)', () => {
    // This table used to assert only `notes[0].length > 20` — and that is precisely how a note reading
    // "rendered by an RELEASE toolkit … cannot be pinned to a release" (for a block
    // `toolkitPinFromLock` pins fine) shipped past a green suite: 100+ characters of wrong is still
    // > 20. A row now carries the substring its note must contain, so a state and its message cannot
    // drift apart. The length check stays as a backstop, but it is no longer the only guard.
    const states = [
      [{ lockToolkit: null }, 'not-recorded', /records no toolkit provenance/],
      [{ lockToolkit: toolkitLockEntry(unreleasedIdentity()) }, 'unpinnable', /marked UNRELEASED .* cannot be pinned to a release/],
      [{ lockToolkit: RELEASE_BLOCK, identity: null }, 'unverifiable', /reported no identity, so the two cannot be compared/],
      [{ lockToolkit: RELEASE_BLOCK, lockVersion: '0.12.0', identity: releaseIdentity() }, 'match', /matches this CLI/],
      [{ lockToolkit: RELEASE_BLOCK, lockVersion: '0.12.0', identity: releaseIdentity({ commit: SHA_B }) }, 'recut', /re-cut or force-pushed/],
      [{ lockToolkit: RELEASE_BLOCK, lockVersion: '0.11.0', identity: releaseIdentity({ commit: SHA_B }) }, 'mismatch', /the lock was rendered by/],
      // A release block with no commit — impossible from `toolkitLockEntry`, but a hand-edited,
      // foreign, or future-CLI lock can carry one, and doctor must not crash OR LIE about it. It is
      // PINNABLE (see the pin below) and merely not comparable, so the note must not say otherwise.
      [{ lockToolkit: { ...RELEASE_BLOCK, commit: null } }, 'unverifiable', /names github:dustinkeeton\/wafflestack#v0\.12\.0 but recorded no commit/],
      // A malformed block with no `status` at all: it printed `an UNDEFINED toolkit`.
      [{ lockToolkit: { ...RELEASE_BLOCK, status: undefined } }, 'unpinnable', /marked UNIDENTIFIED/],
    ];
    for (const [input, expected, noteMatches] of states) {
      const result = describeToolkitProvenance(input);
      assert.equal(result.status, expected, JSON.stringify(input));
      assert.equal(result.notes.length, 1);
      assert.match(result.notes[0], noteMatches, `the note for '${expected}' must say what is true`);
      assert.doesNotMatch(result.notes[0], /\ban (RELEASE|UNDEFINED|UNRELEASED|UNVERIFIED)\b/, 'no ungrammatical article, no UNDEFINED');
      assert.ok(result.notes[0].length > 20, 'a note that says nothing is worse than no note');
    }
  });

  test('the two exported halves of the contract AGREE about a pinnable block (#384 F7)', () => {
    // `describeToolkitProvenance` said the lock "cannot be pinned to a release" while
    // `toolkitPinFromLock` — the other half of the contract #372 consumes — pinned that exact block.
    // Shipping them contradictory hands the ambiguity to the next PR. They must agree.
    const block = { ...RELEASE_BLOCK, commit: null };
    const pin = toolkitPinFromLock({ toolkit: block });
    assert.equal(pin, 'github:dustinkeeton/wafflestack#v0.12.0', 'it IS pinnable…');

    const note = describeToolkitProvenance({ lockToolkit: block, lockVersion: '0.12.0' }).notes[0];
    assert.doesNotMatch(note, /cannot be pinned/, '…so the note must not claim it cannot be');
    assert.match(note, /but recorded no commit/, 'what is missing is a commit to COMPARE against');
    assert.ok(note.includes(pin), 'and the note names the very pin the other half returns');
  });

  test('a FORK\'s v0.12.0 vs UPSTREAM\'s v0.12.0 is not a re-cut tag — it is two repos (#384 F3)', () => {
    // `recut` used to fire on `sameVersion && differentCommit` and assert "the tag was re-cut or
    // force-pushed" — an assertion about a remote it never queried. Two repositories that each cut a
    // genuine v0.12.0 land here, neither tag touched. This is the ORDINARY shape for the fork
    // population #373 F14 exists to serve, and the correct diagnosis was sitting unread in
    // `lockToolkit.source` and `identity.repo`.
    const result = describeToolkitProvenance({
      lockToolkit: { source: 'github:acme/wafflestack', sourceType: 'git', ref: 'v0.12.0', commit: SHA_A, status: 'release' },
      lockVersion: '0.12.0',
      identity: releaseIdentity({ commit: SHA_B }), // repo: dustinkeeton/wafflestack
    });
    assert.equal(result.status, 'mismatch', 'NOT recut');
    const note = result.notes[0];
    assert.doesNotMatch(note, /re-cut|force-pushed/, 'it must not assert a cause it never checked');
    assert.match(note, /DIFFERENT REPOSITORIES/);
    assert.match(note, /github:acme\/wafflestack/, 'names the lock\'s repo…');
    assert.match(note, /github:dustinkeeton\/wafflestack/, '…and this CLI\'s');
    assert.match(note, /version 0\.12\.0/, 'and says they agree on the version, which is why it looked like a re-cut');
  });

  test('…while a genuine re-cut — SAME repo, same version, different commit — still reports `recut`', () => {
    // The headline capability must survive the fix: gating on the sources agreeing must not gut it.
    const result = describeToolkitProvenance({
      lockToolkit: RELEASE_BLOCK, // github:dustinkeeton/wafflestack
      lockVersion: '0.12.0',
      identity: releaseIdentity({ commit: SHA_B }), // same repo, different commit
    });
    assert.equal(result.status, 'recut');
    assert.match(result.notes[0], /re-cut or force-pushed/);
    assert.match(result.notes[0], /from the same repository/, 'and it now shows the evidence for that claim');
  });

  test('an UNKNOWN source is neither "same" nor "different" — it gets a hedge, not membership (#384 F12)', () => {
    // The three-state rule. F3's fix compared sources but treated `unknown` as `same`, so a bare
    // clone's release block (`source: null` — `toolkitLockEntry` emits these) was told the two "both
    // report version 0.12.0 FROM THE SAME REPOSITORY" — in a sentence that had just called the lock
    // "an unknown toolkit". F3 fixed an over-claim by introducing one; this pins the third state.
    const result = describeToolkitProvenance({
      lockToolkit: { ...RELEASE_BLOCK, source: null },
      lockVersion: '0.12.0',
      identity: releaseIdentity({ commit: SHA_B }),
    });
    assert.equal(result.status, 'recut', 'still the headline state — we cannot prove the repos differ…');
    const note = result.notes[0];
    assert.doesNotMatch(note, /DIFFERENT REPOSITORIES/, '…so we must not claim they do…');
    assert.doesNotMatch(note, /from the same repository/, '…and must not claim they are the same either');
    assert.match(note, /the two sources cannot be compared/, 'it says what it actually knows');
    assert.match(note, /may be a re-cut or force-pushed tag, or two different repositories/, 'and hedges the cause');
  });

  test('…and the same-repo claim is still MADE when it is actually established', () => {
    // The opposite miss: a fix that hedged everything would gut the headline. When both sources are
    // known and equal, "from the same repository" is established fact and must still be asserted —
    // that is the evidence the re-cut cause rests on.
    const result = describeToolkitProvenance({
      lockToolkit: RELEASE_BLOCK, // github:dustinkeeton/wafflestack
      lockVersion: '0.12.0',
      identity: releaseIdentity({ commit: SHA_B }), // same repo
    });
    assert.equal(result.status, 'recut');
    assert.match(result.notes[0], /from the same repository/);
    assert.match(result.notes[0], /the tag was re-cut or force-pushed/, 'the strong cause, on strong evidence');
    assert.doesNotMatch(result.notes[0], /cannot be compared/);
  });
});
