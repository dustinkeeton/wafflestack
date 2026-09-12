import YAML from 'yaml';

// The negative lookbehind excludes `${{ ... }}` (Actions / shell template syntax) from matching at all.
const PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g;

/** Cap on follow-up expansion passes, so a self- or mutually-referential value can't loop forever. */
const MAX_SUBSTITUTION_DEPTH = 4;

/** Substitute {{dotted.key}} placeholders in `text`: `declared` keys and `harness.*` resolve, everything else passes through. */
export function substitute(text, resolve, declared, errors, context, guards) {
  return text.replace(PLACEHOLDER, (match, key) => {
    if (!declared.has(key) && !key.startsWith('harness.')) return match;
    const v = resolve(key);
    if (v === undefined) {
      errors.push(`${context}: missing config value for {{${key}}}`);
      return match;
    }
    // Map-valued guards run on the RAW value: once `formatValue` flattens it, the structure they police is gone.
    const entryProblems = entryPatternProblems(guards, key, v);
    if (entryProblems.length) {
      errors.push(...entryProblems.map((p) => `${context}: config value for {{${key}}} ${p}`));
      return match;
    }
    const typeProblem = scalarTypeProblem(guards, key, v);
    if (typeProblem) {
      errors.push(`${context}: config value for {{${key}}} ${typeProblem}`);
      return match;
    }
    const value = expandNested(formatValue(v), resolve, 1, guards, errors, context);
    // A declared `pattern:` is checked against the FULLY-EXPANDED value that lands in the output.
    const failing = failingGuards(guards, key, value);
    if (failing.length) {
      errors.push(patternFailure(context, key, failing));
      return match;
    }
    return value;
  });
}

/** Compile a raw `pattern:` into the guard record render and validate share; throws on an invalid regex. */
export function makeGuard(pattern, source, hint = '') {
  return { re: compilePattern(pattern), pattern, source, hint };
}

/** The single failing-guard filter, ridden by both the scalar and the entryPatterns paths. */
const failingOf = (guardList, value) => guardList.filter((g) => !g.re.test(value));

/** The scalar pattern guards on `key` that `value` fails — empty when unguarded or passing. */
function failingGuards(guards, key, value) {
  const gs = guards?.patterns?.get(key);
  return gs ? failingOf(gs, value) : [];
}

/** A guarded key must be handed a STRING — checked RAW, since `formatValue` would flatten a list/map past the pattern. */
function scalarTypeProblem(guards, key, v) {
  if (!guards?.patterns?.has(key) || typeof v === 'string') return null;
  const kind = Array.isArray(v) ? 'a list' : v !== null && typeof v === 'object' ? 'a map' : `a ${typeof v}`;
  return `must be a string, not ${kind} (the key declares a pattern:, and a non-string value would be flattened into text before the pattern could police it — quote it, or set one command)`;
}

/** Name only the FAILING patterns and their declaring stacks, grouping identical patterns under joined sources. */
const describeGuards = (failing) => {
  const byPattern = new Map();
  for (const g of failing) {
    const sources = byPattern.get(g.pattern);
    if (sources) sources.push(g.source);
    else byPattern.set(g.pattern, [g.source]);
  }
  return [...byPattern].map(([pattern, sources]) => `\`${pattern}\` (declared by ${sources.join('; ')})`).join('; ');
};

/** The remedy prose a failing guard's key declares (`patternHint:`), deduped; empty when none declares one. */
const describeHints = (failing) => {
  const hints = [...new Set(failing.map((g) => g.hint).filter(Boolean))];
  return hints.length ? ` — ${hints.join(' ')}` : '';
};

function patternFailure(context, key, failing) {
  return `${context}: config value for {{${key}}} does not match its declared pattern ${describeGuards(failing)}${describeHints(failing)}`;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Validate a map-valued key against its declared `entryPatterns:`; returns EVERY problem found, `[]` when clean or unguarded. */
export function entryPatternProblems(guards, key, value) {
  const leaves = guards?.entryPatterns?.get(key);
  if (!leaves) return [];
  const allowed = [...leaves.keys()].join(', ');
  if (!isPlainObject(value)) return [`must be a map of entries (it declares entryPatterns: ${allowed})`];
  const problems = [];
  for (const [entry, body] of Object.entries(value)) {
    if (!isPlainObject(body)) {
      problems.push(`entry "${entry}" must be a map of: ${allowed}`);
      continue;
    }
    for (const [leaf, leafValue] of Object.entries(body)) {
      const res = leaves.get(leaf);
      if (!res) {
        problems.push(`entry "${entry}" has unknown key "${leaf}" (allowed: ${allowed})`);
        continue;
      }
      if (typeof leafValue !== 'string') {
        problems.push(`entry "${entry}" key "${leaf}" must be a string`);
        continue;
      }
      const failing = failingOf(res, leafValue);
      if (failing.length) {
        problems.push(`entry "${entry}" key "${leaf}" does not match its declared pattern ${describeGuards(failing)}`);
      }
    }
  }
  return problems;
}

/** Expand placeholders inside a substituted value — guards apply here too, so a composed key can't dodge them. */
function expandNested(text, resolve, depth, guards, errors, context) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return text;
  return text.replace(PLACEHOLDER, (match, key) => {
    const v = resolve(key);
    if (v === undefined) return match;
    const entryProblems = entryPatternProblems(guards, key, v);
    if (entryProblems.length) {
      errors?.push(...entryProblems.map((p) => `${context}: config value for {{${key}}} ${p}`));
      return match;
    }
    const typeProblem = scalarTypeProblem(guards, key, v);
    if (typeProblem) {
      errors?.push(`${context}: config value for {{${key}}} ${typeProblem}`);
      return match;
    }
    const value = expandNested(formatValue(v), resolve, depth + 1, guards, errors, context);
    const failing = failingGuards(guards, key, value);
    if (failing.length) {
      errors?.push(patternFailure(context, key, failing));
      return match;
    }
    return value;
  });
}

export function formatValue(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(', ');
  return YAML.stringify(v, { lineWidth: 0 }).trimEnd();
}

/** All placeholder keys appearing in a text, declared or not (for validate). */
export function placeholderKeys(text) {
  const keys = new Set();
  for (const m of text.matchAll(PLACEHOLDER)) keys.add(m[1]);
  return keys;
}

/** Compile a config key's `pattern:` into a full-match RegExp; throws on an invalid regex. */
export function compilePattern(pattern) {
  return new RegExp(`^(?:${pattern})$`);
}
