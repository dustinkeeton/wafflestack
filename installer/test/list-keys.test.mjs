import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, substitute } from '../lib/template.mjs';
import { makeResolver, retiredConfigProblems } from '../lib/project.mjs';
import { listKeyProblems } from '../lib/validate.mjs';

// #612: `listFormat:` renders a list as code bullets; `omitWhenEmpty:` blanks a composed key on an empty gate.
const stack = {
  name: 'demo',
  config: {
    'demo.paths': { listFormat: 'code-bullets', default: ['A.md', 'b/**'] },
    'demo.section': { omitWhenEmpty: 'demo.paths', default: '## Kept\n\n{{demo.paths}}' },
  },
};
const declared = new Set(Object.keys(stack.config));
const guards = { patterns: new Map(), entryPatterns: new Map(), modes: new Map(), listFormats: new Map([['demo.paths', 'code-bullets']]) };
const render = (values) => {
  const errors = [];
  const out = substitute('{{demo.section}}', makeResolver(stack, values, 'claude'), declared, errors, 'ctx', guards);
  return { out, errors };
};

describe('list keys: listFormat + omitWhenEmpty (#612)', () => {
  test('a plain string list still joins with ", "; code-bullets renders one backticked line each', () => {
    assert.equal(formatValue(['a', 'b']), 'a, b');
    assert.equal(formatValue(['a', 'b'], 'code-bullets'), '- `a`\n- `b`');
  });

  test('the default list renders through the composed key', () => {
    assert.deepEqual(render({}), { out: '## Kept\n\n- `A.md`\n- `b/**`', errors: [] });
  });

  test('an override replaces the list', () => {
    assert.equal(render({ demo: { paths: ['X.md'] } }).out, '## Kept\n\n- `X.md`');
  });

  for (const empty of [[], '', null]) {
    test(`a gate of ${JSON.stringify(empty)} renders the composed key as nothing`, () => {
      assert.deepEqual(render({ demo: { paths: empty } }), { out: '', errors: [] });
    });
  }

  test('a non-list or a backticked entry fails instead of breaking the bullets', () => {
    assert.match(render({ demo: { paths: 'A.md' } }).errors.join('\n'), /must be a list of strings/);
    assert.match(render({ demo: { paths: ['a`b'] } }).errors.join('\n'), /no backticks/);
  });

  test('the resolver hands state/setup callers the raw list', () => {
    assert.deepEqual(makeResolver(stack, {}, 'claude')('demo.paths'), ['A.md', 'b/**']);
  });

  test('validate lints both fields', () => {
    assert.deepEqual(listKeyProblems('demo.paths', stack.config['demo.paths'], stack.config), []);
    assert.deepEqual(listKeyProblems('demo.section', stack.config['demo.section'], stack.config), []);
    assert.match(listKeyProblems('k', { listFormat: 'csv' }, {})[0], /must be one of: code-bullets/);
    assert.match(listKeyProblems('k', { listFormat: 'code-bullets', default: 'A.md' }, {})[0], /default is not a list/);
    assert.match(listKeyProblems('k', { omitWhenEmpty: 'k' }, {})[0], /must name another config key/);
    assert.match(listKeyProblems('k', { omitWhenEmpty: 'nope' }, {})[0], /names nope, which this stack does not declare/);
  });

  test('a retired key is reported only when set', () => {
    assert.deepEqual(retiredConfigProblems({}), []);
    assert.match(retiredConfigProblems({ docs: { voiceGuardrailSection: '' } })[0], /removed in 0\.18\.0/);
  });
});
