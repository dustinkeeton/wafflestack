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
        description: sub(stack, item.data.description, `waffledocs:agents/${item.name}#description`),
        skills: Array.isArray(item.data.skills) ? item.data.skills : [],
      });
    }
  }
  // Alphabetical, so output is deterministic (stable lock hash) regardless of stack order.
  commands.sort((a, b) => a.name.localeCompare(b.name));
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const docs = [];
  if (commands.length) {
    docs.push({ rel: CHEATSHEET_MD, content: cheatsheetMarkdown(commands, toolkit.name) });
    docs.push({ rel: CHEATSHEET_HTML, content: cheatsheetHtml(commands, toolkit.name) });
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
.wd-foot { margin: 28px 0 0; font-size: 12.5px; color: var(--muted); }`;

/**
 * One `<li>` per item. `rows` is `[{ primary, hint, secondary, tags }]`:
 *   primary   — the mono headline (`/name` or an agent name)
 *   hint      — optional mono chip (a skill's argument syntax)
 *   secondary — the one-line description (selectable, reflowing prose)
 *   tags      — optional pill list (an agent's granted skills / hand-offs)
 */
function rowHtml({ primary, hint, secondary, tags }) {
  const hintHtml = hint ? ` <code class="wd-hint">${esc(hint)}</code>` : '';
  const tagsHtml =
    tags && tags.length
      ? `\n      <p class="wd-tags">${tags.map((t) => `<span class="wd-tag">${esc(t)}</span>`).join(' ')}</p>`
      : '';
  return (
    '    <li class="wd-row">\n' +
    `      <p class="wd-line"><code class="wd-name">${esc(primary)}</code>${hintHtml}</p>\n` +
    `      <p class="wd-desc">${esc(secondary)}</p>${tagsHtml}\n` +
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

function cheatsheetHtml(commands, toolkitName) {
  const rows = commands.map((c) => ({
    primary: `/${c.name}`,
    hint: c.argumentHint || '',
    secondary: oneLiner(c.description, 200),
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
  }));
  return htmlDoc({
    eyebrow: toolkitName,
    title: 'Team',
    lede: `Specialist agents installed in this repo, assembled from the ${toolkitName} selection. Delegate to one by name; each lists the skills it can hand off to.`,
    rows,
    footer: `${agents.length} agent${agents.length === 1 ? '' : 's'} · generated by wafflestack render — do not edit`,
  });
}
