#!/usr/bin/env node
//
// identity.mjs — verify the git identities (human / main-agent / sub-agent) a delegate run will
// commit under. Dependency-free: it runs in a repo that may have no npm deps installed.
//
// Usage: node identity.mjs --git-cmd '<resolved git.cmd>' [--agents-dir <dir>] \
//          --agents <slug,slug,...>   (git.agentIdentities YAML on stdin, heredoc)
//
// Prints ERROR:/WARN:/NOTE: lines; exit 1 on any ERROR — the caller must STOP, never improvise.

import fs from 'node:fs';
import path from 'node:path';

const USAGE =
  "Usage: node identity.mjs --git-cmd '<resolved git.cmd>' [--agents-dir <dir>] --agents <slug,slug,...>  (agentIdentities YAML on stdin)";

// Kept byte-identical to the `entryPatterns` guards on git.agentIdentities in the stack.yamls.
// Re-checked here because a hand-edited render dodges the render-time guard entirely.
const LEAF_PATTERNS = {
  botName: /^(?!.*\$\{\{)[A-Za-z0-9._[\]-]+(?: [A-Za-z0-9._[\]-]+)*$/,
  botEmail: /^(?!.*\$\{\{)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  signingKey: /^(?!.*\$\{\{)[A-Za-z0-9._\/~+:-]+$/,
};
const LEAF_KEYS = Object.keys(LEAF_PATTERNS);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--git-cmd') out.gitCmd = argv[++i];
    else if (a === '--agents-dir') out.agentsDir = argv[++i];
    else if (a === '--agents') out.agents = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return out;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return ''; // no stdin attached — same as an empty override map
  }
}

// git.cmd tokenizer. Double quotes group a spaced value; single quotes are NOT handled and cannot
// reach here through a render (`git.cmd`'s allowlist `pattern:` rejects them, #254). An
// unterminated quote or stray bare word means git would word-split it — an ERROR, not a guess.

function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let started = false;
  let inQuote = false;
  for (const ch of cmd) {
    if (ch === '"') {
      inQuote = !inQuote;
      started = true;
    } else if (!inQuote && /\s/.test(ch)) {
      if (started) tokens.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  if (inQuote) return { error: 'unterminated double quote' };
  return { tokens };
}

/**
 * Parse the tokens into a last-wins `-c` config map. git config keys are case-insensitive
 * in their section and name, so keys are lowercased; a `-c key` with no `=` means `true`,
 * exactly as git reads it.
 */
function parseGitCmd(cmd, errors) {
  const config = new Map();
  // Keys whose last occurrence carried no `=`: git reads those as the literal "true", so the
  // caller needs to tell `-c user.name` (⇒ "true") apart from `-c user.name=true`.
  const valueless = new Set();

  if (/\{\{[^}]*\}\}/.test(cmd)) {
    errors.push(
      `git.cmd carries an unresolved template placeholder: ${cmd.match(/\{\{[^}]*\}\}/)[0]} — the recipe leaned on a stack default that does not resolve here; set the identity keys as real values in project config`,
    );
  }

  const { tokens, error } = tokenize(cmd);
  if (error) {
    errors.push(`git.cmd has ${error} — a spaced value must be double-quoted or git will word-split it`);
    return { config, valueless };
  }
  if (!tokens.length || tokens[0] !== 'git') {
    errors.push(`git.cmd must start with "git" (got ${JSON.stringify(tokens[0] ?? '')})`);
    return { config, valueless };
  }

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-c') {
      const pair = tokens[++i];
      if (pair === undefined) {
        errors.push('git.cmd ends with a dangling -c (no key=value follows)');
        break;
      }
      const eq = pair.indexOf('=');
      const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? 'true' : pair.slice(eq + 1);
      if (eq === -1) valueless.add(key);
      else valueless.delete(key); // last wins, for the valueless flag as for the value
      config.set(key, value);
    } else if (t.startsWith('-')) {
      // An unknown flag is tolerated: this script polices identity, not git's whole CLI.
    } else {
      errors.push(
        `git.cmd has a stray word ${JSON.stringify(t)} that is neither "-c" nor a key=value — an unquoted spaced value word-splits here`,
      );
    }
  }
  return { config, valueless };
}

// git's boolean vocabulary (`git config --bool`). Anything outside this set is not "false" — it
// is a value git rejects at commit time, a different finding from "signing is off".
const GIT_BOOLEANS = ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'];
const isBoolean = (v) => v !== undefined && GIT_BOOLEANS.includes(String(v).toLowerCase());
const isTrue = (v) => v !== undefined && ['true', 'yes', 'on', '1'].includes(String(v).toLowerCase());

// A restricted two-level YAML-subset parser for `git.agentIdentities` as the renderer formats it.
// Sound because the split is on the FIRST colon: a leaf name is one of three literals, none
// containing a colon, so colons inside a value (signingKey admits ":") are harmless. Anything
// unrecognised throws, and the caller turns that into an ERROR — a parse surprise is fail-safe.

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseAgentIdentities(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '{}' || trimmed === 'null') return {};

  const out = {};
  let current = null;
  const lines = trimmed.split('\n');
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`cannot parse line ${JSON.stringify(raw)} (expected "key: value")`);
    const key = unquote(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();

    if (indent === 0) {
      if (!key) throw new Error(`empty agent slug in ${JSON.stringify(raw)}`);
      if (value && value !== '{}') {
        throw new Error(`agent "${key}" must map to a block of leaves, not the inline value ${JSON.stringify(value)}`);
      }
      out[key] = {};
      current = out[key];
    } else {
      if (!current) throw new Error(`indented line ${JSON.stringify(raw)} has no parent agent key`);
      if (!value) throw new Error(`leaf "${key}" has no value`);
      current[key] = unquote(value);
    }
  }
  return out;
}

function agentSlugsOnDisk(dir) {
  if (!dir) return null;
  try {
    return new Set(
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3)),
    );
  } catch {
    return null; // no agents dir in this repo — the file-backed checks simply don't run
  }
}

function hasDisplayName(dir, slug) {
  if (!dir) return true; // unknowable ⇒ don't claim a fallback that may not happen
  try {
    const md = fs.readFileSync(path.join(dir, `${slug}.md`), 'utf8');
    return /^\s*displayName:\s*\S/m.test(md);
  } catch {
    return false;
  }
}

/** A base email cannot subaddress when its domain is a *.noreply.github.com, or its local part already spends the `+` tag. */
function canSubaddress(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (domain === 'noreply.github.com' || domain.endsWith('.noreply.github.com')) return false;
  if (local.includes('+')) return false;
  return true;
}

const looksLikeKeyId = (k) => /^(0x)?[0-9A-Fa-f]{8,40}$/.test(k);
const looksLikePath = (k) => k.includes('/') || k.startsWith('~');


function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.error) {
    console.error(`identity: ${args.error}\n${USAGE}`);
    process.exit(1);
  }
  if (args.gitCmd === undefined || args.agents === undefined) {
    console.error(`identity: --git-cmd and --agents are both required\n${USAGE}`);
    process.exit(1);
  }

  const errors = [];
  const warns = [];
  const notes = [];

  const planned = args.agents
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { config, valueless } = parseGitCmd(args.gitCmd, errors);

  // --- main-agent tier: is the resolved command coherent? ---------------------

  const name = config.get('user.name');
  const email = config.get('user.email');
  const signingKey = config.get('user.signingkey');
  const gpgsign = config.get('commit.gpgsign');
  const gpgFormat = config.get('gpg.format');

  // Tri-state, never binary: `unsigned` is a claim about the config, so it may only be printed
  // when the config actually says so.
  const posture = isTrue(gpgsign)
    ? `signed, gpg.format=${gpgFormat}`
    : gpgsign === undefined
      ? 'signing posture AMBIENT (commit.gpgsign unpinned)'
      : 'unsigned';

  if (name !== undefined && email === undefined) {
    errors.push('git.cmd sets user.name but not user.email — half an identity; the missing half falls back to the ambient config');
  }
  if (email !== undefined && name === undefined) {
    errors.push('git.cmd sets user.email but not user.name — half an identity; the missing half falls back to the ambient config');
  }
  // PRESENCE IS NOT A VALUE: the checks above ask only whether each half was set at all, and git
  // objects only at commit time (or not at all), so the gate has to object now.
  //   -c user.name=          → `git commit` dies: "Author identity unknown"
  //   -c user.email=         → git commits happily, authored `<>`: no attribution at all
  //   -c user.name           → no `=`, so git reads the literal "true": commits authored by "true"
  if (config.get('user.name') === '') {
    errors.push('git.cmd sets an EMPTY user.name — git refuses the commit ("Author identity unknown"), and only at commit time, so this fails silently until an agent tries to commit');
  } else if (valueless.has('user.name')) {
    errors.push('git.cmd sets a valueless -c user.name — git reads a -c with no "=" as the literal value "true", so every bot commit would be authored by "true"');
  }
  if (config.get('user.email') === '') {
    errors.push('git.cmd sets an EMPTY user.email — git does not reject it: every bot commit is authored as "<>", with no attribution at all');
  } else if (valueless.has('user.email')) {
    errors.push('git.cmd sets a valueless -c user.email — git reads a -c with no "=" as the literal value "true", so every bot commit would be authored as "<true>"');
  }
  if (config.has('user.signingkey') && signingKey === '') {
    errors.push('git.cmd sets an EMPTY user.signingkey — git rejects it only at commit time, so this fails silently until an agent tries to commit');
  }
  if (config.has('commit.gpgsign') && !isBoolean(gpgsign)) {
    errors.push(
      `git.cmd sets commit.gpgsign=${JSON.stringify(gpgsign)}, which is not a git boolean (${GIT_BOOLEANS.join('|')}, or valueless ⇒ true) — git rejects it only at commit time, so this fails silently until an agent tries to commit`,
    );
  }
  // The #158 bug class: an identity-bearing command that never pins the signing posture leaves it
  // AMBIENT, so a ~/.gitconfig with commit.gpgsign=true signs bot commits with the human's key or
  // hangs a non-interactive agent. A BARE git.cmd is exempt — no identity, no posture to own.
  if (name !== undefined && email !== undefined && !config.has('commit.gpgsign')) {
    errors.push(
      'git.cmd pins an identity but leaves commit.gpgsign AMBIENT — the recipe owns the signing posture, and an unpinned one signs bot-authored commits with whatever key the ambient config names (or hangs a non-interactive agent on a prompting signer). Pin it: `-c commit.gpgsign=false` for an unsigned bot, or `-c commit.gpgsign=true` with user.signingkey and gpg.format for a signing one',
    );
  }
  if (isTrue(gpgsign)) {
    if (!signingKey) {
      errors.push('git.cmd sets commit.gpgsign=true without user.signingkey — the signer picks a key from the ambient config, so bot commits get signed with whatever key the human has');
    }
    if (gpgFormat === undefined) {
      errors.push('git.cmd sets commit.gpgsign=true without pinning gpg.format — the ambient format decides which signer receives the key, and a prompting signer hangs a non-interactive agent');
    }
  }

  // Everything below derives FROM the base command, so an incoherent base makes every derived
  // finding noise. Leaf-shape validation still runs: it is independent of the base.
  const baseIsCoherent = errors.length === 0;

  // --- sub-agent tier: is the derivation feasible for every planned agent? ----

  let identities = {};
  try {
    identities = parseAgentIdentities(readStdin());
  } catch (err) {
    errors.push(`git.agentIdentities on stdin is unparseable: ${err.message}`);
  }

  for (const [slug, entry] of Object.entries(identities)) {
    for (const [leaf, value] of Object.entries(entry)) {
      if (!LEAF_KEYS.includes(leaf)) {
        errors.push(`git.agentIdentities."${slug}" has an unknown leaf "${leaf}" — expected one of ${LEAF_KEYS.join(', ')}`);
        continue;
      }
      if (!LEAF_PATTERNS[leaf].test(value)) {
        errors.push(`git.agentIdentities."${slug}".${leaf} value ${JSON.stringify(value)} violates its declared entryPattern`);
      }
    }
  }

  // A bare base is the documented no-opt-in state: every tier collapses to the ambient (human)
  // identity, so nothing below can virtualize anything.
  const bare = name === undefined && email === undefined;

  // ...but "no identity" is not "no configuration": a base may pin the signing posture without
  // pinning a name, so the NOTE must not say "nothing to verify" and must keep that posture.
  const postureOnly = bare && ['commit.gpgsign', 'user.signingkey', 'gpg.format', 'tag.gpgsign'].some((k) => config.has(k));

  if (!baseIsCoherent) {
    // no derived findings — see baseIsCoherent above
  } else if (bare) {
    notes.push(
      postureOnly
        ? `no bot identity configured — all tiers run under the ambient (human) identity, by design; the base still pins the signing posture (${posture}), which applies to every commit routed through it, sub-agents included`
        : 'no bot identity configured — all tiers run under the ambient (human) identity, by design; nothing to verify',
    );
    if (Object.keys(identities).length) {
      warns.push(
        `git.agentIdentities has ${Object.keys(identities).length} entr(y/ies) but git.cmd is bare — the map is INERT WITHOUT THE OPT-IN: no agent identity will be applied`,
      );
    }
  } else {
    const subaddressable = canSubaddress(email ?? '');
    const sharing = planned.filter((slug) => !identities[slug]?.botEmail);
    if (!subaddressable && sharing.length) {
      notes.push(
        `the base email ${email} cannot subaddress (a *.noreply.github.com domain, or a local part that already carries a "+") — ${sharing.length} agent(s) share it verbatim and attribution rides on the display name; give one its own address with an explicit git.agentIdentities[<agent>].botEmail`,
      );
    }

    for (const [slug, entry] of Object.entries(identities)) {
      if (!entry.signingKey) continue;
      if (gpgsign !== undefined && !isTrue(gpgsign)) {
        warns.push(
          `git.agentIdentities."${slug}".signingKey is set under a commit.gpgsign=${gpgsign} base — it SELECTS a key, it does not ENABLE signing, so it is deliberately inert: do not expect signed sub-agent commits`,
        );
      } else if (isTrue(gpgsign) && gpgFormat === 'ssh' && looksLikeKeyId(entry.signingKey)) {
        warns.push(
          `git.agentIdentities."${slug}".signingKey looks like an OpenPGP key id (${entry.signingKey}) but the base pins gpg.format=ssh — the ssh signer will be handed a value it cannot use`,
        );
      } else if (isTrue(gpgsign) && gpgFormat === 'openpgp' && looksLikePath(entry.signingKey)) {
        warns.push(
          `git.agentIdentities."${slug}".signingKey looks like a key path (${entry.signingKey}) but the base pins gpg.format=openpgp — the OpenPGP signer expects a key id`,
        );
      }
    }
  }

  // WARN, never ERROR — a key shape is a heuristic, and the signer is the real authority.
  if (isTrue(gpgsign) && signingKey) {
    if (gpgFormat === 'ssh' && looksLikeKeyId(signingKey)) {
      warns.push(
        `git.cmd's user.signingkey looks like an OpenPGP key id (${signingKey}) but the base pins gpg.format=ssh — the ssh signer will be handed a value it cannot use`,
      );
    } else if (gpgFormat === 'openpgp' && looksLikePath(signingKey)) {
      warns.push(
        `git.cmd's user.signingkey looks like a key path (${signingKey}) but the base pins gpg.format=openpgp — the OpenPGP signer expects a key id`,
      );
    }
  }

  // Only a base that actually ENABLES signing has a dangling tag-signing intent to report.
  if (isTrue(gpgsign) && !config.has('tag.gpgsign')) {
    warns.push(
      'git.cmd pins commit.gpgsign=true but leaves tag.gpgSign ambient — delegate agents never tag, so this is advisory, but a `git tag -s` elsewhere still rides the ambient signing config',
    );
  }

  // An entry matching neither a definition file nor a planned agent is PROBABLY a typo'd slug, but
  // a harness built-in has no definition file either — so absence is not proof, and this fails open.
  const onDisk = agentSlugsOnDisk(args.agentsDir);
  if (onDisk) {
    for (const slug of Object.keys(identities)) {
      if (planned.includes(slug) || onDisk.has(slug)) continue;
      warns.push(
        `git.agentIdentities."${slug}" matches no agent definition and no agent planned in this run — likely a typo'd slug; if it is a harness built-in (which has no definition file), the entry applies only on a run that plans it`,
      );
    }
  }

  if (baseIsCoherent && !bare) {
    const noDisplayName = planned.filter((slug) => !identities[slug]?.botName && !hasDisplayName(args.agentsDir, slug));
    if (noDisplayName.length) {
      notes.push(
        `no identity.displayName for: ${noDisplayName.join(', ')} — the title-cased slug is used as the display name (the definition file is absent, as for a harness built-in, or the field is unset)`,
      );
    }
  }

  // --- report -----------------------------------------------------------------

  for (const e of errors) console.error(`ERROR: ${e}`);
  for (const w of warns) console.log(`WARN: ${w}`);
  for (const n of notes) console.log(`NOTE: ${n}`);

  if (errors.length) {
    console.error(
      `identity: preflight FAILED (${errors.length} error(s), ${warns.length} warning(s)). STOP: do not spawn agents. Fix the identity configuration and re-run the preflight — never improvise an identity or fall back to the ambient one.`,
    );
    process.exit(1);
  }

  // The bare arm reports the ambient identity — but never at the cost of the posture: a base that
  // pins signing without pinning a name still governs every commit routed through it.
  const mainTier = bare
    ? postureOnly
      ? `ambient (human), ${posture}`
      : 'ambient (human)'
    : `${name} <${email}> (${posture})`;
  const subTier = bare
    ? 'ambient (no virtualization)'
    : canSubaddress(email ?? '')
      ? `derived (+<slug> subaddressing), ${planned.length} planned`
      : `derived (shared base email; display names distinguish), ${planned.length} planned`;
  console.log(`identity: main-bot = ${mainTier}; sub-agents = ${subTier}; human = untouched`);
  console.log(`identity: preflight PASSED (${warns.length} warning(s), ${notes.length} note(s)).`);
  process.exit(0);
}

main();
