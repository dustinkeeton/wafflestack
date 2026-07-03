/**
 * Ref grammar, toolkit-wide resolution, and dependency-closure logic shared by
 * `install`, `render`, and `validate`.
 *
 * A ref names something installable:
 *   - a bundle:                 `github-workflow`
 *   - an item:                  `skills/issue`, `agents/project-manager`, `files/.github/workflows/ci.yml`
 *   - a bundle-qualified item:  `engineering-team/skills/security-audit`
 * The qualified form disambiguates names defined in more than one bundle.
 */

/** Normalize an item ref's prefix: skill/skill:/skills → `skills/`, agent… → `agents/`, file… → `files/`. */
export function normalizeItemRef(ref) {
  return ref.replace(/^(agent|skill|file)s?[:/]/, (_m, kind) => `${kind}s/`);
}

/** The agents, skills, or files array of a bundle, selected by kind. */
export function itemsOfKind(bundle, kind) {
  if (kind === 'agents') return bundle.agents;
  if (kind === 'files') return bundle.files;
  return bundle.skills;
}

/** Every (bundleName, item) pair of `kind` across the toolkit that is named `name`. */
export function findItems(toolkit, kind, name) {
  const matches = [];
  for (const [bundleName, bundle] of toolkit.bundles) {
    const item = itemsOfKind(bundle, kind).find((i) => i.name === name);
    if (item) matches.push({ bundleName, item });
  }
  return matches;
}

/**
 * Parse a raw ref into one of:
 *   { form: 'qualified', bundle, kind, name }  — `<bundle>/(agents|skills)/<name>`
 *   { form: 'item', kind, name }               — `(agents|skills)[:/]<name>`
 *   { form: 'bundle', name }                   — anything else (a bundle name)
 */
export function parseRef(raw) {
  const ref = String(raw).trim();
  const qualified = /^([^/]+)\/(agents|skills|files)\/(.+)$/.exec(ref);
  if (qualified) return { form: 'qualified', bundle: qualified[1], kind: qualified[2], name: qualified[3] };
  const item = /^(agents|skills|files)\/(.+)$/.exec(normalizeItemRef(ref));
  if (item) return { form: 'item', kind: item[1], name: item[2] };
  return { form: 'bundle', name: ref };
}

function availableItemRefs(toolkit) {
  const refs = new Set();
  for (const bundle of toolkit.bundles.values()) {
    for (const a of bundle.agents) refs.add(`agents/${a.name}`);
    for (const s of bundle.skills) refs.add(`skills/${s.name}`);
    for (const f of bundle.files) refs.add(`files/${f.name}`);
  }
  return [...refs].sort();
}

/**
 * Resolve a single ref against the whole toolkit.
 * Returns { type: 'bundle', name } or
 *         { type: 'item', kind, name, bundle, item, canonicalRef }.
 * `canonicalRef` is the minimal ref that re-resolves uniquely: unqualified when the
 * name is unique toolkit-wide, bundle-qualified when it is not.
 * Throws with an actionable message on unknown or ambiguous refs.
 */
export function resolveRef(toolkit, raw) {
  const parsed = parseRef(raw);
  const bundleNames = [...toolkit.bundles.keys()].join(', ');

  if (parsed.form === 'bundle') {
    if (toolkit.bundles.has(parsed.name)) return { type: 'bundle', name: parsed.name };
    throw new Error(
      `unknown ref "${raw}": no such bundle (have: ${bundleNames}). ` +
      `To install a single item, prefix it: skills/${parsed.name} or agents/${parsed.name}.`,
    );
  }

  if (parsed.form === 'qualified') {
    const bundle = toolkit.bundles.get(parsed.bundle);
    if (!bundle) throw new Error(`unknown bundle "${parsed.bundle}" in ref "${raw}" (have: ${bundleNames})`);
    const item = itemsOfKind(bundle, parsed.kind).find((i) => i.name === parsed.name);
    if (!item) {
      const have = itemsOfKind(bundle, parsed.kind).map((i) => `${parsed.bundle}/${parsed.kind}/${i.name}`);
      throw new Error(
        `unknown ref "${raw}": bundle "${parsed.bundle}" has no ${singular(parsed.kind)} "${parsed.name}" ` +
        `(has: ${have.join(', ') || '(none)'})`,
      );
    }
    const ambiguous = findItems(toolkit, parsed.kind, parsed.name).length > 1;
    return {
      type: 'item',
      kind: parsed.kind,
      name: parsed.name,
      bundle: parsed.bundle,
      item,
      canonicalRef: ambiguous ? `${parsed.bundle}/${parsed.kind}/${parsed.name}` : `${parsed.kind}/${parsed.name}`,
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
    const candidates = matches.map((m) => `${m.bundleName}/${parsed.kind}/${parsed.name}`);
    throw new Error(`ambiguous ref "${raw}": defined in multiple bundles — qualify it (${candidates.join(' | ')})`);
  }
  return {
    type: 'item',
    kind: parsed.kind,
    name: parsed.name,
    bundle: matches[0].bundleName,
    item: matches[0].item,
    canonicalRef: `${parsed.kind}/${parsed.name}`,
  };
}

/**
 * Strictly resolve a dependency ref (an entry in a bundle's `requires:`), preferring
 * the declaring item's own bundle for bare names, then a unique toolkit-wide match.
 * Throws on unknown or ambiguous refs — `requires:` is authored, so a dangling entry
 * is a toolkit bug.
 */
export function resolveDepStrict(toolkit, refString, preferBundle) {
  const parsed = parseRef(refString);
  if (parsed.form === 'bundle') {
    throw new Error(`invalid dependency "${refString}" — must be skills/<name> or agents/<name>`);
  }
  if (parsed.form === 'qualified') {
    const bundle = toolkit.bundles.get(parsed.bundle);
    const item = bundle && itemsOfKind(bundle, parsed.kind).find((i) => i.name === parsed.name);
    if (!item) throw new Error(`cannot resolve dependency "${refString}" — no ${parsed.kind}/${parsed.name} in bundle "${parsed.bundle}"`);
    return { kind: parsed.kind, name: parsed.name, bundle: parsed.bundle, item };
  }
  const own = toolkit.bundles.get(preferBundle);
  const ownItem = own && itemsOfKind(own, parsed.kind).find((i) => i.name === parsed.name);
  if (ownItem) return { kind: parsed.kind, name: parsed.name, bundle: preferBundle, item: ownItem };
  const matches = findItems(toolkit, parsed.kind, parsed.name);
  if (matches.length === 0) throw new Error(`cannot resolve dependency "${refString}" — no such item in the toolkit`);
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.bundleName}/${parsed.kind}/${parsed.name}`);
    throw new Error(`ambiguous dependency "${refString}" (${candidates.join(', ')}) — qualify it as <bundle>/${parsed.kind}/${parsed.name}`);
  }
  return { kind: parsed.kind, name: parsed.name, bundle: matches[0].bundleName, item: matches[0].item };
}

/**
 * Leniently resolve an agent frontmatter `skills:` entry (a bare skill name). Agent
 * skill lists are harness grant-pointers that may reference skills provided outside
 * this toolkit (project-local, or not yet authored), so an unresolved name is not an
 * error — it is simply skipped. Prefers the agent's own bundle, then a unique
 * toolkit-wide match. Returns the resolved item or null (unknown or ambiguous).
 */
export function resolveAgentSkill(toolkit, name, preferBundle) {
  const own = toolkit.bundles.get(preferBundle);
  const ownItem = own && own.skills.find((s) => s.name === name);
  if (ownItem) return { kind: 'skills', name, bundle: preferBundle, item: ownItem };
  const matches = findItems(toolkit, 'skills', name);
  if (matches.length === 1) return { kind: 'skills', name, bundle: matches[0].bundleName, item: matches[0].item };
  return null;
}

/** Direct dependencies of a resolved item: agent frontmatter `skills:` + bundle `requires:`. */
function directDeps(toolkit, node) {
  const bundle = toolkit.bundles.get(node.bundle);
  const deps = [];
  if (node.kind === 'agents') {
    const agent = bundle.agents.find((a) => a.name === node.name);
    for (const skillName of agent?.data?.skills ?? []) {
      const dep = resolveAgentSkill(toolkit, skillName, node.bundle);
      if (dep) deps.push(dep);
    }
  }
  for (const ref of bundle.requires?.[`${node.kind}/${node.name}`] ?? []) {
    deps.push(resolveDepStrict(toolkit, ref, node.bundle));
  }
  return deps;
}

/**
 * Transitive, cross-bundle dependency closure of a resolved item, breadth-first, with
 * the root first. Each node is { kind, name, bundle, item }. Dedup is by
 * bundle+kind+name so the same item pulled via two paths appears once.
 */
export function closureFor(toolkit, root) {
  const seen = new Set();
  const order = [];
  const queue = [{ kind: root.kind, name: root.name, bundle: root.bundle, item: root.item }];
  while (queue.length) {
    const node = queue.shift();
    const key = `${node.bundle}::${node.kind}/${node.name}`;
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
    .filter((n) => !(n.bundle === root.bundle && n.kind === root.kind && n.name === root.name))
    .map((n) => `${n.kind}/${n.name}`);
}

/** Does an `include:` entry (qualified or not) refer to the given kind/name? */
export function includeRefMatches(includeRef, kind, name) {
  const parsed = parseRef(includeRef);
  return parsed.form !== 'bundle' && parsed.kind === kind && parsed.name === name;
}

/**
 * The full set of items to render:
 *   union(items of enabled `bundles:`) ∪ closure(each `include:` item) − `eject:`
 * `trackedFiles` is the set of repo-relative paths the previous lock managed (`oldLock.files`
 * keys); it lets a **syrup** item a repo already renders keep updating even though a fresh
 * bundle expansion would gate it out.
 * Returns:
 *   items:    [{ bundleName, bundle, kind, item }] deduped by bundle+kind+name, eject-filtered
 *   closures: [{ rootRef, deps: [kind/name…] }] for reporting pulled-in dependencies
 *   errors:   resolution errors (unknown bundle, unknown/ambiguous ref)
 */
export function computeSelection(toolkit, project, trackedFiles = new Set()) {
  const errors = [];
  const chosen = new Map();
  const addItem = (bundleName, kind, item) => {
    const key = `${bundleName}::${kind}/${item.name}`;
    if (!chosen.has(key)) chosen.set(key, { bundleName, bundle: toolkit.bundles.get(bundleName), kind, item });
  };
  const addBundle = (bundleName) => {
    const bundle = toolkit.bundles.get(bundleName);
    for (const a of bundle.agents) addItem(bundleName, 'agents', a);
    for (const s of bundle.skills) addItem(bundleName, 'skills', s);
    for (const f of bundle.files) {
      // Syrup is opt-in: a bundle's default expansion skips a syrup file unless the repo
      // already tracks its path in the lock (an existing install keeps getting updates).
      // An explicit `include:` of the file ref bypasses this gate — it is added via the
      // closure loop below, whose root is the file itself.
      if (bundle.syrup.has(`files/${f.name}`) && !trackedFiles.has(f.name)) continue;
      addItem(bundleName, 'files', f);
    }
  };

  for (const bundleName of project.bundles) {
    if (!toolkit.bundles.has(bundleName)) {
      errors.push(`bundle "${bundleName}" not found in toolkit (have: ${[...toolkit.bundles.keys()].join(', ')})`);
      continue;
    }
    addBundle(bundleName);
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
    if (resolved.type === 'bundle') {
      addBundle(resolved.name);
      continue;
    }
    let closure;
    try {
      closure = closureFor(toolkit, resolved);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    for (const node of closure) addItem(node.bundle, node.kind, node.item);
    closures.push({
      rootRef: `${resolved.kind}/${resolved.name}`,
      deps: closure
        .filter((n) => !(n.bundle === resolved.bundle && n.kind === resolved.kind && n.name === resolved.name))
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
