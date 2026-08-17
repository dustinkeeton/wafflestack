import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { placeholderKeys, compilePattern, makeGuard, entryPatternProblems } from './template.mjs';
import { parseFrontmatter } from './util.mjs';
import { findItems, itemsOfKind, parseRef, resolveDepStrict } from './refs.mjs';
import { PREREQ_KINDS, PREREQ_LEVELS } from './prerequisites.mjs';
import { HARNESS_BUILTINS, HARNESS_PATTERNS } from './project.mjs';
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
 * Allowlist for an agent's `identity.displayName` (#156) — the same shape as the `git.botName`
 * pattern, because the value lands in the same place: inside the double quotes of `-c
 * user.name="…"` in an agent-executed shell command.
 */
const DISPLAY_NAME_RE = compilePattern('(?!.*\\$\\{\\{)[A-Za-z0-9._\\[\\]-]+(?: [A-Za-z0-9._\\[\\]-]+)*');

/**
 * Allowlist for the agent slug (#247), which is also its filename. The slug reaches the same
 * agent-executed git command as `displayName`: always plus-addressed into `-c user.email=`, and
 * title-cased into `-c user.name="…"` when `identity.displayName` is absent — the case where
 * DISPLAY_NAME_RE never runs. The lookahead forces one letter or digit, so a separator-only slug
 * cannot title-case to an empty `user.name`.
 */
const AGENT_SLUG_RE = compilePattern('(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+');

/**
 * Allowlist for an agent's `identity.avatar` (#157) — an `https://` URL or a repo-relative path,
 * and nothing else. The alternatives stay separate because each bans what the other must allow:
 * the URL class excludes `@`, so userinfo cannot spoof the displayed host, and the path class
 * excludes `:` and `%`, so no scheme parses and no encoding slips past the `..`/`%40` lookaheads.
 */
const IDENTITY_AVATAR_RE = compilePattern(
  '(?!.*\\$\\{\\{)(?!.*\\.\\.)(?!.*%40)(?:https://[A-Za-z0-9._~/?#!&=+*%-]+|[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)',
);

const IDENTITY_KEYS = ['displayName', 'avatar'];

/**
 * Agent frontmatter keys the renderer owns and the `claude:` passthrough may NOT shadow (#156):
 * `claude:` hoists its keys to the top level of the render, so a passthrough copy of a validated
 * key would overwrite the checked one. Enforced here and stripped again in `renderAgent`.
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
 * Reconcile the waffle registry against the filesystem and against every `stack.yaml` (#335), so
 * that a three-way divergence — a rename or a move landed halfway — is a red here. Built-in stacks
 * only: an external stack is governed by ITS toolkit's registry, and syrup is out of scope.
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
  // Walked over both the manifest and the disk: they catch different escapes, and disk-only is the
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
  // The lenient agent-frontmatter `skills:` list is deliberately NOT checked here: a grant-pointer
  // at an absent skill is its normal case, and is what lets an agent ship before its skill exists.
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
 * Mirrors `replacementFor`'s walk, hop budget included.
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
 * Every agent/skill directory entry physically present under a stack dir, one level deep. It must
 * stay independent of `stack.yaml` — this is the on-disk half of the three-way reconcile.
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
 * Toolkit-source hygiene (#249): a raw control byte makes ripgrep classify a source file as binary
 * and silently skip it, so scan `installer/` and `stacks/` for any but \t \n \r.
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
 * Lint the reserved `harness.*` injection guards (#131) — resolved from HARNESS_BUILTINS rather
 * than a stack's `config:`, so their guards live in HARNESS_PATTERNS and are checked here instead
 * of in `validateStack`. Toolkit-global, so it runs once.
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
    // A built-in is a scalar or a per-target map; a value carrying {{placeholders}} resolves at render.
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
 * Enforce the external-source trust boundary at install/render time (#126): the same lint over
 * every stack carrying a `provenance` record. Resolution sees the full merged toolkit, but only
 * external stacks' problems are reported — a consumer can neither cause nor fix a built-in one.
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
 * Lint a single loaded stack against its containing (possibly multi-root) toolkit. `ctx` prefixes
 * each problem, so the same checks serve `validate` and the install-time external gate.
 */
export function validateStack(toolkit, stack, ctx = `stack ${stack.name}`) {
  const problems = [];
  {
    if (!stack.description) problems.push(`${ctx}: missing description`);

    const usedKeys = new Set();
    for (const agent of stack.agents) {
      // Deliberately unconditional, never gated on an `identity:` block: the dangerous case is an
      // agent with NO identity, whose slug is what reaches the git command. See AGENT_SLUG_RE.
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
      // An absent skill name is allowed (it may be project-local or unwritten), but an ambiguous
      // one is not: agent frontmatter has no way to qualify a name across stacks.
      for (const skillName of agent.data.skills ?? []) {
        if (stack.skills.some((s) => s.name === skillName)) continue;
        const matches = findItems(toolkit, 'skills', skillName);
        if (matches.length > 1) {
          const where = matches.map((m) => `${m.stackName}/skills/${skillName}`).join(', ');
          problems.push(`${ctx}: agent ${agent.name} skill "${skillName}" is ambiguous across stacks (${where})`);
        }
      }
      // The optional `identity:` block (#156) is a trust boundary, not a shape check: external
      // stacks reach it through `validateExternalStacks` at render time.
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
      // Reserved keys are rejected outright rather than validated twice: a passthrough copy of a
      // key with a first-class home would silently win over the checked one.
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
      for (const k of placeholderKeys(agent.body)) usedKeys.add(k);
      for (const k of placeholderKeys(agent.data.description ?? '')) usedKeys.add(k);
    }

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
    // Each `optIn:` entry must name a real item, so a typo cannot silently un-gate a file.
    for (const ref of stack.optIn) {
      const parsed = parseRef(ref);
      if (parsed.form === 'stack' || !itemsOfKind(stack, parsed.kind).some((i) => i.name === parsed.name)) {
        problems.push(`${ctx}: optIn entry "${ref}" does not match a file/skill/agent in this stack`);
      }
    }
    // Typed external prerequisites (#129), with the same anti-typo rule for any `items:` ref.
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

    // Optional per-key `pattern:`: the regex must compile, and a static string default must satisfy
    // it — nested and non-string defaults resolve at render, so they are skipped here.
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
      // A `patternHint:` (#218) without a `pattern:` to explain would silently never print.
      if (spec?.patternHint !== undefined) {
        if (typeof spec.patternHint !== 'string') {
          problems.push(`${ctx}: config key ${key} \`patternHint\` must be a string`);
        } else if (typeof spec.patternHint === 'string' && typeof spec?.pattern !== 'string') {
          problems.push(`${ctx}: config key ${key} declares a \`patternHint\` but no \`pattern\` — the hint would never print`);
        }
      }
      // `entryPatterns:` (#156) — the map-valued sibling of `pattern:`, held to the same two rules.
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
            // The guard-record shape `entryPatternProblems` consumes (see `makeGuard`).
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

    // A files entry's `targets:` (#364) is deliberately NOT linted here: every malformation of it
    // is a hard load error in `loadToolkit`, which is a gate a forked toolkit cannot skip.

    // Text `files/` payloads are templated just like skills; binaries are byte-copied, so skip them.
    for (const file of stack.files) {
      if (file.binary) continue;
      for (const k of placeholderKeys(fs.readFileSync(file.path, 'utf8'))) usedKeys.add(k);
    }

    for (const key of usedKeys) {
      // `harness.*` is a reserved namespace resolved per target, never declared in stack config.
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
 * Undeclared {{...}} text is usually third-party template syntax that must pass through, so only
 * dotted lowercase keys — the toolkit's config-key convention — are flagged.
 */
function looksLikeConfigKey(key) {
  return /^[a-z][\w-]*(\.[\w-]+)+$/.test(key);
}
