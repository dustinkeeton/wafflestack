// @ts-check
/**
 * Ref grammar, toolkit-wide resolution, and dependency-closure logic shared by
 * `install`, `render`, and `validate`.
 */

import path from 'node:path';
import { VALID_TARGETS } from './project.mjs';
import { isWaffleWip, replacementFor } from './registry.mjs';

/** @import { Toolkit, Stack, Item } from './toolkit.mjs' */

/**
 * A REF kind — always PLURAL, distinct from an item's intrinsic singular `kind`.
 * @typedef {'agents' | 'skills' | 'files'} ItemKind
 *
 * @typedef {{ form: 'qualified', stack: string, kind: ItemKind, name: string }
 *         | { form: 'item', kind: ItemKind, name: string }
 *         | { form: 'stack', name: string }} ParsedRef
 *
 * A ref resolved against the toolkit — discriminated on `type`. `forwardedFrom` is the ref the
 * caller ASKED for, present only when the registry forwarded a `replaced` waffle (#335).
 * @typedef {{ type: 'stack', name: string }
 *         | { type: 'item', kind: ItemKind, name: string, stack: string, item: Item,
 *             canonicalRef: string, forwardedFrom?: string }} ResolvedRef
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
 * @property {string[]} targets the enabled targets this selection was filtered by — carried on the
 *   result so a downstream consumer cannot judge scope against a DIFFERENT target set (#364)
 * @property {{ ref: string, targets: string[] }[]} targetSkipped explicitly `include:`d `files/`
 *   items whose declared `targets:` are all disabled here, so nothing renders (#364)
 * @property {{ from: string, to: string, via: string[] }[]} forwarded `include:` refs the registry
 *   forwarded to a renamed waffle's successor (#335) — the render proceeds, but the pin is stale
 * @property {{ ref: string, requiredBy: string, stackName: string, targets: string[], optIn: boolean }[]}
 *   targetBrokenRequires a SELECTED item's `requires:` edge landing on a `files/` item the scope
 *   filtered out, eject-filtered on both ends. `optIn` = the dependency is opt-in syrup in its own
 *   stack, so enabling one of its targets is necessary but NOT sufficient to render it
 */

/**
 * Predicate matching the repo-relative output paths a rendered item owns, across ALL targets — the
 * inverse of the render's item→path mapping. Deliberately target-blind: a lock only holds paths for
 * the *enabled* targets, so an over-broad pattern set can never over-match.
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
 * The `kind` casts are safe by construction: each regex alternates over exactly the three ItemKind
 * literals, which tsc cannot see through a capture group.
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
 * Is this waffle gated out of every consumer-facing surface by the registry (#335)? A toolkit with
 * no registry is uniformly ungated, rather than each call site remembering to check.
 *
 * @param {Toolkit} toolkit
 * @param {string} stackName the stack the item was resolved FROM — a name is not toolkit-unique,
 *   and one stack's `wip` waffle must not gate another stack's waffle of the same name
 * @param {ItemKind} kind
 * @param {string} name
 * @returns {boolean}
 */
export function isWipWaffle(toolkit, stackName, kind, name) {
  return isWaffleWip(toolkit?.registry, stackName, kind, name);
}

/**
 * @param {Toolkit} toolkit
 * @returns {string[]} every INSTALLABLE `kind/name` item ref in the toolkit, sorted; `wip` waffles
 *   are omitted (#335), since this list is the remedy printed on an unknown ref
 */
function availableItemRefs(toolkit) {
  const refs = new Set();
  for (const [stackName, stack] of toolkit.stacks) {
    for (const a of stack.agents) if (!isWipWaffle(toolkit, stackName, 'agents', a.name)) refs.add(`agents/${a.name}`);
    for (const s of stack.skills) if (!isWipWaffle(toolkit, stackName, 'skills', s.name)) refs.add(`skills/${s.name}`);
    for (const f of stack.files) refs.add(`files/${f.name}`);
  }
  return [...refs].sort();
}

/**
 * The error a consumer-facing resolution raises when a ref names a `wip` waffle (#335) — such a
 * waffle is present in the repo, so "unknown ref" would send the reader looking for a typo.
 *
 * @param {string} raw the ref as the consumer wrote it
 * @param {ItemKind} kind
 * @param {string} name
 * @returns {Error}
 */
function wipRefError(raw, kind, name) {
  return new Error(
    `waffle "${kind}/${name}" is marked work-in-progress in the toolkit's waffle registry and is not ` +
      `available to install (ref "${raw}"). It exists in the toolkit source but is not offered yet; ` +
      `it becomes installable when its registry status moves to \`stable\`.`,
  );
}

/**
 * Resolve a single ref against the whole toolkit. `canonicalRef` is the minimal ref that re-resolves
 * uniquely: unqualified when the name is unique toolkit-wide, stack-qualified when it is not.
 *
 * The CONSUMER-FACING resolver, so the registry's two consumer rules apply here (#335): a `replaced`
 * waffle is FORWARDED to its successor (carrying `forwardedFrom`), a `wip` one is REFUSED.
 *
 * @param {Toolkit} toolkit
 * @param {string} raw
 * @returns {ResolvedRef}
 * @throws on an unknown, ambiguous, or work-in-progress ref
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

  // Forwarded before anything else looks on disk (#335): a tombstone exists exactly BECAUSE the old
  // name is gone, and a qualified ref's stack is equally stale — hence the unqualified re-resolve.
  const forward = replacementFor(toolkit?.registry, parsed.kind, parsed.name);
  if (forward) {
    const resolved = resolveRef(toolkit, forward.ref);
    if (resolved.type !== 'item') return resolved; // unreachable: a forward target is always an item ref
    return { ...resolved, forwardedFrom: `${parsed.kind}/${parsed.name}` };
  }

  if (parsed.form === 'qualified') {
    const stack = toolkit.stacks.get(parsed.stack);
    if (!stack) throw new Error(`unknown stack "${parsed.stack}" in ref "${raw}" (have: ${stackNames})`);
    const item = itemsOfKind(stack, parsed.kind).find((i) => i.name === parsed.name);
    if (!item) {
      const have = itemsOfKind(stack, parsed.kind)
        .filter((i) => !isWipWaffle(toolkit, parsed.stack, parsed.kind, i.name))
        .map((i) => `${parsed.stack}/${parsed.kind}/${i.name}`);
      throw new Error(
        `unknown ref "${raw}": stack "${parsed.stack}" has no ${singular(parsed.kind)} "${parsed.name}" ` +
        `(has: ${have.join(', ') || '(none)'})`,
      );
    }
    if (isWipWaffle(toolkit, parsed.stack, parsed.kind, parsed.name)) throw wipRefError(raw, parsed.kind, parsed.name);
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

  const allMatches = findItems(toolkit, parsed.kind, parsed.name);
  // A `wip` waffle is not a CANDIDATE, so it is filtered BEFORE the count decides between
  // unknown / ambiguous / unique — one `wip` plus one `stable` of a name is not ambiguous.
  const matches = allMatches.filter((m) => !isWipWaffle(toolkit, m.stackName, parsed.kind, parsed.name));
  if (matches.length === 0) {
    // Everything that matched was gated: say WHY, rather than sending the reader after a typo.
    if (allMatches.length) throw wipRefError(raw, parsed.kind, parsed.name);
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
 * Strictly resolve a dependency ref (an entry in a stack's `requires:`), preferring the declaring
 * item's own stack for bare names. `requires:` is authored, so a dangling entry is a toolkit bug.
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
 * Leniently resolve an agent frontmatter `skills:` entry (a bare skill name). Agent skill lists are
 * harness grant-pointers that may name skills provided outside this toolkit, so an unresolved name
 * is skipped rather than an error. A `wip` skill (#335) is the same absence and is skipped too.
 *
 * @param {Toolkit} toolkit
 * @param {string} name a bare skill name
 * @param {string} preferStack the agent's own stack
 * @returns {DepNode | null} null when unknown, ambiguous, OR work-in-progress — deliberately lenient
 */
export function resolveAgentSkill(toolkit, name, preferStack) {
  const own = toolkit.stacks.get(preferStack);
  const ownItem = own && own.skills.find((s) => s.name === name);
  if (ownItem) {
    return isWipWaffle(toolkit, preferStack, 'skills', name) ? null : { kind: 'skills', name, stack: preferStack, item: ownItem };
  }
  const matches = findItems(toolkit, 'skills', name).filter((m) => !isWipWaffle(toolkit, m.stackName, 'skills', name));
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
 * Transitive, cross-stack dependency closure of a resolved item, breadth-first with the root first.
 * Dedup is by stack+kind+name, so the same item pulled via two paths appears once.
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
 * Does a `files:` item render for a consumer whose enabled harness targets are `targets`? (#364)
 * An unscoped item renders unconditionally; a scoped one renders iff it declares an enabled target.
 * Agents and skills are never filtered — they FAN OUT across the enabled targets instead.
 *
 * @param {Item} item
 * @param {string[]} targets the consumer's enabled targets (`project.targets`)
 * @returns {boolean}
 */
export function fileMatchesTargets(item, targets) {
  if (item.kind !== 'files' || !item.targets) return true;
  return item.targets.some((t) => targets.includes(t));
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
 * `trackedFiles` is the set of repo-relative paths the previous lock managed; it lets an **opt-in**
 * item a repo already renders keep updating even though a fresh stack expansion would gate it out.
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
  // `loadProjectConfig` always sets `targets`, but a bare test-constructed project may not —
  // defaulted here too, rather than filtering every scoped file out.
  const targets = project.targets ?? VALID_TARGETS;
  /** @type {{ ref: string, targets: string[] }[]} */
  const targetSkipped = [];
  /** @type {(stackName: string, kind: ItemKind, item: Item) => void} */
  const addItem = (stackName, kind, item) => {
    // The single choke point every entry path funnels through, so an explicit include cannot bypass
    // a scope (#364); it must stay AFTER addStack's trackedFiles re-admission, or a file that falls
    // out of scope would never be pruned.
    if (!fileMatchesTargets(item, targets)) return;
    const key = `${stackName}::${kind}/${item.name}`;
    if (!chosen.has(key)) chosen.set(key, { stackName, stack: toolkit.stacks.get(stackName), kind, item });
  };
  /** @type {(stackName: string) => void} */
  const addStack = (stackName) => {
    const stack = toolkit.stacks.get(stackName);
    // Gated in the STACK EXPANSION rather than in `addItem` (#335): the other entry paths are
    // already gated by the resolvers that feed them (`resolveRef`, `resolveAgentSkill`).
    for (const a of stack.agents) if (!isWipWaffle(toolkit, stackName, 'agents', a.name)) addItem(stackName, 'agents', a);
    for (const s of stack.skills) if (!isWipWaffle(toolkit, stackName, 'skills', s.name)) addItem(stackName, 'skills', s);
    for (const f of stack.files) {
      // Opt-in syrup is poured on request only, unless the repo already tracks its path. An
      // explicit `include:` bypasses this gate via the closure loop below.
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
  /** @type {{ from: string, to: string, via: string[] }[]} */
  const forwarded = [];
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
    // Recorded for the caller to report: a silent forward leaves the consumer's config stale (#335).
    if (resolved.forwardedFrom) {
      const old = parseRef(resolved.forwardedFrom);
      const chain = old.form === 'stack' ? null : replacementFor(toolkit?.registry, old.kind, old.name);
      forwarded.push({ from: resolved.forwardedFrom, to: resolved.canonicalRef, via: chain?.via ?? [] });
    }
    // Recorded so the caller can SAY so; a stack-expansion skip stays silent (#364).
    if (resolved.item.kind === 'files' && !fileMatchesTargets(resolved.item, targets)) {
      targetSkipped.push({ ref: resolved.canonicalRef, targets: resolved.item.targets ?? [] });
      continue; // do not walk its closure — nothing of it renders
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

  // Walked over `items` (post-eject), not `chosen`: an ejected dependent is not rendered, and an
  // ejected dependency is the project's, so neither edge is worth a warning.
  /** @type {{ ref: string, requiredBy: string, stackName: string, targets: string[], optIn: boolean }[]} */
  const targetBrokenRequires = [];
  const seenEdges = new Set();
  for (const { stackName, stack, kind, item } of items) {
    const requiredBy = `${kind}/${item.name}`;
    for (const depRef of stack?.requires?.[requiredBy] ?? []) {
      /** @type {DepNode} */
      let dep;
      try {
        dep = resolveDepStrict(toolkit, depRef, stackName);
      } catch {
        continue; // a dangling requires: is a toolkit bug `validate` reports; not this gate's business
      }
      // Narrowed on the ITEM's intrinsic kind: the plural `dep.kind` does not discriminate the
      // `Item` union, so it cannot reach `targets`. The two always agree at runtime.
      if (dep.item.kind !== 'files' || fileMatchesTargets(dep.item, targets)) continue;
      const ref = `files/${dep.name}`;
      if (ejected.has(ref)) continue;
      const edge = `${requiredBy}→${ref}`;
      if (seenEdges.has(edge)) continue;
      seenEdges.add(edge);
      // Opt-in is a property of the dependency's OWN stack (`dep.stack`), not the dependent's, and
      // it decides the remedy: enabling a target alone leaves an opt-in file still ungated.
      const optIn = Boolean(toolkit.stacks.get(dep.stack)?.optIn.has(ref));
      targetBrokenRequires.push({ ref, requiredBy, stackName, targets: dep.item.targets ?? [], optIn });
    }
  }

  // `targets` rides along so every downstream scope judgment reads the set this was filtered by.
  return { items, closures, errors, targets, targetSkipped, targetBrokenRequires, forwarded };
}

/**
 * Opt-in syrup companions that pair with a selected item but were gated out of the render.
 *
 * A stack declares its opt-in syrup's companion waffle with a `requires: [kind/name]` edge, and the
 * render only ever walks that edge forward (#74) — this walks it in REVERSE, over the stacks that
 * actually contribute selected items.
 *
 * @param {Toolkit} toolkit loaded toolkit
 * @param {Selection} selection a `computeSelection` result — its `targets` are read straight off it,
 *   so the two can never disagree (#364)
 * @returns {{ fileRef: string, stackName: string, companions: string[], scopedTo: string[]|null }[]}
 *   one entry per skipped syrup file, `companions` naming the selected waffles that pull it into
 *   relevance. `scopedTo` null ⇒ pourable, and `fileRef` is a ready `wafflestack install` argument;
 *   non-null ⇒ the file's `targets:` scope, and the pairing cannot be completed here. Deterministic
 *   order (stack, then manifest).
 */
export function skippedSyrupCompanions(toolkit, selection) {
  const targets = selection.targets;
  const selectedRefs = new Set(selection.items.map((i) => `${i.kind}/${i.item.name}`));
  const stacksInSelection = new Set(selection.items.map((i) => i.stackName));
  /** @type {{ fileRef: string, stackName: string, companions: string[], scopedTo: string[]|null }[]} */
  const results = [];
  for (const stackName of stacksInSelection) {
    const stack = toolkit.stacks.get(stackName);
    if (!stack) continue;
    for (const f of stack.files) {
      const fileRef = `files/${f.name}`;
      if (!stack.optIn.has(fileRef)) continue; // only opt-in syrup is silently gated
      if (selectedRefs.has(fileRef)) continue; // already poured (explicitly included or tracked)
      // `scopedTo` non-null means the pairing is real AND uncompletable here (#364), so the caller
      // states it without a pour command rather than suppressing the notification.
      const scopedTo = fileMatchesTargets(f, targets) ? null : (f.targets ?? []);
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
      if (companions.length) results.push({ fileRef, stackName, companions, scopedTo });
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
