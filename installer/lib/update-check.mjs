// @ts-check
// The newer-release check behind `doctor` and `state` (#608): best-effort, time-boxed, cached in the
// user cache dir, and never thrown — any failure is "no verdict", never an error or an exit code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitLsRemoteTags, httpsUrl, parseLsRemoteTags, parseRepoSlug, newerRelease } from './toolkit-ref.mjs';

/** @import { ToolkitIdentity } from './toolkit-ref.mjs' */

export const UPDATE_CHECK_TIMEOUT_MS = 2_000;
export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_FAIL_TTL_MS = 60 * 60 * 1000;

/**
 * @typedef {'remote'|'cache'|'local-tags'|'changelog'|null} LatestSource
 *
 * @typedef {object} LatestRelease
 * @property {string|null} latestTag
 * @property {LatestSource} source
 * @property {string|null} checkedAt ISO time of the remote answer, when one stands behind `latestTag`
 *
 * @typedef {object} UpdateVerdict the `update` block of the state document
 * @property {string|null} latestTag
 * @property {boolean} available
 * @property {string|null} command
 * @property {string|null} checkedAt
 * @property {LatestSource} source
 *
 * @typedef {{ latestTag: string|null, checkedAt: string, failed?: boolean }} CacheEntry
 */

/** `$XDG_CACHE_HOME/wafflestack/latest-release.json`, else `~/.cache/…` — beside the sources cache. */
export function defaultUpdateCacheFile(env = process.env) {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'wafflestack', 'latest-release.json');
}

/**
 * The cache map, `{ [repo]: CacheEntry }`. A missing, corrupt or non-object file reads as empty.
 *
 * @param {string} file
 * @returns {Record<string, CacheEntry>}
 */
export function readUpdateCache(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch {
    return {};
  }
}

/**
 * Merge one entry in, atomically (tmp + rename) so concurrent sessions never read a torn file.
 *
 * @param {string} file
 * @param {string} repo
 * @param {CacheEntry} entry
 */
export function writeUpdateCache(file, repo, entry) {
  const doc = { ...readUpdateCache(file), [repo]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * The latest release tag worth comparing against. A checkout answers from its local tags; an
 * install reads a fresh cache entry, else (online, repo known) asks `lsRemote` once, else falls back
 * to the identity's shipped-CHANGELOG value. Offline reads the cache but never asks or writes.
 *
 * @param {object} opts
 * @param {ToolkitIdentity|null} opts.identity an OFFLINE identity
 * @param {boolean} [opts.offline]
 * @param {(url: string) => string} [opts.lsRemote]
 * @param {string} [opts.cacheFile]
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.failTtlMs]
 * @returns {LatestRelease}
 */
export function resolveLatestRelease({
  identity,
  offline = false,
  lsRemote = (url) => gitLsRemoteTags(url, { timeoutMs: UPDATE_CHECK_TIMEOUT_MS }),
  cacheFile = defaultUpdateCacheFile(),
  now = Date.now,
  ttlMs = UPDATE_CACHE_TTL_MS,
  failTtlMs = UPDATE_FAIL_TTL_MS,
}) {
  const fallback = /** @type {LatestRelease} */ ({
    latestTag: identity?.latestTag ?? null,
    source: identity?.latestTag ? 'changelog' : null,
    checkedAt: null,
  });
  try {
    if (!identity) return fallback;
    if (identity.origin === 'checkout') return { ...fallback, source: fallback.latestTag ? 'local-tags' : null };
    const repo = identity.repo;
    const slug = parseRepoSlug(repo);
    if (!repo || !slug) return fallback;

    const entry = readUpdateCache(cacheFile)[repo];
    const age = entry ? now() - Date.parse(entry.checkedAt) : NaN;
    if (entry && age >= 0 && age < (entry.failed ? failTtlMs : ttlMs)) {
      return entry.failed || !entry.latestTag ? fallback : { latestTag: entry.latestTag, source: 'cache', checkedAt: entry.checkedAt };
    }
    if (offline) return fallback;

    const checkedAt = new Date(now()).toISOString();
    let latestTag;
    try {
      latestTag = parseLsRemoteTags(lsRemote(httpsUrl(slug))).latest;
    } catch {
      // The negative entry keeps an air-gapped pane from paying the timeout on every turn.
      safeWrite(cacheFile, repo, { latestTag: null, checkedAt, failed: true });
      return fallback;
    }
    safeWrite(cacheFile, repo, { latestTag, checkedAt });
    return latestTag ? { latestTag, source: 'remote', checkedAt } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The `update` block: the resolved latest tag, judged against `runningVersion` by `newerRelease`.
 *
 * @param {ToolkitIdentity|null} identity
 * @param {string} runningVersion
 * @param {LatestRelease} latest
 * @returns {UpdateVerdict}
 */
export function updateVerdict(identity, runningVersion, latest) {
  const newer = identity ? newerRelease({ ...identity, latestTag: latest.latestTag }, runningVersion) : null;
  return {
    latestTag: latest.latestTag,
    available: newer !== null,
    command: newer?.command ?? null,
    checkedAt: latest.checkedAt,
    source: latest.source,
  };
}

/** @type {UpdateVerdict} */
export const NO_UPDATE_VERDICT = Object.freeze({ latestTag: null, available: false, command: null, checkedAt: null, source: null });

/** @param {string} file @param {string} repo @param {CacheEntry} entry */
function safeWrite(file, repo, entry) {
  try {
    writeUpdateCache(file, repo, entry);
  } catch {
    // An unwritable cache costs one more lookup next time, nothing else.
  }
}
