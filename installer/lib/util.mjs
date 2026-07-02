import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Heuristic binary sniff for `files/` payloads: a NUL byte in the head means binary
 * (byte-copied), otherwise text (template-substituted). Same rule git uses to decide
 * whether to diff a blob — good enough to tell a `.yml`/`.mjs` from a `.png`/`.ico`.
 */
export function isBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

export function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export function exists(file) {
  return fs.existsSync(file);
}

export function writeFileEnsuringDir(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Deep-merge b over a. Objects merge recursively; arrays and scalars replace. */
export function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse a semver-ish version ("0.5.0", "v0.5.0", "0.6.0-rc.1") into [major, minor, patch].
 * Any pre-release / build suffix is ignored — the toolkit tags plain `vX.Y.Z`, and the
 * upgrade window is coarse enough that pre-release ordering does not matter. Returns null
 * when the string has no `X.Y.Z` core (e.g. a lock predating `toolkitVersion`).
 */
export function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Compare two semver-ish versions numerically. Returns -1 / 0 / 1 (a<b / a==b / a>b).
 * An unparseable version sorts below any parseable one (two unparseable compare equal),
 * so a version-less lock is treated as "older than everything" by callers that opt into it.
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Look up a dotted path ("git.botEmail") in a nested object. */
export function lookupPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Parse frontmatter off a markdown file. Returns { data, body }. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: YAML.parse(m[1]) ?? {}, body: text.slice(m[0].length).replace(/^\r?\n+/, '') };
}

export function stringifyFrontmatter(data, body) {
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}
