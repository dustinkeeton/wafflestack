import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateToolkit, behavioralKeyProblems } from '../lib/validate.mjs';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { modeProblems, PROMPT_MODE, parseFlagPlaceholder, flagPlaceholders, undeclaredFlagProblem } from '../lib/template.mjs';
import { makeResolver } from '../lib/project.mjs';
import { sha256 } from '../lib/util.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const GATE_LINE = 'The gate for this run is **{{demo.gate}}**.';

/** A one-stack fixture toolkit whose single skill references `{{demo.gate}}` (or `skillLines`), so the key is "used". */
function fixtureToolkit(specLines, skillLines = [GATE_LINE]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-478-'));
  write(root, 'toolkit.yaml', 'name: fixture\ndescription: x\nstacks: [demo]\n');
  write(root, 'stacks/demo/stack.yaml', [
    'name: demo',
    'description: Demo.',
    'skills: [gated]',
    'config:',
    '  demo.gate:',
    ...specLines.map((l) => `    ${l}`),
    '    description: Whether the gated skill pauses.',
    '',
  ].join('\n'));
  write(root, 'stacks/demo/skills/gated/SKILL.md', [
    '---', 'name: gated', 'description: A gated skill.', '---', '',
    ...skillLines, '',
  ].join('\n'));
  return root;
}

const WELL_FORMED = [
  'required: false',
  'default: true',
  'modes: [true, false, prompt]',
  'nonInteractive: false',
  'flag: { on: "--confirm", off: "--yes" }',
];

describe('behavioral config keys — stack-side validate rules (#478)', () => {
  const problemsFor = (specLines) => {
    const root = fixtureToolkit(specLines);
    try {
      return validateToolkit(root).filter((p) => p.includes('demo.gate'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const expectProblem = (specLines, re) => {
    const problems = problemsFor(specLines);
    assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);
  };

  test('a well-formed three-mode key with a flag and a nonInteractive fallback validates clean', () => {
    assert.deepEqual(problemsFor(WELL_FORMED), []);
  });

  test('a plain key (no behavioral fields) is untouched by the new rules', () => {
    assert.deepEqual(problemsFor(['required: false', 'default: some text']), []);
  });

  test('a default outside modes is rejected — the acceptance criterion', () => {
    expectProblem(['default: maybe', 'modes: [true, false]'], /default "maybe" is not one of its declared modes/);
  });

  test('modes must be a non-empty list of scalars, with no duplicates', () => {
    expectProblem(['default: true', 'modes: []'], /`modes` must be a non-empty list of scalars/);
    expectProblem(['default: true', 'modes: true'], /`modes` must be a non-empty list of scalars/);
    expectProblem(['default: true', 'modes: [true, { a: 1 }]'], /`modes` must be a non-empty list of scalars/);
    expectProblem(['default: true', 'modes: [true, false, true]'], /`modes` lists true more than once/);
    expectProblem(['default: true', 'modes: [true, "true"]'], /`modes` lists "true" more than once/);
  });

  test('modes and a pattern guard are mutually exclusive', () => {
    expectProblem(['default: a', 'modes: [a, b]', "pattern: '[ab]'"], /declares both `modes` and a `pattern`\/`entryPatterns` guard/);
  });

  test('a nested default is not judged against modes (it resolves at render)', () => {
    const problems = problemsFor(['default: "{{demo.other}}"', 'modes: [true, false]']);
    assert.ok(!problems.some((p) => /not one of its declared modes/.test(p)), JSON.stringify(problems));
  });

  test('lockMode must equal the literal default and sit inside modes', () => {
    expectProblem(['default: false', 'modes: [true, false]', 'lockMode: true'], /`lockMode` true does not equal its default false/);
    expectProblem(['default: false', 'lockMode: true'], /`lockMode` true does not equal its default false/);
    expectProblem(['default: off', 'modes: [true, false]', 'lockMode: off'], /`lockMode` "off" is not one of its declared modes/);
    expectProblem(['required: true', 'lockMode: true'], /declares `lockMode` without a literal `default`/);
    expectProblem(['default: true', 'lockMode: [true]'], /`lockMode` must be a scalar mode/);
    assert.deepEqual(problemsFor(['default: false', 'modes: [true, false]', 'lockMode: false']), []);
  });

  test('flag is a map of on/off tokens, each a single whitespace-free string, and needs boolean modes', () => {
    expectProblem(['default: true', 'modes: [true, false]', 'flag: "--yes"'], /`flag` must be a map of \{ on, off \} tokens/);
    expectProblem(['default: true', 'modes: [true, false]', 'flag: { yes: "--yes" }'], /`flag` has unknown key\(s\) yes/);
    expectProblem(['default: true', 'modes: [true, false]', 'flag: {}'], /`flag` must name at least one token/);
    expectProblem(['default: true', 'modes: [true, false]', 'flag: { off: "-- yes" }'], /`flag\.off` must be a single non-empty token/);
    expectProblem(['default: true', 'modes: [true, false]', 'flag: { on: "" }'], /`flag\.on` must be a single non-empty token/);
    expectProblem(['default: true', 'modes: [true, false]', 'flag: { on: "--x", off: "--x" }'], /`flag\.on` and `flag\.off` must be different/);
    expectProblem(['default: true', 'flag: { off: "--yes" }'], /declares a `flag` but no `modes`/);
    expectProblem(['default: a', 'modes: [a, b]', 'flag: { on: "--a" }'], /`modes` may only be true, false, and prompt/);
    assert.deepEqual(problemsFor(['default: true', 'modes: [true, false]', 'flag: { off: "--yes" }']), []);
  });

  test('nonInteractive is required exactly when prompt is a mode, and must be fail or a non-prompt mode', () => {
    expectProblem(['default: true', 'modes: [true, false, prompt]'], /lists `prompt` in its modes but declares no `nonInteractive`/);
    expectProblem(['default: true', 'modes: [true, false]', 'nonInteractive: false'], /declares `nonInteractive` but `prompt` is not one of its modes/);
    expectProblem(['default: true', 'modes: [true, false, prompt]', 'nonInteractive: prompt'], /`nonInteractive` must be `fail` or one of its non-prompt modes/);
    expectProblem(['default: true', 'modes: [true, false, prompt]', 'nonInteractive: maybe'], /`nonInteractive` must be `fail` or one of its non-prompt modes/);
    assert.deepEqual(problemsFor(['default: prompt', 'modes: [true, false, prompt]', 'nonInteractive: fail']), []);
  });

  test('behavioralKeyProblems is the unit behind the loop and reports every problem at once', () => {
    const problems = behavioralKeyProblems({ default: 'x', modes: ['a', 'a'], lockMode: 'b', flag: { on: '--a' } });
    assert.ok(problems.length >= 4, JSON.stringify(problems));
    assert.equal(PROMPT_MODE, 'prompt');
  });
});

describe('behavioral config keys — consumer-side render and doctor guards (#478)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-478-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    if (toolkitRoot) fs.rmSync(toolkitRoot, { recursive: true, force: true });
    toolkitRoot = undefined;
  });

  const project = (value, { local = false } = {}) => {
    const cfg = value === undefined ? 'config: {}\n' : `config:\n  demo:\n    gate: ${value}\n`;
    write(cwd, '.waffle/waffle.yaml', `targets: [claude]\nstacks: [demo]\n${local ? 'config: {}\n' : cfg}`);
    if (local) write(cwd, '.waffle/waffle.local.yaml', cfg);
  };
  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
  const rendered = () => fs.readFileSync(path.join(cwd, '.claude/skills/gated/SKILL.md'), 'utf8');

  test('a value inside modes renders, and the resolved mode lands in the skill', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED);
    project('prompt');
    const r = render();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(rendered(), /The gate for this run is \*\*prompt\*\*/);
  });

  test('a value outside modes fails the render, names the key and the list, and writes no lock', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED);
    project('sometimes');
    const r = render();
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => /config value for \{\{demo\.gate\}\} is not one of its declared modes \[true, false, "prompt"\] \(declared by stack "demo"\)/.test(e)),
      JSON.stringify(r.errors),
    );
    assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), false);
  });

  test('membership is decided on rendered text — a quoted "true" is the true mode', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED);
    project('"true"');
    assert.equal(render().ok, true);
  });

  test('a list or map value is never a mode', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED);
    project('[true]');
    const r = render();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /\{\{demo\.gate\}\} must be a scalar, not a list \(the key declares modes:\)/.test(e)), JSON.stringify(r.errors));
  });

  test('a locked key accepts only its lock value from config, and says the flag token is the override', () => {
    toolkitRoot = fixtureToolkit(['default: false', 'modes: [true, false, prompt]', 'lockMode: false', 'nonInteractive: false', 'flag: { on: "+arm" }']);
    project('false');
    assert.equal(render().ok, true, 'restating the lock value is allowed');
    project('true');
    const r = render();
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => /\{\{demo\.gate\}\} is locked to false by stack "demo" \(lockMode\) — config may not set it; the skill's own flag token is the only per-run override/.test(e)),
      JSON.stringify(r.errors),
    );
  });

  test('the local overlay cannot smuggle a locked value past the guard either', () => {
    toolkitRoot = fixtureToolkit(['default: false', 'modes: [true, false]', 'lockMode: false']);
    project('true', { local: true });
    const r = render();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /\{\{demo\.gate\}\} is locked to false/.test(e)), JSON.stringify(r.errors));
  });

  test('bare doctor reports a mode violation introduced after a clean render (no re-render needed)', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED);
    project('false');
    assert.equal(render().ok, true);
    project('sometimes');
    const dr = doctor({ cwd, toolkitVersion: '0.0.test', toolkitRoot });
    assert.equal(dr.ok, false);
    assert.ok(dr.configProblems.some((p) => /\{\{demo\.gate\}\} is not one of its declared modes/.test(p)), JSON.stringify(dr.configProblems));
  });

  test('modeProblems is a no-op for a key with no mode guard', () => {
    assert.equal(modeProblems({ modes: new Map() }, 'x.y', 'anything', 'anything'), null);
    assert.equal(modeProblems(undefined, 'x.y', ['list'], 'list'), null);
  });
});

describe('autopilot consents are locked in config (#478 acceptance)', () => {
  const KEYS = ['autopilot.autoMerge', 'autopilot.reviewLoop', 'autopilot.qaLoop', 'autopilot.auditStep'];
  let cwd;
  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-478-orch-')); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  test('the shipped orchestration stack declares each consent as a locked three-mode key with its + token', () => {
    const toolkit = loadToolkit(repoRoot);
    const config = toolkit.stacks.get('orchestration').config;
    const tokens = { 'autopilot.autoMerge': '+automerge', 'autopilot.reviewLoop': '+review', 'autopilot.qaLoop': '+qa', 'autopilot.auditStep': '+audit' };
    for (const key of KEYS) {
      const spec = config[key];
      assert.deepEqual(spec.modes, [true, false, 'prompt'], key);
      assert.equal(spec.lockMode, 'prompt', key);
      assert.equal(spec.nonInteractive, false, key);
      assert.deepEqual(spec.flag, { on: tokens[key] }, key);
      assert.equal(spec.default, spec.lockMode, `${key}: a locked key defaults to its lock`);
    }
    assert.deepEqual(validateToolkit(repoRoot).filter((p) => /autopilot\./.test(p)), []);
  });

  const renderAutopilot = (consent) => {
    write(cwd, '.waffle/waffle.yaml', [
      'targets: [claude]',
      'include: [orchestration/skills/autopilot]',
      'config:',
      '  project:',
      '    name: Lock478',
      '  roster:',
      '    classificationTable: "| Signal | Agent |"',
      '    labelFallback: "| Label | Agent |"',
      '    rootFiles: package.json',
      '    sharedModule: lib/',
      '    moduleDependencies: none',
      '  audit:',
      '    complianceLabel: Integrity',
      '    complianceFrontmatterLabel: integrity',
      '    complianceTaskLabel: Integrity check',
      '    complianceAgentName: integrity',
      '    complianceDescription: Validates the thing.',
      '    compliancePrompt: Run the checks.',
      ...(consent ? ['  autopilot:', `    autoMerge: ${consent}`] : []),
      '',
    ].join('\n'));
    return renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
  };

  test('autopilot.autoMerge: true (or false) in waffle.yaml is refused by render, naming the lock', () => {
    for (const value of ['true', 'false']) {
      const r = renderAutopilot(value);
      assert.equal(r.ok, false, `consent must never be config-sticky (${value})`);
      assert.ok(
        r.errors.some((e) => /\{\{autopilot\.autoMerge\}\} is locked to "prompt" by stack "orchestration" \(lockMode\)/.test(e)),
        JSON.stringify(r.errors),
      );
    }
  });

  test('autopilot.autoMerge: prompt in waffle.yaml is the one config value the lock admits', () => {
    const r = renderAutopilot('prompt');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test('leaving the key unset renders (the lock value is the default), and bare doctor then catches a later true', () => {
    const r = renderAutopilot(undefined);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    renderAutopilot('true');
    const dr = doctor({ cwd, toolkitVersion: '0.0.test', toolkitRoot: repoRoot });
    assert.equal(dr.ok, false);
    assert.ok(dr.configProblems.some((p) => /\{\{autopilot\.autoMerge\}\} is locked to "prompt"/.test(p)), JSON.stringify(dr.configProblems));
  });
});

describe('flag tokens and the resolved value thread through render (#486)', () => {
  const FLAG_LINES = [GATE_LINE, 'Pass `{{demo.gate.flag.on}}` to force the gate, `{{demo.gate.flag.off}}` to skip it.'];
  const SKILL = '.claude/skills/gated/SKILL.md';
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-486-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    if (toolkitRoot) fs.rmSync(toolkitRoot, { recursive: true, force: true });
    toolkitRoot = undefined;
  });

  const validateFixture = (specLines, skillLines) => {
    toolkitRoot = fixtureToolkit(specLines, skillLines);
    return validateToolkit(toolkitRoot).filter((p) => p.includes('demo'));
  };
  const projectConfig = (file, value) => {
    const cfg = value === undefined ? 'config: {}\n' : `config:\n  demo:\n    gate: ${value}\n`;
    write(cwd, `.waffle/${file}`, `${file === 'waffle.yaml' ? 'targets: [claude]\nstacks: [demo]\n' : ''}${cfg}`);
  };
  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
  const rendered = () => fs.readFileSync(path.join(cwd, SKILL), 'utf8');
  const lockHash = (file) => JSON.parse(fs.readFileSync(path.join(cwd, `.waffle/${file}`), 'utf8')).files[SKILL];

  test('the placeholder helpers: shape, discovery, and the undeclared-side problem', () => {
    assert.deepEqual(parseFlagPlaceholder('demo.gate.flag.on'), { key: 'demo.gate', side: 'on' });
    assert.deepEqual(parseFlagPlaceholder('a.b.c.flag.off'), { key: 'a.b.c', side: 'off' });
    assert.equal(parseFlagPlaceholder('demo.gate'), null);
    assert.equal(parseFlagPlaceholder('demo.gate.flag.maybe'), null);
    const config = { 'demo.gate': { flag: { on: '--confirm' } }, 'demo.plain': { default: 'x' }, 'demo.bad': { flag: 'oops' } };
    assert.deepEqual([...flagPlaceholders(config)], ['demo.gate.flag.on']);
    const declared = new Set(['demo.gate', 'demo.gate.flag.on', 'demo.plain']);
    assert.equal(undeclaredFlagProblem(declared, 'demo.gate.flag.on'), null);
    assert.match(undeclaredFlagProblem(declared, 'demo.gate.flag.off'), /config key demo\.gate does not declare \(flag\.off\)/);
    assert.match(undeclaredFlagProblem(declared, 'demo.plain.flag.on'), /config key demo\.plain does not declare \(flag\.on\)/);
    assert.equal(undeclaredFlagProblem(declared, 'demo.other.flag.on'), null, 'an undeclared base key is the generic undeclared-placeholder case');
  });

  test('validate accepts both token placeholders on a key with a full flag map', () => {
    assert.deepEqual(validateFixture(WELL_FORMED, FLAG_LINES), []);
  });

  test('validate does not demand that a declared token be referenced (the shipped consents reference none yet)', () => {
    assert.deepEqual(validateFixture(WELL_FORMED), []);
  });

  test('validate rejects a token placeholder for a side the key does not declare, naming the side', () => {
    const problems = validateFixture(['default: true', 'modes: [true, false]', 'flag: { on: "--confirm" }'], FLAG_LINES);
    assert.ok(problems.some((p) => /placeholder \{\{demo\.gate\.flag\.off\}\} names a flag token that config key demo\.gate does not declare \(flag\.off\)/.test(p)), JSON.stringify(problems));
    assert.ok(!problems.some((p) => /demo\.gate\.flag\.on/.test(p)), 'the declared side is fine');
  });

  test('validate rejects a token placeholder on a key with no flag at all', () => {
    const problems = validateFixture(['default: true', 'modes: [true, false]'], FLAG_LINES);
    assert.ok(problems.some((p) => /\{\{demo\.gate\.flag\.on\}\} names a flag token that config key demo\.gate does not declare/.test(p)), JSON.stringify(problems));
  });

  test('makeResolver answers a token from the stack spec and ignores any project value for it', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED, FLAG_LINES);
    const stack = loadToolkit(toolkitRoot).stacks.get('demo');
    assert.ok(stack.declared.has('demo.gate.flag.on') && stack.declared.has('demo.gate.flag.off'));
    const resolve = makeResolver(stack, { demo: { gate: { flag: { on: '--smuggled' } } } }, 'claude');
    assert.equal(resolve('demo.gate.flag.on'), '--confirm');
    assert.equal(resolve('demo.gate.flag.off'), '--yes');
    assert.equal(resolve('demo.other.flag.on'), undefined);
  });

  test('a skill renders its resolved default and both tokens', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED, FLAG_LINES);
    projectConfig('waffle.yaml');
    const r = render();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(rendered(), /The gate for this run is \*\*true\*\*/);
    assert.match(rendered(), /Pass `--confirm` to force the gate, `--yes` to skip it\./);
  });

  test('a committed waffle.yaml value replaces the default; the tokens are unchanged', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED, FLAG_LINES);
    projectConfig('waffle.yaml', 'false');
    assert.equal(render().ok, true);
    assert.match(rendered(), /is \*\*false\*\*/);
    assert.match(rendered(), /`--confirm` .* `--yes`/);
  });

  test('render refuses a token placeholder for an undeclared side rather than passing it through', () => {
    toolkitRoot = fixtureToolkit(['default: true', 'modes: [true, false]', 'flag: { on: "--confirm" }'], FLAG_LINES);
    projectConfig('waffle.yaml');
    const r = render();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /\{\{demo\.gate\.flag\.off\}\} names a flag token that config key demo\.gate does not declare \(flag\.off\)/.test(e)), JSON.stringify(r.errors));
    assert.equal(fs.existsSync(path.join(cwd, SKILL)), false);
  });

  test('a waffle.local.yaml override changes the on-disk render and the local lock, never the committed lock', () => {
    toolkitRoot = fixtureToolkit(WELL_FORMED, FLAG_LINES);
    projectConfig('waffle.yaml');
    assert.equal(render().ok, true);
    const canonicalContent = rendered();
    const canonicalHash = lockHash('waffle.lock.json');
    assert.equal(canonicalHash, sha256(canonicalContent));
    assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.local.lock.json')), false);

    projectConfig('waffle.local.yaml', 'prompt');
    const r = render();
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(rendered(), /is \*\*prompt\*\*/, 'the overlay wins on disk');
    assert.match(rendered(), /`--confirm` .* `--yes`/, 'the tokens still come from the stack');
    assert.equal(lockHash('waffle.lock.json'), canonicalHash, 'the committed lock still describes the committed-inputs render');
    assert.equal(lockHash('waffle.local.lock.json'), sha256(rendered()), 'the local lock describes this machine');
    assert.notEqual(lockHash('waffle.local.lock.json'), canonicalHash);
  });

  test('the shipped orchestration consents expose their + tokens as placeholders', () => {
    const stack = loadToolkit(repoRoot).stacks.get('orchestration');
    const resolve = makeResolver(stack, {}, 'claude');
    for (const [key, token] of [['autopilot.autoMerge', '+automerge'], ['autopilot.reviewLoop', '+review'], ['autopilot.qaLoop', '+qa'], ['autopilot.auditStep', '+audit']]) {
      assert.ok(stack.declared.has(`${key}.flag.on`), key);
      assert.ok(!stack.declared.has(`${key}.flag.off`), `${key} declares no off token`);
      assert.equal(resolve(`${key}.flag.on`), token);
    }
  });
});
