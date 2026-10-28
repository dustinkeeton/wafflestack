// @ts-check
// `state --board` (#697, part of #610): the best-effort team-focus read behind the `/standup`
// pane. Two `gh api graphql` calls, time-boxed, cached briefly in the user cache dir, never thrown.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultUpdateCacheFile } from './update-check.mjs';

export const BOARD_CALL_TIMEOUT_MS = 5_000;
export const BOARD_BUDGET_MS = 8_000;
export const BOARD_CACHE_TTL_MS = 60_000;
export const BOARD_STATUSES = /** @type {const} */ ({ inProgress: 'In Progress', inReview: 'In Review' });
export const BOARD_ERRORS = /** @type {const} */ ({
  offline: 'offline',
  ghMissing: 'gh not found',
  ghTimeout: 'gh timed out',
  budget: 'timed out',
  ghFailed: 'gh failed',
  badResponse: 'unexpected gh response',
});

/**
 * @typedef {{ number: number|null, title: string, kind: 'issue'|'pr'|'draft' }} BoardItem
 *
 * @typedef {object} BoardBlock the `board` block of `state --json`
 * @property {{ title: string, dueOn: string|null }[]} milestones open, soonest due first
 * @property {{ number: number, title: string, done: number, total: number }[]} epics open `[epic]` issues, native sub-issue progress
 * @property {BoardItem[]} inProgress
 * @property {BoardItem[]} inReview
 * @property {{ number: number, title: string }|null} project the Projects v2 board matched to `project.name`
 * @property {string|null} error
 * @property {string|null} checkedAt ISO time of the gh read
 * @property {'remote'|'cache'|null} source
 *
 * @typedef {(args: string[], opts: { cwd: string, timeoutMs: number }) => string} GhRunner
 */

const REPO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    milestones(states: OPEN, first: 20, orderBy: { field: DUE_DATE, direction: ASC }) { nodes { title dueOn } }
    owner { login ... on ProjectV2Owner { projectsV2(first: 50) { nodes { number title } } } }
  }
}`;

const EPICS_FIELDS = `search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on Issue { number title subIssuesSummary { total completed } } }
  }`;

const ITEMS_FIELDS = `repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) {
    items(first: 100, query: "status:\\"In Progress\\",\\"In Review\\" is:open") { nodes {
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      content { __typename ... on Issue { number title } ... on PullRequest { number title } ... on DraftIssue { title } }
    } }
  } } }`;

/** `latest-release.json`'s sibling (#608). */
export function defaultBoardCacheFile(env = process.env) {
  return path.join(path.dirname(defaultUpdateCacheFile(env)), 'board.json');
}

/** @type {GhRunner} */
export function ghRun(args, { cwd, timeoutMs }) {
  return execFileSync('gh', args, { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {string|null} error
 * @param {Partial<BoardBlock>} [over]
 * @returns {BoardBlock}
 */
export function emptyBoard(error, over = {}) {
  return { milestones: [], epics: [], inProgress: [], inReview: [], project: null, error, checkedAt: null, source: null, ...over };
}

/**
 * The board block. Offline → `error: 'offline'` with no read. A fresh cache entry (60 s, keyed by
 * repo dir + project name) answers as `source: 'cache'`; a failed read is cached too, so a pane
 * refreshing every turn pays the timeout at most once a minute.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string|null} [opts.projectName] the board title to match, case-insensitively
 * @param {boolean} [opts.offline]
 * @param {GhRunner} [opts.gh]
 * @param {string} [opts.cacheFile]
 * @param {() => number} [opts.now]
 * @returns {BoardBlock}
 */
export function readBoard({ cwd, projectName = null, offline = false, gh = ghRun, cacheFile = defaultBoardCacheFile(), now = Date.now }) {
  if (offline) return emptyBoard(BOARD_ERRORS.offline);
  const key = `${path.resolve(cwd)}#${projectName ?? ''}`;
  const cached = readCache(cacheFile)[key];
  const age = cached ? now() - Date.parse(cached.checkedAt ?? '') : NaN;
  if (cached && age >= 0 && age < BOARD_CACHE_TTL_MS) return { ...cached, source: 'cache' };

  const checkedAt = new Date(now()).toISOString();
  /** @type {BoardBlock} */
  let board;
  try {
    board = { ...fetchBoard({ cwd, projectName, gh, now }), checkedAt, source: 'remote' };
  } catch (err) {
    board = emptyBoard(describeGhError(err), { checkedAt, source: 'remote' });
  }
  writeCache(cacheFile, key, board);
  return board;
}

/**
 * @param {{ cwd: string, projectName: string|null, gh: GhRunner, now: () => number }} ctx
 * @returns {BoardBlock}
 */
function fetchBoard({ cwd, projectName, gh, now }) {
  const start = now();
  const repo = graphql(gh, cwd, BOARD_CALL_TIMEOUT_MS, REPO_QUERY, ['-F', 'owner={owner}', '-F', 'name={repo}'])?.repository;
  if (!repo?.nameWithOwner) return emptyBoard(BOARD_ERRORS.badResponse);

  const want = projectName?.toLowerCase();
  const match = want ? (repo.owner?.projectsV2?.nodes ?? []).find((/** @type {any} */ p) => p?.title?.toLowerCase() === want) : null;
  const project = match ? { number: match.number, title: match.title } : null;
  const milestones = (repo.milestones?.nodes ?? []).map((/** @type {any} */ m) => ({ title: m.title, dueOn: m.dueOn ?? null }));

  const remaining = BOARD_BUDGET_MS - (now() - start);
  if (remaining <= 0) return emptyBoard(BOARD_ERRORS.budget, { milestones, project });

  const vars = ['-f', `q=repo:${repo.nameWithOwner} is:issue is:open "[epic]" in:title`];
  let query = `query($q: String!) { ${EPICS_FIELDS} }`;
  if (project) {
    query = `query($q: String!, $login: String!, $number: Int!) { ${EPICS_FIELDS} ${ITEMS_FIELDS} }`;
    vars.push('-f', `login=${repo.owner.login}`, '-F', `number=${project.number}`);
  }
  const data = graphql(gh, cwd, Math.min(BOARD_CALL_TIMEOUT_MS, remaining), query, vars);

  const epics = (data?.search?.nodes ?? [])
    .filter((/** @type {any} */ n) => typeof n?.title === 'string' && /^\s*\[epic\]/i.test(n.title))
    .map((/** @type {any} */ n) => ({ number: n.number, title: n.title, done: n.subIssuesSummary?.completed ?? 0, total: n.subIssuesSummary?.total ?? 0 }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.number - b.number);
  const items = data?.repositoryOwner?.projectV2?.items?.nodes ?? [];
  return emptyBoard(null, {
    milestones,
    epics,
    project,
    inProgress: itemsWithStatus(items, BOARD_STATUSES.inProgress),
    inReview: itemsWithStatus(items, BOARD_STATUSES.inReview),
  });
}

/**
 * @param {any[]} nodes
 * @param {string} status
 * @returns {BoardItem[]}
 */
function itemsWithStatus(nodes, status) {
  /** @type {Record<string, BoardItem['kind']>} */
  const kinds = { Issue: 'issue', PullRequest: 'pr', DraftIssue: 'draft' };
  return nodes
    .filter((n) => n?.status?.name === status && n.content && kinds[n.content.__typename])
    .map((n) => ({ number: n.content.number ?? null, title: n.content.title ?? '', kind: kinds[n.content.__typename] }));
}

/**
 * @param {GhRunner} gh
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {string} query
 * @param {string[]} vars
 */
function graphql(gh, cwd, timeoutMs, query, vars) {
  const out = gh(['api', 'graphql', '-H', 'GraphQL-Features: sub_issues', '-f', `query=${query}`, ...vars], { cwd, timeoutMs });
  return JSON.parse(out)?.data ?? null;
}

/** @param {any} err @returns {string} */
export function describeGhError(err) {
  if (err?.code === 'ENOENT') return BOARD_ERRORS.ghMissing;
  if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM') return BOARD_ERRORS.ghTimeout;
  if (err instanceof SyntaxError) return BOARD_ERRORS.badResponse;
  const detail = String(err?.stderr || err?.message || '').trim().split('\n')[0];
  return detail ? `${BOARD_ERRORS.ghFailed}: ${detail.slice(0, 200)}` : BOARD_ERRORS.ghFailed;
}

/** @param {string} file @returns {Record<string, BoardBlock>} */
function readCache(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/** @param {string} file @param {string} key @param {BoardBlock} board */
function writeCache(file, key, board) {
  try {
    const doc = { ...readCache(file), [key]: board };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // An unwritable cache costs one more read next time, nothing else.
  }
}
