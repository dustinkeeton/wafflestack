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
them, `wafflestack`, is self-referential: ten `/waffle-*` skills, each a thin wrapper
that runs one CLI command (`npx wafflestack <command>`) and interprets the output — so
the toolkit ships its own lifecycle the same way it ships everything else.

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

**Labels and repo settings are checked the same way.** Every label the stacks own is named
`waffle:<label>` (#451), and the **Required labels** table in `schema/SETUP.md` step 4 is the one
bootstrap list — a copy-paste `gh label create --force` block covering every label the stacks
declare (#452). The `orchestration` stack also probes two repo settings before `delegate` /
`autopilot` arm auto-merge: **Allow auto-merge** is on, and the default branch has a **required
status check** — which needs branch protection or a ruleset, and on GitHub Free those exist only
for public repos (#205). In that stack only the tool probes (`node`, `git`, `gh`) are `require`;
auth, label, and setting checks are `recommend`, so `doctor` reports them but never fails on them.

### Recommended plugins

A stack can also name **external harness plugins** it pairs well with (a Claude Code plugin or
marketplace entry) via `recommendedPlugins:` (#199). This is an **offer, never an install**:
`wafflestack setup` lists each entry with its required one-line `why`, and the render, `doctor`,
and lock are untouched — declaring one cannot change an output byte. The first shipped entry is
archify on `docs-system`, offered behind the `diagram` **proxy skill** — a capability-named skill
that tries an ordered provider list at invocation and ends in a built-in Mermaid fallback, so the
external provider is preferred without being depended on (#471).

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

`eject:` wins over `stacks:` and over a dependency closure — that is how you drop one
item from a stack. It never overlaps `include:`: the two lists are **mutually exclusive**
(#497). An item named in both is a hard `render` error that also fails `doctor`, with the
fix in the message. The commands keep the lists apart for you, and `upgrade` removes an
overlap from a committed `waffle.yaml` automatically (migration `0.16.0`, #501).

Required config is scoped to only the placeholders your selected items actually use — so
a one-item install doesn't demand config that its unselected siblings need.

**Opt-in syrup — a gate for sensitive syrup.** The generic `files/` payload is called
**syrup**; a stack can mark certain payloads as **opt-in syrup** via the `optIn:` manifest key
— seven of the github-workflow stack's CI workflows (label-hook, hygiene, release, post-merge,
evals, pr-green, pr-response — the ones that hold repo write permissions or spend API budget)
and the orchestration stack's two `/audit` workflow scripts
(`.claude/workflows/audit-stage-{1,2}.js`, inert until a session runs them). Enabling the
stack does *not* render them. They render only when you install the ref explicitly or when
your repo already tracks the file in its lock. That way an existing install keeps getting
updates, but a fresh enable never silently arms a workflow you didn't ask for.

**Target scoping (since v0.13.0, #364).** A `files/` payload can also declare `targets:` —
it then renders only when your project enables at least one of the listed harnesses, and
disabling the last one means the next `render` **prunes** the poured copy (the same
contract as dropping a stack). Because that prune deletes files, every malformed `targets:`
(a typo'd name, an empty list) is a hard load error, and `list` reports a poured,
scoped-out file as `PENDING REMOVAL` rather than pretending it isn't installed. Six payloads
use it today, all `targets: [claude]`: the four github-workflow hooks that dispatch Claude
(label-hook, hygiene, pr-green, pr-response — #190) and the two `/audit` workflow scripts (#363).
A Codex- or agents-dir-only project never receives a workflow that dispatches a harness it
doesn't render for.

### Agents and skills

- **Agent** — a specialist persona with instructions (e.g. a documentation
  writer, a security reviewer). Defined as a Markdown file with a small YAML
  header.
- **Skill** — a reusable capability or playbook an agent can invoke (e.g.
  "create a GitHub issue," "run the git workflow"). Defined as a `SKILL.md` plus
  any supporting files.

Both are written **harness-neutral** — no Claude- or Codex-specific wording — so
one source can render everywhere. There are **14 agents and 40 skills** in total.

**Tool calls are checked, not trusted (#445).** A skill is prose, so nothing compiles it — a
call to a tool the harness has since removed looks fine in review and fails at runtime. A
per-target roster of real harness tools lives in `installer/lib/harness-tools.mjs`, and
`npm test` fails on any `Tool(` call in a source or rendered skill or agent that is not on it.
Only `claude` has a declared roster today; the `codex` and `agents-dir` checks skip visibly
rather than pass on nothing. Adding a tool call means adding the name to the roster in the same
PR. See [DECISIONS.md](DECISIONS.md#2026-09-16-harness-tool-calls-are-checked-against-a-per-target-allowlist-not-a-denylist-445).

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

The checkpoint outlives the run. `/clean-up` reads the same `.delegate/*.json` files to sweep
agents an interrupted run left behind, and judges each by its **work**, not its task status: an
agent is stopped only once its PR is merged or closed (#172).

### Orchestrators are skills; workflow scripts only sequence them

The `/audit` chain shows the split. The prose `audit` skill runs on every harness and is the
permanent fallback. For Claude, the same chain also ships as two staged workflow scripts (opt-in
syrup, #363): `audit-stage-1.js` runs architecture → security pass 1 and stops on any
Critical/High finding; `audit-stage-2.js` runs compliance → the `docs` skill → security pass 2,
and refuses to run after an un-signed-off stop. Your review happens **between** the two runs.
Every phase in the scripts is a one-line pointer into `audit/SKILL.md` or `docs/SKILL.md`, and a
test keeps the prose chain order and the scripts' phase order identical.

Two related rules keep the orchestrators from drifting apart: `/audit` invokes `/docs` rather
than re-implementing it (#361), and the spawn-and-collect scaffold every orchestrator uses has
one home — a contract section in `audit` that `standup` and `autopilot` cite (#365).

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
directory once (shared, not duplicated). So the expected `.codex/` layout is
small on purpose: `agents/*.toml` only (plus your own `config.toml`) — the skills
Codex loads are in `.agents/skills/`. A two-file `.codex/` is the whole render,
not missing coverage. The Codex agent TOML carries **no skill grant** — Codex's
`[[skills.config]]` is a per-skill on/off override, not a grant — so an agent's skill access is
stated in its body prose instead, and a content test keeps every harness-neutral source free of
literal `.claude/skills/` paths (#190).

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

**Some keys switch a behavior instead of filling in text (#478 — partly landed).** A confirmation
gate or an auto-merge consent is a *behavioral* key: it declares a closed `modes:` list (the
reserved mode `prompt` means "never assume, ask"), optional `flag:` tokens that override it for
one run, an optional `lockMode:` pinning what config may say, and a `nonInteractive:` fallback
for CI and agent callers. Precedence is fixed: run token → `waffle.local.yaml` → `waffle.yaml` →
the stack default. A value outside `modes:`, or one that overrides a lock, fails `render` and
bare `doctor`. **Only the schema, the `validate` lint and the flag inventory have shipped** (PR
#493) — the four autopilot consents declare the new fields as metadata, and no skill's prose has
migrated yet (#486–#490, open). See
[DECISIONS.md](DECISIONS.md#2026-09-16-behavioral-skill-flags-become-three-mode-config-keys--modes-flag-lockmode-noninteractive-478-slices-12).

### The installer (render pipeline)

The `wafflestack` CLI lives in `installer/` (plain Node.js ES modules, one
runtime dependency: `yaml`). Its jobs, in one line each:

| Command | What it does |
|---------|--------------|
| `init` | Write a starter `.waffle/waffle.yaml`. |
| `setup` | Print the agent-driven install playbook + a generated inventory. On an already-configured repo, also prints a live "Current configuration — update mode" section. |
| `list` | Show every stack/item as installed & current / out of date / not installed — plus `not installable` (scoped to targets this repo doesn't enable) and `PENDING REMOVAL` (poured under an older scope; the next render deletes it). `--interactive` multi-selects the ones to add/update and applies them. |
| `toggle` | Choose, per skill, whether an agent may invoke it on its own or only you can via `/slash` (#476). A checkbox picker in a terminal, a plain table on a pipe, `--disable` / `--enable` flags for agents and CI. Writes `waffle.yaml`, then renders. See [below](#two-consumer-side-knobs-toggle-and-report). |
| `install <ref…>` | Add a stack or single item to your config (pulling in dependencies), then render. Installing an **ejected** item un-ejects it (#497); if the render then refuses to overwrite your differing project-owned copy, `waffle.yaml` is rolled back and nothing changes. `--force` overrides the overwrite guard. Bare `install` just renders. |
| `render` (alias: `bake`) | Regenerate every managed file, delete stale ones, write the lock. Refuses to overwrite a pre-existing untracked file without `--force`. `bake` is a pure alias — same command, better metaphor. |
| `upgrade` | Read the lock's version, print the `CHANGELOG.md` delta, run any migrations (an unreleased toolkit also runs the steps keyed past its own version, #501), move any release-tag `toolkitRef` pins you already chose, then re-render + `doctor`. |
| `doctor` | Compare rendered files to the lock that describes this machine's tree (the local lock when your overlay shaped the render, else the committed one) and run the selected stacks' prerequisite checks; report drift, missing files, or an unmet `require`. `--verify-render` additionally re-renders the **committed** inputs into a temp dir and diffs the result against the committed canonical lock — the tree is never touched. Pin `doctor.toolkitRef` to a release tag *before* arming that flag in CI: it is the one flag that makes the toolkit load-bearing. |
| `report` | Print a **redacted** diagnostics bundle for a toolkit bug report (#473) — Markdown by default, `--json` for machines. Read-only, never contacts GitHub, exit 0 even when `doctor` is red. |
| `eject <skills/NAME\|agents/NAME\|files/PATH>` | Stop managing an item — its files stay and become project-owned. Also drops a matching `include:` entry. Never renders: it prints which dependencies only that entry was selecting, for the next `render` to prune (#497). |
| `uninstall` | Remove the whole install — the only destructive command. Deletes only what the lock tracks *and* whose content still matches; **a dry run until `--yes`**. See [Taking it back out](#taking-it-back-out-uninstall--reinstall). |
| `reinstall` | Refresh in place: remove the rendered files, re-render the same selection. Keeps your config, overlay and extensions, so it needs no `--yes`. `--clean --yes` wipes the config too and re-scaffolds it. |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline: register each agent's deterministic avatar for its verified commit email (`sync`), or report roster drift without writing (`status`, exit 1 on drift). Owner-only OAuth2 token from `WAFFLE_GRAVATAR_TOKEN`. |
| `validate` | Toolkit-author lint: manifests parse, placeholders are declared, refs resolve. |
| `help` | Print the banner, usage, and one line per command and flag — on stdout, exit 0. Also `--help` / `-h`, before or after a command. |

Under the hood, `installer/lib/` holds 26 small modules (load the toolkit, resolve
external sources, load project config, substitute templates, render, diff against
the lock, check prerequisites, uninstall, sync agent avatars, resolve the toolkit's
own identity, etc.). The full function-level registry is in the root `AGENTS.md`.

### Two consumer-side knobs: `toggle` and `report`

**`toggle` decides who may fire a skill.** Claude Code's `disable-model-invocation: true` keeps
a skill slash-only, but skills render byte-for-byte from source, so that used to be the toolkit
author's call. Now a committed `skills.modelInvocation: { disabled: [..], enabled: [..] }` block
in `waffle.yaml` is a render input like any other: `render` patches that one frontmatter line in
the `claude` copy, the lock records the patched bytes, and `doctor` stays clean. Other targets
have no such key, so their copy renders unchanged. `toggle` writes only the committed config —
never the private overlay — and lists rendered skills only, never externally installed ones.

**`report` gets a toolkit bug back upstream without leaking your repo.** The command gathers
what a maintainer needs — toolkit version and provenance, targets, stacks, a `doctor` summary —
and its redaction is **structural**: it never opens `waffle.local.yaml` or the local lock, and
it emits config *key paths*, never values. A scrub pass then replaces your repo path, home
directory, emails and git remotes with placeholders. The `/waffle-report` skill does the filing:
it resolves the target repo from `waffle.toolkitRef` (a fork's consumer reports to the fork),
shows you the post-redaction text, and files only on your yes.

Why each is shaped this way:
[`toggle`](DECISIONS.md#2026-09-16-toggle-makes-agent-invocation-a-per-project-config-input-not-a-hand-edit-476) ·
[`report`](DECISIONS.md#2026-09-15-report-is-a-cli-command-behind-a-thin-skill-wrapper-and-its-redaction-is-structural-473).

### Which toolkit am I running? (the release gate, since v0.13.0)

An `npx github:…` spec with no `#tag` fetches the repo's **default branch**, not the
latest release, while reporting the released version number. Since v0.13.0 (#373) the CLI
resolves its own identity before writing anything:

- **Write commands refuse when provably unreleased.** `render`, `install`, `upgrade`,
  `reinstall`, `doctor --verify-render`, and `toggle` whenever it writes stop with an error
  naming the exact pinned command to run. (`toggle` checks *before* opening its picker, so a
  refusal never follows your picks; `report` and a flagless `toggle` are read-only and only warn.) An *unanswerable* lookup (offline, GitHub unreachable) warns and
  proceeds — fail open on ignorance, closed only on a confirmed "not a release".
- **The lock records the answer.** A `toolkit` block names the ref and commit SHA that
  produced the render — recorded only for a real release, because only a release names
  immutable content; an untagged checkout records explicit nulls with a `status` saying why.
- **`upgrade` moves your pins.** A `doctor.toolkitRef` / `waffle.toolkitRef` you already
  pinned to a release tag is rewritten to the release that just rendered your lock — it
  never *introduces* a pin, and a run that cannot prove it is a release writes none.
- **Toolkit developers pass `--allow-unreleased`** (or `WAFFLESTACK_ALLOW_UNRELEASED=1`).
  It suppresses the refusal, not the truth — the toolkit still reports itself unreleased.

### Taking it back out (`uninstall` / `reinstall`)

`uninstall` is the toolkit's **only destructive command**, and it answers one question
conservatively: *which files are ours to delete?*

**The lock decides.** A file is deleted only if `.waffle/waffle.lock.json` tracks it **and** its
content still hashes to exactly what wafflestack rendered — the same check `doctor` uses to spot
hand-edits. There is no directory glob and no "looks generated" guess, so a file the toolkit cannot
prove it wrote *and* prove is unchanged is a file it does not touch:

- **A file you hand-edited is kept** and reported, not deleted (`--force` deletes it too). Rendered
  output is often gitignored, so your edit may be the only copy of that work anywhere.
- **A file you authored is never touched** — it isn't in the lock, so the rule never reaches it.
- **An ejected item stays** and is announced as project-owned. `eject` already removed it from the
  lock.
- **A lock entry pointing outside the repo aborts the whole run**, deleting nothing — including one
  that escapes through a symlinked parent directory. The lock is a file *you* can edit, so it is
  treated as untrusted input.

**It only reports until you pass `--yes`.** The CLI is non-interactive by design — agents and CI
drive it — so the flag is the consent, not a prompt. Run it bare to preview exactly what would go.

It then clears the `.waffle/` metadata (`--keep-config` spares your `waffle.yaml`, `extensions/` and
the lock), prunes directories that genuinely emptied out, and strips its own `.gitignore` lines.

`reinstall` is the non-scary sibling: remove the rendered files and re-render the same selection. It
snapshots the bytes it deletes and restores them if the re-render fails, and it needs no `--yes`
because every file it removes the render writes straight back.

> [!NOTE]
> Four rough edges ship with the first release of these commands and are tracked in **#359** —
> most notably, an uninstall that skipped a hand-edited file still removes your config, and it
> still exits 0. See [DECISIONS.md](DECISIONS.md#2026-07-13-the-lock-decides-what-uninstall-may-delete-182-epic-346).

## How the pieces interact

A render is a straight-line flow:

1. **Load** `toolkit.yaml` and each enabled stack's manifest.
2. **Load** your project config (`.waffle/waffle.yaml`, plus the gitignored
   `.waffle/waffle.local.yaml` merged on top).
3. **Select** what to render: every item in your `stacks:`, plus each `include:`
   item and its dependency closure, minus anything in `eject:`. An item listed in both
   `include:` and `eject:` fails the render before anything is written (#497).
4. For every selected item and every target, **substitute** placeholders and
   **append** any project extension.
5. **Write** the harness-native files, then record hashes in the lock. The committed
   `.waffle/waffle.lock.json` hashes the **canonical** render — what the committed inputs
   produce on their own, overlay excluded — so it is byte-identical on every machine and
   a private overlay value never propagates through it. When the overlay changed an
   output byte, the hashes of the files actually written go to the gitignored
   `.waffle/waffle.local.lock.json` instead.
6. **Prune** any previously-managed file that is no longer rendered.

Two safety checks guard the write step: two enabled sources emitting the *same*
output path is a hard error (never last-write-wins), and a render that would
overwrite a pre-existing file the lock doesn't track (a consumer's hand-written
file) is refused before any write — a byte-identical file is adopted silently, and
`--force` overrides the guard.

Later, `doctor` re-hashes the files and compares them to the lock that describes the
tree (the local one when your overlay shaped this machine's render, else the committed
one) — that is how it knows if someone hand-edited a generated file or an update changed
the output, even on a machine whose render legitimately differs from the committed lock.

## Configuration overview

Everything a consuming project owns:

| File | Tracked in git? | Purpose |
|------|-----------------|---------|
| `.waffle/waffle.yaml` | ✅ committed | Version pin, targets, enabled stacks, individual items (`include`), config values, `eject` list, and the optional `skills.modelInvocation` block `toggle` writes (#476) |
| `.waffle/waffle.local.yaml` | 🚫 gitignored | Account-specific values (bot identity, board IDs); merged over the committed config and wins. Private by design (#317): it shapes the bytes on *your* disk but never reaches the committed lock |
| `.waffle/extensions/{agents,skills}/<name>.md` | ✅ committed | Your own text, appended to a rendered item inside marker comments — committed, therefore canonical, therefore it *does* propagate (the deliberate contrast with the overlay) |
| `.waffle/waffle.lock.json` | ✅ committed (generated) | The **canonical** render's hashes — what the committed inputs alone produce, overlay excluded — so it is byte-identical on every machine. Also carries the `toolkit` block: **which toolkit produced the render** (ref + commit SHA), recorded only when it names immutable content — a release. An untagged checkout records explicit nulls, so the block does not churn as `main` moves. `doctor --verify-render` reproduces it (comparing **files only**); `render` rewrites it |
| `.waffle/waffle.local.lock.json` | 🚫 gitignored (generated) | The render *this machine* actually wrote, overlay values included. Exists only while the overlay changes an output byte; `doctor`, `list`, and `render`'s prune/overwrite checks read it in preference to the committed lock, so a hand-edit is still caught locally |
| `.waffle/CHEATSHEET.md`, `TEAM.md` + `cheatsheet.html`, `team.html` | generated (usually committed) | Overview docs of your installed selection — a cheat sheet of user-invocable skills and a team intro of agents, in Markdown plus a branded, self-contained HTML page each. Managed like any rendered file (lock-tracked, doctor-checked, pruned) |

**Rule of thumb:** never edit files under `.claude/` (etc.) — a re-render will
overwrite them. Change source, config, or an extension instead.

## How this repo uses itself

wafflestack **dogfoods** its own stacks: `.waffle/waffle.yaml` here renders **five**
stacks — `github-workflow`, `docs-system`, `orchestration`, `harness-architect`, and
the self-referential `wafflestack` — into this repo, so the toolkit's own agents and
skills are available while developing it. `include:` arms three opt-in syrup workflows — the
deterministic release and post-merge hooks, plus the scheduled hygiene hook — two code-quality
skills the PR gates run (`adversarial-review` and `qa`), and the two `/audit` workflow scripts
(`audit-stage-1.js`, `audit-stage-2.js` — inert until a session invokes them, poured so the
render and lock exercise the opt-in `targets:` path). (While developing the toolkit you still
drive it with `node installer/cli.mjs` directly rather than the rendered `/waffle-*`
wrappers.)

The three hooks that dispatch the **paid** Claude harness are in two different states as of
2026-09-16:

| Hook | State here | How |
|------|------------|-----|
| hygiene (`waffle-hygiene.yml`) | **Armed** — a daily cron plus manual dispatch | In `include:`, lock-managed, and the rendered workflow is tracked in git (PRs #495, #496) |
| pr-green (`waffle-pr-green-hook.yml`) | **Ejected** | In `eject:` — `render` does not produce it and the lock does not track it |
| pr-response (`waffle-pr-response-hook.yml`) | **Ejected** | Same; briefly re-included by #495, re-ejected by #496 the same day |

All three were disarmed on 2026-07-15 (#396) and ejected the next day so the lock forgot their
rendered paths (#414, PR #417) — an ejected hook cannot be re-armed by a stray `git add -A`.
Re-arming one is a single command since #497: `wafflestack install <files/ref>` un-ejects it, adds
the `include:` entry, and renders — refusing without `--force` if your project-owned copy differs
from the render. Then commit. See
[DECISIONS.md](DECISIONS.md#2026-07-15-the-paid-claude-dispatch-hooks-are-disarmed-while-the-repo-carries-no-api-key-396).

The rendered output (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json`)
and the lock (`.waffle/waffle.lock.json`) are **committed**, exactly like a real
consuming project — the `waffle-doctor` drift gate (a required check on `main`) can
only compare against a render + lock that live in git, and CI-dispatched harness runs
read the committed skills when a hook is armed. So after any `stacks/**` change you
must **re-render and commit** the updated files:

```bash
node installer/cli.mjs render --allow-unreleased
```

The flag is **required** (#373): `render` refuses to write files from a toolkit that is
not at a release tag, and a feature-branch working tree never is. It suppresses the
refusal, not the truth — the identity still resolves to `unreleased`, which is what keeps
this repo's own dogfooded lock honest rather than merely permitted.

Two required checks then guard the committed render from different angles. The
`waffle-doctor` drift gate re-hashes the committed files against the committed lock. But a
forgotten re-render leaves files and lock stale *together* — they agree with each other,
so that gate stays green — which is why the `tests` workflow ends with
`WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs doctor --allow-missing --verify-render`,
run with the checkout's own CLI: it re-renders the PR's committed inputs into a temp dir and
diffs the result against the committed lock (#314/#316). The env twin is shown inline because
that is what *executes* — the job supplies it once at the `env:` block rather than per-step, so
the step at `tests.yml:36` itself carries no flag (the value sits at `tests.yml:22`). Running that step **by hand** from a branch needs
`--allow-unreleased`, since `--verify-render` renders and is gated (#373). It uses the
checkout's CLI (not the shipped
`doctor.flags` route) because the shipped workflow fetches the toolkit from `main` — the
wrong toolkit for the toolkit's own PRs.

A few things stay deliberately untracked (and `doctor` runs with `--allow-missing`
to tolerate them): `.claude/worktrees/` (throwaway working state), `.codex/` and
`.agents/` (non-targets — this repo only renders `claude`), the
`waffle-label-hook.yml` workflow (committing it would arm a live label→harness
dispatch), and the generated `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`,
both `.html` pages, `AVATARS.md`, and `avatars/`).

## Getting started (new contributors)

1. **Read the source, not the output.** Neutral definitions live in `stacks/**`
   and `schema/**`; the render CLI lives in `installer/**`. Anything under
   `.claude/`, `.codex/`, or `.agents/` is generated — don't edit it.
2. **Make changes to a stack**, then **re-render** (the `--allow-unreleased` flag is
   required — `render` refuses from a non-release checkout, #373):
   ```bash
   node installer/cli.mjs render --allow-unreleased
   ```
3. **Verify before you push:**
   ```bash
   npm run validate      # manifests + placeholder checks
   npm test              # installer test suite
   npm run typecheck     # tsc over the installer
   node installer/cli.mjs doctor   # rendered output matches the lock (not gated)
   node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # committed inputs reproduce the lock (the CI render gate)
   ```
   `--verify-render` *renders*, so it is gated like `render` itself (#373) and needs
   `--allow-unreleased` from a branch checkout. Plain `doctor` reads no toolkit content
   and is never gated. (CI passes the env twin `WAFFLESTACK_ALLOW_UNRELEASED=1` at the job
   level instead, which is why the step in `tests.yml` carries no flag.)
4. **Documentation is generated by agents.** The machine registry (`AGENTS.md`)
   and these human docs (`DECISIONS.md`, `STATUS.md`, `ARCHITECTURE.md`) are
   maintained by the `docs-system` stack's agents. The owner-voiced
   `README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are edited by hand —
   don't rewrite them in a docs pass.
