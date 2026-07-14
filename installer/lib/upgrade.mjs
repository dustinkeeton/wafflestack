import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { exists, compareVersions, parseVersion } from './util.mjs';
import { readLock, renderProject } from './render.mjs';
import { doctor } from './doctor.mjs';
import { MIGRATIONS, runMigrations } from './migrations.mjs';
import { CONFIG_FILE, LOCK_FILE, resolveConfigFile, setScalarIn } from './project.mjs';
import { classifyToolkitRefValue, toolkitPinFromIdentity, parseRepoSlug } from './toolkit-ref.mjs';

const CHANGELOG_FILE = 'CHANGELOG.md';

/**
 * The two config keys that decide WHICH TOOLKIT ACTUALLY RUNS in a consumer repo (#372), as YAML
 * paths in `.waffle/waffle.yaml`. Both live under `config:` — that is not a detail, it is the only
 * place the resolver reads (`loadProjectConfig`: `values: cfg.config ?? {}`; `makeResolver` →
 * `lookupPath`, which walks NESTED objects and never resolves a flat literal `"doctor.toolkitRef"`
 * key). A pin written anywhere else is inert, so a pin found anywhere else is not ours to move.
 *
 *   - `doctor.toolkitRef` → `.github/workflows/waffle-doctor.yml` — the toolkit CI's doctor job fetches
 *   - `waffle.toolkitRef` → every rendered `waffle-*` SKILL.md — the toolkit every `/waffle-*` skill runs
 */
const TOOLKIT_REF_KEYS = [
  ['config', 'doctor', 'toolkitRef'],
  ['config', 'waffle', 'toolkitRef'],
];

/**
 * Move a consumer repo from the toolkit version its lock records to the toolkit version
 * being invoked. The flow, in order:
 *   1. read the lock's `toolkitVersion` (the "from" version);
 *   2. print what changed between then and now (from CHANGELOG.md, degrading gracefully
 *      when the file is absent);
 *   3. run any registered migrations whose version is in `(from, to]`, in order;
 *   4. **reconcile the pinned `toolkitRef` config keys** to the toolkit that is rendering (#372);
 *   5. re-render every managed file for the current config;
 *   6. run `doctor` and fold its result into the outcome.
 *
 * Migrations run BEFORE render so a step that changes file layout (a rename, a moved
 * config key) leaves the tree in the shape render expects. A missing lock or a lock with
 * no `toolkitVersion` is reported clearly and degrades to "render + doctor, no migrations"
 * rather than erroring — there is simply no known baseline to migrate from.
 *
 * **Step 4's position is load-bearing, and it is why this is not a migration** (#372). The two
 * `toolkitRef` keys are template placeholders: `render` bakes them into `waffle-doctor.yml` and every
 * `waffle-*` skill, and `renderProject` re-reads `.waffle/waffle.yaml` FROM DISK. Writing the pin
 * between the migrations and the render is therefore what makes ONE `upgrade` move the config, the
 * rendered output and the lock together — the same run, no second command. A migration could not do
 * it: migrations receive only `cwd` (so they cannot know `toVersion`), run only on `status:
 * 'upgrade'`, and exist for breaking changes. The pins need reconciling on `status: 'current'` too —
 * that is precisely the state the already-broken repo is sitting in (lock at 0.13.0, pin still at
 * `#v0.12.0`, CI red), and the state it heals from.
 *
 * External sources are re-resolved per pin (`refreshSources`): the re-render re-fetches each git
 * source so a MOVED ref (e.g. a branch that advanced) is observed rather than served stale from
 * the session cache, and the resolved commits are diffed against the lock's recorded provenance
 * to report per-source version moves (#125). `sourceMoves` carries that diff.
 *
 * Returns a structured result; the CLI is responsible for presentation.
 */
export function upgrade({
  toolkitRoot,
  cwd,
  toolkitVersion,
  toolkitIdentity = null, // #373: what the running CLI IS (release/unreleased/unverified + the ref)
  migrations = MIGRATIONS,
  changelog, // optional raw markdown override; defaults to reading toolkitRoot/CHANGELOG.md
  sourceCacheDir, // optional cache dir override (threaded to render); default keeps prod behavior
  log = () => {},
}) {
  const notes = [];
  const lock = readLock(cwd);
  const fromVersion = lock?.toolkitVersion ?? null;
  // `toVersion` is the running CLI's own package.json version, and #373 is what finally makes that
  // honest: the CLI now REFUSES to upgrade from a toolkit that is not a release, so by the time we
  // are here, `toolkitVersion` names a tag whose content is exactly what we are about to render. It
  // used to be a number the default branch merely carried around.
  const toVersion = toolkitVersion;
  // Snapshot the pre-render per-source provenance so we can diff resolved commits after re-render.
  const oldSources = new Map((lock?.sources ?? []).map((s) => [s.name, s]));
  // …and the same for the BUILT-IN toolkit (#374). `oldToolkit` is null for a lock written before
  // the `toolkit` block existed — the exact `?? null` idiom `oldSources` already uses for a pre-#125
  // lock, and the whole of the backward-compatibility story.
  const oldToolkit = lock?.toolkit ?? null;

  // Decide whether we have a baseline to migrate from, and describe the move.
  let status;
  let migrate = false;
  if (!lock) {
    status = 'no-lock';
    notes.push(`no ${LOCK_FILE} found — nothing to upgrade from; running a fresh render`);
  } else if (!fromVersion) {
    status = 'no-version';
    notes.push(
      `${LOCK_FILE} records no toolkitVersion (rendered by an older toolkit) — skipping migrations and changelog; re-rendering will stamp ${toVersion}`,
    );
  } else {
    const cmp = compareVersions(fromVersion, toVersion);
    if (cmp < 0) {
      status = 'upgrade';
      migrate = true;
      notes.push(`upgrading ${fromVersion} → ${toVersion}`);
    } else if (cmp === 0) {
      status = 'current';
      notes.push(`already on toolkit ${toVersion} — re-rendering to confirm the tree is in sync`);
    } else {
      status = 'downgrade';
      notes.push(
        `lock is toolkit ${fromVersion}, newer than this CLI (${toVersion}) — re-rendering to the older version; no migrations run`,
      );
    }
  }

  // Changelog delta (only meaningful for a real forward move with a known baseline).
  let changelogDelta = null;
  if (status === 'upgrade') {
    const text = changelog ?? readChangelog(toolkitRoot);
    if (text == null) {
      notes.push(`no ${CHANGELOG_FILE} shipped with this toolkit — skipping the change summary`);
    } else {
      changelogDelta = changelogBetween(text, fromVersion, toVersion);
      if (!changelogDelta) {
        notes.push(`no ${CHANGELOG_FILE} entries between ${fromVersion} and ${toVersion}`);
      }
    }
  }

  // THE SELF-UPGRADE TRAP, ANSWERED (#372). A repo whose `waffle.toolkitRef` is pinned to an old tag
  // runs the OLD CLI when `/waffle-upgrade` fires it: `toVersion` equals the version already in the
  // lock, `status` is `current`, and the upgrade that was supposed to move the pin reports "already on
  // toolkit X" and moves nothing. The old CLI structurally cannot contain the fix, and re-exec is off
  // the table (#373: a toolkit that silently re-executes a DIFFERENT toolkit is exactly the
  // unpinned-render class of bug this epic exists to kill).
  //
  // But a pinned CLI is not ignorant — it is merely stuck. `resolveToolkitIdentity` learns `latestTag`
  // from `ls-remote` (npx) or the local tag list (checkout) EVEN WHEN its own commit maps to an older
  // tag. So it can name the exact command that escapes the trap, and hand it to the operator (or to
  // `/waffle-upgrade`, whose escalation flow runs it). Report and name; never re-exec.
  //
  // The pins are NOT bumped to `latestTag`: a pin records what RENDERED, and this CLI is what rendered.
  const newerRelease = describeNewerRelease(toolkitIdentity, toVersion);
  if (newerRelease) notes.push(newerRelease.note);

  // Emit the narrative up front — what's moving and what changed — before the mechanical
  // migration/render logs, so a consumer reads the changelog before it's applied.
  for (const n of notes) log(n);
  if (changelogDelta) {
    log('\nchanges since the version this repo last rendered from:\n');
    log(changelogDelta);
    log('');
  }

  // Migrations.
  let migrationsRun = [];
  if (migrate) {
    migrationsRun = runMigrations({ cwd, fromVersion, toVersion, migrations, log }).map((m) => ({
      version: m.version,
      description: m.description,
    }));
    if (!migrationsRun.length) log(`no migrations registered between ${fromVersion} and ${toVersion}`);
  }

  // Move the pins the consumer already chose (#372) — AFTER the migrations (one could move the config
  // key itself) and BEFORE the render, which re-reads `.waffle/waffle.yaml` from disk and bakes these
  // two values into `waffle-doctor.yml` and every `waffle-*` skill. Runs on EVERY status, `current`
  // included; idempotent by the dirty guard, so a repo whose pins are already right is a zero-byte
  // no-op. A repo that pinned nothing is a zero-byte no-op twice over.
  const pinMoves = reconcileToolkitRefPins({ cwd, identity: toolkitIdentity, log });

  // Re-render (re-resolving each external source at its pin — refreshSources re-fetches git
  // sources so a moved ref is observed, not served from the session cache), then doctor.
  const render = renderProject({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity, sourceCacheDir, refreshSources: true, log });
  if (!render.ok) {
    // `pinMoves` rides the failure return too — the config writes ALREADY HAPPENED (migrations set the
    // same precedent: they mutate `cwd` before the render can fail). A caller that reported only on
    // success would leave a bumped pin invisible in the one run where knowing about it matters most.
    return { ok: false, status, fromVersion, toVersion, identity: toolkitIdentity, changelogDelta, migrationsRun, render, doctor: null, sourceMoves: [], toolkitMove: null, pinMoves, newerRelease: newerRelease?.result ?? null, notes };
  }

  // Per-source version moves: diff the freshly-resolved commits against the lock's recorded ones.
  const sourceMoves = diffSources(oldSources, render.sources ?? []);
  for (const move of sourceMoves) log(describeSourceMove(move));

  // The BUILT-IN toolkit's move (#374) — the same report, for the toolkit every consumer depends on.
  // The case this exists for is the one `status` above cannot see: `toVersion === fromVersion` →
  // `status: 'current'` → "already on toolkit X" — while the COMMIT moved underneath it (a re-cut
  // tag, or one of the two renders ran an unreleased toolkit). Upgrade can now say so.
  const toolkitMove = diffToolkit(oldToolkit, render.toolkit ?? null, { fromVersion, toVersion });
  const moveNote = toolkitMove ? describeToolkitMove(toolkitMove) : null;
  if (moveNote) log(moveNote);

  const dr = doctor({ cwd, toolkitVersion, toolkitIdentity, toolkitRoot });

  return {
    ok: render.ok && dr.ok,
    status,
    fromVersion,
    toVersion,
    // The resolved identity of the toolkit that did the upgrade — `{ ref, commit, tag }`. #372
    // consumes it to bump `doctor.toolkitRef` / `waffle.toolkitRef` to the ref that just rendered,
    // which is the pin a consumer's CI must use if it is to reproduce this render.
    identity: toolkitIdentity,
    changelogDelta,
    migrationsRun,
    render,
    doctor: dr,
    sourceMoves,
    // The built-in toolkit's commit move, or null when neither lock recorded provenance (a pre-#374
    // lock re-rendered by a library caller that supplied no identity). #372 branches on `status`.
    toolkitMove,
    // What happened to each `toolkitRef` config key the consumer had pinned (#372) — the mirror of
    // `sourceMoves`, for the two pins that decide which toolkit their CI and their skills run.
    // Empty when nothing was pinned, which is most repos, this one included.
    pinMoves,
    // `{ tag, command } | null` — a release NEWER than the toolkit that just ran. The pinned-CLI
    // escape hatch: it names what to run, because it cannot run it.
    newerRelease: newerRelease?.result ?? null,
    notes,
  };
}

/**
 * Reconcile the pinned `toolkitRef` config keys in `.waffle/waffle.yaml` with the toolkit that is
 * about to render (#372) — the write-side of the pin, and the last link of epic #377's
 * resolve → record → **move** chain.
 *
 * ## The rule, in one sentence
 *
 * **Rewrite a `toolkitRef` key if and only if the consumer already pinned it release-shaped, and
 * write the pin the lock is about to record — nothing else, nowhere else.**
 *
 * Everything else follows from that:
 *
 *   - **A pin is never INTRODUCED.** An absent key and an unpinned `github:owner/repo` are hard
 *     no-ops, not oversights: unpinned is a CHOICE (it floats to the default branch, deliberately),
 *     and silently pinning it would change what a consumer's CI fetches without them asking. Both
 *     leave the file byte-identical, which is a tested property, not an intention.
 *   - **`#main` / `#<sha>` / `#nightly` are left alone and NOTED.** They are pins we did not write and
 *     cannot interpret; saying so beats both silence and a rewrite.
 *   - **The value written is `toolkitPinFromIdentity(identity)`** — by construction the same string
 *     `toolkitPinFromLock` will read back out of the lock this render is about to write. Not string
 *     surgery on the old value: see `classifyToolkitRefValue` for why preserving the authored style or
 *     slug would write a pin that does not resolve (`#0.13.0`) or one that names a repo which did not
 *     render the lock.
 *   - **A non-pinnable toolkit writes NOTHING.** Hatch / `dlx` / a blip (`unverified`, #383), a
 *     provably unreleased tree, or a release CHECKOUT (#384 F13) all yield a null pin — and a null pin
 *     means the file is not touched. It is logged, because a repo whose release-shaped pin was left
 *     unreconciled deserves to hear why rather than assume it moved.
 *
 * ## What it writes, and where
 *
 * Only the COMMITTED config (`resolveConfigFile`) — `.waffle/waffle.local.yaml` is a developer's
 * private, gitignored overlay (#317), and a pin there (typically a local checkout path) is a
 * deliberate machine-local override. It is neither read nor written here.
 *
 * The edit is an in-place `Scalar.value` mutation (`setScalarIn`), never `doc.setIn`, which builds a
 * fresh node and drops the comments attached to the old one. One dirty-guarded write, the idiom the
 * other two config writers already use (`eject`, `installRefs`).
 *
 * @param {object} opts
 * @param {string} opts.cwd the consumer repo
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} opts.identity the toolkit performing the render
 * @param {(msg: string) => void} [opts.log]
 * @returns {{key: string, from: string, to: string|null, action: 'bumped'|'unchanged'|'left'|'skipped', reason: string}[]}
 */
export function reconcileToolkitRefPins({ cwd, identity = null, log = () => {} }) {
  /** @type {{key: string, from: string, to: string|null, action: 'bumped'|'unchanged'|'left'|'skipped', reason: string}[]} */
  const pinMoves = [];
  const { file: configFile } = resolveConfigFile(cwd);
  if (!exists(configFile)) return pinMoves; // `render` will fail on this next, with a better message

  const doc = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'));
  if (doc.errors?.length) {
    // A config that does not parse is one `render` is about to reject anyway. Do not half-write it.
    log(`could not reconcile the pinned toolkitRef keys — ${CONFIG_FILE} did not parse cleanly; leaving it untouched`);
    return pinMoves;
  }

  const pin = toolkitPinFromIdentity(identity);
  const pinSlug = parseRepoSlug(pin);
  let dirty = false;

  for (const keyPath of TOOLKIT_REF_KEYS) {
    const key = keyPath.slice(1).join('.'); // "doctor.toolkitRef" — how a consumer names it
    const current = doc.getIn(keyPath);
    const found = classifyToolkitRefValue(current);
    // An absent, floating, or non-github value is not a pin we may move. Say nothing: on the
    // overwhelming majority of repos (this one included) BOTH keys land here, and a line of output
    // per non-event on every upgrade is noise, not information.
    if (found.kind === 'absent' || found.kind === 'unpinned' || found.kind === 'not-github') continue;

    const from = String(current).trim();
    if (found.kind === 'other-pin') {
      const reason = `pinned to \`#${found.fragment}\`, which is not a release tag — \`upgrade\` moves release pins only`;
      pinMoves.push({ key, from, to: null, action: 'left', reason });
      log(`${key} is ${reason}; left as ${from}`);
      continue;
    }

    // A release-shaped pin, and the only kind we rewrite.
    if (!pin) {
      const reason = unpinnableReason(identity);
      pinMoves.push({ key, from, to: null, action: 'skipped', reason });
      log(`${key} still pins ${from} and was NOT reconciled — ${reason}`);
      continue;
    }
    if (from === pin) {
      pinMoves.push({ key, from, to: pin, action: 'unchanged', reason: 'already pins the toolkit that rendered' });
      continue;
    }
    if (setScalarIn(doc, keyPath, pin)) dirty = true;
    pinMoves.push({ key, from, to: pin, action: 'bumped', reason: 'moved to the toolkit that rendered this lock' });
    log(`${key} ${from} → ${pin}`);
    // A rewrite that changes the OWNER/REPO is truthful — the pin must name the toolkit that rendered
    // — but it is never routine, so it is never quiet. It is what a consumer sees when they switch to
    // (or away from) a fork, and the one case where the new pin points at a repo they did not author.
    if (found.slug && pinSlug && (found.slug.owner !== pinSlug.owner || found.slug.repo !== pinSlug.repo)) {
      log(
        `  note: that is a DIFFERENT REPOSITORY (${found.slug.owner}/${found.slug.repo} → ${pinSlug.owner}/${pinSlug.repo}) — ` +
          'the pin names the toolkit that rendered this lock, which is the one CI must fetch to reproduce it',
      );
    }
  }

  if (dirty) fs.writeFileSync(configFile, doc.toString());
  return pinMoves;
}

/**
 * Why a release-shaped pin was left unreconciled — i.e. why `toolkitPinFromIdentity` returned null.
 * Every branch is a case where writing a pin would be a claim we cannot back (see
 * `toolkitPinFromIdentity`), so the honest report is the whole of the feature here.
 *
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} identity
 * @returns {string}
 */
function unpinnableReason(identity) {
  if (!identity) return 'this run recorded no toolkit identity, so there is no ref to pin to';
  if (identity.status !== 'release') {
    return `the toolkit that rendered is ${identity.status}, so it has no release ref to pin to (a \`--allow-unreleased\` run, a \`dlx\` install, or a release lookup that could not answer)`;
  }
  // A release with no pin: `toolkitLockEntry` recorded `source: null`. A CHECKOUT release is the
  // reachable case (#384 F13) — `git describe` reads local refs and corroborates no remote.
  return identity.origin === 'checkout'
    ? 'the toolkit that rendered is a release CHECKOUT — no remote was asked whether any repository holds that tag, so there is no pin it can honestly write into your config'
    : 'the toolkit that rendered is a release, but no repository could be established for it, so there is no pin to write';
}

/**
 * A release NEWER than the toolkit that is running — the other half of #372's answer to the
 * self-upgrade trap (see the call site). Returns the note to print AND the structured `{tag, command}`
 * the CLI/skill consume, or null when this CLI is the latest thing it knows of.
 *
 * `compareVersions` tolerates the `v` prefix (`parseVersion`), so `latestTag` ("v0.14.0") and
 * `toVersion` ("0.13.0") compare directly.
 *
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} identity
 * @param {string|null|undefined} toVersion the version this CLI is rendering
 * @returns {{note: string, result: {tag: string, command: string|null}}|null}
 */
function describeNewerRelease(identity, toVersion) {
  const tag = identity?.latestTag ?? null;
  if (!tag || !toVersion || compareVersions(tag, toVersion) <= 0) return null;
  // The remedy must name a command that RESOLVES, or it is worse than saying nothing (the rule
  // `formatUnreleasedRefusal` already lives by). With no repo we can still name the tag.
  const repo = identity?.repo ?? identity?.lockRepo ?? null;
  const command = repo ? `npx --yes github:${repo}#${tag} upgrade` : null;
  const note = command
    ? `a newer toolkit release exists: ${tag} — this CLI is ${toVersion} and renders only its own content. To move to ${tag}, run:\n  ${command}`
    : `a newer toolkit release exists: ${tag} — this CLI is ${toVersion} and renders only its own content. Re-run \`upgrade\` from a toolkit pinned to ${tag} to move to it.`;
  return { note, result: { tag, command } };
}

/**
 * Diff the lock's recorded per-source provenance (`oldSources`, name → entry) against the
 * freshly-resolved sources from a re-render. Reports a git source whose resolved commit moved
 * (a ref that advanced), plus sources added since / removed since the last lock. A local-path
 * source (no commit) never reports a "moved". Sorted by name for deterministic output.
 */
export function diffSources(oldSources, newSources) {
  const moves = [];
  const newByName = new Map(newSources.map((s) => [s.name, s]));
  for (const s of newSources) {
    const prev = oldSources.get(s.name);
    if (!prev) {
      moves.push({ name: s.name, ref: s.ref ?? null, sourceType: s.sourceType, from: null, to: s.commit ?? null, status: 'added' });
    } else if (s.sourceType === 'git' && (prev.commit ?? null) !== (s.commit ?? null)) {
      moves.push({ name: s.name, ref: s.ref ?? null, sourceType: s.sourceType, from: prev.commit ?? null, to: s.commit ?? null, status: 'moved' });
    }
  }
  for (const [name, prev] of oldSources) {
    if (!newByName.has(name)) {
      moves.push({ name, ref: prev.ref ?? null, sourceType: prev.sourceType, from: prev.commit ?? null, to: null, status: 'removed' });
    }
  }
  return moves.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Diff the built-in toolkit's provenance across an upgrade — the lock's `toolkit` block (#374)
 * before the re-render, against the block the re-render just wrote. Exported like `diffSources`,
 * whose shape it deliberately mirrors, because #372 consumes it.
 *
 * `status`:
 *   - `moved`     — both sides recorded a commit, and they differ. THE report. When the two
 *                   VERSIONS also match, this is a re-cut tag (or an unreleased render), and it is
 *                   precisely what `toolkitVersion` alone cannot express.
 *   - `unchanged` — both recorded the same commit. Nothing to say.
 *   - `added`     — the previous lock recorded no provenance (pre-#374), this render does.
 *   - `removed`   — the previous lock recorded provenance, this render supplies none (a library
 *                   caller with no identity; the CLI always has one on a gated write).
 *   - `unknown`   — both sides have a block, but at least one recorded NO commit (an unreleased or
 *                   unverified toolkit). No move can be asserted — and asserting one anyway is the
 *                   exact false claim `toolkitLockEntry` refuses to write.
 *
 * Returns `null` when neither side recorded anything: there is no move, and no absence worth a line.
 *
 * @param {import('./toolkit-ref.mjs').ToolkitLockEntry|null} prev the lock's block before the render
 * @param {import('./toolkit-ref.mjs').ToolkitLockEntry|null} next the block the render wrote
 * @param {{fromVersion?: string|null, toVersion?: string|null}} [versions]
 */
export function diffToolkit(prev, next, { fromVersion = null, toVersion = null } = {}) {
  if (!prev && !next) return null;
  const move = {
    from: prev?.commit ?? null,
    to: next?.commit ?? null,
    fromRef: prev?.ref ?? null,
    toRef: next?.ref ?? null,
    // Which REPOSITORY each side came from (#384 F3). Without these, `describeToolkitMove` compared
    // commits alone and reported a repo swap as "the tag was re-cut" — the same unasked question
    // `describeToolkitProvenance` was answering wrong, at the second site.
    fromSource: prev?.source ?? null,
    toSource: next?.source ?? null,
    fromVersion,
    toVersion,
    fromStatus: prev?.status ?? null,
    toStatus: next?.status ?? null,
    status: 'unknown',
  };
  if (!prev) move.status = 'added';
  else if (!next) move.status = 'removed';
  else if (!prev.commit || !next.commit) move.status = 'unknown';
  else move.status = prev.commit === next.commit ? 'unchanged' : 'moved';
  return move;
}

/**
 * The one-line report for a toolkit move, or null when there is nothing to say. Module-private and
 * tested through the `log` sink, exactly like `describeSourceMove`.
 */
function describeToolkitMove(move) {
  const { status, from, to, fromRef, toRef, fromSource, toSource, fromVersion, toVersion, toStatus } = move;
  const at = (ref, sha) => [ref, sha ? shortSha(sha) : null].filter(Boolean).join(' @ ') || 'no commit recorded';
  const v = (x) => x ?? 'unknown';
  // Same unasked question as `describeToolkitProvenance`'s `recut`, at the second site (#384 F3) —
  // and the same THREE-STATE rule, because F3's fix collapsed `unknown` into `same` here too (#384
  // F12). `differentRepos` is false when a source is merely NULL, so a lock whose `source` was never
  // recorded (a bare clone; a lock written before #374) fell into the `re-cut or force-pushed` arm and
  // was told a tag had moved — the very assertion-about-an-unqueried-remote F3 exists to stop. Same /
  // different / unknown: the strong cause needs BOTH sources, and unknown gets the hedge.
  const comparableRepos = Boolean(fromSource && toSource);
  const differentRepos = comparableRepos && fromSource !== toSource;
  if (status === 'unchanged') return null;
  if (status === 'moved') {
    // The #372 trap, said out loud: same version, different commit. `upgrade` reports `current`
    // ("already on toolkit X") and would otherwise fall silent on a toolkit that genuinely moved.
    if (fromVersion && toVersion && fromVersion === toVersion) {
      if (differentRepos) {
        return `toolkit ${toVersion} is unchanged by version, but its provenance moved ${fromSource} @ ${shortSha(from)} → ${toSource} @ ${shortSha(to)} — these are DIFFERENT REPOSITORIES, so neither tag need have been re-cut`;
      }
      // The cause named here is now the only one REACHABLE (#384 F4). The old line also offered "or
      // one of the two renders used an unreleased toolkit", which `moved` structurally cannot be:
      // `moved` requires both commits non-null, and `toolkitLockEntry` writes `commit` IFF
      // `status === 'release'` — the anti-churn invariant. An unreleased render lands in `unknown`.
      //
      // …and it is only reachable when the sources are KNOWN EQUAL. Otherwise we have not established
      // that any tag moved at all, and say so (#384 F12).
      if (!comparableRepos) {
        return `toolkit ${toVersion} is unchanged by version, but its commit moved ${shortSha(from)} → ${shortSha(to)} — at least one source is unrecorded, so this may be a re-cut or force-pushed tag, or two different repositories`;
      }
      return `toolkit ${toVersion} is unchanged by version, but its commit moved ${shortSha(from)} → ${shortSha(to)} — the tag was re-cut or force-pushed`;
    }
    const repos = differentRepos ? ` (DIFFERENT REPOSITORIES: ${fromSource} → ${toSource})` : '';
    return `toolkit moved ${v(fromVersion)} (${at(fromRef, from)}) → ${v(toVersion)} (${at(toRef, to)})${repos}`;
  }
  if (status === 'added') {
    return `toolkit ${v(toVersion)} (${at(toRef, to)}) — the previous render recorded no toolkit provenance`;
  }
  if (status === 'removed') {
    return `toolkit provenance dropped: the lock recorded ${v(fromVersion)} (${at(fromRef, from)}), and this render supplied none`;
  }
  // `unknown`: at least one side has no commit, so no move can be honestly claimed — and this branch
  // used to claim one anyway (#384 F8), printing `toolkit moved 0.12.0 → 0.12.0` one line under a
  // comment saying it must not. The `moved` branch above already special-cases `fromVersion ===
  // toVersion` because `X → X` reads as nonsense; this one forgot the same guard.
  //
  // Not exotic: a first render lands `unverified` on any network blip, and per #383 a pnpm/yarn `dlx`
  // consumer is `unverified` ALWAYS. The moment they `upgrade` on a CLI that does resolve a release at
  // the same version, they were told their toolkit "moved 0.12.0 → 0.12.0". With no version move this
  // is the previous render's provenance being FILLED IN, not a move — so say that.
  if (to) {
    return fromVersion && toVersion && fromVersion === toVersion
      ? `toolkit ${v(toVersion)} is now pinned to ${at(toRef, to)}; the previous render recorded no commit, so no move can be reported`
      : `toolkit moved ${v(fromVersion)} → ${v(toVersion)} (${at(toRef, to)}); the previous render recorded no commit`;
  }
  return `toolkit ${v(toVersion)} (this toolkit is ${toStatus ?? 'unidentified'} — no commit recorded, so no move can be reported)`;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : 'unknown';
}

function describeSourceMove(move) {
  const at = move.ref ? ` (ref ${move.ref})` : '';
  if (move.status === 'moved') return `source ${move.name}${at} moved ${shortSha(move.from)} → ${shortSha(move.to)}`;
  if (move.status === 'added') {
    return `source ${move.name} added${move.sourceType === 'git' ? ` at ${shortSha(move.to)}${at}` : ' (local path)'}`;
  }
  return `source ${move.name} removed${move.sourceType === 'git' ? ` (was ${shortSha(move.from)})` : ''}`;
}

function readChangelog(toolkitRoot) {
  if (!toolkitRoot) return null;
  const file = path.join(toolkitRoot, CHANGELOG_FILE);
  return exists(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Extract the changelog sections for every released version in `(fromVersion, toVersion]`,
 * newest first, as raw markdown. Sections are `## [X.Y.Z] …` blocks (Keep a Changelog
 * style); an `## [Unreleased]` block (or any non-semver heading) is skipped, since the
 * target is always a concrete version. Returns null when nothing in range is found.
 */
export function changelogBetween(text, fromVersion, toVersion) {
  const sections = [];
  // Split on level-2 headings, keeping each heading with its body.
  const parts = String(text).split(/^(?=## )/m);
  for (const part of parts) {
    const head = /^##\s+\[?([^\]\s]+)\]?/.exec(part);
    if (!head) continue;
    const version = head[1];
    if (!parseVersion(version)) continue; // skips "Unreleased" and other non-semver headings
    if (compareVersions(version, fromVersion) > 0 && compareVersions(version, toVersion) <= 0) {
      sections.push({ version, body: part.trim() });
    }
  }
  if (!sections.length) return null;
  sections.sort((a, b) => compareVersions(b.version, a.version));
  return sections.map((s) => s.body).join('\n\n');
}
