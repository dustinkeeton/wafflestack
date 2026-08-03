import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { placeholderKeys, compilePattern, makeGuard, entryPatternProblems } from './template.mjs';
import { parseFrontmatter } from './util.mjs';
import { findItems, itemsOfKind, parseRef, resolveDepStrict } from './refs.mjs';
import { PREREQ_KINDS, PREREQ_LEVELS } from './prerequisites.mjs';
import { PLUGIN_ENTRY_KEYS } from './plugins.mjs';
import { HARNESS_BUILTINS, HARNESS_PATTERNS, VALID_TARGETS } from './project.mjs';
import {
  REGISTRY_FILE,
  WAFFLE_KINDS,
  WAFFLE_STATUSES,
  LIVE_STATUSES,
  REGISTRY_ENTRY_KEYS,
  canonicalWafflePath,
  refKindOf,
  waffleStatus,
} from './registry.mjs';

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Allowlist for an agent's `identity.displayName` (#156) — deliberately the SAME shape as the
 * `git.botName` pattern declared by the github-workflow stack, because the value lands in the
 * same place: inside the double quotes of `-c user.name="…"` in an agent-executed shell command.
 * Letters, digits, `.` `_` `-` `[` `]`, single interior spaces. No quote, `$`, backtick or `\`.
 */
const DISPLAY_NAME_RE = compilePattern('(?!.*\\$\\{\\{)[A-Za-z0-9._\\[\\]-]+(?: [A-Za-z0-9._\\[\\]-]+)*');

/**
 * Allowlist for the agent slug itself (#247) — the `agents:` manifest entry, which is also the
 * agent's filename (`agents/<slug>.md`). The slug reaches the SAME agent-executed git command
 * `displayName` is guarded for, by two delegate-derivation paths: always as the plus-address in
 * `-c user.email=bot+<slug>@…`, and as the title-cased `-c user.name="…"` fallback when
 * `identity.displayName` is absent — precisely the case where DISPLAY_NAME_RE never runs.
 * Stricter than DISPLAY_NAME_RE (it is a filename): letters, digits, `.` `_` `-`, no spaces.
 * The lookahead requires at least one letter or digit (#247 review): a separator-only slug
 * (`---`, `...`, `___`) title-cases to an empty/whitespace user.name — git's "Author identity
 * unknown" failure at the agent's first commit, uncaught on the derived path.
 */
const AGENT_SLUG_RE = compilePattern('(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+');

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
 *   - the URL alternative's class excludes `@`, so a userinfo authority
 *     (`https://good.tld@evil.tld/x.png` — displayed host ≠ fetch host) cannot spoof the host a
 *     reader eyeballs (#249). This also blocks `@` in URL paths (`https://cdn.x/@scope/pkg`) —
 *     a deliberate tightening; nothing in the avatar contract needs it, and an explicit
 *     host/path split buys nothing today. The URL class keeps `%`, so the encoded form needs its
 *     own `(?!.*%40)` lookahead (#262 review) — the path alternative bans `%` precisely because
 *     encoding smuggles characters past lookaheads, and the same logic holds here (the WHATWG
 *     parser rejects `%40` in a host, but the guard must not lean on the consumer's parser);
 *   - the path alternative is `segment(/segment)*` over a class WITHOUT `:`, `%`, or an empty
 *     segment, which rejects every scheme, the leading `/`, the `//` authority form, and any
 *     percent-encoding (so encoded dots cannot smuggle traversal past the `..` lookahead).
 * `..` stays blocked in both by the lookahead. `(?!.*\$\{\{)` is the usual sibling-injection guard.
 */
const IDENTITY_AVATAR_RE = compilePattern(
  '(?!.*\\$\\{\\{)(?!.*\\.\\.)(?!.*%40)(?:https://[A-Za-z0-9._~/?#!&=+*%-]+|[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)',
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
  problems.push(...validateSourceBytes(rootDir));
  problems.push(...validateRegistry(rootDir, toolkit));
  for (const stack of toolkit.stacks.values()) problems.push(...validateStack(toolkit, stack));
  return problems;
}

/**
 * Reconcile the waffle registry against the filesystem AND against every `stack.yaml` (#335).
 *
 * **This is what makes a rename or a move impossible to land quietly.** Before the registry, a
 * waffle's existence was whatever happened to be on disk, so moving `stacks/a/skills/x` to
 * `stacks/b/skills/x` broke nothing here and everything at the next consumer render. Now the
 * registry states where each waffle lives and whether it is offered, and three-way divergence is a
 * red: a waffle on disk that nobody registered, a registered waffle whose path does not exist or is
 * not the one the loader would use, or a `stack.yaml` naming a waffle the registry does not carry.
 *
 * Scope, and the two deliberate exclusions:
 *   - **Absent registry ⇒ no problems at all.** A toolkit is allowed not to have one (a fork, a
 *     fixture); what it forfeits is this enforcement, not the ability to render. `validateToolkit`
 *     is toolkit-DEVELOPER lint, so the toolkit that ships a registry is the one that must keep it
 *     honest — and that this repo ships one is pinned by its own content test, not inferred here.
 *   - **Built-in stacks only.** `validateToolkit` loads `rootDir` alone, so an external `source:`
 *     stack never reaches this function; and `validateExternalStacks` deliberately does not call
 *     it. A third-party stack is governed by ITS toolkit's registry, and reddening a consumer's
 *     render because someone else's waffle is missing from OUR file would be nonsense.
 *   - **Syrup is out of scope.** `files/` payloads are addressed by output path and gated by
 *     `optIn:`; see the registry.mjs docblock.
 *
 * @param {string} rootDir toolkit root
 * @param {import('./toolkit.mjs').Toolkit} toolkit the loaded toolkit (its `registry` is read)
 * @returns {string[]} problems (empty = clean, or no registry to reconcile)
 */
export function validateRegistry(rootDir, toolkit) {
  const registry = toolkit.registry;
  if (!registry?.present) return [];
  const problems = [];
  const where = REGISTRY_FILE;

  // ── 1. Per-entry shape ────────────────────────────────────────────────────────────────────
  // Every check below reports against `<name> (kind)` where those are usable and the raw index
  // otherwise, so a nameless entry is still locatable in the file.
  const seen = new Map();
  for (const e of registry.entries) {
    const at = e.name && e.kind ? `${e.kind} "${e.name}"` : `entry #${e.index + 1}`;
    if (!e.raw || typeof e.raw !== 'object' || Array.isArray(e.raw)) {
      problems.push(`${where}: ${at} must be a mapping (name, kind, stack, path, status)`);
      continue;
    }
    if (e.unknownKeys.length) {
      problems.push(
        `${where}: ${at} has unknown key${e.unknownKeys.length > 1 ? 's' : ''} ` +
          `${e.unknownKeys.map((k) => `"${k}"`).join(', ')} (allowed: ${REGISTRY_ENTRY_KEYS.join(', ')})`,
      );
    }
    if (!e.name) problems.push(`${where}: ${at} is missing a \`name\``);
    if (!e.kind) {
      problems.push(`${where}: ${at} needs a \`kind\` of ${WAFFLE_KINDS.join(' or ')} (syrup files are not registered)`);
    }
    if (!e.status) {
      problems.push(`${where}: ${at} needs a \`status\` of ${WAFFLE_STATUSES.join(' | ')}`);
    }
    if (!e.name || !e.kind || !e.status) continue;

    const key = `${e.kind}/${e.name}`;
    if (seen.has(key)) {
      problems.push(`${where}: ${at} is registered twice (entries #${seen.get(key) + 1} and #${e.index + 1}) — a waffle has ONE entry`);
      continue;
    }
    seen.set(key, e.index);

    if (e.status === 'replaced') {
      // A tombstone names no live location — it exists precisely because there is none. A `stack:`
      // or `path:` on one would be a claim that outlives the thing it describes.
      for (const field of ['stack', 'path']) {
        if (e[field]) problems.push(`${where}: ${at} is \`replaced\`, so it must not declare a \`${field}\` — a tombstone names no location`);
      }
      if (!e.replacedBy) {
        problems.push(
          `${where}: ${at} is \`replaced\` but declares no \`replacedBy\` — that is the forward-fix a pinned ` +
            `consumer is carried across; a waffle removed outright should be deleted from the registry instead`,
        );
      }
      continue;
    }

    if (!LIVE_STATUSES.includes(e.status)) continue; // unreachable; keeps the narrowing honest
    if (e.replacedBy && e.status !== 'deprecated') {
      problems.push(`${where}: ${at} declares \`replacedBy\` but is \`${e.status}\` — only \`deprecated\` and \`replaced\` name a successor`);
    }
    if (!e.stack) problems.push(`${where}: ${at} is \`${e.status}\`, so it must declare the \`stack\` that owns it`);
    if (!e.path) problems.push(`${where}: ${at} is \`${e.status}\`, so it must declare its \`path\``);
    if (!e.stack) continue;

    // ── 2. Registry → stack.yaml → filesystem ───────────────────────────────────────────────
    const stack = toolkit.stacks.get(e.stack);
    if (!stack) {
      problems.push(`${where}: ${at} names stack "${e.stack}", which is not a stack in toolkit.yaml`);
      continue;
    }
    const expected = canonicalWafflePath(e.stack, e.kind, e.name);
    if (e.path && e.path !== expected) {
      problems.push(
        `${where}: ${at} records path "${e.path}" but a ${e.kind} of that name in stack "${e.stack}" ` +
          `is loaded from "${expected}" — the loader joins the bare manifest name under the stack dir, so no other path can be real`,
      );
    }
    if (!fs.existsSync(path.join(rootDir, expected))) {
      problems.push(`${where}: ${at} is registered at "${expected}", which does not exist — the waffle was moved or deleted without updating the registry`);
    }
    const refKind = refKindOf(e.kind);
    if (refKind && !itemsOfKind(stack, refKind).some((i) => i.name === e.name)) {
      problems.push(
        `${where}: ${at} is registered under stack "${e.stack}", but that stack's stack.yaml does not list it ` +
          `under \`${refKind}:\` — the registry and the manifest must agree on what the stack contains`,
      );
    }
  }

  // ── 3. Tombstone integrity ────────────────────────────────────────────────────────────────
  // A `replaced` entry claims the old name is GONE and names its successor. Both halves are
  // checked: a name that still resolves is not replaced (it is a duplicate that would shadow the
  // live waffle at the forwarding gate), and a `replacedBy` that resolves to nothing forwards a
  // pinned consumer into a second error.
  for (const e of registry.entries) {
    if (e.status !== 'replaced' || !e.name || !e.kind) continue;
    const at = `${e.kind} "${e.name}"`;
    const refKind = refKindOf(e.kind);
    const stillLive = refKind ? findItems(toolkit, refKind, e.name) : [];
    if (stillLive.length) {
      problems.push(
        `${where}: ${at} is \`replaced\`, but a ${e.kind} of that name still exists in stack ` +
          `"${stillLive[0].stackName}" — a tombstone is for a name that is gone`,
      );
    }
    if (!e.replacedBy) continue;
    const target = seen.has(`${e.kind}/${e.replacedBy}`)
      ? registry.entries.find((c) => c.kind === e.kind && c.name === e.replacedBy)
      : null;
    if (!target) {
      problems.push(`${where}: ${at} is replaced by "${e.replacedBy}", which is not a registered ${e.kind}`);
    } else if (target.status === 'wip') {
      problems.push(
        `${where}: ${at} is replaced by "${e.replacedBy}", which is \`wip\` — a consumer forwarded there ` +
          `would land on a waffle that is not offered`,
      );
    } else if (target.status === 'replaced' && !followsToLive(registry, e)) {
      problems.push(
        `${where}: ${at} is replaced by "${e.replacedBy}", whose own \`replacedBy\` chain does not end at a ` +
          `live waffle (a cycle, or a chain that is too long) — a pinned consumer would never be forwarded`,
      );
    }
  }

  // ── 4. Deprecation advice must resolve ────────────────────────────────────────────────────
  for (const e of registry.entries) {
    if (e.status !== 'deprecated' || !e.replacedBy || !e.name || !e.kind) continue;
    if (!seen.has(`${e.kind}/${e.replacedBy}`)) {
      problems.push(`${where}: ${e.kind} "${e.name}" is deprecated in favour of "${e.replacedBy}", which is not a registered ${e.kind}`);
    }
  }

  // ── 5. Filesystem/manifest → registry (the un-registered side) ────────────────────────────
  // Walked over both the MANIFEST and the DISK, because they catch different escapes: a waffle
  // listed in `stack.yaml` but absent from the registry, and a waffle sitting in a stack's
  // `agents/`/`skills/` directory that no manifest lists AND no registry entry covers — the exact
  // residue a half-finished move leaves behind.
  for (const [stackName, stack] of toolkit.stacks) {
    for (const [refKind, items] of [['agents', stack.agents], ['skills', stack.skills]]) {
      for (const item of /** @type {any[]} */ (items)) {
        if (!registry.live.has(`${stackName}::${refKind}/${item.name}`)) {
          problems.push(
            `${where}: stack "${stackName}" lists ${refKind}/${item.name} in stack.yaml, but it is not in the waffle ` +
              `registry — add an entry (status: stable, or wip while it is being written)`,
          );
        }
      }
    }
    for (const { kind, name } of wafflesOnDisk(stack.dir)) {
      const refKind = refKindOf(kind);
      if (refKind && !registry.live.has(`${stackName}::${refKind}/${name}`)) {
        problems.push(
          `${where}: ${canonicalWafflePath(stackName, kind, name)} exists on disk but is not in the waffle registry ` +
            `— register it, or delete it if it is the residue of a move`,
        );
      }
    }
  }

  // ── 6. A strict dependency on something that is never offered ─────────────────────────────
  // `requires:` is an authored PROMISE, resolved strictly — so an offered waffle promising a `wip`
  // one is a promise the render cannot keep: the dependent installs, its declared dependency is
  // gated out of every entry path, and nothing downstream notices. (The lenient agent-frontmatter
  // `skills:` list is deliberately NOT checked here — a grant-pointer at an absent skill is its
  // normal case, which is what lets an agent ship while its skill is still being written.)
  for (const [stackName, stack] of toolkit.stacks) {
    for (const [itemRef, deps] of Object.entries(stack.requires ?? {})) {
      const parsed = parseRef(itemRef);
      if (parsed.form === 'stack') continue; // `validateStack` already reports this
      if (waffleStatus(registry, stackName, parsed.kind, parsed.name) === 'wip') continue; // wip may need wip
      for (const dep of deps ?? []) {
        /** @type {import('./refs.mjs').DepNode} */
        let node;
        try {
          node = resolveDepStrict(toolkit, dep, stackName);
        } catch {
          continue; // a dangling requires: is `validateStack`'s report, not this one's
        }
        if (waffleStatus(registry, node.stack, node.kind, node.name) !== 'wip') continue;
        problems.push(
          `${where}: stack "${stackName}" declares requires[${itemRef}] → ${node.kind}/${node.name}, which is \`wip\` ` +
            `— an offered waffle cannot depend on one that is never installed; mark the dependent \`wip\` too, or ship the dependency`,
        );
      }
    }
  }

  return problems;
}

/**
 * Does this tombstone's `replacedBy` chain terminate at a registered, non-`replaced` waffle?
 * Mirrors `replacementFor`'s walk (same hop budget) but answers the question `validate` asks —
 * whether a forward is POSSIBLE — rather than producing the target.
 *
 * @param {import('./registry.mjs').Registry} registry
 * @param {import('./registry.mjs').RegistryEntry} start
 * @returns {boolean}
 */
function followsToLive(registry, start) {
  const kind = start.kind;
  const seen = new Set([start.name]);
  let next = start.replacedBy;
  for (let hop = 0; hop < 8; hop += 1) {
    if (!next || seen.has(next)) return false;
    seen.add(next);
    const entry = registry.entries.find((c) => c.kind === kind && c.name === next);
    if (!entry) return false;
    if (entry.status !== 'replaced') return true;
    next = entry.replacedBy;
  }
  return false;
}

/**
 * Every agent/skill directory entry physically present under a stack dir — `agents/<name>.md` and
 * `skills/<name>/`, one level deep, no recursion. Deliberately independent of `stack.yaml`: this
 * is the "what is actually on disk" half of the three-way reconcile, and reading the manifest to
 * find it would defeat the point. A stack with no `agents/` or no `skills/` dir yields nothing.
 *
 * @param {string} stackDir
 * @returns {{ kind: string, name: string }[]}
 */
function wafflesOnDisk(stackDir) {
  /** @type {{ kind: string, name: string }[]} */
  const found = [];
  const agentsDir = path.join(stackDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) found.push({ kind: 'agent', name: entry.name.slice(0, -3) });
    }
  }
  const skillsDir = path.join(stackDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push({ kind: 'skill', name: entry.name });
    }
  }
  return found;
}

/** Text extensions the control-byte lint scans; everything else under the roots is skipped. */
const SOURCE_TEXT_EXTS = new Set(['.mjs', '.md', '.yaml', '.yml', '.json', '.sh']);
/** Any control byte other than \t \n \r — the bytes that flip a file to "binary" for ripgrep. */
const CONTROL_BYTE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/**
 * Toolkit-source hygiene (#249): a raw control byte in a source file makes ripgrep classify it
 * as binary and silently skip it (the F3 NUL hid `waffledocs.mjs` from every `rg` search). Scan
 * the toolkit's own text sources for control bytes other than \t \n \r. Scoped to `installer/`
 * and `stacks/` under the toolkit root: the real instance was in installer/lib, so a stacks-only
 * check (the files the validator already walks) would not have caught it — and a full repo
 * walker (assets, schema, .github) is deliberately NOT added; this is the smallest scan that
 * covers the real regression surface. Fixture toolkits without these dirs skip cleanly.
 * Returns problems (empty = clean).
 */
export function validateSourceBytes(rootDir) {
  const problems = [];
  for (const dir of ['installer', 'stacks']) {
    const abs = path.join(rootDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const entry of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !SOURCE_TEXT_EXTS.has(path.extname(entry.name))) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      const text = fs.readFileSync(file, 'utf8');
      const m = CONTROL_BYTE_RE.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(
          `${path.relative(rootDir, file)}:${line} contains a raw control byte ` +
            `(U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) — ` +
            `use an escape sequence; raw control bytes make search tools treat the file as binary`,
        );
      }
    }
  }
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
      // Trust-boundary check, deliberately UNCONDITIONAL (not gated on an `identity:` block):
      // the dangerous case is exactly an agent with NO identity — the delegate skill then
      // title-cases the slug into `-c user.name="…"`, and it always plus-addresses the slug
      // into `-c user.email=`. See AGENT_SLUG_RE.
      if (typeof agent.name !== 'string' || !AGENT_SLUG_RE.test(agent.name)) {
        problems.push(
          `${ctx}: agent ${JSON.stringify(agent.name ?? null)} name does not match the allowed slug shape ` +
            `(letters, digits, ". _ -", at least one letter or digit) — the slug is a filename and lands in an agent-executed git command ` +
            `(-c user.email=bot+<slug>@…, and as the title-cased user.name fallback when identity.displayName is absent)`,
        );
      }
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
      // quote-breaking display name into an agent-executed command. The other operand of that
      // command — the agent slug — is enforced unconditionally at the top of this loop (#247),
      // because it reaches the command even when this whole block is skipped.
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
                `"/", no "//", no other scheme, no percent-encoding, no "@" userinfo, no ".." traversal)`,
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
    // Recommended external plugins (#199): pointers at harness plugins OUTSIDE this toolkit, which
    // `setup` offers to the user with the author's rationale. Nothing here is fetched, rendered, or
    // installed, so this lint guards the only thing that can go wrong — an offer the user cannot
    // act on. Each of the three required fields is one half of that: no `name` and there is nothing
    // to look for, no `source` and nowhere to look, no `why` and no reason to say yes (a wizard
    // pitching an unexplained third-party install is worse than one that stays quiet). The
    // `items:`/`targets:` scopes are linted like every other ref/target list so a typo mis-scopes
    // rather than silently widens. A malformed entry is reported here and skipped by the inventory
    // — never a load error: see the tolerance note in plugins.mjs.
    const pluginNames = new Set();
    for (const p of stack.recommendedPlugins ?? []) {
      const label = p.name ? `recommended plugin "${p.name}"` : `recommended plugin entry #${p.index + 1}`;
      if (!isPlainObject(p.raw)) {
        problems.push(`${ctx}: ${label} must be a mapping (name, source, why) — \`recommendedPlugins:\` is a list of them`);
        continue;
      }
      if (p.unknownKeys.length) {
        problems.push(
          `${ctx}: ${label} has unknown key${p.unknownKeys.length > 1 ? 's' : ''} ` +
            `${p.unknownKeys.map((k) => `"${k}"`).join(', ')} (allowed: ${PLUGIN_ENTRY_KEYS.join(', ')})`,
        );
      }
      if (!p.name) problems.push(`${ctx}: ${label} is missing a \`name\``);
      if (!p.source) {
        problems.push(`${ctx}: ${label} is missing a \`source\` — where the user gets the plugin (a marketplace ref or a URL)`);
      } else if (/\s/.test(p.source)) {
        problems.push(
          `${ctx}: ${label} \`source\` "${p.source}" contains whitespace — it must be a single marketplace ref or URL ` +
            `the user can act on; put the prose in \`why\``,
        );
      }
      if (!p.why) {
        problems.push(`${ctx}: ${label} is missing a \`why\` — the one-line rationale \`setup\` shows before offering it`);
      }
      if (p.name) {
        if (pluginNames.has(p.name)) problems.push(`${ctx}: ${label} is recommended twice — one entry per plugin`);
        pluginNames.add(p.name);
      }
      if (p.items === null && p.raw.items !== undefined) {
        problems.push(`${ctx}: ${label} \`items:\` must be a list of item refs in this stack`);
      }
      for (const ref of p.items ?? []) {
        const parsed = parseRef(ref);
        if (parsed.form === 'stack' || !itemsOfKind(stack, parsed.kind).some((i) => i.name === parsed.name)) {
          problems.push(`${ctx}: ${label} \`items:\` entry "${ref}" does not match a file/skill/agent in this stack`);
        }
      }
      if (p.targets === null && p.raw.targets !== undefined) {
        problems.push(`${ctx}: ${label} \`targets:\` must be a list of harness names (${VALID_TARGETS.join(', ')})`);
      }
      const badTargets = (p.targets ?? []).filter((t) => !(/** @type {string[]} */ (VALID_TARGETS)).includes(t));
      if (badTargets.length) {
        problems.push(
          `${ctx}: ${label} declares unknown target${badTargets.length > 1 ? 's' : ''} ` +
            `${badTargets.map((t) => `"${t}"`).join(', ')} (valid: ${VALID_TARGETS.join(', ')})`,
        );
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
      // `patternHint:` (#218) — the prose remedy printed when the guard fires. It must be a string,
      // and it is meaningless without a `pattern:` to explain: a hint on an unguarded key is an
      // authoring mistake that would silently never print.
      if (spec?.patternHint !== undefined) {
        if (typeof spec.patternHint !== 'string') {
          problems.push(`${ctx}: config key ${key} \`patternHint\` must be a string`);
        } else if (typeof spec.patternHint === 'string' && typeof spec?.pattern !== 'string') {
          problems.push(`${ctx}: config key ${key} declares a \`patternHint\` but no \`pattern\` — the hint would never print`);
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
            // The guard-record shape entryPatternProblems consumes (see makeGuard): the self-check
            // rejection then names this stack as the declarer, same as a render-time rejection.
            compiled.set(leaf, [makeGuard(pattern, `stack "${stack.name}"`)]);
          } catch (err) {
            problems.push(`${ctx}: config key ${key} has an invalid entryPattern for "${leaf}": ${err.message}`);
          }
        }
        if (spec.default !== undefined) {
          for (const problem of entryPatternProblems({ entryPatterns: new Map([[key, compiled]]) }, key, spec.default)) {
            problems.push(`${ctx}: config key ${key} default ${problem}`);
          }
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

    // An optional `targets:` on a files entry (#364) scopes a harness-specific payload to the
    // consumers who enabled that harness; absent, it renders unconditionally (the default, and what
    // a harness-independent `.github/` payload wants).
    //
    // There is deliberately NO `targets:` lint here. Every malformation of this field — a `target:`
    // singular typo, a non-list value, an EMPTY list, and an UNKNOWN NAME — is a hard LOAD error in
    // `loadToolkit`, so none of them can reach this lint. That is not a stylistic split: `targets:`
    // is the only manifest field whose malformation is DESTRUCTIVE (the render prunes every lock
    // path it no longer produces, so a mis-scoped entry DELETES an already-poured file out of a
    // consumer's tree), and `validate` is toolkit-developer lint that consumers never run over
    // built-in stacks — `render` imports only `validateExternalStacks`. A `validate`-only check
    // would have been no gate at all for a forked toolkit that does not run `validate` in CI.
    // `validate` still REPORTS every one of them, via the load error it catches, so the lint surface
    // does not go quiet. See the block comment in `toolkit.mjs` for why an unknown name is not inert.

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
