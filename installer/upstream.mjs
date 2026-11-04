#!/usr/bin/env node
// @ts-check
// `npm run upstream:check` / `upstream:bump` (#828): toolkit-developer tooling for upstream-pinned
// skills. Not a `wafflestack` subcommand: consumers never run it, like `installer/evals.mjs`.

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpstream, bumpUpstream } from './lib/upstream-sync.mjs';
import { UPSTREAM_COMMIT_RE } from './lib/upstream.mjs';

const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const USAGE = [
  'usage: node installer/upstream.mjs check',
  '       node installer/upstream.mjs bump [<ref>] [--commit <sha>]',
  '',
  'check  compare each upstream-pinned skill with the latest upstream commit touching its path',
  '       (or the root LICENSE); exit 0 all current, 1 any behind or diverged, 2 on an error.',
  'bump   re-copy each behind skill (or <ref>, at --commit), rewrite its pin, hash and registry',
  '       commit, and add a CHANGELOG line; exit 0, or 2 on an error. Uses `gh api`.',
].join('\n');

/** @param {string} msg */
function usage(msg) {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (cmd !== 'check' && cmd !== 'bump') usage(cmd ? `unknown command: ${cmd}` : 'missing command');
  /** @type {{ cmd: string, ref: string | null, commit: string | null }} */
  const opts = { cmd, ref: null, commit: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (cmd === 'bump' && a === '--commit') {
      const sha = rest[++i];
      if (!sha || !UPSTREAM_COMMIT_RE.test(sha)) usage('--commit needs a full 40-char lowercase sha');
      opts.commit = sha;
    } else if (cmd === 'bump' && !a.startsWith('-') && opts.ref === null) opts.ref = a;
    else usage(`unexpected argument: ${a}`);
  }
  return opts;
}

/** @param {string | null} s */
const short = (s) => (s ?? '?').slice(0, 12);

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === 'check') {
    const { items } = checkUpstream({ toolkitRoot });
    if (!items.length) console.log('no upstream-pinned skills');
    for (const it of items) {
      const license = it.licenseChanged ? '  (upstream LICENSE changed)' : '';
      console.log(`${it.status.padEnd(8)}  ${it.ref}  ${it.repo}/${it.path}  pinned ${short(it.pinned)} latest ${short(it.latest)}${license}`);
      if (it.error) console.log(`          ${it.error}`);
    }
    const statuses = new Set(items.map((i) => i.status));
    process.exit(statuses.has('error') ? 2 : statuses.has('behind') || statuses.has('diverged') ? 1 : 0);
  }
  let result;
  try {
    result = bumpUpstream({ toolkitRoot, ref: opts.ref, commit: opts.commit });
  } catch (err) {
    usage(/** @type {Error} */ (err).message);
    return;
  }
  for (const it of result.items) {
    const move = it.status === 'bumped' ? `${short(it.from)} -> ${short(it.to)}` : `at ${short(it.from)}`;
    console.log(`${it.status.padEnd(9)}  ${it.ref}  ${move}`);
    if (it.error) console.log(`           ${it.error}`);
    for (const w of it.warnings) console.log(`           warning: ${w}`);
  }
  if (result.items.some((i) => i.status === 'bumped')) console.log('\nnext: npm run validate && npm test, then review the diff');
  process.exit(result.items.some((i) => i.status === 'error') ? 2 : 0);
}

main();
