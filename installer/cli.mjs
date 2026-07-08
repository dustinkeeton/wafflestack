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
import { loadToolkit } from './lib/toolkit.mjs';
import { formatPrereq } from './lib/prerequisites.mjs';
import { computeListModel, formatListTable, interactiveSelect } from './lib/list.mjs';
import {
  loadProjectConfig,
  ensureGitignoreEntries,
  recommendedGitignoreEntries,
  LOCAL_CONFIG_FILE,
} from './lib/project.mjs';

const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(toolkitRoot, 'package.json'), 'utf8'));

const [, , command, ...args] = process.argv;
const cwd = extractCwd(args) ?? process.cwd();

try {
  switch (command) {
    case 'render': {
      const force = extractFlag(args, '--force');
      const gitignore = extractFlag(args, '--gitignore');
      if (args.length) {
        fail('render takes no refs — use `wafflestack install <ref…>` to add a stack or item (it persists the choice, then re-renders); bare `render` re-renders the current selection');
      }
      runRender(force);
      if (gitignore) offerGitignore();
      break;
    }
    case 'install': {
      const force = extractFlag(args, '--force');
      const gitignore = extractFlag(args, '--gitignore');
      // Bare `install` is an alias for `render`; with refs it persists them first.
      if (args.length) installRefs({ toolkitRoot, cwd, refs: args, log: console.log });
      runRender(force);
      if (gitignore) offerGitignore();
      break;
    }
    case 'doctor': {
      const allowMissing = extractFlag(args, '--allow-missing');
      const result = doctor({ cwd, toolkitVersion: pkg.version, allowMissing, toolkitRoot });
      const from = (f) => (result.attribution?.[f] ? ` — from ${result.attribution[f]}` : '');
      for (const f of result.modified) console.log(`modified: ${f}${from(f)}`);
      for (const f of result.missing) console.log((allowMissing ? `missing (tolerated): ${f}` : `missing:  ${f}`) + from(f));
      for (const n of result.notes) console.log(n);
      // Prerequisite gate (#129): an unmet `require` fails the check; a `recommend` only reports.
      for (const p of result.prerequisites.unmetRequired) console.log(`prerequisite unmet (require): ${formatPrereq(p)}`);
      for (const p of result.prerequisites.unmetRecommended) console.log(`prerequisite unmet (recommend): ${formatPrereq(p)}`);
      if (result.ok) {
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
      // upgrade() logs its narrative (version move, changelog, migrations, render) via `log`.
      const result = upgrade({ toolkitRoot, cwd, toolkitVersion: pkg.version, log: console.log });
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
    case 'init': {
      const gitignore = extractFlag(args, '--gitignore');
      const file = init({ cwd });
      console.log(`wrote ${file} — pick stacks and config values, then run \`wafflestack render\``);
      console.log('(or run `wafflestack setup` and hand the printed playbook to your coding agent)');
      // Only the local overlay (`.waffle/waffle.local.yaml`) is knowable at init (no stacks
      // chosen yet); `install --gitignore` later adds the worktrees dir once a stack that
      // declares it is enabled.
      if (gitignore) reportGitignore(ensureGitignoreEntries(cwd, [LOCAL_CONFIG_FILE]));
      break;
    }
    case 'setup': {
      process.stdout.write(setupGuide(toolkitRoot, pkg.version, cwd));
      break;
    }
    case 'list': {
      const interactive = extractFlag(args, '--interactive');
      const noColor = extractFlag(args, '--no-color');
      if (args.length) fail(`list takes no refs (got ${args.join(', ')}) — it reports the whole toolkit surface`);
      const model = computeListModel({ toolkitRoot, cwd, toolkitVersion: pkg.version });

      // Interactive is opt-in (`--interactive`) AND needs a real TTY on both ends. The DEFAULT is
      // always the plain table — safe for CI, pipes and agents, consistent with the toolkit's
      // deliberately non-interactive CLI. `--interactive` without a TTY degrades to the table
      // (never blocks on readline).
      if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
        const result = await interactiveSelect(model);
        if (result.applied && result.refs.length) {
          installRefs({ toolkitRoot, cwd, refs: result.refs, log: console.log });
          runRender();
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
    case 'validate': {
      const problems = validateToolkit(toolkitRoot);
      for (const p of problems) console.error(p);
      console.log(problems.length ? `${problems.length} problems` : 'toolkit is valid');
      process.exit(problems.length ? 1 : 0);
      break;
    }
    default:
      fail(
        [
          '┏━┳━┳━┓',
          `┣━╋━╋━┫  wafflestack v${pkg.version}`,
          '┣━╋━╋━┫  one batter, every repo',
          '┗━┻━┻━┛',
          '',
          'usage: wafflestack <init|setup|list|install|render|upgrade|doctor|eject|validate> [refs…] [--cwd DIR]',
        ].join('\n'),
      );
  }
} catch (err) {
  fail(err.message);
}

function runRender(force = false) {
  const result = renderProject({ toolkitRoot, cwd, toolkitVersion: pkg.version, force, log: console.log });
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
