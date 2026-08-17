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

// Extracted globally because the flags must be gone from `args` before any "takes no refs" check
// runs. `--allow-unreleased` suppresses the refusal only; `--offline` is what skips the lookup (#373).
const allowUnreleased = extractFlag(args, '--allow-unreleased') || envAllowUnreleased();
const offline = extractFlag(args, '--offline') || envOffline();

// Resolved at most once, and only when a command needs it: `validate`/`help`/`init`/`eject` never do.
/** @type {import('./lib/toolkit-ref.mjs').ToolkitIdentity | null} */
let identityCache = null;
/** @type {import('./lib/toolkit-ref.mjs').ToolkitIdentity | null} */
let offlineIdentityCache = null;

// Must stay ABOVE the dispatch: `const` is not hoisted, so at the bottom it would be in the TDZ
// on every help and unknown-command path.
const USAGE =
  'usage: wafflestack <init|setup|list|install|render|bake|upgrade|doctor|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]';

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
      if (args.length) installRefs({ toolkitRoot, cwd, refs: args, log: console.log });
      runRender(force, toolkitIdentity);
      if (gitignore) offerGitignore();
      break;
    }
    case 'doctor': {
      const allowMissing = extractFlag(args, '--allow-missing');
      const verifyRender = extractFlag(args, '--verify-render');
      // Plain doctor is NOT gated — it reads no toolkit content, and gating it would red the
      // unpinned waffle-doctor.yml for every consumer; `--verify-render` renders, so it is (#373).
      const toolkitIdentity = verifyRender ? requireRelease('doctor --verify-render') : offlineIdentity();
      const result = doctor({ cwd, toolkitVersion: pkg.version, toolkitIdentity, allowMissing, verifyRender, toolkitRoot });
      const from = (f) => (result.attribution?.[f] ? ` — from ${result.attribution[f]}` : '');
      const tolerated = allowMissing && (!result.nothingPresent || result.render.evaluated);
      for (const f of result.modified) console.log(`modified: ${f}${from(f)}`);
      for (const f of result.missing) console.log((tolerated ? `missing (tolerated): ${f}` : `missing:  ${f}`) + from(f));
      for (const f of result.render.stale) console.log(`stale render: ${f}${from(f)} — the config would render different content than the lock records`);
      for (const f of result.render.absent) console.log(`stale lock entry: ${f}${from(f)} — tracked by the lock but no longer rendered by the config`);
      for (const f of result.render.unexpected) console.log(`unrendered: ${f} — the config would render this file but the lock does not track it`);
      for (const e of result.render.errors) console.log(`verify-render: ${e}`);
      for (const n of result.notes) console.log(n);
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
      const toolkitIdentity = requireRelease('upgrade');
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
    case 'init': {
      const gitignore = extractFlag(args, '--gitignore');
      const file = init({ cwd });
      console.log(`wrote ${file} — pick stacks and config values, then run \`wafflestack render\``);
      console.log('(or run `wafflestack setup` and hand the printed playbook to your coding agent)');
      // Only the local overlay and its lock are knowable at init — no stacks are chosen yet;
      // `install --gitignore` adds the rest once a stack that declares them is enabled.
      if (gitignore) reportGitignore(ensureGitignoreEntries(cwd, [LOCAL_CONFIG_FILE, LOCAL_LOCK_FILE]));
      break;
    }
    case 'setup': {
      // Reporting only — it writes nothing, so it warns rather than refusing (#373).
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

      // The DEFAULT must stay the plain table — CI, pipes and agents drive this CLI, so a missing
      // TTY degrades to the table rather than blocking on readline.
      if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
        const result = await interactiveSelect(model);
        if (result.applied && result.refs.length) {
          // The one branch of `list` that writes — hence the gate here, not on the command.
          const toolkitIdentity = requireRelease('list --interactive');
          installRefs({ toolkitRoot, cwd, refs: result.refs, log: console.log });
          runRender(false, toolkitIdentity);
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

// `toolkitIdentity` is what `requireRelease()` already resolved; every caller here is a gated
// command, so it is never null, and the lock records WHICH toolkit rendered (#374).
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

// Reached only after `runRender` succeeds — the explicit `--gitignore` flag is the consent.
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
