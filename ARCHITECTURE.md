# Architecture

How wafflestack is put together, in plain language. For the exact format rules
the toolkit enforces, see the owner-voiced [schema/FORMAT.md](schema/FORMAT.md).
For decisions and current state, see [DECISIONS.md](DECISIONS.md) and
[STATUS.md](STATUS.md).

## What wafflestack is

wafflestack is a **library of reusable AI-agent and skill definitions** and a
tool that copies them into your project. You write the definition once, in a
neutral format, and the tool *renders* it into whatever files your coding
assistant expects — Claude Code, OpenAI Codex, or the cross-tool agents
directory.

The trick is that it works like [shadcn/ui](https://ui.shadcn.com/): the files
land **in your repo, owned by you**, but you can re-render at any time to pull in
upstream updates without losing your local configuration. Think of it as a
compiler — neutral source in, harness-native files out.

## The big picture

```
  SOURCE (this repo)                  RENDER                 YOUR PROJECT
  ─────────────────                   ──────                 ────────────
  toolkit.yaml         ┐
  bundles/<name>/      │   wafflestack render      .claude/agents/*.md
    bundle.yaml        ├──────────────────────►    .claude/skills/*/
    agents/*.md        │   (fill placeholders,     .codex/agents/*.toml
    skills/*/SKILL.md  │    resolve per target,    .agents/skills/*/
  schema/FORMAT.md     ┘    append extensions)     .waffle/waffle.lock.json

              ▲                                            │
              │            your settings                   │
              └──── .waffle/waffle.yaml  ◄────────────┘
                    .waffle/waffle.local.yaml  (config + secrets)
                    .waffle/extensions/        (your additions)
```

Source goes in; the installer fills in your project's values and writes
harness-native files plus a lock manifest. Your config and extensions are the
only inputs you own — everything under `.claude/` (etc.) is generated.

## The core pieces

### Bundles

A **bundle** is a themed group of agents and skills you enable together (for
example `github-workflow` or `docs-system`). `toolkit.yaml` lists every bundle;
each bundle's `bundle.yaml` manifest declares its agents, skills, config keys, and
any environment or service prerequisites. There are **8 bundles** today.

### Picking what to install

You don't have to take a whole bundle. A **ref** names something installable. An
item is one of three kinds — an `agents/` definition, a `skills/` definition, or a
`files/` payload (a workflow or script copied to a repo-relative path):

| Ref | Example | Means |
|-----|---------|-------|
| bundle | `github-workflow` | the whole bundle |
| item | `skills/issue`, `agents/project-manager`, `files/.github/workflows/waffle-hygiene.yml` | one item (the name/path must be unique across the toolkit) |
| qualified item | `engineering-team/skills/webapp-security-audit` | one item in a named bundle — use this when the same name exists in two bundles |

`wafflestack install <ref…>` records your choice in `.waffle/waffle.yaml`
(bundles in the `bundles:` list, single items in an `include:` list) and then renders.

**Dependencies resolve automatically** — installing an item pulls in whatever it
needs, transitively and across bundles:

- an **agent** pulls the skills in its frontmatter `skills:` list (names the
  toolkit doesn't ship — for example a project-local skill — are skipped);
- a bundle's optional **`requires:`** map pulls declared dependencies (e.g. the
  `/delegate` skill pulls in `git-workflow` and `github-project-management`).

The final rendered set is:

```
union(items of bundles:)  ∪  closure(each include: item)  −  eject:
```

`eject:` wins over both lists, and required config is scoped to only the
placeholders your selected items actually use — so a one-item install doesn't
demand config that its unselected siblings need.

**Syrup — an opt-in gate for sensitive items.** A bundle can mark certain `files/`
payloads (the label-hook, hygiene, and release workflows — the ones that hold repo
write permissions or spend API budget) as **syrup**. Enabling the bundle does *not*
render them. They render only when you install the ref explicitly or when your repo
already tracks the file in its lock. That way an existing install keeps getting
updates, but a fresh enable never silently arms a workflow you didn't ask for.

### Agents and skills

- **Agent** — a specialist persona with instructions (e.g. a documentation
  writer, a security reviewer). Defined as a Markdown file with a small YAML
  header.
- **Skill** — a reusable capability or playbook an agent can invoke (e.g.
  "create a GitHub issue," "run the git workflow"). Defined as a `SKILL.md` plus
  any supporting files.

Both are written **harness-neutral** — no Claude- or Codex-specific wording — so
one source can render everywhere. There are **14 agents and 21 skills** in total.

### Targets (harnesses)

A **target** is a coding assistant you render for. Three are supported:

| Target | Renders to | Notes |
|--------|-----------|-------|
| `claude` | `.claude/agents/`, `.claude/skills/` | Claude Code |
| `codex` | `.codex/agents/*.toml` | OpenAI Codex (agents only) |
| `agents-dir` | `.agents/skills/` | Cross-tool convention (skills only) |

The small per-harness differences (like whose name goes in an attribution line)
come from a reserved `harness.*` set of values that resolve differently per
target — so the *same* source file renders correctly for each.

### Templates and placeholders

Source files contain `{{placeholders}}` like `{{project.name}}`. At render time
the installer substitutes the values you set in config. Two rules keep this safe:

- **Only declared keys are substituted.** Any other `{{...}}`-looking text (bash
  `${...}`, GitHub Actions `${{ }}`, mustache) passes through untouched.
- **Substitution is recursive** (up to 4 levels). A committed value can point at
  a key you keep in your gitignored local file — so secrets stay out of git while
  the template stays in.

### The installer (render pipeline)

The `wafflestack` CLI lives in `installer/` (plain Node.js ES modules, one
runtime dependency: `yaml`). Its jobs, in one line each:

| Command | What it does |
|---------|--------------|
| `init` | Write a starter `.waffle/waffle.yaml`. |
| `setup` | Print the agent-driven install playbook + a generated inventory. On an already-configured repo, also prints a live "Current configuration — update mode" section. |
| `install <ref…>` | Add a bundle or single item to your config (pulling in dependencies), then render. `--force` overrides the overwrite guard. Bare `install` just renders. |
| `render` | Regenerate every managed file, delete stale ones, write the lock. Refuses to overwrite a pre-existing untracked file without `--force`. |
| `upgrade` | Read the lock's version, print the `CHANGELOG.md` delta, run any migrations, then re-render + `doctor`. |
| `doctor` | Compare rendered files to the lock; report drift or missing files. |
| `eject <skills/NAME\|agents/NAME\|files/PATH>` | Stop managing an item — its files stay and become project-owned. |
| `validate` | Toolkit-author lint: manifests parse, placeholders are declared, refs resolve. |

Under the hood, `installer/lib/` holds 13 small modules (load the toolkit, load
project config, substitute templates, render, diff against the lock, etc.). The
full function-level registry is in the root `AGENTS.md`.

## How the pieces interact

A render is a straight-line flow:

1. **Load** `toolkit.yaml` and each enabled bundle's manifest.
2. **Load** your project config (`.waffle/waffle.yaml`, plus the gitignored
   `.waffle/waffle.local.yaml` merged on top).
3. **Select** what to render: every item in your `bundles:`, plus each `include:`
   item and its dependency closure, minus anything in `eject:`.
4. For every selected item and every target, **substitute** placeholders and
   **append** any project extension.
5. **Write** the harness-native files and record each file's hash in
   `.waffle/waffle.lock.json`.
6. **Prune** any previously-managed file that is no longer rendered.

Two safety checks guard the write step: two enabled sources emitting the *same*
output path is a hard error (never last-write-wins), and a render that would
overwrite a pre-existing file the lock doesn't track (a consumer's hand-written
file) is refused before any write — a byte-identical file is adopted silently, and
`--force` overrides the guard.

Later, `doctor` re-hashes the files and compares them to the lock — that is how it
knows if someone hand-edited a generated file or an update changed the output.

## Configuration overview

Everything a consuming project owns:

| File | Tracked in git? | Purpose |
|------|-----------------|---------|
| `.waffle/waffle.yaml` | ✅ committed | Version pin, targets, enabled bundles, individual items (`include`), config values, `eject` list |
| `.waffle/waffle.local.yaml` | 🚫 gitignored | Account-specific values (bot identity, board IDs); merged over the committed config and wins |
| `.waffle/extensions/{agents,skills}/<name>.md` | ✅ committed | Your own text, appended to a rendered item inside marker comments |
| `.waffle/waffle.lock.json` | generated | Map of each rendered file to its hash; `doctor` reads it, `render` rewrites it |

**Rule of thumb:** never edit files under `.claude/` (etc.) — a re-render will
overwrite them. Change source, config, or an extension instead.

## How this repo uses itself

wafflestack **dogfoods** its own bundles: `.waffle/waffle.yaml` here renders
`github-workflow`, `docs-system`, `orchestration`, and `harness-architect` into
this repo, so the toolkit's own agents and skills are available while developing
it. It also arms two syrup workflows via `include:` — the hygiene and release
hooks.

The rendered output (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json`)
and the lock (`.waffle/waffle.lock.json`) are **committed**, exactly like a real
consuming project. Two reasons: the CI hygiene harness reads the committed skills,
and the `waffle-doctor` drift gate (a required check on `main`) can only compare
against a render + lock that live in git. So after any `bundles/**` change you must
**re-render and commit** the updated files:

```bash
node installer/cli.mjs render
```

A few things stay deliberately untracked (and `doctor` runs with `--allow-missing`
to tolerate them): `.claude/worktrees/` (throwaway working state), `.codex/` and
`.agents/` (non-targets — this repo only renders `claude`), the
`waffle-label-hook.yml` workflow (committing it would arm a live label→harness
dispatch), and the generated `.waffle/` overview docs.

## Getting started (new contributors)

1. **Read the source, not the output.** Neutral definitions live in `bundles/**`
   and `schema/**`; the render CLI lives in `installer/**`. Anything under
   `.claude/`, `.codex/`, or `.agents/` is generated — don't edit it.
2. **Make changes to a bundle**, then **re-render**:
   ```bash
   node installer/cli.mjs render
   ```
3. **Verify before you push:**
   ```bash
   npm run validate      # manifests + placeholder checks
   npm test              # installer test suite
   node installer/cli.mjs doctor   # rendered output matches the lock
   ```
4. **Documentation is generated by agents.** The machine registry (`AGENTS.md`)
   and these human docs (`DECISIONS.md`, `STATUS.md`, `ARCHITECTURE.md`) are
   maintained by the `docs-system` bundle's agents. The owner-voiced
   `README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are edited by hand —
   don't rewrite them in a docs pass.
