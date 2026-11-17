import { spawnSync } from 'node:child_process';
import { loadProjectConfig, resolveLocalConfigFile } from './project.mjs';
import { loadToolkit } from './toolkit.mjs';
import { expandKey } from './state.mjs';
import { exists, lookupPath, readYaml } from './util.mjs';
import { parseGitCmd } from '../../stacks/orchestration/skills/delegate/git-command.mjs';

export const COMMIT_PROFILES = ['legacy', 'personal', 'personal-credit-agent', 'agent-credit-human', 'prepare-only'];

const RECIPE_KEYS = new Set([
  'user.name', 'user.email', 'author.name', 'author.email', 'committer.name', 'committer.email',
  'user.signingkey', 'user.useconfigonly', 'commit.gpgsign', 'tag.gpgsign', 'gpg.format',
  'gpg.program', 'gpg.openpgp.program', 'gpg.ssh.program', 'gpg.x509.program',
]);
const identityText = (identity) => identity ? `${identity.name} <${identity.email}>` : '(missing)';
const sameEmail = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const sameIdentity = (left, right) => Boolean(left && right && left.name === right.name && sameEmail(left.email, right.email));

function parseIdentity(text) {
  const match = /^([^<>\r\n]+) <([^<>\s]+@[^<>\s]+)>$/.exec(text);
  return match ? { name: match[1], email: match[2] } : null;
}

function trailers(text, token, errors) {
  if (typeof text !== 'string') {
    errors.push(`${token} trailers must be a string`);
    return [];
  }
  if (!text.trim()) return [];
  const identities = [];
  for (const line of text.split('\n')) {
    const identity = line.startsWith(`${token}: `) ? parseIdentity(line.slice(token.length + 2)) : null;
    if (!identity) errors.push(`expected only ${token}: Name <email> lines`);
    else if (identities.some((entry) => sameIdentity(entry, identity))) errors.push(`duplicate ${token} identity`);
    else identities.push(identity);
  }
  return identities;
}

function runGit(cwd, args, env) {
  const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('commit-policy could not read Git metadata; check the repository and Git configuration');
  return result.status === 0 ? result.stdout.trimEnd() : null;
}

export function inspectCommitPolicy({ cwd, toolkitRoot, profile, agent, gitCmd, coAuthorTrailer, signOffTrailer, env = process.env }) {
  const errors = [];
  const notices = [];
  const project = loadProjectConfig(cwd);
  const canonical = loadProjectConfig(cwd, [], { canonical: true });
  const overlayPath = resolveLocalConfigFile(cwd).file;
  const overlay = exists(overlayPath) ? readYaml(overlayPath)?.config ?? {} : {};
  const stack = loadToolkit(toolkitRoot).stacks.get('github-workflow');
  if (!stack) throw new Error('github-workflow stack is unavailable');
  const source = (key) => lookupPath(overlay, key) !== undefined ? 'local-overlay'
    : lookupPath(canonical.values, key) !== undefined ? 'waffle.yaml' : 'stack-default';
  const value = (key) => expandKey(stack, project, project.targets[0], key);
  const globalEnv = { ...env };
  delete globalEnv.GIT_CONFIG_COUNT;
  delete globalEnv.GIT_CONFIG_PARAMETERS;
  const globalValue = (key) => runGit(cwd, ['config', '--global', '--includes', '--get', key], globalEnv);
  const configuredProfile = lookupPath(project.values, 'git.commitProfile');
  const globalProfile = globalValue('wafflestack.commitProfile');
  const selected = profile ?? configuredProfile ?? globalProfile ?? 'legacy';
  const profileSource = profile !== undefined ? 'invocation' : configuredProfile !== undefined ? source('git.commitProfile')
    : globalProfile !== null ? 'global-git' : 'stack-default';
  if (!COMMIT_PROFILES.includes(selected)) errors.push(`unknown commit profile; choose ${COMMIT_PROFILES.join(', ')}`);
  const recipeErrors = [];
  let command = gitCmd ?? value('git.cmd');
  const recipeSource = gitCmd !== undefined ? 'invocation' : source('git.cmd');
  if (typeof command !== 'string' || !new RegExp(stack.config['git.cmd'].pattern).test(command)) {
    recipeErrors.push('git.cmd must match the declared safe Git recipe pattern');
    command = 'git';
  }
  const { config: recipe, valueless } = parseGitCmd(command, recipeErrors, { strict: true });
  for (const key of recipe.keys()) {
    if (!RECIPE_KEYS.has(key)) recipeErrors.push(`unsupported git.cmd key for read-only identity inspection: ${key}`);
  }
  const agentOverrides = lookupPath(project.values, 'git.agentIdentities') ?? {};
  if (typeof agentOverrides !== 'object' || Array.isArray(agentOverrides)) recipeErrors.push('git.agentIdentities must be a map');
  const override = agent ? agentOverrides[agent] : null;
  if (agent && !/^[a-z0-9][a-z0-9-]*$/.test(agent)) errors.push('agent must be a configured agent slug');
  if (override !== undefined && override !== null && (typeof override !== 'object' || Array.isArray(override))) recipeErrors.push('agent identity override must be a map');
  if (agent) {
    for (const [field, key] of [['botName', 'user.name'], ['botEmail', 'user.email'], ['signingKey', 'user.signingkey']]) {
      if (override?.[field] !== undefined) {
        recipe.set(key, override[field]);
        valueless.delete(key);
      }
    }
    notices.push('Strict profile inspection uses explicit agent overrides or the configured bot; it never invents plus-addressed identities.');
  }
  const flags = [];
  for (const [key, entry] of recipe) {
    if (!RECIPE_KEYS.has(key)) continue;
    if (typeof entry !== 'string' || /[\r\n\0]/.test(entry)) recipeErrors.push(`invalid recipe value for ${key}`);
    else flags.push('-c', `${key}=${entry}`);
  }
  errors.push(...recipeErrors);
  const read = (args) => {
    if (recipeErrors.length) return null;
    try {
      return runGit(cwd, [...flags, ...args], env);
    } catch {
      errors.push(`could not resolve git ${args.join(' ')}; check Git identity and configuration`);
      return null;
    }
  };
  const configValue = (key) => read(['config', '--get', key]);
  const ident = (role) => {
    const raw = read(['var', `GIT_${role}_IDENT`]);
    return raw ? parseIdentity(raw.replace(/ \d+ [+-]\d{4}$/, '')) : null;
  };
  const author = ident('AUTHOR');
  const committer = ident('COMMITTER');
  if (selected !== 'prepare-only' && (!author || !committer)) errors.push('effective author and committer must both have a name and email');
  const signingEnabled = read(['config', '--bool', '--get', 'commit.gpgsign']) === 'true';
  const format = configValue('gpg.format') ?? 'openpgp';
  const key = configValue('user.signingkey');
  const program = configValue(`gpg.${format}.program`) ?? (format === 'openpgp' ? configValue('gpg.program') : null)
    ?? ({ ssh: 'ssh-keygen', openpgp: 'gpg', x509: 'gpgsm' })[format] ?? null;
  const configuredIdentity = (nameKey, emailKey, overrides = null) => {
    const name = overrides?.botName ?? (lookupPath(project.values, nameKey) !== undefined ? value(nameKey) : null);
    const email = overrides?.botEmail ?? (lookupPath(project.values, emailKey) !== undefined ? value(emailKey) : null);
    return name && email ? parseIdentity(`${name} <${email}>`) : null;
  };
  const human = configuredIdentity('git.ownerName', 'git.ownerEmail');
  const bot = configuredIdentity('git.botName', 'git.botEmail', override);
  const coAuthors = trailers(coAuthorTrailer ?? value('git.coAuthorTrailer'), 'Co-authored-by', errors);
  const signOffs = trailers(signOffTrailer ?? value('git.signOffTrailer'), 'Signed-off-by', errors);
  const requirements = [lookupPath(canonical.values, 'git.requireSignedCommits'), lookupPath(overlay, 'git.requireSignedCommits')];
  if (requirements.some((entry) => entry !== undefined && typeof entry !== 'boolean')) errors.push('git.requireSignedCommits must be boolean');
  const requireSignedCommits = requirements.includes(true);
  const strict = COMMIT_PROFILES.includes(selected) && !['legacy', 'prepare-only'].includes(selected);
  if (requireSignedCommits && !signingEnabled && selected !== 'prepare-only') errors.push('repository requires signed commits; this invocation does not sign');
  if (strict) {
    const automation = selected === 'agent-credit-human';
    const expected = automation ? bot : human;
    const credit = selected === 'personal-credit-agent' ? bot : automation ? human : null;
    if (!expected) errors.push(`explicit configured ${automation ? 'bot' : 'human (git.ownerName / git.ownerEmail)'} identity is missing`);
    if (!sameIdentity(author, expected)) errors.push(`effective author does not match the selected profile: expected ${identityText(expected)}, got ${identityText(author)}`);
    if (!sameIdentity(committer, expected)) errors.push(`effective committer does not match the selected profile: expected ${identityText(expected)}, got ${identityText(committer)}`);
    if (!signingEnabled || !key || !program) errors.push('selected profile requires a configured signing key, format and signer; unsigned fallback is forbidden');
    if (!['ssh', 'openpgp', 'x509'].includes(format)) errors.push('unsupported signing format');
    if (selected !== 'personal' && !credit) errors.push('explicit configured co-author identity is missing');
    if (credit ? coAuthors.length !== 1 || !sameIdentity(coAuthors[0], credit) : coAuthors.length !== 0) errors.push('co-author trailers do not exactly match the selected profile');
    if (automation) {
      const automationKey = override?.signingKey ?? (lookupPath(project.values, 'git.signingKey') !== undefined ? value('git.signingKey') : null);
      if (!automationKey || automationKey !== key) errors.push('effective signer must select the explicitly configured agent signing key');
      if (!recipe.has('user.signingkey') || !recipe.has('gpg.format') || !recipe.has('commit.gpgsign')) errors.push('agent signing key, format and signing posture must be pinned in git.cmd');
      if (!human || sameEmail(human.email, bot?.email)) errors.push('agent and human identities must be explicitly configured and distinct');
      if (key && key === globalValue('user.signingkey')) errors.push('agent signer references the personal global signing key');
    } else if (!key || key !== globalValue('user.signingkey')) {
      errors.push('personal profile must select the configured personal global signing key');
    }
    for (const entry of valueless) {
      if (RECIPE_KEYS.has(entry) && entry !== 'commit.gpgsign' && entry !== 'tag.gpgsign' && entry !== 'user.useconfigonly') errors.push(`valueless identity or signer setting: ${entry}`);
    }
  }
  const privacyEmails = new Map();
  for (const [role, identity] of [['author', author], ['committer', committer], ...coAuthors.map((entry) => ['co-author', entry])]) {
    if (!identity || /@users\.noreply\.github\.com$/i.test(identity.email)) continue;
    if (sameEmail(identity.email, bot?.email) && !sameEmail(identity.email, human?.email)) continue;
    const normalizedEmail = identity.email.toLowerCase();
    const exposed = privacyEmails.get(normalizedEmail) ?? { email: identity.email, roles: new Set() };
    exposed.roles.add(role);
    privacyEmails.set(normalizedEmail, exposed);
  }
  for (const { email, roles } of privacyEmails.values()) {
    notices.push(`Privacy: ${email} (${[...roles].join(', ')}) is not a GitHub noreply address and would be public in shared commit history. Do not assume GitHub's email-privacy push protection protects Co-authored-by trailers; real addresses remain legitimate for other hosts or intentional public use.`);
  }
  const overriddenByEnvironment = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
    .filter((name) => env[name] !== undefined);
  if (overriddenByEnvironment.length) notices.push(`Identity environment overrides are present: ${overriddenByEnvironment.join(', ')}`);
  if (gitCmd !== undefined) notices.push('Invocation recipe is a proposed override, not permission to change repository signing posture.');
  if (signOffs.length) notices.push('Signed-off-by is a separate attestation requiring explicit approval; profile selection does not grant it.');
  return {
    schemaVersion: 1, profile: selected, profileSource, recipeSource, author, committer,
    sources: {
      human: { name: source('git.ownerName'), email: source('git.ownerEmail') },
      bot: {
        name: override?.botName !== undefined ? source(`git.agentIdentities.${agent}.botName`) : source('git.botName'),
        email: override?.botEmail !== undefined ? source(`git.agentIdentities.${agent}.botEmail`) : source('git.botEmail'),
        agent: agent ?? null,
      },
      coAuthors: coAuthorTrailer !== undefined ? 'invocation' : source('git.coAuthorTrailer'),
      signOffs: signOffTrailer !== undefined ? 'invocation' : source('git.signOffTrailer'),
      identityEnvironment: overriddenByEnvironment,
      signer: recipe.has('user.signingkey') ? 'recipe-or-agent-override' : 'ambient-git',
    },
    signer: { enabled: signingEnabled, format, key, program, fingerprint: null, verified: false },
    coAuthors, signOffs, requireSignedCommits,
    authorization: { granted: false, source: 'external-user-or-harness', inspectorCanAuthorize: false },
    configurationValid: errors.length === 0,
    execution: selected === 'prepare-only' ? 'human-handoff' : 'not-authorized-by-inspector',
    requiredChecks: strict ? [
      'Explicit user commit request and harness approval for the actual invocation.',
      'Human credit email verification and consent; explicit agent co-author consent when selected.',
      'User-controlled signer, key availability, and actual signing success.',
      ...(selected === 'agent-credit-human' ? ['Agent and personal public-key fingerprints are distinct; filenames alone do not prove this.'] : []),
      ...(signOffs.length ? ['Separate approval for every Signed-off-by attestation.'] : []),
    ] : [],
    notices, errors,
  };
}

export function formatCommitPolicy(policy) {
  return [
    `profile: ${policy.profile} (${policy.profileSource})`,
    `author: ${identityText(policy.author)}`,
    `committer: ${identityText(policy.committer)}`,
    `signer: ${policy.signer.enabled ? 'enabled' : 'disabled'}; ${policy.signer.format}; key ${policy.signer.key ?? '(missing)'}; program ${policy.signer.program ?? '(missing)'}`,
    'signer fingerprint: not checked; no key read or signing operation performed',
    `co-authors: ${policy.coAuthors.map(identityText).join(', ') || 'none'}`,
    `sign-off: ${policy.signOffs.map(identityText).join(', ') || 'none'}`,
    `repository requires signing: ${policy.requireSignedCommits}`,
    'commit authorization: NOT GRANTED by inspection; explicit user/harness authorization is separate',
    `configuration: ${policy.configurationValid ? 'valid (not proof of signing readiness)' : 'BLOCKED'}`,
    `execution: ${policy.execution}`,
    ...policy.requiredChecks.map((check) => `prerequisite: ${check}`),
    ...policy.notices.map((notice) => `note: ${notice}`),
    ...policy.errors.map((error) => `error: ${error}`),
    '',
  ].join('\n');
}
