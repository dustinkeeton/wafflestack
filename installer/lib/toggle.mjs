// @ts-check
// `wafflestack toggle` (#476): per-skill agent-invocation state, the table, the picker, and the
// `.waffle/waffle.yaml` write. Rendered skills only — externals are never tracked (#471).

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadToolkitWithSources } from './toolkit.mjs';
import { defaultSourceCacheDir } from './sources.mjs';
import { computeSelection } from './refs.mjs';
import { readTreeLock } from './render.mjs';
import { loadProjectConfig, resolveConfigFile, CONFIG_FILE } from './project.mjs';
import { ANSI, keypressMultiSelect } from './list.mjs';
import { CONFIG_PATH, overrideFor, sourceDisablesModelInvocation } from './model-invocation.mjs';

/**
 * @typedef {object} ToggleRow one rendered skill
 * @property {string} name
 * @property {string} stack
 * @property {boolean} sourceDisabled the SKILL.md's own `disable-model-invocation: true`
 * @property {boolean} disabled the effective state after the override
 * @property {boolean | null} override the config's verdict, `null` when the source decides
 *
 * @typedef {object} ToggleModel
 * @property {boolean} hasClaude whether the `claude` target is enabled (the only one with the key)
 * @property {ToggleRow[]} rows sorted by stack, then name
 * @property {{ disabled: string[], enabled: string[] }} carried override names no rendered skill matches
 * @property {string[]} errors selection problems (unresolvable refs, etc.)
 */

/**
 * @param {{ toolkitRoot: string, cwd: string }} opts
 * @returns {ToggleModel}
 */
export function computeToggleModel({ toolkitRoot, cwd }) {
  const project = loadProjectConfig(cwd, [], { canonical: true });
  const toolkit = loadToolkitWithSources({
    builtinRoot: toolkitRoot,
    externalStacks: project.externalStacks ?? [],
    cwd,
    cacheDir: defaultSourceCacheDir(),
  });
  const enabledStacks = [...project.stacks, ...(project.externalStacks ?? []).map((s) => s.name)];
  const trackedFiles = new Set(Object.keys(readTreeLock(cwd)?.files ?? {}));
  const selection = computeSelection(toolkit, { ...project, stacks: enabledStacks }, trackedFiles);

  /** @type {ToggleRow[]} */
  const rows = [];
  for (const sel of selection.items) {
    if (sel.kind !== 'skills') continue;
    const skill = /** @type {import('./toolkit.mjs').SkillItem} */ (sel.item);
    const sourceDisabled = sourceDisablesModelInvocation(fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8'));
    const override = overrideFor(project.modelInvocation, skill.name);
    rows.push({ name: skill.name, stack: sel.stackName, sourceDisabled, disabled: override ?? sourceDisabled, override });
  }
  rows.sort((a, b) => a.stack.localeCompare(b.stack) || a.name.localeCompare(b.name));

  const known = new Set(rows.map((r) => r.name));
  const carried = {
    disabled: project.modelInvocation.disabled.filter((n) => !known.has(n)),
    enabled: project.modelInvocation.enabled.filter((n) => !known.has(n)),
  };
  return { hasClaude: project.targets.includes('claude'), rows, carried, errors: selection.errors };
}

/**
 * The plain, agent-parseable table; `color` gates ANSI. Ends in a newline.
 *
 * @param {ToggleModel} model
 * @param {{ color?: boolean }} [opts]
 * @returns {string}
 */
export function formatToggleTable(model, { color = false } = {}) {
  /** @type {(s: string, code: string) => string} */
  const paint = (s, code) => (color ? `${code}${s}${ANSI.reset}` : s);
  const lines = [paint('wafflestack toggle — agent invocation per rendered skill', ANSI.bold)];
  if (!model.hasClaude) {
    lines.push(paint('note: no `claude` target is enabled — the override renders nothing (codex/agents-dir have no disable-model-invocation key)', ANSI.yellow));
  }
  for (const err of model.errors) lines.push(paint(`selection problem: ${err}`, ANSI.yellow));
  lines.push('');
  if (!model.rows.length) lines.push(paint('  (no skills rendered)', ANSI.dim));
  for (const row of model.rows) {
    const state = row.disabled ? paint('slash-only'.padEnd(15), ANSI.yellow) : paint('agent-invocable', ANSI.green);
    const why = row.override !== null ? paint('(override)', ANSI.cyan) : paint('(source)', ANSI.dim);
    lines.push(`  ${state}  ${row.stack} › ${row.name}  ${why}`);
  }
  const carried = [...model.carried.disabled, ...model.carried.enabled];
  if (carried.length) {
    lines.push('');
    lines.push(paint(`note: ${CONFIG_FILE} also names ${carried.join(', ')}, which no selected stack renders — kept, ignored`, ANSI.dim));
  }
  lines.push('');
  const on = model.rows.filter((r) => !r.disabled).length;
  lines.push(paint(`summary: ${on} agent-invocable, ${model.rows.length - on} slash-only`, ANSI.bold));
  lines.push(paint('non-interactive: wafflestack toggle --disable <skill> / --enable <skill> (repeatable), then it re-renders', ANSI.dim));
  return `${lines.join('\n')}\n`;
}

/**
 * The picker's rows: one per rendered skill, checked = agent-invocable. Pure.
 *
 * @param {ToggleModel} model
 */
export function toggleChoices(model) {
  return model.rows.map((r) => ({ name: r.name, stack: r.stack, sourceDisabled: r.sourceDisabled, checked: !r.disabled }));
}

/**
 * Drive the picker; resolves the FULL desired state, not a diff. TTY-guarded by the CALLER.
 *
 * @param {ToggleModel} model
 * @param {{ input?: any, output?: any }} [streams]
 * @returns {Promise<{ applied: boolean, disable: string[], enable: string[], reason?: string }>}
 */
export function interactiveToggle(model, { input = process.stdin, output = process.stdout } = {}) {
  const choices = toggleChoices(model);
  if (!model.hasClaude) {
    return Promise.resolve({ applied: false, disable: [], enable: [], reason: 'no `claude` target is enabled — nothing to toggle' });
  }
  if (!choices.length) return Promise.resolve({ applied: false, disable: [], enable: [], reason: 'no skills are rendered — nothing to toggle' });
  /** @type {(c: { name: string, stack: string, sourceDisabled: boolean }) => string} */
  const label = (c) => `${c.stack} › ${c.name}${c.sourceDisabled ? ` ${ANSI.dim}(source: slash-only)${ANSI.reset}` : ''}`;
  return keypressMultiSelect({ title: 'Agent-invocable skills (checked = an agent may fire it)', choices, label, input, output }).then(
    (result) => ({
      applied: result.applied,
      disable: result.applied ? choices.filter((c) => !c.checked).map((c) => c.name) : [],
      enable: result.applied ? choices.filter((c) => c.checked).map((c) => c.name) : [],
    }),
  );
}

/**
 * Persist a desired state to the COMMITTED config (never the overlay): a skill lands under
 * `disabled:`/`enabled:` only where it differs from its source, so the block stays minimal;
 * names in neither list keep their current state; unmatched names already in the file are kept.
 *
 * @param {{ cwd: string, model: ToggleModel, disable?: string[], enable?: string[] }} opts
 * @returns {{ changed: boolean, disabled: string[], enabled: string[], unknown: string[] }}
 */
export function applyToggle({ cwd, model, disable = [], enable = [] }) {
  const byName = new Map(model.rows.map((r) => [r.name, r]));
  const unknown = [...disable, ...enable].filter((n) => !byName.has(n));
  if (unknown.length) return { changed: false, disabled: [], enabled: [], unknown };

  const disabled = [...model.carried.disabled];
  const enabled = [...model.carried.enabled];
  for (const row of model.rows) {
    const want = disable.includes(row.name) ? true : enable.includes(row.name) ? false : row.disabled;
    if (want !== row.sourceDisabled) (want ? disabled : enabled).push(row.name);
  }

  // `changed` compares the block to be written against the one in the file, not effective states:
  // a redundant entry (override == source) is minimized away even when nothing flips.
  const current = {
    disabled: [...model.carried.disabled, ...model.rows.filter((r) => r.override === true).map((r) => r.name)],
    enabled: [...model.carried.enabled, ...model.rows.filter((r) => r.override === false).map((r) => r.name)],
  };
  /** @type {(a: string[], b: string[]) => boolean} */
  const same = (a, b) => a.length === b.length && a.every((n) => b.includes(n));
  const changed = !same(current.disabled, disabled) || !same(current.enabled, enabled);
  if (changed) writeOverride(cwd, disabled, enabled);
  return { changed, disabled, enabled, unknown: [] };
}

/**
 * @param {string} cwd
 * @param {string[]} disabled
 * @param {string[]} enabled
 */
function writeOverride(cwd, disabled, enabled) {
  const { file } = resolveConfigFile(cwd);
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors?.length) throw new Error(`${CONFIG_FILE} did not parse cleanly — fix it before toggling`);
  // A null `skills:` scalar is a valid (empty) block to the loader but not a collection `setIn`/
  // `deleteIn` can walk — treat it as absent.
  const skills = doc.get('skills', true);
  const skillsMap = YAML.isMap(skills) ? skills : null;
  if (!disabled.length && !enabled.length) {
    if (!skillsMap) return;
    doc.deleteIn(CONFIG_PATH);
    if (!skillsMap.items.length) doc.delete('skills');
  } else {
    if (!skillsMap && doc.has('skills')) doc.delete('skills');
    /** @type {Record<string, string[]>} */
    const block = {};
    if (disabled.length) block.disabled = disabled;
    if (enabled.length) block.enabled = enabled;
    doc.setIn(CONFIG_PATH, doc.createNode(block));
  }
  fs.writeFileSync(file, doc.toString());
}
