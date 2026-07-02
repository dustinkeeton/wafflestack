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
  files/<repo-rel-path>      generic project files (CI workflows, scripts, config)
installer/                   the render CLI (`wafflestack`)
schema/                      this document
```

Three payload types share the same render machinery — **agents** and **skills** target
harness dirs (`.claude/`, `.codex/`, `.agents/`), while **files** render to an arbitrary
repo-relative path. All three get `{{key}}` substitution, lock tracking, `doctor` drift
detection, and `eject`.

## bundle.yaml

```yaml
name: github-workflow
description: One-line description of the bundle.
agents: [architect, security]        # files under agents/, without .md
skills: [git-workflow, issue]        # directories under skills/
files:                               # generic files under files/, by repo-relative path
  - .github/workflows/release.yml
  - scripts/check-format.mjs
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

## Files definition (`files/<repo-relative-path>`)

For reusable project scaffolding that lives at an arbitrary repo path rather than in a
harness dir — CI workflows, helper scripts, shared config. Each entry in the manifest's
`files:` list is a **repo-relative path** under the bundle's `files/` directory; it renders
**verbatim to that same path** in the consuming project.

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

Same frozen-image contract as everything else: tracked in `.waffle.lock.json`, restored
verbatim by `render`, drift-flagged by `doctor`, and releasable with
`wafflestack eject files/<repo-relative-path>` (the file stays in place and becomes
project-owned). Two enabled bundles that emit the **same** repo path is a hard render error —
the same cross-bundle conflict rule as same-named skills; enable one or `eject` one.

**GitHub Actions caveat.** A `${{ ... }}` expression (leading `$`) is **not** a wafflestack
placeholder — only `{{ ... }}` without a `$` is. Workflow expressions like
`${{ secrets.GITHUB_TOKEN }}` and `${{ github.sha }}` therefore pass through untouched and are
not policed by `validate`; use a plain `{{key}}` where you want the toolkit to substitute.
Note also that files under `.github/workflows/` cannot be written by GitHub Actions' default
`GITHUB_TOKEN` (that needs the `workflow` scope) — a non-issue for the local `render` flow,
but relevant if you ever render from CI.

## Consuming project contract

- `.waffle.yaml` (committed) — version pin, `targets:` (`claude`, `codex`,
  `agents-dir`), `bundles:`, optional `include:` (individual items), `config:` values,
  optional `eject:` list.
- `.waffle.local.yaml` (gitignored) — deep-merged over the committed config, wins
  on conflict. For account-specific values that must not be committed.
- `.waffle/extensions/agents/<name>.md`, `.waffle/extensions/skills/<name>.md`
  (committed, optional) — appended to the rendered item inside marked
  `<!-- BEGIN/END project extension -->` comments. This is the supported way to add
  project-specific guidance to a toolkit item.
- `.waffle.lock.json` (generated) — manifest of every rendered file with its hash.
  `wafflestack doctor` diffs reality against it; `wafflestack render` regenerates
  everything verbatim and deletes previously-managed files that are no longer rendered.
  It is also what tells *your* managed files apart from a hand-written file at the same
  path: `render` refuses to overwrite a pre-existing file that the lock does not track
  (see *Pre-existing (unmanaged) file collisions* below), unless you pass `--force`.
  `wafflestack doctor --allow-missing` treats absent managed files as informational (only
  *modified* files fail) — for use as a CI drift gate in repos that deliberately gitignore
  some renders; a missing lock still fails, since that means the repo was never rendered.

## Selecting what renders

The rendered set is `union(items of bundles:) ∪ include: − eject:`.

- `bundles:` — whole bundles; every agent and skill in them renders.
- `include:` — individual items you want without adopting their whole bundle. Each entry
  is a **ref**:
  - a bundle name — `github-workflow` (equivalent to listing it in `bundles:`);
  - an item — `skills/<name>`, `agents/<name>`, or `files/<repo-relative-path>`;
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
Missing **required** keys fail the render with a list of what to add. A `$`-prefixed
`${{ ... }}` (GitHub Actions / shell-template syntax) is **not** a placeholder — it is left
untouched everywhere, so workflow expressions survive rendering and `validate`.

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

can reference keys kept in the gitignored `.waffle.local.yaml`. Unresolvable nested
placeholders pass through verbatim. Avoid config key names that collide with literal
template syntax you embed in values (e.g. don't declare a `secrets.*` namespace).

### Item-name collisions

Two bundles may define items with the same name — alternative implementations of the same
skill interface (e.g. the desktop-plugin vs. browser-app `security-audit`). Enabling both
in one project is an error: the renderer refuses to render the same output path from two
bundles instead of silently letting the last one win. Pick one, or `eject` one.

### Pre-existing (unmanaged) file collisions

`render` will not overwrite a file it did not write. A path a render would produce that
already exists on disk but is **not** tracked by `.waffle.lock.json` — a hand-written
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
