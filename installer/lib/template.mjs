import YAML from 'yaml';

// A `$`-prefixed `${{ ... }}` is GitHub Actions / shell-template syntax, never a
// wafflestack placeholder — the negative lookbehind excludes it from matching entirely,
// so such expressions pass through verbatim in every payload (agents, skills, and the
// generic `files/` payloads that carry workflow files) and are not policed by validate.
const PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g;

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
export function substitute(text, resolve, declared, errors, context, patterns) {
  return text.replace(PLACEHOLDER, (match, key) => {
    if (!declared.has(key) && !key.startsWith('harness.')) return match;
    const v = resolve(key);
    if (v === undefined) {
      errors.push(`${context}: missing config value for {{${key}}}`);
      return match;
    }
    const value = expandNested(formatValue(v), resolve, 1, patterns, errors, context);
    // Optional render-time value validation: a declared `pattern:` must fully match the
    // fully-expanded value that actually lands in the output. Textual substitution cannot
    // know its target context (a YAML scalar, a workflow `if:` expression, a shell word),
    // so escaping is impossible in general — a pattern makes an unsafe value fail loudly at
    // render instead of silently corrupting the output. `patterns` is a Map<key, RegExp>.
    const re = patterns?.get(key);
    if (re && !re.test(value)) {
      errors.push(`${context}: config value for {{${key}}} does not match its declared pattern`);
      return match;
    }
    return value;
  });
}

/**
 * Expand placeholders appearing *inside* a substituted value. `patterns` is enforced here
 * too: a guarded key reached only through composition (`git.cmd: git -c
 * user.email={{git.botEmail}}`) is exactly the case a pattern exists to police, and it never
 * appears as a top-level placeholder in the canonical text. Validating only at the top level
 * would make the guard an accident of whether some other item happens to reference the key
 * directly. A violating nested value pushes an error and leaves its placeholder in place —
 * the render fails, same as the top-level path.
 */
function expandNested(text, resolve, depth, patterns, errors, context) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return text;
  return text.replace(PLACEHOLDER, (match, key) => {
    const v = resolve(key);
    if (v === undefined) return match;
    const value = expandNested(formatValue(v), resolve, depth + 1, patterns, errors, context);
    const re = patterns?.get(key);
    if (re && !re.test(value)) {
      errors?.push(`${context}: config value for {{${key}}} does not match its declared pattern`);
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

/**
 * Compile a config key's `pattern:` into a full-match RegExp. Wrapping in `^(?:…)$`
 * makes "the value must fully match" hold regardless of whether the author anchored the
 * pattern, and neutralizes top-level alternation (`a|b` → `^(?:a|b)$`, not `^a` OR `b$`).
 * Throws on an invalid regex — callers (validate, render) decide how to surface that.
 */
export function compilePattern(pattern) {
  return new RegExp(`^(?:${pattern})$`);
}
