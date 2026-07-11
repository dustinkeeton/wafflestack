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
  stacks/<name>/      │   wafflestack render      .claude/agents/*.md
    stack.yaml        ├──────────────────────►    .claude/skills/*/
    agents/*.md        │   (fill placeholders,     .codex/agents/*.toml
    skills/*/SKILL.md  │    resolve per target,    .agents/agents/*.md
  schema/FORMAT.md     ┘    append extensions)     .agents/skills/*/
                                                   .waffle/waffle.lock.json

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

### Stacks

A **stack** is a themed group of agents and skills you enable together (for
example `github-workflow` or `docs-system`). `toolkit.yaml` lists every stack;
each stack's `stack.yaml` manifest declares its agents, skills, config keys, and
any environment or service prerequisites. There are **9 stacks** today — one of
them, `wafflestack`, is self-referential: eight `/waffle-*` skills, one per CLI
command, each a thin wrapper that runs `npx wafflestack <command>` and interprets
the output — so the toolkit ships its own lifecycle the same way it ships
everything else.

**A stack can also come from outside this toolkit.** A `stacks:` entry is usually a
built-in name, but it can instead be a `{ name, source, ref }` mapping that points at a
third-party stack — in another git repo (pinned to a `ref`) or at a local path. External
stacks render through the exact same pipeline as built-ins: the lock records where each
external file came from (source, ref, resolved commit), `doctor` attributes any drift back
to its source, `upgrade` re-fetches each pin and reports commit moves, and `render`
validates an external stack before writing a byte. See
[`schema/AUTHORING-EXTERNAL-STACKS.md`](schema/AUTHORING-EXTERNAL-STACKS.md) to author one.

### Prerequisites

Some stacks lean on things a copy-in install can neither provide nor verify — a CLI tool
like `gh`, a repo secret, a GitHub auth scope, a trigger label, a repo setting, or a running
service. A stack **declares** these as a typed `prerequisites:` list, each with a kind, a
one-line shell `check`, and a level of `require` or `recommend`. They are checked, not just
documented:

- **`doctor`** runs every selected stack's checks and **fails (exit 1) on an unmet
  `require`** — so a repo running the shipped `waffle-doctor` CI gate verifies its
  prerequisites on the same run. A `recommend` only reports.
- **`render`** warns for the cheap-to-probe kinds (a missing tool or env var), and **`setup`**
  lists the whole block so the install playbook can ask you to create the labels or set the
  secret.

This is separate from `requires:` (below): `requires:` wires up *other waffles* inside the
toolkit; `prerequisites:` names things in *your own environment*.

### Picking what to install

You don't have to take a whole stack. A **ref** names something installable. An
item is one of three kinds — an `agents/` definition, a `skills/` definition, or a
`files/` payload (a workflow or script copied to a repo-relative path):

| Ref | Example | Means |
|-----|---------|-------|
| stack | `github-workflow` | the whole stack |
| item | `skills/issue`, `agents/project-manager`, `files/.github/workflows/waffle-hygiene.yml` | one item (the name/path must be unique across the toolkit) |
| qualified item | `engineering-team/skills/webapp-security-audit` | one item in a named stack — use this when the same name exists in two stacks |

`wafflestack install <ref…>` records your choice in `.waffle/waffle.yaml`
(stacks in the `stacks:` list, single items in an `include:` list) and then renders.

**Dependencies resolve automatically** — installing an item pulls in whatever it
needs, transitively and across stacks:

- an **agent** pulls the skills in its frontmatter `skills:` list (names the
  toolkit doesn't ship — for example a project-local skill — are skipped);
- a stack's optional **`requires:`** map pulls declared dependencies (e.g. the
  `/delegate` skill pulls in `git-workflow`, `github-project-management`, and
  `github-project-board`).

The final rendered set is:

```
union(items of stacks:)  ∪  closure(each include: item)  −  eject:
```

`eject:` wins over both lists, and required config is scoped to only the
placeholders your selected items actually use — so a one-item install doesn't
demand config that its unselected siblings need.

**Opt-in syrup — a gate for sensitive syrup.** The generic `files/` payload is called
**syrup**; a stack can mark certain payloads (the label-hook, hygiene, and release
workflows — the ones that hold repo write permissions or spend API budget) as **opt-in
syrup** via the `optIn:` manifest key. Enabling the stack does *not* render them. They
render only when you install the ref explicitly or when your repo already tracks the file
in its lock. That way an existing install keeps getting updates, but a fresh enable never
silently arms a workflow you didn't ask for.

### Agents and skills

- **Agent** — a specialist persona with instructions (e.g. a documentation
  writer, a security reviewer). Defined as a Markdown file with a small YAML
  header.
- **Skill** — a reusable capability or playbook an agent can invoke (e.g.
  "create a GitHub issue," "run the git workflow"). Defined as a `SKILL.md` plus
  any supporting files.

Both are written **harness-neutral** — no Claude- or Codex-specific wording — so
one source can render everywhere. There are **14 agents and 32 skills** in total.

A skill's **supporting files** copy into your repo alongside its `SKILL.md`, and
they can do real work. The orchestration stack's `/delegate` skill is the
showcase: it ships three dependency-free Node scripts that act as deterministic
gates around the LLM's judgment —

- `checkpoint.mjs` + `checkpoint.schema.json` — each delegate run writes one JSON
  checkpoint, and the script validates it at **every phase boundary** (fetch →
  classify → plan → execute → report), cross-checking things like "the branch an
  agent pushed is the branch the plan assigned." A failure exits 1 and hard-stops
  the run instead of letting it drift.
- `memory.mjs` — guards a small, **curated, hard-capped** per-repo memory doc of
  lessons between runs (every entry needs a Why, a Since, and an Area). Over the
  byte cap, the run must *curate* the doc down — the script never truncates.

An opt-in config flag (`delegate.approveBeforePush`) adds a human gate on top:
agents commit locally and stop, and nothing is pushed or PR'd until you approve
each branch; a rejection stays local and is recorded in the checkpoint.

### Agent identity and avatars

When a project opts into a managed bot identity (by setting `git.botName` /
`git.botEmail` and pointing `git.cmd` at them), each spawned agent commits under its
**own derived email** — the bot's base address plus-addressed with the agent's slug
(`bot+<slug>@…`). Each agent also has a **deterministic avatar** (a waffle glyph whose
color is a pure function of the agent's name and skill count). GitHub picks a commit's
avatar from its author email's Gravatar, so those per-agent emails can carry per-agent
avatars.

The default `git.botEmail` is the toolkit-owned, subaddressable **`bot@wafflenet.io`**,
and the toolkit owner pre-registers every agent's avatar on Gravatar with **`wafflestack
avatars sync`**. The upshot: a project **on defaults gets per-agent avatars on GitHub with
zero setup**. The trade-offs — a toolkit-domain author email unless overridden, and avatars
*or* a verified sub-agent badge but not both — are recorded in
[DECISIONS.md](DECISIONS.md#2026-07-10). A consumer that overrides `git.botEmail` re-runs
`avatars sync` against its own domain and Gravatar account; `avatars status` reports any
installed agent whose address hasn't been registered. Adding and verifying a new address on
Gravatar stays a manual web step — Gravatar has no API for it. `.waffle/AVATARS.md`
(generated) lists every agent's avatar file and exact commit email.

**Crediting the owner (co-author trailer).** Separate from *who authors* a commit is *who gets
credited* on it. Agent commits carry a `Co-authored-by:` trailer, and its default now credits the
**consuming repo's owner** — `Co-authored-by: {{git.ownerName}} <{{git.ownerEmail}}>` — so the
person who initiates and merges agent work sees it on their GitHub contribution graph while the
commit's *author* stays the bot or the per-agent identity. Two things have to be true for the credit
to land: `git.ownerEmail` must be **verified on the owner's GitHub account** (the private
`ID+user@users.noreply.github.com` form works), and the commit must reach the **default branch**. Set
**both owner keys or neither** — a half-set pair renders a trailer that looks configured but credits
nobody (the email, not the name, is what GitHub keys on). `git.ownerName` accepts real names with an
apostrophe or accented Latin letters (`O'Brien`, `José`, `Müller`); it only lands in inert splice
sites, so it doesn't need `git.botName`'s stricter shell-safe allowlist. A repo that would rather
credit the bot points `git.coAuthorTrailer` at `{{git.botName}} <{{git.botEmail}}>`. See
[DECISIONS.md](DECISIONS.md#2026-07-10-the-default-co-author-trailer-credits-the-consuming-repos-owner-284-refined-by-291).

### Targets (harnesses)

A **target** is a coding assistant you render for. Three are supported:

| Target | Agents render to | Skills render to | Notes |
|--------|-----------|-----------|-------|
| `claude` | `.claude/agents/*.md` | `.claude/skills/*/` | Claude Code |
| `codex` | `.codex/agents/*.toml` | `.agents/skills/*/` | OpenAI Codex — agents as TOML; skills via the cross-tool `.agents/skills` dir Codex scans (cwd → repo root) |
| `agents-dir` | `.agents/agents/*.md` | `.agents/skills/*/` | Cross-tool AGENTS.md convention — harness-neutral Markdown |

**Every target renders both agents and skills** — there is no half-covered
harness. Because Codex and the cross-tool `agents-dir` both consume skills from
the same `.agents/skills/` convention, a repo that enables both renders that
directory once (shared, not duplicated).

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
  the template stays in. Even a config key's *default* can be a placeholder:
  `delegate.memoryFile` defaults to `{{delegate.checkpointDir}}/memory.md`, which
  itself defaults to `{{git.worktreesDir}}/.delegate`.

### The installer (render pipeline)

The `wafflestack` CLI lives in `installer/` (plain Node.js ES modules, one
runtime dependency: `yaml`). Its jobs, in one line each:

| Command | What it does |
|---------|--------------|
| `init` | Write a starter `.waffle/waffle.yaml`. |
| `setup` | Print the agent-driven install playbook + a generated inventory. On an already-configured repo, also prints a live "Current configuration — update mode" section. |
| `list` | Show every stack/item as installed & current / out of date / not installed; `--interactive` multi-selects the ones to add/update and applies them. |
| `install <ref…>` | Add a stack or single item to your config (pulling in dependencies), then render. `--force` overrides the overwrite guard. Bare `install` just renders. |
| `render` | Regenerate every managed file, delete stale ones, write the lock. Refuses to overwrite a pre-existing untracked file without `--force`. |
| `upgrade` | Read the lock's version, print the `CHANGELOG.md` delta, run any migrations, then re-render + `doctor`. |
| `doctor` | Compare rendered files to the lock and run the selected stacks' prerequisite checks; report drift, missing files, or an unmet `require`. |
| `eject <skills/NAME\|agents/NAME\|files/PATH>` | Stop managing an item — its files stay and become project-owned. |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline: register each agent's deterministic avatar for its verified commit email (`sync`), or report roster drift without writing (`status`, exit 1 on drift). Owner-only OAuth2 token from `WAFFLE_GRAVATAR_TOKEN`. |
| `validate` | Toolkit-author lint: manifests parse, placeholders are declared, refs resolve. |

Under the hood, `installer/lib/` holds 18 small modules (load the toolkit, resolve
external sources, load project config, substitute templates, render, diff against
the lock, check prerequisites, sync agent avatars, etc.). The full function-level
registry is in the root `AGENTS.md`.

## How the pieces interact

A render is a straight-line flow:

1. **Load** `toolkit.yaml` and each enabled stack's manifest.
2. **Load** your project config (`.waffle/waffle.yaml`, plus the gitignored
   `.waffle/waffle.local.yaml` merged on top).
3. **Select** what to render: every item in your `stacks:`, plus each `include:`
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
| `.waffle/waffle.yaml` | ✅ committed | Version pin, targets, enabled stacks, individual items (`include`), config values, `eject` list |
| `.waffle/waffle.local.yaml` | 🚫 gitignored | Account-specific values (bot identity, board IDs); merged over the committed config and wins |
| `.waffle/extensions/{agents,skills}/<name>.md` | ✅ committed | Your own text, appended to a rendered item inside marker comments |
| `.waffle/waffle.lock.json` | generated | Map of each rendered file to its hash; `doctor` reads it, `render` rewrites it |
| `.waffle/CHEATSHEET.md`, `TEAM.md` + `cheatsheet.html`, `team.html` | generated (usually committed) | Overview docs of your installed selection — a cheat sheet of user-invocable skills and a team intro of agents, in Markdown plus a branded, self-contained HTML page each. Managed like any rendered file (lock-tracked, doctor-checked, pruned) |

**Rule of thumb:** never edit files under `.claude/` (etc.) — a re-render will
overwrite them. Change source, config, or an extension instead.

## How this repo uses itself

wafflestack **dogfoods** its own stacks: `.waffle/waffle.yaml` here renders **five**
stacks — `github-workflow`, `docs-system`, `orchestration`, `harness-architect`, and
the self-referential `wafflestack` — into this repo, so the toolkit's own agents and
skills are available while developing it. It also arms three opt-in syrup workflows via
`include:` — the hygiene, release, and PR-green hooks — plus the single
`code-quality/skills/adversarial-review` skill the PR-green hook dispatches. (While
developing the toolkit you still drive it with `node installer/cli.mjs` directly rather
than the rendered `/waffle-*` wrappers.)

The rendered output (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json`)
and the lock (`.waffle/waffle.lock.json`) are **committed**, exactly like a real
consuming project. Two reasons: the CI hygiene harness reads the committed skills,
and the `waffle-doctor` drift gate (a required check on `main`) can only compare
against a render + lock that live in git. So after any `stacks/**` change you must
**re-render and commit** the updated files:

```bash
node installer/cli.mjs render
```

A few things stay deliberately untracked (and `doctor` runs with `--allow-missing`
to tolerate them): `.claude/worktrees/` (throwaway working state), `.codex/` and
`.agents/` (non-targets — this repo only renders `claude`), the
`waffle-label-hook.yml` workflow (committing it would arm a live label→harness
dispatch), and the generated `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`,
`cheatsheet.html`, `team.html`).

## Getting started (new contributors)

1. **Read the source, not the output.** Neutral definitions live in `stacks/**`
   and `schema/**`; the render CLI lives in `installer/**`. Anything under
   `.claude/`, `.codex/`, or `.agents/` is generated — don't edit it.
2. **Make changes to a stack**, then **re-render**:
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
   maintained by the `docs-system` stack's agents. The owner-voiced
   `README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are edited by hand —
   don't rewrite them in a docs pass.
