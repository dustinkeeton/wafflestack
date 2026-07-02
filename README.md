<p align="center">
  <img src="assets/wafflestack-hero.svg" width="150" alt="WaffleStack — a stack of golden waffles with a syrup pour">
</p>

<h1 align="center">WaffleStack</h1>

<p align="center"><strong>One batter, every repo.</strong><br>
Reusable AI agent and skill definitions, distributed shadcn-style but <strong>update-safe</strong>.</p>

---

One canonical source repo, rendered into harness-native files inside each consuming
project — the same batter, baked fresh wherever you need it. Supported harnesses:
Claude Code (`.claude/agents`, `.claude/skills`), OpenAI Codex (`.codex/agents/*.toml`),
and the cross-tool agents dir (`.agents/skills`).

Bundles carry three payload types: **agents** and **skills** (rendered into those harness
dirs) and generic **files** — CI workflows, scripts, or config rendered verbatim to any
repo-relative path (`.github/workflows/…`, `scripts/…`), with the same `{{key}}`
substitution, lock tracking, and drift detection.

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
| `render` | Regenerate every managed file verbatim from source + config; delete managed files that are no longer rendered; write `.wafflestack.lock.json`. |
| `install [ref…]` | With refs: add them to `.wafflestack.yaml` (bundle name → `bundles:`, item → `include:`), pull in their dependencies, then render. Refs are a bundle name, `skills/<name>`, `agents/<name>`, or `<bundle>/skills/<name>` (qualify when a name is in two bundles). Bare `install` = `render`. |
| `doctor` | Diff managed files against the lock manifest; report local edits, missing files, and env prerequisites. Exit 1 on drift. Add `--allow-missing` to tolerate absent renders (a CI drift gate for repos that gitignore some outputs): only *modified* files fail, missing ones are informational. |
| `eject <item>` | Stop managing an item (e.g. `skills/issue`, `agents/name`, `files/.github/workflows/ci.yml`): its rendered files stay put and become project-owned; also drops it from `include:`. |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter is complete, every `{{placeholder}}` is declared, and agent `skills:` / `requires:` refs resolve. |

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
4. `doctor` tells you when local edits have crept into managed files, and doubles as a
   **CI drift gate** — run `npx github:dustinkeeton/wafflestack doctor` on PRs to fail the
   build if any managed file was hand-edited. When a repo deliberately gitignores some
   renders (so they're legitimately absent in a fresh CI checkout), add `--allow-missing`:
   absent files are then reported informationally and only *modified* files fail the gate. A
   missing lock still fails — that means the repo was never rendered, which the flag won't mask.

Format details: [schema/FORMAT.md](schema/FORMAT.md). Brand assets and guidelines:
[assets/](assets/).

## License

© 2026 Dustin Keeton. Licensed under the [Apache License, Version 2.0](LICENSE).

---

<p align="center">
  <img src="assets/wafflestack-flat.svg" width="24" alt=""><br>
  A <strong>WaffleWorks</strong> project — controlled fun, one waffle at a time.
</p>
