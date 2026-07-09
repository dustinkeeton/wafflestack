import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { exists, writeFileEnsuringDir } from './util.mjs';
import { readLock } from './render.mjs';
import { loadToolkit } from './toolkit.mjs';
import { normalizeItemRef, resolveRef, closureDeps, includeRefMatches, itemOutputMatcher } from './refs.mjs';
import {
  CONFIG_FILE,
  LEGACY_ROOT_CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  LOCK_FILE,
  resolveConfigFile,
  renameLegacyStacksKey,
} from './project.mjs';

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
    // A `files/` item is a single output at its repo-relative path — matched exactly (no
    // prefix match, so `scripts/build` never sweeps up `scripts/build.mjs`). Agents and skills
    // expand to their per-target render dirs. `itemOutputMatcher` is the shared inverse of the
    // render's item→path mapping (also used by `list` for per-item drift).
    const matches = itemOutputMatcher(kind, name);
    for (const rel of Object.keys(lock.files)) {
      if (matches(rel)) {
        delete lock.files[rel];
        released.push(rel);
      }
    }
    // Always write to the current location (creating `.waffle/` when a legacy-layout repo
    // has no dir yet) — a lock read via the legacy fallback migrates here as a side effect.
    writeFileEnsuringDir(path.join(cwd, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  }

  return { ref, released };
}

/**
 * Additive per-item/stack install — the mirror of `eject`. Resolves each ref against
 * the toolkit, then does a comment-preserving YAML edit of `.waffle/waffle.yaml`: stack
 * refs append to `stacks:`, item refs (canonicalized, stack-qualified only when the
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
  // Carry a legacy `bundles:` key forward in place (comment-preserving) before touching the
  // selection, so we never append to a deprecated key or split state across both names.
  const renamedKey = renameLegacyStacksKey(doc);
  const stacks = doc.get('stacks') ? doc.get('stacks').toJSON() : [];
  const include = doc.get('include') ? doc.get('include').toJSON() : [];
  const added = [];
  const closures = [];
  let touchedStacks = false;
  let touchedInclude = false;

  for (const target of resolved) {
    if (target.type === 'stack') {
      if (!stacks.includes(target.name)) {
        stacks.push(target.name);
        added.push(target.name);
        touchedStacks = true;
      }
      log(`installing ${target.name} (stack)`);
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

  if (touchedStacks) doc.set('stacks', stacks);
  if (touchedInclude) doc.set('include', include);
  if (renamedKey || touchedStacks || touchedInclude) fs.writeFileSync(configFile, doc.toString());

  return { added, closures };
}

const STARTER_CONFIG = `# wafflestack project config — see the toolkit repo's schema/FORMAT.md
# Version pin is the npx ref you install with, e.g. npx github:OWNER/wafflestack#v0.1.0
targets: [claude, codex, agents-dir]
stacks: []
#  - docs-system
#  - github-workflow
#  - code-quality
#  - obsidian-dev
#  - orchestration
# Individual items (dependencies pulled in automatically). Prefer whole stacks;
# use this for one-off skills/agents. \`wafflestack install skills/issue\` edits it for you.
include: []
#  - skills/issue
#  - agents/project-manager
config:
#  project:
#    name: My Project        # required by the github-workflow stack (prose + project-board title)
#  git:
#    botName: Wafflebot        # bot identity for automated commits (github-workflow)
#
# Account-specific values belong in .waffle/waffle.local.yaml (gitignore it) — NOT here.
# That file takes the same shape; uncomment these there, never in this committed file:
#
#  config:
#    git:
#      botEmail: bot@example.com   # account-specific
#      signingKey: ""              # GPG key ID / SSH pubkey path (never private key material)
`;

export function init({ cwd }) {
  const configFile = path.join(cwd, CONFIG_FILE);
  if (exists(configFile)) throw new Error(`${CONFIG_FILE} already exists`);
  // Refuse to scaffold a duplicate next to either legacy generation — a plain render
  // moves those into place instead.
  for (const legacyName of [LEGACY_ROOT_CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    if (exists(path.join(cwd, legacyName))) {
      throw new Error(`${legacyName} already exists — run \`wafflestack render\` to move it to ${CONFIG_FILE}`);
    }
  }
  writeFileEnsuringDir(configFile, STARTER_CONFIG);
  return configFile;
}
