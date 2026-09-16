// @ts-check
// Per-skill model-invocation override (#476): the consumer's `skills.modelInvocation` block and
// the render-time frontmatter patch it drives. Pure — no fs, no imports beyond util.

import { FRONTMATTER_RE, parseFrontmatter } from './util.mjs';

export const MODEL_INVOCATION_KEY = 'disable-model-invocation';
export const CONFIG_PATH = ['skills', 'modelInvocation'];

/**
 * @typedef {object} ModelInvocationOverride the normalized `skills.modelInvocation` block
 * @property {string[]} disabled skills rendered with `disable-model-invocation: true`
 * @property {string[]} enabled skills rendered WITHOUT the key even when the source sets it
 */

/** @returns {ModelInvocationOverride} */
export const emptyOverride = () => ({ disabled: [], enabled: [] });

/**
 * Validate and normalize the raw `skills:` block of a project config. Throws on any shape
 * problem — the same posture as an invalid `targets:` — so a typo never renders silently.
 *
 * @param {unknown} rawSkills the parsed `skills:` value, or undefined
 * @param {string} configFile the file name for error messages
 * @returns {ModelInvocationOverride}
 */
export function normalizeModelInvocation(rawSkills, configFile) {
  if (rawSkills === undefined || rawSkills === null) return emptyOverride();
  const skills = asMap(rawSkills, `skills:`, configFile);
  rejectUnknownKeys(skills, ['modelInvocation'], 'skills:', configFile);
  const raw = skills.modelInvocation;
  if (raw === undefined || raw === null) return emptyOverride();
  const block = asMap(raw, 'skills.modelInvocation:', configFile);
  rejectUnknownKeys(block, ['disabled', 'enabled'], 'skills.modelInvocation:', configFile);
  const disabled = asNameList(block.disabled, 'skills.modelInvocation.disabled', configFile);
  const enabled = asNameList(block.enabled, 'skills.modelInvocation.enabled', configFile);
  const both = disabled.filter((n) => enabled.includes(n));
  if (both.length) {
    throw new Error(
      `${configFile}: skills.modelInvocation lists ${both.join(', ')} under BOTH disabled: and enabled: — a skill takes one side`,
    );
  }
  return { disabled, enabled };
}

/**
 * @param {unknown} v
 * @param {string} label
 * @param {string} configFile
 * @returns {Record<string, unknown>}
 */
function asMap(v, label, configFile) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${configFile}: ${label} must be a map (got ${describe(v)})`);
  }
  return /** @type {Record<string, unknown>} */ (v);
}

/**
 * @param {Record<string, unknown>} map
 * @param {string[]} allowed
 * @param {string} label
 * @param {string} configFile
 */
function rejectUnknownKeys(map, allowed, label, configFile) {
  const unknown = Object.keys(map).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new Error(`${configFile}: ${label} has unknown key(s) ${unknown.join(', ')} — allowed: ${allowed.join(', ')}`);
  }
}

/**
 * @param {unknown} v
 * @param {string} label
 * @param {string} configFile
 * @returns {string[]}
 */
function asNameList(v, label, configFile) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${configFile}: ${label} must be a list of skill names (got ${describe(v)})`);
  /** @type {string[]} */
  const out = [];
  for (const entry of v) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${configFile}: ${label} must contain bare skill names (got ${describe(entry)})`);
    }
    const name = entry.trim().replace(/^skills\//, '');
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** @param {unknown} v */
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'object' ? 'a map' : JSON.stringify(v);
}

/**
 * The override's verdict for one skill: `true` (disable), `false` (enable), or `null` (source wins).
 *
 * @param {ModelInvocationOverride | undefined} override
 * @param {string} name
 * @returns {boolean | null}
 */
export function overrideFor(override, name) {
  if (!override) return null;
  if (override.disabled.includes(name)) return true;
  if (override.enabled.includes(name)) return false;
  return null;
}

/**
 * Whether a SKILL.md's own frontmatter disables model invocation — the state the override is
 * measured against, and the one every non-`claude` target renders. Only a literal `true` counts.
 *
 * @param {Record<string, any>} data parsed frontmatter (`SkillItem.data`)
 * @returns {boolean}
 */
export function frontmatterDisablesModelInvocation(data) {
  return data[MODEL_INVOCATION_KEY] === true;
}

/**
 * @param {string} source the SKILL.md text
 * @returns {boolean}
 */
export function sourceDisablesModelInvocation(source) {
  return frontmatterDisablesModelInvocation(parseFrontmatter(source).data);
}

// A quoted key is valid YAML that `parseFrontmatter` reads as the same key; miss it and the patch appends a duplicate.
const KEY_LINE_RE = /^['"]?disable-model-invocation['"]?\s*:/;

/**
 * Patch a rendered SKILL.md's frontmatter to the override's verdict, touching only the
 * `disable-model-invocation` line: `true` sets it (replacing an existing line in place, else
 * appending it as the last key), `false` removes it, `null` returns the text untouched.
 *
 * @param {string} content
 * @param {boolean | null} disable
 * @returns {string}
 */
export function applyModelInvocation(content, disable) {
  if (disable === null) return content;
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return content;
  const [whole, open, block, close] = m;
  const eol = open.endsWith('\r\n') ? '\r\n' : '\n';
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((l) => KEY_LINE_RE.test(l));
  if (disable) {
    if (at === -1) lines.push(`${MODEL_INVOCATION_KEY}: true`);
    else lines[at] = `${MODEL_INVOCATION_KEY}: true`;
  } else {
    if (at === -1) return content;
    lines.splice(at, 1);
  }
  return `${open}${lines.join(eol)}${close}${content.slice(whole.length)}`;
}
