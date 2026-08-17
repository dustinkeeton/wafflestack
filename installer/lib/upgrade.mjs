import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { exists, compareVersions, parseVersion } from './util.mjs';
import { readLock, renderProject } from './render.mjs';
import { doctor } from './doctor.mjs';
import { MIGRATIONS, runMigrations } from './migrations.mjs';
import { CONFIG_FILE, LOCK_FILE, resolveConfigFile, setScalarIn } from './project.mjs';
import { classifyToolkitRefValue, toolkitPinFromIdentity, parseRepoSlug } from './toolkit-ref.mjs';
import { loadRegistry, replacementFor } from './registry.mjs';
import { parseRef } from './refs.mjs';

const CHANGELOG_FILE = 'CHANGELOG.md';

/**
 * The config keys that decide which toolkit a consumer repo actually runs (#372). Both must sit
 * under `config:` — the resolver walks that nested object only, so a pin written elsewhere is inert.
 */
const TOOLKIT_REF_KEYS = [
  ['config', 'doctor', 'toolkitRef'],
  ['config', 'waffle', 'toolkitRef'],
];

/**
 * Move a consumer repo from the toolkit version its lock records to the version being invoked:
 * changelog delta → migrations → pin reconcile → render → doctor. The CLI presents the result.
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
  const toVersion = toolkitVersion;
  const oldSources = new Map((lock?.sources ?? []).map((s) => [s.name, s]));
  // Null for a lock written before the `toolkit` block existed (#374); every reader tolerates that.
  const oldToolkit = lock?.toolkit ?? null;

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

  // A pinned CLI reports a newer release and names the command to escape it; it never re-execs, and
  // never bumps the pins to `latestTag` — a pin records what rendered, and this CLI is what rendered.
  const newerRelease = describeNewerRelease(toolkitIdentity, toVersion);
  if (newerRelease) notes.push(newerRelease.note);

  for (const n of notes) log(n);
  if (changelogDelta) {
    log('\nchanges since the version this repo last rendered from:\n');
    log(changelogDelta);
    log('');
  }

  let migrationsRun = [];
  if (migrate) {
    migrationsRun = runMigrations({ cwd, fromVersion, toVersion, migrations, log }).map((m) => ({
      version: m.version,
      description: m.description,
    }));
    if (!migrationsRun.length) log(`no migrations registered between ${fromVersion} and ${toVersion}`);
  }

  // Both config writes must run after the migrations (one could move the key itself) and before the
  // render, which re-reads `.waffle/waffle.yaml` from disk (#372). Runs on every status, `current`
  // included.
  const pinMoves = reconcileToolkitRefPins({ cwd, identity: toolkitIdentity, log });
  const waffleMoves = forwardRenamedWaffleRefs({ toolkitRoot, cwd, log });

  // `refreshSources` re-fetches each git source, so a ref that advanced is observed rather than
  // served from the session cache.
  const render = renderProject({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity, sourceCacheDir, refreshSources: true, log });
  if (!render.ok) {
    // The config writes already happened, so `pinMoves` rides the failure return too.
    return { ok: false, status, fromVersion, toVersion, identity: toolkitIdentity, changelogDelta, migrationsRun, render, doctor: null, sourceMoves: [], toolkitMove: null, pinMoves, waffleMoves, newerRelease: newerRelease?.result ?? null, notes };
  }

  const sourceMoves = diffSources(oldSources, render.sources ?? []);
  for (const move of sourceMoves) log(describeSourceMove(move));

  const toolkitMove = diffToolkit(oldToolkit, render.toolkit ?? null, { fromVersion, toVersion });
  const moveNote = toolkitMove ? describeToolkitMove(toolkitMove) : null;
  if (moveNote) log(moveNote);

  const dr = doctor({ cwd, toolkitVersion, toolkitIdentity, toolkitRoot });

  return {
    ok: render.ok && dr.ok,
    status,
    fromVersion,
    toVersion,
    identity: toolkitIdentity,
    changelogDelta,
    migrationsRun,
    render,
    doctor: dr,
    sourceMoves,
    toolkitMove,
    pinMoves,
    waffleMoves,
    newerRelease: newerRelease?.result ?? null,
    notes,
  };
}

/**
 * Rewrite a `toolkitRef` key in the COMMITTED config iff the consumer already pinned it
 * release-shaped, to the pin the lock is about to record — never introducing one (#372). The write
 * is a byte-level splice (`setScalarIn`): `doc.toString()` would reflow the consumer's whole file,
 * and `doc.setIn` would create a key they never chose.
 *
 * @param {object} opts
 * @param {string} opts.cwd the consumer repo
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} opts.identity the toolkit performing the render
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof setScalarIn} [opts.writeScalar] the byte-level pin writer; a test seam
 * @returns {{key: string, from: string, to: string|null, action: 'bumped'|'unchanged'|'left'|'skipped'|'unwritable', reason: string}[]}
 */
export function reconcileToolkitRefPins({ cwd, identity = null, log = () => {}, writeScalar = setScalarIn }) {
  /** @type {{key: string, from: string, to: string|null, action: 'bumped'|'unchanged'|'left'|'skipped'|'unwritable', reason: string}[]} */
  const pinMoves = [];
  const { file: configFile } = resolveConfigFile(cwd);
  if (!exists(configFile)) return pinMoves; // `render` will fail on this next, with a better message

  const source = fs.readFileSync(configFile, 'utf8');
  const doc = YAML.parseDocument(source);
  if (doc.errors?.length) {
    log(`could not reconcile the pinned toolkitRef keys — ${CONFIG_FILE} did not parse cleanly; leaving it untouched`);
    return pinMoves;
  }

  const pin = toolkitPinFromIdentity(identity);
  const pinSlug = parseRepoSlug(pin);
  // The tag the lock is about to record — `github:owner/repo#v0.13.0` → `v0.13.0`.
  const pinFragment = pin ? pin.slice(pin.indexOf('#') + 1) : null;
  // `doc` is the read side and is never serialized; `text` is the write side, carried through the
  // loop so a second bumped key splices onto the first key's result.
  let text = source;

  for (const keyPath of TOOLKIT_REF_KEYS) {
    const key = keyPath.slice(1).join('.'); // "doctor.toolkitRef" — how a consumer names it
    const current = doc.getIn(keyPath);
    const found = classifyToolkitRefValue(current);
    // Not a pin we may move, and both keys land here on most repos — so this one stays silent.
    if (found.kind === 'absent' || found.kind === 'unpinned' || found.kind === 'not-github') continue;

    const from = String(current).trim();
    if (found.kind === 'other-pin') {
      const reason = `pinned to \`#${found.fragment}\`, which is not a release tag — \`upgrade\` moves release pins only`;
      pinMoves.push({ key, from, to: null, action: 'left', reason });
      log(`${key} is ${reason}; left as ${from}`);
      continue;
    }

    if (!pin) {
      const reason = unpinnableReason(identity);
      pinMoves.push({ key, from, to: null, action: 'skipped', reason });
      log(`${key} still pins ${from} and was NOT reconciled — ${reason}`);
      continue;
    }
    // A release pin written as a git URL is never rewritten (see `classifyToolkitRefValue`), but it
    // is always reported: a silent skip lets this key keep fetching the toolkit the other key left.
    if (found.form === 'url') {
      const sameRepo = found.slug && pinSlug && found.slug.owner === pinSlug.owner && found.slug.repo === pinSlug.repo;
      if (sameRepo && found.fragment === pinFragment) {
        // The pin we would have written, in another notation — nothing diverges, so nothing is said.
        pinMoves.push({ key, from, to: from, action: 'unchanged', reason: 'already pins the toolkit that rendered, written as a git URL' });
        continue;
      }
      const reason = 'written as a git URL, which `upgrade` does not rewrite — it moves the `github:owner/repo#tag` shorthand only';
      pinMoves.push({ key, from, to: null, action: 'left', reason });
      log(`${key} still pins ${from} and was NOT reconciled — ${reason}`);
      log(
        `  this lock now records ${pin}, so CI would fetch a DIFFERENT toolkit than the one that rendered it — ` +
          `edit ${key} by hand, or replace it with: ${pin}`,
      );
      continue;
    }
    if (from === pin) {
      pinMoves.push({ key, from, to: pin, action: 'unchanged', reason: 'already pins the toolkit that rendered' });
      continue;
    }
    const next = writeScalar(text, keyPath, pin);
    if (next === null) {
      // Defensive and unreachable from here; report that nothing was written, never a bump (#387).
      const reason = 'the pin could not be rewritten in place — left as authored';
      pinMoves.push({ key, from, to: null, action: 'unwritable', reason });
      log(`${key} still pins ${from} and was NOT reconciled — ${reason}`);
      continue;
    }
    text = next;
    pinMoves.push({ key, from, to: pin, action: 'bumped', reason: 'moved to the toolkit that rendered this lock' });
    log(`${key} ${from} → ${pin}`);
    if (found.slug && pinSlug && (found.slug.owner !== pinSlug.owner || found.slug.repo !== pinSlug.repo)) {
      log(
        `  note: that is a DIFFERENT REPOSITORY (${found.slug.owner}/${found.slug.repo} → ${pinSlug.owner}/${pinSlug.repo}) — ` +
          'the pin names the toolkit that rendered this lock, which is the one CI must fetch to reproduce it',
      );
    }
  }

  // The dirty guard is the bytes themselves: no splice, no write.
  if (text !== source) fs.writeFileSync(configFile, text);
  return pinMoves;
}

/**
 * Rewrite every `include:` entry in the committed config that names a renamed waffle to the ref
 * that supersedes it (#335), walking the registry's `replaced` chain transitively. The successor
 * ref is written UNQUALIFIED — it may live in another stack, and `resolveRef` re-qualifies on read.
 *
 * @param {object} opts
 * @param {string} opts.toolkitRoot the toolkit whose registry supplies the forward-fixes
 * @param {string} opts.cwd the consumer repo
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof setScalarIn} [opts.writeScalar] the byte-level ref writer; a test seam
 * @returns {{ from: string, to: string, action: 'forwarded'|'unwritable' }[]}
 */
export function forwardRenamedWaffleRefs({ toolkitRoot, cwd, log = () => {}, writeScalar = setScalarIn }) {
  /** @type {{ from: string, to: string, action: 'forwarded'|'unwritable' }[]} */
  const moves = [];
  if (!toolkitRoot) return moves;
  let registry;
  try {
    registry = loadRegistry(toolkitRoot);
  } catch (err) {
    log(`could not forward renamed waffle refs — the toolkit's waffle registry did not load: ${err.message}`);
    return moves;
  }
  if (!registry.present || !registry.replaced.size) return moves; // nothing has ever been renamed

  const { file: configFile } = resolveConfigFile(cwd);
  if (!exists(configFile)) return moves; // `render` will fail on this next, with a better message
  const source = fs.readFileSync(configFile, 'utf8');
  const doc = YAML.parseDocument(source);
  if (doc.errors?.length) {
    log(`could not forward renamed waffle refs — ${CONFIG_FILE} did not parse cleanly; leaving it untouched`);
    return moves;
  }
  const include = doc.getIn(['include']);
  if (!include || typeof include !== 'object' || !('items' in include)) return moves;

  let text = source;
  const entries = /** @type {any} */ (include).items ?? [];
  for (let i = 0; i < entries.length; i += 1) {
    const current = doc.getIn(['include', i]);
    if (typeof current !== 'string') continue;
    const from = current.trim();
    const parsed = parseRef(from);
    if (parsed.form === 'stack') continue; // a stack name; the registry governs waffles only
    const forward = replacementFor(registry, parsed.kind, parsed.name);
    if (!forward) continue;
    const next = writeScalar(text, ['include', i], forward.ref);
    if (next === null) {
      // Defensive and unreachable from here; report that nothing was written.
      moves.push({ from, to: forward.ref, action: 'unwritable' });
      log(`\`include:\` still names ${from}, renamed to ${forward.ref}, and could not be rewritten in place — edit ${CONFIG_FILE} by hand`);
      continue;
    }
    text = next;
    const chain = forward.via.length > 1 ? ` (via ${forward.via.slice(1).join(' → ')})` : '';
    moves.push({ from, to: forward.ref, action: 'forwarded' });
    log(`include: ${from} → ${forward.ref}${chain} (renamed in the toolkit)`);
  }

  if (text !== source) fs.writeFileSync(configFile, text);
  return moves;
}

/**
 * Why a release-shaped pin was left unreconciled — i.e. why `toolkitPinFromIdentity` returned null.
 *
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} identity
 * @returns {string}
 */
function unpinnableReason(identity) {
  if (!identity) return 'this run recorded no toolkit identity, so there is no ref to pin to';
  if (identity.status !== 'release') {
    return `the toolkit that rendered is ${identity.status}, so it has no release ref to pin to (a \`--allow-unreleased\` run, a \`dlx\` install, or a release lookup that could not answer)`;
  }
  return identity.origin === 'checkout'
    ? 'the toolkit that rendered is a release CHECKOUT — no remote was asked whether any repository holds that tag, so there is no pin it can honestly write into your config'
    : 'the toolkit that rendered is a release, but no repository could be established for it, so there is no pin to write';
}

/**
 * A release newer than the toolkit that is running: the note to print plus the structured
 * `{tag, command}` the CLI and skill consume, or null when this CLI is the latest it knows of.
 *
 * @param {import('./toolkit-ref.mjs').ToolkitIdentity|null} identity
 * @param {string|null|undefined} toVersion the version this CLI is rendering
 * @returns {{note: string, result: {tag: string, command: string|null}}|null}
 */
function describeNewerRelease(identity, toVersion) {
  const tag = identity?.latestTag ?? null;
  if (!tag || !toVersion || compareVersions(tag, toVersion) <= 0) return null;
  // A remedy that names a command which cannot resolve is worse than none: with no repo, name the tag.
  const repo = identity?.repo ?? identity?.lockRepo ?? null;
  const command = repo ? `npx --yes github:${repo}#${tag} upgrade` : null;
  const note = command
    ? `a newer toolkit release exists: ${tag} — this CLI is ${toVersion} and renders only its own content. To move to ${tag}, run:\n  ${command}`
    : `a newer toolkit release exists: ${tag} — this CLI is ${toVersion} and renders only its own content. Re-run \`upgrade\` from a toolkit pinned to ${tag} to move to it.`;
  return { note, result: { tag, command } };
}

/**
 * Diff the lock's per-source provenance (`oldSources`, name → entry) against the freshly-resolved
 * sources from a re-render: commits that moved, plus sources added and removed. Sorted by name.
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
 * Diff the built-in toolkit's provenance across an upgrade — the lock's `toolkit` block before the
 * re-render against the block it wrote — or null when neither side recorded anything (#374).
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
 * The one-line report for a toolkit move, or null when there is nothing to say.
 */
function describeToolkitMove(move) {
  const { status, from, to, fromRef, toRef, fromSource, toSource, fromVersion, toVersion, toStatus } = move;
  const at = (ref, sha) => [ref, sha ? shortSha(sha) : null].filter(Boolean).join(' @ ') || 'no commit recorded';
  const v = (x) => x ?? 'unknown';
  // Three states, not two: naming a cause needs BOTH sources, and a null source gets the hedge —
  // never assert that a tag moved on the strength of a remote nobody queried (#384).
  const comparableRepos = Boolean(fromSource && toSource);
  const differentRepos = comparableRepos && fromSource !== toSource;
  if (status === 'unchanged') return null;
  if (status === 'moved') {
    if (fromVersion && toVersion && fromVersion === toVersion) {
      if (differentRepos) {
        return `toolkit ${toVersion} is unchanged by version, but its provenance moved ${fromSource} @ ${shortSha(from)} → ${toSource} @ ${shortSha(to)} — these are DIFFERENT REPOSITORIES, so neither tag need have been re-cut`;
      }
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
  // `unknown`: at least one side has no commit, so no move may be claimed — with the versions equal
  // this is the previous render's provenance being filled in.
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
 * The `## [X.Y.Z] …` changelog sections for every released version in `(fromVersion, toVersion]`,
 * newest first, as raw markdown; null when nothing in range is found.
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
