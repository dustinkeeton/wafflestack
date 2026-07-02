# agent-toolkit

Reusable AI agent and skill definitions, distributed shadcn-style but **update-safe**: one
canonical source repo, rendered into harness-native files inside each consuming project.
Supported harnesses: Claude Code (`.claude/agents`, `.claude/skills`), OpenAI Codex
(`.codex/agents/*.toml`), and the cross-tool agents dir (`.agents/skills`).

## Install into a project

```bash
cd your-project
npx github:dustinkeeton/agent-toolkit init     # writes a starter .agent-toolkit.yaml
# edit .agent-toolkit.yaml: pick bundles, fill in config values
npx github:dustinkeeton/agent-toolkit render   # renders all harness files + lock manifest
```

Pin a version with `npx github:dustinkeeton/agent-toolkit#v0.1.0 render`.

## Commands

| Command | What it does |
|---|---|
| `init` | Write a starter `.agent-toolkit.yaml` (won't overwrite an existing one). |
| `render` (alias `install`) | Regenerate every managed file verbatim from source + config; delete managed files that are no longer rendered; write `.agent-toolkit.lock.json`. |
| `doctor` | Diff managed files against the lock manifest; report local edits, missing files, and env prerequisites. Exit 1 on drift. |
| `eject <item>` | Stop managing an item (e.g. `skills/issue`): its rendered files stay put and become project-owned. |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter is complete, every `{{placeholder}}` is declared. |

## Rules of the road

1. **Never edit rendered files** — `render` will overwrite them. Put project additions in
   `.agent-toolkit/extensions/{agents,skills}/<name>.md` (appended to the rendered item)
   and project parameters in `.agent-toolkit.yaml`.
2. **Account-specific values** (bot identities, board IDs) go in `.agent-toolkit.local.yaml`,
   which is gitignored and merged over the committed config.
3. **Updates are re-renders.** `npx github:dustinkeeton/agent-toolkit#<newtag> render`
   regenerates everything; your config and extensions survive untouched.
4. `doctor` tells you when local edits have crept into managed files.

Format details: [schema/FORMAT.md](schema/FORMAT.md).
