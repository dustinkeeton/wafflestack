// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, compareVersions, parseVersion } from './util.mjs';

/**
 * Toolkit self-identification (#373) — "what am I, and what ref reproduces me?" Three statuses:
 * `release` / `unreleased` / `unverified` (the last fails OPEN — warn and proceed on ignorance).
 * Two origins, both offline-first: a `.git` checkout (`git describe --exact-match`) and an `npx`
 * install (npm's hidden-lockfile SHA + one `git ls-remote --tags`, never the rate-limited REST API).
 * `lsRemote`/`runGit` are injectable for tests. The write gate lives in `cli.mjs`; full contract →
 * AGENTS.md `toolkit-ref.mjs` and DECISIONS #374.
 *
 * @typedef {object} ToolkitIdentity
 * @property {'release'|'unreleased'|'unverified'} status
 * @property {string}      version      package.json version — always present
 * @property {string|null} commit       40-char sha, when knowable
 * @property {string|null} tag          "v0.12.0" when the commit IS a release tag
 * @property {string|null} ref          "github:owner/repo#v0.12.0" — the npx spec that reproduces this
 *                                      toolkit. Consumers key on `ref != null`, not `status === 'release'`
 *                                      (a slug-less release is release with ref null). Contract #374/#372.
 * @property {'checkout'|'npm-install'|'unknown'} origin
 * @property {string|null} repo         "owner/repo" to ASK about tags — origin-first (`repoSlug`), for the
 *                                      network lookup and remedy, not the lock (#373 F14). See `lockRepo`.
 * @property {string|null} lockRepo     "owner/repo" for the committed lock (`lockRepoSlug`) — pin-derived,
 *                                      never `origin`, so two clones of one commit match (#384 F2/F11, #317).
 * @property {string|null} latestTag    the release to pin to, for the remedy message
 * @property {string|null} lookupError  diagnostic prose for why this is not called a release; never branch on
 *                                      its text. "lookup ran and succeeded" ≙ npm-install && lookupError null.
 *
 * @typedef {object} ToolkitLockEntry  the lock's top-level `toolkit` block (#374) — see `toolkitLockEntry`
 * @property {string|null} source      "github:<owner>/<repo>" — the npx spec BASE, no `#ref`. Null when the
 *                                     repo holding `ref` is unattributable; `source`+`ref` ARE the pin (#384 F13).
 * @property {'git'} sourceType        always "git"; shape parity with a `sources[]` entry
 * @property {string|null} ref         the PIN — "v0.12.0", not the npx spec. Null unless `release`.
 * @property {string|null} commit      40-char sha. Null unless `release`. **Never a moving HEAD.**
 * @property {'release'|'unreleased'|'unverified'} status  why a null block is null
 */

/** A wafflestack release tag. The toolkit tags plain `vX.Y.Z` — see CHANGELOG.md. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** Last-resort repo name for the remedy message, if `repoSlug`'s three sources all come back empty. */
const FALLBACK_REPO = 'dustinkeeton/wafflestack';

/**
 * Establish what toolkit is running (see the module docblock).
 *
 * `allowUnreleased` and `offline` both suppress the network lookup; neither manufactures a release
 * verdict. On an npx install the skip can forfeit a release you genuinely had (`unverified`, ref
 * null) — see issue #383 and DECISIONS #374.
 *
 * @param {object} opts
 * @param {string} opts.toolkitRoot
 * @param {(url: string) => string} [opts.lsRemote] injectable; returns raw `git ls-remote` stdout
 * @param {(cwd: string, args: string[]) => string | null} [opts.runGit] injectable; null on failure
 * @param {boolean} [opts.allowUnreleased] escape hatch: skip the lookup, keep the verdict honest
 * @param {boolean} [opts.offline] never touch the network (plain `doctor`, banner)
 * @returns {ToolkitIdentity}
 */
export function resolveToolkitIdentity({ toolkitRoot, lsRemote = gitLsRemoteTags, runGit = gitCapture, allowUnreleased = false, offline = false }) {
  const pkg = readJson(path.join(toolkitRoot, 'package.json')) ?? {};
  const changelog = readTextOrNull(path.join(toolkitRoot, 'CHANGELOG.md'));
  const slug = repoSlug({ toolkitRoot, pkg, runGit });
  // The lock's slug — must not depend on the renderer's clone (#384 F2); see `lockRepoSlug`.
  const lockSlug = lockRepoSlug({ toolkitRoot, pkg });
  /** @type {ToolkitIdentity} */
  const base = {
    status: 'unverified',
    version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
    commit: null,
    tag: null,
    ref: null,
    origin: 'unknown',
    repo: slug ? `${slug.owner}/${slug.repo}` : null,
    lockRepo: lockSlug ? `${lockSlug.owner}/${lockSlug.repo}` : null,
    // Fallback for the remedy message; overwritten by a real tag list when we get one.
    latestTag: changelogLatestRelease(changelog),
    lookupError: null,
  };
  const noNetwork = allowUnreleased || offline;

  // ── a checkout of the toolkit: git answers it, offline, always. ────────────────────────────────
  if (exists(path.join(toolkitRoot, '.git'))) {
    const commit = runGit(toolkitRoot, ['rev-parse', 'HEAD']);
    if (!commit) {
      return { ...base, origin: 'checkout', lookupError: 'the toolkit is a git checkout but `git rev-parse HEAD` did not run — is git installed?' };
    }
    // `--dirty`, no HEAD arg: `describe` answers about the COMMIT, so a tag with uncommitted tracked
    // edits would classify `release` and render content the ref does not reproduce; `--dirty` re-adds
    // working-tree sensitivity (tracked files only). DECISIONS #374.
    const described = runGit(toolkitRoot, ['describe', '--tags', '--exact-match', '--dirty']); // null when untagged
    const dirty = described !== null && described.endsWith('-dirty');
    const exact = dirty ? described.slice(0, -'-dirty'.length) : described;
    const onReleaseTag = exact !== null && RELEASE_TAG.test(exact);
    const localLatest = latestReleaseTag(splitLines(runGit(toolkitRoot, ['tag', '--list', 'v*']) ?? ''));
    const latestTag = localLatest ?? base.latestTag;
    if (onReleaseTag && !dirty) {
      return { ...base, status: 'release', origin: 'checkout', commit, tag: exact, ref: toolkitRef(slug, exact), latestTag: latestTag ?? exact };
    }
    return {
      ...base,
      status: 'unreleased',
      origin: 'checkout',
      commit,
      latestTag,
      // Say WHY when it is not the obvious "no tag here" — a dirty tree sitting exactly on a tag.
      lookupError: onReleaseTag && dirty
        ? `HEAD is ${exact}, but the working tree has uncommitted changes to tracked files — the tag no longer describes what would render`
        : null,
    };
  }

  // ── an `npx github:` install: npm's hidden lockfile knows the commit; ls-remote classifies it. ─
  const commit = commitFromNpmLockfile(toolkitRoot, pkg.name);
  if (!commit) {
    return corroborate({ ...base, lookupError: 'no .git and no resolvable commit in npm\'s hidden lockfile — cannot tell whether this toolkit is a release' }, changelog);
  }
  const found = { ...base, origin: /** @type {const} */ ('npm-install'), commit };
  if (noNetwork) {
    return corroborate({ ...found, lookupError: allowUnreleased ? 'release lookup skipped (--allow-unreleased)' : 'release lookup skipped (offline)' }, changelog);
  }
  if (!slug) {
    return corroborate({ ...found, lookupError: 'could not work out which repository this toolkit came from' }, changelog);
  }
  let tags;
  try {
    tags = parseLsRemoteTags(lsRemote(httpsUrl(slug)));
  } catch (err) {
    return corroborate({ ...found, lookupError: `could not list the toolkit's release tags: ${err instanceof Error ? err.message : String(err)}` }, changelog);
  }
  // A successful lookup with zero tags is positive knowledge → `latestTag` stays null (do NOT fall
  // back to the shipped-CHANGELOG value), so a tagless fork is not handed a nonexistent pin.
  const latestTag = tags.latest;
  const tag = tags.byCommit.get(commit) ?? null;
  if (tag) return { ...found, status: 'release', tag, ref: toolkitRef(slug, tag), latestTag: latestTag ?? tag };
  return { ...found, status: 'unreleased', latestTag };
}

/**
 * The offline corroborator: a shipped CHANGELOG carrying a non-empty `## [Unreleased]` section
 * proves, with no network, that this build is not a release → tighten `unverified` → `unreleased`.
 * Its one false positive (a default branch identical to the tag) is a safe refusal, one flag away.
 *
 * @param {ToolkitIdentity} identity
 * @param {string|null} changelog
 * @returns {ToolkitIdentity}
 */
function corroborate(identity, changelog) {
  if (identity.status !== 'unverified') return identity;
  if (!changelogHasUnreleasedEntries(changelog)) return identity;
  return {
    ...identity,
    status: 'unreleased',
    lookupError: `${identity.lookupError ?? 'release lookup unavailable'} — but the shipped CHANGELOG.md carries an unreleased section, so this build is not a release`,
  };
}

/**
 * Read the commit an `npx github:…` fetch landed on, from npm's hidden lockfile (the sibling
 * `.package-lock.json`, lockfileVersion 3). Every step degrades to null, never throws — a missing
 * answer reports `unverified` and proceeds rather than becoming an outage.
 *
 * @param {string} toolkitRoot
 * @param {unknown} pkgName
 * @returns {string|null} 40-char commit sha
 */
export function commitFromNpmLockfile(toolkitRoot, pkgName) {
  return shaFromResolved(npmResolvedUrl(toolkitRoot, pkgName));
}

/**
 * The `resolved` URL npm recorded for THIS toolkit, or null — the one place the hidden lockfile is
 * located and keyed, shared by `commitFromNpmLockfile` (SHA) and `repoSlug` (owner/repo) so they
 * cannot answer about different packages.
 *
 * @param {string} toolkitRoot
 * @param {unknown} pkgName
 * @returns {string|null}
 */
function npmResolvedUrl(toolkitRoot, pkgName) {
  const lock = readJson(path.resolve(toolkitRoot, '..', '.package-lock.json'));
  const packages = lock && typeof lock === 'object' ? lock.packages : null;
  if (!packages || typeof packages !== 'object') return null;
  // By package name, else by our own dir basename (installed under a non-package-name directory).
  const byName = typeof pkgName === 'string' ? packages[`node_modules/${pkgName}`] : null;
  const entry = byName ?? packages[`node_modules/${path.basename(toolkitRoot)}`];
  const resolved = entry && typeof entry === 'object' ? entry.resolved : null;
  return typeof resolved === 'string' ? resolved : null;
}

/**
 * The `#<sha>` fragment of an npm `resolved` git URL — a full 40-char sha only. npm records the
 * RESOLVED commit even for a tag/branch spec, which is what makes it usable as provenance.
 *
 * @param {string|null} resolved
 * @returns {string|null}
 */
export function shaFromResolved(resolved) {
  if (!resolved) return null;
  const m = /#([0-9a-f]{40})\s*$/.exec(resolved.trim());
  return m ? m[1] : null;
}

/**
 * Parse `git ls-remote --tags <url>` output into a commit → tag index. A peeled `refs/tags/vX^{}`
 * line (an annotated tag's commit) wins over the unpeeled line for the same tag, either order;
 * non-`vX.Y.Z` names are filtered out.
 *
 * @param {string} stdout
 * @returns {{ byCommit: Map<string, string>, tags: string[], latest: string|null }}
 */
export function parseLsRemoteTags(stdout) {
  /** @type {Map<string, string>} */
  const shaByTag = new Map();
  /** @type {Set<string>} */
  const peeledTags = new Set();
  for (const line of splitLines(stdout)) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (!m) continue;
    const [, sha, tag, peeled] = m;
    if (!RELEASE_TAG.test(tag)) continue;
    if (peeled) {
      shaByTag.set(tag, sha);
      peeledTags.add(tag);
    } else if (!peeledTags.has(tag)) {
      shaByTag.set(tag, sha);
    }
  }
  /** @type {Map<string, string>} */
  const byCommit = new Map();
  for (const [tag, sha] of shaByTag) byCommit.set(sha, tag);
  const tags = [...shaByTag.keys()];
  return { byCommit, tags, latest: latestReleaseTag(tags) };
}

/**
 * The newest `vX.Y.Z` in a list of tag names, by semver order (not string — `v0.9.0` < `v0.10.0`).
 *
 * @param {string[]} tags
 * @returns {string|null}
 */
export function latestReleaseTag(tags) {
  const releases = tags.filter((t) => RELEASE_TAG.test(t));
  if (!releases.length) return null;
  return releases.reduce((best, t) => (compareVersions(t, best) > 0 ? t : best));
}

/**
 * The npx spec that reproduces a toolkit at `tag` — THE contract string, pinned by a test (#372/#374).
 *
 * @param {{owner: string, repo: string}|null} slug
 * @param {string|null} tag
 * @returns {string|null}
 */
export function toolkitRef(slug, tag) {
  return slug && tag ? `github:${slug.owner}/${slug.repo}#${tag}` : null;
}

/**
 * The npx spec BASE — `"owner/repo"` → `"github:owner/repo"`, the lock's `toolkit.source` (no `#tag`;
 * `toolkitRef` adds it, `toolkitPinFromLock` reassembles, a test pins the three together).
 *
 * @param {string|null|undefined} repo "owner/repo"
 * @returns {string|null}
 */
export function toolkitSource(repo) {
  return repo ? `github:${repo}` : null;
}

/**
 * The lock's `toolkit` block (#374) — what produced this render, in a `sources[]` entry's shape plus
 * a `status`. The anti-churn invariant: NO FIELD MAY BE A FUNCTION OF A MOVING HEAD, so `commit` is
 * recorded iff `status === 'release'`; a non-release block is `{ ref: null, commit: null, status }`
 * with `status` saying why (read `ref == null` as "no provenance captured", not "not a release").
 * An `unverified` render carries the previous block forward ONLY when it asserts nothing new — same
 * `toolkitVersion` and an identical `files` map — else it rewrites to nulls. DECISIONS #374, #317; #383.
 *
 * @param {ToolkitIdentity|null} identity the running CLI's identity; **null → the block is OMITTED**
 *   (a library caller — every `renderProject` in the test suite and `evals.mjs` — writes a lock
 *   byte-identical to the pre-#374 shape, which is what keeps the whole suite green)
 * @param {object} [opts]
 * @param {any} [opts.prevLock] the lock this render is about to overwrite (each of the two locks
 *   carries forward from its OWN predecessor — #317's canonical/local split)
 * @param {Record<string,string>|null} [opts.newFiles] the freshly rendered `files` map
 * @param {string} [opts.toolkitVersion]
 * @returns {ToolkitLockEntry|null} null → omit the block
 */
export function toolkitLockEntry(identity, { prevLock = null, newFiles = null, toolkitVersion = undefined } = {}) {
  if (!identity) return null;
  const source = toolkitSource(lockSourceRepo(identity));
  if (identity.status === 'release') {
    return {
      source,
      sourceType: 'git',
      ref: identity.tag ?? null,
      commit: identity.commit ?? null,
      status: 'release',
    };
  }
  if (
    identity.status === 'unverified' &&
    prevLock?.toolkit &&
    prevLock.toolkitVersion === toolkitVersion &&
    sameFiles(prevLock.files, newFiles)
  ) {
    return prevLock.toolkit;
  }
  return { source, sourceType: 'git', ref: null, commit: null, status: identity.status };
}

/**
 * Which repo does the committed lock name as the source of this render? `source` + `ref` are a PIN —
 * a claim that THAT repo holds THAT ref at THAT commit — so only a path that corroborated it may set
 * it. Exactly one does: `npm-install`, where `ls-remote` found the tag on that commit in that remote
 * and `repo === lockRepo`. A checkout-`release` records `source: null` (`git describe` asks no remote),
 * and `origin`-derived slugs are nondeterministic and stay out (two clones of one commit must match).
 * The `repo` fallback is `.git`-gated for the same reason. DECISIONS #372/#317; F2/F11/F13 in provenance.test.mjs.
 *
 * @param {ToolkitIdentity} identity
 * @returns {string|null}
 */
function lockSourceRepo(identity) {
  // A `release` block's `source` may name only a corroborated repo — `npm-install` alone establishes
  // one (`ls-remote` found the tag on that commit); a checkout asks no remote (#384 F13).
  if (identity.status === 'release' && identity.origin !== 'npm-install') return null;
  if (identity.lockRepo) return identity.lockRepo;
  if (identity.origin === 'checkout') return null;
  return identity.repo ?? null;
}

/**
 * Do two `files` maps record exactly the same paths at the same hashes? The carry-forward precondition.
 *
 * @param {Record<string,string>|null|undefined} a
 * @param {Record<string,string>|null|undefined} b
 * @returns {boolean}
 */
function sameFiles(a, b) {
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/**
 * The npx spec that reproduces the toolkit a lock was rendered by — `github:<owner>/<repo>#<tag>`, or
 * null when the lock cannot name one. #372's read-back, kept here so the consumer never does string
 * surgery on the lock; a test pins the triple equality with `toolkitRef` and `identity.ref`.
 *
 * @param {any} lock a parsed lock (or anything with a `.toolkit`)
 * @returns {string|null}
 */
export function toolkitPinFromLock(lock) {
  const t = lock?.toolkit;
  if (!t || t.status !== 'release' || !t.source || !t.ref) return null;
  return `${t.source}#${t.ref}`;
}

/**
 * The pin a running toolkit would have a consumer write into `doctor.toolkitRef` / `waffle.toolkitRef`
 * — #372's write-side. A composition of `toolkitLockEntry` + `toolkitPinFromLock`, so it IS the value
 * the lock is about to record (a test pins the identity) and inherits every null rule → null writes
 * nothing (a run that could not corroborate a pin makes no claim). DECISIONS #372; #383, #384 F13.
 *
 * @param {ToolkitIdentity|null} identity the toolkit that performed the render
 * @returns {string|null} `github:<owner>/<repo>#<tag>`, or null when this toolkit is not pinnable
 */
export function toolkitPinFromIdentity(identity) {
  return toolkitPinFromLock({ toolkit: toolkitLockEntry(identity) });
}

/** A pinnable release fragment. `v`-optional on READ (`#0.12.0` is a mistake to recognise; we WRITE `v`). */
const RELEASE_PIN_FRAGMENT = /^v?\d+\.\d+\.\d+$/;

/**
 * Does a `toolkitRef` value name github.com at all? A coarse gate only — `parseRepoSlug` does the real
 * host-anchoring, so re-anchoring here would be the redundant check #386 F3 removed (#386 F3).
 */
const NAMES_GITHUB_HOST = /github\.com/i;

/**
 * Classify the CURRENT value of a `toolkitRef` config key — #372's read half, kept pure. The rule:
 * `upgrade` moves a pin the consumer already chose; it never makes the choice for them.
 *
 *   | kind          | value                                    | what #372 does                      |
 *   |---------------|------------------------------------------|-------------------------------------|
 *   | `absent`      | key unset (this repo; most consumers)     | nothing — a pin is never INTRODUCED |
 *   | `unpinned`    | `github:owner/repo` (no `#fragment`)      | nothing — deliberately floating     |
 *   | `release-pin` | `github:owner/repo#v0.12.0` / `#0.12.0`   | **rewrite the whole value**         |
 *   | `other-pin`   | `#main`, `#<sha>`, `#nightly`             | nothing — left alone, and NOTED     |
 *   | `not-github`  | a local path, a non-github URL, a non-string | nothing                          |
 *
 * `form` is the second axis: `shorthand` (`github:…`) is the only form `upgrade` rewrites; a `url` form
 * is READ but never rewritten (#386 F3). A bare `owner/repo` is not accepted — it reads as a local path.
 *
 * @param {unknown} value the raw config value (may be undefined, a non-string, anything)
 * @returns {{kind: 'absent'|'unpinned'|'release-pin'|'other-pin'|'not-github', slug?: {owner: string, repo: string}, fragment?: string, form?: 'shorthand'|'url'}}
 */
export function classifyToolkitRefValue(value) {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'string') return { kind: 'not-github' };
  const raw = value.trim();
  if (!raw) return { kind: 'absent' };
  const shorthand = /^github:/.test(raw);
  // A git URL is a pin we READ but never rewrite; classifying it `not-github` was the #386 F3 bug.
  const url = !shorthand && NAMES_GITHUB_HOST.test(raw);
  if (!shorthand && !url) return { kind: 'not-github' };
  const hash = raw.indexOf('#');
  const base = hash === -1 ? raw : raw.slice(0, hash);
  const fragment = hash === -1 ? '' : raw.slice(hash + 1).trim();
  // THE gate, for both forms: no parseable `owner/repo`, a lookalike host, or a github.com path
  // segment on another host all fail here (see `parseRepoSlug`) — leave them where they are.
  const slug = parseRepoSlug(base);
  if (!slug) return { kind: 'not-github' };
  const form = /** @type {'shorthand'|'url'} */ (shorthand ? 'shorthand' : 'url');
  if (!fragment) return { kind: 'unpinned', slug, form };
  if (RELEASE_PIN_FRAGMENT.test(fragment)) return { kind: 'release-pin', slug, fragment, form };
  return { kind: 'other-pin', slug, fragment, form };
}

/**
 * Compare the provenance the lock recorded against the toolkit now in hand. A WARNING, never an error
 * (`doctor` must not fold it into `ok`). The headline is `recut` — same version, different commit.
 *
 * @param {object} opts
 * @param {ToolkitLockEntry|null} [opts.lockToolkit] the lock's `toolkit` block
 * @param {string|null} [opts.lockVersion] the lock's `toolkitVersion`
 * @param {ToolkitIdentity|null} [opts.identity] the running CLI
 * @returns {{ status: 'not-recorded'|'unpinnable'|'unverifiable'|'match'|'recut'|'mismatch', notes: string[] }}
 */
export function describeToolkitProvenance({ lockToolkit = null, lockVersion = null, identity = null }) {
  /** @param {string|null|undefined} sha */
  const at = (sha) => (sha ? String(sha).slice(0, 12) : 'no commit');
  if (!lockToolkit) {
    return {
      status: 'not-recorded',
      notes: [
        'the lock records no toolkit provenance (it was rendered by a toolkit predating the `toolkit` block) — the next `render` records it',
      ],
    };
  }
  const pin = toolkitPinFromLock({ toolkit: lockToolkit });
  const lockWho = `${pin ?? lockToolkit.source ?? 'an unknown toolkit'}${lockToolkit.commit ? ` @ ${at(lockToolkit.commit)}` : ''}`;
  // "marked X" with a fallback, so no hand-edited status makes the sentence ungrammatical (#384 F7).
  const lockStatus = String(lockToolkit.status ?? 'unidentified').toUpperCase();
  if (lockToolkit.status !== 'release') {
    // Informational — this repo's own lock shape, plus hatch/`dlx` renders (#383). Nothing to compare.
    return {
      status: 'unpinnable',
      notes: [
        `the lock was rendered by a toolkit marked ${lockStatus} (${lockToolkit.source ?? 'source unknown'}) — its provenance cannot be pinned to a release, so there is nothing to compare this CLI against`,
      ],
    };
  }
  if (!lockToolkit.commit) {
    // A RELEASE block with no commit: pinnable, but nothing to compare against — a different sentence
    // than `unpinnable` (#384 F7). Only a hand-edited/foreign/future-CLI lock can emit it.
    return {
      status: 'unverifiable',
      notes: [
        `the lock names ${pin ?? lockToolkit.source ?? 'an unknown toolkit'} but recorded no commit, so this CLI cannot be compared against it`,
      ],
    };
  }
  if (!identity || identity.status !== 'release' || !identity.commit) {
    // Cannot compare — the normal state for plain `doctor`, which resolves offline and cannot reach
    // `release`. Say what the lock holds and stop; a comparison against an unknown is not a mismatch.
    return {
      status: 'unverifiable',
      notes: [
        `rendered by toolkit ${lockVersion ?? 'unknown'} (${lockWho}); this CLI ${identity ? `is ${identity.status}` : 'reported no identity'}, so the two cannot be compared`,
      ],
    };
  }
  if (identity.commit === lockToolkit.commit) {
    return {
      status: 'match',
      notes: [`rendered by toolkit ${lockVersion ?? identity.version} (${lockWho}) — matches this CLI`],
    };
  }
  const cliWho = `${identity.ref ?? toolkitSource(identity.repo) ?? 'an unknown toolkit'} @ ${at(identity.commit)}`;
  // Do the two blocks name the same REPOSITORY? Three-state, not two: same / different / unknown — a
  // null source is `unknown` and gets a hedge, never membership in "same" (#384 F3/F12).
  const lockSource = lockToolkit.source ?? null;
  const cliSource = toolkitSource(identity.repo);
  const comparable = Boolean(lockSource && cliSource);
  const differentRepos = comparable && lockSource !== cliSource;
  const sameRepo = comparable && lockSource === cliSource;
  if (lockVersion && identity.version && lockVersion === identity.version && !differentRepos) {
    // THE HEADLINE (#374) — one version, two commits; both provenances named, cause stated only as
    // strongly as the evidence supports.
    const sameRepoClause = sameRepo ? ' from the same repository' : '';
    const cause = sameRepo
      ? 'the tag was re-cut or force-pushed, or one of them is not the release it claims to be'
      : 'the two sources cannot be compared (at least one is unrecorded), so this may be a re-cut or force-pushed tag, or two different repositories';
    return {
      status: 'recut',
      notes: [
        `toolkit provenance mismatch — the lock (${lockWho}) and this CLI (${cliWho}) both report version ${lockVersion}${sameRepoClause} but resolve to DIFFERENT commits: ${cause}. \`--verify-render\` says whether the difference changes any file.`,
      ],
    };
  }
  if (differentRepos) {
    // Same version, DIFFERENT repositories — the fork shape (#373 F14); never a re-cut tag.
    return {
      status: 'mismatch',
      notes: [
        `toolkit provenance mismatch — the lock was rendered by ${lockWho}; this CLI is ${cliWho}. These are DIFFERENT REPOSITORIES${lockVersion && identity.version && lockVersion === identity.version ? ` that each report version ${lockVersion}` : ''}, so neither tag need have moved. Re-render, or pin CI to the toolkit that produced the lock; \`--verify-render\` says whether the difference changes any file.`,
      ],
    };
  }
  return {
    status: 'mismatch',
    notes: [
      `toolkit provenance mismatch — the lock was rendered by ${lockWho}; this CLI is ${cliWho}. Re-render, or pin CI to the toolkit that produced the lock; \`--verify-render\` says whether the difference changes any file.`,
    ],
  };
}

/**
 * Which GitHub repo is this toolkit? PROVENANCE BEFORE DECLARATION — where this build came FROM beats
 * what it SAYS: (1) npm's hidden lockfile `resolved`, (2) a checkout's `origin`, (3) `package.json`
 * `repository`. A fork inherits `repository` verbatim, so a declared-first order would ask upstream's
 * remote and refuse a correctly-pinned fork release (#373 F14). All three sources are read offline.
 *
 * @param {{toolkitRoot: string, pkg: any, runGit: (cwd: string, args: string[]) => string | null}} opts
 * @returns {{owner: string, repo: string}|null}
 */
export function repoSlug({ toolkitRoot, pkg, runGit = gitCapture }) {
  const fromLock = parseRepoSlug(npmResolvedUrl(toolkitRoot, pkg?.name));
  if (fromLock) return fromLock;
  if (exists(path.join(toolkitRoot, '.git'))) {
    const fromGit = parseRepoSlug(runGit(toolkitRoot, ['config', '--get', 'remote.origin.url']));
    if (fromGit) return fromGit;
  }
  return parseRepoSlug(repositoryUrl(pkg));
}

/**
 * The same question for the committed lock, minus the `origin` step: (1) npm's hidden lockfile
 * `resolved` (carries #373 F14 — the pin the operator typed), (2) `package.json` `repository`. Omitting
 * `remote.origin.url` is the #384 F2 fix: it is a property of the renderer's clone, so two clones of one
 * commit would write byte-different locks. Determinism by a content-bearing source only. DECISIONS #317.
 *
 * @param {{toolkitRoot: string, pkg: any}} opts
 * @returns {{owner: string, repo: string}|null}
 */
export function lockRepoSlug({ toolkitRoot, pkg }) {
  const fromLock = parseRepoSlug(npmResolvedUrl(toolkitRoot, pkg?.name));
  if (fromLock) return fromLock;
  return parseRepoSlug(repositoryUrl(pkg));
}

/** @param {any} pkg @returns {string|null} */
function repositoryUrl(pkg) {
  const repo = pkg?.repository;
  if (typeof repo === 'string') return repo;
  if (repo && typeof repo === 'object' && typeof repo.url === 'string') return repo.url;
  return null;
}

/**
 * Parse any GitHub repo form — `git+https`, `git+ssh`, scp `git@…:o/r.git`, `github:o/r`, bare `o/r`.
 *
 * @param {string|null|undefined} url
 * @returns {{owner: string, repo: string}|null}
 */
export function parseRepoSlug(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/^git\+/, '').replace(/#.*$/, '');
  const m =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s) ??
    /^github:([^/#]+)\/([^/#]+?)(?:\.git)?$/.exec(s) ??
    // A bare `owner/repo`, anchored on a leading word char so a relative path is never mistaken for one.
    /^(\w[\w.-]*)\/(\w[\w.-]*?)(?:\.git)?$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The URL to hand `git ls-remote`. Normalize to https: npm's `git+ssh://` demands an ssh key an
 * unauthenticated CI runner lacks, which would degrade the lookup to `unverified` and defeat the gate.
 *
 * @param {{owner: string, repo: string}} slug
 * @returns {string}
 */
export function httpsUrl(slug) {
  return `https://github.com/${slug.owner}/${slug.repo}.git`;
}

/**
 * Default `lsRemote`: shell out to git. NOT `--refs` — that drops the peeled `^{}` lines an annotated
 * tag's commit needs (see `parseLsRemoteTags`). A non-zero exit throws, becoming `unverified`, not an outage.
 *
 * @param {string} url
 * @returns {string} raw stdout
 */
export function gitLsRemoteTags(url) {
  try {
    return execFileSync('git', ['ls-remote', '--tags', '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 15_000,
      // No credential prompt may block a render; a repo that prompts is one we cannot classify.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    const stderr = e?.stderr ? String(e.stderr).trim() : '';
    throw new Error(stderr || e?.message || 'git ls-remote failed');
  }
}

/**
 * Default `runGit`: capture a git command's stdout, or null. Null is data, not an error — `git describe
 * --exact-match` exits non-zero precisely when HEAD is UNTAGGED, this module's key answer.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null}
 */
export function gitCapture(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Does the shipped changelog carry a non-empty `## [Unreleased]` section? See `corroborate`. An empty
 * heading or the scaffold a release leaves behind is not evidence.
 *
 * @param {string|null} text
 * @returns {boolean}
 */
export function changelogHasUnreleasedEntries(text) {
  if (!text) return false;
  for (const part of String(text).split(/^(?=## )/m)) {
    if (!/^##\s+\[?Unreleased\]?/i.test(part)) continue;
    const body = part.replace(/^##[^\n]*\n/, '');
    if (hasEntries(body)) return true;
  }
  return false;
}

/**
 * Real entries under `## [Unreleased]`, or only the empty Keep-a-Changelog scaffold? Strip the scaffold
 * — sub-headings, HTML comments, vocabulary-only placeholders — then ask whether anything remains. Err
 * toward keeping a line: a false refusal is recoverable (`--allow-unreleased`), a false "released" is
 * the silent #373 render. So filters key on what a placeholder SAYS, never on what an entry LOOKS like.
 *
 * @param {string} body the `## [Unreleased]` section, heading line already removed
 * @returns {boolean}
 */
function hasEntries(body) {
  const substance = body
    // "<!-- add entries here -->" — may span lines, so strip before the line filters.
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    // "### Added" — a sub-heading is scaffolding, not an entry (`## ` cannot appear; caller split on it).
    .filter((line) => !/^\s*#{3,}\s/.test(line))
    // "_Nothing yet._", "**No changes.**" — a placeholder by VOCABULARY, not emphasis; an emphasized
    // line that says anything else is a real ENTRY and survives.
    .filter((line) => !PLACEHOLDER_LINE.test(line))
    .join('\n');
  return /\S/.test(substance);
}

/**
 * An emphasis-wrapped line whose WORDS say "there is nothing here" — a closed vocabulary, and the phrase
 * must be the WHOLE line (a prefix match would eat `**Nothing is broken by this release.**`). See `hasEntries`.
 */
const PLACEHOLDER_LINE = /^\s*[_*]{1,2}\s*(nothing(\s+yet)?|none|no\s+(changes?|entries)|n\/a|tbd|empty)\s*[.!]?\s*[_*]{1,2}\s*$/i;

/**
 * The newest released version heading in a Keep-a-Changelog file, as a `vX.Y.Z` tag — the remedy
 * message's fallback when there is no tag list to read (offline).
 *
 * @param {string|null} text
 * @returns {string|null}
 */
export function changelogLatestRelease(text) {
  if (!text) return null;
  /** @type {string[]} */
  const versions = [];
  for (const part of String(text).split(/^(?=## )/m)) {
    const m = /^##\s+\[?(\d+\.\d+\.\d+)\]?/.exec(part);
    if (m && parseVersion(m[1])) versions.push(m[1]);
  }
  if (!versions.length) return null;
  return `v${versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best))}`;
}

/**
 * The refusal message — the feature itself: failing closed hands the consumer a copy-pasteable command
 * to run instead, and says why.
 *
 * @param {ToolkitIdentity} identity
 * @param {string} command the gated command that was refused, e.g. "render"
 * @returns {string}
 */
export function formatUnreleasedRefusal(identity, command) {
  const repo = identity.repo ?? FALLBACK_REPO;
  const tag = identity.latestTag;
  const at = identity.commit ? identity.commit.slice(0, 7) : 'an unknown commit';
  const how =
    identity.origin === 'checkout'
      ? `a checkout at ${at} (${identity.lookupError ?? 'no release tag points here'})`
      : `${repo} @ ${at} (not a release)`;
  const why = [
    `refusing to run \`${command}\` from an unreleased toolkit.`,
    '',
    `  running:        wafflestack ${identity.version} — ${how}`,
    `  latest release: ${tag ?? `none known for ${repo}`}`,
    '',
    'An unpinned `npx github:` fetch resolves the DEFAULT BRANCH. Rendering from it writes',
    'unreleased content while stamping the last released version number into your lock — which',
    'is what breaks `doctor --verify-render` in CI, and what makes the lock stop identifying',
    'what produced it.',
    '',
  ];
  // No tag to name: only a lookup that ran and succeeded (npm-install + lookupError null) proves "no
  // tags exist" → strong sentence; a skipped/failed lookup or a checkout gets a hedge. Either way print
  // no pinned command that cannot resolve.
  const provablyNone = identity.origin === 'npm-install' && identity.lookupError === null;
  if (!tag) {
    const noTag = provablyNone
      ? [
          `${repo} has no \`vX.Y.Z\` release tags, so no pinned command would resolve.`,
          'Cut a release there and pin to it — or, if this IS the toolkit you are developing, render',
          'the working tree anyway:',
        ]
      : [
          `No \`vX.Y.Z\` release of ${repo} is known to this CLI: the release lookup did not answer, so`,
          'there may well be one to pin to that this run cannot see. Check, and pin it if there is —',
          'or, if this IS the toolkit you are developing, render the working tree anyway:',
        ];
    return [
      ...why,
      ...noTag,
      `  npx --yes github:${repo} ${command} --allow-unreleased    # or WAFFLESTACK_ALLOW_UNRELEASED=1`,
      '',
      'The identity stays honest either way: `--allow-unreleased` suppresses the refusal, not the truth.',
    ].join('\n');
  }
  const pinned = `github:${repo}#${tag}`;
  return [
    ...why,
    'Run this instead:',
    `  npx --yes ${pinned} ${command}`,
    '',
    'And pin CI, in .waffle/waffle.yaml:',
    '  config:',
    `    doctor: { toolkitRef: ${pinned} }`,
    `    waffle: { toolkitRef: ${pinned} }`,
    '',
    'Developing the toolkit itself? Pass `--allow-unreleased` (or set WAFFLESTACK_ALLOW_UNRELEASED=1)',
    'to render the working tree anyway — the identity stays honest either way.',
  ].join('\n');
}

/**
 * The warning for ungated commands that still read the toolkit (`list`, `setup`), and for a
 * proceed-anyway or unanswerable lookup. These are never refused, but must say what they are.
 *
 * @param {ToolkitIdentity} identity
 * @returns {string|null} null when the toolkit IS a release (nothing to say)
 */
export function formatProvenanceWarning(identity) {
  if (identity.status === 'release') return null;
  const repo = identity.repo ?? FALLBACK_REPO;
  const at = identity.commit ? ` (${identity.commit.slice(0, 7)})` : '';
  // Same rule as the refusal: never advise a pin that cannot exist (no known tag → no pin to name).
  const advice = identity.latestTag
    ? `Pin to \`github:${repo}#${identity.latestTag}\` for a reproducible render.`
    : `No \`vX.Y.Z\` release of ${repo} is known to this CLI, so it cannot name a pin — pin one (or cut one) for a reproducible render.`;
  if (identity.status === 'unverified') {
    return `could not verify that this toolkit${at} is a release — ${identity.lookupError ?? 'lookup unavailable'}; proceeding. ${advice}`;
  }
  return `this toolkit${at} is NOT a release — it is the default branch or a working tree, and \`${identity.version}\` is merely the last released version number. ${advice}`;
}

/** @param {string} file @returns {any} */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} file @returns {string|null} */
function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} text @returns {string[]} */
function splitLines(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
