// @ts-check
// Keeping upstream-pinned skills current (#828, part of #825): `npm run upstream:check` / `upstream:bump`.
// Toolkit-developer tooling only; it talks to GitHub through `gh api`, injectable for tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readYaml } from './util.mjs';
import { upstreamHash, UPSTREAM_LICENSE_FILE } from './upstream.mjs';
import { loadToolkit } from './toolkit.mjs';
import { REGISTRY_FILE } from './registry.mjs';
import { setScalarIn } from './project.mjs';

/** @import { UpstreamPin } from './upstream.mjs' */

/** @typedef {(args: string[]) => any} GhJson a `gh api <args…>` call returning parsed JSON */

/**
 * @typedef {object} PinnedSkill
 * @property {string} ref `<stack>/skills/<name>`
 * @property {string} stack
 * @property {string} skill
 * @property {number} index the entry's position in the stack.yaml `skills:` list
 * @property {string} dir absolute dir of the copy
 * @property {string[]} files the copy's files, as the loader lists them
 * @property {UpstreamPin} pin
 */

/**
 * @typedef {object} CheckItem
 * @property {string} ref
 * @property {string | null} repo
 * @property {string | null} path
 * @property {string | null} pinned
 * @property {string | null} latest the commit a bump would move to (null when unknown)
 * @property {'current' | 'behind' | 'diverged' | 'error'} status
 * @property {boolean} licenseChanged upstream's root LICENSE moved past the pin
 * @property {string | null} upstreamLicense upstream's SPDX id
 * @property {string | null} error
 */

/**
 * The default `gh api` runner: raw stdout, or a throw carrying gh's first stderr line.
 *
 * @param {string[]} args
 * @returns {string}
 */
export function ghApi(args) {
  const res = spawnSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`gh api ${args[0]}: ${res.error.message}`);
  if (res.status !== 0) {
    const line = (res.stderr || '').split('\n').find((l) => l.trim()) ?? `exit ${res.status}`;
    throw new Error(`gh api ${args[0]}: ${line.trim()}`);
  }
  return res.stdout;
}

/** @type {GhJson} */
export const ghJson = (args) => JSON.parse(ghApi(args));

/**
 * Every built-in skill carrying an `upstream:` pin.
 *
 * @param {string} toolkitRoot
 * @returns {PinnedSkill[]}
 */
export function pinnedSkills(toolkitRoot) {
  /** @type {PinnedSkill[]} */
  const out = [];
  for (const [stackName, stack] of loadToolkit(toolkitRoot).stacks) {
    stack.skills.forEach((/** @type {any} */ skill, /** @type {number} */ index) => {
      if (!skill.upstream) return;
      out.push({ ref: `${stackName}/skills/${skill.name}`, stack: stackName, skill: skill.name, index, dir: skill.dir, files: skill.files, pin: skill.upstream });
    });
  }
  return out;
}

/**
 * The newer of two commits on a repo, via `compare/<a>...<b>`: `'a' | 'b' | 'same' | 'diverged'`.
 *
 * @param {GhJson} gh
 * @param {string} repo
 * @param {string} a
 * @param {string} b
 */
function newer(gh, repo, a, b) {
  if (a === b) return 'same';
  const { status } = gh([`repos/${repo}/compare/${a}...${b}`]);
  if (status === 'ahead') return 'b';
  if (status === 'behind' || status === 'identical') return 'a';
  return 'diverged';
}

/**
 * @param {GhJson} gh
 * @param {string} repo
 * @param {string} relPath
 * @param {string} branch
 * @returns {string | null}
 */
function latestTouching(gh, repo, relPath, branch) {
  const commits = gh([`repos/${repo}/commits?path=${encodeURIComponent(relPath)}&sha=${encodeURIComponent(branch)}&per_page=1`]);
  return Array.isArray(commits) && typeof commits[0]?.sha === 'string' ? commits[0].sha : null;
}

/**
 * @param {PinnedSkill} p
 * @param {GhJson} gh
 * @param {Map<string, any>} repoCache
 * @returns {CheckItem}
 */
function checkOne(p, gh, repoCache) {
  const { repo, path: relPath, commit } = p.pin;
  /** @type {CheckItem} */
  const item = { ref: p.ref, repo, path: relPath, pinned: commit, latest: null, status: 'error', licenseChanged: false, upstreamLicense: null, error: null };
  try {
    if (!repo || !relPath || !commit) throw new Error('pin names no repo, path and commit (run validate)');
    if (!repoCache.has(repo)) repoCache.set(repo, gh([`repos/${repo}`]));
    const info = repoCache.get(repo);
    item.upstreamLicense = info?.license?.spdx_id ?? null;
    const branch = info?.default_branch;
    if (typeof branch !== 'string') throw new Error(`repos/${repo} reports no default branch`);
    const latestPath = latestTouching(gh, repo, relPath, branch);
    const latestLicense = latestTouching(gh, repo, UPSTREAM_LICENSE_FILE, branch);
    if (!latestPath) throw new Error(`no commit on ${branch} touches ${relPath}`);
    const pathCmp = newer(gh, repo, commit, latestPath);
    const licenseCmp = latestLicense ? newer(gh, repo, commit, latestLicense) : 'a';
    item.licenseChanged = licenseCmp === 'b';
    if (pathCmp === 'diverged' || licenseCmp === 'diverged') {
      item.status = 'diverged';
      item.latest = latestPath;
    } else if (pathCmp === 'b' && item.licenseChanged && latestLicense) {
      item.status = 'behind';
      item.latest = newer(gh, repo, latestPath, latestLicense) === 'b' ? latestLicense : latestPath;
    } else if (pathCmp === 'b' || item.licenseChanged) {
      item.status = 'behind';
      item.latest = pathCmp === 'b' ? latestPath : /** @type {string} */ (latestLicense);
    } else {
      item.status = 'current';
      item.latest = commit;
    }
  } catch (err) {
    item.status = 'error';
    item.error = /** @type {Error} */ (err).message;
  }
  return item;
}

/**
 * Compare every pin against the latest upstream commit touching its path (or the root LICENSE).
 *
 * @param {{ toolkitRoot: string, gh?: GhJson, pins?: PinnedSkill[] }} opts
 * @returns {{ items: CheckItem[] }}
 */
export function checkUpstream({ toolkitRoot, gh = ghJson, pins = pinnedSkills(toolkitRoot) }) {
  const repoCache = new Map();
  return { items: pins.map((p) => checkOne(p, gh, repoCache)) };
}

/**
 * Insert one bullet at the top of `## [Unreleased]` → `### Changed`, creating that heading after
 * `### Added` (or directly under `## [Unreleased]`) when absent.
 *
 * @param {string} text CHANGELOG.md
 * @param {string} bullet the entry, no trailing newline
 * @returns {string}
 */
export function addChangelogLine(text, bullet) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l));
  if (start < 0) throw new Error('CHANGELOG.md has no `## [Unreleased]` section');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const changed = lines.findIndex((l, i) => i > start && i < end && /^### Changed\s*$/.test(l));
  const entry = [...bullet.split('\n'), ''];
  if (changed >= 0) {
    let at = changed + 1;
    while (at < end && lines[at].trim() === '') at++;
    lines.splice(at, 0, ...entry);
    return lines.join('\n');
  }
  const added = lines.findIndex((l, i) => i > start && i < end && /^### Added\s*$/.test(l));
  let at = start + 1;
  if (added >= 0) {
    const next = lines.findIndex((l, i) => i > added && i < end && /^### /.test(l));
    at = next >= 0 ? next : end;
  } else {
    while (at < end && lines[at].trim() === '') at++;
  }
  const block = ['### Changed', '', ...entry];
  if (at > 0 && lines[at - 1].trim() !== '') block.unshift('');
  lines.splice(at, 0, ...block);
  return lines.join('\n');
}

/**
 * The CHANGELOG bullet a bump records.
 *
 * @param {PinnedSkill} p
 * @param {string} to
 */
export function bumpChangelogBullet(p, to) {
  const short = (/** @type {string | null} */ s) => (s ?? '?').slice(0, 12);
  return [
    `- **Bump upstream-pinned \`${p.skill}\` to ${p.pin.repo}@${short(to)} (from ${short(p.pin.commit)}).**`,
    '',
    `  **Consumer impact:** the rendered \`${p.skill}\` skill now matches upstream at ${short(to)}; consumers`,
    `  who enable \`${p.stack}\` see the new bytes on their next render.`,
  ].join('\n');
}

/**
 * The copy's files whose git `text` attribute is not `unset` (null outside a git work tree).
 *
 * @param {string} root
 * @param {string[]} relFiles root-relative POSIX paths
 * @returns {string[] | null}
 */
export function textAttrNotUnset(root, relFiles) {
  if (!relFiles.length) return [];
  const res = spawnSync('git', ['-C', root, 'check-attr', 'text', '--', ...relFiles], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .filter((l) => !l.endsWith(': text: unset'))
    .map((l) => l.slice(0, l.indexOf(': text: ')));
}

/**
 * Fetch the copy at `commit`: every blob under `<path>/` plus the root LICENSE, path → bytes.
 *
 * @param {GhJson} gh
 * @param {UpstreamPin} pin
 * @param {string} commit
 * @returns {Map<string, Buffer>}
 */
function fetchCopy(gh, pin, commit) {
  const tree = gh([`repos/${pin.repo}/git/trees/${commit}?recursive=1`]);
  if (!Array.isArray(tree?.tree)) throw new Error(`no tree for ${pin.repo}@${commit}`);
  if (tree.truncated) throw new Error(`the tree of ${pin.repo}@${commit} is truncated; bump it by hand`);
  const prefix = `${pin.path}/`;
  /** @type {Map<string, string>} */
  const wanted = new Map();
  let license = null;
  for (const e of tree.tree) {
    if (e.path === UPSTREAM_LICENSE_FILE) license = e;
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (e.mode === '120000') throw new Error(`${e.path} is a symlink; a pinned copy holds regular files only`);
    if (e.type === 'commit') throw new Error(`${e.path} is a submodule; a pinned copy holds regular files only`);
    if (e.type !== 'blob') continue;
    if (rel === UPSTREAM_LICENSE_FILE) throw new Error(`${e.path} collides with the root ${UPSTREAM_LICENSE_FILE} the copy carries`);
    wanted.set(rel, e.sha);
  }
  if (!license || license.type !== 'blob') throw new Error(`${pin.repo}@${commit.slice(0, 12)} has no root ${UPSTREAM_LICENSE_FILE}`);
  if (!wanted.has('SKILL.md')) throw new Error(`${pin.repo}@${commit.slice(0, 12)} has no ${prefix}SKILL.md`);
  wanted.set(UPSTREAM_LICENSE_FILE, license.sha);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const [rel, sha] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const blob = gh([`repos/${pin.repo}/git/blobs/${sha}`]);
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`blob ${sha} (${rel}) is not base64`);
    files.set(rel, Buffer.from(blob.content, 'base64'));
  }
  return files;
}

/** @param {string} dir */
const listFiles = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .sort();

/**
 * The one place a bump touches disk: swap in the new copy dir, then the text files.
 *
 * @param {{ dir: string, files: Map<string, Buffer>, texts: [string, string][] }} plan
 */
function applyPlan({ dir, files, texts }) {
  const scratch = fs.mkdtempSync(path.join(path.dirname(dir), `.${path.basename(dir)}-bump-`));
  try {
    for (const [rel, bytes] of files) {
      fs.mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
      fs.writeFileSync(path.join(scratch, rel), bytes);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(scratch, dir);
  } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
  for (const [file, text] of texts) fs.writeFileSync(file, text);
}

/**
 * The hash of a not-yet-written copy, computed exactly as `upstreamHash` reads it from disk.
 *
 * @param {Map<string, Buffer>} files
 */
function hashOfCopy(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-hash-'));
  try {
    for (const [rel, bytes] of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), bytes);
    }
    return upstreamHash(tmp, listFiles(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @typedef {object} BumpItem
 * @property {string} ref
 * @property {string | null} from
 * @property {string | null} to
 * @property {'bumped' | 'unchanged' | 'error'} status
 * @property {string | null} error
 * @property {string[]} warnings
 */

/**
 * @param {string} toolkitRoot
 * @param {PinnedSkill} p
 * @param {string} to
 * @param {GhJson} gh
 * @param {string | null} upstreamLicense
 * @returns {string[]} warnings
 */
function bumpOne(toolkitRoot, p, to, gh, upstreamLicense) {
  if (upstreamLicense !== p.pin.license) {
    throw new Error(`upstream ${p.pin.repo} is licensed ${upstreamLicense ?? 'unknown'}, the pin says ${p.pin.license}; a relicense is a human decision`);
  }
  if (upstreamHash(p.dir, p.files) !== p.pin.hash) {
    throw new Error(`the copy at ${path.relative(toolkitRoot, p.dir)} no longer matches its pin (an edit or a stray file); restore it before bumping`);
  }
  const files = fetchCopy(gh, p.pin, to);
  const hash = hashOfCopy(files);
  const stackFile = path.join(toolkitRoot, 'stacks', p.stack, 'stack.yaml');
  let stackText = fs.readFileSync(stackFile, 'utf8');
  for (const [key, value] of [['commit', to], ['hash', hash]]) {
    stackText = setScalarIn(stackText, ['skills', p.index, 'upstream', key], value) ?? stackText;
  }
  /** @type {[string, string][]} */
  const texts = [[stackFile, stackText]];
  const registryFile = path.join(toolkitRoot, REGISTRY_FILE);
  if (fs.existsSync(registryFile)) {
    const waffles = readYaml(registryFile)?.waffles ?? [];
    const j = waffles.findIndex((/** @type {any} */ e) => e?.kind === 'skill' && e.name === p.skill && e.stack === p.stack);
    if (j < 0) throw new Error(`${REGISTRY_FILE} has no entry for ${p.ref}`);
    const regText = fs.readFileSync(registryFile, 'utf8');
    texts.push([registryFile, setScalarIn(regText, ['waffles', j, 'upstream', 'commit'], to) ?? regText]);
  }
  const changelog = path.join(toolkitRoot, 'CHANGELOG.md');
  texts.push([changelog, addChangelogLine(fs.readFileSync(changelog, 'utf8'), bumpChangelogBullet(p, to))]);
  applyPlan({ dir: p.dir, files, texts });
  const rel = [...files.keys()].map((f) => path.relative(toolkitRoot, path.join(p.dir, f)).split(path.sep).join('/'));
  const textSet = textAttrNotUnset(toolkitRoot, rel);
  return textSet?.length
    ? [`git may eol-convert ${textSet.join(', ')}; add \`${path.relative(toolkitRoot, p.dir).split(path.sep).join('/')}/** -text\` to .gitattributes`]
    : [];
}

/** @param {PinnedSkill[]} pins @param {string} ref */
function matchRef(pins, ref) {
  const hits = pins.filter((p) => p.ref === ref || `skills/${p.skill}` === ref || p.skill === ref);
  if (hits.length !== 1) {
    const known = pins.map((p) => p.ref).join(', ') || 'none';
    throw new Error(hits.length ? `ref ${ref} is ambiguous (${hits.map((h) => h.ref).join(', ')})` : `no upstream-pinned skill ${ref} (pinned: ${known})`);
  }
  return hits[0];
}

/**
 * Move pins forward: rewrite the copy, the stack.yaml pin + hash, the registry commit and a CHANGELOG line.
 *
 * @param {{ toolkitRoot: string, gh?: GhJson, ref?: string | null, commit?: string | null }} opts
 * @returns {{ items: BumpItem[] }}
 */
export function bumpUpstream({ toolkitRoot, gh = ghJson, ref = null, commit = null }) {
  const all = pinnedSkills(toolkitRoot);
  if (commit && !ref && all.length > 1) throw new Error('--commit needs a ref when more than one skill is pinned');
  const pins = ref ? [matchRef(all, ref)] : all;
  const checks = checkUpstream({ toolkitRoot, gh, pins });
  return {
    items: pins.map((p, i) => {
      const c = checks.items[i];
      /** @type {BumpItem} */
      const item = { ref: p.ref, from: p.pin.commit, to: commit ?? c.latest, status: 'unchanged', error: null, warnings: [] };
      try {
        if (c.status === 'error') throw new Error(/** @type {string} */ (c.error));
        if (!commit && c.status === 'diverged') throw new Error(`the pin has diverged from ${p.pin.repo}'s default branch; pass --commit <sha>`);
        if (!item.to || item.to === p.pin.commit) return item;
        item.warnings = bumpOne(toolkitRoot, p, item.to, gh, c.upstreamLicense);
        item.status = 'bumped';
      } catch (err) {
        item.status = 'error';
        item.error = /** @type {Error} */ (err).message;
      }
      return item;
    }),
  };
}
