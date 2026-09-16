// @ts-check
// Per-target roster of the call-shaped harness tools a skill or agent may invoke (#445).
// Adding a `Tool(` call to any skill means adding the name HERE, on purpose, in the same PR.

/** @typedef {import('./project.mjs').Target} Target */

/**
 * The tool names each target exposes as `Name(...)` calls. `null` means the target declares NO
 * call-shaped tool surface — the per-target check skips it (visibly) rather than passing
 * vacuously; a declared `[]` would assert that nothing rendered there calls any tool.
 *
 * @type {Readonly<Record<Target, ReadonlyArray<string> | null>>}
 */
export const HARNESS_TOOLS = Object.freeze({
  claude: Object.freeze([
    'Agent',
    'Artifact',
    'AskUserQuestion',
    'Bash',
    'CronCreate',
    'CronDelete',
    'CronList',
    'Edit',
    'EnterPlanMode',
    'EnterWorktree',
    'ExitPlanMode',
    'ExitWorktree',
    'Glob',
    'Grep',
    'ListAgents',
    'Monitor',
    'NotebookEdit',
    'PushNotification',
    'Read',
    'ScheduleWakeup',
    'SendMessage',
    'SendUserFile',
    'Skill',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskOutput',
    'TaskStop',
    'TaskUpdate',
    'ToolSearch',
    'WebFetch',
    'WebSearch',
    'Workflow',
    'Write',
  ]),
  codex: null,
  'agents-dir': null,
});

/** Removed from the harness (#360); never a roster member, kept so the roster can be checked against them. */
export const DEAD_HARNESS_TOOLS = Object.freeze(['TeamCreate', 'TeamDelete', 'TeamList']);

/**
 * @param {Target} target
 * @returns {ReadonlyArray<string> | null}
 */
export const toolsForTarget = (target) => HARNESS_TOOLS[target] ?? null;

/** Every name any target declares — what a harness-neutral SOURCE may call. */
export const anyTargetTools = () =>
  new Set(Object.values(HARNESS_TOOLS).flatMap((roster) => (roster ? [...roster] : [])));

/**
 * @typedef {object} ToolCall
 * @property {string} name the capitalized identifier before the `(`
 * @property {number} line 1-based
 */

const CALL_RE = /\b([A-Z][A-Za-z]+)\(/g;
// Not a tool call: `new X(` / `new {{cfg.key}}X(` constructors, `function X(` declarations, `a.X(` member calls.
const NOT_A_CALL_BEFORE = /(\bnew\s+(\{\{[^}]*\}\})?|\bfunction\s+|\.)$/;

/**
 * Extract the call-shaped tool names in a markdown body: `Name(` with the paren attached. A
 * prose parenthetical (`the PR (see below)`) has a space and is not a call; `Module(s)` is a plural.
 *
 * @param {string} text
 * @returns {ToolCall[]}
 */
export function toolCalls(text) {
  /** @type {ToolCall[]} */
  const calls = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    for (const m of lineText.matchAll(CALL_RE)) {
      const start = m.index ?? 0;
      if (NOT_A_CALL_BEFORE.test(lineText.slice(0, start))) continue;
      if (lineText.startsWith('s)', start + m[0].length)) continue;
      calls.push({ name: m[1], line: i + 1 });
    }
  });
  return calls;
}

/**
 * The calls in `text` whose name is not in `roster`.
 *
 * @param {string} text
 * @param {Iterable<string>} roster
 * @returns {ToolCall[]}
 */
export function unknownToolCalls(text, roster) {
  const allowed = new Set(roster);
  return toolCalls(text).filter((c) => !allowed.has(c.name));
}
