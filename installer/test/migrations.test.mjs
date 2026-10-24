import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { MIGRATIONS, applicableMigrations, migrationCeiling, protectedPathsFromProse } from '../lib/migrations.mjs';
import { upgrade } from '../lib/upgrade.mjs';
import { renderProject } from '../lib/render.mjs';
import { eject } from '../lib/eject.mjs';
import { compareVersions, sha256 } from '../lib/util.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = '.waffle/waffle.yaml';
const OVERLAY = '.waffle/waffle.local.yaml';
const STEP_VERSION = '0.16.0';

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** base: skills git, gpm · alt / alt2: both define skill `dupe` (ambiguous unless stack-qualified). */
function makeToolkit(root) {
  write(root, 'toolkit.yaml', 'name: migfix\ndescription: migration fixture\nstacks: [base, alt, alt2]\n');
  write(root, 'stacks/base/stack.yaml', 'name: base\ndescription: Base skills.\nskills: [git, gpm]\n');
  for (const s of ['git', 'gpm']) {
    write(root, `stacks/base/skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: Skill ${s}.\n---\n\nBody of ${s}.\n`);
  }
  for (const b of ['alt', 'alt2']) {
    write(root, `stacks/${b}/stack.yaml`, `name: ${b}\ndescription: Stack ${b}.\nskills: [dupe]\n`);
    write(root, `stacks/${b}/skills/dupe/SKILL.md`, `---\nname: dupe\ndescription: Dupe from ${b}.\n---\n\nvariant ${b}\n`);
  }
}

/** sha256 of every rendered file outside `.waffle/` — the config and lock legitimately move. */
function renderedTree(cwd) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(cwd, abs);
      if (rel === '.waffle') continue;
      if (entry.isDirectory()) walk(abs);
      else out[rel] = sha256(fs.readFileSync(abs));
    }
  };
  walk(cwd);
  return out;
}

const identity = (status) => ({
  status,
  version: '0.15.0',
  commit: null,
  tag: null,
  ref: null,
  origin: 'checkout',
  repo: null,
  lockRepo: null,
  latestTag: null,
  lookupError: null,
});

describe(`${STEP_VERSION} migration: include:/eject: overlaps are dropped on upgrade (#501)`, () => {
  let root;
  let cwd;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-mig501-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mig501-'));
    makeToolkit(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const step = MIGRATIONS.find((m) => m.version === STEP_VERSION);
  const run = () => {
    const logs = [];
    step.run(cwd, { log: (m) => logs.push(m) });
    return logs;
  };
  const config = () => YAML.parse(read(cwd, CONFIG));

  test('the step is registered, and sits in the (0.15.0, 0.16.0] window only', () => {
    assert.ok(step, `a ${STEP_VERSION} migration step is registered`);
    assert.deepEqual(applicableMigrations('0.15.0', STEP_VERSION).map((s) => s.version), [STEP_VERSION]);
    assert.deepEqual(applicableMigrations(STEP_VERSION, STEP_VERSION).map((s) => s.version), []);
    assert.ok(applicableMigrations('0.15.0', '1.0.0').some((s) => s.version === STEP_VERSION), 'a major bump still covers it');
    assert.deepEqual(applicableMigrations('0.15.0', '0.15.1').map((s) => s.version), [], 'a patch bump would skip it — see the guard');
  });

  test('drops the qualified, unqualified and alias include forms; keeps eject:, the rest, and the comments; idempotent', () => {
    write(cwd, CONFIG, [
      '# header',
      'targets: [claude]',
      'stacks: []',
      'include:',
      '  - skills/git',
      '  # keep me',
      '  - skills/gpm # survivor',
      '  - alt2/skills/dupe',
      '  - skill:git',
      'eject:',
      '  - skills/git',
      '  - skills/dupe # project-owned',
      'config: {}',
      '',
    ].join('\n'));
    const logs = run();
    assert.deepEqual(config().include, ['skills/gpm']);
    assert.deepEqual(config().eject, ['skills/git', 'skills/dupe']);
    const text = read(cwd, CONFIG);
    for (const kept of ['# header', '# keep me', '# survivor', '# project-owned']) assert.match(text, new RegExp(kept));
    for (const ref of ['skills/git', 'alt2/skills/dupe', 'skill:git']) {
      assert.ok(logs.some((l) => l.includes(`dropped \`include:\` entry ${ref} `)), `${ref}: ${logs.join('\n')}`);
    }
    assert.equal(logs.length, 3, logs.join('\n'));

    assert.deepEqual(run(), [], 'a second run has nothing to say');
    assert.equal(read(cwd, CONFIG), text, 'and writes nothing');
    assert.equal(renderProject({ toolkitRoot: root, cwd, toolkitVersion: STEP_VERSION }).ok, true);
  });

  test('an emptied include: key is dropped — flow sequences too', () => {
    write(cwd, CONFIG, 'targets: [claude]\nstacks: [base]\ninclude: [skills/git]\neject: [skills/git]\nconfig: {}\n');
    run();
    assert.equal('include' in config(), false);
    assert.deepEqual(config().eject, ['skills/git']);
    assert.deepEqual(config().stacks, ['base']);
  });

  test('a config with no overlap is not rewritten — not one byte, not even a reflow', () => {
    // A stack-qualified eject: entry is never honored by the selection, so it is not an overlap.
    const text = 'targets:   [claude]\nstacks: []\ninclude:   [alt/skills/dupe,   skills/git]\neject: [alt/skills/dupe]\nconfig: {}\n';
    write(cwd, CONFIG, text);
    assert.deepEqual(run(), []);
    assert.equal(read(cwd, CONFIG), text);
  });

  test('a missing or unparseable config is left for render to report', () => {
    assert.deepEqual(run(), []);
    write(cwd, CONFIG, 'include: [skills/git\neject: [skills/git]\n');
    assert.deepEqual(run(), []);
    assert.equal(read(cwd, CONFIG), 'include: [skills/git\neject: [skills/git]\n');
  });

  describe('the local overlay is never edited', () => {
    test('an overlap that lives in the overlay is reported, not migrated', () => {
      const committed = 'targets: [claude]\nstacks: []\ninclude: [skills/git]\nconfig: {}\n';
      const overlay = 'eject: [skills/git] # mine\n';
      write(cwd, CONFIG, committed);
      write(cwd, OVERLAY, overlay);
      const logs = run();
      assert.equal(read(cwd, CONFIG), committed);
      assert.equal(read(cwd, OVERLAY), overlay);
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /NOT migrated — this overlap involves \.waffle\/waffle\.local\.yaml/);
      assert.match(logs[0], /`include:` names skills\/git and `eject:` names skills\/git/);
    });

    test('a committed overlap is still migrated under an overlay that shadows include:', () => {
      write(cwd, CONFIG, 'targets: [claude]\nstacks: []\ninclude: [skills/git]\neject: [skills/git]\nconfig: {}\n');
      write(cwd, OVERLAY, 'include: [skills/gpm]\n');
      const logs = run();
      assert.equal('include' in config(), false);
      assert.equal(read(cwd, OVERLAY), 'include: [skills/gpm]\n');
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.equal(renderProject({ toolkitRoot: root, cwd, toolkitVersion: STEP_VERSION }).ok, true);
    });

    test('an overlay eject: that was keeping the item rendered on this machine is called out', () => {
      write(cwd, CONFIG, 'targets: [claude]\nstacks: []\ninclude: [skills/git]\neject: [skills/git]\nconfig: {}\n');
      write(cwd, OVERLAY, 'eject: []\n');
      const logs = run();
      assert.equal('include' in config(), false);
      assert.ok(logs.some((l) => /note: .*waffle\.local\.yaml replaces `eject:` without ejecting skills\/git/.test(l)), logs.join('\n'));
    });
  });

  describe('upgrade end-to-end', () => {
    const OVERLAPPING = [
      '# my project',
      'targets: [claude]',
      'stacks: [base]',
      'include:',
      '  - skills/git',
      '  - alt/skills/dupe # the alt variant',
      'eject:',
      '  - skills/git',
      'config: {}',
      '',
    ].join('\n');

    // A 0.15.0 toolkit let `eject:` win silently, so its render equals the overlap-free config's.
    const renderAsOldToolkit = () => {
      write(cwd, CONFIG, OVERLAPPING.replace('  - skills/git\n', ''));
      assert.equal(renderProject({ toolkitRoot: root, cwd, toolkitVersion: '0.15.0' }).ok, true);
      write(cwd, CONFIG, OVERLAPPING);
      return renderedTree(cwd);
    };

    test('0.15.0 → 0.16.0 with an overlap upgrades clean, and the render is byte-identical', () => {
      const before = renderAsOldToolkit();
      assert.ok('.claude/skills/gpm/SKILL.md' in before && !('.claude/skills/git/SKILL.md' in before));

      const logs = [];
      const result = upgrade({ toolkitRoot: root, cwd, toolkitVersion: STEP_VERSION, log: (m) => logs.push(m) });
      assert.equal(result.ok, true, JSON.stringify(result.render.errors ?? result.doctor));
      assert.deepEqual(result.migrationsRun.map((m) => m.version), [STEP_VERSION]);
      assert.deepEqual(renderedTree(cwd), before);
      assert.deepEqual(config().include, ['alt/skills/dupe']);
      assert.deepEqual(config().eject, ['skills/git']);
      assert.match(read(cwd, CONFIG), /# my project/);
      assert.match(read(cwd, CONFIG), /# the alt variant/);
      assert.ok(logs.some((l) => l.includes('dropped `include:` entry skills/git ')), logs.join('\n'));
      assert.equal(JSON.parse(read(cwd, '.waffle/waffle.lock.json')).toolkitVersion, STEP_VERSION);
    });

    test('without the step the same upgrade dies on the #497 render error — the migration runs BEFORE the render', () => {
      renderAsOldToolkit();
      const result = upgrade({ toolkitRoot: root, cwd, toolkitVersion: STEP_VERSION, migrations: [] });
      assert.equal(result.ok, false);
      assert.ok(result.render.errors.some((e) => /mutually exclusive/.test(e)), JSON.stringify(result.render.errors));
    });

    test('an UNRELEASED toolkit still at 0.15.0 runs the pending step; a release at 0.15.0 does not', () => {
      const before = renderAsOldToolkit();
      const released = upgrade({ toolkitRoot: root, cwd, toolkitVersion: '0.15.0', toolkitIdentity: identity('release') });
      assert.equal(released.status, 'current');
      assert.deepEqual(released.migrationsRun, []);
      assert.equal(released.ok, false);

      const logs = [];
      const result = upgrade({
        toolkitRoot: root, cwd, toolkitVersion: '0.15.0', toolkitIdentity: identity('unreleased'), log: (m) => logs.push(m),
        // Scoped to the step under test: later pending steps would otherwise run too.
        migrations: MIGRATIONS.filter((m) => compareVersions(m.version, STEP_VERSION) <= 0),
      });
      assert.equal(result.status, 'current');
      assert.deepEqual(result.migrationsRun.map((m) => m.version), [STEP_VERSION]);
      assert.equal(result.ok, true, JSON.stringify(result.render.errors ?? result.doctor));
      assert.deepEqual(renderedTree(cwd), before);
      assert.ok(logs.some((l) => /this toolkit is unreleased — also running the migrations keyed past 0\.15\.0/.test(l)), logs.join('\n'));
    });

    test('an unreleased toolkit never migrates on a downgrade, a missing lock, or with nothing pending', () => {
      const ran = [];
      const migrations = [{ version: '9.0.0', description: 'pending', run: () => ran.push('9.0.0') }];
      assert.equal(migrationCeiling('0.15.0', migrations), '9.0.0');
      assert.equal(migrationCeiling('9.0.0', migrations), '9.0.0');
      assert.equal(migrationCeiling('0.15.0', []), '0.15.0');

      write(cwd, CONFIG, 'targets: [claude]\nstacks: [base]\nconfig: {}\n');
      const opts = { toolkitRoot: root, cwd, toolkitIdentity: identity('unreleased'), migrations };
      assert.equal(upgrade({ ...opts, toolkitVersion: '0.15.0' }).status, 'no-lock');
      assert.equal(upgrade({ ...opts, toolkitVersion: '0.14.0' }).status, 'downgrade');
      assert.deepEqual(ran, []);
    });
  });

  test('eject() drops its include entry through the same in-place edit, so sibling comments survive', () => {
    write(cwd, CONFIG, 'targets: [claude]\nstacks: []\ninclude:\n  - skills/git\n  # why gpm\n  - skills/gpm # pinned\nconfig: {}\n');
    eject({ cwd, item: 'skills/git' });
    assert.deepEqual(config().include, ['skills/gpm']);
    assert.deepEqual(config().eject, ['skills/git']);
    assert.match(read(cwd, CONFIG), /# why gpm/);
    assert.match(read(cwd, CONFIG), /# pinned/);
  });
});

describe('0.18.0 migration: docs.voiceGuardrailSection → docs.protectedDocs (#612)', () => {
  let cwd;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mig612-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const step = MIGRATIONS.find((m) => m.version === '0.18.0');
  const run = () => {
    const logs = [];
    step.run(cwd, { log: (m) => logs.push(m) });
    return logs;
  };
  const docs = () => YAML.parse(read(cwd, CONFIG)).config.docs;
  const withGuardrail = (value) =>
    `# mine\ntargets: [claude]\nstacks: [docs-system]\nconfig:\n  docs:\n    voiceGuardrailSection: ${value}\n    humanDocSet: H # keep\n`;

  test('the step is registered in the (0.17.x, 0.18.0] window', () => {
    assert.ok(step);
    assert.deepEqual(applicableMigrations('0.17.2', '0.18.0').map((s) => s.version), ['0.18.0']);
  });

  test('an empty guardrail becomes protectedDocs: []; idempotent; comments kept', () => {
    write(cwd, CONFIG, withGuardrail('""'));
    assert.equal(run().length, 1);
    assert.deepEqual(docs(), { humanDocSet: 'H', protectedDocs: [] });
    const text = read(cwd, CONFIG);
    assert.match(text, /# mine/);
    assert.match(text, /# keep/);
    assert.deepEqual(run(), []);
    assert.equal(read(cwd, CONFIG), text);
  });

  test('backticked paths in custom prose become the list, with a review note', () => {
    write(cwd, CONFIG, withGuardrail('"## Mine\\n\\n`README.md` and `schema/FORMAT.md` (`do not touch`), `LICENSE`, `.waffle/**`."'));
    const logs = run();
    assert.deepEqual(docs().protectedDocs, ['README.md', 'schema/FORMAT.md', 'LICENSE', '.waffle/**']);
    assert.equal('voiceGuardrailSection' in docs(), false);
    assert.ok(logs.some((l) => /review it: custom wording is not carried/.test(l)), logs.join('\n'));
  });

  test('prose that names no paths is left alone and reported', () => {
    write(cwd, CONFIG, withGuardrail('"Be careful with the handbook."'));
    const before = read(cwd, CONFIG);
    const logs = run();
    assert.equal(read(cwd, CONFIG), before);
    assert.match(logs.join('\n'), /NOT migrated — .*names no backticked paths/);
  });

  test('an already-set protectedDocs wins; the old key is just dropped', () => {
    write(cwd, CONFIG, 'config:\n  docs:\n    protectedDocs: [A.md]\n    voiceGuardrailSection: "`B.md`"\n');
    run();
    assert.deepEqual(docs(), { protectedDocs: ['A.md'] });
  });

  test('the local overlay is never edited, only reported', () => {
    write(cwd, CONFIG, 'targets: [claude]\nstacks: [docs-system]\nconfig: {}\n');
    const overlay = 'config:\n  docs:\n    voiceGuardrailSection: "`X.md`"\n';
    write(cwd, OVERLAY, overlay);
    const logs = run();
    assert.equal(read(cwd, OVERLAY), overlay);
    assert.match(logs.join('\n'), /NOT migrated — \.waffle\/waffle\.local\.yaml sets docs\.voiceGuardrailSection/);
  });

  describe('carve-outs, config keys, and odd paths (#648)', () => {
    const configWith = (lines) => `config:\n  docs:\n${lines.map((l) => `    ${l}\n`).join('')}`;
    const notCarried = (logs) => logs.find((l) => /not carried —/.test(l));

    test('a carve-out sentence and a docs.* key are not carried, and both are logged', () => {
      write(cwd, CONFIG, withGuardrail('"`README.md` is owner-authored. This list does not cover `AGENTS.md` or `docs.humanDocSet`, nor `DECISIONS.md`."'));
      const logs = run();
      assert.deepEqual(docs().protectedDocs, ['README.md', 'DECISIONS.md']);
      assert.equal('voiceGuardrailSection' in docs(), false);
      const line = notCarried(logs);
      assert.match(line, /`AGENTS\.md` \(agent-managed doc set\)/);
      assert.match(line, /`docs\.humanDocSet` \(config key\)/);
    });

    test('the default human doc set is carved out when humanDocSet is unset', () => {
      write(cwd, CONFIG, configWith(['voiceGuardrailSection: "`CLAUDE.md`; not `STATUS.md` or `ARCHITECTURE.md`"']));
      const logs = run();
      assert.deepEqual(docs().protectedDocs, ['CLAUDE.md']);
      assert.match(notCarried(logs), /`STATUS\.md` \(agent-managed doc set\), `ARCHITECTURE\.md` \(agent-managed doc set\)/);
    });

    test('an overridden machine doc set is carved out instead of the default', () => {
      write(cwd, CONFIG, configWith(['machineDocSet: "one `REGISTRY.md`"', 'voiceGuardrailSection: "`AGENTS.md` and `REGISTRY.md`"']));
      const logs = run();
      assert.deepEqual(docs().protectedDocs, ['AGENTS.md']);
      assert.match(notCarried(logs), /`REGISTRY\.md` \(agent-managed doc set\)/);
    });

    test('extensionless and @/+ paths are kept', () => {
      write(cwd, CONFIG, withGuardrail('"`Makefile`, `Dockerfile`, `notes/@team.md`, `LICENSE`, `bin/run`, `c++/x.md`"'));
      const logs = run();
      assert.deepEqual(docs().protectedDocs, ['Makefile', 'Dockerfile', 'notes/@team.md', 'LICENSE', 'bin/run', 'c++/x.md']);
      assert.equal(notCarried(logs), undefined, logs.join('\n'));
    });

    test('capitalized prose words are logged as not a path; all-caps and known filenames are kept (#655)', () => {
      write(cwd, CONFIG, withGuardrail('"`README.md`, `Important`: `Never` edit `TODO`, `Procfile`, `Justfile`"'));
      const logs = run();
      assert.deepEqual(docs().protectedDocs, ['README.md', 'TODO', 'Procfile', 'Justfile']);
      assert.match(notCarried(logs), /`Important` \(not a path\), `Never` \(not a path\)/);
    });

    test('commands and bare words are logged as not a path', () => {
      write(cwd, CONFIG, withGuardrail('"`README.md`, run `npm test`, set `true`"'));
      const logs = run();
      assert.deepEqual(docs().protectedDocs, ['README.md']);
      assert.match(notCarried(logs), /`npm test` \(not a path\).*`true` \(not a path\)/);
    });

    test('prose naming only skipped tokens is left alone, and the skips are still logged', () => {
      write(cwd, CONFIG, withGuardrail('"Mind `docs.humanDocSet` and `AGENTS.md`."'));
      const before = read(cwd, CONFIG);
      const logs = run();
      assert.equal(read(cwd, CONFIG), before);
      assert.match(logs.join('\n'), /NOT migrated — .*names no backticked paths/);
      assert.match(notCarried(logs), /`docs\.humanDocSet` \(config key\), `AGENTS\.md` \(agent-managed doc set\)/);
    });

    test('the 0.17 stock prose, carve-outs resolved, migrates to the exact default list', () => {
      const stock = [
        '## Owner-voiced docs — do not rewrite',
        '',
        'These files are owner-authored. Never rewrite them in a docs pass:',
        '',
        '- `README.md` — the project\'s front door',
        '- `CLAUDE.md` — the owner\'s instructions to the harness',
        '- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE` — governance',
        '- `CHANGELOG.md` — maintained by the release flow, not by doc writers',
        '- `.waffle/waffle.yaml`, `.waffle/waffle.local.yaml`, and `.waffle/extensions/**` —',
        '  consumer config and project-owned extensions',
        '',
        'This list does not cover the agent-managed docs — a root `AGENTS.md`, plus a per-feature',
        '`AGENTS.md` in each `src/<feature>/` directory; and `DECISIONS.md`, `STATUS.md`, and',
        '`ARCHITECTURE.md` at the repo root — which the doc writers update as usual.',
      ].join('\n');
      write(cwd, CONFIG, YAML.stringify({ config: { docs: { voiceGuardrailSection: stock } } }));
      run();
      assert.deepEqual(docs().protectedDocs, [
        'README.md',
        'CLAUDE.md',
        'CONTRIBUTING.md',
        'CODE_OF_CONDUCT.md',
        'SECURITY.md',
        'LICENSE',
        'CHANGELOG.md',
        '.waffle/waffle.yaml',
        '.waffle/waffle.local.yaml',
        '.waffle/extensions/**',
      ]);
    });

    test('protectedPathsFromProse keeps docs.* files and drops camelCase keys', () => {
      assert.deepEqual(protectedPathsFromProse('`docs.md` `docs/x.md` `docs.json` `docs.machineDocSet`'), {
        paths: ['docs.md', 'docs/x.md', 'docs.json'],
        skipped: [{ token: 'docs.machineDocSet', why: 'config key' }],
      });
    });

    test('protectedPathsFromProse drops capitalized words and single letters, keeps all-caps and _names (#655)', () => {
      assert.deepEqual(protectedPathsFromProse('`Never` `TODO` `Important` `A` `CODE_OF_CONDUCT` `_redirects` `Taskfile`'), {
        paths: ['TODO', 'CODE_OF_CONDUCT', '_redirects'],
        skipped: [
          { token: 'Never', why: 'not a path' },
          { token: 'Important', why: 'not a path' },
          { token: 'A', why: 'not a path' },
          { token: 'Taskfile', why: 'not a path' },
        ],
      });
    });

    test('protectedPathsFromProse keeps every frozen 0.18.0 extensionless filename (#660)', () => {
      // A literal list, never derived from the set: dropping an entry must fail here.
      const frozen = ['Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Procfile', 'Gemfile',
        'Rakefile', 'Justfile', 'Vagrantfile', 'Brewfile', 'Podfile', 'Jenkinsfile', 'Caddyfile',
        'Guardfile', 'Berksfile', 'Capfile', 'Snakefile'];
      for (const name of frozen) {
        assert.deepEqual(protectedPathsFromProse(`\`${name}\``), { paths: [name], skipped: [] }, name);
      }
    });

    test('protectedPathsFromProse dedupes in order and honors exclude', () => {
      assert.deepEqual(protectedPathsFromProse('`A.md` `B.md` `A.md` `x y` `x y`', { exclude: ['B.md'] }), {
        paths: ['A.md'],
        skipped: [
          { token: 'B.md', why: 'agent-managed doc set' },
          { token: 'x y', why: 'not a path' },
        ],
      });
    });
  });

  test('upgrade end-to-end: the retired key migrates and the render is clean', () => {
    const base = 'targets: [claude]\nstacks: [docs-system]\nconfig:\n  project:\n    name: Fx\n    longName: the Fx project\n';
    write(cwd, CONFIG, base);
    assert.equal(renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.17.2' }).ok, true);
    write(cwd, CONFIG, `${base}  docs:\n    voiceGuardrailSection: "\`HANDBOOK.md\` only"\n`);
    assert.equal(renderProject({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.17.2' }).ok, false, 'the old key fails the render');

    const result = upgrade({ toolkitRoot: REPO_ROOT, cwd, toolkitVersion: '0.18.0' });
    assert.equal(result.ok, true, JSON.stringify(result.render?.errors ?? result.doctor));
    assert.deepEqual(result.migrationsRun.map((m) => m.version), ['0.18.0']);
    assert.deepEqual(docs(), { protectedDocs: ['HANDBOOK.md'] });
    assert.match(read(cwd, '.claude/agents/docs-human.md'), /^- `HANDBOOK\.md`$/m);
  });
});

/**
 * The release guard (#501). A step keyed past the package version is PENDING, and must be announced
 * under `[Unreleased]` as "migration `X.Y.Z`" — so a bump that stamps the CHANGELOG to a version
 * BELOW the key (which would ship the change without its migration) fails here, at bump time.
 */
function pendingMigrationProblems({ packageVersion, changelog, migrations }) {
  const pending = [...new Set(migrations.map((m) => m.version).filter((v) => compareVersions(v, packageVersion) > 0))];
  const problems = [];
  if (pending.length > 1) problems.push(`more than one pending migration version (${pending.join(', ')}) — the next release is a single version`);
  const section = String(changelog).split(/^(?=## )/m).find((part) => /^##\s+\[Unreleased\]/.test(part)) ?? '';
  const unreleased = section.replace(/\s+/g, ' ');
  for (const version of pending) {
    if (unreleased.includes(`migration \`${version}\``)) continue;
    problems.push(
      `migration ${version} is keyed past package.json ${packageVersion}, and CHANGELOG [Unreleased] does not announce ` +
        `"migration \`${version}\`" — the release that ships its change must be ${version} or later ` +
        '(bump to it, or re-key the step and its CHANGELOG line together)',
    );
  }
  return problems;
}

describe('release guard: a bump cannot silently skip a pending migration (#501)', () => {
  const packageVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');

  test('the real registry, package.json and CHANGELOG agree', () => {
    assert.deepEqual(pendingMigrationProblems({ packageVersion, changelog, migrations: MIGRATIONS }), []);
  });

  const migrations = [{ version: '0.10.0' }, { version: '0.16.0' }];
  const announced = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- thing. Consumer impact: migrated (migration\n  `0.16.0`).\n\n## [0.15.0] - 2026-01-01\n';
  const stamped = (v) => announced.replace('## [Unreleased]', `## [Unreleased]\n\n## [${v}] - 2026-02-02`);

  test('pending + announced passes; the line may wrap', () => {
    assert.deepEqual(pendingMigrationProblems({ packageVersion: '0.15.0', changelog: announced, migrations }), []);
  });

  test('a PATCH bump that stamps the CHANGELOG fails — it would ship the change without its migration', () => {
    const problems = pendingMigrationProblems({ packageVersion: '0.15.1', changelog: stamped('0.15.1'), migrations });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /migration 0\.16\.0 is keyed past package\.json 0\.15\.1/);
  });

  test('the keyed bump, and any later one, passes', () => {
    for (const v of ['0.16.0', '0.17.0', '1.0.0']) {
      assert.deepEqual(pendingMigrationProblems({ packageVersion: v, changelog: stamped(v), migrations }), [], v);
    }
  });

  test('a pending step nobody announced, and two pending versions, both fail', () => {
    const silent = '# Changelog\n\n## [Unreleased]\n\n## [0.15.0] - 2026-01-01\n- migration `0.16.0`\n';
    assert.equal(pendingMigrationProblems({ packageVersion: '0.15.0', changelog: silent, migrations }).length, 1);
    const two = [...migrations, { version: '0.17.0' }];
    const problems = pendingMigrationProblems({ packageVersion: '0.15.0', changelog: announced, migrations: two });
    assert.ok(problems.some((p) => /more than one pending migration version/.test(p)), problems.join('\n'));
  });
});
