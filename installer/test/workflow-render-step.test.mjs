import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { renderProject } from '../lib/render.mjs';
import { checksDigest } from '../lib/prerequisites.mjs';
import { loadToolkitWithSources } from '../lib/toolkit.mjs';

// #615: every shipped CI job that reads rendered resources renders the missing ones first.

const WF_DIR = fileURLToPath(new URL('../../stacks/github-workflow/files/.github/workflows/', import.meta.url));
const WORKFLOWS = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml')).sort();
const EXEMPT = { 'waffle-doctor.yml': 'doctor is the render checker; rendering first would hide its gaps' };
const RENDERED_PATH = /(?:^|[\s'"(`])(\.(?:claude|codex|agents|waffle)\/[\w./*-]*)/g;
const NOT_RENDERED = /^\.waffle\/(?:waffle\.yaml|waffle\.lock\.json|waffle\.local\.|telemetry\/)/;
const PROBED = /^\.claude\//;
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

  test('github-workflow is the only stack that ships workflows, so the audit sees them all', () => {
    const stacksDir = fileURLToPath(new URL('../../stacks/', import.meta.url));
    const shipping = fs.readdirSync(stacksDir).filter((s) => fs.existsSync(path.join(stacksDir, s, 'files/.github/workflows')));
    assert.deepEqual(shipping, ['github-workflow'], 'audit the new stack\'s workflows here too');
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

  test("a gated reader whose waffle-render step lacks its if: is reported", () => {
    const wf = parseWorkflow(
      'jobs:\n  x:\n    steps:\n      - uses: actions/checkout@abc\n      - id: waffle-render\n        run: "true"\n' +
        '      - if: x\n        run: cat .claude/skills/x/SKILL.md\n',
    );
    assert.ok(auditWorkflow('synthetic.yml', wf).violations.some((v) => /waffle-render's if: differs/.test(v)));
  });
});

const REAL_GIT = execFileSync('/usr/bin/env', ['which', 'git'], { encoding: 'utf8' }).trim();
const REAL_NPM = execFileSync('/usr/bin/env', ['which', 'npm'], { encoding: 'utf8' }).trim();
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
  const run = ({ trusted = 'github:dustinkeeton/wafflestack#v1.2.3', repo = 'consumer/app', lsRemote = `${SHA}\trefs/tags/v1.2.3\n`, env = {} } = {}) => {
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    const r = spawnSync('bash', ['-c', CANONICAL.run], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRUSTED_TOOLKIT: trusted, GITHUB_REPOSITORY: repo, LOG: log, LS_REMOTE: lsRemote, GITHUB_STEP_SUMMARY: path.join(bin, 'summary'), ...env },
    });
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    const npx = lines.filter((l) => l.startsWith('npx-env ')).map((l) => JSON.parse(l.slice(8)));
    return { ...r, calls: lines.filter((l) => !l.startsWith('npx-env ')), npx };
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-render-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-render-bin-'));
    log = path.join(bin, 'calls.log');
    git('init', '-q');
    write('.claude/agents/a.md', 'committed\n');
    cwd = fs.realpathSync(cwd);
    const fakeRender = 'mkdir -p .claude/skills/x && echo r > .claude/skills/x/SKILL.md && echo {} > .claude/settings.json && echo edited > .claude/agents/a.md';
    // Records what npm itself would see from npx's cwd, then renders into --cwd like the real CLI.
    exe(path.join(bin, 'npx'), [
      'echo "npx $*" >> "$LOG"',
      `node -e 'console.log("npx-env " + JSON.stringify({ pwd: process.cwd(), entries: require("fs").readdirSync("."), registry: process.argv[1], git: process.env.npm_config_git ?? null, upper: process.env.NPM_CONFIG_SCRIPT_SHELL ?? null }))' "$(${REAL_NPM} config get registry)" >> "$LOG"`,
      '[ -z "${NPX_STDERR:-}" ] || { echo "$NPX_STDERR" >&2; exit 1; }',
      'while [ $# -gt 0 ]; do [ "$1" = --cwd ] && d="$2"; shift; done',
      `cd "$d" && ${fakeRender}`,
    ].join('\n'));
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

  test('Posture 2: .claude/ committed, another harness gitignored, unreleased lock → no fetch, exit 0', () => {
    lock({ source: 'github:consumer/app', ref: null, commit: null, status: 'unreleased' });
    const l = JSON.parse(fs.readFileSync(path.join(cwd, '.waffle/waffle.lock.json'), 'utf8'));
    l.files['.codex/config.toml'] = 'h';
    l.files['.agents/skills/x/SKILL.md'] = 'h';
    write('.waffle/waffle.lock.json', JSON.stringify(l));
    write('.claude/skills/x/SKILL.md', 'x\n');
    write('.claude/settings.json', '{}\n');
    const r = run({ trusted: 'github:dustinkeeton/wafflestack#main' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.calls, []);
  });

  test('release pin: verifies the tag on the trusted repo, renders at its commit, fills gaps only', () => {
    lock(release());
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.calls[0], /^git ls-remote --tags -- https:\/\/github\.com\/dustinkeeton\/wafflestack$/);
    assert.equal(r.calls[1], `npx --yes github:dustinkeeton/wafflestack#${SHA} render --untrusted-config --cwd ${cwd}`);
    assert.equal(fs.readFileSync(path.join(cwd, '.claude/agents/a.md'), 'utf8'), 'committed\n');
    assert.equal(git('status', '--porcelain'), '');
    assert.ok(fs.existsSync(path.join(cwd, '.claude/skills/x/SKILL.md')));
  });

  test('a release older than --untrusted-config fails with an upgrade hint, not a bare "takes no refs" (#789)', () => {
    lock(release());
    const r = run({ env: { NPX_STDERR: 'render takes no refs — use `wafflestack install <ref…>`' } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /::error title=waffle-render::toolkit github:dustinkeeton\/wafflestack#a+ predates render --untrusted-config/);
  });

  test('any other render failure still fails the step, with its own stderr and no upgrade hint', () => {
    lock(release());
    const r = run({ env: { NPX_STDERR: 'some other render failure' } });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /predates/);
    assert.match(r.stderr, /some other render failure/);
  });

  test('no lock commit → the tag commit; an annotated tag → its peeled commit', () => {
    lock(release({ commit: null }));
    const r = run({ lsRemote: `${SHA}\trefs/tags/v1.2.3\n${PEELED}\trefs/tags/v1.2.3^{}\n${'c'.repeat(40)}\trefs/tags/v1.2.30\n` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.calls[1], `npx --yes github:dustinkeeton/wafflestack#${PEELED} render --untrusted-config --cwd ${cwd}`);
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

  test('a PR-committed .npmrc and npm_config_* env never reach npx: it runs from an empty dir outside the checkout', () => {
    lock(release());
    write('.npmrc', 'registry=http://evil.invalid/\ngit=./pwn.sh\nscript-shell=./pwn.sh\n');
    write('package.json', '{"name":"pr-head"}\n');
    const r = run({ env: { npm_config_git: './pwn.sh', NPM_CONFIG_SCRIPT_SHELL: './pwn.sh' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.npx.length, 1);
    const [seen] = r.npx;
    assert.notEqual(seen.pwd, cwd);
    assert.ok(!seen.pwd.startsWith(cwd + path.sep), seen.pwd);
    assert.deepEqual(seen.entries, ['.npmrc']);
    assert.equal(fs.readFileSync(path.join(seen.pwd, '.npmrc'), 'utf8'), '');
    assert.doesNotMatch(seen.registry, /evil\.invalid/);
    assert.equal(seen.git, null);
    assert.equal(seen.upper, null);
    assert.ok(fs.existsSync(path.join(cwd, '.claude/skills/x/SKILL.md')));
  });

  const selfHost = (extra = {}) => {
    lock({ source: 'github:dustinkeeton/wafflestack', ref: null, commit: null, status: 'unreleased' });
    write('installer/cli.mjs', `import fs from 'node:fs';\nfs.appendFileSync(process.env.LOG, 'node ' + process.argv.slice(2).join(' ') + '\\n');\n`);
    exe(path.join(bin, 'npm'), 'echo "npm $*" >> "$LOG"');
    return run({ repo: 'DustinKeeton/wafflestack', ...extra });
  };

  test("the toolkit's own repo renders with the trusted default branch's installer, never the PR head's", () => {
    const r = selfHost({ trusted: 'github:dustinkeeton/wafflestack', lsRemote: `${SHA}\tHEAD\n${PEELED}\trefs/heads/HEAD-x\n` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.calls, [
      'git ls-remote -- https://github.com/dustinkeeton/wafflestack',
      `npx --yes github:dustinkeeton/wafflestack#${SHA} render --allow-unreleased --untrusted-config --cwd ${cwd}`,
    ]);
    assert.equal(git('status', '--porcelain'), '');
  });

  const E = 'e'.repeat(40);
  for (const [label, ref, lsRemote, sha] of [
    ['an annotated tag → its peeled commit', 'v1.2.3', `${SHA}\trefs/tags/v1.2.3\n${PEELED}\trefs/tags/v1.2.3^{}\n${E}\trefs/heads/v1.2.3x\n`, PEELED],
    ['a branch → its tip', 'main', `${SHA}\tHEAD\n${E}\trefs/heads/main\n${PEELED}\trefs/heads/x/main\n`, E],
  ]) {
    test(`the toolkit's own repo honors a trusted #ref: ${label}`, () => {
      const r = selfHost({ trusted: `github:dustinkeeton/wafflestack#${ref}`, lsRemote });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.equal(r.calls[1], `npx --yes github:dustinkeeton/wafflestack#${sha} render --allow-unreleased --untrusted-config --cwd ${cwd}`);
    });
  }

  test("the toolkit's own repo fails when its trusted ref does not resolve, running nothing", () => {
    const r = selfHost({ trusted: 'github:dustinkeeton/wafflestack#nope', lsRemote: `${SHA}\tHEAD\n` });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /trusted ref nope was not found/);
    assert.deepEqual(r.calls, ['git ls-remote -- https://github.com/dustinkeeton/wafflestack']);
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

describe('render --untrusted-config: a PR-head config runs no prerequisite check (#615)', () => {
  const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  let dirs;
  const tmp = (p) => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
    dirs.push(d);
    return d;
  };
  const put = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const ran = (root, name) => fs.existsSync(path.join(root, `${name}.ran`));
  // The PR's own stack, acknowledged by a digest the PR wrote for itself.
  const evilProject = (cwd, base = []) => {
    put(cwd, 'evil/stacks/evil/stack.yaml', [
      'name: evil',
      'description: Evil.',
      'skills: [x]',
      'prerequisites:',
      `  - { kind: tool, name: pwn, description: Pwn., check: 'touch "${cwd}/evil.ran"' }`,
      '',
    ].join('\n'));
    put(cwd, 'evil/stacks/evil/skills/x/SKILL.md', '---\nname: x\ndescription: X.\n---\n\nX.\n');
    const ext = { name: 'evil', source: './evil', sourceType: 'path', ref: null };
    const digest = checksDigest(loadToolkitWithSources({ builtinRoot: fs.realpathSync(path.join(CLI, '../..')), externalStacks: [ext], cwd, cacheDir: tmp('cache-') }).stacks.get('evil'));
    put(cwd, '.waffle/waffle.yaml', ['targets: [claude]', 'stacks:', ...base.map((b) => `  - ${b}`), '  - name: evil', '    source: ./evil', `    acknowledgedChecks: ${digest}`, ''].join('\n'));
  };

  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  test('the CLI, run from an empty dir like the step, refuses an acknowledged local-path stack and never runs its check', () => {
    const cwd = tmp('pr-head-');
    evilProject(cwd);
    const cli = (...flags) =>
      spawnSync(process.execPath, [CLI, 'render', '--allow-unreleased', ...flags, '--cwd', cwd], { cwd: tmp('npx-'), encoding: 'utf8', env: { ...process.env, WAFFLESTACK_OFFLINE: '1' } });

    const r = cli('--untrusted-config');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--untrusted-config: .*external stack\(s\) evil/);
    assert.equal(ran(cwd, 'evil'), false, 'the PR-authored check ran');
    assert.equal(fs.existsSync(path.join(cwd, '.claude')), false);

    const control = cli();
    assert.equal(control.status, 0, control.stdout + control.stderr);
    assert.equal(ran(cwd, 'evil'), true, 'control: without the flag the acknowledged check does run');
  });

  test('a committed overlay cannot slip a source: stack past the flag', () => {
    const cwd = tmp('pr-head-');
    evilProject(cwd);
    const yaml = fs.readFileSync(path.join(cwd, '.waffle/waffle.yaml'), 'utf8');
    put(cwd, '.waffle/waffle.local.yaml', yaml);
    put(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: []\n');
    const r = renderProject({ toolkitRoot: fs.realpathSync(path.join(CLI, '../..')), cwd, toolkitVersion: '0.0.test', sourceCacheDir: tmp('cache-'), untrustedConfig: true });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /external stack\(s\) evil/.test(e)), JSON.stringify(r.errors));
    assert.equal(ran(cwd, 'evil'), false);
  });

  test("built-in stacks still render, with no prerequisite probe run", () => {
    const toolkitRoot = tmp('toolkit-');
    const cwd = tmp('pr-head-');
    put(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: f\nstacks: [core]\n');
    put(toolkitRoot, 'stacks/core/stack.yaml', [
      'name: core',
      'description: Core.',
      'skills: [base]',
      'prerequisites:',
      `  - { kind: tool, name: probe, description: Probe., check: 'touch "${cwd}/core.ran"' }`,
      '',
    ].join('\n'));
    put(toolkitRoot, 'stacks/core/skills/base/SKILL.md', '---\nname: base\ndescription: Base.\n---\n\nBase.\n');
    put(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\n');
    const go = (untrustedConfig) => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test', untrustedConfig });
    const r = go(true);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(fs.existsSync(path.join(cwd, '.claude/skills/base/SKILL.md')));
    assert.equal(ran(cwd, 'core'), false, 'a probe ran under --untrusted-config');
    assert.equal(go(false).ok, true);
    assert.equal(ran(cwd, 'core'), true, 'control: a normal render probes');
  });
});

describe('render never writes through a PR-committed symlink out of the tree (#789)', () => {
  let dirs;
  const tmp = (p) => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
    dirs.push(d);
    return d;
  };
  const put = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  let toolkitRoot;
  let cwd;
  let outside;
  const go = () => renderProject({ toolkitRoot, cwd, toolkitVersion: '0.0.test', untrustedConfig: true });

  beforeEach(() => {
    dirs = [];
    toolkitRoot = tmp('toolkit-');
    cwd = tmp('pr-head-');
    outside = tmp('outside-');
    put(toolkitRoot, 'toolkit.yaml', 'name: fixture\ndescription: f\nstacks: [core]\n');
    put(toolkitRoot, 'stacks/core/stack.yaml', 'name: core\ndescription: Core.\nskills: [base]\n');
    put(toolkitRoot, 'stacks/core/skills/base/SKILL.md', '---\nname: base\ndescription: Base.\n---\n\nBase.\n');
    put(cwd, '.waffle/waffle.yaml', 'targets: [claude]\nstacks: [core]\n');
  });
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  test('a symlinked parent directory is refused before any write', () => {
    fs.mkdirSync(path.join(cwd, '.claude'));
    fs.symlinkSync(outside, path.join(cwd, '.claude/skills'));
    const r = go();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /refusing to write \.claude\/skills\/base\/SKILL\.md: .*symlink/.test(e)), JSON.stringify(r.errors));
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(path.join(cwd, '.waffle/waffle.lock.json')), false, 'the lock was written');
  });

  test('a settings file the PR-head lock names is not merged through a symlinked leaf', () => {
    const victim = path.join(outside, 'victim.json');
    fs.writeFileSync(victim, '{"x":true}\n');
    fs.symlinkSync(victim, path.join(cwd, 'evil.json'));
    put(cwd, '.waffle/waffle.lock.json', JSON.stringify({ files: {}, settings: { 'evil.json#/x': true } }));
    const r = go();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /refusing to write evil\.json/.test(e)), JSON.stringify(r.errors));
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"x":true}\n');
  });

  test('no legacy-dotfile migration renames through a symlinked .waffle out of the tree', () => {
    fs.rmSync(path.join(cwd, '.waffle'), { recursive: true });
    put(cwd, '.waffle.yaml', 'targets: [claude]\nstacks: [core]\n');
    fs.symlinkSync(outside, path.join(cwd, '.waffle'));
    go();
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(fs.existsSync(path.join(cwd, '.waffle.yaml')));
  });

  test('a symlinked leaf (the lock, or an output) pointing outside is refused; one pointing inside is not', () => {
    const victim = path.join(outside, 'victim');
    fs.writeFileSync(victim, '{}\n');
    fs.symlinkSync(victim, path.join(cwd, '.waffle/waffle.lock.json'));
    let r = go();
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /refusing to write \.waffle\/waffle\.lock\.json/.test(e)), JSON.stringify(r.errors));
    assert.equal(fs.readFileSync(victim, 'utf8'), '{}\n');

    fs.rmSync(path.join(cwd, '.waffle/waffle.lock.json'));
    fs.mkdirSync(path.join(cwd, '.claude/skills/base'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'gone'), path.join(cwd, '.claude/skills/base/SKILL.md'));
    r = go();
    assert.equal(r.ok, false, 'a dangling link cannot be verified');
    assert.equal(fs.existsSync(path.join(outside, 'gone')), false);

    fs.rmSync(path.join(cwd, '.claude/skills/base/SKILL.md'));
    put(cwd, 'in-tree.md', 'x\n');
    fs.symlinkSync(path.join(cwd, 'in-tree.md'), path.join(cwd, '.claude/skills/base/SKILL.md'));
    r = go();
    assert.ok(!(r.errors ?? []).some((e) => /through a symlink/.test(e)), JSON.stringify(r.errors));
  });
});

// #777: this repo gitignores its .claude/ render, so its project-owned workflows must read none of it.
describe("this repo's project-owned workflows read no rendered resource (#777)", () => {
  const ROOT = fileURLToPath(new URL('../../', import.meta.url));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, '.waffle/waffle.lock.json'), 'utf8'));
  const own = fs.readdirSync(path.join(ROOT, '.github/workflows'))
    .filter((f) => f.endsWith('.yml') && !(`.github/workflows/${f}` in lock.files));

  test('the sweep sees tests.yml', () => assert.ok(own.includes('tests.yml'), own.join(', ')));
  for (const name of own) {
    test(`${name}: no reader step`, () => {
      const wf = parseWorkflow(fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8'));
      assert.deepEqual(auditWorkflow(name, wf).readers, []);
    });
  }
});
