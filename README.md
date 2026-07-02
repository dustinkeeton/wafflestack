# wafflestack

Reusable AI agent and skill definitions, distributed shadcn-style but **update-safe**: one
canonical source repo, rendered into harness-native files inside each consuming project.
Supported harnesses: Claude Code (`.claude/agents`, `.claude/skills`), OpenAI Codex
(`.codex/agents/*.toml`), and the cross-tool agents dir (`.agents/skills`).

## Install into a project

**Guided (recommended)** — let your coding agent (Claude Code, Codex, …) do the whole
setup. Tell it *"set up wafflestack in this repo"* and have it start from:

```bash
npx github:dustinkeeton/wafflestack setup
```

`setup` prints an agent playbook plus an inventory of every bundle, config key, env
prerequisite, and service-side setup note — generated from the installed toolkit
version. The agent then detects targets and project commands, asks you which bundles
to enable, fills `.wafflestack.yaml`, verifies externals (e.g. `gh` auth and labels),
renders, runs `doctor`, and reports what it did.

**Manual:**

```bash
cd your-project
npx github:dustinkeeton/wafflestack init     # writes a starter .wafflestack.yaml
# edit .wafflestack.yaml: pick bundles, fill in config values
npx github:dustinkeeton/wafflestack render   # renders all harness files + lock manifest
```

Pin a version with `npx github:dustinkeeton/wafflestack#v0.1.0 render`.

## Commands

| Command | What it does |
|---|---|
| `init` | Write a starter `.wafflestack.yaml` (won't overwrite an existing one). |
| `setup` | Print the agent-driven install playbook + generated toolkit inventory (see above). |
| `render` (alias `install`) | Regenerate every managed file verbatim from source + config; delete managed files that are no longer rendered; write `.wafflestack.lock.json`. |
| `doctor` | Diff managed files against the lock manifest; report local edits, missing files, and env prerequisites. Exit 1 on drift. |
| `eject <item>` | Stop managing an item (e.g. `skills/issue`): its rendered files stay put and become project-owned. |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter is complete, every `{{placeholder}}` is declared. |

## Rules of the road

1. **Never edit rendered files** — `render` will overwrite them. Put project additions in
   `.wafflestack/extensions/{agents,skills}/<name>.md` (appended to the rendered item)
   and project parameters in `.wafflestack.yaml`.
2. **Account-specific values** (bot identities, board IDs) go in `.wafflestack.local.yaml`,
   which is gitignored and merged over the committed config. Config values may reference
   other keys with `{{...}}` (nested substitution) — so a committed value can point at a
   key kept in the local overlay.
3. **Updates are re-renders.** `npx github:dustinkeeton/wafflestack#<newtag> render`
   regenerates everything; your config and extensions survive untouched.
4. `doctor` tells you when local edits have crept into managed files.

Format details: [schema/FORMAT.md](schema/FORMAT.md).
