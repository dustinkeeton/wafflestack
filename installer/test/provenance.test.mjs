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
          resolveToolkitIdentity({ toolkitRoot: root, runGit: clone(originUrl) }),
          { toolkitVersion: '0.12.0' },
        );

      const upstream = blockFor('https://github.com/dustinkeeton/wafflestack.git');
      const forked = blockFor('git@github.com:contributor/wafflestack.git');

      assert.deepEqual(forked, upstream, 'the committed lock cannot depend on which clone rendered it');
      assert.equal(upstream.source, 'github:dustinkeeton/wafflestack');
      // …while the value the NETWORK path needs still tracks the clone in hand (#373 F14 intact).
      assert.equal(resolveToolkitIdentity({ toolkitRoot: root, runGit: clone('git@github.com:contributor/wafflestack.git') }).repo, 'contributor/wafflestack');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a checkout on a RELEASE TAG asks NO remote — so it records NO source (#384 F11, F13)', () => {
    // The counted stub is the whole point, and it now carries TWO findings. The `release` carve-out was
    // justified by "`ls-remote` asked THAT remote"; this proves no remote is asked at all on a checkout —
    // `git describe --exact-match` decides it offline and `resolveToolkitIdentity` returns before the
    // lookup. F11 concluded "so record the DECLARED repo, which at least is deterministic". F13 showed
    // that conclusion still wrote a lie: `source` + `ref` ARE the pin (`toolkitPinFromLock` is
    // `` `${source}#${ref}` ``), so naming the declared repo CLAIMS that repo holds this tag — and the
    // 0 ls-remote calls this test counts are the proof that nobody ever checked. Zero corroboration
    // must buy zero claims: the block records `source: null` and pins nothing.
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

  test('identity is hatch-independent — an unreleased checkout is `unreleased`, ref null (#383)', () => {
    // `--allow-unreleased` is a cli.mjs refusal-suppressor, not an argument to `resolveToolkitIdentity`
    // (the gate matrix drives that end). Identity itself only ever tells the truth: this keeps the lock
    // #374 writes honest rather than merely permitted.
    advance('unreleased work');
    const id = resolveToolkitIdentity({ toolkitRoot: work, lsRemote: forbidNetwork });
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

  test('the lookup is skippable ONLY by `offline` — a genuine release pin keeps its `ref` (#383)', () => {
    const root = layout({ resolved: `git+https://github.com/dustinkeeton/wafflestack.git#${SHA_A}` });
    // Online (the default). There is no `allowUnreleased` argument that could short-circuit the
    // lookup — that WAS the #383 bug: the hatch forfeited a release you genuinely had. Now a
    // release-pinned npx install resolves `release`, ref intact, and the hatch (cli.mjs) only
    // suppresses the refusal it would never have raised for a release anyway.
    const online = resolveToolkitIdentity({ toolkitRoot: root, lsRemote: fakeLsRemote([`${SHA_A}\trefs/tags/v0.12.0`]) });
    assert.equal(online.status, 'release');
    assert.equal(online.ref, 'github:dustinkeeton/wafflestack#v0.12.0');
  });

  test('`offline: true` (plain doctor, the banner, `--offline`) skips the lookup — never a release', () => {
    // The air-gapped escape: fail OPEN (no stall on a doomed `ls-remote`), and never MANUFACTURE a
    // release. `forbidNetwork` fails the test if the lookup is attempted at all.
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

  test('`--allow-unreleased` and `--offline` are accepted by every command, not just the gated ones', () => {
    // Both flags are stripped globally, before any "takes no refs" guard runs — otherwise they would
    // be rejected as stray refs by exactly the commands that need them least.
    for (const flag of ['--allow-unreleased', '--offline']) {
      for (const cmd of ['render', 'upgrade', 'reinstall', 'list', 'doctor']) {
        const r = allowed([cmd, flag]);
        assert.doesNotMatch(r.stderr, /takes no refs/, `${cmd} must not treat ${flag} as a ref`);
      }
    }
  });

  test('`--offline` renders under the hatch without stalling — the air-gapped shape (#383)', () => {
    // An air-gapped CI: `--allow-unreleased` (don't refuse me) + `--offline` (don't pay for the
    // answer). The lookup is skipped, so nothing waits on a doomed `ls-remote`; the render proceeds.
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
// The CLI's own flag wiring, driven end-to-end (#383 / PR #419 QA). Every other spawned-CLI test
// resolves THIS checkout — origin `checkout`, answered by `git describe`, never `ls-remote` — so
// reverting cli.mjs's identity() to `offline: offline || allowUnreleased` (the exact #383
// conflation) left the whole suite green. These spawns run a COPY of the toolkit from a fabricated
// release-pinned npx-install layout, with a stub `git` on PATH recording its invocations, so the
// CLI's flag plumbing is the only thing deciding whether the lookup runs.
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

/**
 * The same release, rendered from a CHECKOUT — and it names no repo (#384 F13). `git describe` reads
 * the clone's local tag refs and asks no remote, so nothing corroborates that ANY repo holds this tag;
 * `source` + `ref` are a pin, and a pin is a claim. The local facts (`ref`, `commit`, `status`) are
 * recorded because they are real and checkable; the repo is not, because it is not.
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

  test('a RELEASE is NOT an exception — a checkout records NO source at all (#384 F11, F13)', () => {
    // This test has now asserted three different things, and the journey IS the finding. F2's first fix
    // carved `release` out of "the lock records the pin, not the clone", on the reasoning that
    // `identity.repo` had been "corroborated" by `ls-remote`. F11 showed that is false on a CHECKOUT —
    // `release` is decided offline by `git describe --exact-match` and the function returns before any
    // lookup, ZERO ls-remote calls — and concluded: record the DECLARED repo, which is at least
    // deterministic. F13 showed that STILL wrote a lie, because `source` is not a label, it is half of
    // a PIN (`toolkitPinFromLock` === `` `${source}#${ref}` ``): naming the declared repo asserts that
    // repo holds this tag, and on a checkout nobody asked it. A fork clean on its own `v1.0.0`, carrying
    // upstream's `repository` verbatim, pinned `github:dustinkeeton/wafflestack#v1.0.0` — a repo that
    // never cut that tag.
    //
    // Determinism was never the whole obligation; it was one of two. `null` satisfies BOTH: no clone
    // leaks in, and no unverified repo is named. NOTE `origin: 'checkout'` — the fixture used to say
    // `npm-install` while its name said checkout, so it never once exercised the path it was guarding.
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
    // The checkout twin of the npx fork test above, which was the ONLY path that pinned this property —
    // and on the checkout it was false. THE REALISTIC FORK: `gh repo fork`, cut `v1.0.0`, push, change
    // nothing else. `repository` still says upstream (`repoSlug`'s docblock: "nothing prompts anyone to
    // rewrite it"), `origin` says acme, and `git describe` reads acme's OWN tag out of the local refs.
    //
    // The two candidate sources are BOTH wrong here, which is why the answer is neither:
    //   - `repo` (acme, from origin)      → correct repo, but it is the CLONE — F2/F11 nondeterminism.
    //   - `lockRepo` (dustinkeeton)       → deterministic, and a pin for a tag upstream NEVER CUT.
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

  test('a FORK CHECKOUT\'s genuine re-cut reads `recut`, not DIFFERENT REPOSITORIES (#384 F13)', () => {
    // #374's headline, INVERTED for the fork population this PR exists to serve — and the writer is what
    // fixed it. The lock was written by the fork's own checkout render, so under F13 its `source` was the
    // DECLARED repo (upstream, inherited) while the CLI's was `origin` (acme): apples to oranges, and the
    // comparison then labelled ONE repo with a re-cut tag as TWO repos whose tags "need not have moved",
    // with a remedy pointing at a toolkit that did not produce the lock.
    //
    // Now the checkout records `source: null` — it corroborated no repo, so it names none — and the
    // comparison falls to F12's hedge: still `recut` (the commits DID move), with the cause honestly
    // hedged rather than a repo split invented out of a `package.json` field nobody rewrote.
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
    // The reader-side fix F13's review proposed — compare `lockToolkit.source` against
    // `toolkitSource(identity.lockRepo ?? identity.repo)` — and the reason it is NOT the fix. It reds
    // right here, and the note it produces refutes itself in one sentence.
    //
    // A lock rendered by the fork VIA NPX carries a CORROBORATED source (`ls-remote` found v0.12.0 on
    // that commit in acme's remote). The CLI is a CHECKOUT of that same fork: `origin` = acme, declared
    // `repository` = upstream (inherited). One repository; the tag was re-cut. Reading `lockRepo` for the
    // CLI's side compares acme against dustinkeeton, returns `mismatch`, and prints:
    //
    //   "the lock was rendered by github:acme/wafflestack#v0.12.0 @ aaaa…; this CLI is
    //    github:acme/wafflestack#v0.12.0 @ bbbb…. These are DIFFERENT REPOSITORIES"
    //
    // — two IDENTICAL sources, declared different. `cliWho` is built from `identity.ref`, which is
    // origin-derived (#373 F14, and it must stay so: the remedy has to name the toolkit in your hand).
    // So a verdict computed from a DIFFERENT slug than the sentence prints is F12's self-contradiction
    // class, and it re-inverts the very diagnosis F13 is about. The CLI has ONE self-identification, and
    // this is it.
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
// #372 — MOVE. The last link of epic #377: resolve (#373) → record (#374) → move.
//
// `upgrade` moved the toolkit forward everywhere except the two places that decide WHICH TOOLKIT
// ACTUALLY RUNS: `doctor.toolkitRef` (CI's doctor job) and `waffle.toolkitRef` (every `/waffle-*`
// skill). They are plain config in `.waffle/waffle.yaml`, and `upgrade` never wrote that file — so a
// consumer who followed the REQUIRED PRACTICE and pinned ended up with a lock rendered by the NEW
// toolkit and a CI job re-rendering with the OLD one. The two disagree, and the next unrelated PR
// goes red for a change nobody made.
//
// The rule under test, in one sentence: **rewrite a pin the consumer already chose, to the pin the
// lock is about to record — never introduce one, never write a pin we cannot back.**
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
    // A release tag is ALWAYS `v`-prefixed (RELEASE_TAG), so `#0.12.0` names a tag that does not
    // exist. Recognising it is precisely how `upgrade` fixes it: we read the bare form and write the
    // real one. "Preserving the authored style" would write another tag that does not resolve.
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
    // A BARE `owner/repo` parses as a slug (`parseRepoSlug` takes it) and is still not a candidate:
    // `vendor/wafflestack` is a relative path as readily as a slug, and this answer decides whether a
    // consumer's committed config gets rewritten. Only an explicit `github:` spec or github.com URL qualifies.
    assert.equal(classifyToolkitRefValue('vendor/wafflestack').kind, 'not-github');
    assert.equal(classifyToolkitRefValue('vendor/wafflestack#v0.12.0').kind, 'not-github', 'even with a release fragment');
    assert.equal(classifyToolkitRefValue('https://gitlab.com/dustinkeeton/wafflestack#v0.12.0').kind, 'not-github', 'another host');
    assert.equal(classifyToolkitRefValue(42).kind, 'not-github');
    assert.equal(classifyToolkitRefValue({ toolkitRef: 'x' }).kind, 'not-github');
    assert.equal(classifyToolkitRefValue('github:').kind, 'not-github', 'unparseable behind the scheme');
  });

  // ── the git-URL form (#386 F3) ────────────────────────────────────────────────────────────────
  // These used to fall in with local paths as `not-github` and be skipped in SILENCE, so a consumer
  // who pinned in URL form watched `doctor.toolkitRef` and the lock diverge with no output at all.
  // They are npx specs the rendered `npx --yes <ref> doctor` line resolves, and no `pattern:` in
  // either key's schema rejects one. They are now READ (so the divergence can be reported) and still
  // never REWRITTEN — `form` is the axis that separates those two questions.
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
      // Same value, same kind, different form. The kind says WHAT it is; the form says whether we may
      // rewrite it. Folding the two together is what produced the silent skip.
      assert.equal(classifyToolkitRefValue('https://github.com/dustinkeeton/wafflestack').kind, 'unpinned', 'floating, and still floating');
      assert.equal(classifyToolkitRefValue('https://github.com/dustinkeeton/wafflestack').form, 'url');
      assert.equal(classifyToolkitRefValue('https://github.com/dustinkeeton/wafflestack#main').kind, 'other-pin');
      assert.equal(classifyToolkitRefValue(`https://github.com/dustinkeeton/wafflestack#${SHA_A}`).kind, 'other-pin');
    });

    test('the host is anchored — a lookalike or a path segment is NOT a github URL', () => {
      // `parseRepoSlug` is the second gate, but the form test must not admit these on its own: this
      // answer decides whether we report a repo the consumer never named.
      assert.equal(classifyToolkitRefValue('https://evil.com/github.com/o/r#v0.12.0').kind, 'not-github');
      assert.equal(classifyToolkitRefValue('https://github.com.evil.com/o/r#v0.12.0').kind, 'not-github');
    });
  });
});

describe('toolkitPinFromIdentity — the pin is DERIVED, never surgically edited (#372)', () => {
  test('a release npx toolkit yields the pin the lock is about to record — by construction', () => {
    const identity = releaseIdentity();
    assert.equal(toolkitPinFromIdentity(identity), 'github:dustinkeeton/wafflestack#v0.12.0');
    // THE COMPOSITION, stated as an assertion: what #372 writes into waffle.yaml is literally what
    // #374 writes into the lock, read back by #372's own read-back function. They cannot drift.
    assert.equal(toolkitPinFromIdentity(identity), toolkitPinFromLock({ toolkit: toolkitLockEntry(identity) }));
    assert.equal(toolkitPinFromIdentity(identity), identity.ref);
  });

  test('a CHECKOUT release yields NULL — #384 F13, inherited for free', () => {
    // `git describe` reads the clone's LOCAL tag refs and asks no remote, so nothing corroborates
    // that any repository holds this tag. `toolkitLockEntry` records `source: null`; the pin is a
    // claim about a repo, so there is no pin. A toolkit developer's `upgrade` therefore never writes
    // their clone's origin into a consumer's committed config.
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

  // The one assertion worth making about a "verbatim" write, and the one the #372 tests were missing:
  // the output is the input with the PIN'S BYTES swapped and NOTHING else moved. Substring matches
  // cannot see a reflow — they pass just as happily on a file the serializer has re-laid-out.
  const assertOnlyThePinMoved = (src, out) =>
    assert.equal(out, src.replaceAll(OLD, NEW), 'the pin moved; every other byte must be where it was');

  test('BYTE-VERBATIM: only the pin’s own bytes change — the rest of the file is untouched', () => {
    // Every element here is one a `doc.toString()` re-serialize DEMONSTRABLY reflows (#386), which is
    // what makes this test non-vacuous: an unpadded flow collection (the shape `schema/FORMAT.md:43`
    // documents), a plain scalar past 80 columns, and a double-spaced inline comment.
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
    // Spelled out, so a failure names the thing that broke rather than dumping two files:
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
    // The one shape the splice refuses (its bytes carry a block header + indentation). The value must
    // still land: a pin we decline to move would silently leave CI fetching the old toolkit.
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
    // `makeResolver` reads config via `lookupPath`, which splits on `.` and walks NESTED objects. A
    // literal `"doctor.toolkitRef":` key in waffle.yaml is therefore INERT — it pins nothing. So the
    // bumper must not touch it either: rewriting a key the renderer ignores would be a lie.
    assert.equal(setScalarIn(`config:\n  doctor.toolkitRef: ${OLD}\n`, PIN_PATH, NEW), null);
  });

  test('setting the value it already holds is not a change — the dirty guard can trust null', () => {
    assert.equal(setScalarIn(`config:\n  doctor:\n    toolkitRef: ${OLD}\n`, PIN_PATH, OLD), null);
  });

  test('a config that does not parse is never half-written', () => {
    assert.equal(setScalarIn('config:\n  doctor:\n   toolkitRef: [unclosed\n', PIN_PATH, NEW), null);
  });

  // The rationale this helper carried until #386 — "`doc.setIn` drops the comments attached to the old
  // node" — was FALSE for `yaml` v2, and it was documented as fact in six places. `YAMLMap.set` keeps
  // the old node on a scalar→scalar overwrite, so `setIn` preserves comments exactly as an in-place
  // mutation does. Pinning it here means the six corrected sites cannot silently rot back.
  test('the REAL contract: `doc.setIn` would CREATE the pin — which is what #372 forbids', () => {
    const doc = YAML.parseDocument('config:\n  doctor: {}\n');
    doc.setIn(PIN_PATH, NEW);
    assert.match(doc.toString(), /toolkitRef: github/, 'setIn invents a pin the consumer never chose…');
    assert.equal(setScalarIn('config:\n  doctor: {}\n', PIN_PATH, NEW), null, '…and setScalarIn refuses to');

    // And the claim that justified the ban is simply not true of this `yaml`, so it must not be
    // re-asserted in the docs: on an EXISTING scalar, setIn keeps the comments too.
    const live = YAML.parseDocument(`config:\n  doctor:\n    toolkitRef: ${OLD} # pinned deliberately\n`);
    live.setIn(PIN_PATH, NEW);
    assert.match(live.toString(), /# pinned deliberately/, 'setIn does NOT drop comments (yaml v2)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The write, end to end, through a real `upgrade` over a fixture toolkit that declares BOTH keys and
// renders BOTH placeholders — so the sequencing claim (config → render → lock, one run) is provable.
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
    // The fixture stack DECLARES both keys and RENDERS both placeholders — `alpha` stands in for the
    // nine `waffle-*` skills, `ci` for `.github/workflows/waffle-doctor.yml`. Same substitution
    // machinery, same lock hashing; the point is that one `upgrade` moves config, render and lock.
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
    // The write lands AFTER migrations and BEFORE render — and `renderProject` re-reads waffle.yaml
    // from disk. So the same `upgrade` that moves the config also renders the moved value into every
    // consumer of the placeholder, and hashes THAT into the lock. A bump applied after the render
    // would leave the stale ref in the rendered output until someone ran `render` again.
    writeConfig(pinnedConfig('github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    assert.match(fs.readFileSync(skillPath(), 'utf8'), /v0\.12\.0/, 'the OLD pin is what rendered before');

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(result.ok, true, JSON.stringify(result.render?.errors));
    assert.match(fs.readFileSync(skillPath(), 'utf8'), /npx --yes github:dustinkeeton\/wafflestack#v0\.13\.0 doctor/, 'the waffle-* skills');
    assert.match(fs.readFileSync(ciPath(), 'utf8'), /npx --yes github:dustinkeeton\/wafflestack#v0\.13\.0 doctor/, 'the doctor workflow');

    // …and the lock's hashes describe the bytes actually on disk. `doctor` folds that into `ok`, so
    // this is the assertion that the whole thing is coherent rather than merely written.
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
    // The epic's third *Done when*, and the state the bug actually leaves people in: they upgraded,
    // the lock moved to 0.13.0, the pin stayed at v0.12.0, CI went red. Running `upgrade` again is a
    // no-op by version (`current`) — and it must STILL move the pin, or the remedy doctor prints
    // ("run `wafflestack upgrade`") remains the command that cannot fix it.
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
    // The claim #372 makes about this file is `verbatim`, and only ONE assertion tests it: the bytes
    // after == the bytes before with the pins swapped. Substring matches cannot see a whole-document
    // reflow — the flow collection, the over-long plain scalar and the double-spaced inline comment
    // below are each a thing `doc.toString()` demonstrably re-lays-out, and each passed the old test.
    // Written whole, not through `writeConfig`, so the assertion owns EVERY byte of the file — the
    // unpadded `targets: [claude]` flow collection included.
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
    // This repo's own shape, and most consumers'. Introducing a pin here would silently change what
    // their CI fetches — a decision that is theirs, not ours.
    writeConfig('config: {}\n');
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();
    // Since #386 the write is byte-verbatim, so "wrote the same bytes back" and "did not write" are
    // INDISTINGUISHABLE by content — a byte assertion can no longer catch a dropped dirty guard. The
    // mtime can: age the file, and require that upgrade never touched it. (Before #386 the guard was
    // caught only because an unguarded write REFLOWED the file, i.e. by the very bug that PR fixed.)
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

  // ── the git-URL pin (#386 F3) ─────────────────────────────────────────────────────────────────
  // The bug this replaces: a release-pinned git URL classified as `not-github`, fell in with local
  // paths, and was skipped in SILENCE — no pinMove, no log. The other key moved, the lock recorded the
  // new toolkit, and CI went on fetching the old one. That is the lock/pin divergence #372 exists to
  // kill, reintroduced through a pin form the classifier did not recognise.
  test('a release-pinned GIT URL is left alone — and SAID so, with the remedy, while the other key moves', () => {
    writeConfig(pinnedConfig('git+https://github.com/dustinkeeton/wafflestack#v0.12.0', 'github:dustinkeeton/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');

    // BYTE IDENTITY: the ONLY bytes that moved are the shorthand pin's. The URL pin is not rewritten
    // (the conservative call), and nothing else in the file is either. `github:…#v0.12.0` is not a
    // substring of `git+https://github.com/…#v0.12.0` (`github:` vs `github.com/`), so this one
    // replacement names exactly the shorthand line.
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
    // back into the silent `not-github` bucket. Each is a spec `npx --yes` resolves.
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
    // Same pin, different notation: `git+https://…#v0.13.0` fetches exactly what `github:…#v0.13.0`
    // does. Nothing diverges, so a warning here would fire on every upgrade at a consumer who is
    // already correct — and a warning that fires when nothing is wrong is how consumers learn to
    // ignore warnings.
    writeConfig(pinnedConfig('git+https://github.com/dustinkeeton/wafflestack#v0.13.0', 'github:dustinkeeton/wafflestack#v0.13.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.13.0', toolkitIdentity: at('0.13.0', { commit: SHA_B }) });
    const before = configBytes();

    const result = runUpgrade(at('0.13.0'), '0.13.0');
    assert.equal(configBytes(), before, 'still a zero-byte no-op');
    assert.deepEqual(result.pinMoves.map((m) => m.action), ['unchanged', 'unchanged']);
    assert.doesNotMatch(logged.join('\n'), /NOT reconciled/, 'nothing diverges, so nothing is said');
  });

  test('a git URL naming a DIFFERENT repo diverges even at the same tag — and is reported', () => {
    // The fragment matches, but the repo does not: a pin at `acme/wafflestack#v0.13.0` does not name
    // the toolkit that rendered this lock, so it is a divergence like any other. Matching the tag is
    // not enough — the repo has to be the one that rendered (#384 F14, inherited).
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
    // The hatch, a `dlx` install, a network blip (#383): `ref` is null, so there is no pin. Writing
    // one anyway would stamp a claim this run could not establish. Read `ref == null` as "no
    // provenance captured", NEVER as "not a release".
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
    // An acme pin, upgraded by an UPSTREAM toolkit. The rewrite is correct (the pin must name the
    // toolkit that produced the lock, or `--verify-render` reds by construction) and it is exactly
    // the case a consumer must see, so it never happens quietly.
    writeConfig(pinnedConfig('github:acme/wafflestack#v0.12.0'));
    renderProject({ toolkitRoot, cwd, toolkitVersion: '0.12.0', toolkitIdentity: at('0.12.0', { commit: SHA_A, repo: 'acme/wafflestack', ref: 'github:acme/wafflestack#v0.12.0' }) });

    runUpgrade(at('0.13.0'), '0.13.0'); // upstream
    assert.match(configBytes(), /toolkitRef: github:dustinkeeton\/wafflestack#v0\.13\.0/);
    assert.match(logged.join('\n'), /DIFFERENT REPOSITORY \(acme\/wafflestack → dustinkeeton\/wafflestack\)/);
  });

  test('the gitignored overlay is neither read nor written (#317)', () => {
    // `waffle.local.yaml` is a developer's private tooling — a pin there (typically a local checkout)
    // is a deliberate machine-local override, and it must not trigger a write to the committed file
    // OR receive one itself.
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
    // A release pin that WOULD move (`from !== pin`), but the byte-level writer returns null — a path no
    // config input can reach on its own, so it is driven through the `writeScalar` seam. The branch used
    // to assert `unchanged, to: <pin>` — a bump on the one path where nothing was written. It must now
    // say what is true: nothing landed.
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
    // The whole trap: `waffle.toolkitRef` pinned to v0.13.0 runs the v0.13.0 CLI, which reports
    // `current` and would otherwise fall silent. It cannot BE v0.14.0 — but `latestTag` told it that
    // v0.14.0 exists, so it can say exactly what to run. Report and name; never re-exec (#373).
    const identity = releaseIdentity({ version: '0.13.0', tag: 'v0.13.0', ref: 'github:dustinkeeton/wafflestack#v0.13.0', latestTag: 'v0.14.0' });
    const result = runUpgrade(identity, '0.13.0');
    assert.deepEqual(result.newerRelease, { tag: 'v0.14.0', command: 'npx --yes github:dustinkeeton/wafflestack#v0.14.0 upgrade' });
    const out = logged.join('\n');
    assert.match(out, /a newer toolkit release exists: v0\.14\.0/);
    assert.match(out, /npx --yes github:dustinkeeton\/wafflestack#v0\.14\.0 upgrade/);
    // …and the pins/lock still record what ACTUALLY rendered, which is 0.13.0. A pin names the
    // toolkit that produced the render, never one it merely heard about.
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
