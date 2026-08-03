// The waffle registry (#335) — `stacks/registry.yaml` as the single source of truth for waffle
// identity, location, and availability.
//
// Three properties are worth a test each, and they are the three the issue exists for:
//   1. ENFORCEMENT — a rename, a move, or an unregistered waffle turns `validate` red. If this
//      suite passes while the registry disagrees with the tree, the registry is decoration.
//   2. GATING — a `wip` waffle is offered by no consumer-facing surface, and is offered by ALL of
//      them again once it goes `stable`. Each surface is tested separately: they are separate
//      code paths, and one un-gated path is a `wip` waffle shipping.
//   3. FORWARDING — a `replaced` tombstone carries a pinned consumer across a rename, at render
//      (a warning, so the repo keeps working) and at upgrade (a rewrite, so it stops being stale).
//
// Plus the property that makes all three safe to add to an existing toolkit: a toolkit with NO
// registry behaves exactly as it did before one existed.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  replacementFor,
  waffleStatus,
  isWaffleWip,
  canonicalWafflePath,
  refKindOf,
  waffleKindOf,
  WAFFLE_STATUSES,
} from '../lib/registry.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { validateToolkit, validateRegistry } from '../lib/validate.mjs';
import { resolveRef, computeSelection, resolveAgentSkill, isWipWaffle } from '../lib/refs.mjs';
import { toolkitInventory } from '../lib/setup.mjs';
import { forwardRenamedWaffleRefs } from '../lib/upgrade.mjs';
import { renderProject } from '../lib/render.mjs';
import { installRefs } from '../lib/eject.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

/**
 * A two-stack fixture toolkit: `alpha` (one agent + one skill) and `beta` (one skill), with a
 * registry marking everything `stable`. Every test below mutates one thing from this baseline, so
 * a failure names the ONE divergence it introduced.
 */
function makeToolkit(registryEntries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-reg-'));
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: registry fixture\nstacks: [alpha, beta]\n');
  write(root, 'stacks/alpha/stack.yaml', 'name: alpha\ndescription: Stack alpha.\nagents: [scout]\nskills: [mapper]\n');
  write(root, 'stacks/alpha/agents/scout.md', '---\nname: scout\ndescription: Scout agent.\nskills: [mapper]\n---\n\nScout body.\n');
  write(root, 'stacks/alpha/skills/mapper/SKILL.md', '---\nname: mapper\ndescription: Mapper skill.\n---\n\nMapper body.\n');
  write(root, 'stacks/beta/stack.yaml', 'name: beta\ndescription: Stack beta.\nskills: [ledger]\n');
  write(root, 'stacks/beta/skills/ledger/SKILL.md', '---\nname: ledger\ndescription: Ledger skill.\n---\n\nLedger body.\n');
  if (registryEntries !== null) {
    write(root, 'stacks/registry.yaml', YAML.stringify({ waffles: registryEntries ?? defaultEntries() }));
  }
  return root;
}

const defaultEntries = () => [
  { name: 'scout', kind: 'agent', stack: 'alpha', path: 'stacks/alpha/agents/scout.md', status: 'stable' },
  { name: 'mapper', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/mapper', status: 'stable' },
  { name: 'ledger', kind: 'skill', stack: 'beta', path: 'stacks/beta/skills/ledger', status: 'stable' },
];

/** The same fixture, with one entry's fields overridden by name+kind. */
function entriesWith(name, kind, patch) {
  return defaultEntries().map((e) => (e.name === name && e.kind === kind ? { ...e, ...patch } : e));
}

const problemsFor = (root) => validateRegistry(root, loadToolkit(root));
const matching = (problems, re) => problems.filter((p) => re.test(p));

describe('waffle registry: the file and its lookups (#335)', () => {
  let root;
  afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

  test('an ABSENT registry is a silent no-op, not an error — a fork stays renderable', () => {
    root = makeToolkit(null);
    const registry = loadToolkit(root).registry;
    assert.equal(registry.present, false);
    assert.equal(registry.entries.length, 0);
    // …and every gate keyed on it answers "available".
    assert.equal(waffleStatus(registry, 'alpha', 'skills', 'mapper'), null);
    assert.equal(isWaffleWip(registry, 'alpha', 'skills', 'mapper'), false);
    assert.equal(replacementFor(registry, 'skills', 'anything'), null);
    // Nothing to reconcile means nothing to report — an unregistered toolkit is not a broken one.
    assert.deepEqual(problemsFor(root), []);
  });

  // The counterpart, and the reason absence is allowed to be silent: a registry that EXISTS but
  // cannot be read must never degrade to "ungated", because that is how a wip waffle ships.
  for (const [label, content] of [
    ['empty', ''],
    ['a bare list', '- name: scout\n'],
    ['missing `waffles:`', 'items:\n  - name: scout\n'],
    ['a non-list `waffles:`', 'waffles: scout\n'],
  ]) {
    test(`a registry that is ${label} is a HARD error, never a silent un-gating`, () => {
      root = makeToolkit(defaultEntries());
      write(root, 'stacks/registry.yaml', content);
      assert.throws(() => loadToolkit(root), /registry\.yaml/);
      // `validate` still REPORTS it rather than crashing — it catches the load error.
      assert.match(validateToolkit(root).join('\n'), /toolkit failed to load[\s\S]*registry\.yaml/);
    });
  }

  test('the kind vocabularies map both ways, and syrup has no registry kind', () => {
    assert.equal(refKindOf('agent'), 'agents');
    assert.equal(refKindOf('skill'), 'skills');
    assert.equal(refKindOf('files'), null);
    assert.equal(waffleKindOf('skills'), 'skill');
    assert.equal(waffleKindOf('agents'), 'agent');
    // The out-of-scope decision, pinned: `files/` payloads are addressed by output path.
    assert.equal(waffleKindOf('files'), null);
    assert.equal(canonicalWafflePath('alpha', 'skill', 'mapper'), 'stacks/alpha/skills/mapper');
    assert.equal(canonicalWafflePath('alpha', 'agent', 'scout'), 'stacks/alpha/agents/scout.md');
    assert.equal(canonicalWafflePath('alpha', 'files', 'x'), null);
  });

  test('status is keyed on the OWNING stack — one stack\'s wip cannot gate another\'s same name', () => {
    root = makeToolkit([
      ...defaultEntries(),
      { name: 'mapper', kind: 'skill', stack: 'beta', path: 'stacks/beta/skills/mapper', status: 'wip' },
    ]);
    const registry = loadToolkit(root).registry;
    assert.equal(waffleStatus(registry, 'alpha', 'skills', 'mapper'), 'stable');
    assert.equal(waffleStatus(registry, 'beta', 'skills', 'mapper'), 'wip');
  });

  // The fail-open rule. A typo in `status:` must not read as "gate this out": gating deletes a
  // poured waffle from a consumer's tree, so the destructive reading needs an exact spelling.
  for (const status of ['stabel', 'WIP', 'Wip', 'work-in-progress', '']) {
    test(`an unrecognised status (${JSON.stringify(status)}) leaves the waffle AVAILABLE and reds validate`, () => {
      root = makeToolkit(entriesWith('mapper', 'skill', { status }));
      const registry = loadToolkit(root).registry;
      assert.equal(isWaffleWip(registry, 'alpha', 'skills', 'mapper'), false);
      assert.ok(matching(problemsFor(root), /needs a `status`/).length, 'validate must report the bad status');
    });
  }

  test('replacementFor walks a chain transitively and refuses cycles', () => {
    root = makeToolkit([
      { name: 'v3', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/v3', status: 'stable' },
      { name: 'v1', kind: 'skill', status: 'replaced', replacedBy: 'v2' },
      { name: 'v2', kind: 'skill', status: 'replaced', replacedBy: 'v3' },
      { name: 'loopA', kind: 'skill', status: 'replaced', replacedBy: 'loopB' },
      { name: 'loopB', kind: 'skill', status: 'replaced', replacedBy: 'loopA' },
      { name: 'selfie', kind: 'skill', status: 'replaced', replacedBy: 'selfie' },
      { name: 'dangling', kind: 'skill', status: 'replaced' },
    ]);
    const registry = loadToolkit(root).registry;
    // Two renames back still lands on the current name in ONE hop — the property that keeps a very
    // stale consumer config from needing one upgrade per historical rename.
    assert.deepEqual(replacementFor(registry, 'skills', 'v1'), { ref: 'skills/v3', name: 'v3', via: ['v1', 'v2'] });
    assert.deepEqual(replacementFor(registry, 'skills', 'v2'), { ref: 'skills/v3', name: 'v3', via: ['v2'] });
    // A live name is not a tombstone: nothing to forward.
    assert.equal(replacementFor(registry, 'skills', 'v3'), null);
    // A cycle answers null rather than looping — a gate must not hang on a bad registry.
    assert.equal(replacementFor(registry, 'skills', 'loopA'), null);
    assert.equal(replacementFor(registry, 'skills', 'selfie'), null);
    // A tombstone with no successor is a plain removal; there is nothing to forward TO.
    assert.equal(replacementFor(registry, 'skills', 'dangling'), null);
    // The kind is part of the key: an AGENT named v1 was never renamed.
    assert.equal(replacementFor(registry, 'agents', 'v1'), null);
  });
});

describe('waffle registry: enforcement — the three-way reconcile turns drift red (#335)', () => {
  let root;
  afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

  test('a clean tree reconciles with no problems', () => {
    root = makeToolkit(defaultEntries());
    assert.deepEqual(problemsFor(root), []);
  });

  // THE issue's headline case: a MOVE used to break nothing at the toolkit level and everything at
  // the consumer's next render. Now it cannot land without the registry moving with it.
  test('MOVING a waffle to another stack without updating the registry is red', () => {
    root = makeToolkit(defaultEntries());
    fs.mkdirSync(path.join(root, 'stacks/beta/skills'), { recursive: true });
    fs.renameSync(path.join(root, 'stacks/alpha/skills/mapper'), path.join(root, 'stacks/beta/skills/mapper'));
    write(root, 'stacks/alpha/stack.yaml', 'name: alpha\ndescription: Stack alpha.\nagents: [scout]\n');
    write(root, 'stacks/beta/stack.yaml', 'name: beta\ndescription: Stack beta.\nskills: [ledger, mapper]\n');
    const problems = problemsFor(root);
    // The registry still claims the old location…
    assert.ok(matching(problems, /registered at "stacks\/alpha\/skills\/mapper", which does not exist/).length);
    // …and the new location is unregistered, from both the manifest side and the disk side.
    assert.ok(matching(problems, /stack "beta" lists skills\/mapper in stack\.yaml, but it is not in the waffle registry/).length);
  });

  test('RENAMING a waffle is red until all three parts land — files, stack.yaml, registry', () => {
    root = makeToolkit(defaultEntries());
    fs.renameSync(path.join(root, 'stacks/alpha/skills/mapper'), path.join(root, 'stacks/alpha/skills/cartographer'));
    write(root, 'stacks/alpha/stack.yaml', 'name: alpha\ndescription: Stack alpha.\nagents: [scout]\nskills: [cartographer]\n');
    assert.ok(problemsFor(root).length, 'files + manifest moved, registry did not — must be red');

    // Now land the third part: a tombstone plus a live entry under the new name.
    write(root, 'stacks/registry.yaml', YAML.stringify({
      waffles: [
        ...defaultEntries().filter((e) => e.name !== 'mapper'),
        { name: 'cartographer', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/cartographer', status: 'stable' },
        { name: 'mapper', kind: 'skill', status: 'replaced', replacedBy: 'cartographer' },
      ],
    }));
    assert.deepEqual(problemsFor(root), []);
  });

  test('a waffle sitting on disk that NO manifest and NO registry entry covers is red', () => {
    root = makeToolkit(defaultEntries());
    write(root, 'stacks/alpha/skills/orphan/SKILL.md', '---\nname: orphan\ndescription: Orphan.\n---\n\nx\n');
    assert.ok(matching(problemsFor(root), /stacks\/alpha\/skills\/orphan exists on disk but is not in the waffle registry/).length);
  });

  test('a registered waffle whose stack.yaml does not list it is red', () => {
    root = makeToolkit([...defaultEntries(), { name: 'ghost', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/ghost', status: 'stable' }]);
    const problems = problemsFor(root);
    assert.ok(matching(problems, /skill "ghost"[\s\S]*does not exist/).length);
    assert.ok(matching(problems, /skill "ghost" is registered under stack "alpha", but that stack's stack\.yaml does not list it/).length);
  });

  test('a path that is not the path the LOADER would use is red, even when it exists', () => {
    root = makeToolkit(entriesWith('mapper', 'skill', { path: 'stacks/beta/skills/ledger' }));
    assert.ok(matching(problemsFor(root), /records path "stacks\/beta\/skills\/ledger" but[\s\S]*is loaded from "stacks\/alpha\/skills\/mapper"/).length);
  });

  test('entry shape: unknown keys, duplicates, missing fields, and an unknown stack are each named', () => {
    root = makeToolkit([
      ...defaultEntries(),
      { name: 'mapper', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/mapper', status: 'stable' }, // duplicate
      { name: 'typo', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/typo', status: 'stable', replacedby: 'x' },
      { kind: 'skill', stack: 'alpha', status: 'stable', path: 'stacks/alpha/skills/x' },
      { name: 'elsewhere', kind: 'skill', stack: 'nosuch', path: 'stacks/nosuch/skills/elsewhere', status: 'stable' },
    ]);
    const problems = problemsFor(root);
    assert.ok(matching(problems, /is registered twice/).length);
    assert.ok(matching(problems, /unknown key "replacedby"/).length);
    assert.ok(matching(problems, /is missing a `name`/).length);
    assert.ok(matching(problems, /names stack "nosuch", which is not a stack in toolkit\.yaml/).length);
  });

  test('a tombstone must be a tombstone: no stack/path, a successor, and a name that is really gone', () => {
    root = makeToolkit([
      ...defaultEntries(),
      // Still resolves — `mapper` is very much alive.
      { name: 'mapper', kind: 'agent', status: 'replaced', replacedBy: 'scout' },
      { name: 'gone', kind: 'skill', status: 'replaced', stack: 'alpha', path: 'stacks/alpha/skills/gone' },
      { name: 'orphaned', kind: 'skill', status: 'replaced', replacedBy: 'nobody' },
    ]);
    const problems = problemsFor(root);
    assert.ok(matching(problems, /is `replaced`, so it must not declare a `stack`/).length);
    assert.ok(matching(problems, /is `replaced`, so it must not declare a `path`/).length);
    assert.ok(matching(problems, /is `replaced` but declares no `replacedBy`/).length);
    assert.ok(matching(problems, /replaced by "nobody", which is not a registered skill/).length);
  });

  test('a tombstone whose name still resolves is red — that would shadow the live waffle', () => {
    root = makeToolkit([...defaultEntries(), { name: 'ledger', kind: 'skill', status: 'replaced', replacedBy: 'mapper' }]);
    assert.ok(matching(problemsFor(root), /is `replaced`, but a skill of that name still exists in stack "beta"/).length);
  });

  test('forwarding must terminate somewhere useful: a cycle and a wip target are both red', () => {
    root = makeToolkit([
      ...defaultEntries(),
      { name: 'draft', kind: 'skill', stack: 'beta', path: 'stacks/beta/skills/draft', status: 'wip' },
      { name: 'old', kind: 'skill', status: 'replaced', replacedBy: 'draft' },
      { name: 'ring1', kind: 'skill', status: 'replaced', replacedBy: 'ring2' },
      { name: 'ring2', kind: 'skill', status: 'replaced', replacedBy: 'ring1' },
    ]);
    const problems = problemsFor(root);
    assert.ok(matching(problems, /replaced by "draft", which is `wip`/).length);
    assert.ok(matching(problems, /chain does not end at a live waffle/).length);
  });

  test('a `deprecated` successor must resolve; `replacedBy` on a `stable` entry is meaningless', () => {
    root = makeToolkit([
      ...entriesWith('mapper', 'skill', { status: 'deprecated', replacedBy: 'nowhere' }),
      { name: 'x', kind: 'agent', stack: 'alpha', path: 'stacks/alpha/agents/x.md', status: 'stable', replacedBy: 'scout' },
    ]);
    const problems = problemsFor(root);
    assert.ok(matching(problems, /deprecated in favour of "nowhere", which is not a registered skill/).length);
    assert.ok(matching(problems, /declares `replacedBy` but is `stable`/).length);
  });

  test('an OFFERED waffle that `requires:` a wip one is red — a promise the render cannot keep', () => {
    root = makeToolkit(entriesWith('ledger', 'skill', { status: 'wip' }));
    write(root, 'stacks/alpha/stack.yaml', [
      'name: alpha',
      'description: Stack alpha.',
      'agents: [scout]',
      'skills: [mapper]',
      'requires:',
      '  skills/mapper:',
      '    - skills/ledger',
      '',
    ].join('\n'));
    assert.ok(matching(problemsFor(root), /requires\[skills\/mapper\] → skills\/ledger, which is `wip`/).length);

    // …but a wip waffle may depend on a wip waffle: nothing is offered, so nothing is promised.
    write(root, 'stacks/registry.yaml', YAML.stringify({
      waffles: defaultEntries().map((e) => (e.kind === 'skill' ? { ...e, status: 'wip' } : e)),
    }));
    assert.deepEqual(matching(problemsFor(root), /which is `wip`/), []);
  });

  test("the real toolkit's registry covers every waffle in the tree, with nothing left over", () => {
    const toolkit = loadToolkit(REPO_ROOT);
    assert.equal(toolkit.registry.present, true, 'this repo SHIPS a registry — absence would silently disable enforcement');
    assert.deepEqual(validateRegistry(REPO_ROOT, toolkit), []);
    // Counts, so a waffle added without an entry (or an entry with no waffle) is caught by arithmetic
    // as well as by the reconcile.
    const live = [...toolkit.stacks.values()];
    const waffles = live.reduce((n, s) => n + s.agents.length + s.skills.length, 0);
    assert.equal(toolkit.registry.live.size, waffles);
    // Every registered status is one of the four; today the whole tree is `stable`.
    for (const e of toolkit.registry.entries) assert.ok(WAFFLE_STATUSES.includes(e.status), `${e.name}: ${e.status}`);
  });
});

describe('waffle registry: gating — a wip waffle is offered by nobody (#335)', () => {
  let root;
  afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

  const wipToolkit = () => loadToolkit((root = makeToolkit(entriesWith('mapper', 'skill', { status: 'wip' }))));

  test('an explicit ref is REFUSED, and the message says wip rather than "unknown"', () => {
    const toolkit = wipToolkit();
    assert.throws(() => resolveRef(toolkit, 'skills/mapper'), /work-in-progress/);
    assert.throws(() => resolveRef(toolkit, 'alpha/skills/mapper'), /work-in-progress/);
    // The unknown-ref remedy must not advertise it either — naming a ref we then refuse is worse
    // than saying nothing.
    assert.throws(() => resolveRef(toolkit, 'skills/nope'), (err) => {
      assert.match(err.message, /Available items: /);
      assert.ok(!err.message.includes('skills/mapper'), err.message);
      assert.ok(err.message.includes('skills/ledger'));
      return true;
    });
  });

  test('stack expansion skips it — adopting its whole stack does not pull it in', () => {
    const toolkit = wipToolkit();
    const selection = computeSelection(toolkit, { stacks: ['alpha', 'beta'], include: [], targets: ['claude'] });
    const refs = selection.items.map((i) => `${i.kind}/${i.item.name}`).sort();
    assert.deepEqual(refs, ['agents/scout', 'skills/ledger']);
  });

  test("an agent's frontmatter `skills:` closure drops it — leniently, like any absent skill", () => {
    const toolkit = wipToolkit();
    // `scout` grants `mapper`; the grant-pointer resolves to nothing while mapper is wip…
    assert.equal(resolveAgentSkill(toolkit, 'mapper', 'alpha'), null);
    const selection = computeSelection(toolkit, { stacks: [], include: ['agents/scout'], targets: ['claude'] });
    assert.deepEqual(selection.errors, [], 'a wip grant-pointer is not an ERROR — that is the lenient doctrine');
    assert.deepEqual(selection.items.map((i) => `${i.kind}/${i.item.name}`), ['agents/scout']);
  });

  test('the setup inventory omits it, and marks a deprecated waffle instead of hiding it', () => {
    const toolkit = wipToolkit();
    const inv = toolkitInventory(toolkit, '0.0.test');
    assert.ok(!inv.includes('skills/mapper'), inv);
    assert.ok(inv.includes('skills/ledger'));
    // A skills-only stack whose every skill is wip still renders a coherent line.
    assert.match(inv, /## stack: alpha[\s\S]*?- skills: \(none\)/);

    fs.rmSync(root, { recursive: true, force: true });
    root = makeToolkit(entriesWith('mapper', 'skill', { status: 'deprecated' }));
    assert.match(toolkitInventory(loadToolkit(root), '0.0.test'), /skills\/mapper \(deprecated\)/);
  });

  test('flipping the SAME waffle back to stable restores it everywhere', () => {
    root = makeToolkit(defaultEntries());
    const toolkit = loadToolkit(root);
    assert.equal(isWipWaffle(toolkit, 'alpha', 'skills', 'mapper'), false);
    assert.equal(resolveRef(toolkit, 'skills/mapper').canonicalRef, 'skills/mapper');
    const selection = computeSelection(toolkit, { stacks: ['alpha'], include: [], targets: ['claude'] });
    assert.ok(selection.items.some((i) => i.item.name === 'mapper'));
    assert.ok(toolkitInventory(toolkit, '0.0.test').includes('skills/mapper'));
  });

  // A wip waffle in one stack must not shadow a same-named STABLE waffle in another: there is
  // exactly one thing the bare ref can mean, so demanding a qualifier would be nonsense.
  test('a wip twin does not make a bare ref ambiguous — it resolves to the stable one', () => {
    root = makeToolkit([
      ...defaultEntries(),
      { name: 'mapper', kind: 'skill', stack: 'beta', path: 'stacks/beta/skills/mapper', status: 'wip' },
    ]);
    write(root, 'stacks/beta/stack.yaml', 'name: beta\ndescription: Stack beta.\nskills: [ledger, mapper]\n');
    write(root, 'stacks/beta/skills/mapper/SKILL.md', '---\nname: mapper\ndescription: Beta mapper.\n---\n\nx\n');
    const resolved = resolveRef(loadToolkit(root), 'skills/mapper');
    assert.equal(resolved.type === 'item' && resolved.stack, 'alpha');
    assert.equal(resolved.type === 'item' && resolved.canonicalRef, 'skills/mapper');
  });
});

describe('waffle registry: forwarding a renamed waffle (#335)', () => {
  let root;
  let cwd;

  const renamedToolkit = () => {
    root = makeToolkit([
      ...defaultEntries().filter((e) => !(e.name === 'mapper' && e.kind === 'skill')),
      { name: 'cartographer', kind: 'skill', stack: 'alpha', path: 'stacks/alpha/skills/cartographer', status: 'stable' },
      { name: 'mapper', kind: 'skill', status: 'replaced', replacedBy: 'cartographer' },
      { name: 'ancient', kind: 'skill', status: 'replaced', replacedBy: 'mapper' },
    ]);
    fs.renameSync(path.join(root, 'stacks/alpha/skills/mapper'), path.join(root, 'stacks/alpha/skills/cartographer'));
    write(root, 'stacks/alpha/stack.yaml', 'name: alpha\ndescription: Stack alpha.\nagents: [scout]\nskills: [cartographer]\n');
    return loadToolkit(root);
  };

  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-reg-')); });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    root = null;
  });

  test('resolveRef forwards the old ref and records where it came from', () => {
    const toolkit = renamedToolkit();
    const resolved = resolveRef(toolkit, 'skills/mapper');
    assert.equal(resolved.type, 'item');
    assert.equal(resolved.type === 'item' && resolved.name, 'cartographer');
    assert.equal(resolved.type === 'item' && resolved.forwardedFrom, 'skills/mapper');
    // A stack-qualified old ref forwards too — the qualifier is as stale as the name.
    assert.equal(resolveRef(toolkit, 'alpha/skills/mapper').type === 'item' && resolveRef(toolkit, 'alpha/skills/mapper').name, 'cartographer');
    // Two renames back, one hop.
    assert.equal(resolveRef(toolkit, 'skills/ancient').type === 'item' && resolveRef(toolkit, 'skills/ancient').name, 'cartographer');
  });

  test('a render with a stale include: SUCCEEDS and warns — a rename must not break a repo', () => {
    const toolkit = renamedToolkit();
    const selection = computeSelection(toolkit, { stacks: [], include: ['skills/mapper'], targets: ['claude'] });
    assert.deepEqual(selection.errors, []);
    assert.deepEqual(selection.items.map((i) => i.item.name), ['cartographer']);
    assert.deepEqual(selection.forwarded, [{ from: 'skills/mapper', to: 'skills/cartographer', via: ['mapper'] }]);

    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\ninclude:\n  - skills/mapper\n');
    const result = renderProject({ toolkitRoot: root, cwd, toolkitVersion: '0.0.test' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.ok(fs.existsSync(path.join(cwd, '.claude/skills/cartographer/SKILL.md')));
    assert.ok(result.warnings.some((w) => /renamed to skills\/cartographer/.test(w) && /wafflestack upgrade/.test(w)), result.warnings.join('\n'));
  });

  test('upgrade rewrites the stale ref in place, leaving the rest of the config byte-identical', () => {
    renamedToolkit();
    const before = [
      '# my project config',
      'targets: [claude]',
      'stacks:',
      '  - beta          # keep this comment',
      'include:',
      '  - skills/mapper # the old name',
      '  - skills/ledger',
      'eject:',
      '  - skills/mapper',
      '',
    ].join('\n');
    write(cwd, '.waffle/waffle.yaml', before);

    const moves = forwardRenamedWaffleRefs({ toolkitRoot: root, cwd });
    assert.deepEqual(moves, [{ from: 'skills/mapper', to: 'skills/cartographer', action: 'forwarded' }]);
    const after = fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8');
    // ONE line changed. Comments, ordering, and flow style all survive — this is a byte-level
    // scalar splice, not a re-serialize.
    assert.equal(after, before.replace('  - skills/mapper # the old name', '  - skills/cartographer # the old name'));
    // `eject:` is deliberately untouched: the project took ownership of that file, and rewriting the
    // entry would silently re-adopt something they chose to keep.
    assert.match(after, /eject:\n {2}- skills\/mapper\n/);
    // Idempotent: a second run finds nothing to do and writes nothing.
    assert.deepEqual(forwardRenamedWaffleRefs({ toolkitRoot: root, cwd }), []);
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), after);
  });

  test('nothing to forward = nothing written; and a corrupt config is left alone', () => {
    renamedToolkit();
    const clean = 'targets: [claude]\nstacks: [beta]\ninclude:\n  - skills/ledger\n';
    write(cwd, '.waffle/waffle.yaml', clean);
    assert.deepEqual(forwardRenamedWaffleRefs({ toolkitRoot: root, cwd }), []);
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), clean);

    const broken = 'include:\n  - [unclosed\n';
    write(cwd, '.waffle/waffle.yaml', broken);
    const notes = [];
    assert.deepEqual(forwardRenamedWaffleRefs({ toolkitRoot: root, cwd, log: (m) => notes.push(m) }), []);
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), broken);
    assert.ok(notes.some((n) => /did not parse cleanly/.test(n)), notes.join('\n'));
  });

  // `install` persists `canonicalRef`, so installing by the OLD name writes the NEW one — the
  // consumer never acquires a stale pin in the first place, which is the cheapest form of this fix.
  test('installing by the old name persists the new ref, not the one that was typed', () => {
    renamedToolkit();
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\ninclude: []\n');
    const result = installRefs({ toolkitRoot: root, cwd, refs: ['skills/mapper'] });
    assert.deepEqual(result.added, ['skills/cartographer']);
    assert.match(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), /- skills\/cartographer/);
  });

  test('a toolkit that has never renamed anything is a total no-op', () => {
    root = makeToolkit(defaultEntries());
    write(cwd, '.waffle/waffle.yaml', 'include:\n  - skills/mapper\n');
    assert.deepEqual(forwardRenamedWaffleRefs({ toolkitRoot: root, cwd }), []);
    // …as is a toolkit with no registry at all.
    fs.rmSync(path.join(root, 'stacks/registry.yaml'));
    assert.deepEqual(forwardRenamedWaffleRefs({ toolkitRoot: root, cwd }), []);
  });

  test('an unwritable splice reports the truth — never a rewrite that did not happen', () => {
    renamedToolkit();
    write(cwd, '.waffle/waffle.yaml', 'include:\n  - skills/mapper\n');
    const notes = [];
    const moves = forwardRenamedWaffleRefs({ toolkitRoot: root, cwd, log: (m) => notes.push(m), writeScalar: () => null });
    assert.deepEqual(moves, [{ from: 'skills/mapper', to: 'skills/cartographer', action: 'unwritable' }]);
    assert.equal(fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8'), 'include:\n  - skills/mapper\n');
    assert.ok(notes.some((n) => /could not be rewritten in place/.test(n)));
  });
});
