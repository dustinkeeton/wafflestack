#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderProject } from './lib/render.mjs';
import { doctor } from './lib/doctor.mjs';
import { eject, init, installRefs } from './lib/eject.mjs';
import { validateToolkit } from './lib/validate.mjs';
import { setupGuide } from './lib/setup.mjs';
import { upgrade } from './lib/upgrade.mjs';
import { uninstall, reinstall } from './lib/uninstall.mjs';
import { loadToolkit } from './lib/toolkit.mjs';
import { formatPrereq } from './lib/prerequisites.mjs';
import { computeListModel, formatListTable, interactiveSelect } from './lib/list.mjs';
import { resolveToolkitIdentity, formatUnreleasedRefusal, formatProvenanceWarning } from './lib/toolkit-ref.mjs';
import {
  loadProjectConfig,
  ensureGitignoreEntries,
  recommendedGitignoreEntries,
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  LOCAL_LOCK_FILE,
} from './lib/project.mjs';

const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(toolkitRoot, 'package.json'), 'utf8'));

const [, , command, ...args] = process.argv;
const cwd = extractCwd(args) ?? process.cwd();

// #373 — the write path refuses to run from a toolkit that is provably not a release. Extracted
// here, globally, for two reasons: every command must accept the flag (the guard lives inside the
// gated cases, but the FLAG has to be gone from `args` before any "takes no refs" check runs, or it
// would be rejected as a stray ref), and toolkit development needs one switch, not eleven.
//
// It suppresses the REFUSAL, not the TRUTH: identity is still resolved (network lookup included) and
// still reported, so a genuine release under the hatch keeps its `ref` (#383). This is why the two
// flags are separate: `--allow-unreleased` answers "don't refuse me"; `--offline` answers "don't pay
// for the answer" and is the only one that skips the lookup — for an air-gapped run that must not
// stall on a doomed `ls-remote`.
const allowUnreleased = extractFlag(args, '--allow-unreleased') || envAllowUnreleased();
const offline = extractFlag(args, '--offline') || envOffline();

// Resolved at most once, and only when a command actually needs it — `validate`, `help`, `init` and
// `eject` must never so much as look at the network.
/** @type {import('./lib/toolkit-ref.mjs').ToolkitIdentity | null} */
let identityCache = null;
/** @type {import('./lib/toolkit-ref.mjs').ToolkitIdentity | null} */
let offlineIdentityCache = null;

// Declared ABOVE the dispatch, not beside helpText() with the other helpers: `const` is not
// hoisted, and the switch below reads it. Left at the bottom it would be in the temporal dead zone
// on every help and unknown-command path — a ReferenceError the catch would quietly turn into a
// baffling exit 1. (`banner()`/`helpText()` are function declarations, so they hoist and may stay.)
const USAGE =
  'usage: wafflestack <init|setup|list|install|render|bake|upgrade|doctor|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]';

// `--help`/`-h` AFTER a command (`wafflestack uninstall --help`) prints the help instead of running
// the command — the same full help text as bare `help`, not a per-command page. Checked before the
// switch so a destructive command can never be reached by someone who was asking a question — and
// before the flag reaches any "takes no refs" guard, which would otherwise reject it as a stray
// ref. Bare `--help`/`-h` (no command) lands in the switch.
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(helpText());
  process.exit(0);
}

try {
  switch (command) {
    // `bake` is a pure alias for `render` — the baking metaphor, all the way down (#176).
    case 'bake':
    case 'render': {
      const force = extractFlag(args, '--force');
      const gitignore = extractFlag(args, '--gitignore');
      if (args.length) {
        fail(`${command} takes no refs — use \`wafflestack install <ref…>\` to add a stack or item (it persists the choice, then re-renders); bare \`${command}\` re-renders the current selection`);
      }
      // #373: render writes files FROM toolkit content — the gated path itself.
      const toolkitIdentity = requireRelease(command);
      runRender(force, toolkitIdentity);
      if (gitignore) offerGitignore();
      break;
    }
    case 'install': {
      const force = extractFlag(args, '--force');
      const gitignore = extractFlag(args, '--gitignore');
      // Gate BEFORE installRefs persists anything: a refused install must leave waffle.yaml as it
      // found it, or the consumer is left holding a selection they were never able to render.
      const toolkitIdentity = requireRelease('install');
      // Bare `install` is an alias for `render`; with refs it persists them first.
      if (args.length) installRefs({ toolkitRoot, cwd, refs: args, log: console.log });
      runRender(force, toolkitIdentity);
      if (gitignore) offerGitignore();
      break;
    }
    case 'doctor': {
      const allowMissing = extractFlag(args, '--allow-missing');
      // #314: verify the lock still matches what the committed config WOULD render (a temp-dir
      // render; the working tree is never touched). Opt-in — plain doctor is unchanged.
      const verifyRender = extractFlag(args, '--verify-render');
      // #373, and this line is the whole scoping decision: PLAIN doctor is not gated (it only hashes
      // files against the lock — it reads no toolkit content, so it is correct from any toolkit, and
      // gating it would red the unpinned-by-default waffle-doctor.yml for every consumer). It gets
      // the OFFLINE identity, purely so the version-skew remedy below can name a command that works.
      // `--verify-render` RENDERS, so it is gated like any other write — it is the #314 gate that
      // #373 breaks, and rendering it from the default branch is exactly how it goes opaquely red.
      const toolkitIdentity = verifyRender ? requireRelease('doctor --verify-render') : offlineIdentity();
      const result = doctor({ cwd, toolkitVersion: pkg.version, toolkitIdentity, allowMissing, verifyRender, toolkitRoot });
      const from = (f) => (result.attribution?.[f] ? ` — from ${result.attribution[f]}` : '');
      // Absent files are only "tolerated" when *some* render survived, or when --verify-render
      // reproduced the render instead (#314); when every managed file is absent and nothing was
      // verified in their place, the flag no longer excuses them (#311).
      const tolerated = allowMissing && (!result.nothingPresent || result.render.evaluated);
      for (const f of result.modified) console.log(`modified: ${f}${from(f)}`);
      for (const f of result.missing) console.log((tolerated ? `missing (tolerated): ${f}` : `missing:  ${f}`) + from(f));
      // Render drift (#314): the lock disagrees with a fresh render of the committed config.
      for (const f of result.render.stale) console.log(`stale render: ${f}${from(f)} — the config would render different content than the lock records`);
      for (const f of result.render.absent) console.log(`stale lock entry: ${f}${from(f)} — tracked by the lock but no longer rendered by the config`);
      for (const f of result.render.unexpected) console.log(`unrendered: ${f} — the config would render this file but the lock does not track it`);
      for (const e of result.render.errors) console.log(`verify-render: ${e}`);
      for (const n of result.notes) console.log(n);
      // Prerequisite gate (#129): an unmet `require` fails the check; a `recommend` only reports.
      for (const p of result.prerequisites.unmetRequired) console.log(`prerequisite unmet (require): ${formatPrereq(p)}`);
      for (const p of result.prerequisites.unmetRecommended) console.log(`prerequisite unmet (recommend): ${formatPrereq(p)}`);
      if (result.ok) {
        if (result.render.evaluated) {
          console.log(`render verified: a fresh render of ${CONFIG_FILE} reproduces the lock (${result.render.checked} files); the working tree was not touched`);
        }
        console.log(
          result.missing.length
            ? `all present managed files match the lock manifest (${result.missing.length} absent, tolerated)`
            : 'all managed files match the lock manifest',
        );
        if (result.prerequisites.unmetRecommended.length) {
          console.log(`${result.prerequisites.unmetRecommended.length} recommended prerequisite(s) unmet — reported above, not blocking`);
        }
      }
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'upgrade': {
      if (args.length) fail('upgrade takes no refs — it re-renders the current selection, moving it across toolkit versions');
      // #373: the command the issue is named for. `upgrade` announces "0.8.0 → 0.12.0" and then
      // writes whatever the fetched toolkit happens to hold — which, unpinned, is the default
      // branch. Gating it is what makes `toVersion` (upgrade.mjs) mean something again.
      const toolkitIdentity = requireRelease('upgrade');
      // upgrade() logs its narrative (version move, changelog, migrations, render) via `log`.
      const result = upgrade({ toolkitRoot, cwd, toolkitVersion: pkg.version, toolkitIdentity, log: console.log });
      for (const w of result.render.warnings) console.warn(`warning: ${w}`);
      if (!result.render.ok) {
        for (const e of result.render.errors) console.error(`error: ${e}`);
        process.exit(1);
      }
      for (const dnote of result.doctor?.notes ?? []) console.log(dnote);
      console.log(
        result.ok
          ? `upgrade complete — now on toolkit ${result.toVersion}`
          : 'upgrade rendered but doctor reports drift — see above',
      );
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'eject': {
      if (!args[0]) fail('usage: wafflestack eject <skills/NAME | agents/NAME | files/PATH>');
      const { ref, released } = eject({ cwd, item: args[0], log: console.log });
      console.log(`ejected ${ref}; ${released.length} files released from management:`);
      for (const f of released) console.log(`  ${f}`);
      console.log('the files remain in place and are now project-owned');
      break;
    }
    // The toolkit's only destructive command (#182). Every delete is gated on the lock: a path is
    // removed only if `.waffle/waffle.lock.json` tracks it AND its sha256 still matches what we
    // rendered. It is a DRY RUN until `--yes` — the CLI is deliberately non-interactive (see the
    // `--interactive` note under `list`), so the flag IS the consent, and a preview by default is
    // the safer default for the agents and CI jobs that drive this toolkit.
    case 'uninstall': {
      const yes = extractFlag(args, '--yes');
      const force = extractFlag(args, '--force');
      const allowMissing = extractFlag(args, '--allow-missing');
      // `.waffle/extensions/` holds files the CONSUMER wrote (render reads them as render sources),
      // and a full uninstall deletes them with the rest of `.waffle/`. `keepConfig` is the library's
      // answer to "take the rendered output, keep my authored inputs" — it has always been there; the
      // CLI simply never let anyone ask for it, so the only way to keep an authored extension was to
      // hope it was committed. It keeps the LOCK too (planUninstall) — the lock carries the poured
      // syrup that `waffle.yaml` alone does not name, so a config without it re-renders a different
      // install than the one you uninstalled.
      const keepConfig = extractFlag(args, '--keep-config');
      if (args.length) {
        fail(`uninstall takes no refs (got ${args.join(', ')}) — it removes the whole install; use \`wafflestack eject <ref>\` to release a single item to project ownership`);
      }
      const result = uninstall({ cwd, toolkitRoot, force, allowMissing, keepConfig, dryRun: !yes, log: console.log });
      for (const e of result.errors) console.error(`error: ${e}`);
      if (result.ok && result.dryRun) console.log('\nnothing was removed — re-run with `--yes` to apply');
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'reinstall': {
      const clean = extractFlag(args, '--clean');
      const yes = extractFlag(args, '--yes');
      const force = extractFlag(args, '--force');
      if (args.length) {
        fail(`reinstall takes no refs (got ${args.join(', ')}) — it removes the rendered files and re-renders the current selection`);
      }
      // No `--yes` for a plain refresh: every file it removes is written straight back by the
      // render that follows. `--clean` deletes the config — authored input, nothing restores it.
      if (clean && !yes) {
        fail(`reinstall --clean deletes ${CONFIG_FILE} and your whole selection, and does not re-render — re-run with \`--yes\` to confirm (plain \`reinstall\` refreshes in place and keeps your config)`);
      }
      // Gated: it re-renders (#373). Refuse before the deletes, never between them — a reinstall
      // that removed the tree and then refused to lay it back down is the one outcome worse than
      // rendering unreleased content.
      const toolkitIdentity = requireRelease('reinstall');
      const result = reinstall({ toolkitRoot, cwd, toolkitVersion: pkg.version, toolkitIdentity, clean, force, log: console.log });
      for (const w of result.render?.warnings ?? []) console.warn(`warning: ${w}`);
      for (const e of result.errors) console.error(`error: ${e}`);
      if (result.ok && !clean) console.log(`reinstalled — ${result.render.written.length} files re-rendered into ${cwd}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'init': {
      const gitignore = extractFlag(args, '--gitignore');
      const file = init({ cwd });
      console.log(`wrote ${file} — pick stacks and config values, then run \`wafflestack render\``);
      console.log('(or run `wafflestack setup` and hand the printed playbook to your coding agent)');
      // Only the local overlay (`.waffle/waffle.local.yaml`) and its derivative the local lock
      // (`.waffle/waffle.local.lock.json` — this machine's render, written only when the overlay
      // feeds it; #317) are knowable at init, no stacks having been chosen yet; `install
      // --gitignore` later adds the worktrees dir once a stack that declares it is enabled.
      if (gitignore) reportGitignore(ensureGitignoreEntries(cwd, [LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE]));
      break;
    }
    case 'setup': {
      // Reporting only — it writes nothing, so it WARNS rather than refusing (#373). `setup` is the
      // README's onboarding entry point; refusing the very first command a new consumer runs, to
      // protect a render it is not doing, would be gratuitous. The warning names the tag to pin.
      warnProvenance(identity());
      process.stdout.write(setupGuide(toolkitRoot, pkg.version, cwd));
      break;
    }
    case 'list': {
      const interactive = extractFlag(args, '--interactive');
      const noColor = extractFlag(args, '--no-color');
      if (args.length) fail(`list takes no refs (got ${args.join(', ')}) — it reports the whole toolkit surface`);
      warnProvenance(identity()); // read-only report: warn, never refuse (see `setup`)
      const model = computeListModel({ toolkitRoot, cwd, toolkitVersion: pkg.version });

      // Interactive is opt-in (`--interactive`) AND needs a real TTY on both ends. The DEFAULT is
      // always the plain table — safe for CI, pipes and agents, consistent with the toolkit's
      // deliberately non-interactive CLI. `--interactive` without a TTY degrades to the table
      // (never blocks on readline).
      if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
        const result = await interactiveSelect(model);
        if (result.applied && result.refs.length) {
          // The one branch of `list` that writes: applying a selection installs refs and renders.
          // The gate belongs here, not on the command — browsing the table is not a write.
          const toolkitIdentity = requireRelease('list --interactive');
          installRefs({ toolkitRoot, cwd, refs: result.refs, log: console.log });
          runRender(false, toolkitIdentity);
        } else {
          console.log(result.reason ?? 'no changes selected');
        }
        break;
      }
      if (interactive) console.error('note: --interactive needs a TTY on stdin/stdout; printing the plain table instead');
      // Color only when writing to a real terminal and neither NO_COLOR nor --no-color opts out.
      const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !noColor;
      process.stdout.write(formatListTable(model, { color }));
      break;
    }
    case 'avatars': {
      // Owner-side Gravatar pipeline (#285): `avatars sync` uploads/assigns each agent avatar for
      // its already-verified commit email; `avatars status` reports drift without writing anything.
      const sub = args[0] ?? 'sync';
      if (!['sync', 'status'].includes(sub)) fail(`usage: wafflestack avatars <sync|status> [--cwd DIR]`);
      const { runAvatarsSync, avatarsExitCode } = await import('./lib/avatars-sync.mjs');
      const result = await runAvatarsSync({ toolkitRoot, cwd, mode: sub, log: console.log });
      // `status` is a check: a drifted (unregistered) address exits non-zero so CI/scripts can gate;
      // any per-agent failure remainder also exits non-zero so a partial `sync` never looks clean.
      process.exit(avatarsExitCode({ mode: sub, pending: result.pending, failed: result.failed }));
      break;
    }
    case 'validate': {
      const problems = validateToolkit(toolkitRoot);
      for (const p of problems) console.error(p);
      console.log(problems.length ? `${problems.length} problems` : 'toolkit is valid');
      process.exit(problems.length ? 1 : 0);
      break;
    }
    // Asking for help is not an error (#187). Prints to STDOUT and exits 0 — so `wafflestack help
    // | less` works and a script can tell "I asked" from "I fumbled". The unknown-command path
    // below still prints usage to STDERR and exits 1, which is what scripts gate on.
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText());
      process.exit(0);
      break;
    default:
      // Includes bare `wafflestack` (no command at all): deliberately an error, not a help screen.
      // A script that invokes the CLI with an empty argument still gets a non-zero exit, which is
      // the failure it needs to see. `wafflestack help` is one word away for a human.
      fail([banner(), USAGE, '', 'run `wafflestack help` for what each command does'].join('\n'));
  }
} catch (err) {
  fail(err.message);
}

// ─── toolkit provenance (#373) ────────────────────────────────────────────────────────────────
// A version number does not identify content: `npx github:dustinkeeton/wafflestack` with no `#ref`
// fetches the DEFAULT BRANCH, whose package.json still says the last released version. So the CLI
// asks what it actually is, and the commands that WRITE FILES FROM TOOLKIT CONTENT refuse when it
// is provably not a release. Scoping is the whole design: gate the write path only. Plain `doctor`
// never reads toolkit content — it hashes files against the lock — so gating it would turn the
// shipped waffle-doctor.yml red for every consumer on the unpinned default, which is an outage, not
// a fix. `list`/`setup` report, so they warn. `init`/`eject`/`uninstall`/`validate`/`help` never
// touch toolkit content at all.

/** The full identity, network lookup included unless `--offline`. Cached. */
function identity() {
  if (!identityCache) identityCache = resolveToolkitIdentity({ toolkitRoot, offline });
  return identityCache;
}

/**
 * Identity WITHOUT the network, for callers that want the truth but must not pay for it: the banner
 * (printed on `help`) and plain `doctor` (the CI drift gate every consumer runs on every PR — it
 * must stay fast, and it must not start depending on our reachability). A checkout still resolves
 * exactly; an npx install degrades to `unverified` unless its shipped CHANGELOG gives it away.
 */
function offlineIdentity() {
  if (!offlineIdentityCache) offlineIdentityCache = resolveToolkitIdentity({ toolkitRoot, offline: true });
  return offlineIdentityCache;
}

/**
 * The gate. Refuses a write command when the running toolkit is provably NOT a release, naming the
 * pinned command to run instead. `unverified` (offline, no git, unreadable npm lockfile) fails
 * OPEN — a warning, then proceed — because failing closed on ignorance would make every consumer's
 * CI depend on our reachability. Fail-closed applies only to a lookup that SUCCEEDED and said "not
 * a release".
 */
function requireRelease(cmd) {
  const id = identity();
  if (id.status === 'unreleased' && !allowUnreleased) fail(formatUnreleasedRefusal(id, cmd));
  warnProvenance(id);
  return id;
}

/** Say what we are whenever we are not a release — under the escape hatch too. Never refuses. */
function warnProvenance(id) {
  const warning = formatProvenanceWarning(id);
  if (warning) console.warn(`warning: ${warning}`);
  return id;
}

/** `WAFFLESTACK_ALLOW_UNRELEASED=1` — the env twin of `--allow-unreleased`, for CI and containers. */
function envAllowUnreleased() {
  return envTruthy('WAFFLESTACK_ALLOW_UNRELEASED');
}

/** `WAFFLESTACK_OFFLINE=1` — the env twin of `--offline`, for air-gapped CI. */
function envOffline() {
  return envTruthy('WAFFLESTACK_OFFLINE');
}

/** @param {string} name */
function envTruthy(name) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function banner() {
  const id = offlineIdentity();
  return [
    '┏━┳━┳━┓',
    `┣━╋━╋━┫  wafflestack v${pkg.version}`,
    '┣━╋━╋━┫  one batter, every repo',
    '┗━┻━┻━┛',
    // Only when it is NOT a release — a released toolkit's version number identifies it completely,
    // and the box has said so for eleven versions. Anything else needs the commit to be identified.
    ...(id.status === 'release' ? [] : [`  ${id.status}${id.commit ? ` — ${id.commit.slice(0, 7)}` : ''}${id.status === 'unreleased' ? ' (not a release; `--allow-unreleased` to write anyway)' : ''}`]),
    '',
  ].join('\n');
}

// One line per subcommand, in lifecycle order — the order you meet them, not alphabetical.
function helpText() {
  return [
    banner(),
    USAGE,
    '',
    'commands:',
    '  init        scaffold .waffle/waffle.yaml so you can pick stacks and config values',
    '  setup       print the install playbook to hand to your coding agent',
    '  list        show every stack and item in the toolkit, and what this repo has selected',
    '  install     add stacks/items to the selection (persists them), then render',
    '  render      re-render the current selection into .claude/, .codex/, .agents/ and files/ paths',
    '  bake        alias for render — same command, better metaphor',
    '  upgrade     move this repo across toolkit versions: run migrations, then re-render',
    '  doctor      check the rendered files still match the lock manifest (drift check)',
    '  eject       release one item to project ownership; the files stay, the lock forgets them',
    '  uninstall   remove every wafflestack-managed file this repo has (dry run without --yes)',
    '  reinstall   remove the rendered files and re-render the same selection (--clean wipes config)',
    '  avatars     owner-side Gravatar pipeline for agent commit identities (sync|status)',
    '  validate    check the toolkit source itself — manifests, placeholders, refs',
    '  help        print this help and exit 0',
    '',
    'flags:',
    '  --cwd DIR         run against DIR instead of the current directory (every command)',
    '  --help, -h        print this help and exit 0; after a command, explain instead of running it',
    '  --force           render/install/reinstall: overwrite pre-existing unmanaged files',
    '                    uninstall: also delete files that were hand-edited after rendering',
    '  --gitignore       init/render/install: append the recommended .gitignore entries',
    '  --yes             uninstall: actually delete (without it, uninstall only reports)',
    '                    reinstall: required by --clean, the one path that deletes your config',
    '  --keep-config     uninstall: keep .waffle/ — your selection, extensions and lock — and take',
    '                    only the rendered output, so `render` can lay the same install back down',
    '  --clean           reinstall: also delete the config and re-scaffold it empty (needs --yes)',
    '  --allow-missing   doctor/uninstall: tolerate managed files that are absent from disk',
    '  --verify-render   doctor: also check the config still renders what the lock records',
    '  --interactive     list: pick stacks in a TTY prompt (falls back to the plain table)',
    '  --allow-unreleased  render/install/upgrade/reinstall/doctor --verify-render: write files from',
    '                    a toolkit that is not a release (a working tree, or an unpinned `npx',
    '                    github:…` fetch of the default branch). Toolkit development only — a',
    '                    consumer should pin the ref instead. Env: WAFFLESTACK_ALLOW_UNRELEASED=1',
    '  --offline         skip the network release lookup (git ls-remote). For an air-gapped run that',
    '                    would otherwise stall on a doomed lookup; identity degrades to unverified.',
    '                    Env: WAFFLESTACK_OFFLINE=1',
    '',
  ].join('\n');
}

// `toolkitIdentity` is the object `requireRelease()` already resolved — passed down so the render
// (and the lock it writes) knows WHICH toolkit produced it, not merely which version number it
// claimed (#373; #374 writes it into the lock). Every caller here is a gated command, so it is
// always the real thing, never null.
function runRender(force = false, toolkitIdentity = null) {
  const result = renderProject({ toolkitRoot, cwd, toolkitVersion: pkg.version, toolkitIdentity, force, log: console.log });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  console.log(`rendered ${result.written.length} files into ${cwd}`);
  if (result.removed.length) console.log(`removed stale: ${result.removed.join(', ')}`);
}

// `--gitignore` on a successful render/install: append the recommended entries the consumer
// asked for (the explicit flag is their consent). Reached only after runRender succeeds — a
// failed render exits first, so this never runs against an unrendered tree.
function offerGitignore() {
  const toolkit = loadToolkit(toolkitRoot);
  const project = loadProjectConfig(cwd);
  reportGitignore(ensureGitignoreEntries(cwd, recommendedGitignoreEntries(toolkit, project)));
}

function reportGitignore(added) {
  console.log(
    added.length
      ? `.gitignore: added ${added.join(', ')}`
      : '.gitignore: already lists the recommended entries — left unchanged',
  );
}

function extractCwd(argv) {
  const i = argv.indexOf('--cwd');
  if (i === -1) return undefined;
  const dir = argv[i + 1];
  if (!dir) fail('--cwd requires a directory');
  argv.splice(i, 2);
  return path.resolve(dir);
}

function extractFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
