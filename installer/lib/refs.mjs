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
import { VALID_TARGETS } from './project.mjs';

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
 * @property {string[]} targets the enabled targets this selection was computed against — the SAME
 *   derived value the scope filter used (`project.targets`, defaulted to VALID_TARGETS when the key
 *   is absent). Carried on the result so a downstream consumer of the selection (`render`'s syrup
 *   pairing, `setup`'s playbook) cannot judge scope against a DIFFERENT target set than the one that
 *   produced these items. It was a defaulted parameter first, and the default — "every target
 *   enabled" — was the one value that silently restores pre-#364 behavior for a caller who forgets
 *   it; there is now no argument to forget (#364)
 * @property {{ ref: string, targets: string[] }[]} targetSkipped explicitly `include:`d `files/`
 *   items whose declared `targets:` are all disabled here — nothing renders, and that must not be
 *   silent (#364)
 * @property {{ ref: string, requiredBy: string, stackName: string, targets: string[], optIn: boolean }[]}
 *   targetBrokenRequires a SELECTED item's `requires:` edge landing on a `files/` item the scope
 *   filtered out: the dependent renders, its declared dependency never does. Eject-filtered on both
 *   ends. Newly possible with #364, and it must not be silent either (#74). `optIn` = the dependency
 *   is opt-in syrup in its own stack, so enabling one of its targets is necessary but NOT sufficient
 *   to render it — the caller must state BOTH steps or the remedy it prints does not work
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
 * Does a `files:` item render for a consumer whose enabled harness targets are `targets`? (#364)
 *
 * An UNSCOPED item (`item.targets === null` — no `targets:` on its manifest entry) renders
 * unconditionally: that is the pre-#364 contract and the overwhelmingly common case, because a
 * `.github/` payload is harness-independent. A SCOPED item renders iff at least one of the targets
 * it declares is enabled here. Agents and skills are never filtered — they FAN OUT across the
 * enabled targets (renderAgent/renderSkill emit one output each), they do not gate on them; a file
 * has no per-harness variant, so a filter is the only coherent reading of a scope on one.
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
  // `loadProjectConfig` always sets `targets` (defaulting to VALID_TARGETS when the key is absent),
  // but a bare test-constructed project object may not — default here too, rather than filtering
  // every scoped file out.
  const targets = project.targets ?? VALID_TARGETS;
  /** @type {{ ref: string, targets: string[] }[]} */
  const targetSkipped = [];
  /** @type {(stackName: string, kind: ItemKind, item: Item) => void} */
  const addItem = (stackName, kind, item) => {
    // #364: a target-scoped syrup file is not SELECTED when none of its targets is enabled — so it
    // never renders, and (because the render prunes every lock path it no longer produces) an
    // already-rendered copy is removed on the next render. Unscoped items are untouched.
    //
    // This gate belongs here, at the single choke point every entry path funnels through — stack
    // expansion, the `include:` closure loop, and a `requires:` dependency edge — so an explicit
    // include cannot bypass a scope. It must also sit AFTER addStack's opt-in/trackedFiles
    // re-admission, which deliberately keeps an already-poured syrup file selected: scope has to
    // override tracking, or a file that falls out of scope would never be pruned.
    if (!fileMatchesTargets(item, targets)) return;
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
    // #364: an explicitly-included file scoped to targets this project has not enabled renders
    // nothing. Record it so the caller can SAY so — a silent no-op on an explicit `include:` is
    // precisely the "half-installed and silent" failure #74 exists to prevent. A stack-expansion
    // skip stays silent (exactly like the `optIn:` gate); only an explicit include warns.
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

  // #364: a `requires:` edge onto a file the SCOPE filtered out is newly possible — before this
  // change a `files/` item always rendered, so a strict edge was always satisfied at render time.
  // Scope the file, and the dependent renders WITHOUT the thing it declares it needs. The renderer
  // only ever walks that edge FORWARD (dep → dependent), so nothing downstream would ever notice:
  // the consumer gets a half-wired flow and hears nothing — the same "half-installed and silent"
  // failure #74 exists to prevent, and the one entry path into the gate that got neither a warning
  // nor a lint. Collect each broken edge so the caller can SAY the flow is incomplete.
  //
  // Walked over `items` (post-eject), not `chosen`, for two reasons: an EJECTED dependent is not
  // rendered, so its unsatisfied edge is nobody's problem; and an EJECTED dependency is handed to
  // the project (it stays on disk, unmanaged, and `eject` drops it from both locks), so the edge is
  // satisfied by a file wafflestack no longer owns — warning about either would be noise.
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
      // Narrowed on the ITEM's intrinsic kind, not the ref kind: `dep.kind` is the plural ref
      // vocabulary and does not discriminate the `Item` union, so it cannot reach `targets` (a
      // FileItem field). The two always agree — `resolveDepStrict` draws the item from
      // `itemsOfKind(stack, kind)` — so this is the same runtime test, stated so tsc can see it.
      // Same idiom as the explicit-include gate above.
      if (dep.item.kind !== 'files' || fileMatchesTargets(dep.item, targets)) continue;
      const ref = `files/${dep.name}`;
      if (ejected.has(ref)) continue;
      const edge = `${requiredBy}→${ref}`;
      if (seenEdges.has(edge)) continue;
      seenEdges.add(edge);
      // Whether the dependency is OPT-IN syrup decides what the caller may tell the consumer to do
      // about it, and getting that wrong is worse than saying nothing: for an opt-in file, enabling
      // a target is NECESSARY BUT NOT SUFFICIENT (`addStack` still gates it out until it is
      // explicitly installed), so a bare "enable one of its targets" is a remedy that does not work
      // — and once the target IS enabled this edge stops being scope-broken, so the warning would
      // VANISH while the dependency still does not render, reading as resolved. Opt-in is a property
      // of the dependency's OWN stack, which is `dep.stack` and need not be the dependent's.
      const optIn = Boolean(toolkit.stacks.get(dep.stack)?.optIn.has(ref));
      targetBrokenRequires.push({ ref, requiredBy, stackName, targets: dep.item.targets ?? [], optIn });
    }
  }

  // `targets` rides along on the result (see the Selection typedef): every downstream scope judgment
  // must be made against the SAME set this selection was filtered by, and the only way to guarantee
  // that is to stop asking the caller to pass it again.
  return { items, closures, errors, targets, targetSkipped, targetBrokenRequires };
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
 * @param {Selection} selection a `computeSelection` result — its `targets` (the consumer's enabled
 *   harnesses) are read straight off it. A syrup file scoped away from all of them cannot be POURED
 *   here (#364), so its entry comes back marked (`scopedTo`) rather than dropped: the pairing is
 *   still real and must still be stated. This was a defaulted third PARAMETER until the default —
 *   `VALID_TARGETS`, i.e. "every target enabled" — was spotted as the one value that silently
 *   restores pre-#364 behavior: a caller who forgot the argument would judge a scoped-out file
 *   POURABLE and print an `install` command that renders nothing. Reading it off the selection that
 *   was already argument #2 means the two can never disagree, and there is no argument to forget.
 * @returns {{ fileRef: string, stackName: string, companions: string[], scopedTo: string[]|null }[]}
 *   one entry per skipped syrup file, `companions` naming the selected waffles that pull it into
 *   relevance. `scopedTo` is null for a pourable file — then `fileRef` is a ready
 *   `wafflestack install <fileRef>` argument. When non-null it is the file's `targets:` scope, and
 *   the pairing CANNOT be completed here: the caller must state it without offering an install
 *   command (which would render nothing). Deterministic order (stack, then manifest).
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
      // #364: a syrup file scoped away from every enabled target cannot be poured here, so the
      // caller must never hand out an `install` command for it — that command would render nothing.
      // But dropping the whole NOTIFICATION is #74 wearing a new hat: the consumer keeps the manual
      // half of the flow, can never get the automated half, and is told nothing. So do not suppress
      // — RESTATE. `scopedTo` non-null means "this pairing is real AND uncompletable here", and the
      // caller phrases it without a pour command, naming the scope instead.
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
