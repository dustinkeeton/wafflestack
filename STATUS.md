# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.12.0 (pre-1.0 — the file contract can still change between minor
  releases). See Current focus for what this release adds.
- **Last updated**: 2026-07-13
- **Health**: 🟢 tests 966/966 (128 suites) · `validate` clean · `doctor --allow-missing` clean
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 9 stacks are shipped and stable. Pick the ones a project needs.

| Stack | Status | What you get |
|--------|--------|--------------|
| `docs-system` | ✅ Shipped | Two-audience docs: machine (`AGENTS.md`) + human (these files) |
| `github-workflow` | ✅ Shipped | Git / GitHub issue / Projects / release workflow + 7 prefab CI workflows (doctor + 6 opt-in syrup hooks: label-hook, hygiene, release, post-merge, evals, pr-green); only stack with a `setup:` step. Declares typed `prerequisites:` |
| `orchestration` | ✅ Shipped | Multi-agent orchestration: project/product management, delegate (typed checkpoints, run memory, optional approval gate, opt-in batch mode + auto-merge), autopilot (unattended backlog runner composing delegate batch mode + auto-merge, clean-up, and git-workflow), audit, docs, standup |
| `code-quality` | ✅ Shipped | Cross-cutting, project-agnostic practice skills: TDD, codebase-architecture, adversarial-review (hostile green-PR review), dry (de-duplication) |
| `engineering-team` | ✅ Shipped | 6-agent product-engineering roster (lead-engineer is the general architect) + webapp-security-audit |
| `obsidian-dev` | ✅ Shipped | Obsidian plugin development (plugin-architect + obsidian-plugin-dev + electron-security-audit) |
| `expo-dev` | ✅ Shipped | Expo / React Native app development (mobile-architect + reference skills) |
| `harness-architect` | ✅ Shipped | Single domain agent — expert in building agent harnesses (agent/skill/tool decomposition, subagent teams, hooks, MCP, multi-harness portability) |
| `wafflestack` | ✅ Shipped | Self-referential (#70): eight `/waffle-*` skills, one per CLI command — thin `npx` wrappers with agent judgment on top. Now enabled/dogfooded in this repo |

Totals: 14 agents and 37 skills across the 9 stacks.

## Installer & CLI

**The CLI surface is now complete** (epic #346). The `wafflestack` CLI (19 pipeline
modules under `installer/lib/`) is tested and all 13 commands work:

`init` · `setup` · `list` · `install` · `render` · `upgrade` · `doctor` · `eject` ·
`uninstall` · `reinstall` · `avatars` · `validate` · `help`  (plus `bake`, an alias for `render`)

- `uninstall` / `reinstall` (new, #182) are the toolkit's **first destructive commands** — the
  lock decides what may be deleted, and `uninstall` is a dry run until `--yes`. See Current focus.
- `help`, `--help`, `-h` (new, #187) print usage to stdout and exit 0; an unknown command (and
  bare `wafflestack`) still fails to stderr.
- `avatars <sync|status>` (#285) is the owner-side Gravatar pipeline.
- `list` (#119) reports every stack/item as installed & current / out of date / not
  installed; `--interactive` drives a multi-select that installs the chosen refs and renders.
- `install <ref…>` records a stack or a single item (`agents/`, `skills/`, or a
  `files/` syrup payload) in `.waffle/waffle.yaml`, resolving dependencies, then renders.
- `render`/`install` take `--force` (overwrite guard) and `--gitignore` (opt-in entries).
- `render` also emits the `.waffle/` overview docs — `CHEATSHEET.md`/`TEAM.md` plus branded
  self-contained HTML pages (`cheatsheet.html`/`team.html`, HTML replaced the SVGs in #104).

## Current focus

**Unreleased (CHANGELOG `[Unreleased]`):**

- **The CLI surface is complete — `help`, `uninstall`/`reinstall`, `bake` (epic #346).** The toolkit
  can finally be **removed**, not just installed. `uninstall` deletes a file only if the lock tracks
  it *and* its hash still matches what was rendered — so a file you hand-edited is kept and
  reported, a file you authored is never touched, and a lock entry pointing outside the repo aborts
  the run. **It is a dry run until `--yes`.** `reinstall` refreshes in place (snapshot → remove →
  re-render, rolling back if the render fails). `help`/`--help`/`-h` now exit 0 on stdout instead of
  failing. Why the lock is the safe authority:
  [DECISIONS.md](DECISIONS.md#2026-07-13-the-lock-decides-what-uninstall-may-delete-182-epic-346).
  **Four known gaps ship with it, tracked in #359** — see Known issues.
- **The committed lock is now canonical (#317).** `.waffle/waffle.lock.json` hashes the render the
  *committed* inputs produce (no `.local` overlay), so it's byte-identical on every machine and a
  private overlay value can never propagate through it. A machine whose overlay changes an output
  byte gets a gitignored `.waffle/waffle.local.lock.json`; working-tree checks read that one
  (`readTreeLock()`), so hand-edits are still caught locally. See
  [DECISIONS.md](DECISIONS.md#2026-07-11-the-committed-lock-records-the-canonical-render-a-local-lock-records-yours-317).
- **`doctor --verify-render` + this repo's own render gate (#314/#316).** The new flag re-renders
  the committed inputs into a temp dir and diffs against the canonical lock — catching an edit whose
  re-render was forgotten (files and lock go stale *together*, so the plain drift gate stays green).
  This repo dogfoods it in `tests.yml`. **Pin `doctor.toolkitRef` to a release tag before arming the
  flag (#322)** — it's the one flag that makes the toolkit load-bearing.
- **Gate-skill fixes (#318, #320, #324).** `pr-response` now appends one comment per round (never
  PATCHes its prior reply); delegate's three specialists finally hold the `SendMessage`/`TaskUpdate`
  tools they were told to report with; the `qa`/`adversarial-review`/`pr-response` staging paths are
  namespaced per PR (a stale payload nearly cross-posted between PRs #285 and #321), each with a
  read-back-before-post rule.
- **Default co-author trailer credits the repo owner (#284, refined by #291).** Two new lockstep keys
  — **`git.ownerName`** / **`git.ownerEmail`** (in `github-workflow` + `orchestration`) — and the
  **`git.coAuthorTrailer` default flips** from the harness-noreply form to
  `Co-authored-by: {{git.ownerName}} <{{git.ownerEmail}}>`. The agent keeps its displayed author
  identity; the owner gets contribution-graph credit — *if* the owner email is verified on GitHub and
  the commit reaches the default branch. Set **both keys or neither** (a half-set pair looks
  configured but credits nobody). `ownerName` takes a name-appropriate allowlist (`O'Brien`, `José`,
  `Müller`). Additive, no migration; this repo sets Dustin's values. See
  [DECISIONS.md](DECISIONS.md#2026-07-10-the-default-co-author-trailer-credits-the-consuming-repos-owner-284-refined-by-291).
- **Programmatic Gravatar avatar pipeline (#285).** Owner-side `avatars sync`/`status` (token from
  `WAFFLE_GRAVATAR_TOKEN`) automate per-agent avatar registration; `status` exits 1 on roster drift.
  The **default `git.botEmail` flips** to the subaddressable `bot@wafflenet.io`, so a project on
  defaults gets per-agent `bot+<slug>@…` emails and avatars on GitHub with zero setup. Trade-offs +
  manual verify-remainder: [DECISIONS.md](DECISIONS.md#2026-07-10-a-programmatic-gravatar-pipeline-for-per-agent-avatars-and-a-default-bot-email-flip-285).

**Already shipped in v0.11.0** (2026-07-08): external third-party stacks (#88), typed
`prerequisites:` gated by `doctor` (#129), the `adversarial-review` + `dry` skills (#112/#116),
Layer-2 evals (#109), and the live backlog→merge automation loop (autopilot, daily hygiene, release
hook). Full detail in the CHANGELOG's `[0.11.0]` section.

## Known issues & things to watch

- **`uninstall`/`reinstall` ship with four rough edges (#359)** — known and deliberately deferred:
  - **An uninstall that skips a hand-edited file** keeps the lock, but still deletes the config and
    strips the `.gitignore` block — the leftovers are recoverable, the selection around them isn't.
  - **An incomplete `uninstall --yes` still exits 0** — a skip isn't treated as an error.
  - **`reinstall` hard-fails** (exit 1) on a repo with a config but no lock (never rendered).
  - **`--no-color` is missing** from the `help` flag list; the flag itself works.
- **No npm package yet** — install only via `npx github:dustinkeeton/wafflestack`.
- **The self-render is committed.** After editing anything under `stacks/**`,
  `schema/**`, or `installer/**`, re-run `node installer/cli.mjs render` and commit the
  updated files + lock — the `waffle-doctor` required check fails PRs on drift, and the
  `tests` workflow's `doctor --allow-missing --verify-render` step (#316) fails PRs whose
  committed inputs no longer reproduce the committed lock (a forgotten re-render).
- **Deliberately gitignored here** (tolerated by `doctor --allow-missing`):
  `.claude/worktrees/` (throwaway), `.codex/`/`.agents/` (non-targets), the
  `waffle-label-hook.yml` workflow (would arm a live label→harness dispatch), and the generated
  `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`, `cheatsheet.html`, `team.html`).

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations |
| `gh` (GitHub CLI) | authenticated | Required only by the `github-workflow` stack |
| SVG rasterizer + `WAFFLE_GRAVATAR_TOKEN` | optional | Owner-side only, for `avatars sync`: any of `rsvg-convert` / ImageMagick / `npx svgexport`, plus an owner OAuth2 token |

## Verify it yourself

```bash
npm test                          # installer test suite (966 tests, 128 suites)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render     # regenerate this repo's rendered files
node installer/cli.mjs doctor     # confirm no drift vs. the lock
node installer/cli.mjs doctor --allow-missing --verify-render   # committed inputs reproduce the lock
npm run evals -- --dry-run        # Layer-2 eval harness, mock model (free); --max-calls N for a live run
```
