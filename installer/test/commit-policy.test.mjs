import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { inspectCommitPolicy, formatCommitPolicy } from '../lib/commit-policy.mjs';
import { renderProject } from '../lib/render.mjs';

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(toolkitRoot, 'installer/cli.mjs');
const human = { name: 'Example Human', email: 'human@example.test' };
const bot = { name: 'Example Automation', email: 'automation@example.test' };
const humanCredit = `Co-authored-by: ${human.name} <${human.email}>`;
const botCredit = `Co-authored-by: ${bot.name} <${bot.email}>`;
const agentRecipe = 'git -c user.name="Example Automation" -c user.email=automation@example.test -c commit.gpgsign=true -c gpg.format=ssh -c user.signingkey=/nonexistent/agent.pub';

function fixture(context) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-commit-policy-'));
  context.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'EMAIL'));
  Object.assign(env, { HOME: cwd, XDG_CONFIG_HOME: cwd, GIT_CONFIG_GLOBAL: path.join(cwd, 'global'), GIT_CONFIG_SYSTEM: '/dev/null' });
  const global = (profile, identity = human) => fs.writeFileSync(env.GIT_CONFIG_GLOBAL, [
    '[user]', `name = ${identity.name}`, `email = ${identity.email}`, 'signingkey = /nonexistent/human.pub',
    '[gpg]', 'format = ssh', '[commit]', 'gpgsign = true',
    ...(profile ? ['[wafflestack]', `commitProfile = ${profile}`] : []), '',
  ].join('\n'));
  global();
  const initialized = spawnSync('git', ['init', '--quiet', cwd], { env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.mkdirSync(path.join(cwd, '.waffle'));
  const config = (git = {}) => fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), YAML.stringify({
    targets: ['claude'], stacks: ['github-workflow'], config: { project: { name: 'example' }, git: {
      ownerName: human.name, ownerEmail: human.email, botName: bot.name, botEmail: bot.email,
      signingKey: '/nonexistent/agent.pub', ...git,
    } },
  }));
  const overlay = (git) => fs.writeFileSync(path.join(cwd, '.waffle/waffle.local.yaml'), YAML.stringify({ config: { git } }));
  config();
  const inspect = (options = {}) => inspectCommitPolicy({ cwd, toolkitRoot, env, ...options });
  const run = (...args) => spawnSync(process.execPath, [cli, 'commit-policy', '--cwd', cwd, ...args], { env, encoding: 'utf8' });
  return { cwd, env, config, overlay, global, inspect, run };
}

function valid(policy) {
  assert.equal(policy.configurationValid, true, policy.errors.join('\n'));
  assert.equal(policy.authorization.granted, false);
  assert.equal(policy.signer.verified, false);
  assert.equal(policy.signer.fingerprint, null);
}

function blocked(policy, diagnostic) {
  assert.equal(policy.configurationValid, false);
  assert.match(policy.errors.join('\n'), diagnostic);
}

test('personal profiles accept case-only noreply differences without changing stored identities', (context) => {
  const { config, global, inspect } = fixture(context);
  const configuredEmail = '1234567+ExampleHuman@users.noreply.github.com';
  const effectiveEmail = configuredEmail.toLowerCase();
  config({ ownerEmail: configuredEmail });
  global(undefined, { ...human, email: effectiveEmail });
  for (const profile of ['personal', 'personal-credit-agent']) {
    const policy = inspect({ profile, coAuthorTrailer: profile === 'personal' ? '' : botCredit });
    valid(policy);
    assert.equal(policy.author.email, effectiveEmail);
    assert.equal(policy.committer.email, effectiveEmail);
  }
  global(undefined, { name: human.name.toLowerCase(), email: effectiveEmail });
  blocked(inspect({ profile: 'personal', coAuthorTrailer: '' }), /effective author does not match/);
});

test('agent profile matches case-only bot and human credit emails', (context) => {
  const { config, inspect } = fixture(context);
  const ownerEmail = '1234567+ExampleHuman@users.noreply.github.com';
  config({ ownerEmail, botEmail: bot.email.toUpperCase() });
  const coAuthorTrailer = `Co-authored-by: ${human.name} <${ownerEmail.toLowerCase()}>`;
  const policy = inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe, coAuthorTrailer });
  valid(policy);
  assert.equal(policy.coAuthors[0].email, ownerEmail.toLowerCase());
  assert.equal(policy.author.email, bot.email);
});

test('case-only trailer duplicates are rejected for both credit and sign-offs', (context) => {
  const { inspect } = fixture(context);
  for (const [option, token] of [['coAuthorTrailer', 'Co-authored-by'], ['signOffTrailer', 'Signed-off-by']]) {
    const email = '1234567+ExampleHuman@users.noreply.github.com';
    blocked(inspect({ [option]: `${token}: ${human.name} <${email}>\n${token}: ${human.name} <${email.toLowerCase()}>` }), new RegExp(`duplicate ${token}`));
  }
});

test('agent and human cannot be distinct through case-only email aliases', (context) => {
  const { config, inspect } = fixture(context);
  const ownerEmail = '1234567+ExampleHuman@users.noreply.github.com';
  config({ ownerEmail, botEmail: ownerEmail.toLowerCase() });
  const policy = inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe.replace(bot.email, ownerEmail.toLowerCase()) });
  blocked(policy, /agent and human identities must be explicitly configured and distinct/);
  assert.doesNotMatch(policy.errors.join('\n'), /effective (author|committer) does not match/);
});

test('identity mismatch diagnostics show expected and actual values without equating noreply forms', (context) => {
  const { config, global, inspect } = fixture(context);
  config({ ownerEmail: '1234567+ExampleHuman@users.noreply.github.com' });
  global(undefined, { ...human, email: 'ExampleHuman@users.noreply.github.com' });
  const policy = inspect({ profile: 'personal', coAuthorTrailer: '' });
  blocked(policy, /effective author does not match/);
  for (const role of ['author', 'committer']) {
    assert.ok(policy.errors.includes(`effective ${role} does not match the selected profile: expected Example Human <1234567+ExampleHuman@users.noreply.github.com>, got Example Human <ExampleHuman@users.noreply.github.com>`));
  }
  config({ ownerEmail: '' });
  blocked(inspect({ profile: 'personal', coAuthorTrailer: '' }), /expected \(missing\), got Example Human/);
});

test('legacy and agent credit warn about public human trailers without blocking real addresses', (context) => {
  const { config, inspect } = fixture(context);
  config({ cmd: agentRecipe });
  for (const profile of ['legacy', 'agent-credit-human']) {
    const policy = inspect({ profile });
    valid(policy);
    const privacy = policy.notices.filter((notice) => notice.startsWith('Privacy:'));
    assert.equal(privacy.length, 1);
    assert.match(privacy[0], /co-author email human@example.test/);
    assert.match(privacy[0], /public in shared commit history/);
    assert.match(privacy[0], /Do not assume GitHub's email-privacy push protection protects Co-authored-by trailers/);
    assert.match(formatCommitPolicy(policy), /note: Privacy:/);
  }
  const noreply = '1234567+ExampleHuman@USERS.NOREPLY.GITHUB.COM';
  config({ cmd: agentRecipe, ownerEmail: noreply });
  for (const profile of ['legacy', 'agent-credit-human']) {
    const policy = inspect({ profile });
    valid(policy);
    assert.equal(policy.notices.some((notice) => notice.startsWith('Privacy:')), false);
  }
});

test('personal profiles warn about real author and committer emails, not a separate bot credit', (context) => {
  const { inspect } = fixture(context);
  for (const profile of ['personal', 'personal-credit-agent']) {
    const policy = inspect({ profile, coAuthorTrailer: profile === 'personal' ? '' : botCredit });
    valid(policy);
    const privacy = policy.notices.filter((notice) => notice.startsWith('Privacy:'));
    assert.equal(privacy.length, 2);
    assert.match(privacy[0], /author email human@example.test/);
    assert.match(privacy[1], /committer email human@example.test/);
  }
});

test('noreply personal identities and unused real human bindings do not cause privacy notices', (context) => {
  const { config, global, inspect } = fixture(context);
  const email = '1234567+ExampleHuman@users.noreply.github.com';
  config({ ownerEmail: email });
  global(undefined, { ...human, email });
  for (const profile of ['personal', 'personal-credit-agent']) {
    const policy = inspect({ profile, coAuthorTrailer: profile === 'personal' ? '' : botCredit });
    valid(policy);
    assert.equal(policy.notices.some((notice) => notice.startsWith('Privacy:')), false);
  }
  config({ cmd: agentRecipe });
  const botOnly = inspect({ coAuthorTrailer: '' });
  valid(botOnly);
  assert.equal(botOnly.notices.some((notice) => notice.startsWith('Privacy:')), false);
});

test('privacy notices inspect actual ambient identities and reject lookalike noreply domains', (context) => {
  const { config, inspect, env } = fixture(context);
  config({ ownerEmail: '1234567+ExampleHuman@users.noreply.github.com' });
  const policy = inspect({ coAuthorTrailer: '', env: { ...env, GIT_AUTHOR_EMAIL: 'human@users.noreply.github.com.example.test' } });
  valid(policy);
  const privacy = policy.notices.filter((notice) => notice.startsWith('Privacy:'));
  assert.equal(privacy.length, 2);
  assert.match(privacy[0], /author email human@users.noreply.github.com.example.test/);
  assert.match(privacy[1], /committer email human@example.test/);
});

test('legacy factory selection remains unchanged and never authorizes a commit', (context) => {
  const { inspect } = fixture(context);
  const policy = inspect();
  valid(policy);
  assert.equal(policy.profile, 'legacy');
  assert.equal(policy.profileSource, 'stack-default');
  assert.deepEqual(policy.author, human);
  assert.deepEqual(policy.committer, human);
  assert.deepEqual(policy.coAuthors, [human]);
  assert.match(formatCommitPolicy(policy), /NOT GRANTED/);
});

test('profile precedence is invocation, overlay, repository, global, legacy', (context) => {
  const { global, config, overlay, inspect } = fixture(context);
  global('prepare-only');
  assert.equal(inspect().profileSource, 'global-git');
  config({ commitProfile: 'legacy' });
  assert.equal(inspect().profileSource, 'waffle.yaml');
  overlay({ commitProfile: 'prepare-only' });
  assert.equal(inspect().profileSource, 'local-overlay');
  const policy = inspect({ profile: 'personal', coAuthorTrailer: '' });
  valid(policy);
  assert.equal(policy.profileSource, 'invocation');
  assert.equal(policy.profile, 'personal');
});

test('personal profiles require exact attribution rather than merging stale credit', (context) => {
  const { inspect } = fixture(context);
  valid(inspect({ profile: 'personal', coAuthorTrailer: '' }));
  valid(inspect({ profile: 'personal-credit-agent', coAuthorTrailer: botCredit }));
  blocked(inspect({ profile: 'personal' }), /co-author trailers/);
  blocked(inspect({ profile: 'personal-credit-agent', coAuthorTrailer: `${botCredit}\n${humanCredit}` }), /co-author trailers/);
});

test('agent profile resolves separate fields and cannot certify signer readiness', (context) => {
  const { inspect } = fixture(context);
  const policy = inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe });
  valid(policy);
  assert.deepEqual(policy.author, bot);
  assert.deepEqual(policy.committer, bot);
  assert.equal(policy.signer.key, '/nonexistent/agent.pub');
  assert.deepEqual(policy.coAuthors, [human]);
  assert.match(policy.requiredChecks.join('\n'), /fingerprints are distinct/);
  assert.equal(policy.sources.signer, 'recipe-or-agent-override');
});

test('environment author and committer overrides are inspected independently', (context) => {
  const { inspect, env } = fixture(context);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    const policy = inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe, env: { ...env, [`GIT_${role}_NAME`]: human.name, [`GIT_${role}_EMAIL`]: human.email } });
    blocked(policy, new RegExp(`effective ${role.toLowerCase()} does not match`));
    assert.deepEqual(policy[role.toLowerCase()], human);
    assert.equal(policy.sources.identityEnvironment.length, 2);
  }
});

test('author and committer config remain independent of user identity', (context) => {
  const { inspect } = fixture(context);
  const policy = inspect({ profile: 'agent-credit-human', gitCmd: `${agentRecipe} -c author.name="Other Author" -c author.email=other@example.test` });
  blocked(policy, /effective author does not match/);
  assert.deepEqual(policy.committer, bot);
});

test('runtime config pairs cannot override explicit recipe pins or redefine the personal baseline', (context) => {
  const { inspect, env } = fixture(context);
  const injected = { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.signingkey', GIT_CONFIG_VALUE_0: '/nonexistent/agent.pub' };
  valid(inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe, env: injected }));
  blocked(inspect({ profile: 'personal', coAuthorTrailer: '', env: injected }), /personal global signing key/);
});

test('canonical unsigned recipe is not mistaken for the signed agent profile', (context) => {
  const { config, inspect } = fixture(context);
  config({ cmd: agentRecipe.replace('commit.gpgsign=true', 'commit.gpgsign=false') });
  valid(inspect());
  blocked(inspect({ profile: 'agent-credit-human' }), /unsigned fallback is forbidden/);
});

test('canonical signing requirement survives local false and invocation legacy', (context) => {
  const { config, overlay, inspect } = fixture(context);
  config({ requireSignedCommits: true });
  overlay({ requireSignedCommits: false });
  const policy = inspect({ profile: 'legacy', gitCmd: 'git -c commit.gpgsign=false' });
  blocked(policy, /repository requires signed commits/);
  assert.equal(policy.requireSignedCommits, true);
  valid(inspect({ profile: 'prepare-only', gitCmd: 'git -c commit.gpgsign=false' }));
});

test('local signing requirement can strengthen repository defaults', (context) => {
  const { overlay, inspect } = fixture(context);
  overlay({ requireSignedCommits: true });
  blocked(inspect({ gitCmd: 'git -c commit.gpgsign=false' }), /requires signed commits/);
});

test('agent profile fails closed on missing bindings, key and credit', (context) => {
  const { config, inspect } = fixture(context);
  config({ signingKey: '' });
  blocked(inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe }), /explicitly configured agent signing key/);
  config({ ownerEmail: '' });
  blocked(inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe, coAuthorTrailer: '' }), /co-author identity is missing/);
  config({ botEmail: human.email });
  blocked(inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe }), /identities must be explicitly configured and distinct/);
});

test('agent profile rejects the personal signer and ambient-only signing selection', (context) => {
  const { config, inspect, env } = fixture(context);
  config({ signingKey: '/nonexistent/human.pub' });
  blocked(inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe.replace('/nonexistent/agent.pub', '/nonexistent/human.pub') }), /personal global signing key/);
  config();
  const injected = { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.signingkey', GIT_CONFIG_VALUE_0: '/nonexistent/agent.pub' };
  blocked(inspect({ profile: 'agent-credit-human', gitCmd: 'git -c user.name="Example Automation" -c user.email=automation@example.test', env: injected }), /must be pinned/);
});

test('explicit per-agent overrides apply without creating synthetic identities', (context) => {
  const { config, inspect } = fixture(context);
  config({ agentIdentities: { engineer: { botName: 'Engineer', botEmail: 'engineer@example.test', signingKey: '/nonexistent/engineer.pub' } } });
  const policy = inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe, agent: 'engineer' });
  valid(policy);
  assert.equal(policy.author.email, 'engineer@example.test');
  assert.equal(policy.signer.key, '/nonexistent/engineer.pub');
  const base = inspect({ profile: 'agent-credit-human', gitCmd: agentRecipe, agent: 'other' });
  valid(base);
  assert.deepEqual(base.author, bot);
});

test('sign-offs are independent attestations, never implicit credits or signatures', (context) => {
  const { inspect } = fixture(context);
  const signOff = `Signed-off-by: ${human.name} <${human.email}>`;
  const policy = inspect({ profile: 'personal', coAuthorTrailer: '', signOffTrailer: signOff });
  valid(policy);
  assert.deepEqual(policy.coAuthors, []);
  assert.deepEqual(policy.signOffs, [human]);
  assert.match(policy.requiredChecks.join('\n'), /Separate approval/);
  blocked(inspect({ coAuthorTrailer: signOff }), /expected only Co-authored-by/);
  blocked(inspect({ signOffTrailer: humanCredit }), /expected only Signed-off-by/);
});

test('attribution overrides replace whole lists and empty strings clear them', (context) => {
  const { overlay, inspect } = fixture(context);
  overlay({ coAuthorTrailer: botCredit, signOffTrailer: `Signed-off-by: ${bot.name} <${bot.email}>` });
  const policy = inspect({ coAuthorTrailer: '', signOffTrailer: '' });
  valid(policy);
  assert.deepEqual(policy.coAuthors, []);
  assert.deepEqual(policy.signOffs, []);
  assert.equal(policy.sources.coAuthors, 'invocation');
  blocked(inspect({ coAuthorTrailer: `${humanCredit}\n${humanCredit}` }), /duplicate Co-authored-by/);
});

test('malformed profiles and unsafe recipes fail closed without shell evaluation', (context) => {
  const { inspect, cwd } = fixture(context);
  blocked(inspect({ profile: 'invalid' }), /unknown commit profile/);
  for (const gitCmd of ['git; touch marker', 'git -c core.sshCommand=evil', 'git --no-pager', 'git -c user.name="unclosed', 'git -c', 'git -c user.name={{missing}}']) {
    blocked(inspect({ gitCmd }), /pattern|unsupported|only git|quote|dangling|unresolved/);
  }
  assert.equal(fs.existsSync(path.join(cwd, 'marker')), false);
});

test('invalid policy types and valueless identities cannot pass', (context) => {
  const { config, inspect } = fixture(context);
  config({ requireSignedCommits: 'true' });
  blocked(inspect(), /must be boolean/);
  config({ agentIdentities: { engineer: { signingKey: true } } });
  blocked(inspect({ agent: 'engineer' }), /invalid recipe value/);
  blocked(inspect({ profile: 'personal', coAuthorTrailer: '', gitCmd: 'git -c user.signingkey' }), /valueless identity or signer/);
});

test('missing ambient identity and malformed signing booleans produce blocked reports', (context) => {
  const { inspect, env } = fixture(context);
  const missing = inspect({ gitCmd: 'git -c user.useConfigOnly=true', env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  blocked(missing, /effective author and committer/);
  blocked(inspect({ gitCmd: 'git -c commit.gpgsign=maybe' }), /could not resolve git config/);
});

test('signing formats and last-wins recipe options are inspected without signing', (context) => {
  const { inspect } = fixture(context);
  for (const format of ['ssh', 'openpgp', 'x509']) {
    valid(inspect({ profile: 'agent-credit-human', gitCmd: `${agentRecipe} -c gpg.format=${format}` }));
  }
  blocked(inspect({ profile: 'agent-credit-human', gitCmd: `${agentRecipe} -c commit.gpgsign=false` }), /unsigned fallback/);
  valid(inspect({ profile: 'agent-credit-human', gitCmd: `git -c commit.gpgsign=false ${agentRecipe.slice(4)}` }));
});

test('CLI prints inspectable JSON and rejects missing, duplicate and unknown options', (context) => {
  const { run } = fixture(context);
  const result = run('--json', '--profile', 'personal', '--co-author-trailer', '');
  assert.equal(result.status, 0, result.stderr);
  valid(JSON.parse(result.stdout));
  for (const args of [['--profile'], ['--profile', 'legacy', '--profile', 'personal'], ['--authorize'], ['--git-cmd', '--json']]) {
    const invalid = run(...args);
    assert.notEqual(invalid.status, 0, invalid.stdout);
  }
  const invalid = run('--json', '--profile', 'personal');
  assert.equal(invalid.status, 1, invalid.stderr);
  blocked(JSON.parse(invalid.stdout), /co-author trailers/);
});

test('inspection is read-only and never invokes a configured signer', (context) => {
  const { config, inspect, cwd } = fixture(context);
  const marker = path.join(cwd, 'signed');
  const signer = path.join(cwd, 'signer');
  fs.writeFileSync(signer, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  config({ cmd: `${agentRecipe} -c gpg.ssh.program=${signer}` });
  const snapshot = () => fs.readdirSync(cwd, { recursive: true }).filter((entry) => fs.statSync(path.join(cwd, entry)).isFile()).sort()
    .map((entry) => [entry, fs.readFileSync(path.join(cwd, entry), 'hex')]);
  const before = snapshot();
  valid(inspect({ profile: 'agent-credit-human' }));
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(snapshot(), before);
});

test('personal global preference never enters canonical render or lock', (context) => {
  const { cwd, env, global, inspect } = fixture(context);
  const render = () => spawnSync(process.execPath, [cli, 'render', '--cwd', cwd, '--allow-unreleased', '--offline'], { env, encoding: 'utf8' });
  const initial = render();
  assert.equal(initial.status, 0, initial.stderr);
  const lockPath = path.join(cwd, '.waffle/waffle.lock.json');
  const skillPath = path.join(cwd, '.claude/skills/git-workflow/SKILL.md');
  const before = [fs.readFileSync(lockPath, 'utf8'), fs.readFileSync(skillPath, 'utf8')];
  global('agent-credit-human');
  assert.equal(inspect().profileSource, 'global-git');
  const updated = render();
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual([fs.readFileSync(lockPath, 'utf8'), fs.readFileSync(skillPath, 'utf8')], before);
});

test('rendered delegate preflight retains its adjacent parser dependency', (context) => {
  const { cwd, env } = fixture(context);
  const configPath = path.join(cwd, '.waffle/waffle.yaml');
  const project = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  project.include = ['skills/delegate'];
  project.config.roster = {
    classificationTable: '| Signal | Agent |', labelFallback: '| Label | Agent |',
    rootFiles: 'package.json', sharedModule: 'lib/', moduleDependencies: 'none',
  };
  fs.writeFileSync(configPath, YAML.stringify(project));
  const rendered = renderProject({ cwd, toolkitRoot, toolkitVersion: '0.20.0' });
  assert.equal(rendered.ok, true, rendered.errors?.join('\n'));
  const result = spawnSync(process.execPath, [path.join(cwd, '.claude/skills/delegate/identity.mjs'), '--git-cmd', 'git', '--agents', 'engineer'], { env, encoding: 'utf8', input: '{}' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /preflight PASSED/);
});
