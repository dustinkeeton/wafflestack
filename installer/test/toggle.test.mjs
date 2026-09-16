import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { doctor } from '../lib/doctor.mjs';
import { installRefs } from '../lib/eject.mjs';
import { loadProjectConfig } from '../lib/project.mjs';
import { normalizeModelInvocation, applyModelInvocation, overrideFor, sourceDisablesModelInvocation } from '../lib/model-invocation.mjs';
import { computeToggleModel, formatToggleTable, toggleChoices, interactiveToggle, applyToggle } from '../lib/toggle.mjs';

// Per-skill model-invocation override + `wafflestack toggle` (#476). Invariants: the override
// flows config → render → lock (doctor clean), patches ONLY the claude copy, the picker never
// runs non-TTY, and `esc` leaves the config byte-identical.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO_ROOT, 'installer', 'cli.mjs');
const KEY = 'disable-model-invocation: true';

const write = (cwd, rel, content) => {
  const abs = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};
const read = (cwd, rel) => fs.readFileSync(path.join(cwd, rel), 'utf8');
const frontmatterOf = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
const runCli = (args, cwd) =>
  spawnSync(process.execPath, [CLI, ...args, '--cwd', cwd, '--offline'], { encoding: 'utf8', timeout: 60000 });

describe('skills.modelInvocation: config normalization (#476)', () => {
  const norm = (skills) => normalizeModelInvocation(skills, '.waffle/waffle.yaml');

  test('absent block → empty override; names dedupe and shed a `skills/` prefix', () => {
    assert.deepEqual(norm(undefined), { disabled: [], enabled: [] });
    assert.deepEqual(norm({ modelInvocation: null }), { disabled: [], enabled: [] });
    assert.deepEqual(norm({ modelInvocation: { disabled: ['skills/audit', 'audit', ' delegate '] } }), {
      disabled: ['audit', 'delegate'],
      enabled: [],
    });
  });

  test('shape errors name the file and the offending path', () => {
    assert.throws(() => norm(['audit']), /skills: must be a map/);
    assert.throws(() => norm({ modelInvocation: 'audit' }), /skills\.modelInvocation: must be a map/);
    assert.throws(() => norm({ modelInvocation: { disabled: 'audit' } }), /disabled must be a list of skill names/);
    assert.throws(() => norm({ modelInvocation: { disabled: [{ name: 'audit' }] } }), /must contain bare skill names/);
    assert.throws(() => norm({ modelInvocation: { off: ['audit'] } }), /unknown key\(s\) off — allowed: disabled, enabled/);
    assert.throws(() => norm({ invocation: {} }), /skills: has unknown key\(s\) invocation/);
  });

  test('a skill on both sides is a hard error', () => {
    assert.throws(() => norm({ modelInvocation: { disabled: ['audit'], enabled: ['audit'] } }), /BOTH disabled: and enabled:/);
  });

  test('overrideFor: true / false / null verdicts', () => {
    const o = { disabled: ['a'], enabled: ['b'] };
    assert.equal(overrideFor(o, 'a'), true);
    assert.equal(overrideFor(o, 'b'), false);
    assert.equal(overrideFor(o, 'c'), null);
    assert.equal(overrideFor(undefined, 'a'), null);
  });
});

describe('applyModelInvocation: the frontmatter patch (#476)', () => {
  const plain = '---\nname: sa\ndescription: Skill A.\n---\n\n# Body\n';
  const off = '---\nname: sb\ndescription: Skill B.\ndisable-model-invocation: true\n---\n\n# Body\n';

  test('null leaves the text byte-identical', () => {
    assert.equal(applyModelInvocation(plain, null), plain);
    assert.equal(applyModelInvocation(off, null), off);
  });

  test('true appends the key as the last frontmatter line, or rewrites an existing one in place', () => {
    assert.equal(applyModelInvocation(plain, true), `---\nname: sa\ndescription: Skill A.\n${KEY}\n---\n\n# Body\n`);
    const falsy = '---\nname: sb\ndisable-model-invocation: false\ndescription: Skill B.\n---\n\n# Body\n';
    assert.equal(applyModelInvocation(falsy, true), `---\nname: sb\n${KEY}\ndescription: Skill B.\n---\n\n# Body\n`);
    assert.equal(applyModelInvocation(off, true), off);
  });

  test('false strips the key; a source without it is untouched', () => {
    assert.equal(applyModelInvocation(off, false), '---\nname: sb\ndescription: Skill B.\n---\n\n# Body\n');
    assert.equal(applyModelInvocation(plain, false), plain);
  });

  test('a body with no frontmatter is never touched, and CRLF frontmatter keeps its line endings', () => {
    assert.equal(applyModelInvocation('# no frontmatter\n', true), '# no frontmatter\n');
    const crlf = '---\r\nname: sa\r\n---\r\n\r\n# Body\r\n';
    assert.equal(applyModelInvocation(crlf, true), `---\r\nname: sa\r\n${KEY}\r\n---\r\n\r\n# Body\r\n`);
  });

  test('sourceDisablesModelInvocation reads only a literal `true`', () => {
    assert.equal(sourceDisablesModelInvocation(off), true);
    assert.equal(sourceDisablesModelInvocation(plain), false);
    assert.equal(sourceDisablesModelInvocation('---\nname: x\ndisable-model-invocation: "true"\n---\n\nb\n'), false);
  });
});

// Fixture: `sa` is agent-invocable at source, `sb` is slash-only at source (the stack author's call).
describe('render + toggle against a fixture toolkit (#476)', () => {
  let toolkitRoot;
  let cwd;

  beforeEach(() => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-toggle-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-toggle-'));
    write(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: toggle fixture\nstacks: [alpha, beta]\n');
    write(toolkitRoot, 'stacks/alpha/stack.yaml', 'name: alpha\ndescription: Alpha stack.\nskills: [sa, sb]\n');
    write(toolkitRoot, 'stacks/alpha/skills/sa/SKILL.md', '---\nname: sa\ndescription: Skill A.\nargument-hint: "<x>"\n---\n\n# Skill A\n');
    write(toolkitRoot, 'stacks/alpha/skills/sb/SKILL.md', '---\nname: sb\ndescription: Skill B.\ndisable-model-invocation: true\n---\n\n# Skill B\n');
    write(toolkitRoot, 'stacks/beta/stack.yaml', 'name: beta\ndescription: Beta stack.\nskills: [sc]\n');
    write(toolkitRoot, 'stacks/beta/skills/sc/SKILL.md', '---\nname: sc\ndescription: Skill C.\n---\n\n# Skill C\n');
  });
  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const configure = (lines) => write(cwd, '.waffle/waffle.yaml', `${lines.join('\n')}\n`);
  const render = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '1.0.0' });
  const check = () => doctor({ cwd, toolkitVersion: '1.0.0' });
  const model = () => computeToggleModel({ toolkitRoot, cwd });
  const rowFor = (m, name) => m.rows.find((r) => r.name === name);

  test('disabled: patches the claude copy only, the lock records the patched bytes, the cheat sheet still lists the skill', () => {
    configure(['targets: [claude, agents-dir]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa]']);
    const result = render();
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(result.warnings.filter((w) => /modelInvocation/.test(w)), []);
    assert.match(frontmatterOf(read(cwd, '.claude/skills/sa/SKILL.md')), new RegExp(`\\n${KEY}$`));
    assert.doesNotMatch(read(cwd, '.agents/skills/sa/SKILL.md'), /disable-model-invocation/);
    assert.equal(check().ok, true, 'doctor clean: the lock hashes the patched output');
    assert.match(read(cwd, '.waffle/CHEATSHEET.md'), /`\/sa`/);
  });

  test('enabled: strips a source-set key from the claude copy; the cross-tool copy keeps the source verbatim', () => {
    configure(['targets: [claude, codex]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    enabled: [sb]']);
    assert.equal(render().ok, true);
    assert.doesNotMatch(read(cwd, '.claude/skills/sb/SKILL.md'), /disable-model-invocation/);
    assert.match(read(cwd, '.agents/skills/sb/SKILL.md'), /disable-model-invocation: true/);
    assert.equal(check().ok, true);
  });

  test('a project extension is appended AFTER the patched frontmatter, never inside it', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa]']);
    write(cwd, '.waffle/extensions/skills/sa.md', 'Project note.\n');
    assert.equal(render().ok, true);
    const out = read(cwd, '.claude/skills/sa/SKILL.md');
    assert.ok(out.indexOf(KEY) < out.indexOf('---\n\n# Skill A'), 'key sits in the frontmatter');
    assert.ok(out.indexOf('BEGIN project extension') > out.indexOf('# Skill A'), 'extension follows the body');
  });

  test('flipping the override changes exactly one byte-run; removing it restores the verbatim source', () => {
    configure(['targets: [claude]', 'stacks: [alpha]']);
    assert.equal(render().ok, true);
    const verbatim = read(cwd, '.claude/skills/sa/SKILL.md');
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa]']);
    assert.equal(render().ok, true);
    assert.equal(read(cwd, '.claude/skills/sa/SKILL.md'), verbatim.replace('argument-hint: "<x>"\n', `argument-hint: "<x>"\n${KEY}\n`));
    configure(['targets: [claude]', 'stacks: [alpha]']);
    assert.equal(render().ok, true);
    assert.equal(read(cwd, '.claude/skills/sa/SKILL.md'), verbatim);
    assert.equal(check().ok, true);
  });

  test('a name no selected stack renders is a warning, kept in config, never an error', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sc, ghost]']);
    const result = render();
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /skills\.modelInvocation names sc, ghost, which no selected stack renders/.test(w)), JSON.stringify(result.warnings));
    assert.match(read(cwd, '.waffle/waffle.yaml'), /disabled: \[sc, ghost\]/);
  });

  test('without a claude target the override is a documented no-op with a warning', () => {
    configure(['targets: [agents-dir]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa]']);
    const result = render();
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /no `claude` target is enabled — the override is a no-op/.test(w)), JSON.stringify(result.warnings));
    assert.doesNotMatch(read(cwd, '.agents/skills/sa/SKILL.md'), /disable-model-invocation/);
  });

  test('a malformed block refuses the render, the same posture as invalid targets', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: sa']);
    assert.throws(render, /skills\.modelInvocation\.disabled must be a list of skill names/);
  });

  test('doctor --verify-render reproduces a render that carries the override (it is canonical, #317)', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa]']);
    assert.equal(render().ok, true);
    const dr = doctor({ cwd, toolkitVersion: '1.0.0', toolkitRoot, verifyRender: true });
    assert.equal(dr.ok, true, JSON.stringify(dr));
  });

  test('computeToggleModel: rows carry source state, effective state, and who decided; unmatched names are carried', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa, ghost]', '    enabled: [sb]']);
    const m = model();
    assert.equal(m.hasClaude, true);
    assert.deepEqual(m.rows.map((r) => r.name), ['sa', 'sb']);
    assert.deepEqual(rowFor(m, 'sa'), { name: 'sa', stack: 'alpha', sourceDisabled: false, disabled: true, override: true });
    assert.deepEqual(rowFor(m, 'sb'), { name: 'sb', stack: 'alpha', sourceDisabled: true, disabled: false, override: false });
    assert.deepEqual(m.carried, { disabled: ['ghost'], enabled: [] });
    assert.deepEqual(m.errors, []);
  });

  test('computeToggleModel reads the COMMITTED config: an overlay never shows up as the override', () => {
    configure(['targets: [claude]', 'stacks: [alpha]']);
    write(cwd, '.waffle/waffle.local.yaml', 'skills:\n  modelInvocation:\n    disabled: [sa]\n');
    assert.equal(rowFor(model(), 'sa').override, null);
  });

  test('formatToggleTable: plain text without ANSI, one row per rendered skill, carried note, summary', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa, ghost]']);
    const out = formatToggleTable(model(), { color: false });
    assert.doesNotMatch(out, /\x1b\[/);
    assert.match(out, /slash-only\s+alpha › sa\s+\(override\)/);
    assert.match(out, /slash-only\s+alpha › sb\s+\(source\)/);
    assert.match(out, /also names ghost, which no selected stack renders/);
    assert.match(out, /summary: 0 agent-invocable, 2 slash-only/);
    assert.ok(out.endsWith('\n'));
    assert.match(formatToggleTable(model(), { color: true }), /\x1b\[/);
  });

  test('formatToggleTable flags a config with no claude target', () => {
    configure(['targets: [codex]', 'stacks: [alpha]']);
    assert.match(formatToggleTable(model(), { color: false }), /no `claude` target is enabled/);
  });

  test('applyToggle writes a MINIMAL block to the committed file, preserving comments; defaults remove it', () => {
    configure(['targets: [claude]', '# keep me', 'stacks: [alpha]', 'config: {}']);
    assert.equal(render().ok, true);
    const r1 = applyToggle({ cwd, model: model(), disable: ['sa', 'sb'] });
    assert.deepEqual(r1, { changed: true, disabled: ['sa'], enabled: [], unknown: [] });
    const yaml = read(cwd, '.waffle/waffle.yaml');
    assert.match(yaml, /# keep me/);
    assert.match(yaml, /skills:\n {2}modelInvocation:\n {4}disabled:\n {6}- sa\n/);
    assert.doesNotMatch(yaml, /sb/, 'sb is slash-only at source already — no entry');
    assert.deepEqual(loadProjectConfig(cwd).modelInvocation, { disabled: ['sa'], enabled: [] });

    const r2 = applyToggle({ cwd, model: model(), enable: ['sa', 'sb'] });
    assert.deepEqual(r2, { changed: true, disabled: [], enabled: ['sb'], unknown: [] });
    assert.match(read(cwd, '.waffle/waffle.yaml'), /enabled:\n {6}- sb\n/);

    const r3 = applyToggle({ cwd, model: model(), disable: ['sb'] });
    assert.equal(r3.changed, true);
    const restored = read(cwd, '.waffle/waffle.yaml');
    assert.doesNotMatch(restored, /skills:|modelInvocation/, 'back at source defaults → block removed');
    assert.match(restored, /# keep me/);
  });

  test('applyToggle: no effective change writes nothing; an unknown name writes nothing', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [ghost]']);
    const before = read(cwd, '.waffle/waffle.yaml');
    assert.deepEqual(applyToggle({ cwd, model: model(), disable: ['sb'], enable: ['sa'] }), { changed: false, disabled: ['ghost'], enabled: [], unknown: [] });
    assert.deepEqual(applyToggle({ cwd, model: model(), disable: ['nope'] }), { changed: false, disabled: [], enabled: [], unknown: ['nope'] });
    assert.equal(read(cwd, '.waffle/waffle.yaml'), before);
  });

  test('applyToggle keeps carried (unmatched) names alongside a new entry', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [ghost]']);
    const r = applyToggle({ cwd, model: model(), disable: ['sa'] });
    assert.deepEqual(r, { changed: true, disabled: ['ghost', 'sa'], enabled: [], unknown: [] });
  });

  test('`install` (comment-preserving config edit) leaves the block intact', () => {
    configure(['targets: [claude]', 'stacks: [alpha]', 'skills:', '  modelInvocation:', '    disabled: [sa]']);
    installRefs({ toolkitRoot, cwd, refs: ['beta'] });
    assert.deepEqual(loadProjectConfig(cwd).modelInvocation, { disabled: ['sa'], enabled: [] });
    assert.equal(render().ok, true);
    assert.match(read(cwd, '.claude/skills/sa/SKILL.md'), /disable-model-invocation: true/);
    assert.doesNotMatch(read(cwd, '.claude/skills/sc/SKILL.md'), /disable-model-invocation/);
  });

  test('toggleChoices: checked = agent-invocable', () => {
    configure(['targets: [claude]', 'stacks: [alpha]']);
    assert.deepEqual(toggleChoices(model()), [
      { name: 'sa', stack: 'alpha', sourceDisabled: false, checked: true },
      { name: 'sb', stack: 'alpha', sourceDisabled: true, checked: false },
    ]);
  });

  // The picker is driven through fake streams: `emitKeypressEvents` decodes raw bytes on any Readable.
  const drive = (m, keys) => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const done = interactiveToggle(m, { input, output });
    for (const k of keys) input.write(k);
    return done;
  };

  test('picker: space on the first row + enter resolves the FULL desired state', async () => {
    configure(['targets: [claude]', 'stacks: [alpha]']);
    const result = await drive(model(), [' ', '\r']);
    assert.deepEqual(result, { applied: true, disable: ['sa', 'sb'], enable: [] });
  });

  test('picker: j moves down, space re-enables the source-disabled row, enter applies', async () => {
    configure(['targets: [claude]', 'stacks: [alpha]']);
    const result = await drive(model(), ['j', ' ', '\r']);
    assert.deepEqual(result, { applied: true, disable: [], enable: ['sa', 'sb'] });
  });

  test('picker: escape resolves applied=false with empty lists, so the caller writes nothing', async () => {
    configure(['targets: [claude]', 'stacks: [alpha]']);
    const result = await drive(model(), [' ', '\x1b']);
    assert.deepEqual(result, { applied: false, disable: [], enable: [] });
  });

  test('picker: no claude target / no rendered skills resolve immediately with a reason (input never read)', async () => {
    configure(['targets: [codex]', 'stacks: [alpha]']);
    assert.match((await interactiveToggle(model(), { input: new PassThrough(), output: new PassThrough() })).reason, /no `claude` target/);
    configure(['targets: [claude]', 'stacks: []']);
    assert.match((await interactiveToggle(model(), { input: new PassThrough(), output: new PassThrough() })).reason, /no skills are rendered/);
  });
});

// Real-CLI spawns against the shipped toolkit: non-TTY safety and the flag path, end to end.
describe('CLI toggle (#476)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-toggle-cli-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('non-TTY `toggle` prints the table and exits 0 — it never opens the picker', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\nconfig: {}\n');
    const run = runCli(['toggle'], cwd);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /wafflestack toggle/);
    assert.match(run.stdout, /\(no skills rendered\)/);
    assert.match(run.stdout, /summary: 0 agent-invocable, 0 slash-only/);
  });

  test('--disable then --enable round-trip the shipped stack: key set, doctor clean, key gone', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [wafflestack]\nconfig: {}\n');
    const first = runCli(['render', '--allow-unreleased'], cwd);
    assert.equal(first.status, 0, first.stdout + first.stderr);

    const off = runCli(['toggle', '--disable', 'waffle-doctor,waffle-eject', '--allow-unreleased'], cwd);
    assert.equal(off.status, 0, off.stdout + off.stderr);
    assert.match(off.stdout, /skills\.modelInvocation → disabled: waffle-doctor, waffle-eject/);
    assert.match(read(cwd, '.claude/skills/waffle-doctor/SKILL.md'), /disable-model-invocation: true/);
    assert.match(read(cwd, '.claude/skills/waffle-eject/SKILL.md'), /disable-model-invocation: true/);
    assert.doesNotMatch(read(cwd, '.claude/skills/waffle-render/SKILL.md'), /disable-model-invocation/);
    assert.match(read(cwd, '.waffle/CHEATSHEET.md'), /`\/waffle-doctor`/);
    const dr = runCli(['doctor'], cwd);
    assert.equal(dr.status, 0, dr.stdout + dr.stderr);
    assert.match(runCli(['toggle'], cwd).stdout, /slash-only\s+wafflestack › waffle-doctor\s+\(override\)/);

    const same = runCli(['toggle', '--disable', 'waffle-doctor', '--allow-unreleased'], cwd);
    assert.equal(same.status, 0);
    assert.match(same.stdout, /no change/);

    const on = runCli(['toggle', '--enable', 'waffle-doctor', '--enable', 'waffle-eject', '--allow-unreleased'], cwd);
    assert.equal(on.status, 0, on.stdout + on.stderr);
    assert.match(on.stdout, /removed \(source defaults\)/);
    assert.doesNotMatch(read(cwd, '.claude/skills/waffle-doctor/SKILL.md'), /disable-model-invocation/);
    assert.doesNotMatch(read(cwd, '.waffle/waffle.yaml'), /modelInvocation/);
    assert.equal(runCli(['doctor'], cwd).status, 0);
  });

  test('bad invocations exit 1 before anything is written', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\nconfig: {}\n');
    const before = read(cwd, '.waffle/waffle.yaml');
    const refs = runCli(['toggle', 'skills/foo'], cwd);
    assert.equal(refs.status, 1);
    assert.match(refs.stderr, /takes no refs/);
    const both = runCli(['toggle', '--disable', 'x', '--enable', 'x'], cwd);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /passed to both --disable and --enable/);
    const unknown = runCli(['toggle', '--disable', 'nope', '--allow-unreleased'], cwd);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /nope is not a rendered skill/);
    const bare = runCli(['toggle', '--disable'], cwd);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /--disable requires a skill name/);
    assert.equal(read(cwd, '.waffle/waffle.yaml'), before);
  });

  test('a selection that does not render refuses BEFORE the config write (#484 F1)', () => {
    write(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [wafflestack]\ninclude: [skills/does-not-exist]\nconfig: {}\n');
    const before = read(cwd, '.waffle/waffle.yaml');
    const run = runCli(['toggle', '--disable', 'waffle-doctor', '--allow-unreleased'], cwd);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /does not render .* nothing was written/);
    assert.match(run.stderr, /does-not-exist/);
    assert.doesNotMatch(run.stdout, /modelInvocation/);
    assert.equal(read(cwd, '.waffle/waffle.yaml'), before);
    assert.equal(fs.existsSync(path.join(cwd, '.claude')), false, 'nothing rendered either');
    const table = runCli(['toggle'], cwd);
    assert.equal(table.status, 0, 'the read-only table still prints, with the problem as a note');
    assert.match(table.stdout, /selection problem: .*does-not-exist/);
  });

  test('help and usage list toggle and its flags', () => {
    const run = runCli(['help'], cwd);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /\|toggle\|/);
    assert.match(run.stdout, /--disable SKILL/);
    assert.match(run.stdout, /--enable SKILL/);
  });
});
