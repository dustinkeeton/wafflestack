import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { placeholderKeys, compilePattern, makeGuard, entryPatternProblem } from './template.mjs';
import { parseFrontmatter } from './util.mjs';
import { findItems, itemsOfKind, parseRef, resolveDepStrict } from './refs.mjs';
import { PREREQ_KINDS, PREREQ_LEVELS } from './prerequisites.mjs';
import { HARNESS_BUILTINS, HARNESS_PATTERNS } from './project.mjs';

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Allowlist for an agent's `identity.displayName` (#156) — deliberately the SAME shape as the
 * `git.botName` pattern declared by the github-workflow stack, because the value lands in the
 * same place: inside the double quotes of `-c user.name="…"` in an agent-executed shell command.
 * Letters, digits, `.` `_` `-` `[` `]`, single interior spaces. No quote, `$`, backtick or `\`.
 */
const DISPLAY_NAME_RE = compilePattern('(?!.*\\$\\{\\{)[A-Za-z0-9._\\[\\]-]+(?: [A-Za-z0-9._\\[\\]-]+)*');

/**
 * Allowlist for an agent's `identity.avatar` (#157) — a *reference* to the agent's avatar image:
 * a repo-relative path (`.waffle/avatars/scout.svg`) or an `https://` URL, and nothing else. It is
 * guarded in the same trust-boundary style as its `displayName` sibling, because a consumer may
 * splice it somewhere hotter than the YAML frontmatter and Markdown table it lands in today (an
 * `<img src>`, a `curl`).
 *
 * The union enforces the documented contract rather than gesturing at it (#248 review). A single
 * permissive character class admitting `:` and `%` accepted `javascript:alert`, `data:…`,
 * `file:///etc/passwd`, `http://evil.tld/x`, the protocol-relative `//evil.tld/x`, the absolute
 * `/etc/passwd`, and `%2e%2e%2f`-encoded traversal that the `(?!.*\.\.)` lookahead cannot see.
 * So:
 *   - the URL alternative requires a literal `https://` prefix — no other scheme parses;
 *   - the path alternative is `segment(/segment)*` over a class WITHOUT `:`, `%`, or an empty
 *     segment, which rejects every scheme, the leading `/`, the `//` authority form, and any
 *     percent-encoding (so encoded dots cannot smuggle traversal past the `..` lookahead).
 * `..` stays blocked in both by the lookahead. `(?!.*\$\{\{)` is the usual sibling-injection guard.
 */
const IDENTITY_AVATAR_RE = compilePattern(
  '(?!.*\\$\\{\\{)(?!.*\\.\\.)(?:https://[A-Za-z0-9._~/?#@!&=+*%-]+|[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)',
);

const IDENTITY_KEYS = ['displayName', 'avatar'];

/**
 * Agent frontmatter keys the renderer owns and the `claude:` passthrough may NOT shadow (#156
 * review). `claude:` hoists every key it carries to the top level of the Claude render, so an
 * unpoliced `claude: { identity: { displayName: 'Evil"; id' } }` would overwrite the `identity:`
 * block that `validateStack` just checked against DISPLAY_NAME_RE — defeating the trust boundary
 * for exactly the value that lands in an agent-executed `git -c user.name="…"`. The passthrough
 * exists for Claude-only knobs (`tools`, `model`), not for re-declaring a field with a
 * first-class, validated home. Enforced here and stripped again in `renderAgent`.
 */
export const RESERVED_AGENT_KEYS = Object.freeze(['name', 'description', 'skills', 'identity']);

/** Toolkit-developer lint. Returns a list of problems (empty = clean). */
export function validateToolkit(rootDir) {
  let toolkit;
  try {
    toolkit = loadToolkit(rootDir);
  } catch (err) {
    return [`toolkit failed to load: ${err.message}`];
  }
  const problems = [];
  problems.push(...validateHarnessBuiltins());
  for (const stack of toolkit.stacks.values()) problems.push(...validateStack(toolkit, stack));
  return problems;
}

/**
 * Lint the reserved `harness.*` injection guards (#131). Those keys render into CI workflow
 * files but are resolved from HARNESS_BUILTINS rather than a stack's `config:`, so they carry
 * their guard in HARNESS_PATTERNS instead of a declared `pattern:`. Check the same two things
 * `validateStack` checks for a stack's own patterns: every guard regex must compile, and the
 * built-in default it guards must satisfy it — so a bad default can't ship a self-violating or
 * unenforceable guard. Toolkit-global (not per-stack), so it runs once. Returns problems.
 */
export function validateHarnessBuiltins() {
  const problems = [];
  for (const [sub, pattern] of Object.entries(HARNESS_PATTERNS)) {
    let re;
    try {
      re = compilePattern(pattern);
    } catch (err) {
      problems.push(`reserved harness.${sub} has an invalid pattern: ${err.message}`);
      continue;
    }
    const builtin = HARNESS_BUILTINS[sub];
    if (builtin === undefined) {
      problems.push(`reserved harness.${sub} declares an injection guard but has no built-in default`);
      continue;
    }
    // A built-in is a scalar (target-independent) or a per-target map — check every concrete
    // string value. A value carrying {{placeholders}} resolves at render, so skip it here.
    const values = builtin && typeof builtin === 'object' ? Object.values(builtin) : [builtin];
    for (const v of values) {
      if (typeof v === 'string' && !v.includes('{{') && !re.test(v)) {
        problems.push(`reserved harness.${sub} default "${v}" does not match its injection guard`);
      }
    }
  }
  return problems;
}

/**
 * Enforce the external-source trust boundary at install/render time (#126): run the same lint
 * over every EXTERNAL stack's definitions (a stack merged in from a `source:` carries a
 * `provenance` record — see `loadToolkitWithSources`), so a malformed third-party stack fails
 * loudly before anything renders. Cross-stack resolution sees the full merged toolkit (an
 * external stack may legitimately depend on a built-in item), but only the external stacks'
 * problems are reported — built-in stacks are vetted by the toolkit's own `validate` in CI and
 * the consumer can neither cause nor fix a built-in problem here. Each problem names the source.
 * Returns a list of problems (empty = clean).
 */
export function validateExternalStacks(toolkit) {
  const problems = [];
  for (const stack of toolkit.stacks.values()) {
    if (!stack.provenance) continue; // only source-provided (external) stacks
    const { source, ref } = stack.provenance;
    const where = ref ? `${source}@${ref}` : source;
    problems.push(...validateStack(toolkit, stack, `external stack "${stack.name}" (${where})`));
  }
  return problems;
}

/**
 * Lint a single loaded stack against its containing (possibly multi-root) toolkit. `ctx` is the
 * prefix each problem is reported under — `stack <name>` for a built-in, or an external-source
 * identity for a third-party stack — so the same checks serve both the toolkit-developer
 * `validate` and the install-time external gate. Returns this stack's problems (empty = clean).
 */
export function validateStack(toolkit, stack, ctx = `stack ${stack.name}`) {
  const problems = [];
  {
    if (!stack.description) problems.push(`${ctx}: missing description`);

    const usedKeys = new Set();
    for (const agent of stack.agents) {
      if (!agent.data.description) problems.push(`${ctx}: agent ${agent.name} missing frontmatter description`);
      if (agent.data.name && agent.data.name !== agent.name) {
        problems.push(`${ctx}: agent ${agent.name} frontmatter name "${agent.data.name}" mismatches filename`);
      }
      // Agent `skills:` names are pulled into the dependency closure when the agent is
      // installed. They may point at skills provided outside the toolkit (project-local
      // or not yet authored), so an absent name is allowed — but a name defined in more
      // than one stack can't be auto-resolved (frontmatter can't qualify it).
      for (const skillName of agent.data.skills ?? []) {
        if (stack.skills.some((s) => s.name === skillName)) continue;
        const matches = findItems(toolkit, 'skills', skillName);
        if (matches.length > 1) {
          const where = matches.map((m) => `${m.stackName}/skills/${skillName}`).join(', ');
          problems.push(`${ctx}: agent ${agent.name} skill "${skillName}" is ambiguous across stacks (${where})`);
        }
      }
      // Optional `identity:` block (#156, #157) — the agent's virtualized git author plus its
      // avatar reference. `displayName` lands inside the double quotes of `-c user.name="…"` in a
      // shell command the delegate orchestrator hands a spawned agent, so it is the same injection
      // surface as `git.botName` and carries the same allowlist; `avatar` is guarded in the same
      // style (see IDENTITY_AVATAR_RE). This is a trust-boundary check: external stacks flow
      // through `validateExternalStacks` at render, so a third-party agent cannot smuggle a
      // quote-breaking display name into an agent-executed command.
      const identity = agent.data.identity;
      if (identity !== undefined) {
        if (!isPlainObject(identity)) {
          problems.push(`${ctx}: agent ${agent.name} \`identity\` must be a map with a \`displayName\``);
        } else {
          for (const k of Object.keys(identity)) {
            if (!IDENTITY_KEYS.includes(k)) {
              problems.push(
                `${ctx}: agent ${agent.name} identity has unknown key "${k}" ` +
                  `(only ${IDENTITY_KEYS.map((n) => `\`${n}\``).join(' and ')} are defined)`,
              );
            }
          }
          const displayName = identity.displayName;
          if (typeof displayName !== 'string' || !DISPLAY_NAME_RE.test(displayName)) {
            problems.push(
              `${ctx}: agent ${agent.name} identity.displayName ${JSON.stringify(displayName ?? null)} ` +
                `does not match the allowed shape (letters, digits, ". _ - [ ]", single interior spaces)`,
            );
          }
          // Optional: absent means the deterministic `.waffle/avatars/<agent>.svg` default applies.
          const avatar = identity.avatar;
          if (avatar !== undefined && (typeof avatar !== 'string' || !IDENTITY_AVATAR_RE.test(avatar))) {
            problems.push(
              `${ctx}: agent ${agent.name} identity.avatar ${JSON.stringify(avatar ?? null)} ` +
                `does not match the allowed shape (an https:// URL, or a repo-relative path — no leading ` +
                `"/", no "//", no other scheme, no percent-encoding, no ".." traversal)`,
            );
          }
        }
      }
      // The `claude:` passthrough hoists its keys to the top level of the Claude render, so it
      // is a second, unvalidated door into the frontmatter the renderer owns. Reserved keys are
      // rejected outright rather than validated twice: `identity` in particular has a first-class
      // home whose allowlist is a trust boundary, and a passthrough copy would silently win.
      const passthrough = agent.data.claude;
      if (passthrough !== undefined) {
        if (!isPlainObject(passthrough)) {
          problems.push(`${ctx}: agent ${agent.name} \`claude\` must be a map of passthrough frontmatter keys`);
        } else {
          for (const k of Object.keys(passthrough)) {
            if (RESERVED_AGENT_KEYS.includes(k)) {
              problems.push(
                `${ctx}: agent ${agent.name} \`claude.${k}\` shadows the reserved frontmatter key ` +
                  `"${k}" — declare it at the top level (the \`claude:\` block is for Claude-only keys)`,
              );
            }
          }
        }
      }
      // Both the body and the frontmatter description are substituted at render time.
      for (const k of placeholderKeys(agent.body)) usedKeys.add(k);
      for (const k of placeholderKeys(agent.data.description ?? '')) usedKeys.add(k);
    }

    // `requires:` entries must key a real item in this stack and resolve to real deps.
    for (const [itemRef, deps] of Object.entries(stack.requires ?? {})) {
      const parsed = parseRef(itemRef);
      if (parsed.form === 'stack' || !itemsOfKind(stack, parsed.kind).some((i) => i.name === parsed.name)) {
        problems.push(`${ctx}: requires key "${itemRef}" does not match a skill/agent in this stack`);
        continue;
      }
      for (const dep of deps ?? []) {
        try {
          resolveDepStrict(toolkit, dep, stack.name);
        } catch (err) {
          problems.push(`${ctx}: requires[${itemRef}]: ${err.message}`);
        }
      }
    }
    // `optIn:` entries mark sensitive syrup as opt-in; each must name a real item in this
    // stack (like a `requires:` key), so a typo can't silently un-gate or mis-gate a file.
    for (const ref of stack.optIn) {
      const parsed = parseRef(ref);
      if (parsed.form === 'stack' || !itemsOfKind(stack, parsed.kind).some((i) => i.name === parsed.name)) {
        problems.push(`${ctx}: optIn entry "${ref}" does not match a file/skill/agent in this stack`);
      }
    }
    // Typed external prerequisites (#129): each declared entry must name a known kind and level,
    // carry a human description and a deterministic check, and any `items:` scoping ref must
    // resolve to a real item in this stack (like a `requires:` key or `optIn:` entry) — so a typo
    // can't silently mis-scope or drop a check.
    for (const p of stack.prerequisites ?? []) {
      const label = p.name ? `prerequisite "${p.name}"` : 'a prerequisite';
      if (!p.name) problems.push(`${ctx}: a prerequisite is missing its \`name\``);
      if (!PREREQ_KINDS.includes(p.kind)) {
        problems.push(`${ctx}: ${label} has ${p.kind ? `unknown kind "${p.kind}"` : 'no `kind`'} (valid: ${PREREQ_KINDS.join(', ')})`);
      }
      if (!PREREQ_LEVELS.includes(p.level)) {
        problems.push(`${ctx}: ${label} has unknown level "${p.level}" (valid: ${PREREQ_LEVELS.join(', ')})`);
      }
      if (!p.description) problems.push(`${ctx}: ${label} is missing a \`description\``);
      if (!p.check) problems.push(`${ctx}: ${label} is missing a \`check\` (a deterministic shell command whose exit 0 means satisfied)`);
      for (const ref of p.items ?? []) {
        const parsed = parseRef(ref);
        if (parsed.form === 'stack' || !itemsOfKind(stack, parsed.kind).some((i) => i.name === parsed.name)) {
          problems.push(`${ctx}: ${label} \`items:\` entry "${ref}" does not match a file/skill/agent in this stack`);
        }
      }
    }

    // Optional per-key `pattern:` (render-time value validation). The regex must compile,
    // and a static string default must satisfy its own pattern (nested/non-string defaults
    // resolve at render, so skip them here).
    for (const [key, spec] of Object.entries(stack.config)) {
      if (typeof spec?.pattern === 'string') {
        let re;
        try {
          re = compilePattern(spec.pattern);
          if (typeof spec.default === 'string' && !spec.default.includes('{{') && !re.test(spec.default)) {
            problems.push(`${ctx}: config key ${key} default "${spec.default}" does not match its declared pattern`);
          }
        } catch (err) {
          problems.push(`${ctx}: config key ${key} has an invalid pattern: ${err.message}`);
        }
      }
      // `entryPatterns:` (#156) — the map-valued sibling of `pattern:`. Each leaf's regex must
      // compile (render fails loudly otherwise, so a broken guard can never ship unenforced),
      // and a static `default:` map must satisfy its own guard, exactly as a string default must.
      const entryPatterns = spec?.entryPatterns;
      if (entryPatterns !== undefined) {
        if (!isPlainObject(entryPatterns)) {
          problems.push(`${ctx}: config key ${key} \`entryPatterns\` must be a map of leaf name → pattern`);
          continue;
        }
        const compiled = new Map();
        for (const [leaf, pattern] of Object.entries(entryPatterns)) {
          if (typeof pattern !== 'string') {
            problems.push(`${ctx}: config key ${key} entryPattern for "${leaf}" must be a string`);
            continue;
          }
          try {
            // The guard-record shape entryPatternProblem consumes (see makeGuard): the self-check
            // rejection then names this stack as the declarer, same as a render-time rejection.
            compiled.set(leaf, [makeGuard(pattern, `stack "${stack.name}"`)]);
          } catch (err) {
            problems.push(`${ctx}: config key ${key} has an invalid entryPattern for "${leaf}": ${err.message}`);
          }
        }
        if (spec.default !== undefined) {
          const problem = entryPatternProblem({ entryPatterns: new Map([[key, compiled]]) }, key, spec.default);
          if (problem) problems.push(`${ctx}: config key ${key} default ${problem}`);
        }
      }
    }

    for (const skill of stack.skills) {
      const raw = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
      const { data } = parseFrontmatter(raw);
      if (!data.name) problems.push(`${ctx}: skill ${skill.name} missing frontmatter name`);
      if (!data.description) problems.push(`${ctx}: skill ${skill.name} missing frontmatter description`);
      for (const rel of skill.files.filter((f) => f.endsWith('.md'))) {
        for (const k of placeholderKeys(fs.readFileSync(path.join(skill.dir, rel), 'utf8'))) usedKeys.add(k);
      }
    }

    // Text `files/` payloads are templated just like skills — every {{key}} they use must
    // be declared (GitHub Actions `${{ ... }}` is excluded by the placeholder grammar, so
    // workflow expressions don't register as config keys). Binaries are byte-copied, skip.
    for (const file of stack.files) {
      if (file.binary) continue;
      for (const k of placeholderKeys(fs.readFileSync(file.path, 'utf8'))) usedKeys.add(k);
    }

    for (const key of usedKeys) {
      // `harness.*` is a reserved, always-available namespace (resolved per target) —
      // it is never declared in stack config.
      if (!stack.declared.has(key) && !key.startsWith('harness.') && looksLikeConfigKey(key)) {
        problems.push(`${ctx}: placeholder {{${key}}} is not declared in stack.yaml config`);
      }
    }
    for (const key of stack.declared) {
      if (!usedKeys.has(key)) problems.push(`${ctx}: declared config key ${key} is never referenced`);
    }
  }
  return problems;
}

/**
 * Undeclared {{...}} text is usually third-party template syntax that must pass
 * through (mustache in docs, GitHub Actions, etc.) — only flag dotted lowercase
 * keys, which match the toolkit's config-key convention.
 */
function looksLikeConfigKey(key) {
  return /^[a-z][\w-]*(\.[\w-]+)+$/.test(key);
}
