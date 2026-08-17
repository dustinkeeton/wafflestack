import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
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
  toolkitPinFromIdentity,
  classifyToolkitRefValue,
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
import YAML from 'yaml';
import { setScalarIn } from '../lib/project.mjs';
import { renderProject, readLock } from '../lib/render.mjs';
import { upgrade, diffToolkit, reconcileToolkitRefPins } from '../lib/upgrade.mjs';
import { doctor } from '../lib/doctor.mjs';
import { reinstall } from '../lib/uninstall.mjs';
import { eject } from '../lib/eject.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// #373/#374/#372 — toolkit provenance: identity resolution, the `ref` string format, the lock
// block, and the per-command gate matrix driven through the real CLI.
//
// NOTHING here touches the network: every test injects `lsRemote`/`runGit`, or drives an origin
// that resolves offline by construction.
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
    // git emits both lines for an annotated tag; the `^{}` line is the commit, and it must win in
    // EITHER arrival order — the unpeeled one points at the tag object, which no fetch lands on.
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
// The `ref` string — THE CONTRACT: #372 writes it into `.waffle/waffle.yaml`, #374 into the lock.
// ─────────────────────────────────────────────────────────────────────────────

describe('the toolkit ref string is exactly `github:<owner>/<repo>#<tag>` (#373 → #372/#374)', () => {
  test('toolkitRef() renders the npx spec, and nothing else', () => {
    assert.equal(toolkitRef({ owner: 'dustinkeeton', repo: 'wafflestack' }, 'v0.12.0'), 'github:dustinkeeton/wafflestack#v0.12.0');
    assert.equal(toolkitRef({ owner: 'o', repo: 'r' }, null), null);
    assert.equal(toolkitRef(null, 'v1.0.0'), null);
  });

  test('a fork names ITSELF, so its users are not sent to pin upstream', () => {
    assert.equal(toolkitRef({ owner: 'someone-else', repo: 'wafflestack' }, 'v1.0.0'), 'github:someone-else/wafflestack#v1.0.0');
  });

  test('parseRepoSlug reads every form a GitHub repo is written in', () => {
    const want = { owner: 'dustinkeeton', repo: 'wafflestack' };
    assert.deepEqual(parseRepoSlug('git+ssh://git@github.com/dustinkeeton/wafflestack.git#' + SHA_A), want);
    assert.deepEqual(parseRepoSlug('git+https://github.com/dustinkeeton/wafflestack.git'), want);
    assert.deepEqual(parseRepoSlug('https://github.com/dustinkeeton/wafflestack'), want);
    assert.deepEqual(parseRepoSlug('git@github.com:dustinkeeton/wafflestack.git'), want);
    assert.deepEqual(parseRepoSlug('github:dustinkeeton/wafflestack'), want);
    assert.deepEqual(parseRepoSlug('dustinkeeton/wafflestack'), want);
    assert.equal(parseRepoSlug(null), null);
    assert.equal(parseRepoSlug(''), null);
    assert.equal(parseRepoSlug('../elsewhere'), null);
    assert.equal(parseRepoSlug('./x'), null);
  });

  test('httpsUrl normalizes to an unauthenticated fetch — an ssh URL would demand a key on CI', () => {
    assert.equal(httpsUrl({ owner: 'o', repo: 'r' }), 'https://github.com/o/r.git');
  });

  test('repoSlug reads PROVENANCE before DECLARATION — and the git remote outranks `repository` too', () => {
    // Order: npm `resolved` → git `origin` → the declared `repository`, which a fork inherits verbatim.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-slug-'));
    try {
      const pkg = { name: 'wafflestack', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } };
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => null }), { owner: 'dustinkeeton', repo: 'wafflestack' });

      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => 'git@github.com:acme/wafflestack.git' }), {
        owner: 'acme',
        repo: 'wafflestack',
      });
      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: () => null }), { owner: 'dustinkeeton', repo: 'wafflestack' });

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
    // `repoSlug` answers "which remote do I ASK about tags?"; the LOCK asks "which toolkit is this,
    // GIVEN THE PIN?" — `origin` is a property of the clone and must never reach a committed artifact (#317).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-lockslug-'));
    try {
      const pkg = { name: 'wafflestack', repository: { type: 'git', url: 'git+https://github.com/dustinkeeton/wafflestack.git' } };
      const fork = () => 'git@github.com:contributor/wafflestack.git';
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });

      assert.deepEqual(repoSlug({ toolkitRoot: root, pkg, runGit: fork }), { owner: 'contributor', repo: 'wafflestack' });
      assert.deepEqual(lockRepoSlug({ toolkitRoot: root, pkg }), { owner: 'dustinkeeton', repo: 'wafflestack' });

      // It takes no `runGit` AT ALL — the origin step cannot be reached even by accident.
      assert.equal(lockRepoSlug.length, 1, 'one arg: there is no git seam to consult');

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
          resolveToolkitIdentity({ toolkitRoot: root, runGit: clone(originUrl) }),
          { toolkitVersion: '0.12.0' },
        );

      const upstream = blockFor('https://github.com/dustinkeeton/wafflestack.git');
      const forked = blockFor('git@github.com:contributor/wafflestack.git');

      assert.deepEqual(forked, upstream, 'the committed lock cannot depend on which clone rendered it');
      assert.equal(upstream.source, 'github:dustinkeeton/wafflestack');
      assert.equal(resolveToolkitIdentity({ toolkitRoot: root, runGit: clone('git@github.com:contributor/wafflestack.git') }).repo, 'contributor/wafflestack');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a checkout on a RELEASE TAG asks NO remote — so it records NO source (#384 F11, F13)', () => {
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
      assert.equal(upstream.source, null, 'and it names NO repo: none was corroborated (#384 F13)');
      assert.equal(toolkitPinFromLock({ toolkit: upstream }), null, 'so it pins nothing, honestly');
      assert.equal(upstream.commit, SHA_A);
      assert.equal(upstream.ref, 'v0.12.0', 'the LOCAL facts are still fully recorded — they are checkable');
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
    assert.equal(id.repo, 'acme/toolkit');
    assert.equal(id.ref, 'github:acme/toolkit#v0.9.0');
    assert.equal(id.lookupError, null);
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

  test('identity is hatch-independent — an unreleased checkout is `unreleased`, ref null (#383)', () => {
    advance('unreleased work');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(id.status, 'unreleased');
    assert.equal(id.ref, null);
    assert.equal(id.commit, head());
  });

  test('A DIRTY TREE ON A RELEASE TAG IS NOT A RELEASE — the tag stops describing what renders', () => {
    // `git describe --exact-match` answers about the COMMIT and ignores the WORKING TREE, so a
    // maintainer's uncommitted `stacks/**` edits would otherwise render as a `release`.
    write(work, 'stacks/x/stack.yaml', 'name: x\ndescription: X.\n');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'stacks');
    git('tag', '-f', 'v0.9.0'); // HEAD is exactly the release tag, tree clean

    const clean = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
    assert.equal(clean.status, 'release', 'a CLEAN tree on the tag is still a release — do not over-refuse');
    assert.equal(clean.ref, 'github:acme/toolkit#v0.9.0');

    // An UNTRACKED scratch file is NOT a dirty toolkit — nothing that renders has changed.
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

    const msg = formatUnreleasedRefusal(dirty, 'render');
    assert.doesNotMatch(msg, /no release tag points here/);
    assert.match(msg, /uncommitted changes to tracked files/);
    assert.match(msg, /HEAD is v0\.9\.0/);
  });

  test('A CHECKOUT NEVER QUERIES THE REMOTE — so the refusal must hedge, never assert', () => {
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
    // KEY ON `ref != null`, NOT ON `status === 'release'`: `status` is fixed by `git describe`
    // before the slug is consulted, so a release whose slug is unknowable has `ref: null`.
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
// origin: 'npm-install' — the `npx github:` consumer path. No `.git`; npm's hidden lockfile
// records the SHA it cloned, and ONE ls-remote classifies it.
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
    // ONE lookup, against HTTPS: an unauthenticated ls-remote over npm's `git+ssh://` needs a key.
    assert.deepEqual(lsRemote.calls, ['https://github.com/dustinkeeton/wafflestack.git']);
  });

  test('the fetched SHA is NOT any tag (the unpinned default branch) → `unreleased`', () => {
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
    const root = layout({
      resolved: `git+ssh://git@github.com/acme/wafflestack.git#${SHA_A}`,
    });
    /** Answers per-URL, so the test pins WHICH REMOTE WAS ASKED and cannot pass by fixture. */
    const asked = [];
    const lsRemote = (url) => {
      asked.push(url);
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
    const root = path.join(tmp, 'node_modules', 'wafflestack');
    write(root, 'package.json', JSON.stringify({ name: 'wafflestack', version: '0.12.0', repository: 'github:dustinkeeton/wafflestack' }));
    assert.deepEqual(repoSlug({ toolkitRoot: root, pkg: { name: 'wafflestack', repository: 'github:dustinkeeton/wafflestack' }, runGit: () => null }), {
      owner: 'dustinkeeton',
      repo: 'wafflestack',
    });
  });

  test('a remote with ZERO release tags names no pinned command — it never inherits UPSTREAM\'s tag', () => {
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
    assert.match(msg, /acme\/wafflestack has no `vX\.Y\.Z` release tags/);
    assert.match(msg, /--allow-unreleased/, 'lead with the hatch — here it is the only path that works');
    assert.match(formatProvenanceWarning(id) ?? '', /cannot name a pin/);
  });

  test('a lookup that NEVER RAN must not claim the remote has no tags — hedge, do not assert', () => {
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
    const root = layout({ changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n' });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork });
    assert.equal(id.status, 'unverified');
    assert.equal(id.origin, 'unknown');
    assert.equal(id.commit, null);
    assert.equal(id.ref, null);
    assert.match(id.lookupError ?? '', /lockfile/i);
    assert.match(formatProvenanceWarning(id) ?? '', /could not verify/i);
  });

  test('a garbage lockfile → `unverified`, never a throw', () => {
    const root = layout({ lockBody: '{ not json at all', changelog: '# Changelog\n\n## [Unreleased]\n' });
    assert.equal(resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork }).status, 'unverified');
  });

  test('a lockfile with no resolvable 40-char SHA → `unverified`', () => {
    for (const resolved of ['https://registry.npmjs.org/wafflestack/-/wafflestack-0.12.0.tgz', 'git+ssh://git@github.com/o/r.git#abc123']) {
      const root = layout({ resolved, changelog: '# Changelog\n\n## [Unreleased]\n' });
      assert.equal(resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork }).status, 'unverified', resolved);
      fs.rmSync(path.join(tmp, 'node_modules'), { recursive: true, force: true });
    }
  });

  test('THE LOOKUP THROWS (offline, GitHub blip) → `unverified` + lookupError, and we proceed', () => {
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
    assert.equal(id.latestTag, 'v0.12.0');
  });

  test('the lookup is skippable ONLY by `offline` — a genuine release pin keeps its `ref` (#383)', () => {
    const root = layout({ resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    const online = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`]) });
    assert.equal(online.status, 'release');
    assert.equal(online.ref, 'github:dustinkeeton/wafflestack#v0.12.0');
  });

  test('`offline: true` (plain doctor, the banner, `--offline`) skips the lookup — never a release', () => {
    const root = layout({ resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork, offline: true });
    assert.equal(id.commit, SHA_A);
    assert.notEqual(id.status, 'release', 'the skip must never manufacture a release verdict');
    assert.match(id.lookupError ?? '', /skipped \(offline\)/);
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
    const root = layout({
      resolved: `git+ssh://git@github.com/acme/forked.git#${SHA_A}`,
      repository: null, // no usable `repository` field → the slug MUST come from the lockfile
    });
    assert.deepEqual(repoSlug({ toolkitRoot: root, pkg: { name: 'wafflestack' }, runGit: () => null }), { owner: 'acme', repo: 'forked' });
    assert.equal(commitFromNpmLockfile(root, 'wafflestack'), SHA_A);
    const lsRemote = fakeLsRemote([`${SHA_A}\trefs/tags/v1.0.0`]);
    const id = resolveToolkitIdentity({ toolkitRoot: root, lsRemote });
    assert.equal(id.repo, 'acme/forked');
    assert.equal(id.commit, SHA_A);
    assert.equal(id.ref, 'github:acme/forked#v1.0.0');
    assert.deepEqual(lsRemote.calls, ['https://github.com/acme/forked.git']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The offline corroborator: the CHANGELOG ships, and a release stamps `## [Unreleased]` down — so
// a shipped changelog with a NON-EMPTY `## [Unreleased]` proves, with no network, this is no release.
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
    for (const entry of ['**Breaking: render now refuses.**', '_Support for pnpm added._']) {
      const id = resolveToolkitIdentity({
        toolkitRoot: npmLayout(`# Changelog\n\n## [Unreleased]\n\n${entry}\n\n## [0.12.0] - 2026-07-11\n`),
        lsRemote: failedLookup,
      });
      assert.equal(id.status, 'unreleased', `an emphasized entry must still corroborate: ${entry}`);
    }
  });

  test('the corroborator never OVERRIDES a successful lookup that said `release`', () => {
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
    // EDGE 1, fail-CLOSED: the scaffold a release leaves behind is not an entry.
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n### Added\n\n### Fixed\n'), false, 'empty sub-headings');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n_Nothing yet._\n'), false, 'emphasis-only placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n**No changes.**\n'), false, 'bold placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n*None.*\n'), false);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n_TBD_\n'), false);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n<!-- add entries\n     here -->\n'), false, 'HTML comment, even across lines');

    // EDGE 2, fail-OPEN (the dangerous direction): an emphasized line is an ENTRY unless its WORDS
    // say otherwise — the filter keys on placeholder vocabulary, never on emphasis.
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n### Added\n\n**Breaking: render now refuses.**\n'), true, 'a BOLD entry is still an entry');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n_Support for pnpm added._\n'), true, 'an ITALIC entry is still an entry');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n**Nothing is broken by this release.**\n'), true, 'opens with "Nothing" — but it is prose, not a placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n### Added\n\n- a real entry\n'), true, 'an entry under a sub-heading');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n* an asterisk bullet\n'), true, 'a bullet is not a placeholder');
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n* a *bold* asterisk bullet\n'), true);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\n- **Fixed** a thing (#1)\n'), true);
    assert.equal(changelogHasUnreleasedEntries('## [Unreleased]\n\nprose, no bullet\n'), true);
    assert.equal(changelogLatestRelease('## [0.9.0] - x\n## [0.10.0] - y\n'), 'v0.10.0', 'semver order, not file order');
    assert.equal(changelogLatestRelease('## [Unreleased]\n'), null);
    assert.equal(changelogLatestRelease(null), null);
  });

  test('THIS repo\'s own shipped CHANGELOG is the live case — the corroborator reads it', () => {
    // Not a fixture, the real file: both `[Unreleased]` states are legitimate and both are safe.
    const real = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    assert.equal(typeof changelogHasUnreleasedEntries(real), 'boolean', 'the corroborator reads the real file without throwing');
    assert.match(changelogLatestRelease(real) ?? '', /^v\d+\.\d+\.\d+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusal message — the copy-pasteable command is the whole value of failing closed.
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
// THE GATE MATRIX — one assertion per command, driven through the real CLI. This checkout is
// `unreleased` by construction and resolves OFFLINE, so the spawns make zero network calls; a
// checkout sitting exactly on a release tag skips the refusal half rather than asserting it falsely.
// ─────────────────────────────────────────────────────────────────────────────

describe('the gate matrix: which commands refuse an unreleased toolkit (#373)', () => {
  let cwd;

  // This suite asserts the GATE, so it must run with the hatch CLOSED — CI and installer.test.mjs
  // both set WAFFLESTACK_ALLOW_UNRELEASED, so strip it per spawn rather than trusting the env.
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
    // A minimal but VALID project, so "did not refuse" is about the gate and not a missing config.
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
      assert.match(r.stderr, /Run this instead:/);
      assert.match(r.stderr, new RegExp(`npx --yes github:\\S+#v\\d+\\.\\d+\\.\\d+ ${args[0]}\\b`));
      assert.match(r.stderr, /--allow-unreleased/);
      assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), false, 'a refused command must write nothing');
    });
  }

  test('`install <ref>` refuses without persisting the ref into waffle.yaml', { skip: skipUnlessUnreleased }, () => {
    const before = fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8');
    const r = gated(['install', 'stacks/github-workflow']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, REFUSAL);
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), before, 'waffle.yaml must be untouched');
  });

  // Everything that does NOT write files from toolkit content. These may exit non-zero on their own
  // merits; what is asserted is that they never REFUSE — gating plain `doctor` would be the outage.
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

  test('`--allow-unreleased` and `--offline` are accepted by every command, not just the gated ones', () => {
    // Both flags are stripped globally, before any "takes no refs" guard can reject them as stray refs.
    for (const flag of ['--allow-unreleased', '--offline']) {
      for (const cmd of ['render', 'upgrade', 'reinstall', 'list', 'doctor']) {
        const r = allowed([cmd, flag]);
        assert.doesNotMatch(r.stderr, /takes no refs/, `${cmd} must not treat ${flag} as a ref`);
      }
    }
  });

  test('`--offline` renders under the hatch without stalling — the air-gapped shape (#383)', () => {
    const r = gated(['render', '--allow-unreleased', '--offline']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, REFUSAL);
    assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), true);
  });

  test('the help text documents both flags and their env twins', () => {
    const r = gated(['help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--allow-unreleased/);
    assert.match(r.stdout, /WAFFLESTACK_ALLOW_UNRELEASED=1/);
    assert.match(r.stdout, /--offline/);
    assert.match(r.stdout, /WAFFLESTACK_OFFLINE=1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The CLI's own flag wiring, end to end (#383): every other spawned-CLI test resolves THIS
// checkout, which never calls `ls-remote` — so these spawns run a COPY from a fabricated
// release-pinned npx layout, with a stub `git` on PATH recording its invocations.
// ─────────────────────────────────────────────────────────────────────────────

describe('the CLI wires `--offline` — not the hatch — to the lookup (#383)', { skip: process.platform === 'win32' ? 'POSIX git stub' : false }, () => {
  let tmp;
  let fabCli;
  let stubLog;
  let spawnPath;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-cli-wire-'));
    const layoutRoot = path.join(tmp, 'node_modules', 'wafflestack');
    for (const entry of ['installer', 'stacks', 'schema', 'toolkit.yaml', 'package.json', 'CHANGELOG.md']) {
      fs.cpSync(path.join(REPO_ROOT, entry), path.join(layoutRoot, entry), { recursive: true });
    }
    // A real npx install ships its prod deps; the toolkit's one is `yaml`.
    fs.cpSync(path.join(REPO_ROOT, 'node_modules', 'yaml'), path.join(layoutRoot, 'node_modules', 'yaml'), { recursive: true });
    write(tmp, 'node_modules/.package-lock.json', JSON.stringify({
      name: 'consumer',
      lockfileVersion: 3,
      packages: { 'node_modules/wafflestack': { version: '0.12.0', resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` } },
    }));
    fabCli = path.join(layoutRoot, 'installer', 'cli.mjs');
    stubLog = path.join(tmp, 'git-stub.log');
    const stubBin = path.join(tmp, 'bin');
    write(tmp, 'bin/git', [
      '#!/bin/sh',
      'echo "$@" >> "$GIT_STUB_LOG"',
      'case "$1" in',
      `  ls-remote) printf '%s\\trefs/tags/v0.12.0\\n' '${SHA_A}' ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    fs.chmodSync(path.join(stubBin, 'git'), 0o755);
    spawnPath = `${stubBin}${path.delimiter}${process.env.PATH}`;
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const run = (args) => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'consumer-'));
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\nconfig: {}\n');
    fs.writeFileSync(stubLog, '');
    const env = { ...process.env, PATH: spawnPath, GIT_STUB_LOG: stubLog };
    delete env.WAFFLESTACK_ALLOW_UNRELEASED;
    delete env.WAFFLESTACK_OFFLINE;
    const r = spawnSync(process.execPath, [fabCli, ...args, '--cwd', cwd], { encoding: 'utf8', env, timeout: 30000 });
    return { r, cwd, gitCalls: fs.readFileSync(stubLog, 'utf8') };
  };

  test('`--allow-unreleased` alone still performs the lookup — a genuine release keeps its provenance', () => {
    const { r, cwd, gitCalls } = run(['render', '--allow-unreleased']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(gitCalls, /ls-remote --tags -- https:\/\/github\.com\/dustinkeeton\/wafflestack\.git/,
      'the hatch must not suppress the lookup — that is the #383 conflation');
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    assert.equal(lock.toolkit.status, 'release', 'a release-pinned npx install resolves as one under the hatch');
    assert.equal(lock.toolkit.source, 'github:dustinkeeton/wafflestack');
    assert.equal(lock.toolkit.ref, 'v0.12.0');
    assert.equal(lock.toolkit.commit, SHA_A);
  });

  test('`--offline` is the switch that skips it — and provenance degrades honestly, never to a fake release', () => {
    const { r, cwd, gitCalls } = run(['render', '--allow-unreleased', '--offline']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.doesNotMatch(gitCalls, /ls-remote/, '`--offline` must never pay for the lookup');
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    assert.notEqual(lock.toolkit.status, 'release', 'skipping the lookup cannot manufacture a release');
    assert.equal(lock.toolkit.ref, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The identity reaches the write site — #374 writes it into the lock, #372 into waffle.yaml.
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

      const lock = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
      assert.equal(lock.toolkitVersion, '0.0.test');
      assert.equal(lock.toolkit.ref, 'v0.12.0', 'the PIN, not the npx spec — `sources[].ref` shape');
      assert.equal(lock.toolkit.commit, SHA_A);

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
    const out = notes(identityAt('unreleased'));
    assert.match(out, /version skew/);
    assert.match(out, /npx --yes github:dustinkeeton\/wafflestack#v0\.12\.0 upgrade/);
    assert.match(out, /a bare `upgrade` re-fetches the default branch/, 'say what is TRUE of a bare upgrade…');
    assert.doesNotMatch(out, /would refuse/, '…not a prediction about the gate, which this note cannot make');
  });

  test('THE NOTE MUST NOT PREDICT THE GATE — a release-pinned npx install is told no such thing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-skew-npx-'));
    try {
      const root = path.join(tmp, 'node_modules', 'wafflestack');
      write(root, 'package.json', JSON.stringify({ name: 'wafflestack', version: '0.12.0', repository: 'github:dustinkeeton/wafflestack' }));
      write(root, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [0.12.0] - 2026-07-11\n\n- shipped\n');
      write(tmp, 'node_modules/.package-lock.json', JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/wafflestack': { resolved: `git+ssh://git@github.com/dustinkeeton/wafflestack.git#${SHA_A}` } },
      }));

      const offline = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: forbidNetwork, offline: true });
      assert.equal(offline.status, 'unverified', 'the offline path cannot see the tag — that IS the design');
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
// #374 — the lock records WHICH TOOLKIT produced the render, keyed like a `sources[]` entry.
// `commit` is recorded IFF `status === 'release'`: no field may be a function of a moving HEAD,
// or a self-rendering repo's committed lock churns on every commit. doctor's check only WARNS.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A synthetic release identity — the shape `resolveToolkitIdentity` hands back. `lockRepo` is
 * deliberately ABSENT, and `origin` is `npm-install`, where `repo` and `lockRepo` always agree.
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
 * The same, for a toolkit that is provably NOT a release. A checkout, so it states BOTH slugs —
 * this is the one origin where they can differ.
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

/**
 * The same release rendered from a CHECKOUT, naming no repo: `git describe` asks no remote, and
 * `source` + `ref` are a pin — a claim. The local facts are recorded because they are checkable.
 */
const CHECKOUT_RELEASE_BLOCK = { ...RELEASE_BLOCK, source: null };

// ─────────────────────────────────────────────────────────────────────────────
// The shape, unit-tested against synthetic identities — no git, no network, no render.
// ─────────────────────────────────────────────────────────────────────────────

describe('toolkitLockEntry — the block\'s shape (#374)', () => {
  test('a RELEASE identity records the full block: source, pinned ref, and the commit', () => {
    assert.deepEqual(toolkitLockEntry(releaseIdentity()), RELEASE_BLOCK);
  });

  test('an UNRELEASED identity records nulls and a status that says WHY — never HEAD\'s sha', () => {
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
    // ~50 existing render call sites pass no identity: omitting the block is what keeps them green.
    assert.equal(toolkitLockEntry(null), null);
  });

  test('a release whose repo slug is unknowable records source: null — and no pin can be built', () => {
    // #373's contract: `status: 'release'` does NOT imply a non-null ref.
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
    // Without the carry-forward an `unverified` render rewrites a full release block to nulls, so two
    // teammates on the SAME pinned toolkit commit two different locks and the diff gate reds.
    const entry = toolkitLockEntry(unverifiedIdentity(), {
      prevLock,
      newFiles: { ...FILES },
      toolkitVersion: '0.12.0',
    });
    assert.deepEqual(entry, RELEASE_BLOCK, 'the recorded toolkit still reproduces these exact bytes — keep it');
  });

  test('the carry-forward\'s guarantee is REPRODUCIBILITY, not attribution (#384 F9)', () => {
    const ranAtB = unverifiedIdentity({ commit: SHA_B }); // an unverified CLI KNOWS its own commit
    const entry = toolkitLockEntry(ranAtB, { prevLock, newFiles: { ...FILES }, toolkitVersion: '0.12.0' });
    assert.equal(entry.commit, SHA_A, 'the block names A…');
    assert.equal(ranAtB.commit, SHA_B, '…while B is what actually rendered');
    assert.equal(entry.status, 'release', 'and the good block is preserved, which is the point');
  });

  test('…but only when it asserts NOTHING NEW: different content rewrites the block honestly', () => {
    // It fires only when the freshly rendered bytes are IDENTICAL to the ones the block describes.
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
    // `sameFiles` compares the key SETS: a subset would carry the block across an added/dropped output.
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
    // Two people rendering the same unreleased toolkit compute the same nulls — nothing to protect.
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
// #372's read-back. The triple equality IS the contract: it stops the lock's pin format and
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
    assert.equal(lock.toolkitVersion, '0.12.0');
    assert.deepEqual(result.toolkit, RELEASE_BLOCK);
    // Placement: immediately after `toolkitVersion`, before `targets`.
    assert.deepEqual(Object.keys(lock).slice(0, 3), ['toolkitVersion', 'toolkit', 'targets']);
  });

  test('an UNRELEASED render records `{ ref: null, commit: null, status: "unreleased" }`', () => {
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
    // THE anti-churn guard: recording HEAD's sha for a checkout render would churn the lock on every
    // commit and permanently red the documented `render` + `git diff --exit-code` recipe.
    assert.equal(render(unreleasedIdentity({ commit: SHA_A })).ok, true);
    const first = lockBytes();
    assert.equal(render(unreleasedIdentity({ commit: SHA_B })).ok, true);
    const second = lockBytes();
    assert.equal(first, second, 'a moving HEAD must not move a single byte of the lock');
    assert.equal(JSON.parse(second).toolkit.commit, null);
  });

  test('THE DETERMINISM TEST — two clones, different `origin`, BYTE-IDENTICAL lock (#384 F2)', () => {
    // Its sibling, varying `repo` rather than `commit`: `identity.repo` is origin-first, so two
    // contributors on the same commit would write different `source` values. `lockRepo` is pin-derived.
    const upstreamClone = unreleasedIdentity({ repo: 'dustinkeeton/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });
    const forkClone = unreleasedIdentity({ repo: 'contributor/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });

    assert.equal(render(upstreamClone).ok, true);
    const first = lockBytes();
    assert.equal(render(forkClone).ok, true);
    const second = lockBytes();

    assert.equal(first, second, 'the renderer\'s clone must not move a single byte of the lock');
    assert.equal(JSON.parse(second).toolkit.source, 'github:dustinkeeton/wafflestack');
  });

  test('a RELEASE is NOT an exception — a checkout records NO source at all (#384 F11, F13)', () => {
    const checkout = { origin: /** @type {const} */ ('checkout') };
    const fromUpstreamClone = releaseIdentity({ ...checkout, repo: 'dustinkeeton/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });
    const fromForkClone = releaseIdentity({ ...checkout, repo: 'contributor/wafflestack', lockRepo: 'dustinkeeton/wafflestack' });

    assert.equal(render(fromUpstreamClone).ok, true);
    const first = lockBytes();
    assert.equal(render(fromForkClone).ok, true);
    const second = lockBytes();

    assert.equal(first, second, 'a release checkout must not record the clone either');
    assert.deepEqual(JSON.parse(second).toolkit, CHECKOUT_RELEASE_BLOCK);
    assert.equal(toolkitPinFromLock(JSON.parse(second)), null, 'an uncorroborated release pins NOTHING');
  });

  test('THE PIN NEVER NAMES A REPO THAT DOES NOT HOLD THE REF — the checkout twin (#384 F13)', () => {
    const forkCheckout = releaseIdentity({
      version: '1.0.0',
      tag: 'v1.0.0',
      ref: 'github:acme/wafflestack#v1.0.0', // the CLI names itself by where it CAME FROM (#373 F14)
      origin: 'checkout',
      repo: 'acme/wafflestack', // origin
      lockRepo: 'dustinkeeton/wafflestack', // declared — INHERITED, and it never cut v1.0.0
    });
    assert.equal(render(forkCheckout).ok, true);
    const block = readLockJson().toolkit;

    assert.equal(block.source, null, 'no repo was corroborated, so no repo is named');
    assert.equal(toolkitPinFromLock({ toolkit: block }), null, 'and NO PIN is emitted — not a false one');
    assert.notEqual(
      toolkitPinFromLock({ toolkit: block }),
      'github:dustinkeeton/wafflestack#v1.0.0',
      'the exact false pin F13 reproduced: upstream never cut v1.0.0',
    );
    assert.equal(block.ref, 'v1.0.0', 'the local facts survive — the tag and commit are checkable');
    assert.equal(block.commit, SHA_A);
    assert.equal(block.status, 'release', 'and it is still, honestly, a release render');
  });

  test('…and #373 F14 still holds where it actually lives: the NPX path names the fork', () => {
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
    // `lockSourceRepo`'s `?? identity.repo` tail is safe only because `repoSlug`'s origin step is
    // `.git`-gated: on npm-install `repo` IS pin-derived; on a checkout it is the clone, so record null.
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
    // Prior art: a lock with no `sources` block doctors clean — additive key, tolerant readers.
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
    // The no-lock early return must still carry `toolkitProvenance` — #372 reads `.status` unguarded.
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
    // If this ever flips to false, every consumer's required `waffle-doctor` check reds the moment
    // anything merges to this repo's `main`: `doctor.toolkitRef` ships UNPINNED by default.
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
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_A }) });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_B }), toolkitRoot });
    assert.equal(dr.ok, true, 'still a warning');
    assert.equal(dr.toolkitProvenance.status, 'recut');
    const out = dr.notes.join('\n');
    assert.doesNotMatch(out, /version skew/, 'the versions MATCH — only the commits differ');
    assert.match(out, /both report version 0\.12\.0 from the same repository but resolve to DIFFERENT commits/);
    assert.match(out, /re-cut or force-pushed/);
    assert.match(out, /aaaaaaaaaaaa/, 'names the lock\'s commit');
    assert.match(out, /bbbbbbbbbbbb/, 'names this CLI\'s commit');
    assert.match(out, /github:dustinkeeton\/wafflestack/, 'and names the repository it checked');
  });

  test('THE GATE-DOESN\'T-GO-RED TEST: --verify-render with different provenance, identical content', () => {
    // `--verify-render` stays files-only: extending it to provenance would red-gate the install base.
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
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: unreleasedIdentity() });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: null, toolkitRoot });
    assert.equal(dr.ok, true);
    assert.equal(dr.toolkitProvenance.status, 'unpinnable');
    const out = dr.notes.join('\n');
    assert.match(out, /rendered by a toolkit marked UNRELEASED/);
    assert.doesNotMatch(out, /provenance mismatch/, 'there is nothing to compare — do not invent a mismatch');
  });

  test('a release lock + an offline (unverified) CLI is NOT a mismatch — it is an unknown', () => {
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    const dr = doctor({ cwd, toolkitVersion: '0.12.0', toolkitIdentity: unverifiedIdentity(), toolkitRoot });
    assert.equal(dr.ok, true);
    assert.equal(dr.toolkitProvenance.status, 'unverifiable');
    assert.doesNotMatch(dr.notes.join('\n'), /provenance mismatch/);
  });

  test('THE OVERLAY-MUST-NOT-PROPAGATE TEST: provenance is read from the CANONICAL lock, never the local one', () => {
    // doctor reads `lock.toolkit`, never `tree.toolkit`: the two can diverge, and provenance is a
    // property of the COMMITTED render — an overlay changes VALUES, not which toolkit produced them (#317).
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity() });
    const canonical = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    assert.deepEqual(canonical.toolkit, RELEASE_BLOCK, 'precondition: the committed block is a release');

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
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: releaseIdentity({ commit: SHA_A }) });

    const result = runUpgrade(releaseIdentity({ commit: SHA_B }), '0.12.0');
    assert.equal(result.status, 'current', 'upgrade\'s own status enum is UNCHANGED — #372 branches on it');
    assert.equal(result.toolkitMove.status, 'moved');
    const out = logged.join('\n');
    assert.match(out, /already on toolkit 0\.12\.0/, 'the old, blind line still prints…');
    assert.match(out, /toolkit 0\.12\.0 is unchanged by version, but its commit moved aaaaaaaaaaaa → bbbbbbbbbbbb/);
    assert.match(out, /the tag was re-cut/);
    assert.doesNotMatch(out, /unreleased toolkit/, 'a cause this branch cannot have');
  });

  test('a REPO SWAP is not a re-cut tag at the second site either (#384 F3)', () => {
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
    assert.doesNotMatch(out, /the tag was re-cut/, 'a cause it never checked');
  });

  test('an UNKNOWN source is not a re-cut either — the three-state rule holds at BOTH sites (#384 F12)', () => {
    renderProject({
      toolkitRoot,
      cwd,
      toolkitVersion: '0.12.0',
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
    assert.equal(diffToolkit(null, null, {}), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describeToolkitProvenance, direct — the note wording is a proposal, but the STATUS is a contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('describeToolkitProvenance (#374)', () => {
  test('every state produces exactly one note, and the note SAYS THE RIGHT THING (#384 F10)', () => {
    // Each row carries the substring its note must contain, so a state and its message cannot drift.
    const states = [
      [{ lockToolkit: null }, 'not-recorded', /records no toolkit provenance/],
      [{ lockToolkit: toolkitLockEntry(unreleasedIdentity()) }, 'unpinnable', /marked UNRELEASED .* cannot be pinned to a release/],
      [{ lockToolkit: RELEASE_BLOCK, identity: null }, 'unverifiable', /reported no identity, so the two cannot be compared/],
      [{ lockToolkit: RELEASE_BLOCK, lockVersion: '0.12.0', identity: releaseIdentity() }, 'match', /matches this CLI/],
      [{ lockToolkit: RELEASE_BLOCK, lockVersion: '0.12.0', identity: releaseIdentity({ commit: SHA_B }) }, 'recut', /re-cut or force-pushed/],
      [{ lockToolkit: RELEASE_BLOCK, lockVersion: '0.11.0', identity: releaseIdentity({ commit: SHA_B }) }, 'mismatch', /the lock was rendered by/],
      // Impossible from `toolkitLockEntry`, but a hand-edited or foreign lock can carry one.
      [{ lockToolkit: { ...RELEASE_BLOCK, commit: null } }, 'unverifiable', /names github:dustinkeeton\/wafflestack#v0\.12\.0 but recorded no commit/],
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
    const block = { ...RELEASE_BLOCK, commit: null };
    const pin = toolkitPinFromLock({ toolkit: block });
    assert.equal(pin, 'github:dustinkeeton/wafflestack#v0.12.0', 'it IS pinnable…');

    const note = describeToolkitProvenance({ lockToolkit: block, lockVersion: '0.12.0' }).notes[0];
    assert.doesNotMatch(note, /cannot be pinned/, '…so the note must not claim it cannot be');
    assert.match(note, /but recorded no commit/, 'what is missing is a commit to COMPARE against');
    assert.ok(note.includes(pin), 'and the note names the very pin the other half returns');
  });

  test('a FORK\'s v0.12.0 vs UPSTREAM\'s v0.12.0 is not a re-cut tag — it is two repos (#384 F3)', () => {
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

  test('a FORK CHECKOUT\'s genuine re-cut reads `recut`, not DIFFERENT REPOSITORIES (#384 F13)', () => {
    const forkCheckoutLock = toolkitLockEntry(
      releaseIdentity({
        version: '1.0.0', tag: 'v1.0.0', ref: 'github:acme/wafflestack#v1.0.0',
        origin: 'checkout', repo: 'acme/wafflestack', lockRepo: 'dustinkeeton/wafflestack',
      }),
      { toolkitVersion: '1.0.0' },
    );
    assert.equal(forkCheckoutLock.source, null, 'the writer names no repo it did not corroborate…');

    const result = describeToolkitProvenance({
      lockToolkit: forkCheckoutLock,
      lockVersion: '1.0.0',
      identity: releaseIdentity({ // the same fork checkout, tag GENUINELY re-cut aaaa -> bbbb
        version: '1.0.0', tag: 'v1.0.0', ref: 'github:acme/wafflestack#v1.0.0', commit: SHA_B,
        origin: 'checkout', repo: 'acme/wafflestack', lockRepo: 'dustinkeeton/wafflestack',
      }),
    });
    assert.equal(result.status, 'recut', 'a re-cut tag is a re-cut tag, on a fork checkout too');
    assert.doesNotMatch(result.notes[0], /DIFFERENT REPOSITORIES/, 'one repo — never call it two');
    assert.doesNotMatch(result.notes[0], /neither tag need have moved/, 'a tag DID move; that is the finding');
  });

  test('the CLI names itself by where it CAME FROM — the reader must not read `lockRepo` (#384 F13)', () => {
    const result = describeToolkitProvenance({
      lockToolkit: { source: 'github:acme/wafflestack', sourceType: 'git', ref: 'v0.12.0', commit: SHA_A, status: 'release' },
      lockVersion: '0.12.0',
      identity: releaseIdentity({
        commit: SHA_B,
        ref: 'github:acme/wafflestack#v0.12.0',
        origin: 'checkout',
        repo: 'acme/wafflestack', // where this clone came from — what the note prints
        lockRepo: 'dustinkeeton/wafflestack', // what its inherited package.json declares
      }),
    });
    assert.equal(result.status, 'recut', 'one repo, one moved tag');
    assert.match(result.notes[0], /from the same repository/, 'and the sources DO agree — both are acme');
    assert.doesNotMatch(result.notes[0], /DIFFERENT REPOSITORIES/, 'the note must never contradict what it prints');
    assert.doesNotMatch(result.notes[0], /github:dustinkeeton/, 'a slug that appears nowhere in the evidence');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// #372 — MOVE: rewrite a pin the consumer already chose, to the pin the lock is about to record.
// Never introduce one, and never write a pin we cannot back.
// ═════════════════════════════════════════════════════════════════════════════

describe('classifyToolkitRefValue — which values are ours to move (#372)', () => {
  test('absent: an unset key is never given a pin', () => {
    assert.deepEqual(classifyToolkitRefValue(undefined), { kind: 'absent' });
    assert.deepEqual(classifyToolkitRefValue(null), { kind: 'absent' });
    assert.deepEqual(classifyToolkitRefValue('   '), { kind: 'absent' }, 'an empty value is not a pin');
  });

  test('unpinned: `github:owner/repo` floats deliberately — leave it floating', () => {
    const c = classifyToolkitRefValue('github:dustinkeeton/wafflestack');
    assert.equal(c.kind, 'unpinned');
    assert.deepEqual(c.slug, { owner: 'dustinkeeton', repo: 'wafflestack' });
  });

  test('release-pin: a `vX.Y.Z` fragment — AND the bare `X.Y.Z` mistake, which is why we read it', () => {
    const v = classifyToolkitRefValue('github:dustinkeeton/wafflestack#v0.12.0');
    assert.equal(v.kind, 'release-pin');
    assert.equal(v.fragment, 'v0.12.0');
    const bare = classifyToolkitRefValue('github:dustinkeeton/wafflestack#0.12.0');
    assert.equal(bare.kind, 'release-pin');
    assert.equal(bare.fragment, '0.12.0');
  });

  test('other-pin: `#main`, a sha, a non-release tag — a pin we did not write and cannot interpret', () => {
    assert.equal(classifyToolkitRefValue('github:dustinkeeton/wafflestack#main').kind, 'other-pin');
    assert.equal(classifyToolkitRefValue(`github:dustinkeeton/wafflestack#${SHA_A}`).kind, 'other-pin');
    assert.equal(classifyToolkitRefValue('github:dustinkeeton/wafflestack#nightly').kind, 'other-pin');
    assert.equal(classifyToolkitRefValue('github:dustinkeeton/wafflestack#v1.2').kind, 'other-pin', 'not a `vX.Y.Z`');
  });

  test('not-github: a local path, a non-github URL, a bare slug, a non-string — none of them ours', () => {
    assert.equal(classifyToolkitRefValue('../wafflestack').kind, 'not-github');
    assert.equal(classifyToolkitRefValue('/Users/dev/wafflestack').kind, 'not-github');
    // A bare `owner/repo` is as readily a relative path, and this answer decides whether a committed
    // config gets rewritten — only an explicit `github:` spec or a github.com URL qualifies.
    assert.equal(classifyToolkitRefValue('vendor/wafflestack').kind, 'not-github');
    assert.equal(classifyToolkitRefValue('vendor/wafflestack#v0.12.0').kind, 'not-github', 'even with a release fragment');
    assert.equal(classifyToolkitRefValue('https://gitlab.com/dustinkeeton/wafflestack#v0.12.0').kind, 'not-github', 'another host');
    assert.equal(classifyToolkitRefValue(42).kind, 'not-github');
    assert.equal(classifyToolkitRefValue({ toolkitRef: 'x' }).kind, 'not-github');
    assert.equal(classifyToolkitRefValue('github:').kind, 'not-github', 'unparseable behind the scheme');
  });

  // git-URL pins are READ, so a divergence can be reported, and never REWRITTEN — `form` is the
  // axis that separates those two questions.
  describe('the git-URL form is recognised, and marked as one we do not rewrite (#386 F3)', () => {
    const URLS = [
      'git+https://github.com/dustinkeeton/wafflestack#v0.12.0',
      'https://github.com/dustinkeeton/wafflestack#v0.12.0',
      'https://github.com/dustinkeeton/wafflestack.git#v0.12.0',
      'git@github.com:dustinkeeton/wafflestack.git#v0.12.0',
      'git+ssh://git@github.com/dustinkeeton/wafflestack.git#v0.12.0',
    ];

    test('a release-pinned git URL is a `release-pin`, in `url` form', () => {
      for (const url of URLS) {
        const c = classifyToolkitRefValue(url);
        assert.equal(c.kind, 'release-pin', url);
        assert.equal(c.form, 'url', url);
        assert.equal(c.fragment, 'v0.12.0', url);
        assert.deepEqual(c.slug, { owner: 'dustinkeeton', repo: 'wafflestack' }, url);
      }
    });

    test('the `github:` shorthand is the only form marked `shorthand` — the only one `upgrade` rewrites', () => {
      assert.equal(classifyToolkitRefValue('github:dustinkeeton/wafflestack#v0.12.0').form, 'shorthand');
      assert.equal(classifyToolkitRefValue('github:dustinkeeton/wafflestack').form, 'shorthand');
    });

    test('a URL carries its fragment kind across, exactly as the shorthand does', () => {
      // The kind says WHAT it is; the form says whether we may rewrite it.
      assert.equal(classifyToolkitRefValue('https://github.com/dustinkeeton/wafflestack').kind, 'unpinned', 'floating, and still floating');
      assert.equal(classifyToolkitRefValue('https://github.com/dustinkeeton/wafflestack').form, 'url');
      assert.equal(classifyToolkitRefValue('https://github.com/dustinkeeton/wafflestack#main').kind, 'other-pin');
      assert.equal(classifyToolkitRefValue(`https://github.com/dustinkeeton/wafflestack#${SHA_A}`).kind, 'other-pin');
    });

    test('the host is anchored — a lookalike or a path segment is NOT a github URL', () => {
      assert.equal(classifyToolkitRefValue('https://evil.com/github.com/o/r#v0.12.0').kind, 'not-github');
      assert.equal(classifyToolkitRefValue('https://github.com.evil.com/o/r#v0.12.0').kind, 'not-github');
    });
  });
});

describe('toolkitPinFromIdentity — the pin is DERIVED, never surgically edited (#372)', () => {
  test('a release npx toolkit yields the pin the lock is about to record — by construction', () => {
    const identity = releaseIdentity();
    assert.equal(toolkitPinFromIdentity(identity), 'github:dustinkeeton/wafflestack#v0.12.0');
    // THE COMPOSITION: what #372 writes into waffle.yaml is what #374 writes into the lock.
    assert.equal(toolkitPinFromIdentity(identity), toolkitPinFromLock({ toolkit: toolkitLockEntry(identity) }));
    assert.equal(toolkitPinFromIdentity(identity), identity.ref);
  });

  test('a CHECKOUT release yields NULL — #384 F13, inherited for free', () => {
    // `git describe` asks no remote, so a checkout records `source: null` and there is no pin to write.
    const identity = releaseIdentity({ origin: 'checkout', lockRepo: 'dustinkeeton/wafflestack' });
    assert.equal(toolkitLockEntry(identity).source, null, 'the F13 shape, on merged main');
    assert.equal(toolkitPinFromIdentity(identity), null);
  });

  test('unreleased / unverified / no identity at all yield NULL — nothing gets written', () => {
    assert.equal(toolkitPinFromIdentity(unreleasedIdentity()), null);
    assert.equal(toolkitPinFromIdentity(unverifiedIdentity()), null, 'the hatch, dlx, a blip — #383');
    assert.equal(toolkitPinFromIdentity(null), null, 'a library caller with no identity');
  });

  test('a fork pins ITSELF (#373 F14) — the fork case needs no special code', () => {
    const acme = releaseIdentity({ repo: 'acme/wafflestack', ref: 'github:acme/wafflestack#v0.12.0' });
    assert.equal(toolkitPinFromIdentity(acme), 'github:acme/wafflestack#v0.12.0');
  });
});

describe('setScalarIn — the byte-verbatim write (#372, #386)', () => {
  const PIN_PATH = ['config', 'doctor', 'toolkitRef'];
  const OLD = 'github:dustinkeeton/wafflestack#v0.12.0';
  const NEW = 'github:dustinkeeton/wafflestack#v0.13.0';

  // A "verbatim" write means the output is the input with the PIN'S BYTES swapped and nothing else
  // moved — a substring match passes just as happily on a file the serializer has re-laid-out.
  const assertOnlyThePinMoved = (src, out) =>
    assert.equal(out, src.replaceAll(OLD, NEW), 'the pin moved; every other byte must be where it was');

  test('BYTE-VERBATIM: only the pin’s own bytes change — the rest of the file is untouched', () => {
    // Every element here is one `doc.toString()` demonstrably reflows (#386) — that is what makes
    // this test non-vacuous.
    const src = [
      '# the pin CI fetches',
      'targets: [claude]',
      'stacks:',
      '  - github-workflow',
      'config:',
      '  project:',
      '    description: A description that is deliberately longer than the eighty columns yaml folds a plain scalar at',
      '  # bumped by hand on 2026-07-01, see #322',
      '  doctor:',
      `    toolkitRef: ${OLD}  # pinned deliberately`,
      '    flags: --verify-render',
      '  # trailing note under the block',
      '',
    ].join('\n');

    const out = setScalarIn(src, PIN_PATH, NEW);
    assertOnlyThePinMoved(src, out);
    assert.match(out, /^targets: \[claude\]$/m, 'the flow collection is not re-padded to `[ claude ]`');
    assert.match(out, /^ {4}description: A description .{40,}columns yaml folds a plain scalar at$/m, 'not folded at 80');
    assert.match(out, new RegExp(`toolkitRef: ${NEW.replace(/[.#/]/g, '\\$&')} {2}# pinned deliberately$`, 'm'), 'the comment keeps its own spacing');
    assert.doesNotMatch(out, /v0\.12\.0/);
  });

  test('quoting style survives — the token is re-emitted in the node’s own type', () => {
    const src = `config:\n  waffle:\n    toolkitRef: "${OLD}"\n`;
    const out = setScalarIn(src, ['config', 'waffle', 'toolkitRef'], NEW);
    assert.equal(out, `config:\n  waffle:\n    toolkitRef: "${NEW}"\n`);
  });

  test('a single-quoted pin stays single-quoted', () => {
    const src = `config:\n  doctor:\n    toolkitRef: '${OLD}'\n`;
    assert.equal(setScalarIn(src, PIN_PATH, NEW), `config:\n  doctor:\n    toolkitRef: '${NEW}'\n`);
  });

  test('a BLOCK scalar cannot be spliced, so it falls back to a re-serialize — correct, not verbatim', () => {
    // The one shape the splice refuses (block header + indentation) — the value must still land.
    const src = `config:\n  doctor:\n    toolkitRef: >-\n      ${OLD}\n`;
    const out = setScalarIn(src, PIN_PATH, NEW);
    assert.equal(YAML.parse(out).config.doctor.toolkitRef, NEW, 'the pin still moved');
  });

  test('it NEVER creates: a missing key, a missing parent, and a non-scalar all return null', () => {
    const src = 'config:\n  doctor: {}\n';
    assert.equal(setScalarIn(src, PIN_PATH, 'x'), null, 'missing key');
    assert.equal(setScalarIn(src, ['config', 'waffle', 'toolkitRef'], 'x'), null, 'missing parent');
    assert.equal(setScalarIn(src, ['config', 'doctor'], 'x'), null, 'a map is not a scalar');
  });

  test('a FLAT literal key is not found — matching `lookupPath`, which never resolves one', () => {
    // A literal `doctor.toolkitRef:` key is INERT — `lookupPath` walks NESTED objects — so rewriting
    // it would be a lie.
    assert.equal(setScalarIn(`config:\n  doctor.toolkitRef: ${OLD}\n`, PIN_PATH, NEW), null);
  });

  test('setting the value it already holds is not a change — the dirty guard can trust null', () => {
    assert.equal(setScalarIn(`config:\n  doctor:\n    toolkitRef: ${OLD}\n`, PIN_PATH, OLD), null);
  });

  test('a config that does not parse is never half-written', () => {
    assert.equal(setScalarIn('config:\n  doctor:\n   toolkitRef: [unclosed\n', PIN_PATH, NEW), null);
  });

  // `setIn` DOES keep the comments on a scalar→scalar overwrite (#386); what #372 forbids is
  // CREATING a pin the consumer never chose.
  test('the REAL contract: `doc.setIn` would CREATE the pin — which is what #372 forbids', () => {
    const doc = YAML.parseDocument('config:\n  doctor: {}\n');
    doc.setIn(PIN_PATH, NEW);
    assert.match(doc.toString(), /toolkitRef: github/, 'setIn invents a pin the consumer never chose…');
    assert.equal(setScalarIn('config:\n  doctor: {}\n', PIN_PATH, NEW), null, '…and setScalarIn refuses to');

    const live = YAML.parseDocument(`config:\n  doctor:\n    toolkitRef: ${OLD} # pinned deliberately\n`);
    live.setIn(PIN_PATH, NEW);
    assert.match(live.toString(), /# pinned deliberately/, 'setIn does NOT drop comments (yaml v2)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The write, end to end, over a fixture toolkit that declares BOTH keys and renders BOTH
// placeholders — so the sequencing claim (config → render → lock, one run) is provable.
// ─────────────────────────────────────────────────────────────────────────────

describe('upgrade moves the pinned toolkitRef keys (#372)', () => {
  let toolkitRoot;
  let cwd;
  let logged;
  const log = (line) => logged.push(String(line));

  const configPath = () => path.join(cwd, '.waffle/waffle.yaml');
  const configBytes = () => fs.readFileSync(configPath(), 'utf8');
  const skillPath = () => path.join(cwd, '.claude/skills/alpha/SKILL.md');
  const ciPath = () => path.join(cwd, '.claude/skills/ci/SKILL.md');

  /** The consumer's committed config, with whatever the test wants under `config:`. */
  const writeConfig = (body) => write(cwd, '.waffle/waffle.yaml', `targets: [claude]\nstacks: [core]\n${body}`);

  /** Both keys pinned to the same release-shaped value. The shape the docs told consumers to write. */
  const pinnedConfig = (doctorRef, waffleRef = doctorRef) =>
    `config:\n  doctor:\n    toolkitRef: ${doctorRef}\n  waffle:\n    toolkitRef: ${waffleRef}\n`;

  /** A toolkit at `version`, installed the way every consumer installs one (npx → npm-install). */
  const at = (version, over = {}) =>
    releaseIdentity({
      version,
      tag: `v${version}`,
      ref: `github:dustinkeeton/wafflestack#v${version}`,
      latestTag: `v${version}`,
      commit: SHA_B,
      ...over,
    });

  const runUpgrade = (toolkitIdentity, toolkitVersion) =>
    upgrade({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity, changelog: '# Changelog\n', migrations: [], log });

  beforeEach(() => {
    logged = [];
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov372-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov372-project-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: fixture\nstacks: [core]\n');
    // The fixture stack declares both keys and renders both placeholders, so one `upgrade` is shown
    // moving config, render and lock together.
    write(
      toolkitRoot,
      'stacks/core/stack.yaml',
      [
        'name: core',
        'description: Core.',
        'skills: [alpha, ci]',
        'config:',
        '  waffle.toolkitRef:',
        '    required: false',
        '    default: github:dustinkeeton/wafflestack',
        '    description: npx spec the waffle-* skills invoke.',
        '  doctor.toolkitRef:',
        '    required: false',
        '    default: github:dustinkeeton/wafflestack',
        '    description: npx spec the doctor CI workflow invokes.',
        '',
      ].join('\n'),
    );
    write(toolkitRoot, 'stacks/core/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Alpha.\n---\n\nnpx --yes {{waffle.toolkitRef}} doctor\n');
    write(toolkitRoot, 'stacks/core/skills/ci/SKILL.md', '---\nname: ci\ndescription: Ci.\n---\n\nnpx --yes {{doctor.toolkitRef}} doctor\n');
  });
  afterEach(() => {
    for (const d of [toolkitRoot, cwd]) fs.rmSync(d, { recursive: true, force: true });
  });

  test('BOTH pinned keys move to the pin the lock records, and both are reported', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(result.ok, true);
    const text = configBytes();
    assert.match(text, /doctor:\n {4}toolkitRef: github:dustinkeeton\/wafflestack#v0\.13\.0/);
    assert.match(text, /waffle:\n {4}toolkitRef: github:dustinkeeton\/wafflestack#v0\.13\.0/);
    assert.doesNotMatch(text, /v0\.12\.0/);

    assert.deepEqual(
      result.pinMoves.map((m) => [m.key, m.from, m.to, m.action]),
      [
        ['doctor.toolkitRef', 'github:dustinkeeton/wafflestack#v0.12.0', 'github:dustinkeeton/wafflestack#v0.13.0', 'bumped'],
        ['waffle.toolkitRef', 'github:dustinkeeton/wafflestack#v0.12.0', 'github:dustinkeeton/wafflestack#v0.13.0', 'bumped'],
      ],
    );
    const out = logged.join('\n');
    assert.match(out, /doctor\.toolkitRef github:dustinkeeton\/wafflestack#v0\.12\.0 → github:dustinkeeton\/wafflestack#v0\.13\.0/);
    assert.match(out, /waffle\.toolkitRef github:dustinkeeton\/wafflestack#v0\.12\.0 → github:dustinkeeton\/wafflestack#v0\.13\.0/);
  });

  test('THE SEQUENCING PROOF: one run bakes the NEW pin into the rendered files and the lock', () => {
    // The write lands AFTER migrations and BEFORE render, and `renderProject` re-reads waffle.yaml
    // from disk — so the same run renders the moved value and hashes it into the lock.
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    assert.match(fs.readFileSync(skillPath(), 'utf8'), /v0\.12\.0/, 'the OLD pin is what rendered before');

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(result.ok, true, JSON.stringify(result.render?.errors));
    assert.match(fs.readFileSync(skillPath(), 'utf8'), /npx --yes github:dustinkeeton\/wafflestack#v0\.13\.0 doctor/, 'the waffle-* skills');
    assert.match(fs.readFileSync(ciPath(), 'utf8'), /npx --yes github:dustinkeeton\/wafflestack#v0\.13\.0 doctor/, 'the doctor workflow');

    assert.equal(result.doctor.ok, true, JSON.stringify(result.doctor?.modified));
    assert.equal(result.doctor.modified.length, 0);
  });

  test('THE CONTRACT: what waffle.yaml now says === what the lock says === identity.ref', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });

    const identity = at('0.13.0');
    runUpgrade(identity, '0.13.0');

    const written = YAML.parse(configBytes()).config.doctor.toolkitRef;
    const fromLock = toolkitPinFromLock(readLock(cwd));
    assert.equal(written, fromLock, 'the pin CI fetches IS the pin the lock records — the whole issue');
    assert.equal(written, identity.ref);
    assert.equal(written, toolkitRef({ owner: 'dustinkeeton', repo: 'wafflestack' }, 'v0.13.0'));
    assert.equal(YAML.parse(configBytes()).config.waffle.toolkitRef, written);
  });

  test('`status: current` STILL reconciles — the already-red-CI repo heals itself', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.13.0', toolkitIdentity: at('0.13.0', { commit: SHA_A }) });

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(result.status, 'current', 'no version move at all…');
    assert.match(logged.join('\n'), /already on toolkit 0\.13\.0/);
    assert.equal(result.pinMoves.filter((m) => m.action === 'bumped').length, 2, '…and both pins moved anyway');
    assert.match(configBytes(), /#v0\.13\.0/);
    assert.doesNotMatch(configBytes(), /#v0\.12\.0/);
  });

  test('a bare `#0.12.0` — a tag that never existed — is rewritten to the real `v`-prefixed one', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });

    runUpgrade(at('0.13.0'), '0.13.0');
    assert.match(configBytes(), /toolkitRef: github:dustinkeeton\/wafflestack#v0\.13\.0/);
    assert.doesNotMatch(configBytes(), /#0\.13\.0\b/, 'style preservation would have written a tag that does not resolve');
  });

  test('comments and formatting survive the rewrite, VERBATIM — byte for byte but the pins (#386)', () => {
    // Written whole, not through `writeConfig`, so the assertion owns EVERY byte of the file.
    const before = [
      '# CI fetches this exact toolkit — see docs/gitignore.md',
      'targets: [claude]',
      'stacks: [core]',
      'config:',
      '  doctor:',
      '    toolkitRef: github:dustinkeeton/wafflestack#v0.12.0  # pinned deliberately (#322)',
      '    flags: --verify-render',
      '  waffle:',
      '    toolkitRef: "github:dustinkeeton/wafflestack#v0.12.0"',
      '  # everything below is ours',
      '  project:',
      '    name: Consumer',
      '    description: A description deliberately longer than the eighty columns at which yaml folds a plain scalar',
      '',
    ].join('\n');
    write(cwd, '.waffle/waffle.yaml', before);
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });

    runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before.replaceAll('#v0.12.0', '#v0.13.0'), 'only the two pins may move');
  });

  test('NO-OP, BYTE FOR BYTE: an absent key is never given a pin — and the file is never WRITTEN', () => {
    // Introducing a pin where the consumer has none would silently change what their CI fetches.
    writeConfig('config: {}\n');
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();
    // Since #386 the write is byte-verbatim, so "wrote the same bytes back" and "did not write" are
    // indistinguishable by content — the mtime is what catches a dropped dirty guard.
    const aged = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath(), aged, aged);
    const untouched = fs.statSync(configPath()).mtimeMs; // fs-reported, not `aged.getTime()`: APFS keeps
    // nanoseconds, and reading them back as a float lands a hair off the integer we asked for.

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before, 'not one byte');
    assert.equal(fs.statSync(configPath()).mtimeMs, untouched, 'and the file was never opened for writing');
    assert.deepEqual(result.pinMoves, []);
    assert.doesNotMatch(logged.join('\n'), /toolkitRef/, 'and not one line of noise about a non-event');
  });

  test('NO-OP, BYTE FOR BYTE: an unpinned `github:owner/repo` is deliberately floating', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before);
    assert.deepEqual(result.pinMoves, []);
  });

  test('NO-OP, BYTE FOR BYTE: a local-path ref (toolkit development) is left alone', () => {
    writeConfig(pinnedConfig('../wafflestack', '/Users/dev/wafflestack'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before);
    assert.deepEqual(result.pinMoves, []);
  });

  test('`#main` and a raw sha are left alone — and SAID so, not silently skipped', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#main', `github:dustinkeeton/wafflestack#${SHA_A}`));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before, 'left exactly as authored');
    assert.deepEqual(result.pinMoves.map((m) => [m.key, m.action]), [['doctor.toolkitRef', 'left'], ['waffle.toolkitRef', 'left']]);
    const out = logged.join('\n');
    assert.match(out, /doctor\.toolkitRef is pinned to `#main`, which is not a release tag/);
    assert.match(out, new RegExp(`waffle\\.toolkitRef is pinned to \`#${SHA_A}\``));
  });

  test('a release-pinned GIT URL is left alone — and SAID so, with the remedy, while the other key moves', () => {
    writeConfig(pinnedConfig('git+https://github.com/dustinkeeton/wafflestack#v0.12.0', 'github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');

    // BYTE IDENTITY: the only bytes that move are the shorthand pin's; the URL pin is left alone.
    assert.equal(
      configBytes(),
      before.replace('github:dustinkeeton/wafflestack#v0.12.0', 'github:dustinkeeton/wafflestack#v0.13.0'),
      'the shorthand pin moved; the URL pin and every other byte stayed put',
    );
    assert.match(configBytes(), /toolkitRef: git\+https:\/\/github\.com\/dustinkeeton\/wafflestack#v0\.12\.0/, 'left exactly as authored');

    assert.deepEqual(
      result.pinMoves.map((m) => [m.key, m.action, m.to]),
      [
        ['doctor.toolkitRef', 'left', null],
        ['waffle.toolkitRef', 'bumped', 'github:dustinkeeton/wafflestack#v0.13.0'],
      ],
      'the skipped key is REPORTED, and reports no `to` — nothing was written',
    );

    const out = logged.join('\n');
    assert.match(out, /doctor\.toolkitRef still pins git\+https:\/\/github\.com\/dustinkeeton\/wafflestack#v0\.12\.0 and was NOT reconciled/);
    assert.match(out, /written as a git URL, which `upgrade` does not rewrite/, 'says WHY');
    assert.match(out, /CI would fetch a DIFFERENT toolkit than the one that rendered it/, 'names the divergence');
    assert.match(out, /replace it with: github:dustinkeeton\/wafflestack#v0\.13\.0/, 'names the remedy');
  });

  test('every git-URL spelling is caught — https, git+https, scp-style ssh, git+ssh', () => {
    // One test per form would pin the same branch four times; what matters is that no spelling slips
    // back into the silent `not-github` bucket.
    for (const url of [
      'https://github.com/dustinkeeton/wafflestack#v0.12.0',
      'git+https://github.com/dustinkeeton/wafflestack#v0.12.0',
      'git@github.com:dustinkeeton/wafflestack.git#v0.12.0',
      'git+ssh://git@github.com/dustinkeeton/wafflestack.git#v0.12.0',
    ]) {
      logged = [];
      writeConfig(pinnedConfig(url, 'github:dustinkeeton/wafflestack#v0.12.0'));
      const moves = reconcileToolkitRefPins({ cwd, identity: at('0.13.0'), log });
      assert.deepEqual(moves.map((m) => [m.key, m.action]), [['doctor.toolkitRef', 'left'], ['waffle.toolkitRef', 'bumped']], url);
      assert.match(logged.join('\n'), /was NOT reconciled/, url);
    }
  });

  test('a git URL that ALREADY names the toolkit that rendered says NOTHING — it must not cry wolf', () => {
    // Same pin, different notation — a warning here would fire on a consumer who is already correct.
    writeConfig(pinnedConfig('git+https://github.com/dustinkeeton/wafflestack#v0.13.0', 'github:dustinkeeton/wafflestack#v0.13.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.13.0', toolkitIdentity: at('0.13.0', { commit: SHA_B }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before, 'still a zero-byte no-op');
    assert.deepEqual(result.pinMoves.map((m) => m.action), ['unchanged', 'unchanged']);
    assert.doesNotMatch(logged.join('\n'), /NOT reconciled/, 'nothing diverges, so nothing is said');
  });

  test('a git URL naming a DIFFERENT repo diverges even at the same tag — and is reported', () => {
    // The fragment matches but the repo does not: matching the tag is not enough.
    writeConfig(pinnedConfig('https://github.com/acme/wafflestack#v0.13.0', 'github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before.replace('#v0.12.0', '#v0.13.0'), 'only the shorthand key moved');
    assert.deepEqual(result.pinMoves.map((m) => [m.key, m.action]), [['doctor.toolkitRef', 'left'], ['waffle.toolkitRef', 'bumped']]);
    assert.match(logged.join('\n'), /doctor\.toolkitRef still pins https:\/\/github\.com\/acme\/wafflestack#v0\.13\.0 and was NOT reconciled/);
  });

  test('an already-correct pin is a zero-byte no-op, reported as `unchanged` — idempotence', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.13.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.13.0', toolkitIdentity: at('0.13.0', { commit: SHA_B }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before);
    assert.deepEqual(result.pinMoves.map((m) => m.action), ['unchanged', 'unchanged']);
  });

  test('a NON-RELEASE toolkit never writes a pin — and says why it did not', () => {
    // Read `ref == null` as "no provenance captured", NEVER as "not a release".
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(unverifiedIdentity({ version: '0.13.0', latestTag: 'v0.13.0' }), '0.13.0');
    assert.equal(configBytes(), before, 'not one byte, on an unverified run');
    assert.deepEqual(result.pinMoves.map((m) => m.action), ['skipped', 'skipped']);
    const out = logged.join('\n');
    assert.match(out, /doctor\.toolkitRef still pins github:dustinkeeton\/wafflestack#v0\.12\.0 and was NOT reconciled/);
    assert.match(out, /is unverified, so it has no release ref to pin to/);
  });

  test('a release CHECKOUT never writes a pin either (#384 F13) — no remote corroborated the tag', () => {
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0', { origin: 'checkout', lockRepo: 'dustinkeeton/wafflestack' }), '0.13.0');
    assert.equal(configBytes(), before, 'a toolkit dev\'s clone never rewrites a consumer\'s committed pin');
    assert.deepEqual(result.pinMoves.map((m) => m.action), ['skipped', 'skipped']);
    assert.match(logged.join('\n'), /release CHECKOUT — no remote was asked/);
  });

  test('a FORK keeps its own owner/repo, because the pin names the toolkit that rendered', () => {
    writeConfig(pinnedConfig('github:acme/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A, repo: 'acme/wafflestack', ref: 'github:acme/wafflestack#v0.12.0' }) });

    const result = runUpgrade(at('0.13.0', { repo: 'acme/wafflestack', ref: 'github:acme/wafflestack#v0.13.0' }), '0.13.0');
    assert.match(configBytes(), /toolkitRef: github:acme\/wafflestack#v0\.13\.0/);
    assert.equal(result.pinMoves[0].to, 'github:acme/wafflestack#v0.13.0');
    assert.doesNotMatch(logged.join('\n'), /DIFFERENT REPOSITORY/, 'acme → acme is not a repo swap');
  });

  test('a CROSS-REPO rewrite is truthful — and loud', () => {
    writeConfig(pinnedConfig('github:acme/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A, repo: 'acme/wafflestack', ref: 'github:acme/wafflestack#v0.12.0' }) });

    runUpgrade(at('0.13.0'), '0.13.0'); // upstream
    assert.match(configBytes(), /toolkitRef: github:dustinkeeton\/wafflestack#v0\.13\.0/);
    assert.match(logged.join('\n'), /DIFFERENT REPOSITORY \(acme\/wafflestack → dustinkeeton\/wafflestack\)/);
  });

  test('the gitignored overlay is neither read nor written (#317)', () => {
    // `waffle.local.yaml` is private tooling: it must neither trigger a write to the committed file
    // nor receive one itself.
    writeConfig('config: {}\n'); // the COMMITTED file pins nothing
    write(cwd, '.waffle/waffle.local.yaml', pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const committed = configBytes();
    const overlay = fs.readFileSync(path.join(cwd, '.waffle/waffle.local.yaml'), 'utf8');

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), committed, 'the committed file has no pin, and gains none');
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.local.yaml'), 'utf8'), overlay, 'and the overlay is never touched');
    assert.deepEqual(result.pinMoves, []);
  });

  test('reconcileToolkitRefPins is callable on its own, and a missing config is a clean no-op', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'prov372-empty-'));
    try {
      assert.deepEqual(reconcileToolkitRefPins({ cwd: empty, identity: at('0.13.0') }), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a config that does not parse is left untouched, with a note — never half-written', () => {
    write(cwd, '.waffle/waffle.yaml', 'config:\n  doctor:\n    toolkitRef: "unterminated\n');
    const before = configBytes();
    const moves = reconcileToolkitRefPins({ cwd, identity: at('0.13.0'), log });
    assert.deepEqual(moves, []);
    assert.equal(configBytes(), before);
    assert.match(logged.join('\n'), /did not parse cleanly; leaving it untouched/);
  });

  test('a write that does not land is reported `unwritable`, to: null — never a bump we did not make (#387)', () => {
    // Driven through the `writeScalar` seam — no config input reaches a null return on its own.
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    const before = configBytes();
    const moves = reconcileToolkitRefPins({ cwd, identity: at('0.13.0'), log, writeScalar: () => null });
    assert.deepEqual(
      moves.map((m) => [m.key, m.from, m.to, m.action]),
      [
        ['doctor.toolkitRef', 'github:dustinkeeton/wafflestack#v0.12.0', null, 'unwritable'],
        ['waffle.toolkitRef', 'github:dustinkeeton/wafflestack#v0.12.0', null, 'unwritable'],
      ],
      'to is null and the action is unwritable — no pin was written, so none is claimed',
    );
    assert.equal(configBytes(), before, 'and nothing was written to disk');
    assert.match(logged.join('\n'), /doctor\.toolkitRef still pins github:dustinkeeton\/wafflestack#v0\.12\.0 and was NOT reconciled/);
    assert.match(logged.join('\n'), /could not be rewritten in place/, 'says WHY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The self-upgrade trap: a pinned CLI cannot run the toolkit that would fix it — but it KNOWS it.
// ─────────────────────────────────────────────────────────────────────────────

describe('upgrade reports a newer release, and names the exact command (#372)', () => {
  let toolkitRoot;
  let cwd;
  let logged;
  const log = (line) => logged.push(String(line));

  beforeEach(() => {
    logged = [];
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov372-newer-toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prov372-newer-project-'));
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

  test('a pinned CLI one release behind names the command that escapes the trap — and does NOT re-exec', () => {
    const identity = releaseIdentity({ version: '0.13.0', tag: 'v0.13.0', ref: 'github:dustinkeeton/wafflestack#v0.13.0', latestTag: 'v0.14.0' });
    const result = runUpgrade(identity, '0.13.0');
    assert.deepEqual(result.newerRelease, { tag: 'v0.14.0', command: 'npx --yes github:dustinkeeton/wafflestack#v0.14.0 upgrade' });
    const out = logged.join('\n');
    assert.match(out, /a newer toolkit release exists: v0\.14\.0/);
    assert.match(out, /npx --yes github:dustinkeeton\/wafflestack#v0\.14\.0 upgrade/);
    assert.equal(readLock(cwd).toolkitVersion, '0.13.0');
  });

  test('a fork\'s newer release names the FORK\'S command, not upstream\'s', () => {
    const identity = releaseIdentity({ version: '0.13.0', tag: 'v0.13.0', ref: 'github:acme/wafflestack#v0.13.0', repo: 'acme/wafflestack', latestTag: 'v0.14.0' });
    const result = runUpgrade(identity, '0.13.0');
    assert.equal(result.newerRelease.command, 'npx --yes github:acme/wafflestack#v0.14.0 upgrade');
  });

  test('the latest release IS this CLI → nothing to say, and no note', () => {
    const result = runUpgrade(releaseIdentity({ version: '0.13.0', tag: 'v0.13.0', latestTag: 'v0.13.0' }), '0.13.0');
    assert.equal(result.newerRelease, null);
    assert.doesNotMatch(logged.join('\n'), /newer toolkit release/);
  });

  test('no identity at all (a library caller) → no note, no crash', () => {
    const result = runUpgrade(null, '0.13.0');
    assert.equal(result.newerRelease, null);
    assert.deepEqual(result.pinMoves, []);
  });
});
