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
import { parseFrontmatter } from './util.mjs';
import { substitute } from './template.mjs';
import { makeResolver } from './project.mjs';
import { resolveAgentSkill } from './refs.mjs';

const CHEATSHEET_MD = path.join('.waffle', 'CHEATSHEET.md');
const CHEATSHEET_HTML = path.join('.waffle', 'cheatsheet.html');
const TEAM_MD = path.join('.waffle', 'TEAM.md');
const TEAM_HTML = path.join('.waffle', 'team.html');

// Description substitution never enforces `pattern:` guards (those police config values
// spliced into structured contexts, not prose) — pass an empty map.
const NO_PATTERNS = new Map();

/**
 * A skill is a slash command unless it explicitly opts out with `user-invocable: false`.
 * An absent key defaults to invocable — matching harness behaviour, so a skill that only
 * sets `disable-model-invocation: true` (e.g. `audit`) still shows on the cheat sheet.
 */
function isUserInvocable(data) {
  return data['user-invocable'] !== false;
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
    substitute(String(text ?? ''), resolverFor(stack), stack.declared, errors, ctx, NO_PATTERNS).trim();

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
        // `stackName` is retained so agent `skills:` refs resolve preferring their own stack
        // (matching render's own resolution) when building the cheatsheet reverse map.
        stackName: stack.name,
        description: sub(stack, item.data.description, `waffledocs:agents/${item.name}#description`),
        skills: Array.isArray(item.data.skills) ? item.data.skills : [],
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
  }
  return docs;
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

const AV_OUTLINE = '#5B2B0E'; // brand cocoa — the waffle's edge line
const AV_EYE = '#2A1608'; // darkest pocket — the eyes

// Skin tones cluster around the GOLDEN anchor; each carries a matched darker `pocket` (empty
// squares) and `freckle` (skill squares) shade so the waffle reads as one baked piece.
const AV_SKINS = [
  { fill: GOLDEN, pocket: '#E3AE3E', freckle: '#B87A24' },
  { fill: '#F0BD46', pocket: '#DBA636', freckle: '#AE7020' },
  { fill: '#F7CE63', pocket: '#E6B94E', freckle: '#BE8130' },
  { fill: '#EAB94A', pocket: '#D6A338', freckle: '#A96C1E' },
  { fill: '#F3C74F', pocket: '#E0A93A', freckle: '#B37622' },
  { fill: '#F8D06A', pocket: '#E8BC55', freckle: '#C08834' },
];

// Syrup "hair" — shape and colour variants around the SYRUP anchor. Each path is a swoosh
// that sits across the top of the head (drawn before the body so the body clips its base).
const AV_SYRUP_COLORS = [SYRUP, '#E67E12', '#F59A34', '#D9750F', '#EE8418'];
const AV_HAIR_PATHS = [
  'M14 30 C10 12 34 5 52 9 C70 13 90 9 86 28 C77 19 66 21 55 19 C39 16 22 19 14 30 Z',
  'M17 29 C13 9 41 3 55 11 C65 16 76 7 83 25 C73 21 63 22 55 20 C41 17 26 17 17 29 Z',
  'M14 27 C19 9 46 6 63 11 C74 14 81 10 86 25 C71 22 59 24 47 22 C34 19 22 18 14 27 Z',
  'M15 30 C11 13 33 6 50 8 C64 10 74 6 82 16 C86 21 84 27 84 29 C78 21 66 21 55 19 C40 16 23 19 15 30 Z',
];

// Eye "expressions" — which two of the nine pockets are the eyes. Each pair is a within-row
// couple with a gap, so the face reads as a face whichever row it lands on.
const AV_EXPRESSIONS = [
  [0, 2],
  [3, 5],
  [6, 8],
  [0, 1],
  [1, 2],
  [3, 4],
];

// Pocket grid geometry (viewBox 0 0 100 100), matching the body rect below.
const AV_COLS = [25, 43.5, 62];
const AV_ROWS = [33, 51.5, 70];

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
 * Deterministic waffle avatar for an agent, as a self-contained inline SVG string. Every trait
 * (skin tone, syrup hair shape/colour, eye expression, freckle positions) is derived from
 * `name`; `skillCount` (clamped to 0..7) sets how many non-eye pockets are darkened as skill
 * squares. Pure — same inputs ⇒ identical string. `www.w3.org` is the SVG namespace, not a fetch.
 */
export function agentAvatarSvg(name, skillCount = 0, { px = 40, className = '' } = {}) {
  const rng = avRng(avHash(name));
  const skin = AV_SKINS[Math.floor(rng() * AV_SKINS.length)];
  const hair = AV_HAIR_PATHS[Math.floor(rng() * AV_HAIR_PATHS.length)];
  const syrup = AV_SYRUP_COLORS[Math.floor(rng() * AV_SYRUP_COLORS.length)];
  const eyes = AV_EXPRESSIONS[Math.floor(rng() * AV_EXPRESSIONS.length)];

  const count = Math.max(0, Math.min(Math.trunc(Number(skillCount) || 0), 7));
  const candidates = [];
  for (let g = 0; g < 9; g++) if (!eyes.includes(g)) candidates.push(g);
  const freckles = new Set(avShuffle(candidates, rng).slice(0, count));

  let pockets = '';
  for (let g = 0; g < 9; g++) {
    const x = AV_COLS[g % 3];
    const y = AV_ROWS[Math.floor(g / 3)];
    let fill;
    let cls;
    if (eyes.includes(g)) {
      fill = AV_EYE;
      cls = 'wd-av-eye';
    } else if (freckles.has(g)) {
      fill = skin.freckle;
      cls = 'wd-av-skill';
    } else {
      fill = skin.pocket;
      cls = 'wd-av-pocket';
    }
    pockets += `<rect class="${cls}" x="${x}" y="${y}" width="13" height="13" rx="4" fill="${fill}"/>`;
  }

  const extraClass = className ? ` ${className}` : '';
  return (
    `<svg class="wd-av${extraClass}" width="${px}" height="${px}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" stroke-linejoin="round">` +
    `<path d="${hair}" fill="${syrup}" stroke="${AV_OUTLINE}" stroke-width="2"/>` +
    `<rect x="16" y="24" width="68" height="68" rx="14" fill="${skin.fill}" stroke="${AV_OUTLINE}" stroke-width="3"/>` +
    pockets +
    '</svg>'
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
  width: 244px;
  display: flex;
  gap: 11px;
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
.wd-idcard-av .wd-av { border-radius: 9px; }
.wd-idcard-body { flex: 1; min-width: 0; }
.wd-idcard-name { display: block; font-family: var(--mono); font-weight: 700; font-size: 14px; color: var(--heading); }
.wd-idcard-desc { display: block; margin: 4px 0 7px; font-size: 12.5px; line-height: 1.4; color: var(--text); }
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
function agentAvatarsHtml(agentNames, agentByName) {
  if (!agentNames || !agentNames.length) return '';
  const chips = agentNames
    .map((name) => {
      const agent = agentByName.get(name);
      if (!agent) return '';
      const n = agent.skills.length;
      const card =
        '<span class="wd-idcard" role="tooltip">' +
        `<span class="wd-idcard-av">${agentAvatarSvg(agent.name, n, { px: 46 })}</span>` +
        '<span class="wd-idcard-body">' +
        `<span class="wd-idcard-name">${esc(agent.name)}</span>` +
        `<span class="wd-idcard-desc">${esc(oneLiner(agent.description, 120))}</span>` +
        `<span class="wd-idcard-count">${n} skill${n === 1 ? '' : 's'}</span>` +
        '</span>' +
        '</span>';
      return (
        `<a class="wd-mini" href="team.html#${esc(agentAnchorId(agent.name))}" aria-label="${esc(agent.name)}">` +
        agentAvatarSvg(agent.name, n, { px: 26 }) +
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
    extra: agentAvatarsHtml(byRef.get(c.ref), byName),
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
