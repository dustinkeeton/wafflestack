// Recommended external plugins (#199) — a stack pointing at harness plugins that live OUTSIDE the
// toolkit, so `setup` can offer them with the author's rationale.
//
// Three properties are worth a test each, and they are the three the feature stands or falls on:
//   1. INERTNESS — declaring recommendations changes no rendered byte and no lock entry. A plugin
//      is not a waffle; if this suite passes while the render moves, the key has quietly become an
//      install mechanism, which is exactly what it must never be.
//   2. OFFERED, NOT INSTALLED — the entries reach the setup surface (per-stack section + a gated
//      intro paragraph teaching offer-never-install), and a stack declaring none is byte-unchanged.
//   3. LINTED, NOT THROWN — every malformation is a `validate` problem, never a load error, and a
//      malformed entry is dropped from the offer rather than shown half-formed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadToolkit } from '../lib/toolkit.mjs';
import { normalizeRecommendedPlugins, offerablePlugins, PLUGIN_ENTRY_KEYS } from '../lib/plugins.mjs';
import { validateToolkit } from '../lib/validate.mjs';
import { toolkitInventory } from '../lib/setup.mjs';
import { renderProject } from '../lib/render.mjs';

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

/**
 * A one-stack fixture toolkit (`demo`: one agent + one skill), plus whatever `recommendedPlugins:`
 * YAML the test wants appended to its manifest. No registry file — this feature is orthogonal to
 * the waffle registry, and leaving it out proves it.
 */
function makeToolkit(pluginsYaml = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-plugins-'));
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: plugins fixture\nstacks: [demo]\n');
  write(root, 'stacks/demo/stack.yaml', `name: demo\ndescription: Demo stack.\nagents: [helper]\nskills: [demo-skill]\n${pluginsYaml}`);
  write(root, 'stacks/demo/agents/helper.md', '---\nname: helper\ndescription: A helper.\nskills: [demo-skill]\n---\n\nHelper body.\n');
  write(root, 'stacks/demo/skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: A demo skill.\n---\n\nDemo body.\n');
  return root;
}

/** The well-formed entry every "good path" test uses, as manifest YAML. */
const GOOD_PLUGIN = [
  'recommendedPlugins:',
  '  - name: acme-reviewer',
  '    source: acme/claude-plugins',
  '    why: Adds inline review comments the demo skill answers.',
  '    items: [skills/demo-skill]',
  '    targets: [claude]',
  '',
].join('\n');

const demoOf = (root) => loadToolkit(root).stacks.get('demo');
const problemsFor = (root) => validateToolkit(root).filter((p) => /plugin/.test(p));
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

describe('recommended plugins: the manifest key and its normalization (#199)', () => {
  test('a well-formed entry loads with every field, items normalized to refs', () => {
    const root = makeToolkit(GOOD_PLUGIN);
    try {
      const [p] = demoOf(root).recommendedPlugins;
      assert.equal(p.name, 'acme-reviewer');
      assert.equal(p.source, 'acme/claude-plugins');
      assert.equal(p.why, 'Adds inline review comments the demo skill answers.');
      assert.deepEqual(p.items, ['skills/demo-skill']);
      assert.deepEqual(p.targets, ['claude']);
      assert.deepEqual(p.unknownKeys, []);
      assert.deepEqual(validateToolkit(root), []);
    } finally {
      cleanup(root);
    }
  });

  test('a stack declaring none loads as [] (generic, not name-keyed)', () => {
    const root = makeToolkit();
    try {
      assert.deepEqual(demoOf(root).recommendedPlugins, []);
    } finally {
      cleanup(root);
    }
  });

  test('normalization is total: no shape throws, and every unusable field lands as null', () => {
    // The loader's contract is tolerance — this key can never be the reason a toolkit fails to
    // load, because at absolute worst a bad recommendation goes unmentioned.
    for (const raw of [undefined, null, 'a string', 42, [null], [['nested']], [{ name: 7 }]]) {
      assert.doesNotThrow(() => normalizeRecommendedPlugins(raw), `threw on ${JSON.stringify(raw ?? null)}`);
    }
    const [entry] = normalizeRecommendedPlugins([{ name: 7, items: 'skills/x', targets: 'claude' }]);
    assert.equal(entry.name, null, 'a non-string name is null, not "7"');
    assert.equal(entry.items, null, 'a non-list items: is null so validate can tell it from absent');
    assert.equal(entry.targets, null);
  });

  test('a present-but-not-a-list value becomes ONE unusable entry, so validate reports it', () => {
    // The failure mode this avoids is silence: `prerequisites:` written as a map simply vanishes.
    const entries = normalizeRecommendedPlugins({ name: 'x' });
    assert.equal(entries.length, 1);
    const root = makeToolkit('recommendedPlugins: acme/claude-plugins\n');
    try {
      assert.ok(
        problemsFor(root).some((p) => /must be a mapping/.test(p)),
        'a scalar recommendedPlugins: must be reported, never silently dropped',
      );
    } finally {
      cleanup(root);
    }
  });

  test('offerablePlugins shows only what a user could act on', () => {
    const entries = normalizeRecommendedPlugins([
      { name: 'ok', source: 'acme/x', why: 'because' },
      { name: 'no-source', why: 'because' },
      { source: 'acme/y', why: 'because' },
    ]);
    assert.deepEqual(offerablePlugins(entries).map((p) => p.name), ['ok']);
    assert.deepEqual(offerablePlugins(undefined), []);
  });
});

describe('recommended plugins: validate lints every malformation (#199)', () => {
  /** Append one entry (as YAML lines) and return the plugin-related problems it produces. */
  function problemsForEntry(lines) {
    const root = makeToolkit(['recommendedPlugins:', ...lines, ''].join('\n'));
    try {
      return problemsFor(root);
    } finally {
      cleanup(root);
    }
  }

  test('each of the three required fields is required', () => {
    // `why` is required for a reason worth pinning: a wizard pitching an unexplained third-party
    // install is worse than one that stays quiet.
    assert.ok(problemsForEntry(['  - source: acme/x', '    why: Because.']).some((p) => /missing a `name`/.test(p)));
    assert.ok(problemsForEntry(['  - name: acme', '    why: Because.']).some((p) => /missing a `source`/.test(p)));
    assert.ok(problemsForEntry(['  - name: acme', '    source: acme/x']).some((p) => /missing a `why`/.test(p)));
  });

  test('an unknown key is reported, not ignored', () => {
    // The real slip is a near-miss on the rationale field, which would otherwise leave the entry
    // silently unexplained — the one thing it exists to carry.
    const problems = problemsForEntry(['  - name: acme', '    source: acme/x', '    reason: Because.']);
    assert.ok(problems.some((p) => /unknown key "reason"/.test(p) && p.includes(PLUGIN_ENTRY_KEYS.join(', '))), problems.join('\n'));
  });

  test('a prose `source` is rejected — it must be something the user can act on', () => {
    const problems = problemsForEntry(['  - name: acme', '    source: search the marketplace for acme', '    why: Because.']);
    assert.ok(problems.some((p) => /contains whitespace/.test(p)), problems.join('\n'));
  });

  test('the same plugin recommended twice is reported', () => {
    const problems = problemsForEntry([
      '  - name: acme',
      '    source: acme/x',
      '    why: Because.',
      '  - name: acme',
      '    source: acme/x',
      '    why: Also because.',
    ]);
    assert.ok(problems.some((p) => /recommended twice/.test(p)), problems.join('\n'));
  });

  test('items: must be a list of refs that resolve in this stack', () => {
    const dangling = problemsForEntry(['  - name: acme', '    source: acme/x', '    why: Because.', '    items: [skills/nope]']);
    assert.ok(dangling.some((p) => /`items:` entry "skills\/nope" does not match/.test(p)), dangling.join('\n'));
    const notAList = problemsForEntry(['  - name: acme', '    source: acme/x', '    why: Because.', '    items: skills/demo-skill']);
    assert.ok(notAList.some((p) => /`items:` must be a list/.test(p)), notAList.join('\n'));
  });

  test('targets: must name real harnesses', () => {
    const unknown = problemsForEntry(['  - name: acme', '    source: acme/x', '    why: Because.', '    targets: [claud]']);
    assert.ok(unknown.some((p) => /unknown target "claud"/.test(p)), unknown.join('\n'));
    const notAList = problemsForEntry(['  - name: acme', '    source: acme/x', '    why: Because.', '    targets: claude']);
    assert.ok(notAList.some((p) => /`targets:` must be a list/.test(p)), notAList.join('\n'));
  });

  test('no malformation is ever a LOAD error — validate reports, the toolkit still loads', () => {
    const root = makeToolkit(['recommendedPlugins:', '  - nonsense', '  - name: acme', '    items: [skills/nope]', ''].join('\n'));
    try {
      assert.doesNotThrow(() => loadToolkit(root));
      assert.ok(problemsFor(root).length >= 3, 'the malformed entries must be reported');
    } finally {
      cleanup(root);
    }
  });
});

describe('recommended plugins: offered by setup, installed by nobody (#199)', () => {
  test('the inventory lists the entry with its reason, source, and both scopes', () => {
    const root = makeToolkit(GOOD_PLUGIN);
    try {
      const inventory = toolkitInventory(loadToolkit(root), '9.9.9');
      assert.match(inventory, /### recommended plugins \(external — offer, never auto-install\)/);
      assert.match(
        inventory,
        /- `acme-reviewer` \[for: claude\] \(suggested with skills\/demo-skill\) — Adds inline review comments the demo skill answers\. — source: `acme\/claude-plugins`/,
      );
      // The gated intro paragraph: what teaches the setup agent the posture, not just the data.
      assert.match(inventory, /A \*\*recommended plugin\*\* \(listed under a stack below\) is an \*\*external harness plugin\*\*/);
      assert.match(inventory, /only on the user's explicit yes/);
    } finally {
      cleanup(root);
    }
  });

  test('a toolkit with no recommendations emits neither the section nor the intro paragraph', () => {
    const root = makeToolkit();
    try {
      const inventory = toolkitInventory(loadToolkit(root), '9.9.9');
      assert.doesNotMatch(inventory, /### recommended plugins/);
      assert.doesNotMatch(inventory, /A \*\*recommended plugin\*\*/);
    } finally {
      cleanup(root);
    }
  });

  test('a malformed entry is not offered (validate reports it; a half-line helps nobody)', () => {
    const root = makeToolkit(['recommendedPlugins:', '  - name: acme-reviewer', '    why: No source, so unfindable.', ''].join('\n'));
    try {
      const inventory = toolkitInventory(loadToolkit(root), '9.9.9');
      assert.doesNotMatch(inventory, /acme-reviewer/);
      assert.doesNotMatch(inventory, /### recommended plugins/);
    } finally {
      cleanup(root);
    }
  });

  test('INERTNESS: declaring recommendations changes no rendered byte and no lock entry', () => {
    // The property the whole design rests on. A plugin is not a waffle: `setup` may talk about it,
    // but `render` must be unable to tell the difference.
    const renderInto = (root) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-plugins-'));
      write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [demo]\n');
      const result = renderProject({ toolkitRoot: root, cwd, toolkitVersion: '0.0.test' });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      const files = fs.readdirSync(cwd, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(cwd, path.join(e.parentPath ?? e.path, e.name)))
        .sort();
      const contents = files.map((f) => `${f}\n${fs.readFileSync(path.join(cwd, f), 'utf8')}`).join('\n---\n');
      fs.rmSync(cwd, { recursive: true, force: true });
      return contents;
    };
    const bare = makeToolkit();
    const withPlugins = makeToolkit(GOOD_PLUGIN);
    try {
      assert.equal(renderInto(withPlugins), renderInto(bare));
    } finally {
      cleanup(bare);
      cleanup(withPlugins);
    }
  });
});
