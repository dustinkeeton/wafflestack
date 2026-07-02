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
installer/                   the render CLI (`agent-toolkit`)
schema/                      this document
```

## bundle.yaml

```yaml
name: github-workflow
description: One-line description of the bundle.
agents: [architect, security]        # files under agents/, without .md
skills: [git-workflow, issue]        # directories under skills/
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
```

Only keys **declared** in `config:` are substituted in this bundle's content — any other
`{{...}}`-looking text (bash, GraphQL, JS templates) passes through untouched.

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
`{{dotted.key}}`.

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

- `.agent-toolkit.yaml` (committed) — version pin, `targets:` (`claude`, `codex`,
  `agents-dir`), `bundles:`, `config:` values, optional `eject:` list.
- `.agent-toolkit.local.yaml` (gitignored) — deep-merged over the committed config, wins
  on conflict. For account-specific values that must not be committed.
- `.agent-toolkit/extensions/agents/<name>.md`, `.agent-toolkit/extensions/skills/<name>.md`
  (committed, optional) — appended to the rendered item inside marked
  `<!-- BEGIN/END project extension -->` comments. This is the supported way to add
  project-specific guidance to a toolkit item.
- `.agent-toolkit.lock.json` (generated) — manifest of every rendered file with its hash.
  `agent-toolkit doctor` diffs reality against it; `agent-toolkit render` regenerates
  everything verbatim and deletes previously-managed files that are no longer rendered.

## Template values

`{{key}}` looks up `key` as a dotted path in the merged `config:` maps. Strings substitute
verbatim; arrays of strings join with `, `; other structures render as a YAML block.
Missing **required** keys fail the render with a list of what to add.
