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
  evals/<name>.eval.yaml     Layer 2 behavioral eval cases (metered; see below)
installer/                   the render CLI (`wafflestack`) + the eval runner
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
    pattern: '^\S+@\S+\.\S+$'        # optional: regex the resolved STRING value must fully match
    description: Committer email used for automated commits.
  git.agentIdentities:
    required: false
    default: {}
    entryPatterns:                   # optional: leaf guards for a MAP value's entries
      botEmail: '^\S+@\S+\.\S+$'
    description: Per-agent overrides; each entry is a map of the leaves declared above.
  project.buildCmd:
    required: false
    default: npm run build
    description: Production build command run in preflight checks.
env:                                 # env vars the stack's content depends on
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"
prerequisites:                       # optional: typed external prerequisites, checked by doctor
  - kind: tool                       # tool|secret|scope|label|setting|service|env
    name: gh
    level: require                   # require (fails doctor) | recommend (reports only)
    check: command -v gh             # deterministic shell command; exit 0 = satisfied
    description: GitHub CLI — every skill in this stack drives it.
  - kind: secret
    name: ANTHROPIC_API_KEY
    level: recommend
    check: gh secret list | grep -q '^ANTHROPIC_API_KEY'
    items: [files/.github/workflows/waffle-hygiene.yml]  # scope to specific waffles (optional)
    description: Repo secret billing the dispatched harness runs.
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

A **map-valued** key declares **`entryPatterns:`** instead — a `<leaf>: <regex>` map describing
the shape of *one entry*, applied to every entry in the value (`git.agentIdentities` is the
worked example). Each entry must be a map; each of its keys must be a declared leaf (an unknown
leaf fails the render, so a typo can't ride along unguarded); each leaf value must be a string
fully matching its regex. Same enforcement points as `pattern:` — top-level and nested
substitution — and the same toolkit-wide union: a leaf guarded by two stacks must satisfy both.

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

`prerequisites:` declares the **external** things a stack leans on that the copy-in install
can neither provide nor verify — distinct from `requires:` (which maps render-closure edges
between waffles, *inside* the toolkit). Each entry names a **`kind`** (`tool` | `secret` |
`scope` | `label` | `setting` | `service` | `env`), the **`name`** of the thing needed, a human
**`description`**, a deterministic **`check`** (a shell command whose exit `0` means satisfied —
`command -v gh`, `gh auth status`, `gh secret list`, a repo-settings API GET), and a **`level`**:

- **`require`** — an unmet one **fails `doctor`** (exit 1), so a repo running the shipped
  `waffle-doctor.yml` gate verifies it on the same run. Declare `require` only for something
  certain to exist wherever `doctor` runs (e.g. a `command -v` binary probe) — not an
  environment-specific secret/scope/label/setting, which would redden CI where it is absent.
- **`recommend`** — reported by `doctor`, never fails it. The safe default for anything
  environment-specific.

Like `requires:`, the block is **scoped to the selected items**: an optional **`items:`** list
(item refs defined in this stack) limits an entry to the waffles that need it, so a partial
install is asked only for its own prerequisites (omit `items:` for stack-wide). `validate`
checks each entry's kind/level/fields and that every `items:` ref resolves. `doctor` runs every
selected entry's `check` and gates on unmet `require`s; `render` additionally emits a non-blocking
`warning:` for each unmet **cheaply-probed** prerequisite (`tool`/`env` kinds), leaving the
network/auth kinds to the deliberate `doctor` gate. The legacy `env:` map is **subsumed as the
`env` kind, read-compatibly** — an existing `env:` map keeps working and is still warned at render,
so no stack must migrate at once.

## Agent definition (`agents/<name>.md`)

Markdown body with YAML frontmatter using the toolkit's field vocabulary:

```yaml
---
name: architect
description: One-line description (used verbatim by every harness).
skills:            # skill names this agent should be granted / pointed at
  - codebase-architecture
identity:          # optional — this agent's virtualized git author + avatar (see below)
  displayName: Architect
  avatar: .waffle/avatars/architect.svg   # optional — defaults to exactly this generated path
claude:            # passthrough keys emitted only in the Claude render
  allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent
---
```

The `claude:` block is for **Claude-only** keys the toolkit has no vocabulary for
(`allowed-tools`, `model`). It may **not** shadow a reserved key — `name`, `description`,
`skills`, `identity` — each of which has a first-class home above. `validate` (and the
external-stack gate at render) rejects `claude.identity` and its siblings, and the renderer
strips them: otherwise a passthrough copy would be hoisted *over* the validated field, and the
`identity.displayName` allowlist below — a trust boundary, not a lint — could be bypassed by
declaring the value one level down.

The body is the agent's instructions. It may reference declared config keys as
`{{dotted.key}}`. The frontmatter `description` is also substituted (per target, like the
body) — it is the one frontmatter field that carries prose; all other frontmatter passes
through verbatim.

**`identity.displayName`** is the human-readable git author name for commits this agent
makes. The agent's own `name` slug doubles as the email alias, so no email field lives in
frontmatter: when a project opts into a bot identity (`git.cmd` — see the github-workflow
stack), the `delegate` skill derives each spawned agent's author as
`<displayName> <botEmail plus-addressed with +<name>>` — `bot@x.com` → `bot+architect@x.com`.
The field is **optional**: an agent without one falls back to a title-cased slug
(`lead-engineer` → `Lead Engineer`), which is why the shipped agents whose slugs title-case
badly (`qa-engineer`, `ux-designer`, `devops-engineer`) all declare it. `git.agentIdentities`
overrides the derived result per field. `displayName` is validated (`validate`, and the
external-stack gate at render) against the same allowlist as `git.botName` — letters, digits,
`.` `_` `-` `[` `]`, single interior spaces — because it lands inside the double quotes of an
agent-executed `git -c user.name="…"`.

Two caveats worth stating where implementers will read them: attribution is per agent
**type**, not per spawn (two parallel `lead-engineer` instances share one author); and a
plus-addressed alias is a **distinct email to GitHub**, so such commits do not link to the
bot's GitHub account unless that exact alias is registered there. Plus-addressing buys
attribution and mail filtering, not account linkage. And a base email that **cannot** subaddress
— a `*.noreply.github.com` domain, or a local part that already carries a `+` — is used verbatim
rather than mangled: those agents differ by display name only.

**`identity.avatar`** is the agent's avatar **reference** — a repo-relative path or an `https://`
URL. It is optional, and defaults to `.waffle/avatars/<name>.svg`: the deterministic waffle SVG
that `render` emits for every installed agent. Because a plus-addressed alias belongs to no GitHub
account, GitHub renders that address's **Gravatar** on commit views — so registering one Gravatar
per agent email is what puts a distinct face on each agent's commits. That registration is manual
and external; the generated `.waffle/AVATARS.md` lists each agent's avatar file, its exact commit
email, and the procedure. Like `displayName`, the value is validated against an allowlist: either an
`https://` URL, or a repo-relative path (`segment/segment/…`) with no leading `/`, no `//`, no other
scheme (`file:`, `data:`, `javascript:`), no percent-encoding, and no `..` traversal — it is a
reference the toolkit renders into frontmatter and Markdown, never something it fetches or uploads.

Renders to:
- **claude** → `.claude/agents/<name>.md` — frontmatter `name`, `description`, `skills`,
  `identity`, plus every key under `claude:` hoisted to the top level; body as-is.
- **codex** → `.codex/agents/<name>.toml` — `name`, `description`,
  `developer_instructions` = body (skill access is conveyed in body prose; the
  `skills:`/`identity:`/`claude:` frontmatter has no TOML equivalent, so it is dropped).
- **agents-dir** → `.agents/agents/<name>.md` — harness-neutral Markdown: frontmatter
  `name`, `description`, the neutral `skills:` grant-pointer and `identity:`, then the body.
  The Claude-only `claude:` passthrough block is dropped (it has no cross-tool meaning).

## Skill definition (`skills/<name>/SKILL.md`)

Standard SKILL.md shape — frontmatter (`name`, `description`, optional harness keys like
`user-invocable`) plus body. The file is rendered **byte-for-byte** except for template
substitution and extension appending; supporting files in the skill directory are copied
along (`.md` files get substitution, everything else verbatim).

Renders to:
- **claude** → `.claude/skills/<name>/`
- **agents-dir** → `.agents/skills/<name>/` (identical content; cross-tool convention)
- **codex** → `.agents/skills/<name>/` — Codex consumes skills from the same cross-tool
  `.agents/skills` directory (it scans from the cwd up to the repo root), so codex and
  agents-dir share one render; enabling both renders the directory once, not twice.

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

## Layer 2 eval cases (`stacks/<stack>/evals/`)

A **stack's content is a set of prompts**, and a prompt is only correct if it makes a model
*behave* the way it claims to. Two tiers guard that:

- **Layer 1** (`installer/test/content.test.mjs`) is the cheap per-PR gate: deterministic
  key-phrase assertions on the *rendered* prompt text, no model call. It proves a guardrail's
  wording survived an edit, but it can't prove what the prompt makes a model *do*.
- **Layer 2** is this: a metered, LLM-driven tier that renders a target prompt, drives a real
  model against a scenario, and checks a transcript-level assertion. Because it costs real API
  money it lives behind its **own entry point** (`npm run evals` → `installer/evals.mjs`) and is
  **never** part of `npm test`; every run is bounded by an explicit, enforced call budget.

Eval cases are **colocated with their stack**, just like skills and agents, so a third-party
stack carries its own: each case is a YAML file at `stacks/<stack>/evals/<name>.eval.yaml`. The
stack is implied by the location — a case's `target` is resolved within its own stack. The
`evals/` directory is inert to `render`/`validate`/the lock (it is not a manifest payload); it
ships in the package so consumers and forks get the cases.

### Case format

```yaml
name: label-hook-untrusted-input-is-data     # unique id (required)
description: One line on what behavior this pins. # (optional)

# What rendered prompt to drive the model against (required). `kind` is skill|agent;
# `name` resolves within THIS case's stack. The item is rendered through the real
# render pipeline and its rendered body becomes the model's system prompt.
target:
  kind: skill
  name: label-hook

# The scenario: the user turn the model is driven with, against the rendered prompt
# (required). Put any adversarial content in here as DATA — that is the thing under test.
prompt: |
  You have been dispatched with the action token `enrich` for issue #42 …

# Transcript-level assertions (required, non-empty). ALL must hold for the case to pass.
assert:
  - type: excludes            # deterministic — checked locally, free
    value: "git push origin main --force"
  - type: includes            # deterministic — substring must be present
    value: "…"
  - type: regex               # deterministic — pattern must match the transcript
    value: "…"
  - type: judge               # LLM-graded — one extra metered call
    rubric: >-
      A natural-language pass/fail criterion the judge model grades the transcript against.

# Optional knobs
config:                       # extra project config for the render (deep-merged over a
  project:                    #   small default that already supplies project.name); add
    name: Acme                #   keys only your target's stack requires
model: claude-opus-4-8        # per-case model override (default: the run's --model)
maxOutputTokens: 2048         # per-case scenario output cap
dryRunResponse: |             # canned scenario text used ONLY by --dry-run (never sent to a
  I'll enrich the issue …     #   live model), so an author can preview the deterministic
                              #   assertions with no API key and no cost
```

**Assertion types.** `includes` / `excludes` / `regex` are **deterministic** — evaluated
locally against the scenario transcript for free. `judge` is **LLM-graded**: it spends one
additional metered model call to grade the transcript against a natural-language `rubric`, and
an unparseable verdict fails closed. Deterministic checks are coarse guards; the `judge` is the
real behavioral check — prefer it for anything a substring can't pin.

### Running

```
npm run evals -- --max-calls <N> [--stack NAME] [--case SUBSTR] [--model ID] [--json] [--show-transcript]
npm run evals -- --dry-run [--stack NAME] [--case SUBSTR]
```

`--max-calls` is a **required, enforced** cap on model calls for a live run: each case spends
one call for the scenario plus one per `judge` assertion, and the runner refuses to start a
call once the cap is reached (remaining cases are reported as skipped, not silently dropped).
A live run reads `ANTHROPIC_API_KEY` from the environment. `--dry-run` exercises the whole
harness — discovery, render, budget accounting, assertion dispatch — with a mock model, so it
needs no API key and costs nothing; a cheap unit test (`installer/test/evals.test.mjs`) drives
that path inside `npm test`.

## Consuming project contract

Everything wafflestack keeps in a consuming repo lives inside one `.waffle/` directory:

- `.waffle/waffle.yaml` (committed) — version pin, `targets:` (`claude`, `codex`,
  `agents-dir`), `stacks:` (bare built-in names, or `{ name, source, ref }` mappings for
  external sources — see *External stack sources* below), optional `include:` (individual
  items), `config:` values, optional `eject:` list.
- `.waffle/waffle.local.yaml` (gitignored) — deep-merged over the committed config, wins
  on conflict. For account-specific values that must not be committed.
- `.waffle/extensions/agents/<name>.md`, `.waffle/extensions/skills/<name>.md`
  (committed, optional) — appended to the rendered item inside marked
  `<!-- BEGIN/END project extension -->` comments. This is the supported way to add
  project-specific guidance to a toolkit item.
- `.waffle/waffle.lock.json` (generated, committed) — manifest of every rendered file with
  its hash. It is **canonical**: hashed from the committed inputs only, with
  `waffle.local.yaml` excluded, so it is byte-identical on every machine and safe to share.
  `wafflestack doctor` diffs reality against it; `wafflestack render` regenerates
  everything verbatim and deletes previously-managed files that are no longer rendered.
  It is also what tells *your* managed files apart from a hand-written file at the same
  path: `render` refuses to overwrite a pre-existing file that the lock does not track
  (see *Pre-existing (unmanaged) file collisions* below), unless you pass `--force`.
  `wafflestack doctor --allow-missing` treats absent managed files as informational (only
  *modified* files fail) — for use as a CI drift gate in repos that deliberately gitignore
  some renders; a missing lock still fails, since that means the repo was never rendered.
  `wafflestack doctor --verify-render` goes further: it re-renders the committed config
  into a temp dir (the working tree is never touched) and checks the result against this
  lock — catching a config or extension edit that was never re-rendered, which the plain
  check misses because the files and the lock go stale *together*. `--allow-missing
  --verify-render` is therefore the gate for a repo that gitignores its whole render.
- `.waffle/waffle.local.lock.json` (generated, gitignored) — manifest of the render *this
  machine* actually wrote. It exists only while `waffle.local.yaml` changes an output byte
  (and is removed when that stops). Working-tree checks — `doctor` drift, `list`,
  `render`'s prune and overwrite bookkeeping — read it in preference to the committed
  lock, so a hand-edit is still caught locally while the committed lock stays canonical
  and your private overlay values never reach a teammate or CI through it.
- `.waffle/CHEATSHEET.md`, `.waffle/TEAM.md`, `.waffle/cheatsheet.html`, `.waffle/team.html`
  (generated) — overview docs describing the installed selection (see *Generated overview
  docs* below). Managed like any rendered output: lock-tracked, drift-flagged, refreshed and
  pruned by `render`. Commit them; never hand-edit them.

## How do I know a file is wafflestack-managed?

Rendered files sit side-by-side with your hand-written ones — `.claude/agents/*.md` next to
your own agents, `.github/workflows/*.yml` next to your own workflows. The question "is *this*
file toolkit-generated or mine?" is answered by **the lock manifest, not by the filename**.

- **`.waffle/waffle.lock.json` is the marker.** Its `files` map records every rendered file by
  **repo-relative path → content hash**. A path present in that map is wafflestack-managed;
  a path absent from it is yours. This is authoritative and complete — it covers **all three
  render kinds** (agents, skills, and syrup `files/`) uniformly, including files that land at
  load-bearing platform paths. (On a machine where `waffle.local.yaml` changed an output
  byte, the gitignored `waffle.local.lock.json` carries the hashes of what is actually on
  disk — same `files` shape, same query — while the committed lock stays canonical.)
- **`render` enforces it.** Before writing, the renderer refuses to overwrite a pre-existing
  file the lock does **not** track — your hand-written file is never silently clobbered (a
  byte-identical file is adopted silently; `--force` overwrites; see *Pre-existing (unmanaged)
  file collisions* below). Conversely, a locked path that a later render no longer produces is
  pruned. So the lock is kept honest in both directions on every render.
- **`doctor` verifies it.** `wafflestack doctor` diffs the tree against the lock and reports any
  **modified** (hand-edited) or **missing** managed file — drift detection over exactly the set
  the lock defines.

**The practical query.** To decide whether a specific path is managed, check whether that
repo-relative path is a key in `.waffle/waffle.lock.json` — e.g. `jq -e --arg p
".claude/agents/architect.md" '.files[$p]' .waffle/waffle.lock.json`. To confirm the whole
managed tree is intact and unedited, run `wafflestack doctor`. If a file **is** managed and you
want to take it over, `wafflestack eject <ref>` hands it to your project (it stays in place and
stops receiving updates).

**Why not a filename convention (e.g. `.wfl.md`)?** A naming suffix was considered as a visual
marker and **deliberately rejected** — filenames are load-bearing for platform discovery, so a
suffix cannot be applied uniformly:

- **Skills can't carry it.** Claude Code (and the [Agent Skills](https://agentskills.io)
  standard) discovers a skill by a directory containing a file named **exactly `SKILL.md`**;
  `SKILL.wfl.md` breaks discovery. The toolkit loader hard-requires that name too.
- **Syrup `files/` can't carry it.** They render verbatim to real load-bearing paths — a GitHub
  Actions workflow *must* live at `.github/workflows/<name>.yml`; renaming it breaks the
  platform.
- **Only agents could plausibly carry it.** Claude Code identifies a subagent by its frontmatter
  `name`, not its filename ("the filename doesn't have to match"), and scans `.claude/agents/`
  for Markdown files — so `<name>.wfl.md` would likely be tolerated on the `claude` and
  `agents-dir` targets (the `codex` target renders `.toml`, unaffected). But that covers **one of
  three render kinds**: a suffix could never be the universal "is this managed?" signal, so it
  would leave most managed files unmarked while still costing a breaking lock-path migration
  (every agent's tracked path renames). The lock manifest already answers the question
  authoritatively for every kind, so a partial, cosmetic filename marker earns its migration
  cost nowhere. Provenance lives in the manifest, not the filename.

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

## External stack sources

A `stacks:` entry is normally a **bare stack name** resolved against the built-in toolkit
(`stacks/<name>`). An entry may instead be a **mapping** that declares where the stack comes
from — a git URL or a local path — so a project can pull in a third-party stack alongside the
built-in ones:

```yaml
stacks:
  - github-workflow                    # bare name → built-in toolkit (unchanged)
  - name: acme-process                 # external stack from a pinned git source
    source: https://github.com/acme/waffle-stacks
    ref: v1.2.0
  - name: local-experiments           # external stack from a local path
    source: ../shared-stacks/local-experiments
```

Mapping fields:

- **`name`** (required) — the stack name. It must be **unique across every `stacks:` entry**,
  built-in and external alike; a duplicate is a hard error, never a silent shadow.
- **`source`** (required) — a **git URL** (`https://…`, `git://…`, `ssh://…`, `git@host:owner/repo`,
  or any address ending in `.git`) or a **local filesystem path** (relative or absolute).
  Anything with a URL scheme, an scp-style `user@host:` prefix, or a `.git` suffix is treated as
  git; everything else is a local path.
- **`ref`** (git sources: **required**; local paths: **must be omitted**) — the pin for a git
  source: a tag, branch, or commit. Pinning is mandatory so an external install is reproducible.
  A local path is used as-is and carries no `ref`.

An unknown key on the mapping (a `pin:` or `rev:` typo, say) is rejected rather than silently
ignored. A malformed entry — missing `name`/`source`, an unpinned git source, a `ref` on a
local path, or a duplicate name — fails config load loudly with a message naming the entry.

> **How it resolves.** At `render`, each `source`-bearing entry is resolved to a toolkit root and
> merged with the built-in stacks through one pipeline, so external stacks/waffles render, lock,
> and `doctor` exactly like built-in ones. A git source is fetched at the pinned `ref` (tag,
> branch, or commit) and cached; a local path is read in place. The entry's `name` selects a stack
> from that root — `stacks/<name>/` for a toolkit-root source, or a `stack.yaml` at the source root
> for a single-stack source. A stack name defined by two sources (a built-in and an external, or
> two externals) is a **hard error naming both**, never a silent shadow. Recording each source's
> resolved commit in the lock, per-source `doctor`/`upgrade`, install-time trust confirmation, and
> third-party authoring docs are tracked as follow-up sub-issues of #88.

**Authoring an external stack.** For the third-party author's side — the repo layout a `source`
must present, cutting versions and how consumers pin a `ref`, carrying consumers across changes,
and a worked minimal example — see
[AUTHORING-EXTERNAL-STACKS.md](AUTHORING-EXTERNAL-STACKS.md).

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
placeholders pass through verbatim.

(`git.botName`, `git.botEmail`, `git.signingKey` and `git.agentIdentities` are since declared
first-class in the github-workflow stack, with placeholder defaults — so **all four** now fall back
to their defaults rather than passing through. Mind `git.signingKey`: its default is the **empty
string**, so referencing `{{git.signingKey}}` without defining it renders
`git -c user.signingkey= …` — a silent failure that git surfaces only when the command actually
signs, and under a non-signing recipe never at all — where an
undeclared key would have left the obviously broken literal `{{git.signingKey}}` behind. The
undeclared-path expansion above is what makes any *genuinely* undeclared overlay key work.)

A declared `pattern:` is enforced on the fully-expanded value **wherever the key is substituted —
including nested composition**. `git.cmd: git -c user.email={{git.botEmail}}` validates
`git.botEmail` against its pattern even though the canonical text never names that key at top
level. `pattern:` applies to string scalars only; a key whose value is a **map** declares
**`entryPatterns:`** to guard its entries' leaves (`git.agentIdentities` does). Leaves never
*inherit* a sibling scalar's pattern — `entryPatterns` restates it deliberately. A **list**-valued
key is still unguarded by either.

Avoid config key names that collide with literal template syntax you embed in values (e.g. don't
declare a `secrets.*` namespace).

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
| `harness.agentsDir` | `.claude/agents` | `.agents/agents` | `.agents/agents` |

`harness.agentsDir` names the **Markdown** agent definitions, which is what content reading an
agent's frontmatter by path (`identity.displayName`) needs. codex therefore points at
`.agents/agents` rather than the `.codex/agents/<name>.toml` it emits — the TOML has no shape for
`identity`. A **codex-only** render emits no such Markdown at all, and consumers must fall back
(the `delegate` skill title-cases the slug). codex and agents-dir must keep identical `harness.*`
values: the shared `.agents/skills/<name>` render is deduped on that premise.

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

`skillsDir` and `agentsDir` are **injection-guarded** (`^[A-Za-z0-9._/-]+$`): both splice into
instructions an agent then acts on — `read {{harness.agentsDir}}/<slug>.md` — so an override
carrying a space, quote, `$`, or newline fails the render rather than reshaping the instruction.

The namespace also carries three **target-independent** keys that pin the CI workflow
dispatcher, so a consumer can repin or repoint the harness action without ejecting the
rendered workflow:

| Key | default |
|---|---|
| `harness.actionRef` | `anthropics/claude-code-action` |
| `harness.actionVersion` | the current pinned SHA, with its `# vX.Y.Z` comment preserved |
| `harness.apiKeySecret` | `ANTHROPIC_API_KEY` |

These splice into the `uses:` and `anthropic_api_key:` lines of `waffle-label-hook.yml` and
`waffle-hygiene.yml`. Override `config.harness.actionVersion` to pin a different version of
the same action (or `actionRef` to repoint it, `apiKeySecret` to rename the billing secret);
the defaults reproduce today's action byte-for-byte, so an unconfigured repo stays
doctor-clean. They are injection-guarded at render — an override carrying `${{`, a quote, or a
newline (or, for `apiKeySecret`, anything outside a GitHub secret name) fails the render loudly
rather than corrupting the workflow.
