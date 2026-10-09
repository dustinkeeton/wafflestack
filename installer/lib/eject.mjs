import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import YAML from 'yaml';
import { exists, writeFileEnsuringDir } from './util.mjs';
import { readLock, readLocalLock, readTreeLock } from './render.mjs';
import { loadToolkit, loadToolkitWithSources } from './toolkit.mjs';
import { defaultSourceCacheDir } from './sources.mjs';
import { lockKeys, modReleaseKeys, removeSettingsEntries } from './settings.mjs';
import { normalizeItemRef, resolveRef, closureDeps, selectingStack, includeRefMatches, itemOutputMatcher, computeSelection } from './refs.mjs';
import {
  CONFIG_FILE,
  LEGACY_ROOT_CONFIG_FILE,
  LEGACY_CONFIG_FILE,
  LOCK_FILE,
  LOCAL_LOCK_FILE,
  resolveConfigFile,
  renameLegacyStacksKey,
  dropIncludeEntries,
  loadProjectConfig,
  appendSeqIn,
  removeSeqIn,
  renameKeyIn,
} from './project.mjs';

/**
 * Stop managing an item: add it to the config's `eject:` list and drop its rendered files
 * from the lock so they become project-owned. The files themselves are left in place — but a mod's
 * settings entries (#594) are REMOVED, since a project-owned `enabledPlugins` key would keep loading it.
 * Deliberately render-free (#497): `orphaned` names what the next `render` will prune instead.
 */
export function eject({ cwd, item, toolkitRoot = null, log = () => {} }) {
  const ref = normalizeItemRef(item);
  if (!/^(agents|skills|files|mods)\//.test(ref)) {
    throw new Error(`eject target must look like skills/<name>, agents/<name>, files/<path>, or mods/<name>, got "${item}"`);
  }
  const [, kind, name] = /^(agents|skills|files|mods)\/(.+)$/.exec(ref);

  const { file: configFile, legacy, note } = resolveConfigFile(cwd);
  if (legacy) log(note);
  const original = fs.readFileSync(configFile, 'utf8');
  const doc = YAML.parseDocument(original);
  const steps = [];
  const current = doc.get('eject');
  const list = current ? current.toJSON() : [];
  if (!list.includes(ref)) {
    doc.set('eject', [...list, ref]);
    steps.push((t) => appendSeqIn(t, 'eject', [ref]));
  }
  // Drop any matching include entry (qualified or not): the two lists are mutually exclusive (#497).
  const matchesInclude = (r) => includeRefMatches(r, kind, name);
  const droppedInclude = dropIncludeEntries(doc, matchesInclude).length > 0;
  if (droppedInclude) steps.push((t) => removeSeqIn(t, 'include', matchesInclude));
  // Only a dropped include can orphan anything: a stack expansion never walks a closure.
  const before = toolkitRoot && droppedInclude ? selectedRefs(toolkitRoot, cwd) : null;
  if (steps.length) fs.writeFileSync(configFile, spliceAll(original, steps, doc) ?? doc.toString());
  const after = before ? selectedRefs(toolkitRoot, cwd) : null;
  const orphaned = after ? [...before].filter((r) => r !== ref && !after.has(r)).sort((a, b) => a.localeCompare(b)) : [];

  // Release the paths from BOTH locks (#317): the committed one stops the project managing the
  // file, and a local lock still listing the path makes the next render's stale-prune delete it.
  const matches = itemOutputMatcher(kind, name);
  const released = new Set();
  const locks = [
    { lock: readLock(cwd), file: LOCK_FILE },
    { lock: readLocalLock(cwd), file: LOCAL_LOCK_FILE },
  ];
  // The TREE lock names what is on disk, so it decides which entries leave settings.json.
  if (kind === 'mods') removeSettingsEntries(cwd, modReleaseKeys(readTreeLock(cwd)?.settings, name));
  for (const { lock, file } of locks) {
    if (!lock) continue;
    for (const rel of Object.keys(lock.files)) {
      if (matches(rel)) {
        delete lock.files[rel];
        released.add(rel);
      }
    }
    if (kind === 'mods' && lock.settings) {
      for (const key of modReleaseKeys(lock.settings, name)) {
        delete lock.settings[key];
        released.add(key);
      }
      if (!Object.keys(lock.settings).length) delete lock.settings;
    }
    // Always write to the current location — a lock read via the legacy fallback migrates here.
    writeFileEnsuringDir(path.join(cwd, file), `${JSON.stringify(lock, null, 2)}\n`);
  }

  return { ref, released: [...released].sort((a, b) => a.localeCompare(b)), orphaned };
}

/** The `kind/name` refs the config on disk selects right now; `null` when that cannot be computed (best-effort). */
function selectedRefs(toolkitRoot, cwd) {
  try {
    const project = loadProjectConfig(cwd);
    const toolkit = loadToolkitWithSources({
      builtinRoot: toolkitRoot,
      externalStacks: project.externalStacks ?? [],
      cwd,
      cacheDir: defaultSourceCacheDir(),
      refreshSources: false,
    });
    const stacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
    const tracked = new Set(lockKeys(readTreeLock(cwd)));
    return new Set(computeSelection(toolkit, { ...project, stacks }, tracked).items.map((i) => `${i.kind}/${i.item.name}`));
  } catch {
    return null;
  }
}

/**
 * Additive per-item/stack install — the mirror of `eject`. Persistence is required, not
 * cosmetic: the frozen-image contract would otherwise delete an ad-hoc install on the next
 * render. Dependency closure is NOT persisted; it is recomputed each render.
 * An ejected item ref is UN-EJECTED (#497). `rollback()` restores the config byte-for-byte as it
 * was found, and returns whether there was anything to restore (#548).
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

  const original = fs.readFileSync(configFile, 'utf8');
  const doc = YAML.parseDocument(original);
  // Carry a legacy `bundles:` key forward in place (comment-preserving) before touching the
  // selection, so we never append to a deprecated key or split state across both names.
  const renamedKey = renameLegacyStacksKey(doc);
  const stacks = doc.get('stacks') ? doc.get('stacks').toJSON() : [];
  const include = doc.get('include') ? doc.get('include').toJSON() : [];
  let ejected = doc.get('eject') ? doc.get('eject').toJSON() : [];
  const isEjected = (ref) => ejected.some((e) => normalizeItemRef(e) === ref);
  const added = [];
  const closures = [];
  const unejected = [];
  const appended = { stacks: /** @type {string[]} */ ([]), include: /** @type {string[]} */ ([]) };

  for (const target of resolved) {
    if (target.type === 'stack') {
      if (!stacks.includes(target.name)) {
        stacks.push(target.name);
        added.push(target.name);
        appended.stacks.push(target.name);
      }
      log(`installing ${target.name} (stack)`);
      const stack = toolkit.stacks.get(target.name);
      for (const kind of /** @type {const} */ (['agents', 'skills', 'files', 'mods'])) {
        for (const { name } of stack[kind]) if (isEjected(`${kind}/${name}`)) log(stillEjected(`${kind}/${name}`));
      }
      continue;
    }
    const canonical = target.canonicalRef;
    const plain = `${target.kind}/${target.name}`;
    const isEjectedNow = isEjected(plain);
    if (isEjectedNow) {
      ejected = ejected.filter((e) => normalizeItemRef(e) !== plain);
      unejected.push({ ref: canonical, kind: target.kind, name: target.name });
      log(`un-ejecting ${canonical} — dropping it from \`eject:\` so wafflestack manages it again (a project-owned copy that differs from the render is refused without \`--force\`)`);
    }
    // Checked AFTER the un-eject: a stack-selected item still leaves `eject:`, it just needs no include.
    const via = selectingStack(toolkit, stacks, target);
    if (!via && !include.includes(canonical)) {
      include.push(canonical);
      added.push(canonical);
      appended.include.push(canonical);
    }
    const deps = closureDeps(toolkit, target);
    closures.push({ ref: canonical, deps });
    if (via && !isEjectedNow) log(alreadySelected(canonical, target.kind, via));
    else log(`installing ${canonical}${deps.length ? ` (+${deps.length} dep${deps.length === 1 ? '' : 's'}: ${deps.join(', ')})` : ''}`);
    for (const dep of deps) if (isEjected(dep)) log(stillEjected(dep));
  }

  if (appended.stacks.length) doc.set('stacks', stacks);
  if (appended.include.length) doc.set('include', include);
  if (unejected.length) {
    if (ejected.length) doc.set('eject', ejected);
    else doc.delete('eject');
  }
  const wrote = renamedKey || appended.stacks.length > 0 || appended.include.length > 0 || unejected.length > 0;
  const steps = [];
  if (renamedKey) steps.push((t) => renameKeyIn(t, 'bundles', 'stacks'));
  for (const key of /** @type {const} */ (['stacks', 'include'])) {
    if (appended[key].length) steps.push((t) => appendSeqIn(t, key, appended[key]));
  }
  const unejectedRefs = new Set(unejected.map(({ kind, name }) => `${kind}/${name}`));
  if (unejected.length) steps.push((t) => removeSeqIn(t, 'eject', (e) => unejectedRefs.has(normalizeItemRef(e))));
  if (wrote) fs.writeFileSync(configFile, spliceAll(original, steps, doc) ?? doc.toString());

  return { added, closures, unejected, rollback: () => { if (wrote) fs.writeFileSync(configFile, original); return wrote; } };
}

/** Byte-level save (#575): every step must splice AND land on `doc`'s content, else null — never a mix with re-serialize. */
function spliceAll(original, steps, doc) {
  let text = original;
  for (const step of steps) if ((text = step(text)) === null) return null;
  const check = YAML.parseDocument(text);
  return !check.errors?.length && isDeepStrictEqual(check.toJSON(), doc.toJSON()) ? text : null;
}

const alreadySelected = (ref, kind, stack) =>
  `note: ${ref} is already selected via stack ${stack} — nothing to persist` +
  (kind === 'mods' ? '; it is enabled through `.claude/settings.json` — run `wafflestack setup` for how it loads' : '');

const stillEjected = (ref) =>
  `note: ${ref} stays ejected (project-owned, not rendered) — \`wafflestack install ${ref}\` un-ejects it`;

/**
 * The refused render collisions that are an un-ejected item's project-owned files (#497) — the
 * signal that an install must roll its un-eject back rather than leave the config half-applied.
 */
export function unejectCollisions(unejected, collisions = []) {
  const matchers = unejected.map(({ kind, name }) => itemOutputMatcher(kind, name));
  return collisions.filter((rel) => matchers.some((m) => m(rel)));
}

const STARTER_CONFIG = `# wafflestack project config — see the toolkit repo's schema/FORMAT.md
# Version pin is the npx ref you install with (npx github:OWNER/wafflestack#<release tag>);
# once pinned, the tag in doctor.toolkitRef is the one of record — don't copy it into comments
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
#    botEmail: bot@example.com # REQUIRED whenever cmd references it — see below
#    cmd: git -c commit.gpgsign=false -c tag.gpgSign=false -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}
#      # ^ the opt-in: without this, commands run under your own git config. Quote user.name.
#      #   commit.gpgsign=false + tag.gpgSign=false is recipe A: the recipe owns the signing
#      #   posture, and anything it does not pin stays ambient — an unpinned posture would sign
#      #   bot commits (or tags) with your key, or hang on a prompting signer. See the stack
#      #   setup note (recipes A/B/C).
#      #   cmd: needs BOTH botName and botEmail as real values HERE. Leaning on the
#      #   github-workflow stack's defaults renders a literal {{git.botEmail}} into other
#      #   stacks' skills (e.g. orchestration's delegate) — silently, with no render error.
#      #   botEmail is otherwise account-specific; keep it committed only while cmd uses it
#      #   (a public noreply-style address), which you must anyway if you commit your
#      #   render / re-render in CI.
#
# Account-specific values belong in .waffle/waffle.local.yaml (gitignore it) — NOT here.
# That file takes the same shape; uncomment these there, never in this committed file:
#
#  config:
#    git:
#      botEmail: bot@example.com   # account-specific — but see the cmd note above: if cmd
#                                  # references {{git.botEmail}}, commit it instead of this
#      signingKey: ""              # GPG key ID / SSH pubkey path (never private key material)
`;

export function init({ cwd }) {
  const configFile = path.join(cwd, CONFIG_FILE);
  if (exists(configFile)) throw new Error(`${CONFIG_FILE} already exists`);
  for (const legacyName of [LEGACY_ROOT_CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    if (exists(path.join(cwd, legacyName))) {
      throw new Error(`${legacyName} already exists — run \`wafflestack render\` to move it to ${CONFIG_FILE}`);
    }
  }
  writeFileEnsuringDir(configFile, STARTER_CONFIG);
  return configFile;
}
