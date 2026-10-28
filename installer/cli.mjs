#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderProject } from './lib/render.mjs';
import { doctor } from './lib/doctor.mjs';
import { defaultPluginsDir } from './lib/installed-mods.mjs';
import { eject, scaffoldConfig, installRefs, unejectCollisions } from './lib/eject.mjs';
import { validateToolkit, validateModPlugins, formatModPluginChecks } from './lib/validate.mjs';
import { setupGuide } from './lib/setup.mjs';
import { collectReport, formatReportMarkdown } from './lib/report.mjs';
import { collectState, formatStateText } from './lib/state.mjs';
import { collectConfig, queryConfig, formatConfig } from './lib/config.mjs';
import { upgrade } from './lib/upgrade.mjs';
import { uninstall, reinstall } from './lib/uninstall.mjs';
import { loadToolkit } from './lib/toolkit.mjs';
import { formatPrereq } from './lib/prerequisites.mjs';
import { computeListModel, formatListTable, interactiveSelect } from './lib/list.mjs';
import { computeToggleModel, formatToggleTable, interactiveToggle, applyToggle } from './lib/toggle.mjs';
import { resolveToolkitIdentity, formatUnreleasedRefusal, formatProvenanceWarning } from './lib/toolkit-ref.mjs';
import { resolveLatestRelease, updateVerdict } from './lib/update-check.mjs';
import { readBoard } from './lib/board.mjs';
import {
  loadProjectConfig,
  ensureGitignoreEntries,
  recommendedGitignoreEntries,
  CONFIG_FILE,
  BASELINE_GITIGNORE_ENTRIES,
} from './lib/project.mjs';

const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(toolkitRoot, 'package.json'), 'utf8'));

const [, , command, ...args] = process.argv;
const cwd = extractCwd(args) ?? process.cwd();

// Extracted globally because the flags must be gone from `args` before any "takes no refs" check
// runs. `--allow-unreleased` suppresses the refusal only; `--offline` is what skips the lookup (#373).
const allowUnreleased = extractFlag(args, '--allow-unreleased') || envAllowUnreleased();
const offline = extractFlag(args, '--offline') || envOffline();

// Resolved at most once, and only when a command needs it: `validate`/`help`/`eject` never do.
/** @type {import('./lib/toolkit-ref.mjs').ToolkitIdentity | null} */
let identityCache = null;
/** @type {import('./lib/toolkit-ref.mjs').ToolkitIdentity | null} */
let offlineIdentityCache = null;

// Must stay ABOVE the dispatch: `const` is not hoisted, so at the bottom it would be in the TDZ
// on every help and unknown-command path.
const USAGE =
  'usage: wafflestack <setup|init|list|toggle|install|render|bake|upgrade|doctor|state|config|report|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]';

// Checked BEFORE the switch: a destructive command must never be reached by someone asking a
// question, and the flag must not survive into a "takes no refs" guard.
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(helpText());
  process.exit(0);
}

try {
  switch (command) {
    case 'bake':
    case 'render': {
      const force = extractFlag(args, '--force');
      const gitignore = extractFlag(args, '--gitignore');
      if (args.length) {
        fail(`${command} takes no refs — use \`wafflestack install <ref…>\` to add a stack or item (it persists the choice, then re-renders); bare \`${command}\` re-renders the current selection`);
      }
      const toolkitIdentity = requireRelease(command);
      runRender(force, toolkitIdentity);
      if (gitignore) offerGitignore();
      break;
    }
    case 'install': {
      const force = extractFlag(args, '--force');
      const gitignore = extractFlag(args, '--gitignore');
      // Gate BEFORE installRefs persists anything: a refused install must leave waffle.yaml as it found it.
      const toolkitIdentity = requireRelease('install');
      const installed = args.length ? installRefs({ toolkitRoot, cwd, refs: args, log: console.log }) : null;
      runRender(force, toolkitIdentity, installed);
      if (gitignore) offerGitignore();
      break;
    }
    case 'doctor': {
      const allowMissing = extractFlag(args, '--allow-missing');
      const verifyRender = extractFlag(args, '--verify-render');
      // Plain doctor is NOT gated — it reads no toolkit content, and gating it would red the
      // unpinned waffle-doctor.yml for every consumer; `--verify-render` renders, so it is (#373).
      const toolkitIdentity = verifyRender ? requireRelease('doctor --verify-render') : offlineIdentity();
      const result = doctor({ cwd, toolkitVersion: pkg.version, toolkitIdentity, allowMissing, verifyRender, toolkitRoot, update: newerReleaseCheck(), pluginsDir: defaultPluginsDir() });
      const from = (f) => (result.attribution?.[f] ? ` — from ${result.attribution[f]}` : '');
      const tolerated = allowMissing && (!result.nothingPresent || result.render.evaluated);
      for (const f of result.modified) console.log(`modified: ${f}${from(f)}`);
      for (const f of result.missing) console.log((tolerated ? `missing (tolerated): ${f}` : `missing:  ${f}`) + from(f));
      for (const f of result.absentDocs) console.log(`absent (generated doc, optional): ${f}${from(f)}`);
      for (const f of result.render.stale) console.log(`stale render: ${f}${from(f)} — the config would render different content than the lock records`);
      for (const f of result.render.absent) console.log(`stale lock entry: ${f}${from(f)} — tracked by the lock but no longer rendered by the config`);
      for (const f of result.render.unexpected) console.log(`unrendered: ${f} — the config would render this file but the lock does not track it`);
      for (const e of result.render.errors) console.log(`verify-render: ${e}`);
      for (const n of result.notes) console.log(n);
      for (const p of result.prerequisites.unmetRequired) console.log(`prerequisite unmet (require): ${formatPrereq(p)}`);
      for (const p of result.prerequisites.unmetRecommended) console.log(`prerequisite unmet (recommend): ${formatPrereq(p)}`);
      for (const p of result.prerequisites.notRun ?? []) console.log(`prerequisite not run — external stack "${p.stackName}" awaiting acknowledgement: ${formatPrereq(p)}`);
      if (result.ok) {
        if (result.render.evaluated) {
          console.log(`render verified: a fresh render of ${CONFIG_FILE} reproduces the lock (${result.render.checked} files); the working tree was not touched`);
        }
        const absent = result.missing.length + result.absentDocs.length;
        console.log(
          absent
            ? `all present managed files match the lock manifest (${absent} absent, tolerated)`
            : 'all managed files match the lock manifest',
        );
        if (result.prerequisites.unmetRecommended.length) {
          console.log(`${result.prerequisites.unmetRecommended.length} recommended prerequisite(s) unmet — reported above, not blocking`);
        }
        if (result.prerequisites.notRun?.length) {
          console.log(`${result.prerequisites.notRun.length} external prerequisite check(s) not run — awaiting acknowledgement, listed above, not blocking`);
        }
      }
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'state': {
      const json = extractFlag(args, '--json');
      const board = extractFlag(args, '--board');
      if (args.length) fail(`state takes no refs (got ${args.join(', ')}) — it prints this repo's resolved behavioral keys, run files and lock status`);
      // Read-only (#561): the tree is read through the tree lock, drift is the subject rather than
      // the exit code, and nothing in the repo is written — only the user-cache newer-release check (#608).
      const toolkitIdentity = warnProvenance(offlineIdentity());
      const state = collectState({ cwd, toolkitRoot, toolkitVersion: pkg.version, toolkitIdentity, update: newerReleaseCheck() });
      // #697: opt-in network read; never throws, never moves the exit code.
      if (board) state.board = readBoard({ cwd, projectName: stringOrNull(state.config['project.name']?.value), offline });
      process.stdout.write(json ? `${JSON.stringify(state, null, 2)}\n` : formatStateText(state));
      break;
    }
    case 'config': {
      if (args.length > 1) fail(`config takes at most one key or prefix (got ${args.join(', ')}) — e.g. \`wafflestack config prResponse.rubric\``);
      // Read-only (#701), like `state`: warn on provenance, never refuse.
      warnProvenance(offlineIdentity());
      const model = collectConfig({ cwd, toolkitRoot, toolkitVersion: pkg.version });
      for (const err of model.errors) console.error(`selection problem: ${err}`);
      const result = queryConfig(model, args[0]);
      if (result.error !== undefined) fail(result.error);
      else process.stdout.write(formatConfig(result));
      break;
    }
    case 'report': {
      const json = extractFlag(args, '--json');
      if (args.length) fail(`report takes no refs (got ${args.join(', ')}) — it prints this repo's wafflestack diagnostics for an upstream bug report`);
      // Read-only and offline (#473): it never opens the local overlay or local lock, and a red
      // doctor is the report's subject, not its exit code.
      const toolkitIdentity = warnProvenance(offlineIdentity());
      const bundle = collectReport({ cwd, toolkitRoot, toolkitVersion: pkg.version, toolkitIdentity });
      process.stdout.write(json ? `${JSON.stringify(bundle, null, 2)}\n` : formatReportMarkdown(bundle));
      break;
    }
    case 'upgrade': {
      if (args.length) fail('upgrade takes no refs — it re-renders the current selection, moving it across toolkit versions');
      const toolkitIdentity = requireRelease('upgrade');
      const result = upgrade({ toolkitRoot, cwd, toolkitVersion: pkg.version, toolkitIdentity, pluginsDir: defaultPluginsDir(), log: console.log });
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
      if (!args[0]) fail('usage: wafflestack eject <skills/NAME | agents/NAME | files/PATH | mods/NAME>');
      const { ref, released, orphaned } = eject({ cwd, item: args[0], toolkitRoot, log: console.log });
      console.log(`ejected ${ref}; ${released.length} files released from management:`);
      for (const f of released) console.log(`  ${f}`);
      console.log('the files remain in place and are now project-owned');
      // `eject` never renders (#497) — it stays offline and ungated — so it says what a render would prune.
      if (orphaned.length) {
        console.log(`note: ${ref} was the only thing selecting ${orphaned.join(', ')} — still rendered and lock-tracked; run \`wafflestack render\` to prune`);
      }
      break;
    }
    // The toolkit's only destructive command: a DRY RUN until `--yes`, and every delete is gated
    // on the lock (tracked path AND matching sha256).
    case 'uninstall': {
      const yes = extractFlag(args, '--yes');
      const force = extractFlag(args, '--force');
      const allowMissing = extractFlag(args, '--allow-missing');
      // `--keep-config` keeps the LOCK too: the lock carries poured syrup `waffle.yaml` does not
      // name, so a config without it re-renders a different install than the one you uninstalled.
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
      // No `--yes` for a plain refresh: the render that follows writes every removed file straight
      // back. `--clean` deletes the config — authored input, nothing restores it.
      if (clean && !yes) {
        fail(`reinstall --clean deletes ${CONFIG_FILE} and your whole selection, and does not re-render — re-run with \`--yes\` to confirm (plain \`reinstall\` refreshes in place and keeps your config)`);
      }
      // Gated because it re-renders, and it must refuse BEFORE the deletes, never between them (#373).
      const toolkitIdentity = requireRelease('reinstall');
      const result = reinstall({ toolkitRoot, cwd, toolkitVersion: pkg.version, toolkitIdentity, clean, force, log: console.log });
      for (const w of result.render?.warnings ?? []) console.warn(`warning: ${w}`);
      for (const e of result.errors) console.error(`error: ${e}`);
      if (result.ok && !clean) console.log(`reinstalled — ${result.render.written.length} files re-rendered into ${cwd}`);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'init':
    case 'setup': {
      // One onboarding command (#611). stdout stays the pure playbook; notices go to stderr.
      const gitignore = extractFlag(args, '--gitignore');
      // Refuse before scaffolding: a dropped ref would otherwise exit 0 having written a starter.
      if (args.length) fail(`${command} takes no refs (got ${args.join(', ')}) — use \`wafflestack install <ref…>\` to add a stack or item`);
      warnProvenance(identity()); // writes only the static starter, so it warns rather than refusing (#373)
      const { file, created } = scaffoldConfig({ cwd });
      if (created) console.error(`wrote ${file} — the playbook below walks you (or your coding agent) through the rest`);
      // No stack is chosen yet, so only the stack-independent baseline is knowable.
      if (gitignore) reportGitignore(ensureGitignoreEntries(cwd, [...BASELINE_GITIGNORE_ENTRIES]), console.error);
      process.stdout.write(setupGuide(toolkitRoot, pkg.version, created ? undefined : cwd));
      break;
    }
    case 'list': {
      const interactive = extractFlag(args, '--interactive');
      const noColor = extractFlag(args, '--no-color');
      const checkPrereqs = extractFlag(args, '--check-prereqs');
      if (args.length) fail(`list takes no refs (got ${args.join(', ')}) — it reports the whole toolkit surface`);
      warnProvenance(identity()); // read-only report: warn, never refuse (see `setup`)
      const model = computeListModel({ toolkitRoot, cwd, toolkitVersion: pkg.version, checkPrereqs });

      // The DEFAULT must stay the plain table — CI, pipes and agents drive this CLI, so a missing
      // TTY degrades to the table rather than blocking on readline.
      if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
        const result = await interactiveSelect(model);
        if (result.applied && result.refs.length) {
          // The one branch of `list` that writes — hence the gate here, not on the command.
          const toolkitIdentity = requireRelease('list --interactive');
          const installed = installRefs({ toolkitRoot, cwd, refs: result.refs, log: console.log });
          runRender(false, toolkitIdentity, installed);
        } else {
          console.log(result.reason ?? 'no changes selected');
        }
        break;
      }
      if (interactive) console.error('note: --interactive needs a TTY on stdin/stdout; printing the plain table instead');
      const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !noColor;
      process.stdout.write(formatListTable(model, { color }));
      break;
    }
    case 'toggle': {
      const disable = extractValues(args, '--disable');
      const enable = extractValues(args, '--enable');
      const noColor = extractFlag(args, '--no-color');
      if (args.length) fail(`toggle takes no refs (got ${args.join(', ')}) — pass --disable <skill> / --enable <skill>, or run it in a TTY for the picker`);
      const both = disable.filter((n) => enable.includes(n));
      if (both.length) fail(`toggle: ${both.join(', ')} passed to both --disable and --enable — pick one`);
      const model = computeToggleModel({ toolkitRoot, cwd });

      const explicit = disable.length || enable.length;
      if (!explicit && process.stdin.isTTY && process.stdout.isTTY) {
        // Gated BEFORE the picker: a refusal must not arrive after the user has made their picks.
        refuseUnrenderable(model);
        const toolkitIdentity = requireRelease('toggle');
        const result = await interactiveToggle(model);
        if (!result.applied) {
          console.log(result.reason ?? 'cancelled — config untouched');
          break;
        }
        applyToggleAndRender(model, result.disable, result.enable, toolkitIdentity);
        break;
      }
      if (!explicit) {
        warnProvenance(identity()); // read-only table: warn, never refuse (see `list`)
        const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && !noColor;
        process.stdout.write(formatToggleTable(model, { color }));
        break;
      }
      applyToggleAndRender(model, disable, enable, requireRelease('toggle'));
      break;
    }
    case 'avatars': {
      // Owner-side Gravatar pipeline: `sync` uploads/assigns agent avatars, `status` only reports (#285).
      const sub = args[0] ?? 'sync';
      if (!['sync', 'status'].includes(sub)) fail(`usage: wafflestack avatars <sync|status> [--cwd DIR]`);
      const { runAvatarsSync, avatarsExitCode } = await import('./lib/avatars-sync.mjs');
      const result = await runAvatarsSync({ toolkitRoot, cwd, mode: sub, log: console.log });
      process.exit(avatarsExitCode({ mode: sub, pending: result.pending, failed: result.failed }));
      break;
    }
    case 'validate': {
      const problems = validateToolkit(toolkitRoot);
      // Claude Code's own lint over each mod source dir (#564) — "skipped" when the CLI is absent.
      const mods = validateModPlugins(toolkitRoot);
      for (const line of formatModPluginChecks(mods)) console.log(line);
      problems.push(...mods.problems);
      for (const p of problems) console.error(p);
      console.log(problems.length ? `${problems.length} problems` : 'toolkit is valid');
      process.exit(problems.length ? 1 : 0);
      break;
    }
    // Asking for help is not an error (#187) — STDOUT and exit 0; the unknown-command path below
    // is the STDERR/exit-1 one that scripts gate on.
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(helpText());
      process.exit(0);
      break;
    default:
      // Includes bare `wafflestack`: deliberately an error, not a help screen — a script invoking
      // the CLI with an empty argument still needs the non-zero exit.
      fail([banner(), USAGE, '', 'run `wafflestack help` for what each command does'].join('\n'));
  }
} catch (err) {
  fail(err.message);
}

// ─── toolkit provenance (#373) ────────────────────────────────────────────────────────────────

/** The full identity, network lookup included unless `--offline`. Cached. */
function identity() {
  if (!identityCache) identityCache = resolveToolkitIdentity({ toolkitRoot, offline });
  return identityCache;
}

/** Identity WITHOUT the network — for the banner and plain `doctor`, which must not depend on our reachability. */
function offlineIdentity() {
  if (!offlineIdentityCache) offlineIdentityCache = resolveToolkitIdentity({ toolkitRoot, offline: true });
  return offlineIdentityCache;
}

/** Best-effort "is there a newer release?" (#608) — cached, time-boxed, never throws; `--offline` only reads the cache. */
function newerReleaseCheck() {
  const id = offlineIdentity();
  return updateVerdict(id, pkg.version, resolveLatestRelease({ identity: id, offline }));
}

/** The gate: refuses a write command from a provably-unreleased toolkit; `unverified` fails OPEN. */
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

/** @param {unknown} v */
function stringOrNull(v) {
  return typeof v === 'string' && v ? v : null;
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
    // Only when it is NOT a release — a released toolkit's version number identifies it completely.
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
    '  setup       scaffold .waffle/waffle.yaml if missing, then print the install playbook for your coding agent',
    '  init        alias for setup — same command',
    '  list        show every stack and item in the toolkit, and what this repo has selected',
    '  toggle      pick which rendered skills an agent may invoke on its own (TTY picker), then render',
    '  install     add stacks/items to the selection (persists them), then render',
    '  render      re-render the current selection into .claude/ (agents, skills, mods), .codex/, .agents/ and files/ paths',
    '  bake        alias for render — same command, better metaphor',
    '  upgrade     move this repo across toolkit versions: run migrations, then re-render',
    '  doctor      check the rendered files still match the lock manifest (drift check)',
    '  state       print the resolved behavioral keys (value, layer, tokens), run files, locks and drift',
    '  config      look up the config keys this selection can set: value, source file, default, constraints',
    '  report      print redacted diagnostics (lock, config keys, doctor) for an upstream bug report',
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
    '  --gitignore       setup/init/render/install: append the recommended .gitignore entries',
    '  --yes             uninstall: actually delete (without it, uninstall only reports)',
    '                    reinstall: required by --clean, the one path that deletes your config',
    '  --keep-config     uninstall: keep .waffle/ — your selection, extensions and lock — and take',
    '                    only the rendered output, so `render` can lay the same install back down',
    '  --clean           reinstall: also delete the config and re-scaffold it empty (needs --yes)',
    '  --allow-missing   doctor/uninstall: tolerate managed files that are absent from disk',
    '  --verify-render   doctor: also check the config still renders what the lock records',
    '  --json            report: print the diagnostics bundle as JSON instead of Markdown',
    '                    state: print the state document as JSON (the shape AGENTS.md documents)',
    '  --board           state: also read milestones, open epics and In Progress / In Review board',
    '                    items via gh (5 s per call, 8 s total, cached 60 s); a failure sets board.error',
    '  --interactive     list: pick stacks in a TTY prompt (falls back to the plain table)',
    '  --check-prereqs   list: run the hinted prerequisite checks and show only the unmet ones',
    '  --disable SKILL   toggle: render SKILL slash-only (disable-model-invocation: true); repeatable',
    '  --enable SKILL    toggle: let an agent invoke SKILL again; repeatable. Either flag skips the picker',
    '  --allow-unreleased  render/install/upgrade/reinstall/doctor --verify-render: write files from',
    '                    a toolkit that is not a release (a working tree, or an unpinned `npx',
    '                    github:…` fetch of the default branch). Toolkit development only — a',
    '                    consumer should pin the ref instead. Env: WAFFLESTACK_ALLOW_UNRELEASED=1',
    '  --offline         skip the network release lookup (git ls-remote). For an air-gapped run that',
    '                    would otherwise stall on a doomed lookup; identity degrades to unverified.',
    '                    doctor/state: also skips the newer-release check (a cached answer is still read)',
    '                    state --board: skips the board read (board.error = "offline")',
    '                    Env: WAFFLESTACK_OFFLINE=1',
    '',
  ].join('\n');
}

// `toolkitIdentity` is what `requireRelease()` already resolved; every caller here is a gated
// command, so it is never null, and the lock records WHICH toolkit rendered (#374).
// `installed` is what `installRefs` just persisted. The render's own checks (`needs config values`,
// collisions, …) run AFTER that save, so ANY refusal rolls it back and a refused install leaves
// waffle.yaml as it found it (#548); an un-eject collision additionally names its `--force` remedy (#497).
function runRender(force = false, toolkitIdentity = null, installed = null) {
  const result = renderProject({ toolkitRoot, cwd, toolkitVersion: pkg.version, toolkitIdentity, force, log: console.log });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e}`);
    if (installed?.rollback()) {
      const blocked = unejectCollisions(installed.unejected, result.collisions);
      console.error(
        blocked.length
          ? `error: install refused — ${installed.unejected.map((u) => u.ref).join(', ')} stay${installed.unejected.length === 1 ? 's' : ''} ejected and ${CONFIG_FILE} was restored; nothing was written. The project-owned ${blocked.length === 1 ? 'copy differs' : 'copies differ'} from the render: re-run with \`--force\` to overwrite, or move your edits into ${CONFIG_FILE} config / .waffle/extensions/ first`
          : `error: install refused — ${CONFIG_FILE} was restored, so the selection is exactly as it was; nothing was written. Fix the errors above, then re-run the install`,
      );
    }
    process.exit(1);
  }
  console.log(`rendered ${result.written.length} files into ${cwd}`);
  if (result.removed.length) console.log(`removed stale: ${result.removed.join(', ')}`);
}

// Reached only after `runRender` succeeds — the explicit `--gitignore` flag is the consent.
function offerGitignore() {
  const toolkit = loadToolkit(toolkitRoot);
  const project = loadProjectConfig(cwd);
  reportGitignore(ensureGitignoreEntries(cwd, recommendedGitignoreEntries(toolkit, project)));
}

function reportGitignore(added, out = console.log) {
  out(
    added.length
      ? `.gitignore: added ${added.join(', ')}`
      : '.gitignore: already lists the recommended entries — left unchanged',
  );
}

// A selection that already fails must refuse BEFORE the config write: writing first would leave
// waffle.yaml modified with nothing rendered and the lock stale, and the wrapper skill promises
// every refusal means "nothing was written".
function refuseUnrenderable(model) {
  if (!model.errors.length) return;
  fail(`toggle: the current selection does not render — fix ${CONFIG_FILE} first; nothing was written\n${model.errors.map((e) => `  ${e}`).join('\n')}`);
}

// The one write `toggle` makes: persist to waffle.yaml, then re-render so the lock records it.
function applyToggleAndRender(model, disable, enable, toolkitIdentity) {
  refuseUnrenderable(model);
  const result = applyToggle({ cwd, model, disable, enable });
  if (result.unknown.length) {
    const rendered = model.rows.map((r) => r.name);
    fail(`toggle: ${result.unknown.join(', ')} is not a rendered skill — rendered: ${rendered.join(', ') || '(none)'}`);
  }
  if (!result.changed) {
    console.log('no change — every named skill is already in that state; config untouched');
    return;
  }
  const state = (list, verb) => (list.length ? `${verb}: ${list.join(', ')}` : null);
  console.log(`${CONFIG_FILE}: skills.modelInvocation → ${[state(result.disabled, 'disabled'), state(result.enabled, 'enabled')].filter(Boolean).join('; ') || 'removed (source defaults)'}`);
  runRender(false, toolkitIdentity);
}

// `--name VALUE` pairs, repeatable, comma-splittable; spliced out like `extractFlag`.
function extractValues(argv, name) {
  const values = [];
  for (let i = argv.indexOf(name); i !== -1; i = argv.indexOf(name)) {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`${name} requires a skill name`);
    argv.splice(i, 2);
    for (const v of value.split(',')) if (v.trim()) values.push(v.trim());
  }
  return values;
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
