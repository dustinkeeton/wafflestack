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

const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(toolkitRoot, 'package.json'), 'utf8'));

const [, , command, ...args] = process.argv;
const cwd = extractCwd(args) ?? process.cwd();

try {
  switch (command) {
    case 'render': {
      if (args.length) {
        fail('render takes no refs — use `wafflestack install <ref…>` to add a bundle or item (it persists the choice, then re-renders); bare `render` re-renders the current selection');
      }
      runRender();
      break;
    }
    case 'install': {
      // Bare `install` is an alias for `render`; with refs it persists them first.
      if (args.length) installRefs({ toolkitRoot, cwd, refs: args, log: console.log });
      runRender();
      break;
    }
    case 'doctor': {
      const result = doctor({ cwd, toolkitVersion: pkg.version });
      for (const f of result.modified) console.log(`modified: ${f}`);
      for (const f of result.missing) console.log(`missing:  ${f}`);
      for (const n of result.notes) console.log(n);
      if (result.ok) console.log('all managed files match the lock manifest');
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case 'eject': {
      if (!args[0]) fail('usage: wafflestack eject <skills/NAME | agents/NAME>');
      const { ref, released } = eject({ cwd, item: args[0] });
      console.log(`ejected ${ref}; ${released.length} files released from management:`);
      for (const f of released) console.log(`  ${f}`);
      console.log('the files remain in place and are now project-owned');
      break;
    }
    case 'init': {
      const file = init({ cwd });
      console.log(`wrote ${file} — pick bundles and config values, then run \`wafflestack render\``);
      console.log('(or run `wafflestack setup` and hand the printed playbook to your coding agent)');
      break;
    }
    case 'setup': {
      process.stdout.write(setupGuide(toolkitRoot, pkg.version));
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
          'usage: wafflestack <init|setup|install|render|doctor|eject|validate> [refs…] [--cwd DIR]',
        ].join('\n'),
      );
  }
} catch (err) {
  fail(err.message);
}

function runRender() {
  const result = renderProject({ toolkitRoot, cwd, toolkitVersion: pkg.version, log: console.log });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  console.log(`rendered ${result.written.length} files into ${cwd}`);
  if (result.removed.length) console.log(`removed stale: ${result.removed.join(', ')}`);
}

function extractCwd(argv) {
  const i = argv.indexOf('--cwd');
  if (i === -1) return undefined;
  const dir = argv[i + 1];
  if (!dir) fail('--cwd requires a directory');
  argv.splice(i, 2);
  return path.resolve(dir);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
