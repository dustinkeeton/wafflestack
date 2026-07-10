#!/usr/bin/env node
//
// identity.mjs — verify the git identities a delegate run will commit under, before it
// spawns anything.
//
// Delegate has gates for plan confirmation, pre-push approval, and checkpoint validity,
// but nothing ever proved the *identity* config coherent. A half-configured identity does
// not fail loudly: it silently falls back to whatever ambient git config the machine has,
// so bot commits land under the human's name, or get signed with the human's key, or hang
// a non-interactive agent on a prompting signer. This script turns that silent default
// into an exit code.
//
// It validates three tiers, all of which are static properties of the resolved config:
//   * human      — bare git; never overridden by anything the toolkit renders
//   * main-agent — the orchestrator's own commits, routed through the resolved git.cmd
//   * sub-agent  — each spawned agent's commits, routed through the per-agent command
//                  derived from git.cmd + the agentIdentities overrides
//
// It validates CONFIGURATION, not runtime process identity: it proves the right identity
// WILL apply to each tier's commits, not who is at the keyboard.
//
// Dependency-free on purpose: it runs inside a consuming repo that may not have any npm
// deps installed, so it uses Node built-ins only. Non-markdown skill files are copied
// verbatim by the renderer (no placeholder substitution), so the caller passes the
// resolved values in as arguments and on stdin.
//
// Usage:
//   node identity.mjs --git-cmd '<resolved git.cmd>' \
//     [--agents-dir <dir>] --agents <slug,slug,...> <<'WAFFLE_AGENT_IDENTITIES'
//   <resolved git.agentIdentities, as YAML>
//   WAFFLE_AGENT_IDENTITIES
//
// Findings print one per line, prefixed ERROR: / WARN: / NOTE:.
//   ERROR — incoherent config: it will break, hang, or misattribute a cryptographic
//           identity — including an identity-bearing command that leaves the signing posture
//           unpinned, which is the #158 bug class above. Exit 1. The caller must STOP the run
//           and report verbatim; it must never improvise an identity or fall back to the
//           ambient one.
//   WARN  — coherent, but expressed intent that cannot take effect, or almost certainly
//           not what the user meant. Logged; the run proceeds.
//   NOTE  — informational. A bare git.cmd is a NOTE, never an error: "no bot identity" is
//           a legitimate documented state, not a misconfiguration.
//
// Exit 0 = pass (warnings allowed). Exit 1 = any ERROR — identical semantics to
// checkpoint.mjs.

import fs from 'node:fs';
import path from 'node:path';

const USAGE =
  "Usage: node identity.mjs --git-cmd '<resolved git.cmd>' [--agents-dir <dir>] --agents <slug,slug,...>  (agentIdentities YAML on stdin)";

// Kept byte-identical to the `entryPatterns` guards declared for git.agentIdentities in
// stacks/orchestration/stack.yaml (and github-workflow's identical declaration). Those
// guards run at render time; re-checking here is defense in depth — a hand-edited render
// dodges the render-time guard entirely, and this script is what the run actually trusts.
const LEAF_PATTERNS = {
  botName: /^(?!.*\$\{\{)[A-Za-z0-9._[\]-]+(?: [A-Za-z0-9._[\]-]+)*$/,
  botEmail: /^(?!.*\$\{\{)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
  signingKey: /^(?!.*\$\{\{)[A-Za-z0-9._\/~+:-]+$/,
};
const LEAF_KEYS = Object.keys(LEAF_PATTERNS);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// git.cmd tokenizer
//
// The rendered command is a flat prefix — `git` followed by `-c key=value` pairs (and possibly
// other flags). Double quotes group a spaced value. Single quotes are NOT handled — and cannot
// reach this tokenizer through a render: `git.cmd` declares an allowlist `pattern:` in both
// stacks (#254) that rejects `'`, backtick, `$`, `;`, `&`, `|`, `<`, `>`, `\` and newlines at
// render time, so the caller's `--git-cmd '…'` shell literal holds by construction — see
// SKILL.md's "Identity preflight". (A hand-run invocation can still pass anything; a `'` is then
// just an ordinary character to this tokenizer.) An unterminated double quote, or a stray bare
// word, means the value was never quoted in the first place and git would word-split it — that
// is an ERROR, not a guess.
// ---------------------------------------------------------------------------

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
  // Keys whose last occurrence carried no `=`. git reads those as the literal string "true",
  // which is a valid value for a flag and a broken one for an identity — the caller needs to
  // tell `-c user.name` (⇒ "true") apart from `-c user.name=true`.
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

// git's boolean vocabulary (`git config --bool`). A `-c key` with no `=` is `true`, which
// parseGitCmd already normalises. Anything outside this set is not "false" — it is a value git
// rejects at commit time, which is a different (and louder) finding than "signing is off".
const GIT_BOOLEANS = ['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'];
const isBoolean = (v) => v !== undefined && GIT_BOOLEANS.includes(String(v).toLowerCase());
const isTrue = (v) => v !== undefined && ['true', 'yes', 'on', '1'].includes(String(v).toLowerCase());

// ---------------------------------------------------------------------------
// agentIdentities: a restricted two-level YAML-subset parser
//
// The caller pipes in `git.agentIdentities` exactly as the renderer formatted it —
// YAML.stringify with lineWidth 0, i.e. `{}` when empty, otherwise `slug:` keys with
// two-space-indented `botName` / `botEmail` / `signingKey` scalar leaves. Nothing richer
// is in scope (checkpoint.mjs's hand-rolled JSON-Schema subset is the same precedent).
//
// The subset is SOUND because the split is on the FIRST colon, which is always the key/value
// separator: a leaf name is one of three literals, none containing a colon. Colons *inside* a
// value are therefore harmless — and they do occur, since the signingKey charset admits ":".
// Anything this parser does not recognise throws, and the caller turns that into an ERROR
// verdict: a parse surprise is fail-safe, never a silent skip.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Agent definition lookup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Identity shape helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

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

  // Tri-state, never binary: `unsigned` is a claim about the config, so it may only be printed when
  // the config actually says so. The AMBIENT arm is unreachable while an unpinned posture is an
  // ERROR below — it stands so that downgrading that taxonomy can never silently resurrect a
  // verdict line that guesses in the reassuring direction.
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
  // PRESENCE IS NOT A VALUE. The two checks above ask only whether each half of the identity was
  // set at all; `-c user.name=` and a valueless `-c user.name` both satisfy them and both produce a
  // broken author. Same class as the empty user.signingkey below — git only objects at commit time
  // (or, worse, does not object at all), so the gate has to object now.
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
  // The #158 bug class this gate exists to kill: an identity-bearing command that never pins the
  // signing posture leaves it AMBIENT. On a machine whose ~/.gitconfig sets commit.gpgsign=true,
  // every bot commit is then signed with the human's key — or hangs a non-interactive agent on a
  // prompting signer. The recipe owns the posture (see git.cmd's description in stack.yaml): pin
  // it false for the canonical unsigned bot, or true alongside user.signingkey + gpg.format.
  // A BARE git.cmd is exempt — no identity is claimed, so there is no posture to own.
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

  // Everything below derives FROM the base command. If the base is already incoherent, any
  // derived finding is noise about a value that will never be used — the base errors are
  // the report. Leaf-shape validation still runs: it is independent of the base.
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

  // A bare base is the documented no-opt-in state: every tier collapses to the ambient
  // (human) identity, by design. Rule 1 of "Per-agent commit identity" short-circuits
  // there, so nothing below can virtualize anything.
  const bare = name === undefined && email === undefined;

  // ...but "no identity" is not "no configuration". A base may pin the signing posture and the key
  // without pinning a name or an email, and rule 4 hands those flags verbatim to every tier. Such a
  // command is bare of IDENTITY and anything but inert, so the NOTE must not say "nothing to verify"
  // and the verdict must not drop the posture the lines above just computed.
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

  // The same key-shape-vs-gpg.format heuristic the per-agent leaves get above, pointed at the key
  // every signing repo actually sets: the base one. A per-agent signingKey leaf is the rare case.
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

  // Only a base that actually ENABLES signing has expressed a tag-signing intent to leave
  // dangling. The canonical `commit.gpgsign=false` recipe never asked for signed tags, so a WARN
  // there surfaces nothing and only teaches readers to skim past WARN lines.
  if (isTrue(gpgsign) && !config.has('tag.gpgsign')) {
    warns.push(
      'git.cmd pins commit.gpgsign=true but leaves tag.gpgSign ambient — delegate agents never tag, so this is advisory, but a `git tag -s` elsewhere still rides the ambient signing config',
    );
  }

  // A map entry for an agent that exists but is not in this run is fine and silent. An entry that
  // matches neither a definition file nor a planned agent is PROBABLY a typo'd slug — but a
  // harness built-in has no definition file either, so absence is not proof. When the definition
  // set is unknowable (no --agents-dir, or an unreadable one) we say nothing at all: same policy
  // as hasDisplayName below, which also fails open rather than assert on missing evidence.
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
