import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { sha256, exists } from './util.mjs';
import { loadToolkit } from './toolkit.mjs';
import { computeSelection, itemOutputMatcher, fileMatchesTargets } from './refs.mjs';
import { readTreeLock } from './render.mjs';
import { loadProjectConfig, resolveConfigFile } from './project.mjs';

/**
 * `list` — one view of what the toolkit offers versus what this repo has, per stack, per waffle
 * (agent/skill) and per syrup file. The state model composes the same seams the renderer uses so
 * the report never drifts from the real install:
 *   - `loadToolkit`           — the available surface (every stack and its items)
 *   - `loadProjectConfig`     — the repo's selection intent
 *   - `computeSelection`      — the installed selection (opt-in syrup already gated out)
 *   - `readTreeLock`          — the rendered manifest OF THIS TREE (paths → sha256). The *tree*
 *                               lock, not the committed one: every hash below is compared against
 *                               a file on disk, and on a machine whose `.local` overlay feeds the
 *                               render those files are the effective render, not the canonical one
 *                               the committed lock describes (#317). Reading the canonical lock here
 *                               would report every overlay-touched item as `outdated`.
 *   - `itemOutputMatcher`     — maps an item to its lock paths (shared with `eject`)
 *   - doctor-style sha256     — per-item file drift
 *   - lock.toolkitVersion vs the invoked CLI — toolkit version skew
 *
 * Each item is classified `current` (installed and byte-matching the lock, no skew), `outdated`
 * (installed but drifted or version-skewed), `not-installed` (not in the selection),
 * `not-installable` (#364: a target-scoped syrup file none of whose targets this project enables —
 * it CANNOT render here, so it is reported, but never offered as a choice), or `pending-removal`
 * (#364: the same scoped-out file, but a previous render already POURED it — it is on disk and in
 * the lock right now, and the next `render` will DELETE it). Built-in surface only (like `setup`):
 * external `source:` stacks are not expanded — an enabled external name surfaces as a selection
 * error rather than an inventory row.
 *
 * `pending-removal` exists because `list` is the surface a user consults BEFORE re-rendering, and
 * the prune is the destructive operation in this feature. Reporting a file that is present on disk
 * as merely `not-installable` would be false — it IS installed — and it would hide an imminent
 * deletion behind a word that reads like "nothing to see here". A user must not learn about a
 * deletion only after it happens.
 */
export const STATUS = {
  CURRENT: 'current',
  OUTDATED: 'outdated',
  NOT_INSTALLED: 'not-installed',
  NOT_INSTALLABLE: 'not-installable',
  PENDING_REMOVAL: 'pending-removal',
};

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

  const lock = readTreeLock(cwd);
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
  const classify = (stackName, kind, name, item) => {
    const matcher = itemOutputMatcher(kind, name);
    const owned = Object.keys(lockFiles).filter(matcher);

    // #364: a target-scoped syrup file none of whose targets this project enables cannot render
    // here AT ALL — `computeSelection` gates it out of every entry path. So it is not merely "not
    // installed" (which reads as *pourable*, and which the picker would offer as a checkbox):
    // it is NOT INSTALLABLE, and installing it would persist an `include:` that renders nothing
    // and re-warns on every future render. Same call the setup playbook makes, so the two
    // discovery surfaces agree. Checked BEFORE the selection lookup — a scoped-out file is absent
    // from the selection, so the NOT_INSTALLED branch would otherwise swallow it.
    //
    // But "cannot be installed" and "is not here" are different claims, and conflating them is how
    // `list` came to hide a DELETION. A file poured under an old `targets:` is still on disk and
    // still in the lock; the render prunes every lock path it no longer produces, so the next
    // `render` DELETES it. Editing `targets:` and running `list` to see what it did is the obvious
    // move, and `list` is documented as agent-parseable — so if the lock paths this item owns are
    // still present, say PENDING REMOVAL, not "not installable". The prune is the dangerous
    // operation in this feature and this is the only discovery surface consulted before it fires.
    //
    // `project` is null for an unconfigured or malformed-config repo; there is no target set to
    // judge against, so every item stays NOT_INSTALLED exactly as before.
    if (project && item && !fileMatchesTargets(item, project.targets)) {
      const live = owned.filter((rel) => exists(path.join(cwd, rel)));
      // "On disk" is NOT sufficient to claim a deletion, and claiming one wrongly is the very defect
      // PENDING_REMOVAL was added to fix — so it is held to its own bar. `owned` matches the lock by
      // PATH (`itemOutputMatcher('files', name)` is `rel === name`), which is stack-BLIND, and two
      // stacks may legally declare the same output path (an error only when both are ENABLED). So a
      // row in a stack that is not even in play can "own" a lock path another, enabled stack
      // actually produces — and announcing PENDING REMOVAL for it would be a lie about a file the
      // render KEEPS.
      //
      // Ask `render`'s own prune question instead of a bare existence check: the prune deletes a
      // live lock path that NO SELECTED ITEM produces. If something in the selection still produces
      // this path, nothing is being deleted — the row is merely not installable here.
      //
      // Deliberately scoped to THIS branch. The mirror-image gap on the NOT_INSTALLED path (a
      // deselected stack's poured file IS pruned, and `list` still calls it "not-installed") is the
      // same stack-blind root cause but a different defect — a hidden deletion, not an invented one
      // — and it needs the offerability split and target fan-out that #371 carries. This does not
      // pre-empt that work; it stops the status THIS PR adds from making a false claim.
      const pruned = live.some(
        (rel) => !selection.items.some((sel) => itemOutputMatcher(sel.kind, sel.item.name)(rel)),
      );
      return pruned ? STATUS.PENDING_REMOVAL : STATUS.NOT_INSTALLABLE;
    }
    if (!selectedKeys.has(`${stackName}::${kind}/${name}`)) return STATUS.NOT_INSTALLED;
    if (!owned.length) return STATUS.OUTDATED; // selected but never rendered (no lock entry yet)
    for (const rel of owned) {
      const abs = path.join(cwd, rel);
      if (!exists(abs) || sha256(fs.readFileSync(abs)) !== lockFiles[rel]) return STATUS.OUTDATED;
    }
    return versionSkew ? STATUS.OUTDATED : STATUS.CURRENT;
  };

  const counts = {
    [STATUS.CURRENT]: 0,
    [STATUS.OUTDATED]: 0,
    [STATUS.NOT_INSTALLED]: 0,
    [STATUS.NOT_INSTALLABLE]: 0,
    [STATUS.PENDING_REMOVAL]: 0,
  };
  const addRow = (rows, stackName, kind, name, optIn = false, item = null) => {
    const status = classify(stackName, kind, name, item);
    counts[status] += 1;
    // #364: `targets` rides along on the row so the table can SAY which harnesses the file is
    // scoped to, rather than just refusing it.
    rows.push({ kind, name, ref: `${kind}/${name}`, status, optIn, targets: item?.targets ?? null });
  };

  const stacks = [];
  for (const stack of toolkit.stacks.values()) {
    const rows = [];
    for (const a of stack.agents) addRow(rows, stack.name, 'agents', a.name);
    for (const s of stack.skills) addRow(rows, stack.name, 'skills', s.name);
    for (const f of stack.files) addRow(rows, stack.name, 'files', f.name, stack.optIn.has(`files/${f.name}`), f);
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

// Every label stays no longer than `installed & current`, which sets STATUS_WIDTH: a longer one
// would widen the status column for EVERY project, including the ones with no scoped syrup at all.
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
  // Not dim: this row is the only one announcing an imminent DELETION. It is a warning, not a
  // shrug, and it must not read as quiet background state.
  [STATUS.PENDING_REMOVAL]: ANSI.yellow,
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
      // #364: a scoped-out row names the scope that excludes it, so the reader sees WHY it is
      // refused (and what to enable to get it) rather than just that it is.
      const scopedOut = row.status === STATUS.NOT_INSTALLABLE || row.status === STATUS.PENDING_REMOVAL;
      const scope =
        scopedOut && row.targets
          ? `  ${paint(`(scoped to targets [${row.targets.join(', ')}])`, ANSI.cyan)}`
          : '';
      // …and a PENDING REMOVAL row spells out the consequence, because the status word alone cannot
      // convey that the file is on disk RIGHT NOW and that a render is what destroys it.
      const doomed =
        row.status === STATUS.PENDING_REMOVAL
          ? `  ${paint('— installed here; the next `render` DELETES it', ANSI.yellow)}`
          : '';
      lines.push(`  ${status}  ${row.ref}${tag}${scope}${doomed}`);
    }
    lines.push('');
  }

  const c = model.counts;
  // Each tail is appended only when there IS one, so a project with no target-scoped syrup (every
  // project today — no shipped stack declares `targets:`) prints the summary unchanged.
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
 * The actionable rows for the interactive picker: everything not already `current` (nothing to do
 * for a current item) and not scoped out — neither `not-installable` nor `pending-removal`, since
 * nothing the picker can DO changes either one. A `not-installed` item toggled on is installed; an
 * `outdated` one is refreshed — the latter is pre-checked, since applying re-renders anyway.
 * `installRef` is the stack-qualified ref handed to `installRefs`, which canonicalises it (dropping
 * the qualifier when the name is unambiguous). Pure and side-effect-free, so it is unit-tested
 * directly.
 *
 * #364: a target-scoped syrup file this project cannot render is NOT a choice. `installRefs` would
 * happily persist `include: [files/…]` for it — a permanent entry that renders nothing and re-emits
 * the target-skip warning on every future render. The picker is the surface most literally about
 * "a choice the user could make", so it is the one that must not offer a non-choice. That holds for
 * `pending-removal` too, and MORE so: the file is on disk, but the only thing that would keep it
 * there is enabling one of its targets in the config — installing it via the picker would persist an
 * `include:` that still renders nothing, and the file would be pruned anyway.
 */
export function selectableChoices(model) {
  const choices = [];
  for (const stack of model.stacks) {
    for (const row of stack.rows) {
      if (row.status === STATUS.CURRENT) continue;
      if (row.status === STATUS.NOT_INSTALLABLE) continue;
      if (row.status === STATUS.PENDING_REMOVAL) continue;
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
