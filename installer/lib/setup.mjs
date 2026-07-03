import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { exists, lookupPath } from './util.mjs';
import { loadProjectConfig, makeResolver, resolveConfigFile } from './project.mjs';
import { computeSelection } from './refs.mjs';
import { readLock } from './render.mjs';

/**
 * The agent-driven install wizard: the static playbook (schema/SETUP.md), an optional
 * "Current configuration" section injected when the project at `cwd` is already configured,
 * then an inventory generated from the installed toolkit — so the agent running the setup
 * always sees the bundle/config/prerequisite surface of the exact version it will render
 * with (never a stale copy baked into docs) and, on a re-run, its own live selections.
 *
 * `cwd` is optional: without it (or on an unconfigured repo) the current-configuration
 * section is omitted and the guide is byte-for-byte the first-install output.
 */
export function setupGuide(toolkitRoot, toolkitVersion, cwd) {
  const playbook = fs
    .readFileSync(path.join(toolkitRoot, 'schema', 'SETUP.md'), 'utf8')
    .trimEnd();
  const toolkit = loadToolkit(toolkitRoot);
  const sections = [playbook];
  const current = cwd ? currentConfigSection(toolkit, cwd) : null;
  if (current) sections.push(current);
  sections.push(toolkitInventory(toolkit, toolkitVersion));
  // toolkitInventory ends with a trailing newline, so the joined guide does too.
  return sections.join('\n\n---\n\n');
}

/**
 * The "Current configuration" section, injected only when the project is already
 * configured (`.waffle/waffle.yaml`, or a legacy fallback, exists). Reads the live config
 * with the same loaders the renderer uses — `loadProjectConfig`, `computeSelection`,
 * `makeResolver` — so the agent sees its actual targets, selections, effective values, and
 * unset required keys without opening the file, turning a re-run of `setup` into a curated
 * update pass rather than the first-install playbook. Returns null for an unconfigured repo.
 */
function currentConfigSection(toolkit, cwd) {
  if (!exists(resolveConfigFile(cwd).file)) return null;

  const header = '# Current configuration — update mode';
  const notes = [];
  let project;
  try {
    project = loadProjectConfig(cwd, notes);
  } catch (err) {
    // A malformed config must not crash the whole guide — surface it and let the agent fix
    // it. The first-install prose above still applies once the config parses.
    return [
      header,
      '',
      'A config file already exists but could not be read:',
      '',
      `> ${err.message}`,
      '',
      'Fix that before continuing; the first-install playbook above still applies once the',
      'config parses.',
    ].join('\n');
  }

  const trackedFiles = new Set(Object.keys(readLock(cwd)?.files ?? {}));
  const selection = computeSelection(toolkit, project, trackedFiles);
  const primaryTarget = project.targets[0] ?? 'claude';

  const lines = [
    header,
    '',
    'This repo is already configured, so `setup` is curating from its current selections',
    'rather than starting fresh. **Skip step 1 (`init`)** — it refuses to overwrite an',
    'existing `.waffle/waffle.yaml` — and revisit only the steps your change calls for (new',
    'bundle → steps 2–7; config change → steps 3, 5, 7). Everything below is read live from',
    'the repo — trust it over the first-install prose above; the inventory that follows is',
    'the full surface of this toolkit version.',
    '',
  ];
  for (const note of notes) lines.push(`> ${note}`, '');

  lines.push('## Targets', '', project.targets.join(', ') || '(none)', '');

  lines.push('## Bundles enabled', '');
  lines.push(project.bundles.length ? project.bundles.map((b) => `- ${b}`).join('\n') : '(none)', '');

  if (project.include.length) {
    lines.push('## Individual includes', '', project.include.map((r) => `- ${r}`).join('\n'), '');
  }
  if (project.eject.length) {
    lines.push(
      '## Ejected (project-owned, no longer managed)',
      '',
      project.eject.map((r) => `- ${r}`).join('\n'),
      '',
    );
  }

  // Surface unknown/ambiguous refs the way the render would, so the agent can fix them here.
  if (selection.errors.length) {
    lines.push('## Problems in the current selection', '');
    for (const e of selection.errors) lines.push(`- ⚠ ${e}`);
    lines.push('');
  }

  // Group by the bundles that actually contribute selected items (an included item does not
  // drag in its bundle's siblings) — matching render's per-bundle grouping.
  const groups = new Map();
  for (const { bundleName, bundle } of selection.items) {
    if (!groups.has(bundleName)) groups.set(bundleName, bundle);
  }

  const valueLines = [];
  for (const [bundleName, bundle] of groups) {
    const entries = Object.entries(bundle.config);
    if (!entries.length) continue;
    const resolve = makeResolver(bundle, project.values, primaryTarget);
    valueLines.push(`### bundle: ${bundleName}`, '');
    for (const [key, spec] of entries) {
      const set = lookupPath(project.values, key) !== undefined;
      valueLines.push(formatConfigValue(key, spec, set, resolve(key)));
    }
    valueLines.push('');
  }
  if (valueLines.length) {
    lines.push(
      '## Config values (current vs default)',
      '',
      "Every declared key of each enabled bundle with its effective value. `set` means the",
      'value comes from your `.waffle/waffle.yaml` (or the `.local` overlay); `default` means',
      "the bundle's built-in is in force — re-check each default against the project before",
      'accepting it (step 3). ⚠ marks a required key with no value.',
      '',
      ...valueLines,
    );
  }

  // Required keys with no resolved value — the render blockers, collected across bundles.
  const missing = [];
  for (const [bundleName, bundle] of groups) {
    for (const [key, spec] of Object.entries(bundle.config)) {
      if (spec?.required && lookupPath(project.values, key) === undefined) {
        missing.push(`${bundleName}: config.${key}`);
      }
    }
  }
  if (missing.length) {
    lines.push(
      '## Required keys still unset (render blockers)',
      '',
      ...missing.map((m) => `- ⚠ ${m}`),
      '',
    );
  }

  // Syrup: sensitive files across enabled bundles, tracked/installed vs available-but-not.
  const installedFiles = new Set(
    selection.items.filter((i) => i.kind === 'files').map((i) => i.item.name),
  );
  const enabledBundleNames = new Set([...project.bundles, ...groups.keys()]);
  const syrupLines = [];
  for (const name of enabledBundleNames) {
    const bundle = toolkit.bundles.get(name);
    if (!bundle) continue;
    for (const f of bundle.files) {
      if (!bundle.syrup.has(`files/${f.name}`)) continue;
      const installed = installedFiles.has(f.name);
      syrupLines.push(
        `- \`files/${f.name}\` (${name}) — ${
          installed
            ? 'installed — renders on this selection (explicitly included or already tracked)'
            : 'not installed — opt-in only; leave out unless the user asks for it'
        }`,
      );
    }
  }
  if (syrupLines.length) {
    lines.push('## Syrup items (sensitive — opt-in)', '', ...syrupLines, '');
  }

  return lines.join('\n').trimEnd();
}

/** One `- \`key\` … ` bullet describing a config key's effective value in the update view. */
function formatConfigValue(key, spec, set, current) {
  const req = spec?.required ? ' [required]' : '';
  if (set) {
    const val = String(current ?? '');
    return val.includes('\n')
      ? `- \`${key}\`${req} — set (multi-line value; see \`.waffle/waffle.yaml\`)`
      : `- \`${key}\`${req} — set: \`${val}\``;
  }
  if (current === undefined) {
    return `- \`${key}\`${req} — unset (no value, no default)${spec?.required ? ' ⚠' : ''}`;
  }
  const val = String(current);
  return val.includes('\n')
    ? `- \`${key}\`${req} — using default (multi-line; see the inventory below)`
    : `- \`${key}\`${req} — using default: \`${val}\``;
}

export function toolkitInventory(toolkit, version) {
  const hasSyrup = [...toolkit.bundles.values()].some((b) => b.syrup.size);
  const lines = [
    `# Toolkit inventory — ${toolkit.name}${version ? ` v${version}` : ''}`,
    '',
    'Generated from the installed toolkit; authoritative for this version.',
    '',
    'Install a whole bundle by name (adds it to `bundles:`), or a single item by ref —',
    '`skills/<name>` or `agents/<name>` (adds it to `include:`). Bundle-qualify an item as',
    '`<bundle>/skills/<name>` when the same name appears in more than one bundle. Installing',
    "an item pulls its dependency closure automatically (an agent's `skills:` and any declared",
    '`requires:`), so required config is scoped to what the selected items actually reference.',
    '',
  ];
  if (hasSyrup) {
    lines.push(
      'A **syrup** item (marked below) is a sensitive `files/` payload — e.g. a workflow that',
      'needs write permissions on the repo. It is NOT part of a bundle default render: enabling',
      'the bundle does **not** install it. It renders only when you install its ref explicitly',
      "(`install files/<path>`) or the repo already tracks it in `.waffle/waffle.lock.json`. **Do",
      'not install a syrup item unless the user explicitly asks for that specific file** —',
      'default to leaving it out.',
      '',
    );
  }
  for (const bundle of toolkit.bundles.values()) {
    lines.push(`## bundle: ${bundle.name}`, '');
    if (bundle.description) lines.push(bundle.description, '');
    lines.push(`- skills: ${bundle.skills.map((s) => `skills/${s.name}`).join(', ') || '(none)'}`);
    lines.push(`- agents: ${bundle.agents.map((a) => `agents/${a.name}`).join(', ') || '(none)'}`);
    const isSyrup = (f) => bundle.syrup.has(`files/${f.name}`);
    const plainFiles = bundle.files.filter((f) => !isSyrup(f));
    const syrupFiles = bundle.files.filter(isSyrup);
    if (plainFiles.length) {
      lines.push(`- files: ${plainFiles.map((f) => `files/${f.name}`).join(', ')}`);
    }
    if (syrupFiles.length) {
      lines.push(
        `- files (syrup — sensitive, do NOT install by default): ${syrupFiles.map((f) => `files/${f.name}`).join(', ')}`,
      );
    }
    const env = Object.entries(bundle.env);
    if (env.length) {
      lines.push(`- env prerequisites: ${env.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    lines.push('');
    lines.push(...configSection(bundle.config));
    if (bundle.setup) lines.push('### setup notes', '', bundle.setup.trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function configSection(config) {
  const entries = Object.entries(config);
  if (!entries.length) return [];
  const lines = ['### config keys', ''];
  for (const [key, spec] of entries) {
    const description = String(spec?.description ?? '').trim().replace(/\s*\n\s*/g, ' ');
    const d = spec?.default;
    const multiline = d !== undefined && String(d).includes('\n');
    const status = spec?.required
      ? 'required'
      : d !== undefined && !multiline
        ? `optional; default: \`${d}\``
        : 'optional';
    lines.push(`- \`${key}\` (${status}) — ${description}`);
    if (multiline) {
      // Four-backtick fence: defaults may themselves contain ``` blocks.
      lines.push('', '  default:', '', '  ````', ...String(d).split('\n').map((l) => `  ${l}`.trimEnd()), '  ````', '');
    }
  }
  lines.push('');
  return lines;
}
