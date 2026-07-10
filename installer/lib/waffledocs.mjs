/**
 * Generate the default `.waffle/` overview docs from the computed render selection:
 *
 *   .waffle/CHEATSHEET.md   one-line cheat sheet of user-invocable skills (slash commands)
 *   .waffle/cheatsheet.html branded, self-contained web page of the same
 *   .waffle/TEAM.md         one-page introduction to the installed agents
 *   .waffle/team.html       branded, self-contained web page of the same
 *
 * These are emitted through render's `emit()` choke point, so they are lock-tracked,
 * `doctor`-drift-checked, pruned when a later render no longer produces them, and refreshed
 * on every render — the "updated when necessary" behaviour falls out of the render lifecycle.
 *
 * The Markdown is the agent-readable source of truth (plain, scannable body). The HTML pages
 * are the visual one-pagers — branded chrome (per `assets/README.md`: waffle glyph +
 * Golden/Syrup/Cocoa palette) around selectable, searchable, reflowing text. They carry a
 * hybrid font strategy: Google Fonts `<link>` tags load the brand type (Baloo 2 / Outfit /
 * JetBrains Mono) as progressive enhancement, with a brand-styled system-font stack as the
 * CSS fallback so the file renders correctly fully offline (fonts are the only external
 * reference — no external images, scripts, or stylesheets). Both formats are assembled purely
 * from item frontmatter (skills: `user-invocable` / `argument-hint` / `description`; agents:
 * `name` / `description` / `skills`), substituted with the same resolver render uses, so a
 * `{{project.name}}` in a description reads the same as in the rendered item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, lookupPath } from './util.mjs';
import { substitute } from './template.mjs';
import { makeResolver } from './project.mjs';
import { resolveAgentSkill } from './refs.mjs';

const CHEATSHEET_MD = path.join('.waffle', 'CHEATSHEET.md');
const CHEATSHEET_HTML = path.join('.waffle', 'cheatsheet.html');
const TEAM_MD = path.join('.waffle', 'TEAM.md');
const TEAM_HTML = path.join('.waffle', 'team.html');
const AVATARS_MD = path.join('.waffle', 'AVATARS.md');
const AVATARS_DIR = path.join('.waffle', 'avatars');

/** Rendered avatar file for an agent — the default `identity.avatar` when none is authored. */
const avatarRel = (name) => path.join(AVATARS_DIR, `${name}.svg`);

// Standalone avatar files are sized for a Gravatar upload (Gravatar serves down from the
// source), not for the 26–56px inline uses on the HTML one-pagers.
const AVATAR_FILE_PX = 512;

// Description substitution never enforces `pattern:`/`entryPatterns:` guards (those police
// config values spliced into structured contexts, not prose) — pass empty guards.
const NO_GUARDS = { patterns: new Map(), entryPatterns: new Map() };

/**
 * A skill is a slash command unless it explicitly opts out with `user-invocable: false`.
 * An absent key defaults to invocable — matching harness behaviour, so a skill that only
 * sets `disable-model-invocation: true` (e.g. `audit`) still shows on the cheat sheet.
 */
function isUserInvocable(data) {
  return data['user-invocable'] !== false;
}

// ---- Per-agent commit-email derivation --------------------------------------------------
//
// KEEP IN LOCKSTEP with `stacks/orchestration/skills/delegate/SKILL.md` → "Per-agent commit
// identity", rules 1–3, and with the github-workflow stack's setup note. The delegate
// orchestrator derives an agent's git author from prose at spawn time; these helpers derive the
// same address here so `.waffle/AVATARS.md` can name the EXACT email a human must register on
// Gravatar. Two derivations of one rule is the maintenance hazard — a change on either side is a
// change on both, and `installer/test/installer.test.mjs` pins the three documented examples.

/** A resolved `user.email=` value, in the shapes `git.cmd` can legally carry it. */
const USER_EMAIL_RE = /(?:^|\s)-c\s+user\.email=(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** Conservative address check — an unresolved `{{git.botEmail}}` must never pass as an email. */
const EMAIL_SHAPE_RE = /^[^\s@{}"'`]+@[^\s@{}"'`]+\.[^\s@{}"'`]+$/;

/**
 * The base committer email a project's resolved `git.cmd` sets, or `null` when it sets none —
 * rule 1: a bare `git` (or any command without `-c user.email=`) means the project has NOT opted
 * into a bot identity, so nothing is virtualized. An unresolved placeholder (a `git.cmd`
 * referencing a `{{git.botEmail}}` no selected stack declares) yields `null` too: the manifest
 * must say "not configured" rather than print a literal `{{…}}` as an address to register.
 */
export function extractBaseEmail(gitCmd) {
  const m = USER_EMAIL_RE.exec(String(gitCmd ?? ''));
  if (!m) return null;
  const value = m[1] ?? m[2] ?? m[3] ?? '';
  return EMAIL_SHAPE_RE.test(value) ? value : null;
}

/**
 * The commit email an agent with slug `slug` will author under, given the project's base email —
 * rule 2: `+<slug>` is inserted immediately before the `@` (`bot@wafflenet.io` →
 * `bot+lead-engineer@wafflenet.io`), UNLESS the base cannot subaddress, in which case it is used
 * **verbatim**. It cannot subaddress when either:
 *   - the domain is `*.noreply.github.com` — that domain routes only the `<id>+<username>@`
 *     shape, so a second `+` segment resolves to nothing at all; or
 *   - the local part already carries a `+` (`12345+wafflebot@…`, `bot+ci@…`) — the tag is spent.
 * Returns `null` for a null base (no bot identity). An explicit
 * `git.agentIdentities[slug].botEmail` override is applied verbatim by the CALLER (rule 3) — it
 * never flows through here.
 */
export function deriveAgentEmail(baseEmail, slug) {
  if (!baseEmail) return null;
  const at = baseEmail.lastIndexOf('@');
  if (at <= 0) return baseEmail;
  const local = baseEmail.slice(0, at);
  const domain = baseEmail.slice(at + 1);
  if (/(^|\.)noreply\.github\.com$/i.test(domain)) return baseEmail;
  if (local.includes('+')) return baseEmail;
  return `${local}+${slug}@${domain}`;
}

/** `lead-engineer` → `Lead Engineer`. The display-name default when no `identity.displayName`. */
function titleCaseSlug(slug) {
  return String(slug)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Build the doc payloads for the current selection. Returns `[{ rel, content }]` — the
 * caller emits each. A doc pair is omitted when its set is empty (no user-invocable skills
 * → no cheat sheet; no agents → no team page), so it prunes cleanly if a later selection
 * drops every item of that kind. Substitution problems (should not occur on a validated
 * toolkit, since descriptions are policed by `validate`) are pushed onto `errors`.
 */
export function generateWaffleDocs({ toolkit, project, selection, errors = [] }) {
  const primaryTarget = project.targets[0] ?? 'claude';
  const resolvers = new Map();
  const resolverFor = (stack) => {
    if (!resolvers.has(stack.name)) resolvers.set(stack.name, makeResolver(stack, project.values, primaryTarget));
    return resolvers.get(stack.name);
  };
  const sub = (stack, text, ctx) =>
    substitute(String(text ?? ''), resolverFor(stack), stack.declared, errors, ctx, NO_GUARDS).trim();

  const commands = [];
  const agents = [];
  for (const { stack, kind, item } of selection.items) {
    if (kind === 'skills') {
      const { data } = parseFrontmatter(fs.readFileSync(path.join(item.dir, 'SKILL.md'), 'utf8'));
      if (!isUserInvocable(data)) continue;
      commands.push({
        // `ref` is the skill's item name (its dir name) — the key an agent's frontmatter
        // `skills:` list resolves against, so the skill→agents reverse map can join on it.
        ref: item.name,
        name: data.name ?? item.name,
        argumentHint:
          data['argument-hint'] != null
            ? sub(stack, data['argument-hint'], `waffledocs:skills/${item.name}#argument-hint`)
            : '',
        description: sub(stack, data.description, `waffledocs:skills/${item.name}#description`),
      });
    } else if (kind === 'agents') {
      agents.push({
        name: item.data.name ?? item.name,
        // The agent's SLUG — its definition filename, which is the key the delegate orchestrator
        // plus-addresses with and `git.agentIdentities` is keyed by. `validateStack` pins
        // `data.name` to the filename when both exist, so today they agree; keep them separate
        // anyway, because the identity derivation is defined on the slug.
        slug: item.name,
        // `stackName` is retained so agent `skills:` refs resolve preferring their own stack
        // (matching render's own resolution) when building the cheatsheet reverse map.
        stackName: stack.name,
        description: sub(stack, item.data.description, `waffledocs:agents/${item.name}#description`),
        skills: Array.isArray(item.data.skills) ? item.data.skills : [],
        // The validated `identity:` block (#156/#157), passed through by `renderAgent` verbatim.
        identity: item.data.identity ?? null,
      });
    }
  }
  // Alphabetical, so output is deterministic (stable lock hash) regardless of stack order.
  commands.sort((a, b) => a.name.localeCompare(b.name));
  agents.sort((a, b) => a.name.localeCompare(b.name));

  // Skill→agents reverse map: for each installed agent, resolve every granted skill ref
  // (leniently — an unresolved/ambiguous name is silently skipped, as elsewhere) and index
  // the granting agents by the resolved skill's item name, so the cheatsheet can badge each
  // skill block with the agents that hold it. Deterministic: agents are already sorted, so
  // each ref's agent set iterates in stable alphabetical order.
  const agentsByRef = new Map();
  for (const a of agents) {
    for (const skillName of a.skills) {
      const resolved = resolveAgentSkill(toolkit, skillName, a.stackName);
      if (!resolved) continue;
      if (!agentsByRef.has(resolved.name)) agentsByRef.set(resolved.name, []);
      const list = agentsByRef.get(resolved.name);
      if (!list.includes(a.name)) list.push(a.name);
    }
  }
  const agentByName = new Map(agents.map((a) => [a.name, a]));

  const docs = [];
  if (commands.length) {
    docs.push({ rel: CHEATSHEET_MD, content: cheatsheetMarkdown(commands, toolkit.name) });
    docs.push({ rel: CHEATSHEET_HTML, content: cheatsheetHtml(commands, toolkit.name, { agentsByRef, agentByName }) });
  }
  if (agents.length) {
    docs.push({ rel: TEAM_MD, content: teamMarkdown(agents, toolkit.name) });
    docs.push({ rel: TEAM_HTML, content: teamHtml(agents, toolkit.name) });
    // Per-agent avatar files (#157) — one static SVG each, plus the manifest pairing every file
    // with the exact commit email to register on Gravatar. Emitted through the same `emit()`
    // choke point as the docs above, so they are lock-tracked, drift-checked and pruned when a
    // later selection drops every agent.
    for (const a of agents) {
      docs.push({ rel: avatarRel(a.name), content: `${agentAvatarSvg(a.name, a.skills.length, { px: AVATAR_FILE_PX, animated: false })}\n` });
    }
    docs.push({ rel: AVATARS_MD, content: avatarsMarkdown(agents, toolkit.name, resolveGitIdentity({ project, selection, resolverFor })) });
  }
  return docs;
}

/**
 * The project's resolved bot-identity inputs, exactly as the delegate orchestrator sees them at
 * spawn time: the substituted `git.cmd` and the `git.agentIdentities` override map.
 *
 * `git.cmd` is resolved through the SAME resolver render uses — the first selected stack (in
 * stable alphabetical order) that declares the key, so nested `{{git.botEmail}}` expands from
 * project config exactly as it does in that stack's rendered skills. A stack that declares
 * `git.cmd` but not the identity keys leaves an unresolvable `{{git.botEmail}}` verbatim (the
 * documented rule-2 hazard) — `extractBaseEmail` then reports "no bot identity", which is the
 * honest reading: no address to register. Substitution errors are swallowed into a throwaway
 * array: this is a *report* of the project's config, and a literal placeholder here must not
 * fail the render that the skills themselves render fine under.
 */
function resolveGitIdentity({ project, selection, resolverFor }) {
  const stacks = [...new Map(selection.items.map(({ stack }) => [stack.name, stack])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const gitStack = stacks.find((s) => s.config?.['git.cmd'] !== undefined);
  let cmd = null;
  if (gitStack) {
    cmd = substitute('{{git.cmd}}', resolverFor(gitStack), new Set(['git.cmd']), [], 'waffledocs:avatars#git.cmd', NO_GUARDS).trim();
  } else {
    // No selected stack declares `git.cmd`; a project may still set the value. Nothing nested to
    // expand in that case — no stack defaults are in play to expand it against.
    const raw = lookupPath(project.values, 'git.cmd');
    if (typeof raw === 'string') cmd = raw.trim();
  }
  const overrides = lookupPath(project.values, 'git.agentIdentities');
  return {
    cmd,
    baseEmail: extractBaseEmail(cmd),
    overrides: overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {},
  };
}

const GENERATED_BANNER =
  '<!-- Generated by `wafflestack render` from the installed selection — do not edit; re-render to update. -->';

/** Collapse whitespace, take the first sentence, cap length at a word boundary with `…`. */
function oneLiner(text, maxLen) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  let s = flat;
  const m = /^(.*?[.!?])(\s|$)/.exec(flat);
  if (m && m[1].length >= 24) s = m[1];
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen - 1).replace(/\s+\S*$/, '').trimEnd()}…`;
  }
  return s;
}

function cheatsheetMarkdown(commands, toolkitName) {
  const lines = [
    GENERATED_BANNER,
    '',
    '# Skills cheat sheet',
    '',
    `Slash commands available in this repo, assembled from the installed **${toolkitName}** skills.`,
    'Type `/<name>` in your agent to run one. Regenerated on every `wafflestack render`.',
    '',
  ];
  for (const c of commands) {
    const hint = c.argumentHint ? ` \`${c.argumentHint.replace(/`/g, '')}\`` : '';
    lines.push(`- **\`/${c.name}\`**${hint} — ${oneLiner(c.description, 200)}`);
  }
  lines.push('', `_${commands.length} command${commands.length === 1 ? '' : 's'} · generated — do not edit._`, '');
  return lines.join('\n');
}

function teamMarkdown(agents, toolkitName) {
  const lines = [
    GENERATED_BANNER,
    '',
    '# Team',
    '',
    `Specialist agents installed in this repo, assembled from the **${toolkitName}** selection.`,
    "Delegate to one by name (via the Task tool or your harness's subagent mechanism). Each agent",
    'lists the skills it is granted — its hand-off points. Regenerated on every `wafflestack render`.',
    '',
  ];
  for (const a of agents) {
    lines.push(`## \`${a.name}\``, '', a.description);
    if (a.skills.length) {
      lines.push('', `**Skills / hand-offs:** ${a.skills.map((s) => `\`${s}\``).join(', ')}`);
    }
    lines.push('');
  }
  lines.push(`_${agents.length} agent${agents.length === 1 ? '' : 's'} · generated — do not edit._`, '');
  return lines.join('\n');
}

/**
 * `.waffle/AVATARS.md` (#157) — the reproducibility artifact for per-agent avatars on GitHub
 * commit views. It pairs each agent's generated avatar file with the EXACT commit email that
 * agent authors under, and spells out the manual Gravatar procedure that makes GitHub render it.
 *
 * It deliberately never claims avatars appear on their own. GitHub renders a Gravatar for a
 * commit email that belongs to no GitHub account; registering that email on Gravatar is a manual,
 * external step, and Gravatar's own upload rules are external-service behaviour. What this file
 * guarantees is that the email/file pairs below are the correct INPUTS to that procedure.
 */
function avatarsMarkdown(agents, toolkitName, git) {
  const configured = Boolean(git.baseEmail);
  const rows = agents.map((a) => {
    const override = (git.overrides ?? {})[a.slug] ?? {};
    const email = configured ? (override.botEmail ?? deriveAgentEmail(git.baseEmail, a.slug)) : null;
    return {
      name: a.name,
      displayName: override.botName ?? a.identity?.displayName ?? titleCaseSlug(a.slug),
      // An authored `identity.avatar` wins over the generated default — the identity metadata is
      // the avatar reference; the generated file is only its deterministic default.
      avatar: a.identity?.avatar ?? avatarRel(a.name),
      authored: Boolean(a.identity?.avatar),
      flavor: agentFlavor(a.name),
      email,
      overridden: Boolean(override.botEmail),
    };
  });
  // A base that cannot subaddress hands every agent the same address (delegate rule 2), so the
  // avatar can only ever be per-*project*, not per-agent, until overrides give agents own emails.
  const derived = rows.filter((r) => !r.overridden).map((r) => r.email);
  const sharedEmail = configured && derived.length > 1 && new Set(derived).size === 1;

  const lines = [
    GENERATED_BANNER,
    '',
    '# Agent avatars',
    '',
    `A distinct avatar per installed **${toolkitName}** agent, for the places an agent's identity shows up:`,
    'the `.waffle/team.html` roster, and — via the procedure below — **GitHub commit views**.',
    'Regenerated on every `wafflestack render`.',
    '',
    '## How GitHub picks a commit avatar',
    '',
    'GitHub resolves a commit avatar from the commit **author email**, not from anything in the commit',
    'message or the repo:',
    '',
    '1. If the email is registered on a GitHub account, that account\'s single avatar is shown, and the',
    '   commit links to the profile.',
    '2. Otherwise, if the email has a **Gravatar**, GitHub shows the Gravatar.',
    '3. Otherwise, the default gray Octocat.',
    '',
    'Each agent commits under its own author email (see the table), and those',
    'plus-addressed emails belong to no GitHub account — so they land in case 2. **Registering each one',
    'on Gravatar is a manual, one-time step; nothing in this toolkit performs it, and nothing here can',
    'verify it.** Until you do, agent commits show the gray default. Note also that GitHub caches the',
    'email→avatar association, so a freshly-registered Gravatar can take a while to appear on existing',
    'commits — verify with a **new** commit (see "Smoke test").',
    '',
    '> **Do not** add these plus-addresses as secondary emails on the bot\'s GitHub account. That links',
    '> every agent\'s commits to that one account and shows its one avatar for all of them — the exact',
    '> opposite of per-agent distinction. Leave them unregistered on GitHub; register them on Gravatar.',
    '',
    '## The agents',
    '',
  ];

  // Footnote markers are fixed per meaning, not positional — so a marker means the same thing
  // whether or not the project has a bot identity configured.
  const AUTHORED = '†';
  const OVERRIDDEN = '‡';
  if (configured) {
    lines.push('| Agent | Display name | Syrup | Avatar | Commit author email |', '| --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const em = `\`${r.email}\`${r.overridden ? ` ${OVERRIDDEN}` : ''}`;
      lines.push(`| \`${r.name}\` | ${r.displayName} | ${r.flavor} | \`${r.avatar}\`${r.authored ? ` ${AUTHORED}` : ''} | ${em} |`);
    }
  } else {
    lines.push(
      '| Agent | Display name | Syrup | Avatar |',
      '| --- | --- | --- | --- |',
      ...rows.map((r) => `| \`${r.name}\` | ${r.displayName} | ${r.flavor} | \`${r.avatar}\`${r.authored ? ` ${AUTHORED}` : ''} |`),
    );
  }
  lines.push('');
  if (rows.some((r) => r.authored)) {
    lines.push(`${AUTHORED} authored \`identity.avatar\` in the agent definition, not the generated default.`);
  }
  if (rows.some((r) => r.overridden)) {
    lines.push(`${OVERRIDDEN} set verbatim by a \`git.agentIdentities.<agent>.botEmail\` override.`);
  }
  if (rows.some((r) => r.authored || r.overridden)) lines.push('');
  if (!configured) {
    lines.push(
      '**No commit emails yet — this project has not opted into a bot identity.** The resolved `git.cmd`',
      `is \`${git.cmd || 'git'}\`, which yields no usable \`user.email\`, so agents commit under *your own* git`,
      'config and there is no per-agent address to give a Gravatar. Opt in by setting `git.botName` /',
      '`git.botEmail` and pointing `git.cmd` at them (see the github-workflow stack\'s setup note), then',
      're-render: the derived per-agent emails appear here.',
      '',
    );
  }

  if (sharedEmail) {
    lines.push(
      `> **Every agent above shares one address** (\`${git.baseEmail}\`). A \`*.noreply.github.com\` base — or any`,
      '> base whose local part already carries a `+` — cannot subaddress, so the delegate skill uses it',
      '> **verbatim** rather than mangling it into an address that routes nowhere. Agents are then distinct by',
      '> **display name** only, and one Gravatar covers them all. To give an agent its own address (and so its',
      '> own avatar), add an explicit `git.agentIdentities.<agent>.botEmail` to your project config.',
      '',
    );
  }

  if (configured && !sharedEmail) {
    lines.push(
      '## Registering the avatars (manual, one-time)',
      '',
      'Each address must receive mail for Gravatar to verify it. A plus-address delivers to its base inbox on',
      'any provider that supports subaddressing (Gmail, Fastmail, Proton, most self-hosted setups) — so all of',
      `the addresses above land in \`${git.baseEmail}\`. Then:`,
      '',
      '1. **Convert each avatar to a raster image.** Gravatar accepts PNG/JPG/GIF, not SVG. One line, any one of:',
      '',
      '   ```bash',
      `   rsvg-convert -w 512 -h 512 ${avatarRel('<agent>')} > <agent>.png    # librsvg`,
      `   npx --yes svgexport ${avatarRel('<agent>')} <agent>.png 512:512     # node, no install`,
      `   magick -background none ${avatarRel('<agent>')} -resize 512x512 <agent>.png   # ImageMagick`,
      '   ```',
      '',
      '2. **Sign in to <https://gravatar.com>** with the base address (one account covers every agent).',
      '3. **Add each agent\'s commit email** to that account and complete the verification mail.',
      '4. **Upload that agent\'s PNG** and assign it to that address. Keep the rating at **G** — GitHub only',
      '   displays G-rated images.',
      '',
      '## Smoke test',
      '',
      'Gravatar-side details (upload formats, the multi-email verification flow) are external-service behaviour',
      'and can change, and GitHub caches the email→avatar association. So verify end-to-end rather than trusting',
      'this document — author one commit as an agent and look at it on GitHub:',
      '',
      '```bash',
      `git -c user.name="${rows[0].displayName}" -c user.email=${rows[0].email} \\`,
      '  commit --allow-empty -m "chore: avatar smoke test"',
      'git push',
      '```',
      '',
      'Open the commit on GitHub: the avatar beside the author should be that agent\'s waffle, and the name',
      'should **not** link to a user profile (it is an unregistered address — that is what puts it on the',
      'Gravatar path). A gray Octocat means the Gravatar is not yet registered, not yet propagated, or rated',
      'above G. Existing commits may keep the old avatar until GitHub\'s cache turns over.',
      '',
    );
  }

  lines.push(
    '## Notes',
    '',
    '- Attribution is per agent **type**, not per spawn: two parallel instances of one agent share an identity.',
    `- The avatar files are generated — a hand edit is drift, and \`wafflestack doctor\` will say so. Each is a`,
    '  pure function of the agent name (skin, syrup, expression) and its granted-skill count (the dark pockets).',
    '- `identity.avatar` in an agent definition overrides the generated default with a repo-relative path or an',
    '  `https://` URL. It is a *reference* carried in the agent\'s identity metadata; nothing uploads it for you.',
    '',
    `_${agents.length} agent${agents.length === 1 ? '' : 's'} · generated — do not edit._`,
    '',
  );
  return lines.join('\n');
}

// ---- Branded HTML one-pagers -----------------------------------------------------------
//
// Self-contained standalone documents: the ONLY external references are the Google Fonts
// `<link>` tags (Baloo 2 / Outfit / JetBrains Mono — the brand type stack), included as
// progressive enhancement. A brand-styled system-font stack is the CSS fallback, so each
// page renders correctly with zero network access. Palette + type per assets/README.md; dark
// is the brand default (BG #1A0D03), with a warm-paper light theme via `prefers-color-scheme`.

// Brand palette anchors (assets/README.md). The remaining shades live inline in the CSS.
const GOLDEN = '#F5C752';
const SYRUP = '#F08A1D';

// Font stacks: brand face first (loaded via the Google Fonts link), then an intentional
// system-font fallback so an offline page still reads on-brand.
const DISPLAY = "'Baloo 2', 'Trebuchet MS', system-ui, sans-serif";
const BODY = "'Outfit', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// The flat waffle mark (assets/wafflestack-flat.svg) as a standalone inline SVG glyph — an
// inline element, not an external reference. `www.w3.org` is the SVG namespace, not a fetch.
function waffleGlyphSvg(px) {
  const pockets = [16.75, 35.5, 54.25]
    .flatMap((x) => [16.75, 35.5, 54.25].map((y) => `<rect x="${x}" y="${y}" width="13" height="13" rx="4.5" fill="#DE8127"/>`))
    .join('');
  return (
    `<svg class="wd-glyph" width="${px}" height="${px}" viewBox="0 0 99 99" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" stroke-linejoin="round">` +
    '<rect x="22" y="22" width="70" height="70" rx="18" fill="#D0902B" stroke="#5B2B0E" stroke-width="6"/>' +
    '<rect x="14.5" y="14.5" width="70" height="70" rx="18" fill="#E4A93D" stroke="#5B2B0E" stroke-width="6"/>' +
    '<rect x="7" y="7" width="70" height="70" rx="18" fill="#F5C752" stroke="#5B2B0E" stroke-width="6.5"/>' +
    pockets +
    '</svg>'
  );
}

// ---- Per-agent waffle avatars ----------------------------------------------------------
//
// A branded waffle character generated per agent, entirely from the agent NAME (plus its
// installed-skill count) — no `Math.random`, no `Date`, no external asset. Rendered docs flow
// through `emit()` and are lock-tracked + doctor-drift-checked, so every trait MUST be a pure
// function of the name: same selection ⇒ byte-identical output.
//
// Character: a golden rounded-square waffle viewed straight-on, a 3×3 grid of pockets, a
// swoosh of orange syrup on top like a hairdo, and two pockets darkened as eyes. The skill
// count freckles the remaining pockets (capped at 7 = 9 pockets − 2 eyes).

// Brand cocoa is the default outline/ink; dark skins override it for legibility.
const AV_INK_DEFAULT = '#5B2B0E';
const AV_CREAM = '#FFF3DC'; // the eyes' sclera + the antenna bead

// Number formatter — integers stay bare, else 2 decimals trimmed. Keeps computed eye/syrup
// coordinates byte-stable across hosts (ported from the wafflebot reference generator).
const f2 = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));

// Skin "batter" tones, light → charcoal. Each carries its own `ink` and a matched
// `pocketLight` (empty squares) / `pocketDark` (skill squares) shade — precomputed from
// shade(fill, 0.90 | 0.80) so the table is literal and byte-stable. Charcoal is hand-tuned so
// its outline and pupils stay legible dark-on-dark.
const AV_SKINS = [
  { fill: '#F7D98B', ink: AV_INK_DEFAULT, pocketLight: '#DEC37D', pocketDark: '#C6AE6F' }, // pale
  { fill: GOLDEN, ink: AV_INK_DEFAULT, pocketLight: '#DDB34A', pocketDark: '#C49F42' }, // classic
  { fill: '#E4A94A', ink: AV_INK_DEFAULT, pocketLight: '#CD9843', pocketDark: '#B6873B' }, // honey
  { fill: '#C98A3C', ink: AV_INK_DEFAULT, pocketLight: '#B57C36', pocketDark: '#A16E30' }, // toasted
  { fill: '#8A5A26', ink: AV_INK_DEFAULT, pocketLight: '#7C5122', pocketDark: '#6E481E' }, // cocoa
  { fill: '#4A3A55', ink: '#2A2036', pocketLight: '#5A4769', pocketDark: '#352A40' }, // charcoal
];

// Syrup "hair" flavors — one distinct color each; the `name` doubles as the ID-card flavor tag.
const AV_SYRUPS = [
  { name: 'maple', color: SYRUP },
  { name: 'caramel', color: '#F0641D' },
  { name: 'berry', color: '#C9699E' },
  { name: 'grape', color: '#6B4E9E' },
  { name: 'blueberry', color: '#4E92CC' },
  { name: 'matcha', color: '#35A878' },
];

// Syrup drip styles — subtle drip length / which side runs longer (ported STY).
const AV_DRIPS = {
  classic: { sL: 41, sR: 33, side: 'L' },
  even: { sL: 38, sR: 36, side: 'L' },
  mirror: { sL: 33, sR: 41, side: 'R' },
  left: { sL: 45, sR: 34, side: 'L' },
  right: { sL: 34, sR: 45, side: 'R' },
};
const AV_DRIP_KEYS = ['classic', 'even', 'mirror', 'left', 'right'];

// Eye expressions — mood set by lids + pupils. Each is a per-eye preset (ported EX):
// [topLid, botLid, tilt, pupilDx, pupilDy, pupilScale]. Exactly two eyes are always present.
const AV_EXPRESSIONS = {
  neutral: { L: [0, 0, 0, 0, 0, 1], R: [0, 0, 0, 0, 0, 1] },
  curious: { L: [0, 0, 0, 0, -1.7, 1.18], R: [0, 0, 0, 0, -1.7, 1.18] },
  tired: { L: [0.5, 0, -0.9, 0, 0.8, 0.95], R: [0.5, 0, -0.9, 0, 0.8, 0.95] },
  sleepy: { L: [0.62, 0.06, -0.5, 0, 1.1, 0.85], R: [0.62, 0.06, -0.5, 0, 1.1, 0.85] },
  focused: { L: [0.32, 0.32, 0, 0, 0, 0.85], R: [0.32, 0.32, 0, 0, 0, 0.85] },
  determined: { L: [0.36, 0, 1.4, 0, 0.4, 1], R: [0.36, 0, 1.4, 0, 0.4, 1] },
  skeptical: { L: [0.5, 0, -0.3, 1, 0.4, 0.95], R: [0.18, 0, -0.3, 1, 0.4, 0.95] },
  sad: { L: [0.2, 0, -1.5, 0, -1, 1.05], R: [0.2, 0, -1.5, 0, -1, 1.05] },
  wide: { L: [0, 0, 0, 0, 0, 1.28], R: [0, 0, 0, 0, 0, 1.28] },
  wink: { L: [0.92, 0, -0.4, 0, 0.6, 0.55], R: [0, 0, 0, 0, 0, 1] },
};
const AV_EXPR_KEYS = ['neutral', 'curious', 'tired', 'sleepy', 'focused', 'determined', 'skeptical', 'sad', 'wide', 'wink'];

// The 7 non-eye pocket cells (viewBox 0 0 96 96), row-major [x, y]; each pocket is 14×14. The
// two eyes are fixed at the middle row's left/right cells, so exactly two eyes always render.
const AV_CELLS = [[20, 20], [41, 20], [62, 20], [41, 41], [20, 62], [41, 62], [62, 62]];

// FNV-1a — a tiny, stable, dependency-free string hash. Deterministic across runs/hosts.
function avHash(name) {
  let h = 2166136261 >>> 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// mulberry32 — a seeded PRNG. Seeded from the name hash, it yields a stable trait stream, so
// avatar traits are reproducible without `Math.random`.
function avRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic Fisher–Yates using the seeded stream (used to place freckles).
function avShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/** Stable anchor id / URL fragment for an agent, shared by team.html ids and cheatsheet links. */
function agentAnchorId(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `agent-${slug}`;
}

/**
 * The deterministic trait selection for an agent, drawn from the name hash in one fixed order
 * (skin → syrup → drip → expression → pocket-darken order). Single source of truth, so the
 * avatar and its ID-card flavor tag can never disagree. LOAD-BEARING: reordering these draws, or
 * adding/removing one, changes every avatar and every lock hash.
 */
function agentTraits(name) {
  const rng = avRng(avHash(name));
  const skin = AV_SKINS[Math.floor(rng() * AV_SKINS.length)];
  const syrup = AV_SYRUPS[Math.floor(rng() * AV_SYRUPS.length)];
  const drip = AV_DRIP_KEYS[Math.floor(rng() * AV_DRIP_KEYS.length)];
  const expression = AV_EXPR_KEYS[Math.floor(rng() * AV_EXPR_KEYS.length)];
  const darkOrder = avShuffle([0, 1, 2, 3, 4, 5, 6], rng); // priority order for which pockets darken
  return { skin, syrup, drip, expression, darkOrder };
}

/** The agent's syrup-flavor name (e.g. 'maple', 'grape') — the ID-card identity tag. */
export function agentFlavor(name) {
  return agentTraits(name).syrup.name;
}

// One eye, clipped to its rounded cell: a cream sclera (the countable `wd-av-eye` hook) + pupil +
// glint, with skin-colored lids setting the mood; when animated, a blink rect and a look-around
// glance. Ported from the wafflebot reference `eye()`. `side`: -1 left, +1 right (tilt direction).
function avEye(idx, side, cx, cellX, p, ink, cream, skin, uid, animated, begin) {
  const cellY = 41, cell = 14, cy = 48, erx = 4.5;
  const t = p[0], b = p[1], tilt = p[2], dx = p[3], dy = p[4], r = p[5];
  const x0 = cellX - 1.6, x1 = cellX + cell + 1.6;
  const tp = tilt * 2.2, base = cellY + t * cell;
  const yInner = base + tp, yOuter = base - tp;
  const yL = side < 0 ? yOuter : yInner, yR = side < 0 ? yInner : yOuter;
  const yb = cellY + cell - b * cell;
  const pr = 3.4 * r, px = cx + dx, py = cy + dy;
  const gx = px + pr * 0.42, gy = py - pr * 0.42, gr = pr * 0.34;
  const clip = `${uid}-eye${idx}`;
  const glance = animated
    ? `<animateTransform attributeName="transform" type="translate" begin="${begin}" dur="8s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.28;0.34;0.52;0.58;1" keySplines="0 0 1 1;0.4 0 0.4 1;0 0 1 1;0.4 0 0.4 1;0 0 1 1" values="0 0;0 0;2.2 0;2.2 0;0 0;0 0"/>`
    : '';
  const blink = animated
    ? `<rect x="${f2(cellX)}" y="${cellY}" width="${cell}" height="0" fill="${skin}"><animate attributeName="height" begin="${begin}" dur="6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.92;0.955;0.99;1" keySplines="0 0 1 1;0.5 0 1 1;0 0 0.5 1;0 0 1 1" values="0;0;${cell};0;0"/></rect>`
    : '';
  const topLid = t > 0.001
    ? `<path d="M${f2(x0)} ${f2(cellY - 1.6)} L${f2(x1)} ${f2(cellY - 1.6)} L${f2(x1)} ${f2(yR)} L${f2(x0)} ${f2(yL)} Z" fill="${skin}"/>`
      + `<path d="M${f2(x0)} ${f2(yL)} L${f2(x1)} ${f2(yR)}" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`
    : '';
  const botLid = b > 0.001
    ? `<path d="M${f2(x0)} ${f2(cellY + cell + 1.6)} L${f2(x1)} ${f2(cellY + cell + 1.6)} L${f2(x1)} ${f2(yb)} L${f2(x0)} ${f2(yb)} Z" fill="${skin}"/>`
      + `<path d="M${f2(x0)} ${f2(yb)} L${f2(x1)} ${f2(yb)}" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`
    : '';
  return `<clipPath id="${clip}"><rect x="${f2(cellX)}" y="${cellY}" width="${cell}" height="${cell}" rx="${erx}"/></clipPath>`
    + `<g clip-path="url(#${clip})">`
    + `<rect class="wd-av-eye" x="${f2(cellX)}" y="${cellY}" width="${cell}" height="${cell}" rx="${erx}" fill="${cream}"/>`
    + `<g><circle cx="${f2(px)}" cy="${f2(py)}" r="${f2(pr)}" fill="${ink}"/>`
    + `<circle cx="${f2(gx)}" cy="${f2(gy)}" r="${f2(gr)}" fill="${cream}"/>${glance}</g>`
    + topLid + botLid + blink + '</g>';
}

// The syrup "hair" blob + its drip, drawn ON TOP of the eyes like bangs. Static: a resting bead.
// Animated: the 9s drip — a bead swells at the active drip's tip, falls, then the drip recoils
// past rest with an overshoot before settling. Ported from the wafflebot reference `syrupGroup()`.
function avSyrup(dripKey, syrup, ink, uid, animated, begin, recoil) {
  const s = AV_DRIPS[dripKey] || AV_DRIPS.classic, sL = s.sL, sR = s.sR, tL = sL + 5, tR = sR + 5;
  const pathFor = (dL, dR) =>
    `M34 8 H62 Q72 8 72 16 Q72 24 62 24 H60 V${sR + dR} Q60 ${tR + dR} 55.5 ${tR + dR} Q51 ${tR + dR} 51 ${sR + dR}`
    + ` V24 H43 V${sL + dL} Q43 ${tL + dL} 38.5 ${tL + dL} Q34 ${tL + dL} 34 ${sL + dL} V24 Q24 24 24 16 Q24 8 34 8 Z`;
  const baseD = pathFor(0, 0);
  const dropCx = s.side === 'R' ? 55.5 : 38.5;
  const activeTip = s.side === 'R' ? tR : tL, dropBaseY = activeTip + 8;
  if (!animated) {
    return `<g><path d="${baseD}" fill="${syrup}" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>`
      + `<circle cx="${dropCx}" cy="${f2(dropBaseY)}" r="4" fill="${syrup}" stroke="${ink}" stroke-width="4"/></g>`;
  }
  const dl = s.side === 'R'
    ? { dangle: [-2.5, 4.5], over: [3.5, -2.5], settle: [-0.8, 0.8] }
    : { dangle: [4.5, -2.5], over: [-2.5, 3.5], settle: [0.8, -0.8] };
  const vals = [baseD, baseD, baseD, pathFor(dl.dangle[0], dl.dangle[1]), pathFor(dl.over[0], dl.over[1]), pathFor(dl.settle[0], dl.settle[1]), baseD].join(';');
  const fall = f2(104 - dropBaseY), cX = f2(dropCx - 13);
  const R = Math.max(0.8, Math.min(4, recoil == null ? 1.8 : recoil)), DUR = 9;
  const gS = DUR - 1.8 - R, gE = gS + 0.5, fS = gS + 0.9, fE = gS + 1.8, vn = fE + 0.135, oE = fE + 0.35 * R, sE = fE + 0.7 * R;
  const Ff = (x) => +(x / DUR).toFixed(4);
  const dkt = `0;${Ff(gS)};${Ff(fS)};${Ff(fE)};${Ff(oE)};${Ff(sE)};1`;
  const sKt = `0;${Ff(gS)};${Ff(gE)};${Ff(fE)};${Ff(vn)};1`;
  const tKt = `0;${Ff(gE)};${Ff(fS)};${Ff(fE)};${Ff(vn)};1`;
  const dks = '0 0 1 1;0 0 1 1;0.3 0 0.6 1;0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1';
  return '<g>'
    + `<path fill="${syrup}" stroke="${ink}" stroke-width="5" stroke-linejoin="round" d="${baseD}">`
    + `<animate attributeName="d" begin="${begin}" dur="9s" repeatCount="indefinite" calcMode="spline" keyTimes="${dkt}" keySplines="${dks}" values="${vals}"/></path>`
    + `<clipPath id="${uid}-drop"><rect x="${cX}" y="40" width="26" height="56"/></clipPath>`
    + `<g clip-path="url(#${uid}-drop)"><g transform="translate(${dropCx} ${f2(dropBaseY)})">`
    + `<circle cx="0" cy="0" r="4" fill="${syrup}" stroke="${ink}" stroke-width="4"/>`
    + `<animateTransform attributeName="transform" type="translate" additive="sum" begin="${begin}" dur="9s" repeatCount="indefinite" calcMode="spline" keyTimes="${tKt}" keySplines="0 0 1 1;0 0 1 1;0.4 0 1 1;0 0 1 1;0 0 1 1" values="0 0;0 0;0 0;0 ${fall};0 ${fall};0 0"/>`
    + `<animateTransform attributeName="transform" type="scale" additive="sum" begin="${begin}" dur="9s" repeatCount="indefinite" calcMode="spline" keyTimes="${sKt}" keySplines="0 0 1 1;0.3 0 0.5 1;0 0 1 1;0 0 1 1;0 0 1 1" values="0;0;1;1;0;0"/>`
    + '</g></g></g>';
}

/**
 * Deterministic waffle avatar for an agent, as a self-contained inline SVG string. Every trait
 * (skin, syrup flavor + drip, eye expression, which pockets darken) is a pure function of `name`
 * via `agentTraits`; `skillCount` (clamped 0..7) sets how many of the 7 non-eye pockets darken as
 * skill squares. Exactly two eyes always. Pure — same (name, skillCount, uid) ⇒ identical string.
 *
 * `uid` prefixes the clip-path ids so many avatars can coexist on one page; it defaults to the
 * name slug (keeping the isolated function byte-stable). Callers that render the SAME agent more
 * than once on a page (the cheat sheet) MUST pass a page-unique uid to avoid id collisions.
 * `www.w3.org` is the SVG namespace, not a fetch.
 */
export function agentAvatarSvg(name, skillCount = 0, { px = 40, className = '', uid, animated = true } = {}) {
  const { skin, syrup, drip, expression, darkOrder } = agentTraits(name);
  const id = uid || agentAnchorId(name);
  const ink = skin.ink;
  // A per-agent start offset so a grid of avatars doesn't blink/drip in lockstep — still a pure
  // function of the name, so output stays byte-identical per name.
  const begin = animated ? `${((avHash(name) % 60) / 10).toFixed(1)}s` : '0s';

  const count = Math.max(0, Math.min(Math.trunc(Number(skillCount) || 0), 7));
  const darkSet = new Set(darkOrder.slice(0, count));

  let pockets = '';
  for (let k = 0; k < AV_CELLS.length; k++) {
    const isSkill = darkSet.has(k);
    pockets += `<rect class="${isSkill ? 'wd-av-skill' : 'wd-av-pocket'}" x="${AV_CELLS[k][0]}" y="${AV_CELLS[k][1]}" width="14" height="14" rx="4.5" fill="${isSkill ? skin.pocketDark : skin.pocketLight}"/>`;
  }

  const p = AV_EXPRESSIONS[expression] || AV_EXPRESSIONS.neutral;
  const extraClass = className ? ` ${className}` : '';
  return (
    `<svg class="wd-av${extraClass}" width="${px}" height="${px}" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" stroke-linejoin="round">`
    // antenna (drawn behind the body so it emerges from the top-right corner)
    + `<g><line x1="63" y1="19" x2="72.5" y2="9.5" stroke="${ink}" stroke-width="5" stroke-linecap="round"/><circle cx="75" cy="7" r="3.6" fill="${AV_CREAM}" stroke="${ink}" stroke-width="3.5"/></g>`
    // drop shadow
    + `<rect x="10" y="14" width="76" height="76" rx="20" fill="${ink}"/>`
    // body
    + `<rect x="10" y="10" width="76" height="76" rx="20" fill="${skin.fill}" stroke="${ink}" stroke-width="7"/>`
    // pockets
    + pockets
    // eyes (drawn under the syrup so the "hair" can fall over them)
    + `<g>${avEye(0, -1, 27, 20, p.L, ink, AV_CREAM, skin.fill, id, animated, begin)}${avEye(1, 1, 69, 62, p.R, ink, AV_CREAM, skin.fill, id, animated, begin)}</g>`
    // syrup / "hair" — on top
    + avSyrup(drip, syrup.color, ink, id, animated, begin, 1.8)
    + '</svg>'
  );
}

// Google Fonts links (hybrid strategy): the brand type as progressive enhancement. These are
// the only external references any generated page carries.
const FONT_LINKS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Outfit:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">',
].join('\n');

const STYLES = `:root {
  color-scheme: dark light;
  --bg: #1A0D03;
  --text: #FFF3DC;
  --muted: #C9A87C;
  --rule: #5C4630;
  --heading: ${GOLDEN};
  --accent: ${SYRUP};
  --chip-bg: #241204;
  --chip-text: #C9A87C;
  --tag-bg: rgba(240, 138, 29, 0.15);
  --tag-text: ${GOLDEN};
  --display: ${DISPLAY};
  --body: ${BODY};
  --mono: ${MONO};
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #FFF7E8;
    --text: #3A2410;
    --muted: #A88B67;
    --rule: #E7D6B8;
    --heading: #5B2B0E;
    --chip-bg: #FFF3DC;
    --chip-text: #5C4630;
    --tag-bg: rgba(240, 138, 29, 0.16);
    --tag-text: #B06A1A;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--body);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.wd { max-width: 880px; margin: 0 auto; padding: 40px 24px 56px; }
.wd-head { display: flex; align-items: center; gap: 18px; }
.wd-glyph { flex: none; }
.wd-eyebrow {
  margin: 0 0 4px;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 3px;
  color: var(--accent);
}
.wd-title {
  margin: 0;
  font-family: var(--display);
  font-size: clamp(28px, 5vw, 38px);
  font-weight: 800;
  line-height: 1.1;
}
.wd-lede {
  margin: 22px 0 6px;
  padding-bottom: 20px;
  border-bottom: 3px solid var(--accent);
  color: var(--muted);
  max-width: 64ch;
}
.wd-rows { list-style: none; margin: 0; padding: 0; }
.wd-row { padding: 18px 0; border-bottom: 1px solid var(--rule); }
.wd-row:last-child { border-bottom: 0; }
.wd-line {
  margin: 0 0 6px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}
.wd-name { font-family: var(--mono); font-size: 17px; font-weight: 700; color: var(--heading); }
.wd-hint {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--chip-text);
  background: var(--chip-bg);
  padding: 2px 8px;
  border-radius: 6px;
}
.wd-desc { margin: 0; max-width: 74ch; }
.wd-tags { margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 6px; }
.wd-tag {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--tag-text);
  background: var(--tag-bg);
  padding: 3px 9px;
  border-radius: 999px;
}
.wd-foot { margin: 28px 0 0; font-size: 12.5px; color: var(--muted); }
.wd-av { display: block; }
/* team.html: the agent's avatar, centred against its mono name. */
.wd-avatar { flex: none; align-self: center; line-height: 0; }
.wd-avatar .wd-av { border-radius: 10px; }
/* cheatsheet.html: small, de-emphasised avatars of every agent granted a skill. */
.wd-agents { margin: 12px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.wd-agents-label {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--muted);
}
.wd-mini {
  position: relative;
  display: inline-flex;
  line-height: 0;
  text-decoration: none;
  color: inherit;
  opacity: 0.82;
  transition: opacity 120ms ease, transform 120ms ease;
}
.wd-mini:hover, .wd-mini:focus-visible { opacity: 1; transform: translateY(-2px); z-index: 4; outline: none; }
.wd-mini .wd-av { border-radius: 8px; }
/* CSS-only "ID card" popover revealed on hover/focus of a mini avatar. */
.wd-idcard {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 9px);
  z-index: 20;
  width: 264px;
  display: flex;
  gap: 12px;
  padding: 12px 13px;
  background: var(--chip-bg);
  border: 1px solid var(--rule);
  border-radius: 13px;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateX(-50%) translateY(5px);
  transition: opacity 130ms ease, transform 130ms ease, visibility 130ms;
  text-align: left;
}
.wd-mini:hover .wd-idcard, .wd-mini:focus-visible .wd-idcard {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) translateY(0);
}
.wd-idcard-av { flex: none; line-height: 0; }
.wd-idcard-av .wd-av { border-radius: 12px; }
.wd-idcard-body { flex: 1; min-width: 0; }
.wd-idcard-name { display: block; font-family: var(--mono); font-weight: 700; font-size: 14px; color: var(--heading); }
.wd-idcard-flavor { display: inline-block; margin: 5px 0 0; padding: 1px 8px; border-radius: 999px; background: var(--tag-bg); font-family: var(--mono); font-size: 9.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--tag-text); }
.wd-idcard-desc { display: block; margin: 7px 0 7px; font-size: 12.5px; line-height: 1.4; color: var(--text); }
.wd-idcard-count { display: block; font-family: var(--mono); font-size: 11px; letter-spacing: 0.5px; color: var(--accent); }`;

/**
 * One `<li>` per item. `rows` is `[{ primary, hint, secondary, tags, avatar, anchorId, extra }]`:
 *   primary   — the mono headline (`/name` or an agent name)
 *   hint      — optional mono chip (a skill's argument syntax)
 *   secondary — the one-line description (selectable, reflowing prose)
 *   tags      — optional pill list (an agent's granted skills / hand-offs)
 *   avatar    — optional pre-built inline SVG (already safe HTML) shown before the name
 *   anchorId  — optional stable `id` on the `<li>` for deep-linking (team.html#agent-<name>)
 *   extra     — optional pre-built trailing HTML block (the cheatsheet's agent avatars)
 */
function rowHtml({ primary, hint, secondary, tags, avatar, anchorId, extra }) {
  const hintHtml = hint ? ` <code class="wd-hint">${esc(hint)}</code>` : '';
  const avatarHtml = avatar ? `<span class="wd-avatar">${avatar}</span>` : '';
  const tagsHtml =
    tags && tags.length
      ? `\n      <p class="wd-tags">${tags.map((t) => `<span class="wd-tag">${esc(t)}</span>`).join(' ')}</p>`
      : '';
  const extraHtml = extra ? `\n${extra}` : '';
  const idAttr = anchorId ? ` id="${esc(anchorId)}"` : '';
  return (
    `    <li class="wd-row"${idAttr}>\n` +
    `      <p class="wd-line">${avatarHtml}<code class="wd-name">${esc(primary)}</code>${hintHtml}</p>\n` +
    `      <p class="wd-desc">${esc(secondary)}</p>${tagsHtml}${extraHtml}\n` +
    '    </li>'
  );
}

/**
 * Shared standalone-document frame. Emits a valid HTML5 page: dark-default branded chrome
 * around a semantic `<ul>` of rows. The layout has no fixed height — it reflows to the item
 * count and the viewport. Fonts are the only external reference (see FONT_LINKS).
 */
function htmlDoc({ eyebrow, title, lede, rows, footer }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(eyebrow)} — ${esc(title)}</title>
${GENERATED_BANNER}
${FONT_LINKS}
<style>
${STYLES}
</style>
</head>
<body>
<main class="wd">
  <header class="wd-head">
    ${waffleGlyphSvg(58)}
    <div>
      <p class="wd-eyebrow">${esc(eyebrow.toUpperCase())}</p>
      <h1 class="wd-title">${esc(title)}</h1>
    </div>
  </header>
  <p class="wd-lede">${esc(lede)}</p>
  <ul class="wd-rows">
${rows.map(rowHtml).join('\n')}
  </ul>
  <p class="wd-foot">${esc(footer)}</p>
</main>
</body>
</html>
`;
}

/**
 * A skill block's trailing strip of agent avatars: every installed agent granted this skill,
 * as a small de-emphasised waffle that reveals a CSS-only "ID card" on hover/focus and links
 * through to that agent's row on team.html. Empty string when no agent holds the skill.
 */
function agentAvatarsHtml(agentNames, agentByName, skillRef = '') {
  if (!agentNames || !agentNames.length) return '';
  const chips = agentNames
    .map((name) => {
      const agent = agentByName.get(name);
      if (!agent) return '';
      const n = agent.skills.length;
      const anchor = agentAnchorId(agent.name);
      // One agent can appear under several skills on a page, each drawing two avatars; a
      // page-unique uid per placement keeps their clip-path ids from colliding.
      const base = skillRef ? `${anchor}-${skillRef}` : anchor;
      const uidMini = `${base}-mini`;
      const uidCard = `${base}-card`;
      const card =
        '<span class="wd-idcard" role="tooltip">' +
        `<span class="wd-idcard-av">${agentAvatarSvg(agent.name, n, { px: 56, uid: uidCard })}</span>` +
        '<span class="wd-idcard-body">' +
        `<span class="wd-idcard-name">${esc(agent.name)}</span>` +
        `<span class="wd-idcard-flavor">${esc(agentFlavor(agent.name))}</span>` +
        `<span class="wd-idcard-desc">${esc(oneLiner(agent.description, 120))}</span>` +
        `<span class="wd-idcard-count">${n} skill${n === 1 ? '' : 's'}</span>` +
        '</span>' +
        '</span>';
      return (
        `<a class="wd-mini" href="team.html#${esc(anchor)}" aria-label="${esc(agent.name)}">` +
        agentAvatarSvg(agent.name, n, { px: 26, uid: uidMini }) +
        card +
        '</a>'
      );
    })
    .join('');
  return `      <p class="wd-agents"><span class="wd-agents-label">Agents</span>${chips}</p>`;
}

function cheatsheetHtml(commands, toolkitName, { agentsByRef, agentByName } = {}) {
  const byRef = agentsByRef ?? new Map();
  const byName = agentByName ?? new Map();
  const rows = commands.map((c) => ({
    primary: `/${c.name}`,
    hint: c.argumentHint || '',
    secondary: oneLiner(c.description, 200),
    extra: agentAvatarsHtml(byRef.get(c.ref), byName, c.ref),
  }));
  return htmlDoc({
    eyebrow: toolkitName,
    title: 'Skills cheat sheet',
    lede: `Slash commands available in this repo, assembled from the installed ${toolkitName} skills. Type /<name> in your agent to run one.`,
    rows,
    footer: `${commands.length} command${commands.length === 1 ? '' : 's'} · generated by wafflestack render — do not edit`,
  });
}

function teamHtml(agents, toolkitName) {
  const rows = agents.map((a) => ({
    primary: a.name,
    secondary: oneLiner(a.description, 200),
    tags: a.skills,
    avatar: agentAvatarSvg(a.name, a.skills.length, { px: 44 }),
    anchorId: agentAnchorId(a.name),
  }));
  return htmlDoc({
    eyebrow: toolkitName,
    title: 'Team',
    lede: `Specialist agents installed in this repo, assembled from the ${toolkitName} selection. Delegate to one by name; each lists the skills it can hand off to.`,
    rows,
    footer: `${agents.length} agent${agents.length === 1 ? '' : 's'} · generated by wafflestack render — do not edit`,
  });
}
