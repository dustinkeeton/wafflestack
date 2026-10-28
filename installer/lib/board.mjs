// @ts-check
// `state --board` (#697, part of #610): the best-effort team-focus read behind the `/standup`
// pane. Up to three `gh api graphql` calls, time-boxed, cached briefly in the user cache dir, never thrown.

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultUpdateCacheFile, readUpdateCache, writeUpdateCache } from './update-check.mjs';

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
 * @property {{ number: number, title: string, done: number, total: number }[]} epics open issues with sub-issues or an `[epic]` title, native sub-issue progress
 * @property {BoardItem[]} inProgress
 * @property {BoardItem[]} inReview
 * @property {string|null} projectName the `project.name` searched for; null means no board lookup ran
 * @property {{ number: number, title: string }|null} project the Projects v2 board matched to `project.name`
 * @property {string|null} projectError why the board lookup failed (e.g. no `project` scope); the other lists still stand
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
    owner { login }
  }
}`;

// An epic is an open issue with native sub-issues, or an `[epic]` title (so a childless epic shows).
// Search has no sub-issue qualifier, so parents come from the newest 100 open issues.
const EPICS_FIELDS = `search(query: $q, type: ISSUE, first: 50) { nodes { ...Epic } }
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...Epic } }
  }`;
const EPIC_FRAGMENT = 'fragment Epic on Issue { number title subIssuesSummary { total completed } }';
const EPIC_TITLE = /^\s*\[epic\]/i;

// Its own call: `projectsV2` needs the opt-in `project` scope, so its failure must not blank the rest.
const PROJECT_QUERY = `query($login: String!, $title: String!) {
  repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: 20, query: $title) { nodes { number title
    items(first: 100, query: "status:\\"In Progress\\",\\"In Review\\" is:open") { nodes {
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      content { __typename ... on Issue { number title } ... on PullRequest { number title } ... on DraftIssue { title } }
    } }
  } } } }
}`;

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
  return { milestones: [], epics: [], inProgress: [], inReview: [], projectName: null, project: null, projectError: null, error, checkedAt: null, source: null, ...over };
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
  if (offline) return emptyBoard(BOARD_ERRORS.offline, { projectName });
  const key = `${path.resolve(cwd)}#${projectName ?? ''}`;
  const cached = /** @type {BoardBlock|undefined} */ (/** @type {unknown} */ (readUpdateCache(cacheFile)[key]));
  const age = cached ? now() - Date.parse(cached.checkedAt ?? '') : NaN;
  if (cached && age >= 0 && age < BOARD_CACHE_TTL_MS) return { ...cached, projectName, source: 'cache' };

  const checkedAt = new Date(now()).toISOString();
  /** @type {BoardBlock} */
  let board;
  try {
    board = { ...fetchBoard({ cwd, projectName, gh, now }), projectName, checkedAt, source: 'remote' };
  } catch (err) {
    board = emptyBoard(describeGhError(err), { projectName, checkedAt, source: 'remote' });
  }
  try {
    writeUpdateCache(cacheFile, key, /** @type {any} */ (board));
  } catch {
    // An unwritable cache costs one more read next time, nothing else.
  }
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
  const milestones = (repo.milestones?.nodes ?? []).map((/** @type {any} */ m) => ({ title: m.title, dueOn: m.dueOn ?? null }));
  const remaining = () => BOARD_BUDGET_MS - (now() - start);

  // Call 1 is capped at 5 s, so at least 3 s of the 8 s budget is left here.
  const [owner, name] = repo.nameWithOwner.split('/');
  const vars = ['-f', `q=repo:${repo.nameWithOwner} is:issue is:open "[epic]" in:title`, '-f', `owner=${owner}`, '-f', `name=${name}`];
  const query = `query($q: String!, $owner: String!, $name: String!) { ${EPICS_FIELDS} } ${EPIC_FRAGMENT}`;
  const data = graphql(gh, cwd, Math.min(BOARD_CALL_TIMEOUT_MS, remaining()), query, vars);

  /** @type {Map<number, { number: number, title: string, done: number, total: number }>} */
  const epicsByNumber = new Map();
  for (const n of [...(data?.search?.nodes ?? []), ...(data?.repository?.issues?.nodes ?? [])]) {
    if (typeof n?.number !== 'number' || typeof n.title !== 'string') continue;
    const total = n.subIssuesSummary?.total ?? 0;
    if (total > 0 || EPIC_TITLE.test(n.title)) epicsByNumber.set(n.number, { number: n.number, title: n.title, done: n.subIssuesSummary?.completed ?? 0, total });
  }
  const epics = [...epicsByNumber.values()].sort((a, b) => a.number - b.number);
  const board = emptyBoard(null, { milestones, epics });
  if (!projectName) return board;

  const left = remaining();
  if (left <= 0) return { ...board, projectError: BOARD_ERRORS.budget };
  try {
    const nodes = graphql(gh, cwd, Math.min(BOARD_CALL_TIMEOUT_MS, left), PROJECT_QUERY, ['-f', `login=${repo.owner?.login ?? owner}`, '-f', `title=${projectName}`])?.repositoryOwner?.projectsV2?.nodes ?? [];
    const match = nodes.find((/** @type {any} */ p) => p?.title?.toLowerCase() === projectName.toLowerCase());
    if (!match) return board;
    const items = match.items?.nodes ?? [];
    return {
      ...board,
      project: { number: match.number, title: match.title },
      inProgress: itemsWithStatus(items, BOARD_STATUSES.inProgress),
      inReview: itemsWithStatus(items, BOARD_STATUSES.inReview),
    };
  } catch (err) {
    return { ...board, projectError: describeGhError(err) };
  }
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
