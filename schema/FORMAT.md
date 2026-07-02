# Toolkit format reference

The toolkit holds **canonical, harness-neutral definitions** of agents and skills, grouped
into bundles. The installer renders them into harness-native files inside a consuming
project. Rendered files are **generated output** — never edit them; change the source here,
project config, or a project extension file instead.

## Repository layout

```
toolkit.yaml                 registry: name + list of bundles
bundles/<bundle>/
  bundle.yaml                bundle manifest (see below)
  agents/<name>.md           neutral agent definitions
  skills/<name>/SKILL.md     neutral skill definitions (+ supporting files)
installer/                   the render CLI (`wafflestack`)
schema/                      this document
```

## bundle.yaml

```yaml
name: github-workflow
description: One-line description of the bundle.
agents: [architect, security]        # files under agents/, without .md
skills: [git-workflow, issue]        # directories under skills/
requires:                            # optional per-item dependency declarations
  skills/issue:                      # keyed by item ref (skills/<name> | agents/<name>)
    - skills/git-workflow            # refs pulled in when this item is installed alone
config:                              # template keys this bundle may reference
  git.botEmail:
    required: true
    description: Committer email used for automated commits.
  project.buildCmd:
    required: false
    default: npm run build
    description: Production build command run in preflight checks.
env:                                 # env vars the bundle's content depends on
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"
setup: |-                            # optional, agent-facing install notes
  Service-side prerequisites and how to verify/create them (CLI auth, labels, boards).
```

Only keys **declared** in `config:` are substituted in this bundle's content — any other
`{{...}}`-looking text (bash, GraphQL, JS templates) passes through untouched.

`requires:` formalizes cross-item dependencies that would otherwise be prose-only (a
skill telling the reader to "see the `github-project-management` skill"). Each key is an
item ref (`skills/<name>` / `agents/<name>`) defined in this bundle; each value is a list
of item refs it depends on, resolved against the **whole toolkit** (prefer this bundle,
then a unique toolkit-wide match; qualify as `<bundle>/skills/<name>` when the name is
ambiguous). When that item is installed individually, its `requires:` closure is pulled in
transitively. Agent → skill dependencies need no `requires:` — they come from the agent's
frontmatter `skills:` list. `validate` checks every `requires:` ref resolves.

`setup:` is free text surfaced verbatim by `wafflestack setup` (the agent-driven install
playbook, `schema/SETUP.md`, followed by a generated inventory of every bundle's items,
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

## Consuming project contract

- `.wafflestack.yaml` (committed) — version pin, `targets:` (`claude`, `codex`,
  `agents-dir`), `bundles:`, optional `include:` (individual items), `config:` values,
  optional `eject:` list.
- `.wafflestack.local.yaml` (gitignored) — deep-merged over the committed config, wins
  on conflict. For account-specific values that must not be committed.
- `.wafflestack/extensions/agents/<name>.md`, `.wafflestack/extensions/skills/<name>.md`
  (committed, optional) — appended to the rendered item inside marked
  `<!-- BEGIN/END project extension -->` comments. This is the supported way to add
  project-specific guidance to a toolkit item.
- `.wafflestack.lock.json` (generated) — manifest of every rendered file with its hash.
  `wafflestack doctor` diffs reality against it; `wafflestack render` regenerates
  everything verbatim and deletes previously-managed files that are no longer rendered.

## Selecting what renders

The rendered set is `union(items of bundles:) ∪ include: − eject:`.

- `bundles:` — whole bundles; every agent and skill in them renders.
- `include:` — individual items you want without adopting their whole bundle. Each entry
  is a **ref**:
  - a bundle name — `github-workflow` (equivalent to listing it in `bundles:`);
  - an item — `skills/<name>` or `agents/<name>`;
  - a bundle-qualified item — `<bundle>/skills/<name>`, needed only when the same item
    name is defined in more than one bundle (e.g. `security-audit`).
  Installing an item pulls its **dependency closure** — an agent's frontmatter `skills:`
  and any `requires:` — transitively and across bundles. Required config is then scoped to
  the placeholders the selected items actually use, so a partial install never demands
  config that only unselected siblings need. Bundle `env:` prerequisites still warn when
  any item from that bundle renders.
- `eject:` — items to stop managing; wins over both `bundles:` and `include:`.

`wafflestack install <ref…>` performs this edit for you: it resolves each ref (failing on
unknown or ambiguous names, listing the qualified candidates), appends bundle refs to
`bundles:` and item refs to `include:` (comment-preserving, bundle-qualified only when
ambiguous), then runs a full render. Persisting the choice is required, not cosmetic — the
frozen-image contract deletes any locked file the next render doesn't reproduce, so an
un-persisted ad-hoc install would be silently removed. Dependency closure is recomputed
each render (not persisted), so it tracks upstream changes. `wafflestack eject skills/<name>`
also drops any matching `include:` entry so it isn't left orphaned.

## Template values

`{{key}}` looks up `key` as a dotted path in the merged `config:` maps. Strings substitute
verbatim; arrays of strings join with `, `; other structures render as a YAML block.
Missing **required** keys fail the render with a list of what to add.

### Nested substitution

A substituted **value** (project config or bundle default) may itself contain
`{{placeholders}}`, expanded recursively (depth-capped). Nested expansion only descends
into values — canonical text that survives the first pass (GitHub Actions `${{ ... }}`,
mustache examples) is never touched. Inside a value, anything resolvable is expanded:
declared keys, `harness.*`, and any dotted path present in the project config **even if
undeclared** — so a committed value like

```yaml
git:
  cmd: git -c user.email={{git.botEmail}} -c user.name={{git.botName}}
```

can reference keys kept in the gitignored `.wafflestack.local.yaml`. Unresolvable nested
placeholders pass through verbatim. Avoid config key names that collide with literal
template syntax you embed in values (e.g. don't declare a `secrets.*` namespace).

### Item-name collisions

Two bundles may define items with the same name — alternative implementations of the same
skill interface (e.g. the desktop-plugin vs. browser-app `security-audit`). Enabling both
in one project is an error: the renderer refuses to render the same output path from two
bundles instead of silently letting the last one win. Pick one, or `eject` one.

### The `harness.*` namespace

`harness.*` is a reserved, **always-available** namespace (never declared in a bundle's
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
