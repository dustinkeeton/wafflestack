import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The delegate identity preflight (identity.mjs) lives beside its SKILL.md in the
// orchestration stack and is copied verbatim into a consumer's .claude/skills/delegate/.
// These tests exercise the source script directly. The property under test is the one the
// issue names: a misconfigured identity must be REPORTED, never silently swallowed — and
// the no-opt-in path (a bare `git.cmd`, every tier on the ambient human identity) must
// stay a pass, because it is a documented state rather than a misconfiguration.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../stacks/orchestration/skills/delegate/identity.mjs');

const RECIPE_A = 'git -c commit.gpgsign=false -c user.name="Wafflebot" -c user.email=bot@wafflenet.io';
const RECIPE_B =
  'git -c commit.gpgsign=true -c gpg.format=ssh -c user.signingkey=~/.ssh/id_ed25519.pub -c tag.gpgsign=true -c user.name="Wafflebot" -c user.email=bot@wafflenet.io';

let agentsDir;

beforeEach(() => {
  agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-agents-'));
  fs.writeFileSync(
    path.join(agentsDir, 'lead-engineer.md'),
    '---\nname: lead-engineer\nidentity:\n  displayName: Lead Engineer\n---\nbody\n',
  );
  fs.writeFileSync(path.join(agentsDir, 'security-auditor.md'), '---\nname: security-auditor\n---\nno displayName here\n');
});
afterEach(() => {
  fs.rmSync(agentsDir, { recursive: true, force: true });
});

/** Run the preflight. `identities` is the raw stdin payload (as the heredoc delivers it). */
function run({ gitCmd, agents = 'lead-engineer', identities = '{}', dir = true, args }) {
  const argv = args ?? [
    '--git-cmd', gitCmd,
    ...(dir ? ['--agents-dir', agentsDir] : []),
    '--agents', agents,
  ];
  const r = spawnSync(process.execPath, [SCRIPT, ...argv], { input: identities, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

describe('identity preflight: the passing tiers', () => {
  test('recipe A + no overrides passes and states all three tiers', () => {
    const r = run({ gitCmd: RECIPE_A });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /identity: main-bot = Wafflebot <bot@wafflenet\.io> \(unsigned\)/);
    assert.match(r.out, /sub-agents = derived \(\+<slug> subaddressing\)/);
    assert.match(r.out, /human = untouched/);
    assert.match(r.out, /preflight PASSED/);
    assert.doesNotMatch(r.all, /^ERROR:/m);
  });

  test('a bare git.cmd is a NOTE and a pass — the no-opt-in path is not a misconfiguration', () => {
    const r = run({ gitCmd: 'git' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /NOTE: no bot identity configured/);
    assert.match(r.out, /main-bot = ambient \(human\)/);
    assert.match(r.out, /sub-agents = ambient \(no virtualization\)/);
    assert.doesNotMatch(r.all, /^(ERROR|WARN):/m, 'the documented no-clobber path must not nag');
  });

  test('a signing recipe reports the pinned format in the verdict', () => {
    const r = run({ gitCmd: RECIPE_B });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /main-bot = Wafflebot <bot@wafflenet\.io> \(signed, gpg\.format=ssh\)/);
  });

  test('--help prints usage and exits 0 without requiring the other args', () => {
    const r = run({ args: ['--help'] });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /Usage: node identity\.mjs/);
    assert.doesNotMatch(r.all, /required/);
  });
});

describe('identity preflight: ERROR class — the run stops', () => {
  const cases = {
    'half an identity (name, no email)': { gitCmd: 'git -c user.name="Wafflebot"', match: /half an identity/ },
    'half an identity (email, no name)': { gitCmd: 'git -c user.email=bot@x.io', match: /half an identity/ },
    'an unquoted spaced user.name word-splits': {
      gitCmd: 'git -c user.name=Waffle Bot -c user.email=bot@x.io',
      match: /stray word "Bot"/,
    },
    'an unterminated quote': { gitCmd: 'git -c user.name="Waffle -c user.email=bot@x.io', match: /unterminated double quote/ },
    'a leftover template placeholder': {
      gitCmd: 'git -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}',
      match: /unresolved template placeholder/,
    },
    'an empty user.signingkey': {
      gitCmd: 'git -c user.name="B" -c user.email=b@x.io -c user.signingkey=',
      match: /EMPTY user\.signingkey/,
    },
    'commit.gpgsign=true without a key': {
      gitCmd: 'git -c commit.gpgsign=true -c gpg.format=ssh -c user.name="B" -c user.email=b@x.io',
      match: /commit\.gpgsign=true without user\.signingkey/,
    },
    'commit.gpgsign=true without a pinned gpg.format': {
      gitCmd: 'git -c commit.gpgsign=true -c user.signingkey=ABCDEF12 -c user.name="B" -c user.email=b@x.io',
      match: /without pinning gpg\.format/,
    },
    'a command that is not git at all': { gitCmd: 'sudo -c user.name="B"', match: /must start with "git"/ },
    // #158's bug class: an identity with no pinned signing posture inherits the human's.
    'an identity-bearing base that leaves commit.gpgsign unpinned': {
      gitCmd: 'git -c user.name="Bot" -c user.email=bot@x.io',
      match: /pins an identity but leaves commit\.gpgsign AMBIENT/,
    },
    'a non-boolean commit.gpgsign is not silently read as false': {
      gitCmd: 'git -c commit.gpgsign=flase -c user.name="Bot" -c user.email=bot@x.io',
      match: /commit\.gpgsign="flase", which is not a git boolean/,
    },
    'an empty commit.gpgsign is not a boolean either': {
      gitCmd: 'git -c commit.gpgsign= -c user.name="Bot" -c user.email=bot@x.io',
      match: /commit\.gpgsign="", which is not a git boolean/,
    },
    'a dangling -c is an error': {
      gitCmd: 'git -c commit.gpgsign=false -c user.name="B" -c user.email=b@x.io -c',
      match: /ends with a dangling -c/,
    },
  };

  for (const [label, { gitCmd, match }] of Object.entries(cases)) {
    test(label, () => {
      const r = run({ gitCmd });
      assert.equal(r.code, 1, r.all);
      assert.match(r.err, match);
      assert.match(r.err, /STOP: do not spawn agents/);
      assert.match(r.err, /never improvise an identity or fall back to the ambient one/);
    });
  }

  test('an unparseable agentIdentities payload fails safe rather than skipping silently', () => {
    const r = run({ gitCmd: RECIPE_A, identities: 'lead-engineer: inline\n  - nope\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /git\.agentIdentities on stdin is unparseable/);
  });

  test('an unknown leaf key is an error', () => {
    const r = run({ gitCmd: RECIPE_A, identities: 'lead-engineer:\n  botname: Lead\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /unknown leaf "botname"/);
  });

  test('a leaf violating its entryPattern is an error (defense in depth over the render-time guard)', () => {
    const r = run({ gitCmd: RECIPE_A, identities: 'lead-engineer:\n  botEmail: not-an-email\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /botEmail value "not-an-email" violates its declared entryPattern/);
  });

  test('missing required args exits 1 with usage', () => {
    const r = run({ args: ['--git-cmd', 'git'] });
    assert.equal(r.code, 1);
    assert.match(r.err, /--git-cmd and --agents are both required/);
    assert.match(r.err, /Usage: node identity\.mjs/);
  });

  test('an unknown argument exits 1 with usage rather than being ignored', () => {
    const r = run({ args: ['--git-cmd', 'git', '--agents', 'lead-engineer', '--bogus'] });
    assert.equal(r.code, 1);
    assert.match(r.err, /identity: unknown argument: --bogus/);
    assert.match(r.err, /Usage: node identity\.mjs/);
  });

  test('the unpinned-posture verdict is never printed as "(unsigned)" — the gate stops first', () => {
    const r = run({ gitCmd: 'git -c user.name="Bot" -c user.email=bot@x.io' });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.all, /\(unsigned\)/, 'a gate must not guess in the reassuring direction');
    assert.doesNotMatch(r.all, /preflight PASSED/);
  });

  test('a broken base command suppresses derived findings — the base error IS the report', () => {
    const r = run({ gitCmd: 'git -c user.name="B"' });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.all, /cannot subaddress/, 'no noise about an email that does not exist');
  });
});

describe('identity preflight: WARN class — surfaced, run proceeds', () => {
  test('a non-empty identity map over a bare git.cmd is inert — the flagship swallowed case', () => {
    const r = run({ gitCmd: 'git', identities: 'lead-engineer:\n  botName: Lead\n' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /WARN: .*INERT WITHOUT THE OPT-IN/);
  });

  test('a per-agent signingKey under a commit.gpgsign=false base is deliberately inert', () => {
    const r = run({ gitCmd: RECIPE_A, identities: 'lead-engineer:\n  signingKey: ABCDEF1234567890\n' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /WARN: .*SELECTS a key, it does not ENABLE signing/);
  });

  test('a hex key id under gpg.format=ssh is a format contradiction (WARN, never ERROR)', () => {
    const r = run({ gitCmd: RECIPE_B, identities: 'lead-engineer:\n  signingKey: DEADBEEF12345678\n' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /WARN: .*looks like an OpenPGP key id .* pins gpg\.format=ssh/);
  });

  test('a key path under gpg.format=openpgp is a format contradiction', () => {
    const gitCmd = RECIPE_B.replace('gpg.format=ssh', 'gpg.format=openpgp');
    const r = run({ gitCmd, identities: 'lead-engineer:\n  signingKey: ~/.ssh/agent.pub\n' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /WARN: .*looks like a key path .* pins gpg\.format=openpgp/);
  });

  test('a signing base that leaves tag.gpgSign ambient is advisory; a non-signing one has nothing to surface', () => {
    const signingNoTag = RECIPE_B.replace(' -c tag.gpgsign=true', '');
    const r = run({ gitCmd: signingNoTag });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /WARN: .*leaves tag\.gpgSign ambient/);
    // ...a recipe that pins both stays quiet about tags...
    assert.doesNotMatch(run({ gitCmd: RECIPE_B }).out, /tag\.gpgSign ambient/);
    // ...and so does the canonical commit.gpgsign=false recipe: it never expressed a
    // tag-signing intent, so there is no dangling intent to warn about.
    assert.doesNotMatch(run({ gitCmd: RECIPE_A }).out, /tag\.gpgSign ambient/);
  });

  test('an entry matching no agent file and no planned agent is a typo; a real-but-unplanned agent is silent', () => {
    const typo = run({ gitCmd: RECIPE_A, identities: 'led-enginer:\n  botName: Lead\n' });
    assert.equal(typo.code, 0, typo.all);
    assert.match(typo.out, /WARN: .*matches no agent definition and no agent planned/);

    // security-auditor has a definition file but is not in this run — legitimate, silent.
    const unplanned = run({ gitCmd: RECIPE_A, identities: 'security-auditor:\n  botName: Auditor\n' });
    assert.equal(unplanned.code, 0, unplanned.all);
    assert.doesNotMatch(unplanned.out, /matches no agent definition/);
  });

  test('the typo WARN never fires without --agents-dir — an unknowable definition set accuses nobody', () => {
    // Same missing evidence, same policy as hasDisplayName: fail open, do not assert.
    const r = run({ gitCmd: RECIPE_A, identities: 'led-enginer:\n  botName: Lead\n', dir: false });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /matches no agent definition/);
    assert.doesNotMatch(r.out, /displayName for/, 'the sibling check also fails open without a dir');
  });

  test('a harness built-in has no definition file, so the WARN it earns must not claim the entry is dead', () => {
    // general-purpose is a real, configurable agent with no .md in agentsDir.
    const r = run({ gitCmd: RECIPE_A, identities: 'general-purpose:\n  botName: GP\n' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /WARN: .*likely a typo'd slug; if it is a harness built-in/);
    assert.doesNotMatch(r.out, /will never apply/, 'a built-in entry applies the moment it is planned');

    // ...and once it IS planned, the WARN is gone entirely.
    const planned = run({ gitCmd: RECIPE_A, agents: 'general-purpose', identities: 'general-purpose:\n  botName: GP\n' });
    assert.equal(planned.code, 0, planned.all);
    assert.doesNotMatch(planned.out, /matches no agent definition/);
  });
});

describe('identity preflight: NOTE class — informational', () => {
  test('a noreply base cannot subaddress, so agents share the email', () => {
    const r = run({ gitCmd: 'git -c commit.gpgsign=false -c user.name="B" -c user.email=1234+wafflebot@users.noreply.github.com' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /NOTE: .*cannot subaddress/);
    assert.match(r.out, /sub-agents = derived \(shared base email; display names distinguish\)/);
  });

  test('an explicit botEmail override silences the shared-email note for that agent', () => {
    const r = run({
      gitCmd: 'git -c commit.gpgsign=false -c user.name="B" -c user.email=bot@users.noreply.github.com',
      identities: 'lead-engineer:\n  botEmail: lead@wafflenet.io\n',
    });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.out, /cannot subaddress/);
  });

  test('a planned agent with no identity.displayName gets the title-case fallback note', () => {
    const r = run({ gitCmd: RECIPE_A, agents: 'lead-engineer,security-auditor,general-purpose' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /NOTE: no identity\.displayName for: security-auditor, general-purpose/);
    assert.doesNotMatch(r.out, /displayName for: lead-engineer/);
  });
});

describe('identity preflight: the agentIdentities YAML subset', () => {
  test('the empty map renders as `{}` and parses to no overrides', () => {
    assert.equal(run({ gitCmd: RECIPE_A, identities: '{}\n' }).code, 0);
  });

  test('quoted scalars and multiple agents parse', () => {
    const r = run({
      gitCmd: RECIPE_A,
      agents: 'lead-engineer,security-auditor',
      identities: 'lead-engineer:\n  botName: "Lead Engineer"\n  botEmail: lead@wafflenet.io\nsecurity-auditor:\n  botName: Auditor\n',
    });
    assert.equal(r.code, 0, r.all);
    assert.doesNotMatch(r.all, /^ERROR:/m);
  });

  // Two different throws, one fail-safe outcome. Pin the exact message each input produces —
  // a `/unparseable/` assertion passes on whichever branch happens to fire.
  test('a lone leaf is de-indented by trim() and fails safe on the inline-value branch', () => {
    const r = run({ gitCmd: RECIPE_A, identities: '  botName: Orphan\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /agent "botName" must map to a block of leaves, not the inline value "Orphan"/);
  });

  test('an indented leaf with no parent agent key fails safe', () => {
    // A leading comment survives trim(), so the leaf really does arrive indented.
    const r = run({ gitCmd: RECIPE_A, identities: '# lead-engineer\n  botName: Orphan\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /indented line "  botName: Orphan" has no parent agent key/);
  });

  test('a leaf with no value fails safe', () => {
    const r = run({ gitCmd: RECIPE_A, identities: 'lead-engineer:\n  botName:\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /leaf "botName" has no value/);
  });
});
