import YAML from 'yaml';

const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g;

/**
 * A substituted value may itself contain placeholders (a config default like
 * `Co-Authored-By: {{harness.assistantName}} <...>`, or a project value composed
 * from other config keys). Those are expanded in follow-up passes, capped so a
 * self- or mutually-referential value can't loop forever.
 */
const MAX_SUBSTITUTION_DEPTH = 4;

/**
 * Substitute {{dotted.key}} placeholders in `text`.
 * Keys present in `declared` (Set of dotted keys) are substituted; so is the reserved
 * `harness.*` namespace, which is always available and resolved per output target
 * (e.g. `{{harness.assistantName}}` → "Claude" in the claude render, "Codex" in the
 * codex / agents-dir renders). Anything else — bash `${...}`, GraphQL, JS templates,
 * undeclared braces — passes through verbatim.
 * `resolve(key)` returns the value (already defaulted / target-resolved) or undefined;
 * missing values push a message into `errors` and leave the placeholder in place.
 *
 * Substitution is recursive — but only downward into substituted VALUES, never back
 * over the canonical text (so undeclared literals that survive the first pass, like
 * GitHub Actions `${{ secrets.X }}`, are never touched). Inside a value, any
 * `{{dotted.key}}` that `resolve` can answer is expanded — declared keys, `harness.*`,
 * and dotted paths present in the project config even if undeclared (so a committed
 * value can reference a key kept in the gitignored local overlay). Unresolvable nested
 * placeholders pass through silently: only the canonical source text is policed for
 * missing values, values are trusted as authored.
 */
export function substitute(text, resolve, declared, errors, context) {
  return text.replace(PLACEHOLDER, (match, key) => {
    if (!declared.has(key) && !key.startsWith('harness.')) return match;
    const v = resolve(key);
    if (v === undefined) {
      errors.push(`${context}: missing config value for {{${key}}}`);
      return match;
    }
    return expandNested(formatValue(v), resolve, 1);
  });
}

function expandNested(text, resolve, depth) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return text;
  return text.replace(PLACEHOLDER, (match, key) => {
    const v = resolve(key);
    return v === undefined ? match : expandNested(formatValue(v), resolve, depth + 1);
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
