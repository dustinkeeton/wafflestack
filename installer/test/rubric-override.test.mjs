import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const rendered = () => read('.claude/skills/pr-response/SKILL.md');
const section = (md, from, to) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));
const tableRows = (md) => [...md.matchAll(/^\| `(\w+)` \| `(prResponse\.rubric\.[\w.]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)];

// #645 (#630 slice 3): a per-run `--rubric` token, model-parsed, so the prose is the contract.
describe('pr-response --rubric run override (#645)', () => {
  test('the argument hint advertises the token after the gate tokens', () => {
    assert.match(rendered(), /argument-hint:.*\[--yes \| --confirm\]\s+\[--rubric <key>=<n>,…\]/);
  });

  test('step 1 carries the mode row and the override subsection, before step 2', () => {
    const md = rendered();
    assert.match(md, /\| `--rubric <spec>` \(with or without a PR ref or gate token\) \| Override this repo's rubric cutoffs and weights for this run only/);
    const sub = md.indexOf('### The rubric run override');
    assert.ok(sub > md.indexOf('## 1. Resolve the target PR') && sub < md.indexOf('## 2. Read every finding'));
    assert.match(md, /before step 2 reads\s+any finding/);
  });

  test('the key table names exactly the declared prResponse.rubric leaves, with their ranges and defaults', () => {
    const config = loadToolkit(repoRoot).stacks.get('github-workflow').config;
    const declared = Object.keys(config).filter((k) => k.startsWith('prResponse.rubric.')).sort();
    const rows = tableRows(rendered());
    assert.deepEqual(rows.map((r) => r[2]).sort(), declared, 'the token table drifted from the stack config');
    for (const [, token, key, range, , dflt] of rows) {
      assert.equal(token, key.split('.').pop());
      const spec = config[key];
      assert.equal(range.trim(), spec.range.max === undefined ? `≥ ${spec.range.min}` : `${spec.range.min}–${spec.range.max}`, key);
      assert.equal(Number(dflt), spec.default, key);
    }
  });

  test('the grammar pins the value shape, the `=` lookahead, case-insensitivity, and no aliases', () => {
    const md = section(rendered(), '### The rubric run override', '## 2. Read every finding');
    assert.ok(md.includes('`-?[0-9]+(\\.[0-9]+)?`'));
    assert.match(md, /only if it\s+contains `=`/);
    assert.match(md, /case-insensitive/);
    assert.match(md, /There are no aliases/);
    assert.match(md, /`--rubric 42` is a malformed override on PR 42/);
  });

  test('validation merges over config first, fails as a whole token, and names the first failing rule', () => {
    const md = section(rendered(), '### The rubric run override', '## 2. Read every finding');
    const order = ['repeated', 'spec is present', 'well-formed', 'one of the seven', 'appears twice', 'is a number', 'Merge the token over', 'in range', '`decline < implement`', 'greater than 0'];
    const at = order.map((s) => md.indexOf(s));
    assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `rule order drifted: ${JSON.stringify(at)}`);
    assert.match(md, /whole token unspecified/);
    assert.match(md, /\(after merging over config\)/);
    assert.match(md, /`--rubric decline=12` \| Unspecified: merged decline \(12\) is not less than config implement \(11\)/);
    assert.match(md, /`--rubric implement=3` \| Unspecified: config decline \(4\) is not less than implement \(3\)/);
    assert.match(md, /`--rubric implement=12 --rubric decline=3` \| Unspecified: repeated/);
    assert.match(md, /`--rubric validity=0` \| Valid\. A false positive still Declines/);
  });

  test('unspecified asks when attended and falls back to config under --yes, departing from autopilot', () => {
    const md = section(rendered(), '### The rubric run override', '## 2. Read every finding');
    assert.match(md, /Unspecified, human-attended run, no `--yes` \| Ask with `AskUserQuestion` before step 2/);
    assert.match(md, /Unspecified, with `--yes` or any non-interactive caller \| Fall back to the rendered config and keep going/);
    assert.match(md, /deliberately departs from autopilot/);
  });

  test('the reply footer names its source; an ignored token is said out loud', () => {
    const md = rendered();
    const after = section(md, '### Reply format', 'Never copy a verdict').split(/```(?:markdown)?\n/)[2];
    assert.ok(after.includes('; source: config'));
    assert.ok(after.includes('; source: run override (--rubric <spec as given>) over\nconfig'));
    assert.ok(after.includes('**Rubric override\nignored**'));
    assert.ok(after.includes('; source: config (--rubric ignored)'));
    assert.match(after, /When any \*\*effective\*\* weight is not 1, add a `Weighted` column after `Score`/);
    assert.match(md, /Report the effective thresholds and\s+weights and their source/);
  });

  test('step 3 reads effective values; the honesty rules bind the override', () => {
    const md = rendered();
    assert.match(md, /unless a `--rubric` token\s+overrides them for this run/);
    assert.match(md, /Wherever this file names a cutoff or a weight, use this run's effective value/);
    assert.match(md, /`--rubric` is not an\s+exception: it is a deliberate per-run policy fixed in step 1/);
    assert.match(md, /\*\*history, never as config\*\*/);
    assert.match(md, /never add or edit one after reading findings/);
    assert.match(md, /A different\s+rubric is not new evidence/);
  });

  test('the key table renders this repo\'s config values', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-645-'));
    try {
      fs.mkdirSync(path.join(cwd, '.waffle'));
      fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), [
        'targets: [claude]',
        'include: [github-workflow/skills/pr-response]',
        'config:',
        '  project:',
        '    name: demo',
        '  prResponse:',
        '    rubric:',
        '      thresholds: { implement: 12 }',
        '      weights: { validity: 2 }',
        '',
      ].join('\n'));
      const r = renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const rows = Object.fromEntries(tableRows(fs.readFileSync(path.join(cwd, '.claude/skills/pr-response/SKILL.md'), 'utf8')).map((m) => [m[1], m[4].trim()]));
      assert.deepEqual(rows, { implement: '12', decline: '4', severity: '1', reach: '1', validity: '2', effortRisk: '1', alignment: '1' });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
