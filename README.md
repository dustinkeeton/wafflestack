<h1 align="center">WaffleStack</h1>
<p align="center">
  <img src="assets/wafflestack-social-animated.svg" width="100%" alt="WaffleStack — a stack of golden waffles with an animated syrup pour">
</p>
<h3 align="center">Reusable AI agent and skill definitions, distributed shadcn-style but <strong>update-safe</strong>.</h3>
<p align="center">
  <a href="https://github.com/sponsors/dustinkeeton"><img src="https://img.shields.io/badge/Sponsor-GitHub-F08A1D?logo=githubsponsors&logoColor=F5C752&labelColor=241204" alt="Sponsor on GitHub"></a>
  <a href="https://buymeacoffee.com/dustinkeeton"><img src="https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-F08A1D?logo=buymeacoffee&logoColor=F5C752&labelColor=241204" alt="Support on Buy Me a Coffee"></a>
</p>

---

One canonical source repo, rendered into harness-native files inside each consuming
project — the same batter, baked fresh wherever you need it. Every supported harness gets
both agents and skills: Claude Code (`.claude/agents`, `.claude/skills`), OpenAI Codex
(`.codex/agents/*.toml` for agents, plus skills in the cross-tool `.agents/skills` dir it
scans), and the cross-tool agents dir (`.agents/agents`, `.agents/skills`).

The vocabulary: an individual installable item — an agent or a skill — is a **waffle**; a
named group of waffles is a **stack**; the generic `files/` payload a stack can also carry is
**syrup**.

Stacks carry three payload types: **agents** and **skills** (waffles, rendered into those
harness dirs) and generic **files** (syrup) — CI workflows, scripts, or config rendered
verbatim to any repo-relative path (`.github/workflows/…`, `scripts/…`), with the same
`{{key}}` substitution, lock tracking, and drift detection.

## Where this fits

wafflestack is the **update-safe distribution layer** for agent process and skills content —
the piece that carries that content across repos and harnesses and keeps it current. It
deliberately doesn't own the neighboring layers. **Process packs** like
[gstack](https://github.com/garrytan/gstack) produce the shipped agent process and skills
content, but distribute it as producer-owned monoliths you fork and then drift from.
**Always-on agent runtimes** own the event-driven, service-layer end — what triggers agents
when nobody's typing. wafflestack's job is the distribution in between: consumer-owned files
under a lock manifest, drift `doctor`, and explicit, diffable upgrades with versioned
migrations. (The shadcn metaphor above is the *mechanism* that makes that work; this is the
*position*.)

## Install into a project

**Guided (recommended)** — let your coding agent (Claude Code, Codex, …) drive the whole
setup. Kick it off one of two ways:

**Agent prompt** — paste to your coding agent:

```text
Set up wafflestack in this repo: run `npx github:dustinkeeton/wafflestack setup` and
follow the playbook it prints. Ask me which stacks to enable before you render.
```

**Inline shell (Claude Code / Codex)** — type in the prompt:

```text
! npx --yes github:dustinkeeton/wafflestack setup
```

> The `!` prefix runs a shell command in-session and feeds its output back to the model —
> supported in both Claude Code and OpenAI Codex; `--yes` keeps `npx` non-interactive.
> Running `setup` yourself just prints the playbook + inventory for an agent to act on, so
> there's no standalone "run it yourself" flavor for it.

`setup` prints an agent playbook plus an inventory of every stack, config key, env
prerequisite, and service-side setup note — generated from the installed toolkit
version. The agent then detects targets and project commands, asks you which stacks
to enable, fills `.waffle/waffle.yaml`, verifies externals (e.g. `gh` auth and labels),
renders, runs `doctor`, and reports what it did.

**Manual** — no agent, just you and a shell (or delegate it with the guided prompt above):

**Run it yourself:**

```bash
cd your-project
npx github:dustinkeeton/wafflestack init     # writes a starter .waffle/waffle.yaml
# edit .waffle/waffle.yaml: pick stacks, fill in config values
npx github:dustinkeeton/wafflestack render   # renders all harness files + lock manifest
```

Pin a version with `npx github:dustinkeeton/wafflestack#v0.1.0 render`.

## Commands

| Command | What it does |
|---|---|
| `init` | Write a starter `.waffle/waffle.yaml` (won't overwrite an existing one). Add `--gitignore` to also append `.waffle/waffle.local.yaml` to `.gitignore`. |
| `setup` | Print the agent-driven install playbook + generated toolkit inventory (see above). |
| `list` | Show, per stack, every waffle (agent/skill) and syrup file with its status — installed & current, out of date (file drift or toolkit version skew), or not installed; opt-in syrup is flagged. Default output is a plain, non-interactive, non-TTY-safe table (honours `NO_COLOR` / `--no-color`). Add `--interactive` (needs a TTY) for a space-to-toggle multi-select that installs/updates the checked items via the normal `install` + `render` path; without a TTY it falls back to the table. |
| `render` (alias: `bake`) | Regenerate every managed file verbatim from source + config; delete managed files that are no longer rendered; write `.waffle/waffle.lock.json`. `bake` is a pure alias — same command, better metaphor. |
| `install [ref…]` | With refs: add them to `.waffle/waffle.yaml` (stack name → `stacks:`, item → `include:`), pull in their dependencies, then render. Refs are a stack name, `skills/<name>`, `agents/<name>`, or `<stack>/skills/<name>` (qualify when a name is in two stacks). Bare `install` = `render`. Add `--gitignore` to append the recommended ignore entries (`.waffle/waffle.local.yaml`, plus the configured `git.worktreesDir` when an enabled stack declares one) — idempotent, existing content preserved. Also on `render`. |
| `upgrade` | Move an existing install across toolkit versions: compare the lock's `toolkitVersion` to the invoked toolkit, print the `CHANGELOG.md` entries in between, run any registered migrations in order, then re-render and run `doctor`. A missing lock or version degrades to a plain render + doctor with a clear note. See [Rules of the road](#rules-of-the-road). |
| `doctor` | Diff managed files against the lock manifest; report local edits, missing files, and env prerequisites. Exit 1 on drift. Add `--allow-missing` to tolerate absent renders (a CI drift gate for repos that gitignore some outputs): only *modified* files fail, missing ones are informational — but a checkout with *every* managed file absent still fails, having verified nothing. Add `--verify-render` to also verify the lock against a fresh render of the committed config, in a temp dir — it catches a config or extension change that was never re-rendered (which the tree-vs-lock check cannot see, since both go stale together) and never touches the working tree. It renders the same **committed** inputs the lock records, so it is a real gate in CI whatever your gitignored `.local` overlay holds. `--allow-missing --verify-render` is the gate for a repo that commits only the lock. |
| `eject <item>` | Stop managing an item (e.g. `skills/issue`, `agents/name`, `files/.github/workflows/ci.yml`): its rendered files stay put and become project-owned; also drops it from `include:`. |
| `uninstall` | Remove the whole install. It deletes only what `.waffle/waffle.lock.json` says it wrote **and** whose content still matches — a file you hand-edited is kept and reported (`--force` to delete it too), an already-deleted one is fine, and a file the lock never tracked is never touched. Then it clears the `.waffle/` metadata, prunes the directories that emptied out, and strips its own `.gitignore` lines. Ejected items are project-owned, so they stay (and it tells you). **It only reports until you pass `--yes`** — run it bare first to see exactly what would go. |
| `reinstall` | Put the install back the way it should be: remove the rendered files and re-render the same selection. Keeps your `.waffle/waffle.yaml`, your overlay and your `extensions/` — it is a refresh, not a reset — so it needs no `--yes`. Add `--clean --yes` for the reset: wipe everything, including the config, and scaffold a fresh starter one. |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter is complete, every `{{placeholder}}` is declared, and agent `skills:` / `requires:` refs resolve. |
| `help` | Print the banner, usage, and a one-line description of every command and flag. Also `--help` / `-h`, before or after a command (`wafflestack uninstall --help` prints this help instead of running the command). Exits 0. |

## Rules of the road

1. **Never edit rendered files** — `render` will overwrite them. Put project additions in
   `.waffle/extensions/{agents,skills}/<name>.md` (appended to the rendered item)
   and project parameters in `.waffle/waffle.yaml`.
2. **Account-specific values** (bot identities, board IDs) go in `.waffle/waffle.local.yaml`,
   which is gitignored and merged over the committed config. Config values may reference
   other keys with `{{...}}` (nested substitution) — so a committed value can point at a
   key kept in the local overlay. **The overlay is private and never propagates**: the lock
   hashes the *canonical* render — what your committed config and extensions produce on their
   own — so your values shape your working copy and nobody else's, and every teammate's lock
   is byte-identical. (Extensions are the deliberate contrast: they *are* committed, so they
   are canonical, so they do propagate.) The one thing that cannot hide in the overlay is a
   `required:` key with no `default:` — the canonical render must be buildable from committed
   inputs, and `render` says so loudly rather than substituting something behind your back.
   wafflestack never edits your `.gitignore` *unasked*, but `wafflestack install --gitignore`
   (or the setup agent, on your approval) appends the entries for you — the local overlay and
   its local lock always, plus the configured worktrees directory.
3. **Updates are re-renders — until they aren't.** For patch/minor tags,
   `npx github:dustinkeeton/wafflestack#<newtag> render` regenerates everything and your
   config and extensions survive untouched. For a **breaking** tag (a renamed/removed item,
   a new required config key, a changed file layout), reach for
   `npx github:dustinkeeton/wafflestack#<newtag> upgrade` instead: it reads your lock's
   `toolkitVersion`, prints what changed since (from `CHANGELOG.md`), runs the registered
   migrations in order, then re-renders and runs `doctor`. See
   [versioning contract](#versioning-and-upgrades) below.
4. `doctor` tells you when local edits have crept into managed files, and doubles as a
   **CI drift gate** — run `npx github:dustinkeeton/wafflestack doctor` on PRs to fail the
   build if any managed file was hand-edited. When a repo deliberately gitignores some
   renders (so they're legitimately absent in a fresh CI checkout), add `--allow-missing`:
   absent files are then reported informationally and only *modified* files fail the gate. A
   missing lock still fails — that means the repo was never rendered, which the flag won't mask.
   So does a checkout where *every* managed file is absent, for the same reason: the flag
   tolerates a **subset** of absent renders, not the whole set — a gate that inspected nothing
   doesn't get to report success. Note what plain `doctor` does *not* check: whether the tree and
   the lock still match your **config**. Edit `.waffle/waffle.yaml` and forget to re-render, and
   they go stale together — agreeing with each other, and passing. Add `--verify-render` to close
   that: it renders your committed config into a temp dir (never the working tree) and checks the
   result against the committed lock. Paired with `--allow-missing` it is also the gate for a repo
   that gitignores its *whole* render — nothing is present to compare, so the render is reproduced
   and verified instead. It renders from your **committed** inputs, which is exactly what the lock
   records, so it works in CI no matter what your gitignored `.local` overlay holds
   ([how](docs/gitignore.md#your-private-overlay-stays-private--and-the-gate-still-works)).

**Deciding what to commit?** [Committing vs. gitignoring the rendered output](docs/gitignore.md) argues the trade-off — what you gain and lose each way, and why the lock is a separate decision from the render.

**Run the drift gate** — the `doctor` command from rule 4, in three copyable forms:

**Agent prompt** — paste to your coding agent:

```text
Check this repo for wafflestack drift: run `npx github:dustinkeeton/wafflestack doctor`
(add `--allow-missing` if we gitignore some renders) and summarize any modified or
missing managed files.
```

**Inline shell (Claude Code / Codex)** — type in the prompt:

```text
! npx --yes github:dustinkeeton/wafflestack doctor
```

**Run it yourself:**

```bash
npx github:dustinkeeton/wafflestack doctor   # add --allow-missing in CI when some renders are gitignored
```

## Versioning and upgrades

WaffleStack ships as git tags (`vX.Y.Z`), and the version is semver **read from a
consumer's point of view**:

| Bump | Example | What it means for you | How to take it |
|---|---|---|---|
| patch | `0.5.0 → 0.5.1` | content-only fixes | `… render` |
| minor | `0.5.0 → 0.6.0` | new stacks/items, additive config | `… render` |
| major / breaking | renamed or removed item, new **required** config key, changed file layout | needs a migration | `… upgrade` |

**Canonical upgrade command** — three copyable forms:

**Agent prompt** — paste to your coding agent:

```text
Upgrade wafflestack in this repo to <newtag>: run
`npx github:dustinkeeton/wafflestack#<newtag> upgrade`, review the CHANGELOG entries it
prints, let it run migrations and re-render, then run `doctor` and tell me what changed
and anything I still owe (e.g. `.gitignore` updates).
```

**Inline shell (Claude Code / Codex)** — type in the prompt:

```text
! npx --yes github:dustinkeeton/wafflestack#<newtag> upgrade
```

**Run it yourself:**

```bash
npx github:dustinkeeton/wafflestack#<newtag> upgrade
```

`upgrade` compares the `toolkitVersion` recorded in your `.waffle/waffle.lock.json` to the
toolkit you invoked, prints the [`CHANGELOG.md`](CHANGELOG.md) entries in between (each
release carries a **Consumer impact** line), runs any registered migrations in
`(lockVersion, toolkitVersion]` order, then re-renders and runs `doctor`. Migrations are
ordered, idempotent, and keyed to the version that introduced the change, so running
`upgrade` on an already-current repo is a safe no-op. If the lock is missing or predates
version stamping, `upgrade` says so and falls back to a plain render + `doctor`.

Two such migrations exist so far: **0.6.0** shortened the consumer dotfiles
(`.wafflestack.yaml` → `.waffle.yaml`, plus the local overlay, lock, and
`.wafflestack/extensions/` → `.waffle/extensions/`), and **0.8.0** consolidates everything
into a single `.waffle/` directory (`.waffle.yaml` → `.waffle/waffle.yaml`,
`.waffle.local.yaml` → `.waffle/waffle.local.yaml`, `.waffle.lock.json` →
`.waffle/waffle.lock.json`). You don't have to rename anything by hand: any `render` or
`upgrade` moves the legacy files in place — chaining a pre-0.6.0 repo all the way forward
in one pass — and reminds you to update the matching `.gitignore` entries (the auto-move
never edits `.gitignore` — swap them yourself, or run `wafflestack install --gitignore` to
re-add the `.waffle/` paths). Until you re-render, the old names keep working with a
deprecation note.

Format details: [schema/FORMAT.md](schema/FORMAT.md). Brand assets and guidelines:
[assets/](assets/).

## License

© 2026 Dustin Keeton. Licensed under the [Apache License, Version 2.0](LICENSE).

---
<p align="center">
    <a href="https://github.com/dustinkeeton/wafflestack/blob/waffle-telemetry/.waffle/telemetry/tokens.json"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdustinkeeton%2Fwafflestack%2Fwaffle-telemetry%2F.waffle%2Ftelemetry%2Ftokens.json" alt="Claude token spend (automated runs)"></a>
</p>
<p align="center">
  <img src="assets/wafflestack-flat.svg" width="24" alt=""><br>
  A <strong>WaffleWorks</strong> project
</p>
