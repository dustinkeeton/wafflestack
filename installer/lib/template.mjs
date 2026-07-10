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
export function substitute(text, resolve, declared, errors, context, guards) {
  return text.replace(PLACEHOLDER, (match, key) => {
    if (!declared.has(key) && !key.startsWith('harness.')) return match;
    const v = resolve(key);
    if (v === undefined) {
      errors.push(`${context}: missing config value for {{${key}}}`);
      return match;
    }
    // Structured (map-valued) guards run on the RAW value, before `formatValue` flattens it
    // into a YAML block — once it is text, the entry/leaf structure a guard polices is gone.
    const entryProblem = entryPatternProblem(guards, key, v);
    if (entryProblem) {
      errors.push(`${context}: config value for {{${key}}} ${entryProblem}`);
      return match;
    }
    const value = expandNested(formatValue(v), resolve, 1, guards, errors, context);
    // Optional render-time value validation: a declared `pattern:` must fully match the
    // fully-expanded value that actually lands in the output. Textual substitution cannot
    // know its target context (a YAML scalar, a workflow `if:` expression, a shell word),
    // so escaping is impossible in general — a pattern makes an unsafe value fail loudly at
    // render instead of silently corrupting the output. `guards.patterns` is a Map<key,
    // guard[]> (see makeGuard) spanning every stack in the toolkit, and a guarded value must
    // satisfy every pattern.
    const failing = failingGuards(guards, key, value);
    if (failing.length) {
      errors.push(patternFailure(context, key, failing));
      return match;
    }
    return value;
  });
}

/**
 * Compile a raw `pattern:` string into the guard record the render-time maps carry:
 * `re` is the full-match RegExp, `pattern` the raw authored string (what the author wrote,
 * not the `^(?:…)$`-wrapped source), `source` a prose name for the declarer (`stack
 * "github-workflow"`, or `the reserved harness guards`). One constructor so every producer
 * (render's compilePatterns, validate's default self-check) builds the same shape a
 * rejection message can then cite (#244 F1). Throws on an invalid regex, like compilePattern.
 */
export function makeGuard(pattern, source) {
  return { re: compilePattern(pattern), pattern, source };
}

/**
 * The single implementation of the failing-guard filter — both the scalar path
 * (`failingGuards`) and the entryPatterns path (`entryPatternProblem`) ride it, so "never
 * name a guard the value satisfies" cannot hold on one path and silently break on the other.
 */
const failingOf = (guardList, value) => guardList.filter((g) => !g.re.test(value));

/** The scalar pattern guards on `key` that `value` fails — empty when unguarded or passing. */
function failingGuards(guards, key, value) {
  const gs = guards?.patterns?.get(key);
  return gs ? failingOf(gs, value) : [];
}

/**
 * A rejection must be actionable: guards are unioned toolkit-wide, so the stack that vetoed a
 * value may not even be installed — name the FAILING pattern(s) and their declaring stack(s),
 * and never the guards the value satisfies (#244 F1). The `does not match its declared
 * pattern` prefix is a stable contract several tests pin by regex; only details follow it.
 * The pattern is backtick-wrapped because shipped regexes contain spaces and trailing groups
 * that would otherwise abut the attribution ambiguously, and identical patterns from several
 * declarers (the live `git.agentIdentities` case — byte-identical in two stacks) are grouped
 * under one pattern with their sources joined, rather than printed once per declarer.
 */
const describeGuards = (failing) => {
  const byPattern = new Map();
  for (const g of failing) {
    const sources = byPattern.get(g.pattern);
    if (sources) sources.push(g.source);
    else byPattern.set(g.pattern, [g.source]);
  }
  return [...byPattern].map(([pattern, sources]) => `\`${pattern}\` (declared by ${sources.join('; ')})`).join('; ');
};

function patternFailure(context, key, failing) {
  return `${context}: config value for {{${key}}} does not match its declared pattern ${describeGuards(failing)}`;
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a map-valued config key against its declared `entryPatterns:` (#156).
 *
 * `pattern:` guards string scalars only — so before this, a map key like `git.agentIdentities`
 * carried its leaves (`botName` / `botEmail` / `signingKey`) straight into a rendered,
 * agent-executed shell command with none of the sibling scalar guards applied. `entryPatterns`
 * closes that: the key declares the leaf shape of ONE entry, and every entry in the map must
 * satisfy it. An unknown leaf is an error rather than a passthrough — a typoed `botEmial:` must
 * not ride along unguarded beside the leaf it was meant to be.
 *
 * `guards.entryPatterns` is a Map<key, Map<leaf, guard[]>> of makeGuard records, unioned
 * toolkit-wide exactly like the scalar patterns (a leaf guarded in two stacks must satisfy
 * both). Returns a problem string, or null when clean.
 */
export function entryPatternProblem(guards, key, value) {
  const leaves = guards?.entryPatterns?.get(key);
  if (!leaves) return null;
  const allowed = [...leaves.keys()].join(', ');
  if (!isPlainObject(value)) return `must be a map of entries (it declares entryPatterns: ${allowed})`;
  for (const [entry, body] of Object.entries(value)) {
    if (!isPlainObject(body)) return `entry "${entry}" must be a map of: ${allowed}`;
    for (const [leaf, leafValue] of Object.entries(body)) {
      const res = leaves.get(leaf);
      if (!res) return `entry "${entry}" has unknown key "${leaf}" (allowed: ${allowed})`;
      if (typeof leafValue !== 'string') return `entry "${entry}" key "${leaf}" must be a string`;
      const failing = failingOf(res, leafValue);
      if (failing.length) {
        return `entry "${entry}" key "${leaf}" does not match its declared pattern ${describeGuards(failing)}`;
      }
    }
  }
  return null;
}

/**
 * Expand placeholders appearing *inside* a substituted value. `guards` are enforced here
 * too: a guarded key reached only through composition (`git.cmd: git -c
 * user.email={{git.botEmail}}`) is exactly the case a pattern exists to police, and it never
 * appears as a top-level placeholder in the canonical text. Validating only at the top level
 * would make the guard an accident of whether some other item happens to reference the key
 * directly — and compiling the guards per stack (fixed in #155's review) made it an accident
 * of which stack happened to be installed. A violating nested value pushes an error and leaves
 * its placeholder in place — the render fails, same as the top-level path. Entry patterns are
 * checked here for the same reason: a map key composed into another value must not dodge them.
 */
function expandNested(text, resolve, depth, guards, errors, context) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return text;
  return text.replace(PLACEHOLDER, (match, key) => {
    const v = resolve(key);
    if (v === undefined) return match;
    const entryProblem = entryPatternProblem(guards, key, v);
    if (entryProblem) {
      errors?.push(`${context}: config value for {{${key}}} ${entryProblem}`);
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

/**
 * Compile a config key's `pattern:` into a full-match RegExp. Wrapping in `^(?:…)$`
 * makes "the value must fully match" hold regardless of whether the author anchored the
 * pattern, and neutralizes top-level alternation (`a|b` → `^(?:a|b)$`, not `^a` OR `b$`).
 * Throws on an invalid regex — callers (validate, render) decide how to surface that.
 */
export function compilePattern(pattern) {
  return new RegExp(`^(?:${pattern})$`);
}
