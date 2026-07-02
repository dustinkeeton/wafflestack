import YAML from 'yaml';

const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g;

/**
 * Substitute {{dotted.key}} placeholders in `text`.
 * Only keys present in `declared` (Set of dotted keys) are touched; anything else —
 * bash `${...}`, GraphQL, JS templates, undeclared braces — passes through verbatim.
 * `resolve(key)` returns the value (already defaulted) or undefined; missing values
 * push a message into `errors` and leave the placeholder in place.
 */
export function substitute(text, resolve, declared, errors, context) {
  return text.replace(PLACEHOLDER, (match, key) => {
    if (!declared.has(key)) return match;
    const v = resolve(key);
    if (v === undefined) {
      errors.push(`${context}: missing config value for {{${key}}}`);
      return match;
    }
    return formatValue(v);
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
