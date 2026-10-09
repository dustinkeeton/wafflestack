import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { sha256, exists } from './util.mjs';
import { loadToolkit } from './toolkit.mjs';
import { computeSelection, itemOutputMatcher, fileMatchesTargets, closureFor, modOutputDir } from './refs.mjs';
import { readTreeLock, missingConfigFor, summarizeConfigKeys, collectUsedKeys } from './render.mjs';
import { loadProjectConfig, resolveConfigFile } from './project.mjs';

/** What the toolkit offers versus what this repo has — classified against the TREE lock, never the committed one (#317). */
export const STATUS = {
  CURRENT: 'current',
  OUTDATED: 'outdated',
  NOT_INSTALLED: 'not-installed',
  NOT_INSTALLABLE: 'not-installable',
  PENDING_REMOVAL: 'pending-removal',
};

/**
 * WHY a `pending-removal` row is doomed (#371) — it decides whether the picker may offer it.
 * `scope`: its `targets:` are all disabled, so installing it persists an `include:` that renders
 * nothing (never offered). `deselected`: its stack was disabled or its include dropped — installing
 * it renders, so it is the remedy (offered).
 */
export const REMOVAL_REASON = {
  SCOPE: 'scope',
  DESELECTED: 'deselected',
};

export function computeListModel({ toolkitRoot, cwd, toolkitVersion }) {
  const toolkit = loadToolkit(toolkitRoot);

  const notes = [];
  let project = null;
  let configError = null;
  const hasConfig = exists(resolveConfigFile(cwd).file);
  if (hasConfig) {
    try {
      project = loadProjectConfig(cwd, notes);
    } catch (err) {
      configError = err.message;
    }
  }

  const lock = readTreeLock(cwd);
  const lockFiles = lock?.files ?? {};
  const trackedFiles = new Set(Object.keys(lockFiles));
  const lockVersion = lock?.toolkitVersion ?? null;
  const versionSkew = Boolean(lock && lockVersion && toolkitVersion && lockVersion !== toolkitVersion);

  const selection = project
    ? computeSelection(toolkit, project, trackedFiles)
    : { items: [], closures: [], errors: [] };
  const selectedKeys = new Set(selection.items.map((i) => `${i.stackName}::${i.kind}/${i.item.name}`));
  const enabledStacks = new Set(project?.stacks ?? []);

  // `render`'s own prune question, asked selection-WIDE: is a live lock path produced by ANY selected
  // item? `owned` below matches stack-blind, so "this row is deselected" alone would announce the
  // deletion of a path another enabled stack keeps (#371). Target-blind on purpose: a selected agent
  // still "owns" a disabled target's path, so a fan-out prune is UNDER-reported, never invented.
  const producedBySelection = (rel) =>
    selection.items.some((sel) => itemOutputMatcher(sel.kind, sel.item.name)(rel));
  // A render with a selection error refuses before it prunes, so nothing is doomed until it is fixed.
  const canPrune = Boolean(project) && !selection.errors.length;
  const doomed = (owned) =>
    canPrune && owned.some((rel) => exists(path.join(cwd, rel)) && !producedBySelection(rel));

  const classify = (stackName, kind, name, item) => {
    const owned = Object.keys(lockFiles).filter(itemOutputMatcher(kind, name));

    // Checked BEFORE the selection lookup: a scoped-out file is absent from the selection, so the
    // NOT_INSTALLED branch below would otherwise swallow it (#364).
    if (project && item && !fileMatchesTargets(item, project.targets)) {
      return doomed(owned)
        ? { status: STATUS.PENDING_REMOVAL, removalReason: REMOVAL_REASON.SCOPE }
        : { status: STATUS.NOT_INSTALLABLE, removalReason: null };
    }
    if (!selectedKeys.has(`${stackName}::${kind}/${name}`)) {
      return doomed(owned)
        ? { status: STATUS.PENDING_REMOVAL, removalReason: REMOVAL_REASON.DESELECTED }
        : { status: STATUS.NOT_INSTALLED, removalReason: null };
    }
    if (!owned.length) return { status: STATUS.OUTDATED, removalReason: null }; // selected but never rendered
    for (const rel of owned) {
      const abs = path.join(cwd, rel);
      if (!exists(abs) || sha256(fs.readFileSync(abs)) !== lockFiles[rel]) return { status: STATUS.OUTDATED, removalReason: null };
    }
    return { status: versionSkew ? STATUS.OUTDATED : STATUS.CURRENT, removalReason: null };
  };

  const counts = {
    [STATUS.CURRENT]: 0,
    [STATUS.OUTDATED]: 0,
    [STATUS.NOT_INSTALLED]: 0,
    [STATUS.NOT_INSTALLABLE]: 0,
    [STATUS.PENDING_REMOVAL]: 0,
  };
  // Only a row the picker would ADD can be blocked; a selected row's failure is the render's own error.
  const blockersFor = (stackName, kind, name, item, status) => {
    if (!project || selection.errors.length) return null;
    if (status !== STATUS.NOT_INSTALLED && status !== STATUS.PENDING_REMOVAL) return null;
    const nodes = closureForSafe(toolkit, { stack: stackName, kind, name, item });
    const config = missingConfigFor(toolkit, project, nodes);
    const unmanaged = nodes.flatMap((n) => unmanagedOutputs(cwd, n, project.targets, trackedFiles));
    return config.length || unmanaged.length ? { config, unmanaged } : null;
  };
  const addRow = (rows, stackName, kind, name, optIn = false, item = null) => {
    const { status, removalReason } = classify(stackName, kind, name, item);
    counts[status] += 1;
    const blockers = item ? blockersFor(stackName, kind, name, item, status) : null;
    rows.push({ kind, name, ref: `${kind}/${name}`, status, removalReason, optIn, targets: item?.targets ?? null, blockers });
  };

  const stacks = [];
  for (const stack of toolkit.stacks.values()) {
    const rows = [];
    for (const a of stack.agents) addRow(rows, stack.name, 'agents', a.name, false, a);
    for (const s of stack.skills) addRow(rows, stack.name, 'skills', s.name, false, s);
    for (const f of stack.files) addRow(rows, stack.name, 'files', f.name, stack.optIn.has(`files/${f.name}`), f);
    for (const m of stack.mods) addRow(rows, stack.name, 'mods', m.name, stack.optIn.has(`mods/${m.name}`), m);
    stacks.push({ name: stack.name, description: stack.description, enabled: enabledStacks.has(stack.name), rows });
  }

  return {
    toolkitName: toolkit.name,
    toolkitVersion,
    lockVersion,
    hasLock: Boolean(lock),
    hasConfig,
    versionSkew,
    configError,
    notes,
    errors: selection.errors,
    stacks,
    counts,
  };
}

/** A closure the toolkit cannot resolve is `validate`'s to report — the row then just carries no blockers. */
function closureForSafe(toolkit, root) {
  try {
    return closureFor(toolkit, root);
  } catch {
    return [root];
  }
}

/**
 * The paths an item would write that already hold a file the lock does not track (#549) — `render`
 * refuses those without `--force`. A verbatim payload whose bytes already match is adopted, so it
 * is not reported; a templated one cannot be compared without rendering, so it is.
 */
export function unmanagedOutputs(cwd, node, targets, trackedFiles) {
  /** @type {{ rel: string, source: string | null }[]} */
  const candidates = [];
  const { kind, name, item } = node;
  if (kind === 'agents') {
    if (targets.includes('claude')) candidates.push({ rel: path.join('.claude', 'agents', `${name}.md`), source: null });
    if (targets.includes('codex')) candidates.push({ rel: path.join('.codex', 'agents', `${name}.toml`), source: null });
  } else if (kind === 'skills') {
    const dirs = new Set();
    if (targets.includes('claude')) dirs.add(path.join('.claude', 'skills', name));
    if (targets.includes('agents-dir') || targets.includes('codex')) dirs.add(path.join('.agents', 'skills', name));
    for (const dir of dirs) for (const rel of item.files) candidates.push({ rel: path.join(dir, rel), source: null });
  } else if (kind === 'files') {
    if (!fileMatchesTargets(item, targets)) return [];
    const verbatim = item.binary || !collectUsedKeys([{ kind, item }]).size;
    candidates.push({ rel: name, source: verbatim ? item.path : null });
  } else if (kind === 'mods') {
    if (!targets.includes('claude')) return [];
    for (const rel of item.files) candidates.push({ rel: path.join(modOutputDir(name), rel), source: path.join(item.dir, rel) });
  }
  return candidates
    .filter(({ rel, source }) => {
      if (trackedFiles.has(rel)) return false;
      const abs = path.join(cwd, rel);
      if (!exists(abs) || !fs.statSync(abs).isFile()) return false;
      return !(source && sha256(fs.readFileSync(abs)) === sha256(fs.readFileSync(source)));
    })
    .map(({ rel }) => rel);
}

/** One short phrase per blocker class, e.g. `needs config.arch.*` · `unmanaged file at X (needs --force)`. */
export function describeBlockers(blockers) {
  if (!blockers) return [];
  const out = [];
  if (blockers.config.length) out.push(`needs ${summarizeConfigKeys(blockers.config)}`);
  const [first, ...more] = blockers.unmanaged;
  if (first) out.push(`unmanaged file at ${first}${more.length ? ` (+${more.length} more)` : ''} (needs --force)`);
  return out;
}

// ── Plain table renderer ────────────────────────────────────────────────────────────────────

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

// Keep every label within `installed & current`: a longer one widens the status column for EVERY project.
const STATUS_LABEL = {
  [STATUS.CURRENT]: 'installed & current',
  [STATUS.OUTDATED]: 'out of date',
  [STATUS.NOT_INSTALLED]: 'not installed',
  [STATUS.NOT_INSTALLABLE]: 'not installable',
  [STATUS.PENDING_REMOVAL]: 'PENDING REMOVAL',
};
const STATUS_COLOR = {
  [STATUS.CURRENT]: ANSI.green,
  [STATUS.OUTDATED]: ANSI.yellow,
  [STATUS.NOT_INSTALLED]: ANSI.dim,
  [STATUS.NOT_INSTALLABLE]: ANSI.dim,
  [STATUS.PENDING_REMOVAL]: ANSI.yellow,
};
const STATUS_WIDTH = Math.max(...Object.values(STATUS_LABEL).map((s) => s.length)); // 'installed & current'

/** Render the state model as a plain, aligned, agent-parseable table; `color` gates ANSI. Ends in a newline. */
export function formatListTable(model, { color = false } = {}) {
  const paint = (s, code) => (color ? `${code}${s}${ANSI.reset}` : s);
  const lines = [];

  lines.push(paint(`wafflestack list — ${model.toolkitName} v${model.toolkitVersion}`, ANSI.bold));
  lines.push(lockLine(model, paint));
  lines.push('');

  if (model.configError) {
    lines.push(paint(`config error: ${model.configError}`, ANSI.yellow));
    lines.push('The inventory below shows the full toolkit surface; fix the config, then re-run.');
    lines.push('');
  } else if (!model.hasConfig) {
    lines.push(paint('this repo is not configured — nothing installed', ANSI.dim));
    lines.push('Run `wafflestack init`, pick stacks, then `wafflestack install` (or `render`).');
    lines.push('');
  }
  for (const note of model.notes) lines.push(paint(`note: ${note}`, ANSI.dim));
  for (const err of model.errors) lines.push(paint(`selection problem: ${err}`, ANSI.yellow));
  if (model.notes.length || model.errors.length) lines.push('');

  for (const stack of model.stacks) {
    const state = stack.enabled ? paint('[enabled]', ANSI.green) : paint('[available]', ANSI.dim);
    const desc = stack.description ? `  ${paint(stack.description, ANSI.dim)}` : '';
    lines.push(`${paint(stack.name, ANSI.bold)}  ${state}${desc}`);
    if (!stack.rows.length) {
      lines.push(`  ${paint('(no items)', ANSI.dim)}`);
    }
    for (const row of stack.rows) {
      const label = STATUS_LABEL[row.status].padEnd(STATUS_WIDTH);
      const status = paint(label, STATUS_COLOR[row.status]);
      const tag = row.optIn ? `  ${paint('(opt-in syrup)', ANSI.cyan)}` : '';
      // The scope is named only when it is the REASON — a deselected file may carry an enabled scope.
      const scopedOut = row.status === STATUS.NOT_INSTALLABLE || row.removalReason === REMOVAL_REASON.SCOPE;
      const scope =
        scopedOut && row.targets
          ? `  ${paint(`(scoped to targets [${row.targets.join(', ')}])`, ANSI.cyan)}`
          : '';
      const doomed =
        row.status === STATUS.PENDING_REMOVAL
          ? `  ${paint(
              row.removalReason === REMOVAL_REASON.DESELECTED
                ? '— installed here but no longer selected; the next `render` DELETES it (install it to keep it)'
                : '— installed here; the next `render` DELETES it',
              ANSI.yellow,
            )}`
          : '';
      const blocked = describeBlockers(row.blockers);
      const blockers = blocked.length ? `  ${paint(`— ${blocked.join('; ')}`, ANSI.yellow)}` : '';
      lines.push(`  ${status}  ${row.ref}${tag}${scope}${doomed}${blockers}`);
    }
    lines.push('');
  }

  const c = model.counts;
  const scoped = c[STATUS.NOT_INSTALLABLE]
    ? `, ${c[STATUS.NOT_INSTALLABLE]} not installable here`
    : '';
  const doomed = c[STATUS.PENDING_REMOVAL]
    ? `, ${c[STATUS.PENDING_REMOVAL]} PENDING REMOVAL on the next render`
    : '';
  lines.push(
    paint(
      `summary: ${c[STATUS.CURRENT]} current, ${c[STATUS.OUTDATED]} out of date, ${c[STATUS.NOT_INSTALLED]} not installed${scoped}${doomed}`,
      ANSI.bold,
    ),
  );
  return `${lines.join('\n')}\n`;
}

/** One line describing the lock / version-skew state under the title. */
function lockLine(model, paint) {
  if (!model.hasLock) return paint('lock: none — this repo has not rendered yet', ANSI.dim);
  const rendered = model.lockVersion ?? 'unknown (pre-versioned lock)';
  if (model.versionSkew) {
    return paint(
      `lock: rendered by toolkit ${rendered}; CLI is ${model.toolkitVersion} — version skew, run \`wafflestack upgrade\``,
      ANSI.yellow,
    );
  }
  return paint(`lock: rendered by toolkit ${rendered}`, ANSI.dim);
}

// ── Interactive multi-select ────────────────────────────────────────────────────────────────

/**
 * The rows the picker can act on: everything not already `current` and not scoped out — nothing it
 * does changes those. A `pending-removal` row is offered iff it is merely deselected (#371):
 * re-installing it renders, whereas installing a scoped-out one persists a dead `include:`.
 */
export function selectableChoices(model) {
  const choices = [];
  for (const stack of model.stacks) {
    for (const row of stack.rows) {
      if (row.status === STATUS.CURRENT) continue;
      if (row.status === STATUS.NOT_INSTALLABLE) continue;
      if (row.status === STATUS.PENDING_REMOVAL && row.removalReason !== REMOVAL_REASON.DESELECTED) continue;
      choices.push({
        stack: stack.name,
        ref: row.ref,
        installRef: `${stack.name}/${row.ref}`,
        status: row.status,
        optIn: row.optIn,
        blockers: describeBlockers(row.blockers),
        checked: row.status === STATUS.OUTDATED,
      });
    }
  }
  return choices;
}

/** Drive the keypress multi-select, resolving `{ applied, refs, reason? }`. TTY-guarded by the CALLER — never reached non-TTY. */
export function interactiveSelect(model, { input = process.stdin, output = process.stdout } = {}) {
  const choices = selectableChoices(model);
  if (!choices.length) {
    return Promise.resolve({ applied: false, refs: [], reason: 'everything is installed & current — nothing to install or update' });
  }
  const label = (c) => {
    const action =
      c.status === STATUS.OUTDATED
        ? `${ANSI.yellow}update${ANSI.reset}`
        : c.status === STATUS.PENDING_REMOVAL
          ? `${ANSI.yellow}keep${ANSI.reset}`
          : `${ANSI.dim}install${ANSI.reset}`;
    const tag = c.optIn ? ` ${ANSI.cyan}(opt-in syrup)${ANSI.reset}` : '';
    const blocked = c.blockers.length ? ` ${ANSI.yellow}⚠ ${c.blockers.join('; ')}${ANSI.reset}` : '';
    return `${c.stack} › ${c.ref}  [${action}]${tag}${blocked}`;
  };
  return keypressMultiSelect({ title: 'Select waffles to install or update', choices, label, input, output }).then(
    (result) => ({ applied: result.applied, refs: result.checked.map((c) => c.installRef) }),
  );
}

/**
 * The shared keypress loop behind `list --interactive` and `toggle` (#476): ↑/↓ (or k/j) move,
 * space toggles `checked`, `a` flips all, enter resolves `{ applied: true, checked }`, esc/q/^C
 * resolves `{ applied: false, checked: [] }`. `choices[].checked` is mutated in place. TTY-guarded
 * by the CALLER — never reached non-TTY.
 */
export function keypressMultiSelect({ title, choices, label, input = process.stdin, output = process.stdout }) {
  return new Promise((resolve) => {
    let cursor = 0;
    let drawn = 0;

    const draw = () => {
      const rows = [
        `${ANSI.bold}${title}${ANSI.reset}  ${ANSI.dim}(↑/↓ move · space toggle · a all · enter apply · esc cancel)${ANSI.reset}`,
      ];
      choices.forEach((c, i) => {
        const pointer = i === cursor ? '›' : ' ';
        const box = c.checked ? '◉' : '○';
        rows.push(`${pointer} ${box} ${label(c)}`);
      });
      if (drawn) output.write(`\x1b[${drawn}A`); // move cursor back to the top of the previous draw
      output.write('\x1b[0J'); // clear from cursor to end of screen
      output.write(`${rows.join('\n')}\n`);
      drawn = rows.length;
    };

    readline.emitKeypressEvents(input);
    const wasRaw = Boolean(input.isRaw);
    if (input.isTTY) input.setRawMode(true);
    output.write(ANSI.hideCursor);

    const finish = (result) => {
      input.removeListener('keypress', onKey);
      if (input.isTTY) input.setRawMode(wasRaw);
      output.write(ANSI.showCursor);
      input.pause();
      resolve(result);
    };

    const onKey = (str, key = {}) => {
      const name = key?.name;
      if (name === 'up' || str === 'k') cursor = (cursor - 1 + choices.length) % choices.length;
      else if (name === 'down' || str === 'j') cursor = (cursor + 1) % choices.length;
      else if (name === 'space') choices[cursor].checked = !choices[cursor].checked;
      else if (str === 'a') {
        const allOn = choices.every((c) => c.checked);
        for (const c of choices) c.checked = !allOn;
      } else if (name === 'return' || name === 'enter') {
        finish({ applied: true, checked: choices.filter((c) => c.checked) });
        return;
      } else if (name === 'escape' || str === 'q' || (key?.ctrl && name === 'c')) {
        finish({ applied: false, checked: [] });
        return;
      }
      draw();
    };

    input.resume();
    input.on('keypress', onKey);
    draw();
  });
}
