import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { exists, lookupPath } from './util.mjs';
import { loadProjectConfig, makeResolver, resolveConfigFile } from './project.mjs';
import { computeSelection, skippedSyrupCompanions } from './refs.mjs';
import { readLock } from './render.mjs';

/**
 * The agent-driven install wizard: the static playbook (schema/SETUP.md), an optional
 * "Current configuration" section injected when the project at `cwd` is already configured,
 * then an inventory generated from the installed toolkit — so the agent running the setup
 * always sees the stack/config/prerequisite surface of the exact version it will render
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
    'stack → steps 2–7; config change → steps 3, 5, 7). Everything below is read live from',
    'the repo — trust it over the first-install prose above; the inventory that follows is',
    'the full surface of this toolkit version.',
    '',
  ];
  for (const note of notes) lines.push(`> ${note}`, '');

  lines.push('## Targets', '', project.targets.join(', ') || '(none)', '');

  lines.push('## Stacks enabled', '');
  lines.push(project.stacks.length ? project.stacks.map((b) => `- ${b}`).join('\n') : '(none)', '');

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

  // Group by the stacks that actually contribute selected items (an included item does not
  // drag in its stack's siblings) — matching render's per-stack grouping.
  const groups = new Map();
  for (const { stackName, stack } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, stack);
  }

  const valueLines = [];
  for (const [stackName, stack] of groups) {
    const entries = Object.entries(stack.config);
    if (!entries.length) continue;
    const resolve = makeResolver(stack, project.values, primaryTarget);
    valueLines.push(`### stack: ${stackName}`, '');
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
      "Every declared key of each enabled stack with its effective value. `set` means the",
      'value comes from your `.waffle/waffle.yaml` (or the `.local` overlay); `default` means',
      "the stack's built-in is in force — re-check each default against the project before",
      'accepting it (step 3). ⚠ marks a required key with no value.',
      '',
      ...valueLines,
    );
  }

  // Required keys with no resolved value — the render blockers, collected across stacks.
  const missing = [];
  for (const [stackName, stack] of groups) {
    for (const [key, spec] of Object.entries(stack.config)) {
      if (spec?.required && lookupPath(project.values, key) === undefined) {
        missing.push(`${stackName}: config.${key}`);
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

  // Opt-in syrup: sensitive files across enabled stacks, tracked/installed vs available-but-not.
  // Reverse the requires: edge (#74) to flag a not-installed syrup that PAIRS with a selected
  // companion waffle — a half-installed flow the agent must resolve with the both/one/neither
  // question, not silently leave gated.
  const installedFiles = new Set(
    selection.items.filter((i) => i.kind === 'files').map((i) => i.item.name),
  );
  const companionsByRef = new Map(
    skippedSyrupCompanions(toolkit, selection).map((s) => [s.fileRef, s.companions]),
  );
  const enabledStackNames = new Set([...project.stacks, ...groups.keys()]);
  const optInLines = [];
  for (const name of enabledStackNames) {
    const stack = toolkit.stacks.get(name);
    if (!stack) continue;
    for (const f of stack.files) {
      const fileRef = `files/${f.name}`;
      if (!stack.optIn.has(fileRef)) continue;
      const companions = companionsByRef.get(fileRef);
      let note;
      if (installedFiles.has(f.name)) {
        note = 'installed — renders on this selection (explicitly included or already tracked)';
      } else if (companions) {
        note = `not installed — **pairs with selected ${companions.join(', ')}**; ask the user both/one/neither, then pour with \`install ${fileRef}\` if they want the automated half`;
      } else {
        note = 'not installed — opt-in only; leave out unless the user asks for it';
      }
      optInLines.push(`- \`${fileRef}\` (${name}) — ${note}`);
    }
  }
  if (optInLines.length) {
    lines.push('## Opt-in syrup (sensitive files — opt-in)', '', ...optInLines, '');
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
  const hasOptIn = [...toolkit.stacks.values()].some((s) => s.optIn.size);
  const lines = [
    `# Toolkit inventory — ${toolkit.name}${version ? ` v${version}` : ''}`,
    '',
    'Generated from the installed toolkit; authoritative for this version.',
    '',
    'A **waffle** is a single installable item — an agent or a skill. A **stack** is a named',
    'group of waffles; **syrup** is the generic `files/` payload type a stack can also carry.',
    'Install a whole stack by name (adds it to `stacks:`), or a single item by ref —',
    '`skills/<name>` or `agents/<name>` (adds it to `include:`). Stack-qualify an item as',
    '`<stack>/skills/<name>` when the same name appears in more than one stack. Installing',
    "an item pulls its dependency closure automatically (an agent's `skills:` and any declared",
    '`requires:`), so required config is scoped to what the selected items actually reference.',
    '',
  ];
  if (hasOptIn) {
    lines.push(
      'An **opt-in syrup** item (marked below) is a sensitive `files/` payload — e.g. a workflow',
      'that needs write permissions on the repo. It is NOT part of a stack default render: enabling',
      'the stack does **not** install it. It renders only when you install its ref explicitly',
      "(`install files/<path>`) or the repo already tracks it in `.waffle/waffle.lock.json`. **Do",
      'not install an opt-in syrup item unless the user explicitly asks for that specific file** —',
      'default to leaving it out.',
      '',
    );
  }
  for (const stack of toolkit.stacks.values()) {
    lines.push(`## stack: ${stack.name}`, '');
    if (stack.description) lines.push(stack.description, '');
    lines.push(`- skills: ${stack.skills.map((s) => `skills/${s.name}`).join(', ') || '(none)'}`);
    lines.push(`- agents: ${stack.agents.map((a) => `agents/${a.name}`).join(', ') || '(none)'}`);
    const isOptIn = (f) => stack.optIn.has(`files/${f.name}`);
    const plainFiles = stack.files.filter((f) => !isOptIn(f));
    const optInFiles = stack.files.filter(isOptIn);
    if (plainFiles.length) {
      lines.push(`- files: ${plainFiles.map((f) => `files/${f.name}`).join(', ')}`);
    }
    if (optInFiles.length) {
      lines.push(
        `- files (opt-in syrup — sensitive, do NOT install by default): ${optInFiles.map((f) => `files/${f.name}`).join(', ')}`,
      );
    }
    const env = Object.entries(stack.env);
    if (env.length) {
      lines.push(`- env prerequisites: ${env.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    lines.push('');
    lines.push(...configSection(stack.config));
    if (stack.setup) lines.push('### setup notes', '', stack.setup.trim(), '');
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
