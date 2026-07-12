import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit, missingRequiredKeys } from './toolkit.mjs';
import { exists, lookupPath } from './util.mjs';
import { loadProjectConfig, makeResolver, resolveConfigFile } from './project.mjs';
import { computeSelection, skippedSyrupCompanions } from './refs.mjs';
import { readTreeLock, collectUsedKeys } from './render.mjs';
import {
  applicablePrerequisites,
  evaluatePrerequisites,
  formatPrereq,
  PREREQ_KINDS,
} from './prerequisites.mjs';

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

  // The TREE lock (#317): `trackedFiles` answers "what is already installed in this working copy",
  // which on a machine whose `.local` overlay shapes the render is the effective render, not the
  // canonical one the committed lock describes.
  const trackedFiles = new Set(Object.keys(readTreeLock(cwd)?.files ?? {}));
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

  // External stack sources (#88): a `{ name, source, ref }` entry pulls a stack from a git URL
  // (pinned by `ref`) or a local path; `render` resolves and merges it with the built-in stacks.
  // The inventory below is the built-in surface — external stacks resolve at render time.
  if (project.externalStacks?.length) {
    lines.push('## External stack sources', '');
    for (const s of project.externalStacks) {
      lines.push(`- ${s.name} ← ${s.source}${s.ref ? ` @ ${s.ref}` : ''} (${s.sourceType})`);
    }
    lines.push(
      '',
      '> These resolve and render at `render` time — git sources are fetched at the pinned `ref`,',
      '> local paths are read in place. A name that collides with a built-in stack or another',
      '> source is a hard error, not a silent shadow.',
      '',
      '> **Trust boundary — external content (#126).** These stacks are authored OUTSIDE this repo,',
      '> so `render` enforces two extra gates at install time. (1) It lints each external stack\'s',
      '> definitions and BLOCKS the render on a malformed one (bad frontmatter, undeclared',
      '> placeholder, dangling `requires:`), naming the source. (2) Any **opt-in syrup** an external',
      '> source carries (e.g. a workflow demanding repo write) needs an **explicit, separate',
      '> acknowledgement from the user, beyond the normal opt-in and the both/one/neither question**',
      '> in step 2 — the content is third-party. Name the source and its pinned `ref`, note it may',
      '> demand elevated permissions, and get a clear yes before you pour it; `render` also prints',
      '> this as a warning when such syrup is selected.',
      '',
    );
  }

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
  // drag in its stack's siblings) — matching render's per-stack grouping, and carrying the
  // selected items so config can be scoped to the keys they reference.
  const groups = new Map();
  for (const { stackName, stack, kind, item } of selection.items) {
    if (!groups.has(stackName)) groups.set(stackName, { stack, items: [] });
    groups.get(stackName).items.push({ kind, item });
  }
  // Scope each stack's config surface to the keys its *selected* items actually reference —
  // exactly what the renderer does (`collectUsedKeys`). A partial stack selection (one skill
  // of many) must not surface config only its unselected siblings use (#77).
  for (const g of groups.values()) g.usedKeys = collectUsedKeys(g.items);

  const valueLines = [];
  for (const [stackName, { stack, usedKeys }] of groups) {
    const entries = Object.entries(stack.config).filter(([key]) => usedKeys.has(key));
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
      'Every config key the selected items actually reference, with its effective value —',
      'scoped like the render (a partial stack selection shows only the keys it uses). `set`',
      'means the value comes from your `.waffle/waffle.yaml` (or the `.local` overlay);',
      "`default` means the stack's built-in is in force — re-check each default against the",
      'project before accepting it (step 3). ⚠ marks a required key with no value.',
      '',
      ...valueLines,
    );
  }

  // Required keys with no resolved value — the render blockers, collected across stacks.
  // Computed exactly as render does: scoped to the selected items' `usedKeys` and resolved
  // through `makeResolver` (default-aware), so setup reports only the blockers render will
  // actually enforce — not every required key of a partially-selected stack (#77).
  const missing = [];
  for (const [stackName, { stack, usedKeys }] of groups) {
    const resolve = makeResolver(stack, project.values, primaryTarget);
    for (const key of missingRequiredKeys(stack, project.values, (_values, k) => resolve(k), usedKeys)) {
      missing.push(`${stackName}: config.${key}`);
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

  // Typed external prerequisites (#129/#130): run the applicable stacks' checks the way `doctor`
  // does and flag any unmet **require** as a blocker for THIS repo — the update-mode analog of
  // doctor's gate, surfaced for the human (the postinstall-prompt analog of #47), mirroring the
  // unset-required-config and skipped-syrup flags above. Unmet `recommend` entries only report.
  // Anything that creates or mutates shared external state (a secret, a label, a repo setting, a
  // service) still needs the user's explicit go-ahead — the toolkit checks and prompts, it never
  // provisions unasked.
  const { unmetRequired: unmetReqPrereqs, unmetRecommended: unmetRecPrereqs } = evaluatePrerequisites(
    applicablePrerequisites(toolkit, selection),
    cwd,
  );
  if (unmetReqPrereqs.length) {
    lines.push(
      '## Prerequisites unmet (require — blockers)',
      '',
      'These `require` prerequisites of the selected stacks are unmet in this repo — `doctor` fails',
      'on them too. Resolve each before relying on the flow. Anything that creates or mutates shared',
      'external state (a secret, a label, a repo setting, a service) needs the user\'s explicit',
      'go-ahead first — surface the exact command and wait for a clear yes; never provision unasked.',
      '',
      ...unmetReqPrereqs.map((p) => `- ⚠ ${formatPrereq(p)}`),
      '',
    );
  }
  if (unmetRecPrereqs.length) {
    lines.push(
      '## Prerequisites unmet (recommend — report-only)',
      '',
      ...unmetRecPrereqs.map((p) => `- ${formatPrereq(p)}`),
      '',
    );
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
    lines.push(...prerequisitesSection(stack.prerequisites));
    lines.push(...configSection(stack.config));
    if (stack.setup) lines.push('### setup notes', '', stack.setup.trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The stack's typed external prerequisites (#47/#129), grouped by kind for the inventory — the
 * human-facing surface (#130) of the block `render` warns on and `doctor` gates. Each line names
 * the thing, its `require`/`recommend` level, any item scope, and the deterministic check, so the
 * setup agent can walk step 4 of the playbook kind by kind. Returns [] when a stack declares none,
 * so a prerequisite-free stack's inventory is byte-unchanged.
 */
function prerequisitesSection(prerequisites) {
  if (!prerequisites?.length) return [];
  const byKind = new Map();
  for (const p of prerequisites) {
    const k = p.kind || 'other';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(p);
  }
  // Canonical kind order first, then any leftover kind (a malformed one `validate` already flags).
  const kinds = [
    ...PREREQ_KINDS.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !PREREQ_KINDS.includes(k)),
  ];
  const lines = [
    '### prerequisites',
    '',
    'External things this stack needs that the copy-in install can neither provide nor verify,',
    'grouped by kind. `[require]` blocks a clean `doctor`; `[recommend]` only reports. Walk these in',
    "step 4 — and get the user's explicit go-ahead before creating or mutating any shared state (a",
    'repo secret, a trigger label, a repo setting, an external service).',
    '',
  ];
  for (const kind of kinds) {
    lines.push(`- **${kind}**`);
    for (const p of byKind.get(kind)) {
      const scope = p.items?.length ? ` (needed by ${p.items.join(', ')})` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      const check = p.check ? ` — check: \`${p.check}\`` : '';
      lines.push(`  - \`${p.name}\` [${p.level}]${scope}${desc}${check}`);
    }
  }
  lines.push('');
  return lines;
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
