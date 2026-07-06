# Toolkit format reference

The toolkit holds **canonical, harness-neutral definitions** of agents and skills, grouped
into stacks. The installer renders them into harness-native files inside a consuming
project. Rendered files are **generated output** — never edit them; change the source here,
project config, or a project extension file instead.

The vocabulary: an individual installable item — an agent or a skill — is a **waffle**; a
named group of waffles is a **stack**; the generic `files/` payload a stack can also carry
(CI workflows, scripts, config) is **syrup**. A sensitive syrup file gated behind explicit
opt-in (the `optIn:` manifest key) is **opt-in syrup**.

## Repository layout

```
toolkit.yaml                 registry: name + list of stacks
stacks/<stack>/
  stack.yaml                stack manifest (see below)
  agents/<name>.md           neutral agent definitions
  skills/<name>/SKILL.md     neutral skill definitions (+ supporting files)
  files/<repo-rel-path>      generic project files (CI workflows, scripts, config)
installer/                   the render CLI (`wafflestack`)
schema/                      this document
```

Three payload types share the same render machinery — **agents** and **skills** target
harness dirs (`.claude/`, `.codex/`, `.agents/`), while **files** render to an arbitrary
repo-relative path. All three get `{{key}}` substitution, lock tracking, `doctor` drift
detection, and `eject`.

## stack.yaml

```yaml
name: github-workflow
description: One-line description of the stack.
agents: [architect, security]        # files under agents/, without .md
skills: [git-workflow, issue]        # directories under skills/
files:                               # generic files under files/, by repo-relative path
  - .github/workflows/release.yml
  - scripts/check-format.mjs
optIn:                               # optional: sensitive syrup that is opt-in, not default
  - files/.github/workflows/release.yml
requires:                            # optional per-item dependency declarations
  skills/issue:                      # keyed by item ref (skills/<name> | agents/<name>)
    - skills/git-workflow            # refs pulled in when this item is installed alone
config:                              # template keys this stack may reference
  git.botEmail:
    required: true
    description: Committer email used for automated commits.
  project.buildCmd:
    required: false
    default: npm run build
    description: Production build command run in preflight checks.
env:                                 # env vars the stack's content depends on
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"
setup: |-                            # optional, agent-facing install notes
  Service-side prerequisites and how to verify/create them (CLI auth, labels, boards).
```

Only keys **declared** in `config:` are substituted in this stack's content — any other
`{{...}}`-looking text (bash, GraphQL, JS templates) passes through untouched.

A key may also declare an optional **`pattern:`** — a regex the fully-resolved value
(after nested substitution) must fully match at render, or the render fails like a missing
required key. Use it for values spliced into a structured context — a workflow `if:`
expression, a YAML scalar, a shell word — where an unescaped quote, newline, or `${{ }}`
would corrupt or subvert the output: textual substitution can't escape for a context it
doesn't know, so the pattern makes a bad value loud at render instead of silently wrong.

`requires:` formalizes cross-item dependencies that would otherwise be prose-only (a
skill telling the reader to "see the `github-project-management` skill"). Each key is an
item ref (`skills/<name>` / `agents/<name>` / `files/<repo-relative-path>`) defined in this stack; each value is a list
of item refs it depends on, resolved against the **whole toolkit** (prefer this stack,
then a unique toolkit-wide match; qualify as `<stack>/skills/<name>` when the name is
ambiguous). When that item is installed individually, its `requires:` closure is pulled in
transitively. Agent → skill dependencies need no `requires:` — they come from the agent's
frontmatter `skills:` list. `validate` checks every `requires:` ref resolves.

`optIn:` marks **opt-in syrup — sensitive syrup files that must be poured only on request** —
a `files/` payload whose footprint (a workflow demanding repo write permissions, say) is
bigger than adopting the stack should silently imply. Each entry is an item ref
(`files/<repo-relative-path>`) defined in this stack. An opt-in syrup item is **excluded from
a stack's default render**: enabling the stack in `stacks:` (or via an `include:` stack ref)
does not render it. It renders only when it is **explicitly installed** — `wafflestack install
files/<path>`, which persists the ref to `include:` — or when the consuming repo **already
tracks its path** in `.waffle/waffle.lock.json`, so an existing install keeps receiving
updates rather than vanishing on the next render. Everything else about an opt-in syrup file
is unchanged: it is lock-tracked, drift-checked, and `eject`-able like any other item once
installed. `validate` checks every `optIn:` entry resolves to a real item in the stack, and
`wafflestack setup` lists opt-in syrup items under a separate, default-do-not-install
acknowledgement.

`setup:` is free text surfaced verbatim by `wafflestack setup` (the agent-driven install
playbook, `schema/SETUP.md`, followed by a generated inventory of every stack's items,
config schema, env, and these notes). It is printed **before** any project config exists,
so it must not use `{{placeholders}}` — refer to config keys by name instead.

## Agent definition (`agents/<name>.md`)

Markdown body with YAML frontmatter using the toolkit's field vocabulary:

```yaml
---
name: architect
description: One-line description (used verbatim by every harness).
skills:            # skill names this agent should be granted / pointed at
  - codebase-architecture
claude:            # passthrough keys emitted only in the Claude render
  allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent
---
```

The body is the agent's instructions. It may reference declared config keys as
`{{dotted.key}}`. The frontmatter `description` is also substituted (per target, like the
body) — it is the one frontmatter field that carries prose; all other frontmatter passes
through verbatim.

Renders to:
- **claude** → `.claude/agents/<name>.md` — frontmatter `name`, `description`, `skills`,
  plus every key under `claude:` hoisted to the top level; body as-is.
- **codex** → `.codex/agents/<name>.toml` — `name`, `description`,
  `developer_instructions` = body (skill access is conveyed in body prose; the
  `skills:`/`claude:` frontmatter has no TOML equivalent).

## Skill definition (`skills/<name>/SKILL.md`)

Standard SKILL.md shape — frontmatter (`name`, `description`, optional harness keys like
`user-invocable`) plus body. The file is rendered **byte-for-byte** except for template
substitution and extension appending; supporting files in the skill directory are copied
along (`.md` files get substitution, everything else verbatim).

Renders to:
- **claude** → `.claude/skills/<name>/`
- **agents-dir** → `.agents/skills/<name>/` (identical content; cross-tool convention)

## Files definition — syrup (`files/<repo-relative-path>`)

The generic `files/` payload is **syrup**: reusable project scaffolding that lives at an
arbitrary repo path rather than in a harness dir — CI workflows, helper scripts, shared
config. Each entry in the manifest's `files:` list is a **repo-relative path** under the
stack's `files/` directory; it renders **verbatim to that same path** in the consuming
project. (Sensitive syrup gated behind `optIn:` is **opt-in syrup** — see above.)

Files are **harness-independent**: they render **once** regardless of `targets:` (a file has
no per-harness variant), so `files/scripts/check.mjs` always lands at `scripts/check.mjs`.

- **Text vs. binary is sniffed by content** (a NUL byte in the head marks binary), not by
  extension — so any text type (`.yml`, `.mjs`, `.sh`, `.json`, …) is templated, and true
  binaries (`.png`, `.ico`) are copied byte-for-byte.
- **Text files** get the same `{{dotted.key}}` substitution as skills — declared config keys
  plus the `harness.*` namespace, resolved against the **first configured target** (files
  render once, so there is a single identity to attribute to).
- **Binaries** are byte-copied untouched — a `{{...}}`-looking byte run inside one is never
  substituted.

Same frozen-image contract as everything else: tracked in `.waffle/waffle.lock.json`,
restored verbatim by `render`, drift-flagged by `doctor`, and releasable with
`wafflestack eject files/<repo-relative-path>` (the file stays in place and becomes
project-owned). Two enabled stacks that emit the **same** repo path is a hard render error —
the same cross-stack conflict rule as same-named skills; enable one or `eject` one.

**GitHub Actions caveat.** A `${{ ... }}` expression (leading `$`) is **not** a wafflestack
placeholder — only `{{ ... }}` without a `$` is. Workflow expressions like
`${{ secrets.GITHUB_TOKEN }}` and `${{ github.sha }}` therefore pass through untouched and are
not policed by `validate`; use a plain `{{key}}` where you want the toolkit to substitute.
Note also that files under `.github/workflows/` cannot be written by GitHub Actions' default
`GITHUB_TOKEN` (that needs the `workflow` scope) — a non-issue for the local `render` flow,
but relevant if you ever render from CI.

## Consuming project contract

Everything wafflestack keeps in a consuming repo lives inside one `.waffle/` directory:

- `.waffle/waffle.yaml` (committed) — version pin, `targets:` (`claude`, `codex`,
  `agents-dir`), `stacks:`, optional `include:` (individual items), `config:` values,
  optional `eject:` list.
- `.waffle/waffle.local.yaml` (gitignored) — deep-merged over the committed config, wins
  on conflict. For account-specific values that must not be committed.
- `.waffle/extensions/agents/<name>.md`, `.waffle/extensions/skills/<name>.md`
  (committed, optional) — appended to the rendered item inside marked
  `<!-- BEGIN/END project extension -->` comments. This is the supported way to add
  project-specific guidance to a toolkit item.
- `.waffle/waffle.lock.json` (generated) — manifest of every rendered file with its hash.
  `wafflestack doctor` diffs reality against it; `wafflestack render` regenerates
  everything verbatim and deletes previously-managed files that are no longer rendered.
  It is also what tells *your* managed files apart from a hand-written file at the same
  path: `render` refuses to overwrite a pre-existing file that the lock does not track
  (see *Pre-existing (unmanaged) file collisions* below), unless you pass `--force`.
  `wafflestack doctor --allow-missing` treats absent managed files as informational (only
  *modified* files fail) — for use as a CI drift gate in repos that deliberately gitignore
  some renders; a missing lock still fails, since that means the repo was never rendered.
- `.waffle/CHEATSHEET.md`, `.waffle/TEAM.md`, `.waffle/cheatsheet.html`, `.waffle/team.html`
  (generated) — overview docs describing the installed selection (see *Generated overview
  docs* below). Managed like any rendered output: lock-tracked, drift-flagged, refreshed and
  pruned by `render`. Commit them; never hand-edit them.

## Generated overview docs

Every `render` writes a small set of overview docs into `.waffle/`, assembled **only from the
items actually installed** (the computed render selection) so they describe what a repo really
has, not the whole toolkit:

- **`.waffle/CHEATSHEET.md`** — one line per installed **user-invocable skill**: its `/name`
  slash command, its `argument-hint`, and a one-line "when to use" taken from the skill
  `description`. A skill counts as user-invocable unless its frontmatter sets
  `user-invocable: false` (a skill that only sets `disable-model-invocation: true` still
  appears — it remains a slash command, it just won't auto-trigger).
- **`.waffle/TEAM.md`** — one entry per installed **agent**: its name, its role / when-to-use
  (from the agent `description`), and the skills it is granted (its hand-off points, from the
  agent frontmatter `skills:`).
- **`.waffle/cheatsheet.html`, `.waffle/team.html`** — branded, self-contained HTML pages of
  the same content: valid standalone documents with selectable, searchable, reflowing text and
  the wafflestack palette (dark by default, light via `prefers-color-scheme`). They use a
  hybrid font strategy — the brand type (Baloo 2 / Outfit / JetBrains Mono) loads via Google
  Fonts `<link>` tags as progressive enhancement, backed by a brand-styled system-font stack
  so the page renders correctly fully offline; those font links are the only external
  reference (no external images, scripts, or stylesheets). The Markdown is the agent-readable
  source of truth; the HTML pages are the visual one-pagers.

The docs are assembled from item **frontmatter** (no extra manifest surface), and every
`description` / `argument-hint` is substituted with the same resolver the rendered item uses,
so a `{{project.name}}` reads identically to how it renders in the item itself. Each doc pair
is omitted when its set is empty — a selection with no user-invocable skills produces no
cheat sheet, one with no agents produces no team page — and the frozen-image prune then
removes any previously-generated copy. Because they flow through the same render/lock
pipeline as every other output, they are refreshed on every render and flagged by `doctor` if
edited by hand; treat them as generated output.

## Selecting what renders

The rendered set is `union(items of stacks:) ∪ include: − eject:`.

- `stacks:` — whole stacks; every agent and skill in them renders, **except items marked
  `optIn:`** in the manifest (opt-in syrup), which stay opt-in (install the ref explicitly, or
  keep an existing install alive via its lock entry — see *`optIn:`* under stack.yaml).
- `include:` — individual items you want without adopting their whole stack. Each entry
  is a **ref**:
  - a stack name — `github-workflow` (equivalent to listing it in `stacks:`);
  - an item — `skills/<name>`, `agents/<name>`, or `files/<repo-relative-path>`;
  - a stack-qualified item — `<stack>/skills/<name>`, needed only when the same item
    name is defined in more than one stack (e.g. `security-audit`).
  Installing an item pulls its **dependency closure** — an agent's frontmatter `skills:`
  and any `requires:` — transitively and across stacks. Required config is then scoped to
  the placeholders the selected items actually use, so a partial install never demands
  config that only unselected siblings need. Stack `env:` prerequisites still warn when
  any item from that stack renders.
- `eject:` — items to stop managing; wins over both `stacks:` and `include:`.

`wafflestack install <ref…>` performs this edit for you: it resolves each ref (failing on
unknown or ambiguous names, listing the qualified candidates), appends stack refs to
`stacks:` and item refs to `include:` (comment-preserving, stack-qualified only when
ambiguous), then runs a full render. Persisting the choice is required, not cosmetic — the
frozen-image contract deletes any locked file the next render doesn't reproduce, so an
un-persisted ad-hoc install would be silently removed. Dependency closure is recomputed
each render (not persisted), so it tracks upstream changes. `wafflestack eject skills/<name>`
also drops any matching `include:` entry so it isn't left orphaned.

## Template values

`{{key}}` looks up `key` as a dotted path in the merged `config:` maps. Strings substitute
verbatim; arrays of strings join with `, `; other structures render as a YAML block.
Missing **required** keys fail the render with a list of what to add. A `$`-prefixed
`${{ ... }}` (GitHub Actions / shell-template syntax) is **not** a placeholder — it is left
untouched everywhere, so workflow expressions survive rendering and `validate`.

### Nested substitution

A substituted **value** (project config or stack default) may itself contain
`{{placeholders}}`, expanded recursively (depth-capped). Nested expansion only descends
into values — canonical text that survives the first pass (GitHub Actions `${{ ... }}`,
mustache examples) is never touched. Inside a value, anything resolvable is expanded:
declared keys, `harness.*`, and any dotted path present in the project config **even if
undeclared** — so a committed value like

```yaml
git:
  cmd: git -c user.email={{git.botEmail}} -c user.name={{git.botName}}
```

can reference keys kept in the gitignored `.waffle/waffle.local.yaml`. Unresolvable nested
placeholders pass through verbatim. Avoid config key names that collide with literal
template syntax you embed in values (e.g. don't declare a `secrets.*` namespace).

### Item-name collisions

Two stacks may define items with the same name — alternative implementations of the same
skill interface (e.g. the desktop-plugin vs. browser-app `security-audit`). Enabling both
in one project is an error: the renderer refuses to render the same output path from two
stacks instead of silently letting the last one win. Pick one, or `eject` one.

### Pre-existing (unmanaged) file collisions

`render` will not overwrite a file it did not write. A path a render would produce that
already exists on disk but is **not** tracked by `.waffle/waffle.lock.json` — a hand-written
consumer file, not a prior render of ours — is an **unmanaged collision**: the render fails
loudly, naming every offending path, and writes nothing. The check runs before any prune or
write, so a refused render leaves the whole tree untouched. Two escape hatches:

- a **byte-identical** existing file is **adopted silently** — the render is a no-op for it
  and the next lock simply records it under management, no flag needed;
- **`--force`** (on `render` or `install`) overwrites a differing file and takes it under
  management — its previous contents are lost.

Already-managed files (present in the lock) are never collisions: the frozen-image contract
restores them verbatim on every render, so a locked path is only ever *your* prior render.
To resolve a refusal, move the named file aside (or fold its content into a
`.waffle/extensions/` file where the target is an agent/skill) and re-render, or pass
`--force` once you've decided the toolkit's version should own that path.

### The `harness.*` namespace

`harness.*` is a reserved, **always-available** namespace (never declared in a stack's
`config:`). It resolves **per output target**, so one source can carry the small
per-harness differences — chiefly authorship attribution — without duplicating files:

| Key | claude | codex | agents-dir |
|---|---|---|---|
| `harness.assistantName` | `Claude` | `Codex` | `Codex` |
| `harness.attributionPath` | `claude-code` | `Codex` | `Codex` |
| `harness.skillsDir` | `.claude/skills` | `.agents/skills` | `.agents/skills` |

A project can override any sub-key under `config.harness.<sub>` — either a scalar (applied
to every target) or a per-target map, e.g.:

```yaml
config:
  harness:
    assistantName: Aider            # scalar → all targets
    attributionPath:                # per-target map (missing targets fall back to the built-in)
      claude: my-tool
      agents-dir: my-tool
```

Because substitution runs once per target, the same `{{harness.*}}` placeholder can render
differently in `.claude/…` vs `.codex/…` / `.agents/…` from a single canonical source.
