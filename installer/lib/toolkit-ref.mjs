// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, compareVersions, parseVersion } from './util.mjs';

/**
 * Toolkit self-identification (#373) — "what am I, and what ref reproduces me?"
 *
 * The bug this answers: `npx github:dustinkeeton/wafflestack <cmd>` with no `#ref` resolves the
 * DEFAULT BRANCH, so the CLI renders unreleased content while stamping the last released version
 * number (`package.json` — identical on the tag and 70 commits past it) into the consumer's lock.
 * The version number does not identify the content, and `doctor --verify-render` in CI — which
 * renders through a PINNED ref — then goes red on a lock that is, from the consumer's side,
 * perfectly correct.
 *
 * The fix is not to guess: the CLI works out whether the code it is running is a RELEASED commit,
 * and the write path refuses when it provably is not (the gate lives in `cli.mjs`; this module only
 * establishes the truth and formats the refusal). Three outcomes, and the third one matters:
 *
 *   - `release`     — this commit IS a release tag. `ref` is the npx spec that reproduces it.
 *   - `unreleased`  — this commit is provably NOT a release tag. Write commands refuse.
 *   - `unverified`  — we could not find out (offline, no git, unreadable npm lockfile). Fail OPEN:
 *                     warn and proceed. Failing closed on ignorance would make every consumer's CI
 *                     depend on our reachability, which is a far worse bug than the one being fixed.
 *
 * How identity is established, by origin — and note that neither path trusts the command line. The
 * running CLI cannot see the `#ref` it was fetched at, only the commit it landed on; asking "is my
 * COMMIT a release" is the stronger question anyway, because it also catches a re-cut or
 * force-pushed tag, which a `#ref` on the command line would happily lie about.
 *
 *   - `checkout`    — `<toolkitRoot>/.git` exists (a clone of the toolkit, i.e. toolkit development).
 *                     `git describe --tags --exact-match HEAD` answers it. **Never touches the network.**
 *   - `npm-install` — an `npx github:` fetch. It has no `.git`, but npm's hidden lockfile
 *                     (`<toolkitRoot>/../.package-lock.json`) records the exact commit it cloned:
 *                       "resolved": "git+ssh://git@github.com/…/wafflestack.git#<40-char-sha>"
 *                     That SHA is read offline; ONE `git ls-remote --tags` then says whether it is a
 *                     release tag. `git ls-remote` and not `api.github.com/releases/latest`
 *                     deliberately: the REST API's 60/hr unauthenticated limit is a live hazard on a
 *                     shared CI IP, and the smart-HTTP git protocol is not subject to it.
 *   - `unknown`     — neither shape. `unverified`.
 *
 * `lsRemote` is injectable, mirroring `sources.mjs`'s `gitFetch`/`gitResolveCommit`: that is the
 * house pattern for keeping git off the network in tests, and it is what lets the whole gate be
 * unit-tested against a fixture tag map.
 *
 * @typedef {object} ToolkitIdentity
 * @property {'release'|'unreleased'|'unverified'} status
 * @property {string}      version      package.json version — always present
 * @property {string|null} commit       40-char sha, when knowable
 * @property {string|null} tag          "v0.12.0" when the commit IS a release tag
 * @property {string|null} ref          "github:owner/repo#v0.12.0" — the npx spec that reproduces
 *                                      this toolkit. Non-null ONLY when status === 'release' — but
 *                                      NOT non-null WHENEVER it is, and the difference is the
 *                                      contract #374/#372 must code against. A release whose repo
 *                                      SLUG is unknowable (a checkout with no `repository` field, no
 *                                      npm lockfile and no `origin` remote) is `status: 'release'`
 *                                      with `ref: null` — pinned by a test, so it cannot drift.
 *                                      **Consumers key on `ref != null`, never on
 *                                      `status === 'release'`**, or they dereference a null the day
 *                                      someone renders from a bare clone.
 * @property {'checkout'|'npm-install'|'unknown'} origin
 * @property {string|null} repo         "owner/repo", when knowable. **Which remote do I ASK?** —
 *                                      origin-first (`repoSlug`), so the `ls-remote` lookup and the
 *                                      remedy message address the clone actually in hand (#373 F14).
 *                                      Correct for the network; NOT a value the committed lock may
 *                                      record on a checkout — see `lockRepo`.
 * @property {string|null} lockRepo     "owner/repo" for the **committed lock** — `lockRepoSlug`, which
 *                                      never reads `remote.origin.url`. **Which toolkit is this,
 *                                      given the pin?** A function of the npm `resolved` pin and the
 *                                      toolkit's own committed `package.json`, so two clones of one
 *                                      commit write a byte-identical lock (#384 F2, #317). It is
 *                                      identical to `repo` on the npx path (no `.git`, so no origin
 *                                      step), and on a checkout no remote is ever asked, so `repo`
 *                                      there is an unverified property of the clone (#384 F11).
 *                                      **The lock records this for every status EXCEPT a checkout
 *                                      `release`, which records `source: null`** — there `lockRepo` is
 *                                      a declared field a fork inherits verbatim, and `source`+`ref`
 *                                      together are a PIN, i.e. a claim that repo holds that tag. No
 *                                      remote was asked, so we do not make it (#384 F13, `lockSourceRepo`).
 * @property {string|null} latestTag    the release to pin to, for the remedy message
 * @property {string|null} lookupError  why we could not call this a release: the lookup that failed
 *                                      (status === 'unverified'), or the reason a release verdict was
 *                                      WITHHELD from a commit that is on a tag (a dirty checkout).
 *                                      Diagnostic prose — never branch on its text. Its one
 *                                      load-bearing use is structural, and it is HALF a
 *                                      discriminator, never a whole one: it is non-null on every
 *                                      npm-install path whose lookup could not answer — but it is
 *                                      also `null` on a clean CHECKOUT, which never looks at all. So
 *                                      "the lookup ran and succeeded" is `origin === 'npm-install'
 *                                      && lookupError === null`, and both conjuncts are required
 *                                      (see `formatUnreleasedRefusal`; each is pinned by a test).
 *
 * @typedef {object} ToolkitLockEntry  the lock's top-level `toolkit` block (#374) — see `toolkitLockEntry`
 * @property {string|null} source      "github:<owner>/<repo>" — the npx spec BASE, no `#ref`. Null when
 *                                     this render could not establish which repo holds `ref` (a checkout
 *                                     `release`, or no declared repository at all) — `source`+`ref` ARE
 *                                     the pin, so an unattributable ref pins nothing (#384 F13)
 * @property {'git'} sourceType        always "git"; shape parity with a `sources[]` entry
 * @property {string|null} ref         the PIN — "v0.12.0", not the npx spec. Null unless `release`.
 * @property {string|null} commit      40-char sha. Null unless `release`. **Never a moving HEAD.**
 * @property {'release'|'unreleased'|'unverified'} status  why a null block is null
 */

/** A wafflestack release tag. The toolkit tags plain `vX.Y.Z` — see CHANGELOG.md. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * Last-resort repo name for the remedy message. Very nearly unreachable: `repoSlug` reads
 * `package.json` `repository` first, which ships with the package (#373 adds the field precisely so
 * this is knowable offline), then npm's lockfile, then the git remote. It exists only so a refusal
 * can still print a copy-pasteable command if all three somehow come back empty.
 */
const FALLBACK_REPO = 'dustinkeeton/wafflestack';

/**
 * Establish what toolkit is running (see the module docblock).
 *
 * `allowUnreleased` and `offline` both suppress the network lookup. They differ only in intent:
 * `allowUnreleased` is the operator's escape hatch (toolkit development), `offline` is a caller
 * declaring it does not need the answer badly enough to pay for it (plain `doctor`, the banner).
 *
 * NEITHER can MANUFACTURE a release verdict — `status` still says `unreleased` whenever that can be
 * established offline, so the lock #374 writes stays honest rather than merely permitted. But be
 * precise about the other direction, because the docs used to over-promise here: on an npx install,
 * skipping the lookup means a genuinely release-pinned toolkit resolves `unverified`, with
 * `ref: null`. The hatch cannot invent a release — but it CAN cost you one you really had, and that
 * is the field #374/#372 record. Tracked as a follow-up; do not "fix" it here without reading it,
 * since only `offline` should arguably skip the lookup and the change stalls air-gapped CI.
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
  // The SAME question asked for the lock, which must not depend on the renderer's clone (#384 F2).
  // Differs from `slug` on exactly one path — an unreleased checkout — and see `lockRepoSlug`.
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
    // Best-effort fallback for the remedy message: the newest released heading in the CHANGELOG
    // that SHIPPED with this toolkit. Overwritten below by a real tag list whenever we get one.
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
    // `--dirty`, and NO `HEAD` argument: git refuses a committish alongside `--dirty`, and HEAD is
    // the default anyway. Without it, `describe --exact-match` answers about the COMMIT and ignores
    // the WORKING TREE — so a checkout sitting on a release tag with uncommitted edits to `stacks/**`
    // classified as `release`, handed out `ref: github:…#v0.9.0`, and rendered content that ref
    // demonstrably does not reproduce. That is an unreleased toolkit landing in `release`: #373's own
    // disease, through the checkout door — and once #374 writes `ref` into the lock it becomes a
    // provenance marker naming content it did not produce.
    //
    // `--dirty` has exactly the sensitivity we want: it appends `-dirty` when a TRACKED file differs
    // from the commit, and ignores untracked files. A maintainer with a scratch note is not rendering
    // different content and must not be refused; one with an edited `stacks/**` is, and must be.
    // Reachable whenever someone checks out a tag to reproduce a consumer issue or cut a hotfix and
    // renders with edits still in the tree — and during a release, since the bump commit IS the
    // tagged one. Costs nothing: every toolkit-dev path in this repo already passes
    // `--allow-unreleased`, so nothing that works today starts refusing.
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
      // Say WHY, when the reason is not the obvious one. "No release tag points here" would be a lie
      // for a dirty tree sitting exactly on a tag, and this module has been bitten twice by a message
      // asserting something the code does not do.
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
  // A lookup that SUCCEEDED and returned zero release tags is POSITIVE knowledge — there is nothing
  // in THIS remote to pin — and it is categorically different from "we could not look". So it must
  // NOT fall back to `base.latestTag`, which is scraped from the CHANGELOG that SHIPPED with the
  // toolkit, i.e. inherited from upstream: a fork that has cut no tags of its own (a plain `git
  // clone` + push carries none) would then be handed `npx …#github:acme/wafflestack#v0.12.0`, a ref
  // that does not exist in acme's remote. The refusal's whole justification is that it names a
  // command that WORKS; `latestTag: null` is what makes it say so honestly instead.
  const latestTag = tags.latest;
  const tag = tags.byCommit.get(commit) ?? null;
  if (tag) return { ...found, status: 'release', tag, ref: toolkitRef(slug, tag), latestTag: latestTag ?? tag };
  return { ...found, status: 'unreleased', latestTag };
}

/**
 * The offline corroborator. A failed (or skipped) lookup leaves us ignorant, and ignorance fails
 * OPEN — but ignorance is not always total: the CHANGELOG *ships* with the toolkit (it is in
 * package.json `files`), and a release stamps `## [Unreleased]` down into `## [X.Y.Z]`. So a
 * SHIPPED changelog carrying a non-empty `## [Unreleased]` section is proof, needing no network,
 * that this build is not a release. Tighten `unverified` → `unreleased`.
 *
 * Its one false positive — a default branch whose changelog has entries but whose `stacks/` are
 * byte-identical to the tag — produces a REFUSAL, which is the safe direction to be wrong in, and
 * is one flag away from proceeding.
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
 * Read the commit an `npx github:…` fetch landed on, from npm's hidden lockfile — the sibling
 * `node_modules/.package-lock.json` of the installed package dir. lockfileVersion 3 records:
 *
 *   "packages": { "node_modules/wafflestack": { "resolved": "git+ssh://git@github.com/o/r.git#<sha40>" } }
 *
 * It is an npm internal (npm 7+), so every step degrades to null rather than throwing: absent file,
 * unparseable JSON, a different lockfile shape, a `resolved` with no SHA. The caller then reports
 * `unverified` and proceeds — a missing answer must never be an outage.
 *
 * @param {string} toolkitRoot
 * @param {unknown} pkgName
 * @returns {string|null} 40-char commit sha
 */
export function commitFromNpmLockfile(toolkitRoot, pkgName) {
  return shaFromResolved(npmResolvedUrl(toolkitRoot, pkgName));
}

/**
 * The `resolved` URL npm recorded for THIS toolkit, or null — the single place the hidden lockfile
 * is located, parsed and keyed. Two callers need it and they need the SAME entry: this function for
 * the SHA (`commitFromNpmLockfile`) and `repoSlug` for the owner/repo. Keeping one copy of the key
 * lookup is not tidiness — a second copy is a divergence hazard, since changing the fallback key in
 * one leaves the other silently answering about a different package.
 *
 * @param {string} toolkitRoot
 * @param {unknown} pkgName
 * @returns {string|null}
 */
function npmResolvedUrl(toolkitRoot, pkgName) {
  const lock = readJson(path.resolve(toolkitRoot, '..', '.package-lock.json'));
  const packages = lock && typeof lock === 'object' ? lock.packages : null;
  if (!packages || typeof packages !== 'object') return null;
  // Prefer the entry for this package by name; fall back to the entry whose path is our own dir,
  // which covers a package installed under a directory that is not its package name.
  const byName = typeof pkgName === 'string' ? packages[`node_modules/${pkgName}`] : null;
  const entry = byName ?? packages[`node_modules/${path.basename(toolkitRoot)}`];
  const resolved = entry && typeof entry === 'object' ? entry.resolved : null;
  return typeof resolved === 'string' ? resolved : null;
}

/**
 * The `#<sha>` fragment of an npm `resolved` git URL. Only a full 40-char sha counts: npm records
 * the RESOLVED commit there even when the install spec was a tag or a branch, which is precisely
 * what makes this usable as provenance.
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
 * Parse `git ls-remote --tags <url>` output into a commit → tag index.
 *
 * Two tag flavours, and the difference is load-bearing. A LIGHTWEIGHT tag (what this repo cuts
 * today) points straight at the commit, one line, no `^{}`. An ANNOTATED tag points at a tag
 * OBJECT, and git emits a second `refs/tags/vX^{}` line carrying the peeled COMMIT — which is the
 * one we must index, since that is what a fetch checks out. So a peeled line always wins over the
 * unpeeled line for the same tag, in either arrival order.
 *
 * Non-release tag names (`nightly`, `v1.2`, `foo`) are filtered out: they are not something a
 * consumer can be told to pin, and letting one into `latest` would misname the remedy.
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
 * The newest `vX.Y.Z` in a list of tag names, by semver order (not string order — `v0.9.0` must
 * not outrank `v0.10.0`). Non-release names are ignored.
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
 * The npx spec that reproduces a toolkit at `tag`. THIS STRING IS THE CONTRACT: #374 writes it
 * into the lock as provenance and #372 writes it into `doctor.toolkitRef` / `waffle.toolkitRef`,
 * so its shape is pinned by a test.
 *
 * @param {{owner: string, repo: string}|null} slug
 * @param {string|null} tag
 * @returns {string|null}
 */
export function toolkitRef(slug, tag) {
  return slug && tag ? `github:${slug.owner}/${slug.repo}#${tag}` : null;
}

/**
 * The npx spec BASE for a repo slug string — `"owner/repo"` → `"github:owner/repo"`. The lock's
 * `toolkit.source` (mirroring `sources[].source`, which is likewise a base with the pin held
 * separately in `ref`). `toolkitRef()` is the same string WITH the `#tag`; `toolkitPinFromLock()`
 * puts them back together, and a test pins the three to one another.
 *
 * @param {string|null|undefined} repo "owner/repo"
 * @returns {string|null}
 */
export function toolkitSource(repo) {
  return repo ? `github:${repo}` : null;
}

/**
 * The lock's `toolkit` block (#374) — what produced this render, in the same shape a `sources[]`
 * entry already records for an external stack, plus a `status` that `sources` cannot need.
 *
 * ## The anti-churn invariant: NO FIELD MAY BE A FUNCTION OF A MOVING HEAD
 *
 * This is the whole design, and it is why `commit` is recorded **if and only if
 * `status === 'release'`**. The tempting alternative — record HEAD's SHA for a checkout render —
 * is not merely imperfect, it is incoherent:
 *
 *   1. **It is self-referential and has no fixed point.** The lock is a COMMITTED artifact here
 *      (this repo renders itself). A lock recording HEAD names the commit BEFORE the one that
 *      contains it. It is never right, and cannot be made right.
 *   2. **It is a false claim even when fresh.** A toolkit developer's tree is dirty by definition —
 *      rendering uncommitted `stacks/**` edits is the point — so HEAD does not identify the content
 *      that rendered. A provenance field naming content it did not produce is worse than the bare
 *      version string this issue exists to fix.
 *   3. **It churns the lock on every commit** — a lock diff on every PR, a conflict on every
 *      long-lived branch, and a permanent red on the documented `render` + `git diff --exit-code
 *      .waffle/waffle.lock.json` recipe, for a change that moved no rendered byte.
 *
 * So a non-release render records `{ ref: null, commit: null, status }`. **Null is not a
 * degradation — it is the correct answer**, and `status` is what makes the null block *say*
 * something instead of merely *lack* something. (Read `ref == null` as "no provenance captured",
 * NEVER as "not a release": on an npx install the `--allow-unreleased` hatch and a pnpm/yarn `dlx`
 * layout both forfeit a release that genuinely existed — see the `resolveToolkitIdentity` docblock
 * and issue #383.)
 *
 * ## The `unverified` carry-forward
 *
 * `unverified` is #373's fail-open state (a GitHub blip, a proxy, an unreadable hidden lockfile,
 * the hatch, `dlx`). Writing nulls there would churn a good `release` block to nulls on a network
 * hiccup: two teammates on the SAME pinned toolkit would commit two different locks, and the
 * documented `render` + `git diff --exit-code` CI gate would go red with no content change anywhere.
 *
 * So an `unverified` render carries the previous block forward — but ONLY when doing so asserts
 * nothing new: same `toolkitVersion`, and the freshly rendered `files` map is IDENTICAL to the one
 * the recorded provenance already describes. If content moved, the block is honestly rewritten to
 * nulls — and the `files` diff is the real signal anyway.
 *
 * **BE PRECISE ABOUT WHAT SURVIVES (#384 F9).** This used to say the carried-forward block is "still
 * exactly true", and it is not: an `unverified` CLI KNOWS its own commit (the lookup could not
 * CLASSIFY it, not locate it), so a render performed at commit B can carry forward a block naming
 * commit A. B produced that render; the lock says A did. What actually holds is narrower, and it is
 * still the guarantee worth having:
 *
 *   the recorded toolkit still **reproduces these exact bytes**, so the block remains a correct answer
 *   to *"what do I run to get this render?"* — even though a different, unclassifiable toolkit may
 *   have performed it.
 *
 * The distinction is not pedantry HERE of all places: this issue's whole thesis is that a version
 * string lies by collapsing two different toolkits into one. A carry-forward doc promising the block
 * is "exactly true" about WHICH TOOLKIT RAN reintroduces that same collapse as a written guarantee —
 * in the contract #372 reads as spec. The behavior is right and must not change; the claim was wrong.
 *
 * `unreleased` needs no carry-forward: it is a POSITIVE determination, reached offline, and two
 * people rendering the same unreleased toolkit compute the same nulls.
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
 * Which repo does the **committed lock** name as the source of this render (#384 F2, F11)? **Always
 * `lockRepo` — the pin-derived slug — whatever the status.** There is no exception, and the exception
 * this function used to make was the bug.
 *
 * F2's first fix carved out `release`, on the reasoning that `identity.repo` was "the slug the
 * identity was **corroborated against** — `ls-remote` asked THAT remote". **That is false on a
 * checkout**, and a checkout is exactly where `repo` and `lockRepo` can differ: `resolveToolkitIdentity`
 * reaches `release` there via `git describe --exact-match` and returns BEFORE any lookup — **zero
 * `ls-remote` calls**. So the carve-out re-admitted the very thing F2 removed: a clean checkout sitting
 * on a release tag wrote the CLONE'S origin into the committed lock, and two clones of one commit, on
 * one tag, rendering identical bytes, produced byte-different locks. The justification named evidence
 * that was never gathered — the same over-claim class this epic keeps shipping, this time in a comment.
 *
 * The carve-out was also **pointless where it was supposed to help**. `repoSlug`'s `origin` step is
 * gated on `.git`, which an npm-installed toolkit does not have — so on the npx path `repo` and
 * `lockRepo` are computed from the SAME npm `resolved` URL and are always **identical**. #373 F14 (a
 * fork must name ITSELF) lives on that path and is carried entirely by `resolved`, which `lockRepoSlug`
 * keeps. The carve-out therefore changed nothing on npx and was wrong on the checkout: it had no
 * correct case at all.
 *
 * **A checkout-release's `source` is NULL, because the triple must name ONE repo (#384 F13).** Recording
 * `lockRepo` there looked like the determinism-preserving answer, and it was — but determinism is not the
 * only property the block owes. `source` is not a decoration: `toolkitPinFromLock` is literally
 * `` `${source}#${ref}` ``, so **`source` is a claim that THAT repo holds THAT ref at THAT commit.** On a
 * checkout, `ref`/`commit` come from `git describe` against the clone's LOCAL tag refs and NO remote is
 * asked, while `lockRepo` comes from a `package.json` field a fork inherits verbatim (`repoSlug`'s own
 * docblock: "nothing prompts anyone to rewrite it"). So a fork clean on ITS OWN `v1.0.0` wrote
 * `github:dustinkeeton/wafflestack#v1.0.0` — **a pin naming a repo that never cut that tag, at a commit
 * it does not have.** Both halves were individually defensible and the pair was a lie.
 *
 * Neither guess can be promoted, and that is the point:
 *
 *   - `origin` is the clone's — **nondeterministic**, and #384 F2/F11 exist to keep it out. (The tempting
 *     "record null only when `origin` and `repository` DISAGREE" is that same value in a null-shaped
 *     costume: a contributor's fork clone of upstream and the maintainer's clone of upstream would write
 *     byte-different locks for one commit. It reds THE DETERMINISM TEST — I tried it.)
 *   - `repository` is the content's — deterministic, but on a checkout it is **unverified against the tag**,
 *     and that is precisely the claim `source` makes.
 *
 * So we record nothing, which is this module's own rule where it could not know (see the tail below):
 * **determinism by recording nothing, not by recording a guess.** The block keeps `ref`/`commit`/`status` —
 * real, local, checkable facts — and `toolkitPinFromLock` honestly declines to pin rather than pinning a
 * repo it cannot vouch for. `describeToolkitProvenance` still compares the COMMITS, so a re-cut tag on a
 * fork checkout reads `recut` (hedged cause, #384 F12) instead of the inverted "DIFFERENT REPOSITORIES".
 *
 * **`npm-install` keeps its `source`, and it is the only path that earned one.** There `ls-remote` found
 * the tag ON that commit IN that remote — a corroborated fact, not a guess — and `repo === lockRepo`
 * (both from npm's `resolved`), so #373 F14's "a fork must name ITSELF" is untouched: `npx
 * github:acme/wafflestack#v1.0.0` records acme and pins acme, on every machine. That path is the whole
 * consumer population; the checkout is toolkit developers, who have the toolkit in their hand already.
 *
 * A fork that renders from a CHECKOUT and wants a pinnable lock cuts its release and installs it the way
 * its own consumers do — `npx github:acme/wafflestack#v1.0.0` — which is the path that can prove the pin.
 *
 * **The `repo` tail is gated on the same fact, or it reopens the hole it just closed.** When no
 * pin-derived slug exists at all, falling back to `repo` is safe on every origin EXCEPT a checkout —
 * because `repoSlug`'s origin step is `.git`-gated, so "not a checkout" is *exactly* the condition
 * under which `repo` cannot be `remote.origin.url`. On a checkout it can be, and a toolkit whose
 * `package.json` declares no `repository` (`lockRepo: null`, `repo:` the clone's origin) would walk
 * straight back into F11 through the fallback. There, the honest answer is that we do not know which
 * repo this came from: `source: null`, which `describeToolkitProvenance` already renders as "an
 * unknown toolkit" and `toolkitPinFromLock` already declines to pin. **An unknown repo is recorded as
 * unknown — never as the clone's.**
 *
 * @param {ToolkitIdentity} identity
 * @returns {string|null}
 */
function lockSourceRepo(identity) {
  // THE RELEASE CARVE-OUT, INVERTED (#384 F13). F2 carved `release` out to record the CLONE; F11 killed
  // that. The carve-out that IS right is the opposite one, and it records NOTHING: a `release` block's
  // `source` is the repo its PIN names, and it may only name a repo we established actually holds that
  // `ref` at that `commit`. Exactly one path establishes it — `npm-install`, where `ls-remote` found
  // the tag on that commit in that remote (and `repo === lockRepo` there, so there is no third answer).
  // A CHECKOUT establishes nothing: `git describe` reads the clone's LOCAL tag refs, zero remotes asked.
  if (identity.status === 'release' && identity.origin !== 'npm-install') return null;
  if (identity.lockRepo) return identity.lockRepo;
  if (identity.origin === 'checkout') return null;
  return identity.repo ?? null;
}

/**
 * Do two `files` maps record exactly the same paths at exactly the same hashes? The carry-forward's
 * precondition, and the reason it is airtight rather than a guess: the old provenance is preserved
 * only when the bytes it describes are the bytes we just rendered.
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
 * The npx spec that reproduces the toolkit a lock was rendered by — `github:<owner>/<repo>#<tag>`,
 * or **null** when the lock cannot name one (no `toolkit` block, a non-release render, or a release
 * whose repo slug was unknowable).
 *
 * THIS IS #372's READ-BACK, and the reason it lives here rather than in the consumer: #372 must not
 * do string surgery on the lock. A test pins the triple equality
 * `toolkitPinFromLock(releaseLock) === toolkitRef(slug, tag) === identity.ref`, so the lock's pin
 * format and the CLI's cannot drift apart.
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
 * Compare the provenance the LOCK recorded against the toolkit NOW IN HAND, and say what the
 * difference means. `doctor` turns this into notes.
 *
 * **This is a WARNING, never an error** — see `doctor`, which must not fold the verdict into `ok`.
 * The headline capability is `recut`: the lock and the CLI agree on the version and disagree on the
 * commit. `"0.12.0"` alone structurally cannot express that, and expressing it is this issue's whole
 * point.
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
  // "marked X", not "an X toolkit": the article cannot be right for every status (`an RELEASE`), and a
  // malformed block printed `an UNDEFINED toolkit`. Sidestep the article and give `status` a fallback,
  // so no lock — however hand-edited — can make this sentence ungrammatical or say `UNDEFINED` (#384 F7).
  const lockStatus = String(lockToolkit.status ?? 'unidentified').toUpperCase();
  if (lockToolkit.status !== 'release') {
    // Informational, and the shape this repo's OWN lock is in — plus every consumer who rendered
    // through the hatch, or through pnpm/yarn `dlx` (#383). There is nothing to compare against.
    return {
      status: 'unpinnable',
      notes: [
        `the lock was rendered by a toolkit marked ${lockStatus} (${lockToolkit.source ?? 'source unknown'}) — its provenance cannot be pinned to a release, so there is nothing to compare this CLI against`,
      ],
    };
  }
  if (!lockToolkit.commit) {
    // A RELEASE block with no commit. THE TWO HALVES MUST AGREE (#384 F7): this branch used to be
    // folded into `unpinnable` above and told the reader the provenance "cannot be pinned to a
    // release" — while `toolkitPinFromLock`, which #372 consumes for the pin, pins this exact block
    // and returns `github:owner/repo#v0.12.0`. The lock IS pinnable; what it lacks is a commit to
    // compare AGAINST, which is a different sentence. Say that one instead.
    //
    // `toolkitLockEntry` cannot emit this block — but a hand-edited, foreign, or future-CLI lock can,
    // and that is the stated reason `toolkitPinFromLock` keeps its "redundant" status guard.
    return {
      status: 'unverifiable',
      notes: [
        `the lock names ${pin ?? lockToolkit.source ?? 'an unknown toolkit'} but recorded no commit, so this CLI cannot be compared against it`,
      ],
    };
  }
  if (!identity || identity.status !== 'release' || !identity.commit) {
    // Cannot compare — and, on an npx install, this is the NORMAL state for plain `doctor`, which
    // resolves its identity OFFLINE and therefore cannot reach `release` at all. Say what the lock
    // holds and stop; a comparison against an unknown is not a mismatch.
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
  // Do the two blocks even name the same REPOSITORY? `recut` used to assert "the tag was re-cut or
  // force-pushed" without ever asking (#384 F3) — so a fork's genuine `v0.12.0` doctored against
  // upstream's genuine `v0.12.0` (two repos, neither tag touched) was told its tag had been
  // force-pushed. That is an assertion about a remote this code never queried, and the correct
  // diagnosis was sitting unread in `lockToolkit.source` and `identity.repo`.
  //
  // THE COMPARISON IS THREE-STATE, NOT TWO (#384 F12). `same` / `different` / **`unknown`** — and
  // collapsing `unknown` into `same` is how F3's own fix reintroduced the over-claim it was fixing.
  // `differentRepos` is false when a source is merely NULL, so a bare clone's release block
  // (`source: null` — `toolkitLockEntry` emits these, and a test pins one) took the `recut` branch and
  // was told the two "both report version 0.12.0 **from the same repository**" — in a sentence that had
  // just named the lock "an unknown toolkit". Self-contradicting, and an assertion of a fact never
  // established. Assert only what was checked: unknown gets a hedge, never membership in "same".
  const lockSource = lockToolkit.source ?? null;
  const cliSource = toolkitSource(identity.repo);
  const comparable = Boolean(lockSource && cliSource);
  const differentRepos = comparable && lockSource !== cliSource;
  const sameRepo = comparable && lockSource === cliSource;
  if (lockVersion && identity.version && lockVersion === identity.version && !differentRepos) {
    // THE HEADLINE (#374) — one version, two commits. The bare version string collapses this into "no
    // skew" and says nothing. Both provenances are named, so a reader can see the evidence rather than
    // trust the verdict; and the CAUSE is stated only as strongly as the evidence supports it.
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
    // Same version, DIFFERENT repositories — the ordinary shape for the fork population #373 F14
    // exists to serve, and the one state that must never be called a re-cut tag.
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
 * Which GitHub repo is this toolkit? **PROVENANCE BEFORE DECLARATION** — where this build actually
 * CAME FROM beats what it SAYS it is. In order:
 *
 *   1. npm's hidden lockfile (`resolved`) — the URL npm actually cloned. Offline.
 *   2. a checkout's `origin` remote — where this working tree actually came from. Offline.
 *   3. `package.json` `repository` — the DECLARED answer, and only a fallback for a toolkit that
 *      has neither of the above (a registry tarball, a vendored copy with no git).
 *
 * The order was the other way round, and it asked the WRONG REMOTE for the population this function
 * exists to serve. A fork inherits `repository` verbatim: nothing prompts anyone to rewrite it — the
 * package is `private: true`, never published, and #373 is what introduced the field. So `npx
 * github:acme/wafflestack#v1.0.0`, a consumer correctly pinned to a real release OF THE FORK, had
 * its `ls-remote` pointed at UPSTREAM, which has never heard of that commit → `unreleased` →
 * **hard-refused**, and then handed `npx --yes github:dustinkeeton/wafflestack#v0.12.0` — a remedy
 * that installs A DIFFERENT REPO'S TOOLKIT and renders upstream content into their repo. Three
 * failures at once: a correctly-pinned release refused (the inverse of #373), a remedy that is
 * actively wrong to follow, and — once #374 lands — upstream's slug baked into the fork's lock as
 * provenance.
 *
 * It also made the zero-release-tag machinery (`provablyNone`) unreachable for exactly the
 * population it was written for: an unedited fork's lookup landed on upstream, which always HAS
 * tags, so the honest `latestTag: null` path could never fire.
 *
 * Both provenance sources are read offline, so the offline guarantee is untouched — and the fork
 * comments in this module become true instead of aspirational.
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
 * The same question, asked **for the committed lock** — and the answer differs on exactly one step.
 *
 *   1. npm's hidden lockfile (`resolved`) — **kept, and it is the whole of #373 F14.** This is not
 *      machine state: it is *the pin the operator typed*, recorded by npm. `npx
 *      github:acme/wafflestack#v1.0.0` resolves to acme on every machine that runs it, so a fork
 *      still names ITSELF in its own lock. Read offline, from the lockfile, never the network.
 *   2. `package.json` `repository` — the DECLARED answer, which SHIPS WITH THE CONTENT and is
 *      therefore a function of the pinned commit.
 *
 * **`remote.origin.url` is deliberately absent, and that is the fix for #384 F2.** The origin step in
 * `repoSlug` is gated on `.git`, so it fires on ONE path — a checkout — and there it reads a value
 * that is not a function of the pin, the commit, or the rendered bytes. It is a property of the CLONE
 * the renderer happened to use. Two contributors on the same commit, rendering identical bytes, wrote
 * `source: github:<their-own-fork>/wafflestack` and `source: github:dustinkeeton/wafflestack` into the
 * COMMITTED lock — churning it back and forth and redding the documented `render` + `git diff
 * --exit-code` gate for a change that moved no rendered byte. That is precisely the nondeterminism the
 * plan cited to reject recording `origin` at all ("two consumers on the same pinned release write
 * different locks… determinism wins", #317), re-admitted through a different door.
 *
 * **Why this does not regress #373 F14**, which exists to stop upstream's slug being baked into a
 * fork's lock: F14's failing population is the **npm/npx** path, and an npm-installed toolkit HAS NO
 * `.git` — so `repoSlug`'s origin step never ran for it in the first place. F14 is carried entirely by
 * step 1, which is preserved verbatim. The origin step only ever served the **checkout**, and for the
 * checkout it is `resolveToolkitIdentity`'s NETWORK lookup and remedy message that need it
 * ("which remote do I ask about tags?") — questions this function does not answer. Those still call
 * `repoSlug`, unchanged.
 *
 * A fork that renders from a CHECKOUT and wants its lock to name itself has a deterministic way to
 * say so: set `repository` in `package.json` — a committed, content-bearing edit, and therefore a
 * function of the pin, which is exactly the property `origin` lacks.
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
 * Parse any of the forms a GitHub repo is written in — `git+https://…`, `git+ssh://git@…`, the scp
 * form `git@github.com:o/r.git`, `github:o/r`, or a bare `o/r` — into `{owner, repo}`.
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
    // A bare `owner/repo`. Anchored on a leading word character so a relative path (`../elsewhere`)
    // can never be mistaken for one — that would send `ls-remote` at a nonsense URL.
    /^(\w[\w.-]*)\/(\w[\w.-]*?)(?:\.git)?$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The URL to hand `git ls-remote`. Normalizing to https is not cosmetic: npm records the resolved
 * URL as `git+ssh://git@github.com/…`, and an unauthenticated `ls-remote` against THAT demands an
 * ssh key — so on a CI runner with no key the lookup would fail, degrade to `unverified`, and
 * silently defeat the whole gate.
 *
 * @param {{owner: string, repo: string}} slug
 * @returns {string}
 */
export function httpsUrl(slug) {
  return `https://github.com/${slug.owner}/${slug.repo}.git`;
}

/**
 * Default `lsRemote`: shell out to git. Deliberately NOT `--refs` — that flag drops the peeled
 * `refs/tags/vX^{}` lines, which are the only way to learn the COMMIT an annotated tag points at
 * (see `parseLsRemoteTags`). A non-zero exit throws with git's stderr attached, and the caller
 * turns that into `unverified` rather than into an outage.
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
      // No credential prompt may EVER block a render. An unauthenticated public fetch is all this
      // needs, and a repo that answers with a prompt is a repo we simply cannot classify.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' },
    });
  } catch (err) {
    const e = /** @type {any} */ (err);
    const stderr = e?.stderr ? String(e.stderr).trim() : '';
    throw new Error(stderr || e?.message || 'git ls-remote failed');
  }
}

/**
 * Default `runGit`: capture a git command's stdout, or null. Null is not an error here — `git
 * describe --tags --exact-match HEAD` exits non-zero precisely when HEAD is UNTAGGED, which is the
 * single most important answer this module gets, so a non-zero exit must read as data, not as a
 * crash.
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
 * Does the SHIPPED changelog carry a non-empty `## [Unreleased]` section? See `corroborate`.
 * A heading with nothing under it (what a release leaves behind) is NOT evidence — and neither is
 * the empty SCAFFOLD a release leaves behind, which is the same claim and needs saying out loud.
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
 * Real entries under `## [Unreleased]`, or only the empty Keep-a-Changelog scaffold?
 *
 * This is the honesty of the whole corroborator (#373 review). A bare `/\S/` on the section body
 * reads `### Added`, `<!-- add entries here -->` and `_Nothing yet._` as ENTRIES — and those are the
 * three idioms a Keep-a-Changelog release process routinely leaves in place. Since `corroborate()`
 * only ever tightens `unverified` → `unreleased`, and `unreleased` REFUSES, a derivative whose
 * release process leaves the scaffold would ship a genuinely tagged release whose own CHANGELOG
 * testifies against it: one lookup failure (a corporate proxy npm honours via `.npmrc` but
 * `git ls-remote` does not; git egress blocked while the registry is not) and a correctly-pinned
 * release is hard-refused. That is bricking a legitimate consumer, not being wrong in the safe
 * direction — the accepted false positive is a DEFAULT BRANCH that matches the tag, which is a far
 * more benign thing than a release.
 *
 * So strip what a release leaves behind — sub-headings, HTML comments, emphasis-only placeholders —
 * and only then ask whether anything is left. This repo's own `release` skill happens to leave the
 * section truly empty, which is exactly why the hole was invisible; the guard must not rest on a
 * convention it never states.
 *
 * WHICH DIRECTION TO ERR, when a shape is ambiguous — the ordering is not symmetric, and the first
 * cut of this function got it backwards:
 *
 *   - Strip too LITTLE → the corroborator over-fires → `unreleased` → a REFUSAL. Recoverable: the
 *     message names the pin, and `--allow-unreleased` is one flag away. (This was F8's bug.)
 *   - Strip too MUCH  → the corroborator goes blind → `unverified` → PROCEED → a default branch
 *     renders into a consumer's lock. That is issue #373 itself, unrecoverable and silent.
 *
 * So every filter here must key on what a placeholder SAYS, never on what an entry LOOKS LIKE. The
 * emphasis rule below keyed on shape and swallowed `**Breaking: render now refuses.**` — a real
 * entry, emphasized. Shape is the vocabulary of entries; only the WORDS are the vocabulary of
 * placeholders. When in doubt, keep the line: a false refusal is the direction this module is
 * allowed to be wrong in.
 *
 * @param {string} body the `## [Unreleased]` section, heading line already removed
 * @returns {boolean}
 */
function hasEntries(body) {
  const substance = body
    // "<!-- add entries here -->" — may span lines, so strip before the line filters.
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    // "### Added" / "#### Fixed" — a sub-heading with nothing under it is scaffolding, not an entry.
    // (`## ` cannot appear here: the caller split the file on it.) Unambiguous: a heading is never
    // itself an entry, and anything written UNDER it survives this filter untouched.
    .filter((line) => !/^\s*#{3,}\s/.test(line))
    // "_Nothing yet._", "*None.*", "**No changes.**", "_TBD_" — a placeholder, recognised by its
    // VOCABULARY and not by its emphasis. An emphasized line that says anything else is an ENTRY:
    // `**Breaking: render now refuses.**` stands, and so does `_Support for pnpm added._`. Bullets
    // (`- x`, `* x`, `* **x**`) never matched this and still do not.
    .filter((line) => !PLACEHOLDER_LINE.test(line))
    .join('\n');
  return /\S/.test(substance);
}

/**
 * An emphasis-wrapped line whose WORDS say "there is nothing here". Deliberately a closed vocabulary
 * rather than a shape: see the safety ordering in `hasEntries`. A placeholder this misses costs a
 * refusal (recoverable); an entry this eats costs a silent unreleased render (#373).
 *
 * The phrase must be the WHOLE line — vocabulary, optional trailing punctuation, close. Matching it
 * as a mere PREFIX would eat `**Nothing is broken by this release.**`, a real entry that happens to
 * open with a placeholder word; the tail is where the meaning lives. Erring toward keeping the line
 * is the safe direction by construction.
 */
const PLACEHOLDER_LINE = /^\s*[_*]{1,2}\s*(nothing(\s+yet)?|none|no\s+(changes?|entries)|n\/a|tbd|empty)\s*[.!]?\s*[_*]{1,2}\s*$/i;

/**
 * The newest released version heading in a Keep-a-Changelog file, as a `vX.Y.Z` tag. The remedy
 * message's last line of defence when there is no tag list to read (offline, on an npx install).
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
 * The refusal. This message IS the feature — the whole value of failing closed over silently
 * rendering the default branch is that the consumer is handed the exact command to run instead, so
 * make it copy-pasteable and say why.
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
  // NO release tag to name — and the message must not claim more than it knows about WHY. Three
  // epistemic states reach `latestTag === null`, and only ONE licenses the strong sentence:
  //
  //   1. npm-install, `ls-remote` RAN AND SUCCEEDED, zero release tags → we looked; there are none.
  //      A fork or vendored copy that has cut no tags of its own is the ordinary shape of this
  //      (`git clone` + push carries none), and it is the population `repoSlug` exists to serve.
  //   2. npm-install, the lookup THREW or was skipped → `corroborate()` can still reach `unreleased`
  //      off the shipped changelog, with no tag to name. WE NEVER QUERIED THE REMOTE.
  //   3. checkout with no local `v*` tags (a `--depth 1` / `--no-tags` clone) → the checkout path
  //      queries the remote BY DESIGN NEVER.
  //
  // `lookupError` is the discriminator, and it is already on the contract: it is null on exactly the
  // paths where a lookup ran and succeeded, and set on every path that could not look. So state 1
  // gets the assertion, and 2 and 3 get a hedge — because telling a fork's user that
  // `--allow-unreleased` is their only path, when a perfectly good release tag exists and we merely
  // failed to see it, sends them to render unreleased content for no reason. Either way we print no
  // pinned command: a `Run this instead:` block that cannot resolve is worse than the refusal it
  // decorates, and this message's whole justification is that what it hands back WORKS.
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
 * The warning for the commands that are NOT gated but still read the toolkit (`list`, `setup`), and
 * for a proceed-anyway (`--allow-unreleased`) or an unanswerable lookup. Reporting-only commands
 * are never refused — `setup` is the documented onboarding entry point, and breaking it would be
 * gratuitous — but they must still say what they are.
 *
 * @param {ToolkitIdentity} identity
 * @returns {string|null} null when the toolkit IS a release (nothing to say)
 */
export function formatProvenanceWarning(identity) {
  if (identity.status === 'release') return null;
  const repo = identity.repo ?? FALLBACK_REPO;
  const at = identity.commit ? ` (${identity.commit.slice(0, 7)})` : '';
  // Same rule as the refusal: never advise a pin that cannot exist. With no release tag known for
  // this repo there is nothing to pin TO, and a `#<latest release tag>` placeholder would send a
  // fork's users hunting for a tag their remote does not have.
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
