# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.10.0 tagged (pre-1.0 — the file contract can still change between minor
  releases). Headlined by the bundles→stacks rebrand (breaking — `wafflestack upgrade`
  runs the migration) plus the harness/CI fixes and delegate work below.
- **Last updated**: 2026-07-08
- **Health**: 🟢 tests 280/280 (46 suites) · `validate` clean · `doctor --allow-missing` clean
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 9 stacks are shipped and stable. Pick the ones a project needs.

| Stack | Status | What you get |
|--------|--------|--------------|
| `docs-system` | ✅ Shipped | Two-audience docs: machine (`AGENTS.md`) + human (these files) |
| `github-workflow` | ✅ Shipped | Git / GitHub issue / Projects / release workflow + 4 prefab CI workflows (doctor + 3 opt-in syrup hooks); only stack with a `setup:` step |
| `orchestration` | ✅ Shipped | Multi-agent orchestration: project/product management, delegate (typed checkpoints, run memory, optional approval gate, opt-in batch mode + auto-merge), autopilot (unattended backlog runner composing delegate batch mode + auto-merge, clean-up, and git-workflow), audit, docs, standup |
| `code-quality` | ✅ Shipped | Cross-cutting, stack-agnostic practice skills: TDD, codebase-architecture |
| `engineering-team` | ✅ Shipped | 6-agent product-engineering roster (lead-engineer is the general architect) + webapp-security-audit |
| `obsidian-dev` | ✅ Shipped | Obsidian plugin development (plugin-architect + obsidian-plugin-dev + electron-security-audit) |
| `expo-dev` | ✅ Shipped | Expo / React Native app development (mobile-architect + reference skills) |
| `harness-architect` | ✅ Shipped | Single domain agent — expert in building agent harnesses (agent/skill/tool decomposition, subagent teams, hooks, MCP, multi-harness portability) |
| `wafflestack` | ✅ Shipped | Self-referential (#70): eight `/waffle-*` skills, one per CLI command — thin `npx` wrappers with agent judgment on top |

Totals: 14 agents and 30 skills across the 9 stacks.

## Installer & CLI

The `wafflestack` CLI (13 pipeline modules under `installer/lib/`) is complete and
tested. All 8 commands work:

`init` · `setup` · `install` · `render` · `upgrade` · `doctor` · `eject` · `validate`

- `install <ref…>` records a stack or a single item (`agents/`, `skills/`, or a
  `files/` syrup payload) in `.waffle/waffle.yaml`, resolving dependencies, then renders.
- `render`/`install` take `--force` (overwrite guard) and `--gitignore` (opt-in entries).
- `render` also emits the `.waffle/` overview docs: `CHEATSHEET.md`/`TEAM.md` plus
  branded self-contained HTML pages (`cheatsheet.html`/`team.html` — HTML replaced the
  old SVGs in #104).

## Current focus

- **Delegate run hardening (new, #105–#107).** Three additions to `/delegate`, each with a
  shipped dependency-free validator script:
  - *Typed checkpoints* (#105) — one schema-validated JSON checkpoint per run, checked at
    every phase boundary; a bad checkpoint exits 1 and hard-STOPs the run.
  - *Approve-before-push* (#106) — opt-in gate (`delegate.approveBeforePush`, default off):
    agents commit locally and stop; a human approves each push/PR, rejections stay local.
  - *Run memory* (#107) — one curated, hard-capped memory doc per repo (`memory.mjs` gate;
    every entry needs Why/Since/Area; over cap = curate, never truncate).
- **Eval layer 1 (new, #108).** `installer/test/content.test.mjs` pins load-bearing
  guardrail phrases in the rendered prompts — rewording passes, removing a guardrail fails
  CI. LLM-judged evals are tracked as layer 2 under #89.
- **Autonomous backlog runner (new, #98–#101).** Two per-run, default-**off** delegate opt-ins
  — `delegate.autoMerge` (#98: after `gh pr create`, arms `gh pr merge --auto --merge` so the PR
  self-merges once required checks pass; if it can't arm — no auto-merge setting or no required
  check — the PR is left **open-but-not-armed**, never an immediate or `--admin` merge) and
  `delegate.batchMode` (#99: skips delegate's plan-approval pause when explicit scope is
  supplied; never weakens the `approveBeforePush` gate) — plus the new **`autopilot`** skill
  (#100), config `autopilot.autoMerge` (default false) + `autopilot.planDir`.
- **Live automation loop (backlog → merge).** Three loops run on this repo, all gated by the
  required `doctor` check. **Autopilot** is the end-to-end runner over a *required* explicit
  issue scope — per issue: a read-only context writes a plan → a fresh delegate-spawned
  implementer treats it as a **brief, not a contract** → `/delegate` batch mode implements and
  opens the PR → doctor-gated auto-merge (opt-in, **fresh every run, never sticky**) →
  post-merge housekeeping (issue closed, board → Done, `clean-up git --yes`); every issue's
  outcome is always a PR. The **daily hygiene run** and **release-tag hook** are the other two.
- **Sponsor links (#113).** `.github/FUNDING.yml` + README badges landed.

## Known issues & things to watch

- **No npm package yet** — install only via `npx github:dustinkeeton/wafflestack`.
- **The self-render is committed.** After editing anything under `stacks/**`,
  `schema/**`, or `installer/**`, re-run `node installer/cli.mjs render` and commit the
  updated files + lock — the `waffle-doctor` required check fails PRs on drift.
- **Deliberately gitignored here**: `.claude/worktrees/` (throwaway), `.codex/` /
  `.agents/` (non-targets), the `waffle-label-hook.yml` workflow (would arm a live
  label→harness dispatch), and the generated `.waffle/` overview docs
  (`CHEATSHEET.md`, `TEAM.md`, `cheatsheet.html`, `team.html`). `doctor` runs with
  `--allow-missing` so these absences don't fail CI.

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations |
| `gh` (GitHub CLI) | authenticated | Required only by the `github-workflow` stack |

## Verify it yourself

```bash
npm test                          # installer test suite (280 tests, 46 suites)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render     # regenerate this repo's rendered files
node installer/cli.mjs doctor     # confirm no drift vs. the lock
```
