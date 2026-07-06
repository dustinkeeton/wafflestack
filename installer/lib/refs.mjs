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

/** Normalize an item ref's prefix: skill/skill:/skills → `skills/`, agent… → `agents/`, file… → `files/`. */
export function normalizeItemRef(ref) {
  return ref.replace(/^(agent|skill|file)s?[:/]/, (_m, kind) => `${kind}s/`);
}

/** The agents, skills, or files array of a stack, selected by kind. */
export function itemsOfKind(stack, kind) {
  if (kind === 'agents') return stack.agents;
  if (kind === 'files') return stack.files;
  return stack.skills;
}

/** Every (stackName, item) pair of `kind` across the toolkit that is named `name`. */
export function findItems(toolkit, kind, name) {
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
 */
export function parseRef(raw) {
  const ref = String(raw).trim();
  const qualified = /^([^/]+)\/(agents|skills|files)\/(.+)$/.exec(ref);
  if (qualified) return { form: 'qualified', stack: qualified[1], kind: qualified[2], name: qualified[3] };
  const item = /^(agents|skills|files)\/(.+)$/.exec(normalizeItemRef(ref));
  if (item) return { form: 'item', kind: item[1], name: item[2] };
  return { form: 'stack', name: ref };
}

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
 */
export function resolveAgentSkill(toolkit, name, preferStack) {
  const own = toolkit.stacks.get(preferStack);
  const ownItem = own && own.skills.find((s) => s.name === name);
  if (ownItem) return { kind: 'skills', name, stack: preferStack, item: ownItem };
  const matches = findItems(toolkit, 'skills', name);
  if (matches.length === 1) return { kind: 'skills', name, stack: matches[0].stackName, item: matches[0].item };
  return null;
}

/** Direct dependencies of a resolved item: agent frontmatter `skills:` + stack `requires:`. */
function directDeps(toolkit, node) {
  const stack = toolkit.stacks.get(node.stack);
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
 */
export function closureFor(toolkit, root) {
  const seen = new Set();
  const order = [];
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

/** The non-root dependency refs of a closure, as `kind/name` strings (for CLI output). */
export function closureDeps(toolkit, root) {
  return closureFor(toolkit, root)
    .filter((n) => !(n.stack === root.stack && n.kind === root.kind && n.name === root.name))
    .map((n) => `${n.kind}/${n.name}`);
}

/** Does an `include:` entry (qualified or not) refer to the given kind/name? */
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
 */
export function computeSelection(toolkit, project, trackedFiles = new Set()) {
  const errors = [];
  const chosen = new Map();
  const addItem = (stackName, kind, item) => {
    const key = `${stackName}::${kind}/${item.name}`;
    if (!chosen.has(key)) chosen.set(key, { stackName, stack: toolkit.stacks.get(stackName), kind, item });
  };
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

  const closures = [];
  for (const ref of project.include ?? []) {
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

function singular(kind) {
  if (kind === 'agents') return 'agent';
  if (kind === 'files') return 'file';
  return 'skill';
}
