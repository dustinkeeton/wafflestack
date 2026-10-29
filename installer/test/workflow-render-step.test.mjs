import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderProject } from '../lib/render.mjs';

// #615: every shipped CI job that reads rendered resources renders the missing ones first.

const WF_DIR = fileURLToPath(new URL('../../stacks/github-workflow/files/.github/workflows/', import.meta.url));
const WORKFLOWS = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml')).sort();
const EXEMPT = { 'waffle-doctor.yml': 'doctor is the render checker; rendering first would hide its gaps' };
const RENDERED_PATH = /(?:^|[\s'"(`])(\.(?:claude|codex|agents|waffle)\/[\w./*-]*)/g;
const NOT_RENDERED = /^\.waffle\/(?:waffle\.yaml|waffle\.lock\.json|waffle\.local\.|telemetry\/)/;
const PROBED = /^\.(?:claude|codex|agents)\//;
const HARNESS_USES = /^(?:__PH_harness\.actionRef__|anthropics\/claude-code-action)/;

const parseWorkflow = (src) => YAML.parse(src.replace(/\{\{([a-z]\w*(?:\.\w+)+)\}\}/g, '__PH_$1__'));
const loadWorkflow = (name) => parseWorkflow(fs.readFileSync(path.join(WF_DIR, name), 'utf8'));

function stepStrings(step) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk({ run: step.run, with: step.with, env: step.env });
  return out;
}

const renderedPaths = (step) =>
  stepStrings(step).flatMap((s) => [...s.matchAll(RENDERED_PATH)].map((m) => m[1]).filter((p) => !NOT_RENDERED.test(p)));
const isRenderStep = (step) => step.id === 'waffle-render';
const isReader = (step) => !isRenderStep(step) && (HARNESS_USES.test(step.uses ?? '') || renderedPaths(step).length > 0);

/** @returns {{readers: string[], violations: string[], renderSteps: object[]}} */
function auditWorkflow(name, wf) {
  const readers = [];
  const violations = [];
  const renderSteps = [];
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    const steps = job.steps ?? [];
    steps.forEach((step, i) => {
      if (isRenderStep(step)) renderSteps.push(step);
      if (!isReader(step)) return;
      const where = `${name} › ${jobName} › ${step.name ?? step.uses}`;
      readers.push(`${name}:${jobName}`);
      for (const p of renderedPaths(step)) {
        if (!PROBED.test(p)) violations.push(`${where}: reads ${p}, outside the waffle-render probe`);
      }
      let checkout = -1;
      for (let j = 0; j < i; j++) if (/^actions\/checkout@/.test(steps[j].uses ?? '')) checkout = j;
      const render = steps.findIndex((s, j) => j > checkout && j < i && isRenderStep(s));
      if (render < 0) violations.push(`${where}: no waffle-render step between its checkout and this reader`);
      else if ((steps[render].if ?? null) !== (step.if ?? null)) violations.push(`${where}: waffle-render's if: differs`);
    });
  }
  return { readers: [...new Set(readers)], violations, renderSteps };
}

const AUDITS = Object.fromEntries(WORKFLOWS.map((n) => [n, auditWorkflow(n, loadWorkflow(n))]));
const canonical = (step) => ({ name: step.name, id: step.id, env: step.env, run: step.run });
const CANONICAL = canonical(AUDITS['waffle-hygiene.yml'].renderSteps[0]);

describe('waffle-render coverage (#615)', () => {
  test('the audit sees every reader job, and only exempt/inert workflows have none', () => {
    const readers = Object.values(AUDITS).flatMap((a) => a.readers);
    for (const job of [
      'waffle-label-hook.yml:enrich',
      'waffle-label-hook.yml:implement',
      'waffle-hygiene.yml:hygiene',
      'waffle-pr-green-hook.yml:adversarial-review',
      'waffle-pr-response-hook.yml:pr-response',
    ]) assert.ok(readers.includes(job), `${job} not detected as a reader`);
    for (const name of ['waffle-release-hook.yml', 'waffle-post-merge-hook.yml', 'waffle-evals.yml']) {
      assert.deepEqual(AUDITS[name].readers, [], `${name} now reads rendered resources`);
    }
    for (const name of Object.keys(EXEMPT)) assert.ok(WORKFLOWS.includes(name), `${name} exempt but not shipped`);
  });

  for (const name of WORKFLOWS.filter((n) => !(n in EXEMPT))) {
    test(`${name}: every reader renders missing resources first`, () => {
      assert.deepEqual(AUDITS[name].violations, []);
    });
  }

  test('every waffle-render step is the one canonical block', () => {
    const all = Object.values(AUDITS).flatMap((a) => a.renderSteps);
    assert.ok(all.length >= 5, `expected ≥5 waffle-render steps, got ${all.length}`);
    for (const step of all) assert.deepEqual(canonical(step), CANONICAL);
    assert.equal(CANONICAL.env.TRUSTED_TOOLKIT, '__PH_doctor.toolkitRef__');
  });

  test('a workflow that reads a skill without the step is reported', () => {
    const wf = parseWorkflow(
      'jobs:\n  x:\n    steps:\n      - uses: actions/checkout@abc\n      - run: cat .claude/skills/x/SKILL.md\n' +
        '  y:\n    steps:\n      - uses: actions/checkout@abc\n      - run: cat .waffle/TEAM.md\n',
    );
    const { violations } = auditWorkflow('synthetic.yml', wf);
    assert.equal(violations.filter((v) => /no waffle-render step/.test(v)).length, 2);
    assert.ok(violations.some((v) => /\.waffle\/TEAM\.md, outside the waffle-render probe/.test(v)));
  });
});

const REAL_GIT = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
const SHA = 'a'.repeat(40);
const PEELED = 'b'.repeat(40);
const exe = (p, body) => {
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(p, 0o755);
};

describe('waffle-render step behavior (#615)', () => {
  let cwd;
  let bin;
  let log;
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), content);
  };
  const git = (...args) =>
    execFileSync(REAL_GIT, ['-c', 'commit.gpgsign=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  const lock = (toolkit) =>
    write('.waffle/waffle.lock.json', JSON.stringify({
      toolkit,
      files: { '.claude/skills/x/SKILL.md': 'h', '.claude/agents/a.md': 'h', '.github/workflows/w.yml': 'h' },
      settings: { '.claude/settings.json#/k': true },
    }));
  const release = (extra = {}) => ({ source: 'github:dustinkeeton/wafflestack', ref: 'v1.2.3', commit: SHA, status: 'release', ...extra });
  const run = ({ trusted = 'github:dustinkeeton/wafflestack#v1.2.3', repo = 'consumer/app', lsRemote = `${SHA}\trefs/tags/v1.2.3\n` } = {}) => {
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    const r = spawnSync('bash', ['-c', CANONICAL.run], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRUSTED_TOOLKIT: trusted, GITHUB_REPOSITORY: repo, LOG: log, LS_REMOTE: lsRemote, GITHUB_STEP_SUMMARY: path.join(bin, 'summary') },
    });
    return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-render-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-render-bin-'));
    log = path.join(bin, 'calls.log');
    git('init', '-q');
    write('.claude/agents/a.md', 'committed\n');
    const fakeRender = 'mkdir -p .claude/skills/x && echo r > .claude/skills/x/SKILL.md && echo {} > .claude/settings.json && echo edited > .claude/agents/a.md';
    exe(path.join(bin, 'npx'), `echo "npx $*" >> "$LOG"\n${fakeRender}`);
    exe(path.join(bin, 'git'), `if [ "$1" = ls-remote ]; then echo "git $*" >> "$LOG"; printf '%b' "$LS_REMOTE"; exit 0; fi\nexec ${REAL_GIT} "$@"`);
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  test('Posture 1: everything committed → no fetch, exit 0', () => {
    lock(release());
    write('.claude/skills/x/SKILL.md', 'x\n');
    write('.claude/settings.json', '{}\n');
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.calls, []);
    assert.match(r.stdout, /nothing to render/);
  });

  test('release pin: verifies the tag on the trusted repo, renders at its commit, fills gaps only', () => {
    lock(release());
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.calls[0], /^git ls-remote --tags -- https:\/\/github\.com\/dustinkeeton\/wafflestack$/);
    assert.equal(r.calls[1], `npx --yes github:dustinkeeton/wafflestack#${SHA} render`);
    assert.equal(fs.readFileSync(path.join(cwd, '.claude/agents/a.md'), 'utf8'), 'committed\n');
    assert.equal(git('status', '--porcelain'), '');
    assert.ok(fs.existsSync(path.join(cwd, '.claude/skills/x/SKILL.md')));
  });

  test('no lock commit → the tag commit; an annotated tag → its peeled commit', () => {
    lock(release({ commit: null }));
    const r = run({ lsRemote: `${SHA}\trefs/tags/v1.2.3\n${PEELED}\trefs/tags/v1.2.3^{}\n${'c'.repeat(40)}\trefs/tags/v1.2.30\n` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.calls[1], `npx --yes github:dustinkeeton/wafflestack#${PEELED} render`);
  });

  const refusals = [
    ['a lock source other than the trusted toolkit', () => release({ source: 'github:evil/fork' }), {}, /not the trusted toolkit/],
    ['a non-tag ref', () => release({ ref: 'main' }), {}, /not a vX\.Y\.Z release tag/],
    ['a lock commit the tag does not point at', () => release({ commit: 'd'.repeat(40) }), {}, /lock pins commit/],
    ['a tag absent from the trusted repo', () => release(), { lsRemote: '' }, /was not found/],
    ['a trusted ref that is not github:owner/repo', () => release(), { trusted: 'wafflestack@1.2.3' }, /not a github:owner\/repo spec/],
    ['an unreleased lock', () => ({ source: 'github:consumer/app', ref: null, commit: null, status: 'unreleased' }), {}, /no release pin.*wafflestack upgrade/],
  ];
  for (const [label, toolkit, opts, message] of refusals) {
    test(`refuses ${label}, fetching nothing`, () => {
      lock(toolkit());
      write('installer/cli.mjs', '');
      const r = run(opts);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, message);
      assert.ok(!r.calls.some((c) => c.startsWith('npx')));
    });
  }

  test('a missing lock fails loudly', () => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /waffle\.lock\.json is missing/);
  });

  test("the toolkit's own repo (per the trusted ref, not the lock) renders from its tree", () => {
    lock({ source: 'github:dustinkeeton/wafflestack', ref: null, commit: null, status: 'unreleased' });
    write('installer/cli.mjs', `import fs from 'node:fs';\nfs.appendFileSync(process.env.LOG, 'node ' + process.argv.slice(2).join(' ') + '\\n');\n`);
    fs.mkdirSync(path.join(cwd, 'node_modules'));
    const r = run({ trusted: 'github:dustinkeeton/wafflestack', repo: 'DustinKeeton/wafflestack' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.calls, ['node render --allow-unreleased']);
  });
});

describe('CI renders overlay-free (#615)', () => {
  let toolkitRoot;
  let cwd;
  afterEach(() => {
    fs.rmSync(toolkitRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('a required key the committed config lacks fails the render, naming the key', () => {
    toolkitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
    const put = (root, rel, s) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), s);
    };
    put(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: f\nstacks: [demo]\n');
    put(toolkitRoot, 'stacks/demo/stack.yaml', 'name: demo\ndescription: D.\nagents: [helper]\nskills: []\nconfig:\n  git.botEmail:\n    required: true\n    description: e\n');
    put(toolkitRoot, 'stacks/demo/agents/helper.md', '---\nname: helper\ndescription: H.\n---\n\n{{git.botEmail}}\n');
    put(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [demo]\n');
    const r = renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /git\.botEmail/.test(e)), JSON.stringify(r.errors));
  });
});
