import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { exists } from './util.mjs';
import { readLock } from './render.mjs';
import { loadToolkit } from './toolkit.mjs';
import { normalizeItemRef, resolveRef, closureDeps, includeRefMatches } from './refs.mjs';
import { CONFIG_FILE, LEGACY_CONFIG_FILE, LOCK_FILE, resolveConfigFile } from './project.mjs';

/**
 * Stop managing an item: add it to the config's `eject:` list (comment-preserving
 * YAML edit) and drop its rendered files from the lock so they become project-owned.
 * The files themselves are left in place. An item installed via `include:` is also
 * removed from that list — otherwise the eject filter would leave a dead entry that
 * silently does nothing.
 */
export function eject({ cwd, item, log = () => {} }) {
  const ref = normalizeItemRef(item);
  if (!/^(agents|skills|files)\//.test(ref)) {
    throw new Error(`eject target must look like skills/<name>, agents/<name>, or files/<path>, got "${item}"`);
  }
  const [, kind, name] = /^(agents|skills|files)\/(.+)$/.exec(ref);

  const { file: configFile, legacy, note } = resolveConfigFile(cwd);
  if (legacy) log(note);
  const doc = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'));
  let dirty = false;
  const current = doc.get('eject');
  const list = current ? current.toJSON() : [];
  if (!list.includes(ref)) {
    doc.set('eject', [...list, ref]);
    dirty = true;
  }
  // Drop any matching include entry (qualified or not) so it is not left orphaned.
  const includeNode = doc.get('include');
  if (includeNode) {
    const includeList = includeNode.toJSON();
    const kept = includeList.filter((r) => !includeRefMatches(r, kind, name));
    if (kept.length !== includeList.length) {
      if (kept.length) doc.set('include', kept);
      else doc.delete('include');
      dirty = true;
    }
  }
  if (dirty) fs.writeFileSync(configFile, doc.toString());

  const lock = readLock(cwd);
  const released = [];
  if (lock) {
    // A `files/` item is a single output at its repo-relative path — match it exactly
    // (no prefix match, so `scripts/build` never sweeps up `scripts/build.mjs`). Agents
    // and skills expand to their per-target render dirs.
    let matches;
    if (kind === 'files') {
      matches = (rel) => rel === name;
    } else {
      const patterns = kind === 'agents'
        ? [path.join('.claude', 'agents', `${name}.md`), path.join('.codex', 'agents', `${name}.toml`)]
        : [path.join('.claude', 'skills', name) + path.sep, path.join('.agents', 'skills', name) + path.sep];
      matches = (rel) => patterns.some((p) => rel === p || rel.startsWith(p));
    }
    for (const rel of Object.keys(lock.files)) {
      if (matches(rel)) {
        delete lock.files[rel];
        released.push(rel);
      }
    }
    fs.writeFileSync(path.join(cwd, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  }

  return { ref, released };
}

/**
 * Additive per-item/bundle install — the mirror of `eject`. Resolves each ref against
 * the toolkit, then does a comment-preserving YAML edit of `.waffle.yaml`: bundle
 * refs append to `bundles:`, item refs (canonicalized, bundle-qualified only when the
 * name is ambiguous) append to `include:`. Persistence is required, not cosmetic — the
 * frozen-image contract would otherwise delete an ad-hoc install on the next render.
 * Dependency closure is NOT persisted; it is recomputed each render, so this only
 * records the user's chosen refs. Returns { added, closures } for reporting; the caller
 * runs a normal full render afterwards.
 */
export function installRefs({ toolkitRoot, cwd, refs, log = () => {} }) {
  const { file: configFile, legacy, note } = resolveConfigFile(cwd);
  if (!exists(configFile)) {
    throw new Error(`${CONFIG_FILE} not found in ${cwd} — run \`wafflestack init\` first`);
  }
  if (legacy) log(note);
  const toolkit = loadToolkit(toolkitRoot);

  // Resolve everything up front so an unknown/ambiguous ref fails before we persist.
  const resolved = [];
  const errors = [];
  for (const ref of refs) {
    try {
      resolved.push(resolveRef(toolkit, ref));
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const doc = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'));
  const bundles = doc.get('bundles') ? doc.get('bundles').toJSON() : [];
  const include = doc.get('include') ? doc.get('include').toJSON() : [];
  const added = [];
  const closures = [];
  let touchedBundles = false;
  let touchedInclude = false;

  for (const target of resolved) {
    if (target.type === 'bundle') {
      if (!bundles.includes(target.name)) {
        bundles.push(target.name);
        added.push(target.name);
        touchedBundles = true;
      }
      log(`installing ${target.name} (bundle)`);
      continue;
    }
    const canonical = target.canonicalRef;
    if (!include.includes(canonical)) {
      include.push(canonical);
      added.push(canonical);
      touchedInclude = true;
    }
    const deps = closureDeps(toolkit, target);
    closures.push({ ref: canonical, deps });
    log(`installing ${canonical}${deps.length ? ` (+${deps.length} dep${deps.length === 1 ? '' : 's'}: ${deps.join(', ')})` : ''}`);
  }

  if (touchedBundles) doc.set('bundles', bundles);
  if (touchedInclude) doc.set('include', include);
  if (touchedBundles || touchedInclude) fs.writeFileSync(configFile, doc.toString());

  return { added, closures };
}

const STARTER_CONFIG = `# wafflestack project config — see the toolkit repo's schema/FORMAT.md
# Version pin is the npx ref you install with, e.g. npx github:OWNER/wafflestack#v0.1.0
targets: [claude, codex, agents-dir]
bundles: []
#  - docs-system
#  - github-workflow
#  - code-quality
#  - design
#  - obsidian-dev
#  - orchestration
# Individual items (dependencies pulled in automatically). Prefer whole bundles;
# use this for one-off skills/agents. \`wafflestack install skills/issue\` edits it for you.
include: []
#  - skills/issue
#  - agents/project-manager
config: {}
#  git:
#    botEmail: bot@example.com
# Account-specific values belong in .waffle.local.yaml (gitignore it).
`;

export function init({ cwd }) {
  const configFile = path.join(cwd, CONFIG_FILE);
  if (exists(configFile)) throw new Error(`${CONFIG_FILE} already exists`);
  const legacyFile = path.join(cwd, LEGACY_CONFIG_FILE);
  if (exists(legacyFile)) {
    throw new Error(`${LEGACY_CONFIG_FILE} already exists — run \`wafflestack render\` to rename it to ${CONFIG_FILE}`);
  }
  fs.writeFileSync(configFile, STARTER_CONFIG);
  return configFile;
}
