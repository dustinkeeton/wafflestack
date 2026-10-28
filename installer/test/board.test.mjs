import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readBoard,
  emptyBoard,
  describeGhError,
  defaultBoardCacheFile,
  BOARD_CACHE_TTL_MS,
  BOARD_CALL_TIMEOUT_MS,
  BOARD_BUDGET_MS,
  BOARD_ERRORS,
} from '../lib/board.mjs';
import { formatStateText } from '../lib/state.mjs';
import { renderProject } from '../lib/render.mjs';

// #697 — `state --board`. Every test injects the gh runner and a tmp cache; none reaches gh.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = Date.parse('2026-10-27T00:00:00.000Z');

const REPO_DATA = {
  repository: {
    nameWithOwner: 'o/r',
    milestones: { nodes: [{ title: 'v1.0', dueOn: '2026-11-01T00:00:00Z' }, { title: 'later', dueOn: null }] },
    owner: { login: 'o' },
  },
};
const FOCUS_DATA = {
  search: {
    nodes: [
      { number: 20, title: '[epic] Second', subIssuesSummary: { total: 4, completed: 1 } },
      { number: 12, title: 'mentions [epic] mid-title', subIssuesSummary: { total: 0, completed: 0 } },
      { number: 9, title: '[Epic] First', subIssuesSummary: { total: 2, completed: 2 } },
    ],
  },
  repository: {
    issues: {
      nodes: [
        { number: 30, title: 'parent without the prefix', subIssuesSummary: { total: 3, completed: 0 } },
        { number: 20, title: '[epic] Second', subIssuesSummary: { total: 4, completed: 1 } },
        { number: 31, title: 'a plain issue', subIssuesSummary: { total: 0, completed: 0 } },
      ],
    },
  },
};
const PROJECT_DATA = {
  repositoryOwner: {
    projectsV2: {
      nodes: [
        { number: 3, title: 'WaffleStack old', items: { nodes: [{ status: { name: 'In Progress' }, content: { __typename: 'Issue', number: 99, title: 'wrong board' } }] } },
        {
          number: 7,
          title: 'WaffleStack',
          items: {
            nodes: [
              { status: { name: 'In Progress' }, content: { __typename: 'Issue', number: 5, title: 'doing' } },
              { status: { name: 'In Review' }, content: { __typename: 'PullRequest', number: 6, title: 'reviewing' } },
              { status: { name: 'In Progress' }, content: { __typename: 'DraftIssue', title: 'a draft' } },
              { status: { name: 'Todo' }, content: { __typename: 'Issue', number: 8, title: 'not yet' } },
              { status: null, content: { __typename: 'Issue', number: 10, title: 'no status' } },
            ],
          },
        },
      ],
    },
  },
};
const SCOPE_ERROR = Object.assign(new Error('Command failed'), {
  status: 1,
  stderr: "gh: Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']\n",
});

/** A runner that answers by call order and records each call's args and timeout. */
function fakeGh(...answers) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args, ...opts });
    const a = answers[calls.length - 1];
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return a();
    return JSON.stringify({ data: a });
  };
  return Object.assign(fn, { calls });
}

const forbidGh = () => {
  throw new Error('gh was called — this path must not read the board');
};

let dir;
let cacheFile;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  cacheFile = path.join(dir, 'cache', 'board.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readBoard (#697)', () => {
  test('reads milestones, epics (sub-issue parents or [epic] titles), and In Progress / In Review items from the matched board', () => {
    const gh = fakeGh(REPO_DATA, FOCUS_DATA, PROJECT_DATA);
    const b = readBoard({ cwd: dir, projectName: 'wafflestack', gh, cacheFile, now: () => T0 });
    assert.equal(b.error, null);
    assert.equal(b.projectError, null);
    assert.equal(b.projectName, 'wafflestack');
    assert.equal(b.source, 'remote');
    assert.equal(b.checkedAt, new Date(T0).toISOString());
    assert.deepEqual(b.project, { number: 7, title: 'WaffleStack' });
    assert.deepEqual(b.milestones, [{ title: 'v1.0', dueOn: '2026-11-01T00:00:00Z' }, { title: 'later', dueOn: null }]);
    assert.deepEqual(b.epics, [
      { number: 9, title: '[Epic] First', done: 2, total: 2 },
      { number: 20, title: '[epic] Second', done: 1, total: 4 },
      { number: 30, title: 'parent without the prefix', done: 0, total: 3 },
    ]);
    assert.deepEqual(b.inProgress, [{ number: 5, title: 'doing', kind: 'issue' }, { number: null, title: 'a draft', kind: 'draft' }]);
    assert.deepEqual(b.inReview, [{ number: 6, title: 'reviewing', kind: 'pr' }]);

    assert.equal(gh.calls.length, 3);
    assert.ok(gh.calls.every((c) => c.cwd === dir && c.args[0] === 'api' && c.args[1] === 'graphql'));
    assert.ok(!gh.calls[0].args.find((a) => a.startsWith('query=')).includes('projectsV2'), 'the repo call needs no project scope');
    assert.ok(gh.calls[0].args.includes('owner={owner}') && gh.calls[0].args.includes('name={repo}'), 'gh resolves the repo from cwd');
    assert.ok(gh.calls[1].args.includes('q=repo:o/r is:issue is:open "[epic]" in:title'));
    assert.ok(gh.calls[1].args.includes('owner=o') && gh.calls[1].args.includes('name=r'));
    assert.ok(gh.calls[2].args.includes('login=o') && gh.calls[2].args.includes('title=wafflestack'));
    assert.equal(gh.calls[0].timeoutMs, BOARD_CALL_TIMEOUT_MS);
  });

  test('no project.name skips the board call; no matching board is not an error', () => {
    const none = fakeGh(REPO_DATA, { search: FOCUS_DATA.search });
    const b = readBoard({ cwd: dir, projectName: null, gh: none, cacheFile: path.join(dir, 'null.json'), now: () => T0 });
    assert.equal(none.calls.length, 2);
    assert.ok(none.calls.every((c) => !c.args.find((a) => a.startsWith('query=')).includes('projectsV2')));

    const gh = fakeGh(REPO_DATA, { search: FOCUS_DATA.search }, PROJECT_DATA);
    const nope = readBoard({ cwd: dir, projectName: 'nope', gh, cacheFile: path.join(dir, 'nope.json'), now: () => T0 });
    assert.deepEqual([b.projectName, nope.projectName], [null, 'nope'], 'the two cases differ in JSON');
    assert.match(formatStateText(/** @type {any} */ ({ ...TEXT_BASE, board: b })), /\nboard: project\.name unset — no board lookup\n/);
    assert.match(formatStateText(/** @type {any} */ ({ ...TEXT_BASE, board: nope })), /\nboard: no Projects v2 board titled "nope"\n/);
    for (const r of [b, nope]) {
      assert.deepEqual([r.error, r.projectError, r.project], [null, null, null]);
      assert.equal(r.epics.length, 2);
      assert.equal(r.milestones.length, 2);
      assert.deepEqual([r.inProgress, r.inReview], [[], []]);
    }
  });

  test('a board call without the project scope keeps milestones and epics and sets projectError, not error', () => {
    const b = readBoard({ cwd: dir, projectName: 'wafflestack', gh: fakeGh(REPO_DATA, FOCUS_DATA, SCOPE_ERROR), cacheFile, now: () => T0 });
    assert.equal(b.error, null);
    assert.match(b.projectError ?? '', /^gh failed: gh: Your token has not been granted the required scopes/);
    assert.equal(b.project, null);
    assert.equal(b.milestones.length, 2);
    assert.equal(b.epics.length, 3);
    assert.deepEqual([b.inProgress, b.inReview], [[], []]);
    assert.match(formatStateText(/** @type {any} */ ({ ...TEXT_BASE, board: b })), /\nboard: board lookup failed — gh failed: gh: Your token/);
  });

  test('offline skips the read and the cache: error "offline", empty arrays', () => {
    const b = readBoard({ cwd: dir, projectName: 'x', offline: true, gh: forbidGh, cacheFile, now: () => T0 });
    assert.deepEqual(b, emptyBoard('offline', { projectName: 'x' }));
    assert.equal(fs.existsSync(cacheFile), false);
  });

  test('a fresh entry answers from cache for 60 s; a stale one reads again', () => {
    readBoard({ cwd: dir, projectName: 'wafflestack', gh: fakeGh(REPO_DATA, FOCUS_DATA, PROJECT_DATA), cacheFile, now: () => T0 });
    const hit = readBoard({ cwd: dir, projectName: 'wafflestack', gh: forbidGh, cacheFile, now: () => T0 + BOARD_CACHE_TTL_MS - 1 });
    assert.equal(hit.source, 'cache');
    assert.equal(hit.checkedAt, new Date(T0).toISOString());
    assert.equal(hit.epics.length, 3);

    const gh = fakeGh(REPO_DATA, FOCUS_DATA, PROJECT_DATA);
    const again = readBoard({ cwd: dir, projectName: 'wafflestack', gh, cacheFile, now: () => T0 + BOARD_CACHE_TTL_MS });
    assert.equal(again.source, 'remote');
    assert.equal(gh.calls.length, 3);
  });

  test('the cache is keyed by repo dir and project name', () => {
    readBoard({ cwd: dir, projectName: 'wafflestack', gh: fakeGh(REPO_DATA, FOCUS_DATA, PROJECT_DATA), cacheFile, now: () => T0 });
    const gh = fakeGh(REPO_DATA, FOCUS_DATA, PROJECT_DATA);
    readBoard({ cwd: dir, projectName: 'other', gh, cacheFile, now: () => T0 });
    assert.equal(gh.calls.length, 3);
  });

  test('failures set error, never throw, and are cached so a refreshing pane pays once a minute', () => {
    const cases = [
      [Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), BOARD_ERRORS.ghMissing],
      [Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }), BOARD_ERRORS.ghTimeout],
      [Object.assign(new Error('Command failed'), { status: 1, stderr: 'HTTP 401: Bad credentials\nmore' }), 'gh failed: HTTP 401: Bad credentials'],
      [() => 'not json', BOARD_ERRORS.badResponse],
      [() => JSON.stringify({ data: { repository: null } }), BOARD_ERRORS.badResponse],
    ];
    for (const [i, [answer, error]] of cases.entries()) {
      const file = path.join(dir, `fail-${i}.json`);
      const b = readBoard({ cwd: dir, projectName: 'x', gh: fakeGh(answer), cacheFile: file, now: () => T0 });
      assert.equal(b.error, error);
      assert.deepEqual([b.milestones, b.epics, b.inProgress, b.inReview, b.project], [[], [], [], [], null]);
      const cached = readBoard({ cwd: dir, projectName: 'x', gh: forbidGh, cacheFile: file, now: () => T0 + 1 });
      assert.equal(cached.error, error);
      assert.equal(cached.source, 'cache');
    }
  });

  test('an epics call that fails keeps no partial data', () => {
    const err = Object.assign(new Error('x'), { stderr: 'HTTP 502: Bad Gateway' });
    const b = readBoard({ cwd: dir, projectName: 'wafflestack', gh: fakeGh(REPO_DATA, err), cacheFile, now: () => T0 });
    assert.equal(b.error, 'gh failed: HTTP 502: Bad Gateway');
    assert.deepEqual([b.milestones, b.projectError], [[], null]);
  });

  test('the whole read is capped at 8 s: later calls get the remainder, an exhausted budget skips the board call', () => {
    let t = T0;
    const slow = (ms, data) => () => {
      t += ms;
      return JSON.stringify({ data });
    };
    const gh = fakeGh(slow(4_000, REPO_DATA), slow(1_000, { search: { nodes: [] } }), PROJECT_DATA);
    readBoard({ cwd: dir, projectName: 'wafflestack', gh, cacheFile, now: () => t });
    assert.equal(gh.calls[1].timeoutMs, BOARD_BUDGET_MS - 4_000);
    assert.equal(gh.calls[2].timeoutMs, BOARD_BUDGET_MS - 5_000);

    t = T0;
    const spent = fakeGh(slow(BOARD_CALL_TIMEOUT_MS, REPO_DATA), slow(BOARD_BUDGET_MS - BOARD_CALL_TIMEOUT_MS, FOCUS_DATA));
    const b = readBoard({ cwd: dir, projectName: 'wafflestack', gh: spent, cacheFile: path.join(dir, 'b.json'), now: () => t });
    assert.equal(spent.calls.length, 2);
    assert.equal(b.error, null);
    assert.equal(b.projectError, BOARD_ERRORS.budget);
    assert.deepEqual([b.milestones.length, b.epics.length, b.project], [2, 3, null]);
  });

  test('an unwritable cache costs nothing but the next read', () => {
    fs.writeFileSync(path.join(dir, 'cache'), 'a file, not a dir');
    const b = readBoard({ cwd: dir, projectName: 'wafflestack', gh: fakeGh(REPO_DATA, FOCUS_DATA, PROJECT_DATA), cacheFile, now: () => T0 });
    assert.equal(b.error, null);
  });

  test('describeGhError trims stderr to its first line and falls back to the bare label', () => {
    assert.equal(describeGhError({ stderr: '  boom\nsecond' }), 'gh failed: boom');
    assert.equal(describeGhError({}), 'gh failed');
  });

  test('the cache lives beside latest-release.json', () => {
    assert.equal(defaultBoardCacheFile({ XDG_CACHE_HOME: '/x' }), path.join('/x', 'wafflestack', 'board.json'));
  });
});

const TEXT_BASE = {
    project: { targets: ['claude'], stacks: [], include: [], eject: [], localOverlay: false, errors: [] },
    keys: [],
    runFiles: { delegate: null },
    locks: { committed: { path: 'a', present: false }, local: { path: 'b', present: false }, divergence: null },
    drift: { ok: true, modified: [], missing: [], absentDocs: [] },
    agents: [],
    update: null,
    cli: { version: '1.0.0', status: 'release' },
};

describe('state text with a board block (#697)', () => {
  const base = TEXT_BASE;

  test('prints the board section only when the block is present', () => {
    assert.ok(!formatStateText(/** @type {any} */ (base)).includes('board:'));
    const board = emptyBoard(null, {
      project: { number: 7, title: 'WaffleStack' },
      milestones: [{ title: 'v1.0', dueOn: '2026-11-01T00:00:00Z' }],
      epics: [{ number: 9, title: '[epic] First', done: 1, total: 3 }],
      inProgress: [{ number: null, title: 'a draft', kind: 'draft' }],
      inReview: [{ number: 6, title: 'reviewing', kind: 'pr' }],
      source: 'cache',
    });
    const text = formatStateText(/** @type {any} */ ({ ...base, board }));
    for (const line of [
      'board: WaffleStack (#7) (cached)',
      '  milestone: v1.0 — due 2026-11-01',
      '  epic: #9 [epic] First — 1 of 3',
      '  in progress: a draft',
      '  in review: #6 reviewing',
    ]) assert.ok(text.includes(`${line}\n`), line);
    assert.ok(formatStateText(/** @type {any} */ ({ ...base, board: emptyBoard('offline') })).includes('board: unavailable — offline\n'));
  });
});

describe('the CLI flag (#697)', () => {
  test('`state --json` omits board; `--board` adds it; offline (flag or env) reports error "offline", exit 0', () => {
    const xdg = path.join(dir, 'xdg');
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'targets: [claude]\nstacks: []\nconfig: {}\n');
    assert.equal(renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' }).ok, true);
    const run = (args, extraEnv = {}) => {
      const env = { ...process.env, XDG_CACHE_HOME: xdg, ...extraEnv };
      if (!('WAFFLESTACK_OFFLINE' in extraEnv)) delete env.WAFFLESTACK_OFFLINE;
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'installer/cli.mjs'), 'state', ...args, '--cwd', cwd], { encoding: 'utf8', env, timeout: 60000 });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
      return r.stdout;
    };
    assert.equal('board' in JSON.parse(run(['--json', '--offline'])), false);
    assert.deepEqual(JSON.parse(run(['--json', '--board', '--offline'])).board, emptyBoard('offline'));
    assert.deepEqual(JSON.parse(run(['--json', '--board'], { WAFFLESTACK_OFFLINE: '1' })).board, emptyBoard('offline'));
    assert.match(run(['--board', '--offline']), /\nboard: unavailable — offline\n/);
    assert.equal(fs.existsSync(path.join(xdg, 'wafflestack', 'board.json')), false);
  });

  test('online: `project.name` reaches the board lookup through a stub gh on PATH; a failing gh sets error, exit 0', () => {
    const cwd = path.join(dir, 'online');
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'targets: [claude]\nstacks: [github-workflow]\nconfig:\n  project:\n    name: StubBoard\n');
    assert.equal(renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.0.test' }).ok, true);
    const bin = path.join(dir, 'bin');
    const log = path.join(dir, 'gh.log');
    fs.mkdirSync(bin);
    const reply = (data) => `printf '%s' '${JSON.stringify({ data })}'`;
    const project = { repositoryOwner: { projectsV2: { nodes: [{ number: 4, title: 'StubBoard', items: { nodes: [{ status: { name: 'In Progress' }, content: { __typename: 'Issue', number: 41, title: 'stubbed' } }] } }] } } };
    fs.writeFileSync(path.join(bin, 'gh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [ -n "$STUB_GH_FAIL" ]; then echo "HTTP 401: Bad credentials" >&2; exit 1; fi',
      'case "$*" in',
      `  *projectsV2*) ${reply(project)} ;;`,
      `  *search*) ${reply({ search: { nodes: [] } })} ;;`,
      `  *milestones*) ${reply(REPO_DATA)} ;;`,
      '  *) echo "unexpected gh call" >&2; exit 2 ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const run = (cache, extraEnv = {}) => {
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_CACHE_HOME: path.join(dir, cache), ...extraEnv };
      delete env.WAFFLESTACK_OFFLINE;
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'installer/cli.mjs'), 'state', '--json', '--board', '--cwd', cwd], { encoding: 'utf8', env, timeout: 60000 });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      return JSON.parse(r.stdout).board;
    };

    const ok = run('ok');
    assert.equal(ok.error, null);
    assert.deepEqual(ok.project, { number: 4, title: 'StubBoard' });
    assert.deepEqual(ok.inProgress, [{ number: 41, title: 'stubbed', kind: 'issue' }]);
    assert.match(fs.readFileSync(log, 'utf8'), /title=StubBoard/);

    const failed = run('fail', { STUB_GH_FAIL: '1' });
    assert.equal(failed.error, 'gh failed: HTTP 401: Bad credentials');
    assert.deepEqual([failed.milestones, failed.project], [[], null]);
  });
});
