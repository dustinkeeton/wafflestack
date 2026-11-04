// @ts-check
// Upstream-pinned skills (#826, part of #825): a skill copied from an upstream repo at a pinned
// commit. This module owns the pin's shape and the offline content hash of the copy.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './util.mjs';

/** The keys a `stack.yaml` skill entry's `upstream:` mapping may carry. */
export const UPSTREAM_KEYS = Object.freeze(['repo', 'path', 'commit', 'license', 'hash']);

/** The keys a registry entry's `upstream:` may carry: provenance identity, never the hash. */
export const REGISTRY_UPSTREAM_KEYS = Object.freeze(['repo', 'path', 'commit', 'license']);

/** The upstream license file that must travel with the copy, in the item dir. */
export const UPSTREAM_LICENSE_FILE = 'LICENSE';

export const UPSTREAM_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
export const UPSTREAM_COMMIT_RE = /^[0-9a-f]{40}$/;
export const UPSTREAM_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * @typedef {object} UpstreamPin an `upstream:` value, normalized but NOT yet validated
 * @property {string | null} repo `owner/name`
 * @property {string | null} path upstream repo-relative dir the copy came from
 * @property {string | null} commit 40-char lowercase sha
 * @property {string | null} license license identifier
 * @property {string | null} hash `sha256:<hex>` of the copy (`upstreamHash`)
 * @property {boolean} isMap false when the authored value is not a mapping
 * @property {string[]} unknownKeys keys outside the allowed set
 * @property {any} raw the value exactly as authored
 */

/**
 * @param {unknown} raw the authored `upstream:` value
 * @param {readonly string[]} [allowed]
 * @returns {UpstreamPin | null} null when no `upstream:` was authored
 */
export function normalizeUpstream(raw, allowed = UPSTREAM_KEYS) {
  if (raw === undefined || raw === null) return null;
  const isMap = typeof raw === 'object' && !Array.isArray(raw);
  /** @type {Record<string, unknown>} */
  const e = isMap ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {(v: unknown) => string | null} */
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    repo: str(e.repo),
    path: str(e.path),
    commit: str(e.commit),
    license: str(e.license),
    hash: str(e.hash),
    isMap,
    unknownKeys: Object.keys(e).filter((k) => !allowed.includes(k)),
    raw,
  };
}

/**
 * The content hash of an item copy: a `sha256sum`-style manifest (`<hex>  <posix-rel>\n` per file,
 * sorted by POSIX path) hashed again. Raw bytes; no line-ending normalization.
 *
 * @param {string} dir absolute item dir
 * @param {string[]} files dir-relative paths (either separator), as the loader lists them
 * @returns {string} `sha256:<64 hex>`
 */
export function upstreamHash(dir, files) {
  const lines = files
    .map((rel) => rel.split(path.sep).join('/'))
    .sort()
    .map((rel) => `${sha256(fs.readFileSync(path.join(dir, ...rel.split('/'))))}  ${rel}\n`);
  return `sha256:${sha256(lines.join(''))}`;
}

/** @param {string} p */
function badUpstreamPath(p) {
  if (p.startsWith('/') || p.includes('\\') || p.endsWith('/')) return true;
  return p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Shape problems for a pin, context-free (the caller prefixes `<ctx>: skill <name>`).
 *
 * @param {UpstreamPin} pin
 * @param {{ allowed?: readonly string[], requireHash?: boolean }} [opts]
 * @returns {string[]}
 */
export function upstreamShapeProblems(pin, { allowed = UPSTREAM_KEYS, requireHash = true } = {}) {
  if (!pin.isMap) return [`upstream: must be a mapping (${allowed.join(', ')})`];
  const problems = [];
  if (pin.unknownKeys.length) {
    problems.push(
      `upstream: has unknown key${pin.unknownKeys.length > 1 ? 's' : ''} ` +
        `${pin.unknownKeys.map((k) => `"${k}"`).join(', ')} (allowed: ${allowed.join(', ')})`,
    );
  }
  if (!pin.repo || !UPSTREAM_REPO_RE.test(pin.repo)) problems.push('upstream.repo must be owner/name (a GitHub repo)');
  if (!pin.path || badUpstreamPath(pin.path)) {
    problems.push('upstream.path must be a repo-relative POSIX dir (no leading or trailing /, no \\, no empty, . or .. segment)');
  }
  if (!pin.commit || !UPSTREAM_COMMIT_RE.test(pin.commit)) problems.push('upstream.commit must be a full 40-char lowercase sha');
  if (!pin.license) problems.push('upstream.license is required: the license must travel with the copy');
  if (requireHash && (!pin.hash || !UPSTREAM_HASH_RE.test(pin.hash))) {
    problems.push('upstream.hash must be sha256:<64 lowercase hex> (the copy\'s content hash)');
  }
  return problems;
}
