import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { sha256, exists } from './util.mjs';
import { loadToolkit } from './toolkit.mjs';
import { computeSelection, itemOutputMatcher } from './refs.mjs';
import { readLock } from './render.mjs';
import { loadProjectConfig, resolveConfigFile } from './project.mjs';

/**
 * `list` — one view of what the toolkit offers versus what this repo has, per stack, per waffle
 * (agent/skill) and per syrup file. The state model composes the same seams the renderer uses so
 * the report never drifts from the real install:
 *   - `loadToolkit`           — the available surface (every stack and its items)
 *   - `loadProjectConfig`     — the repo's selection intent
 *   - `computeSelection`      — the installed selection (opt-in syrup already gated out)
 *   - `readLock`              — the rendered manifest (paths → sha256)
 *   - `itemOutputMatcher`     — maps an item to its lock paths (shared with `eject`)
 *   - doctor-style sha256     — per-item file drift
 *   - lock.toolkitVersion vs the invoked CLI — toolkit version skew
 *
 * Each item is classified `current` (installed and byte-matching the lock, no skew), `outdated`
 * (installed but drifted or version-skewed), or `not-installed` (not in the selection). Built-in
 * surface only (like `setup`): external `source:` stacks are not expanded — an enabled external
 * name surfaces as a selection error rather than an inventory row.
 */
export const STATUS = { CURRENT: 'current', OUTDATED: 'outdated', NOT_INSTALLED: 'not-installed' };

export function computeListModel({ toolkitRoot, cwd, toolkitVersion }) {
  const toolkit = loadToolkit(toolkitRoot);

  const notes = [];
  let project = null;
  let configError = null;
  // An unconfigured repo (no .waffle/waffle.yaml) is not an error — it just means nothing is
  // installed, so every item lists as not-installed against the full available surface. A config
  // that exists but cannot be parsed IS surfaced, and the inventory still renders (all
  // not-installed) so the human sees what the toolkit offers while they fix it.
  const hasConfig = exists(resolveConfigFile(cwd).file);
  if (hasConfig) {
    try {
      project = loadProjectConfig(cwd, notes);
    } catch (err) {
      configError = err.message;
    }
  }

  const lock = readLock(cwd);
  const lockFiles = lock?.files ?? {};
  const trackedFiles = new Set(Object.keys(lockFiles));
  const lockVersion = lock?.toolkitVersion ?? null;
  // Version skew is global: when the tree was rendered by a different toolkit version, every
  // installed item is out of date (a re-render/upgrade is due), even if its bytes still match.
  const versionSkew = Boolean(lock && lockVersion && toolkitVersion && lockVersion !== toolkitVersion);

  const selection = project
    ? computeSelection(toolkit, project, trackedFiles)
    : { items: [], closures: [], errors: [] };
  const selectedKeys = new Set(selection.items.map((i) => `${i.stackName}::${i.kind}/${i.item.name}`));
  const enabledStacks = new Set(project?.stacks ?? []);

  // Per-item drift against the lock, doctor-style: an installed item is outdated if any lock path
  // it owns is absent on disk or its sha256 no longer matches, or if the whole tree is skewed.
  const classify = (stackName, kind, name) => {
    if (!selectedKeys.has(`${stackName}::${kind}/${name}`)) return STATUS.NOT_INSTALLED;
    const matcher = itemOutputMatcher(kind, name);
    const owned = Object.keys(lockFiles).filter(matcher);
    if (!owned.length) return STATUS.OUTDATED; // selected but never rendered (no lock entry yet)
    for (const rel of owned) {
      const abs = path.join(cwd, rel);
      if (!exists(abs) || sha256(fs.readFileSync(abs)) !== lockFiles[rel]) return STATUS.OUTDATED;
    }
    return versionSkew ? STATUS.OUTDATED : STATUS.CURRENT;
  };

  const counts = { [STATUS.CURRENT]: 0, [STATUS.OUTDATED]: 0, [STATUS.NOT_INSTALLED]: 0 };
  const addRow = (rows, stackName, kind, name, optIn = false) => {
    const status = classify(stackName, kind, name);
    counts[status] += 1;
    rows.push({ kind, name, ref: `${kind}/${name}`, status, optIn });
  };

  const stacks = [];
  for (const stack of toolkit.stacks.values()) {
    const rows = [];
    for (const a of stack.agents) addRow(rows, stack.name, 'agents', a.name);
    for (const s of stack.skills) addRow(rows, stack.name, 'skills', s.name);
    for (const f of stack.files) addRow(rows, stack.name, 'files', f.name, stack.optIn.has(`files/${f.name}`));
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

// ── Plain table renderer ────────────────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

const STATUS_LABEL = {
  [STATUS.CURRENT]: 'installed & current',
  [STATUS.OUTDATED]: 'out of date',
  [STATUS.NOT_INSTALLED]: 'not installed',
};
const STATUS_COLOR = {
  [STATUS.CURRENT]: ANSI.green,
  [STATUS.OUTDATED]: ANSI.yellow,
  [STATUS.NOT_INSTALLED]: ANSI.dim,
};
const STATUS_WIDTH = Math.max(...Object.values(STATUS_LABEL).map((s) => s.length)); // 'installed & current'

/**
 * Render the state model as a plain, aligned, agent-parseable table (the default, non-interactive
 * output — safe for CI, pipes and non-TTY agents). `color` gates ANSI: the caller passes false for
 * a non-TTY / NO_COLOR / --no-color context, so the words alone carry the status. Status is the
 * fixed-width leading column (bounded), the variable ref trails, so long syrup paths never misalign
 * the table. Returns a string ending in a trailing newline.
 */
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
      lines.push(`  ${status}  ${row.ref}${tag}`);
    }
    lines.push('');
  }

  const c = model.counts;
  lines.push(
    paint(
      `summary: ${c[STATUS.CURRENT]} current, ${c[STATUS.OUTDATED]} out of date, ${c[STATUS.NOT_INSTALLED]} not installed`,
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
 * The actionable rows for the interactive picker: everything not already `current` (nothing to do
 * for a current item). A `not-installed` item toggled on is installed; an `outdated` one is
 * refreshed — the latter is pre-checked, since applying re-renders anyway. `installRef` is the
 * stack-qualified ref handed to `installRefs`, which canonicalises it (dropping the qualifier when
 * the name is unambiguous). Pure and side-effect-free, so it is unit-tested directly.
 */
export function selectableChoices(model) {
  const choices = [];
  for (const stack of model.stacks) {
    for (const row of stack.rows) {
      if (row.status === STATUS.CURRENT) continue;
      choices.push({
        stack: stack.name,
        ref: row.ref,
        installRef: `${stack.name}/${row.ref}`,
        status: row.status,
        optIn: row.optIn,
        checked: row.status === STATUS.OUTDATED,
      });
    }
  }
  return choices;
}

/**
 * Drive the keypress multi-select (space toggles, enter applies, esc/q/Ctrl-C cancels, `a` toggles
 * all). Hand-rolled on `node:readline` + ANSI — no prompt dependency, matching the toolkit's
 * lean, `yaml`-only surface. Resolves `{ applied, refs, reason? }`: `applied:true` with the chosen
 * `installRef`s to hand to `installRefs`, or `applied:false` on cancel. TTY-guarded by the CALLER —
 * this is never reached in a non-TTY context, so it can never block CI/agents.
 *
 * The redraw assumes the list fits the viewport (in-place move-up + clear-to-end); a longer list
 * than the terminal height would scroll imperfectly — acceptable for the toolkit's modest surface.
 */
export function interactiveSelect(model, { input = process.stdin, output = process.stdout } = {}) {
  const choices = selectableChoices(model);
  return new Promise((resolve) => {
    if (!choices.length) {
      resolve({ applied: false, refs: [], reason: 'everything is installed & current — nothing to install or update' });
      return;
    }

    let cursor = 0;
    let drawn = 0;

    const draw = () => {
      const rows = [
        `${ANSI.bold}Select waffles to install or update${ANSI.reset}  ${ANSI.dim}(↑/↓ move · space toggle · a all · enter apply · esc cancel)${ANSI.reset}`,
      ];
      choices.forEach((c, i) => {
        const pointer = i === cursor ? '›' : ' ';
        const box = c.checked ? '◉' : '○';
        const action = c.status === STATUS.OUTDATED ? `${ANSI.yellow}update${ANSI.reset}` : `${ANSI.dim}install${ANSI.reset}`;
        const tag = c.optIn ? ` ${ANSI.cyan}(opt-in syrup)${ANSI.reset}` : '';
        rows.push(`${pointer} ${box} ${c.stack} › ${c.ref}  [${action}]${tag}`);
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
        finish({ applied: true, refs: choices.filter((c) => c.checked).map((c) => c.installRef) });
        return;
      } else if (name === 'escape' || str === 'q' || (key?.ctrl && name === 'c')) {
        finish({ applied: false, refs: [] });
        return;
      }
      draw();
    };

    input.resume();
    input.on('keypress', onKey);
    draw();
  });
}
