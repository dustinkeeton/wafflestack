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

  test('commit.gpgsign pinned with tag.gpgSign left ambient is advisory', () => {
    const r = run({ gitCmd: RECIPE_A });
    assert.equal(r.code, 0);
    assert.match(r.out, /WARN: .*leaves tag\.gpgSign ambient/);
    // ...and a recipe that pins both stays quiet about tags.
    assert.doesNotMatch(run({ gitCmd: RECIPE_B }).out, /tag\.gpgSign ambient/);
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
});

describe('identity preflight: NOTE class — informational', () => {
  test('a noreply base cannot subaddress, so agents share the email', () => {
    const r = run({ gitCmd: 'git -c user.name="B" -c user.email=1234+wafflebot@users.noreply.github.com' });
    assert.equal(r.code, 0, r.all);
    assert.match(r.out, /NOTE: .*cannot subaddress/);
    assert.match(r.out, /sub-agents = derived \(shared base email; display names distinguish\)/);
  });

  test('an explicit botEmail override silences the shared-email note for that agent', () => {
    const r = run({
      gitCmd: 'git -c user.name="B" -c user.email=bot@users.noreply.github.com',
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

  test('an indented leaf with no parent agent key fails safe', () => {
    const r = run({ gitCmd: RECIPE_A, identities: '  botName: Orphan\n' });
    assert.equal(r.code, 1, r.all);
    assert.match(r.err, /unparseable/);
  });
});
