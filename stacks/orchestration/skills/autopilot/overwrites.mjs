#!/usr/bin/env node
//
// overwrites.mjs — integration gate stage 1: did a later PR drop lines an earlier PR added?
// A later PR whose branch forked after the earlier one merged built on it: its removals are NOTEs.
// Dependency-free, local git only. Exit 0 clean, 1 findings, 2 usage or git error.
//
// Usage: node overwrites.mjs --head <sha> --pr <label>=<sha> [--pr …] [--ignore <path> …]
//   --pr is repeated oldest merge first; a numeric label prints as #N.

import { spawnSync } from 'node:child_process';

const USAGE = 'Usage: node overwrites.mjs --head <sha> --pr <label>=<sha> [--pr <label>=<sha> …] [--ignore <path> …]';
const DEFAULT_IGNORES = ['.waffle/waffle.lock.json'];
const SHOW_PER_GROUP = 5;

class GitError extends Error {}

function git(args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) throw new GitError(`git ${args.join(' ')}: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

function parseArgs(argv) {
  const out = { prs: [], ignores: [...DEFAULT_IGNORES] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--help' || a === '-h') return { help: true };
    if (!['--head', '--pr', '--ignore'].includes(a)) return { error: `unknown argument: ${a}` };
    if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
    i++;
    if (a === '--head') out.head = v;
    else if (a === '--ignore') out.ignores.push(v);
    else {
      const m = /^([^=\s]+)=(\S+)$/.exec(v);
      if (!m) return { error: `--pr wants <label>=<sha>, got ${v}` };
      out.prs.push({ label: /^\d+$/.test(m[1]) ? `#${m[1]}` : m[1], ref: m[2] });
    }
  }
  if (!out.head) return { error: '--head is required' };
  if (!out.prs.length) return { error: 'at least one --pr is required' };
  return out;
}

const resolve = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
const isAncestor = (a, b) => spawnSync('git', ['merge-base', '--is-ancestor', a, b]).status === 0;

/** Where the PR's branch first left its base (a later merge of the base in doesn't move it); null without a second parent. */
function forkPoint(sha) {
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ');
  if (parents.length < 3) return null;
  const own = git(['rev-list', '--first-parent', parents[2], `^${parents[1]}`]).trim().split('\n');
  return own[0] ? git(['rev-parse', `${own[own.length - 1]}^1`]).trim() : null;
}

function unquote(p) {
  if (!p.startsWith('"')) return p;
  const esc = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
  return p.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => esc[c]);
}

// Header paths: `--- a/x`, `+++ b/x`, `/dev/null`; git appends a tab to a name with spaces.
const headerPath = (rest) => (rest === '/dev/null' ? null : unquote(rest.replace(/\t$/, '')).slice(2));

/** One merge commit's net change: per file, its old/new path and the +/- lines. */
function changes(sha) {
  const out = git(['diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `${sha}^1`, sha]);
  const files = [];
  let f = null;
  let inHunk = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { from: null, to: null, added: [], removed: [], deleted: false };
      files.push(f);
      inHunk = false;
    } else if (!f) continue;
    else if (!inHunk && line.startsWith('rename from ')) f.from = unquote(line.slice(12));
    else if (!inHunk && line.startsWith('rename to ')) f.to = unquote(line.slice(10));
    else if (!inHunk && line.startsWith('deleted file mode')) f.deleted = true;
    else if (!inHunk && line.startsWith('--- ')) f.from = headerPath(line.slice(4));
    else if (!inHunk && line.startsWith('+++ ')) f.to = headerPath(line.slice(4));
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) f.added.push(line.slice(1));
    else if (inHunk && line.startsWith('-')) f.removed.push(line.slice(1));
  }
  return files;
}

/** Where each path touched at `sha` lives at `head`: a new path, or null when deleted. */
function pathsAtHead(sha, head) {
  const parts = git(['diff', '-M', '--name-status', '-z', sha, head]).split('\0');
  const moved = new Map();
  for (let i = 0; i < parts.length - 1; ) {
    const status = parts[i];
    if (status.startsWith('R')) {
      moved.set(parts[i + 1], parts[i + 2]);
      i += 3;
    } else {
      if (status === 'D') moved.set(parts[i + 1], null);
      i += 2;
    }
  }
  return (p) => (moved.has(p) ? moved.get(p) : p);
}

function linesAt(head, p, cache) {
  const key = `${head}:${p}`;
  if (!cache.has(key)) {
    const r = spawnSync('git', ['show', key], { encoding: 'utf8', maxBuffer: 1 << 28 });
    cache.set(key, r.status !== 0 ? null : r.stdout.includes('\0') ? 'binary' : new Set(r.stdout.split('\n')));
  }
  return cache.get(key);
}

/** First later PR that removed `line` without re-adding it (null: deleted the file), tracking renames. */
function remover(later, startPath, line) {
  const names = new Set([startPath]);
  for (const pr of later) {
    for (const f of pr.files) {
      if (!names.has(f.from)) continue;
      if (f.deleted || (line !== null && f.removed.includes(line) && !f.added.includes(line))) return pr;
      if (f.to) names.add(f.to);
    }
  }
  return null;
}

function check(args) {
  const head = resolve(args.head);
  const prs = args.prs.map((p) => {
    const sha = resolve(p.ref);
    return { ...p, sha, fork: forkPoint(sha), files: changes(sha) };
  });
  const cache = new Map();
  const findings = [];
  const notes = [];
  let checked = 0;
  const informed = (pr, by) => Boolean(by?.fork) && isAncestor(pr.sha, by.fork);
  prs.forEach((pr, i) => {
    const later = prs.slice(i + 1);
    const atHead = pathsAtHead(pr.sha, head);
    for (const f of pr.files) {
      if (!f.to || args.ignores.includes(f.to)) continue;
      const added = f.added.filter((l) => l.trim() !== '');
      if (!added.length) continue;
      const now = atHead(f.to);
      const lines = now === null ? null : linesAt(head, now, cache);
      if (lines === 'binary') continue;
      checked += added.length;
      if (lines === null) {
        const r = remover(later, f.to, null);
        (informed(pr, r) ? notes : findings).push({ kind: 'DELETED', path: f.to, by: pr.label, count: added.length, removedBy: r?.label });
        continue;
      }
      for (const line of added) {
        if (lines.has(line)) continue;
        const r = remover(later, f.to, line);
        (informed(pr, r) ? notes : findings).push({ kind: 'OVERWRITE', path: now, by: pr.label, line, removedBy: r?.label });
      }
    }
  });
  return { findings, notes, checked, prs: prs.length };
}

function report({ findings, notes, checked, prs }) {
  const rewrites = new Map();
  for (const f of notes) {
    const key = `${f.path}\0${f.removedBy}\0${f.by}`;
    rewrites.set(key, (rewrites.get(key) ?? 0) + (f.count ?? 1));
  }
  for (const [key, count] of rewrites) {
    const [path, removedBy, by] = key.split('\0');
    console.log(`NOTE: ${path}: ${removedBy} rewrote ${count} line(s) ${by} added, on a branch built on ${by}`);
  }
  const removal = (by) => (by ? `removed by ${by}` : "removed outside the run's PRs");
  const groups = new Map();
  for (const f of findings) {
    const key = `${f.kind}\0${f.path}\0${f.by}\0${f.removedBy ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const g of groups.values()) {
    const { kind, path, by, removedBy } = g[0];
    if (kind === 'DELETED') {
      console.log(`DELETED: ${path}: ${by} added ${g[0].count} line(s); file ${removedBy ? `deleted by ${removedBy}` : "deleted outside the run's PRs"}`);
      continue;
    }
    for (const f of g.slice(0, SHOW_PER_GROUP)) {
      const text = f.line.length > 120 ? `${f.line.slice(0, 117)}...` : f.line;
      console.log(`OVERWRITE: ${path}: ${by} added ${JSON.stringify(text)}; ${removal(removedBy)}`);
    }
    if (g.length > SHOW_PER_GROUP) console.log(`OVERWRITE: ${path}: … and ${g.length - SHOW_PER_GROUP} more line(s) ${by} added; ${removal(removedBy)}`);
  }
  const lost = findings.reduce((n, f) => n + (f.count ?? 1), 0);
  const rewritten = notes.reduce((n, f) => n + (f.count ?? 1), 0);
  if (!findings.length) console.log(`overwrites: none (${checked} added line(s) across ${prs} PR(s); ${rewritten} rewritten by PRs built on them)`);
  else console.log(`overwrites: ${lost} of ${checked} added line(s) missing, in ${new Set(findings.map((f) => f.path)).size} file(s)`);
  return findings.length ? 1 : 0;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.error) {
  console.error(`ERROR: ${args.error}\n${USAGE}`);
  process.exit(2);
}
try {
  process.exit(report(check(args)));
} catch (e) {
  console.error(`ERROR: ${e instanceof GitError ? e.message : e.stack}`);
  process.exit(2);
}
