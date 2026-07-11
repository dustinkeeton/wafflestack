// @ts-check
/**
 * Ref grammar, toolkit-wide resolution, and dependency-closure logic shared by
 * `install`, `render`, and `validate`.
 *
 * A ref names something installable:
 *   - a stack:                  `github-workflow`
 *   - an item:                  `skills/issue`, `agents/project-manager`, `files/.github/workflows/ci.yml`
 *   - a stack-qualified item:   `engineering-team/skills/security-audit`
 * The qualified form disambiguates names defined in more than one stack.
 */

import path from 'node:path';

/** @import { Toolkit, Stack, Item } from './toolkit.mjs' */

/**
 * A REF kind — always PLURAL. Distinct from an item's intrinsic `kind` (`'agent'` | `'skill'` |
 * `'files'`), which is singular for agents and skills. See the note on toolkit.mjs's typedefs.
 * @typedef {'agents' | 'skills' | 'files'} ItemKind
 *
 * A raw ref parsed into its grammatical form — discriminated on `form`.
 * @typedef {{ form: 'qualified', stack: string, kind: ItemKind, name: string }
 *         | { form: 'item', kind: ItemKind, name: string }
 *         | { form: 'stack', name: string }} ParsedRef
 *
 * A ref resolved against the toolkit — discriminated on `type`.
 * @typedef {{ type: 'stack', name: string }
 *         | { type: 'item', kind: ItemKind, name: string, stack: string, item: Item,
 *             canonicalRef: string }} ResolvedRef
 *
 * A node in a dependency closure: an item, plus the stack it was resolved from.
 * @typedef {object} DepNode
 * @property {ItemKind} kind
 * @property {string} name
 * @property {string} stack the stack the item was resolved from
 * @property {Item} item
 *
 * @typedef {object} SelectionItem an item chosen for rendering
 * @property {string} stackName
 * @property {Stack} stack
 * @property {ItemKind} kind
 * @property {Item} item
 *
 * @typedef {object} Selection the result of `computeSelection`
 * @property {SelectionItem[]} items deduped by stack+kind+name, eject-filtered
 * @property {{ rootRef: string, deps: string[] }[]} closures pulled-in dependencies, for reporting
 * @property {string[]} errors resolution errors (unknown stack, unknown/ambiguous ref)
 */

/**
 * Predicate matching the repo-relative output paths a rendered item owns, across ALL targets
 * (claude/codex/agents-dir) — the inverse of the render's item→path mapping. A `files/` item is
 * its own single repo-relative path (matched exactly, so `scripts/build` never sweeps up
 * `scripts/build.mjs`); an agent or skill expands to its per-target render dirs. Deliberately
 * target-blind: a lock only holds paths for the *enabled* targets, so an over-broad pattern set
 * can never over-match — it just finds whichever of an item's paths the lock actually tracks.
 * Shared by `eject` (drop an item's files from the lock) and `list` (drift-check them).
 *
 * @param {ItemKind} kind
 * @param {string} name
 * @returns {(rel: string) => boolean} predicate over repo-relative output paths
 */
export function itemOutputMatcher(kind, name) {
  if (kind === 'files') return (rel) => rel === name;
  const patterns =
    kind === 'agents'
      ? [
          path.join('.claude', 'agents', `${name}.md`),
          path.join('.codex', 'agents', `${name}.toml`),
          path.join('.agents', 'agents', `${name}.md`),
        ]
      : [path.join('.claude', 'skills', name) + path.sep, path.join('.agents', 'skills', name) + path.sep];
  return (rel) => patterns.some((p) => rel === p || rel.startsWith(p));
}

/**
 * Normalize an item ref's prefix: skill/skill:/skills → `skills/`, agent… → `agents/`, file… → `files/`.
 *
 * @param {string} ref
 * @returns {string}
 */
export function normalizeItemRef(ref) {
  return ref.replace(/^(agent|skill|file)s?[:/]/, (_m, kind) => `${kind}s/`);
}

/**
 * The agents, skills, or files array of a stack, selected by kind.
 *
 * @param {Stack} stack
 * @param {ItemKind} kind
 * @returns {Item[]} widened to the Item union so callers get one uniform element type
 */
export function itemsOfKind(stack, kind) {
  if (kind === 'agents') return stack.agents;
  if (kind === 'files') return stack.files;
  return stack.skills;
}

/**
 * Every (stackName, item) pair of `kind` across the toolkit that is named `name`.
 *
 * @param {Toolkit} toolkit
 * @param {ItemKind} kind
 * @param {string} name
 * @returns {{ stackName: string, item: Item }[]}
 */
export function findItems(toolkit, kind, name) {
  /** @type {{ stackName: string, item: Item }[]} */
  const matches = [];
  for (const [stackName, stack] of toolkit.stacks) {
    const item = itemsOfKind(stack, kind).find((i) => i.name === name);
    if (item) matches.push({ stackName, item });
  }
  return matches;
}

/**
 * Parse a raw ref into one of:
 *   { form: 'qualified', stack, kind, name }   — `<stack>/(agents|skills|files)/<name>`
 *   { form: 'item', kind, name }               — `(agents|skills|files)[:/]<name>`
 *   { form: 'stack', name }                    — anything else (a stack name)
 *
 * The `kind` casts are safe by construction: each regex alternates over exactly the three
 * ItemKind literals, so a captured group can only be one of them — tsc just can't see that
 * through a capture group.
 *
 * @param {string} raw
 * @returns {ParsedRef}
 */
export function parseRef(raw) {
  const ref = String(raw).trim();
  const qualified = /^([^/]+)\/(agents|skills|files)\/(.+)$/.exec(ref);
  if (qualified) return { form: 'qualified', stack: qualified[1], kind: /** @type {ItemKind} */ (qualified[2]), name: qualified[3] };
  const item = /^(agents|skills|files)\/(.+)$/.exec(normalizeItemRef(ref));
  if (item) return { form: 'item', kind: /** @type {ItemKind} */ (item[1]), name: item[2] };
  return { form: 'stack', name: ref };
}

/**
 * @param {Toolkit} toolkit
 * @returns {string[]} every `kind/name` item ref in the toolkit, sorted
 */
function availableItemRefs(toolkit) {
  const refs = new Set();
  for (const stack of toolkit.stacks.values()) {
    for (const a of stack.agents) refs.add(`agents/${a.name}`);
    for (const s of stack.skills) refs.add(`skills/${s.name}`);
    for (const f of stack.files) refs.add(`files/${f.name}`);
  }
  return [...refs].sort();
}

/**
 * Resolve a single ref against the whole toolkit.
 * Returns { type: 'stack', name } or
 *         { type: 'item', kind, name, stack, item, canonicalRef }.
 * `canonicalRef` is the minimal ref that re-resolves uniquely: unqualified when the
 * name is unique toolkit-wide, stack-qualified when it is not.
 * Throws with an actionable message on unknown or ambiguous refs.
 *
 * @param {Toolkit} toolkit
 * @param {string} raw
 * @returns {ResolvedRef}
 * @throws on an unknown or ambiguous ref
 */
export function resolveRef(toolkit, raw) {
  const parsed = parseRef(raw);
  const stackNames = [...toolkit.stacks.keys()].join(', ');

  if (parsed.form === 'stack') {
    if (toolkit.stacks.has(parsed.name)) return { type: 'stack', name: parsed.name };
    throw new Error(
      `unknown ref "${raw}": no such stack (have: ${stackNames}). ` +
      `To install a single item, prefix it: skills/${parsed.name} or agents/${parsed.name}.`,
    );
  }

  if (parsed.form === 'qualified') {
    const stack = toolkit.stacks.get(parsed.stack);
    if (!stack) throw new Error(`unknown stack "${parsed.stack}" in ref "${raw}" (have: ${stackNames})`);
    const item = itemsOfKind(stack, parsed.kind).find((i) => i.name === parsed.name);
    if (!item) {
      const have = itemsOfKind(stack, parsed.kind).map((i) => `${parsed.stack}/${parsed.kind}/${i.name}`);
      throw new Error(
        `unknown ref "${raw}": stack "${parsed.stack}" has no ${singular(parsed.kind)} "${parsed.name}" ` +
        `(has: ${have.join(', ') || '(none)'})`,
      );
    }
    const ambiguous = findItems(toolkit, parsed.kind, parsed.name).length > 1;
    return {
      type: 'item',
      kind: parsed.kind,
      name: parsed.name,
      stack: parsed.stack,
      item,
      canonicalRef: ambiguous ? `${parsed.stack}/${parsed.kind}/${parsed.name}` : `${parsed.kind}/${parsed.name}`,
    };
  }

  const matches = findItems(toolkit, parsed.kind, parsed.name);
  if (matches.length === 0) {
    throw new Error(
      `unknown ref "${raw}": no ${singular(parsed.kind)} "${parsed.name}" in the toolkit. ` +
      `Available items: ${availableItemRefs(toolkit).join(', ')}`,
    );
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.stackName}/${parsed.kind}/${parsed.name}`);
    throw new Error(`ambiguous ref "${raw}": defined in multiple stacks — qualify it (${candidates.join(' | ')})`);
  }
  return {
    type: 'item',
    kind: parsed.kind,
    name: parsed.name,
    stack: matches[0].stackName,
    item: matches[0].item,
    canonicalRef: `${parsed.kind}/${parsed.name}`,
  };
}

/**
 * Strictly resolve a dependency ref (an entry in a stack's `requires:`), preferring
 * the declaring item's own stack for bare names, then a unique toolkit-wide match.
 * Throws on unknown or ambiguous refs — `requires:` is authored, so a dangling entry
 * is a toolkit bug.
 *
 * @param {Toolkit} toolkit
 * @param {string} refString
 * @param {string} preferStack the declaring item's own stack, preferred for a bare name
 * @returns {DepNode}
 * @throws on an unknown or ambiguous dependency ref
 */
export function resolveDepStrict(toolkit, refString, preferStack) {
  const parsed = parseRef(refString);
  if (parsed.form === 'stack') {
    throw new Error(`invalid dependency "${refString}" — must be skills/<name> or agents/<name>`);
  }
  if (parsed.form === 'qualified') {
    const stack = toolkit.stacks.get(parsed.stack);
    const item = stack && itemsOfKind(stack, parsed.kind).find((i) => i.name === parsed.name);
    if (!item) throw new Error(`cannot resolve dependency "${refString}" — no ${parsed.kind}/${parsed.name} in stack "${parsed.stack}"`);
    return { kind: parsed.kind, name: parsed.name, stack: parsed.stack, item };
  }
  const own = toolkit.stacks.get(preferStack);
  const ownItem = own && itemsOfKind(own, parsed.kind).find((i) => i.name === parsed.name);
  if (ownItem) return { kind: parsed.kind, name: parsed.name, stack: preferStack, item: ownItem };
  const matches = findItems(toolkit, parsed.kind, parsed.name);
  if (matches.length === 0) throw new Error(`cannot resolve dependency "${refString}" — no such item in the toolkit`);
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.stackName}/${parsed.kind}/${parsed.name}`);
    throw new Error(`ambiguous dependency "${refString}" (${candidates.join(', ')}) — qualify it as <stack>/${parsed.kind}/${parsed.name}`);
  }
  return { kind: parsed.kind, name: parsed.name, stack: matches[0].stackName, item: matches[0].item };
}

/**
 * Leniently resolve an agent frontmatter `skills:` entry (a bare skill name). Agent
 * skill lists are harness grant-pointers that may reference skills provided outside
 * this toolkit (project-local, or not yet authored), so an unresolved name is not an
 * error — it is simply skipped. Prefers the agent's own stack, then a unique
 * toolkit-wide match. Returns the resolved item or null (unknown or ambiguous).
 *
 * @param {Toolkit} toolkit
 * @param {string} name a bare skill name
 * @param {string} preferStack the agent's own stack
 * @returns {DepNode | null} null when unknown OR ambiguous — deliberately lenient
 */
export function resolveAgentSkill(toolkit, name, preferStack) {
  const own = toolkit.stacks.get(preferStack);
  const ownItem = own && own.skills.find((s) => s.name === name);
  if (ownItem) return { kind: 'skills', name, stack: preferStack, item: ownItem };
  const matches = findItems(toolkit, 'skills', name);
  if (matches.length === 1) return { kind: 'skills', name, stack: matches[0].stackName, item: matches[0].item };
  return null;
}

/**
 * Direct dependencies of a resolved item: agent frontmatter `skills:` + stack `requires:`.
 *
 * @param {Toolkit} toolkit
 * @param {DepNode} node
 * @returns {DepNode[]}
 */
function directDeps(toolkit, node) {
  const stack = toolkit.stacks.get(node.stack);
  /** @type {DepNode[]} */
  const deps = [];
  if (node.kind === 'agents') {
    const agent = stack.agents.find((a) => a.name === node.name);
    for (const skillName of agent?.data?.skills ?? []) {
      const dep = resolveAgentSkill(toolkit, skillName, node.stack);
      if (dep) deps.push(dep);
    }
  }
  for (const ref of stack.requires?.[`${node.kind}/${node.name}`] ?? []) {
    deps.push(resolveDepStrict(toolkit, ref, node.stack));
  }
  return deps;
}

/**
 * Transitive, cross-stack dependency closure of a resolved item, breadth-first, with
 * the root first. Each node is { kind, name, stack, item }. Dedup is by
 * stack+kind+name so the same item pulled via two paths appears once.
 *
 * @param {Toolkit} toolkit
 * @param {DepNode} root
 * @returns {DepNode[]} breadth-first, root first
 */
export function closureFor(toolkit, root) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {DepNode[]} */
  const order = [];
  /** @type {DepNode[]} */
  const queue = [{ kind: root.kind, name: root.name, stack: root.stack, item: root.item }];
  while (queue.length) {
    const node = queue.shift();
    const key = `${node.stack}::${node.kind}/${node.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(node);
    for (const dep of directDeps(toolkit, node)) queue.push(dep);
  }
  return order;
}

/**
 * The non-root dependency refs of a closure, as `kind/name` strings (for CLI output).
 *
 * @param {Toolkit} toolkit
 * @param {DepNode} root
 * @returns {string[]}
 */
export function closureDeps(toolkit, root) {
  return closureFor(toolkit, root)
    .filter((n) => !(n.stack === root.stack && n.kind === root.kind && n.name === root.name))
    .map((n) => `${n.kind}/${n.name}`);
}

/**
 * Does an `include:` entry (qualified or not) refer to the given kind/name?
 *
 * @param {string} includeRef
 * @param {ItemKind} kind
 * @param {string} name
 * @returns {boolean}
 */
export function includeRefMatches(includeRef, kind, name) {
  const parsed = parseRef(includeRef);
  return parsed.form !== 'stack' && parsed.kind === kind && parsed.name === name;
}

/**
 * The full set of items to render:
 *   union(items of enabled `stacks:`) ∪ closure(each `include:` item) − `eject:`
 * `trackedFiles` is the set of repo-relative paths the previous lock managed (`oldLock.files`
 * keys); it lets an **opt-in** item a repo already renders keep updating even though a fresh
 * stack expansion would gate it out.
 * Returns:
 *   items:    [{ stackName, stack, kind, item }] deduped by stack+kind+name, eject-filtered
 *   closures: [{ rootRef, deps: [kind/name…] }] for reporting pulled-in dependencies
 *   errors:   resolution errors (unknown stack, unknown/ambiguous ref)
 *
 * @param {Toolkit} toolkit
 * @param {import('./project.mjs').ProjectConfig} project
 * @param {Set<string>} [trackedFiles] repo-relative paths the previous lock managed
 * @returns {Selection}
 */
export function computeSelection(toolkit, project, trackedFiles = new Set()) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, SelectionItem>} */
  const chosen = new Map();
  /** @type {(stackName: string, kind: ItemKind, item: Item) => void} */
  const addItem = (stackName, kind, item) => {
    const key = `${stackName}::${kind}/${item.name}`;
    if (!chosen.has(key)) chosen.set(key, { stackName, stack: toolkit.stacks.get(stackName), kind, item });
  };
  /** @type {(stackName: string) => void} */
  const addStack = (stackName) => {
    const stack = toolkit.stacks.get(stackName);
    for (const a of stack.agents) addItem(stackName, 'agents', a);
    for (const s of stack.skills) addItem(stackName, 'skills', s);
    for (const f of stack.files) {
      // Opt-in syrup is poured on request only: a stack's default expansion skips an opt-in
      // file unless the repo already tracks its path in the lock (an existing install keeps
      // getting updates). An explicit `include:` of the file ref bypasses this gate — it is
      // added via the closure loop below, whose root is the file itself.
      if (stack.optIn.has(`files/${f.name}`) && !trackedFiles.has(f.name)) continue;
      addItem(stackName, 'files', f);
    }
  };

  for (const stackName of project.stacks) {
    if (!toolkit.stacks.has(stackName)) {
      errors.push(`stack "${stackName}" not found in toolkit (have: ${[...toolkit.stacks.keys()].join(', ')})`);
      continue;
    }
    addStack(stackName);
  }

  /** @type {{ rootRef: string, deps: string[] }[]} */
  const closures = [];
  for (const ref of project.include ?? []) {
    /** @type {ResolvedRef} */
    let resolved;
    try {
      resolved = resolveRef(toolkit, ref);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    if (resolved.type === 'stack') {
      addStack(resolved.name);
      continue;
    }
    /** @type {DepNode[]} */
    let closure;
    try {
      closure = closureFor(toolkit, resolved);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    for (const node of closure) addItem(node.stack, node.kind, node.item);
    closures.push({
      rootRef: `${resolved.kind}/${resolved.name}`,
      deps: closure
        .filter((n) => !(n.stack === resolved.stack && n.kind === resolved.kind && n.name === resolved.name))
        .map((n) => `${n.kind}/${n.name}`),
    });
  }

  const ejected = new Set((project.eject ?? []).map(normalizeItemRef));
  const items = [...chosen.values()].filter((c) => !ejected.has(`${c.kind}/${c.item.name}`));
  return { items, closures, errors };
}

/**
 * Opt-in syrup companions that pair with a selected item but were gated out of the render.
 *
 * A stack declares its opt-in syrup's companion waffle with a `requires: [kind/name]` edge —
 * installing the syrup pulls the companion (`directDeps`). The render only ever walks that
 * edge forward, so installing the companion *skill* (or enabling its whole stack) never
 * surfaces the syrup it pairs with: the flow lands half-installed and silent (issue #74). This
 * walks the edge in REVERSE. For every opt-in syrup file a stack-in-the-selection did NOT
 * render, if any waffle it `requires:` IS in the selection, the syrup is a skipped companion of
 * that selection.
 *
 * Scope is the stacks that actually contribute selected items — a companion selected from
 * stack X means X is in that set, so no relevant pairing is missed, and syrup from an
 * uninvolved stack is never suggested.
 *
 * @param {Toolkit} toolkit loaded toolkit
 * @param {Selection} selection a `computeSelection` result ({ items, … })
 * @returns {{ fileRef: string, stackName: string, companions: string[] }[]} one entry per skipped
 *   syrup file, `companions` naming the selected waffles that pull it into relevance. `fileRef` is
 *   a ready `wafflestack install <fileRef>` argument. Deterministic order (stack, then manifest).
 */
export function skippedSyrupCompanions(toolkit, selection) {
  const selectedRefs = new Set(selection.items.map((i) => `${i.kind}/${i.item.name}`));
  const stacksInSelection = new Set(selection.items.map((i) => i.stackName));
  /** @type {{ fileRef: string, stackName: string, companions: string[] }[]} */
  const results = [];
  for (const stackName of stacksInSelection) {
    const stack = toolkit.stacks.get(stackName);
    if (!stack) continue;
    for (const f of stack.files) {
      const fileRef = `files/${f.name}`;
      if (!stack.optIn.has(fileRef)) continue; // only opt-in syrup is silently gated
      if (selectedRefs.has(fileRef)) continue; // already poured (explicitly included or tracked)
      /** @type {string[]} */
      const companions = [];
      for (const ref of stack.requires?.[fileRef] ?? []) {
        /** @type {DepNode} */
        let dep;
        try {
          dep = resolveDepStrict(toolkit, ref, stackName);
        } catch {
          continue; // a dangling requires is a toolkit bug validate reports; skip it here
        }
        const depRef = `${dep.kind}/${dep.name}`;
        if (selectedRefs.has(depRef)) companions.push(depRef);
      }
      if (companions.length) results.push({ fileRef, stackName, companions });
    }
  }
  return results;
}

/**
 * @param {ItemKind} kind
 * @returns {string} the kind, singular, for an error message
 */
function singular(kind) {
  if (kind === 'agents') return 'agent';
  if (kind === 'files') return 'file';
  return 'skill';
}
