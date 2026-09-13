# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.15.0 (tagged 2026-09-13; pre-1.0 — the file contract can still change
  between minor releases).
- **Last updated**: 2026-09-13
- **Health**: 🟢 tests 1298/1298 (174 suites) · `validate` clean · CI green on `main` (`880a13e`)
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 9 stacks are shipped and stable — **14 agents and 37 skills** in total. Pick what a project needs.

| Stack | What you get |
|--------|--------------|
| `docs-system` | Two-audience docs: machine (`AGENTS.md`) + human (these files), plus the writing-craft skills (`prose`, `md-maximalist`, `accurate`) |
| `github-workflow` | Git / GitHub issue / Projects / release skills + 14 prefab `files/` payloads: the doctor drift-gate workflow, **7 opt-in syrup hooks** (label-hook, hygiene, release, post-merge, evals, pr-green, pr-response — the four that dispatch Claude are `targets: [claude]`, #190), and 6 issue/PR/review templates. Only stack with a `setup:` step; declares typed `prerequisites:` |
| `code-quality` | Cross-cutting practice skills: tdd, codebase-architecture, adversarial-review (hostile green-PR review), qa (green PR vs. the linked issue's intent), dry |
| `orchestration` | Multi-agent orchestration: delegate (typed checkpoints, run memory, approval gate), autopilot (unattended backlog runner with opt-in QA / review / audit gates), audit, docs, standup + 3 manager/planner agents. Also ships `/audit` as **2 opt-in Claude workflow scripts** (#363) |
| `engineering-team` | 6-agent product-engineering roster + webapp-security-audit |
| `obsidian-dev` | Obsidian plugin development (+ electron-security-audit) |
| `expo-dev` | Expo / React Native app development |
| `harness-architect` | Single domain agent — expert in building agent harnesses |
| `wafflestack` | Self-referential: eight `/waffle-*` skills, one per CLI command; dogfooded here |

## Installer & CLI

All 13 commands work (plus `bake`, a pure alias for `render`), over 22 pipeline modules in
`installer/lib/`: `init` · `setup` · `list` · `install` · `render` · `upgrade` · `doctor` ·
`eject` · `uninstall` · `reinstall` · `avatars` · `validate` · `help`

## Current focus — shipped in v0.15.0

Everything below merged on 2026-09-12 and ships in v0.15.0 (CHANGELOG `[0.15.0]`):

- **`/clean-up` sweeps a `/delegate` run's leaked agents (#172, closes epic #380).** It reads
  the run checkpoint and judges each agent by its *work* — the PR is merged or closed — never by
  the task status the interruption corrupted. [Why](DECISIONS.md#2026-09-12-clean-up-judges-a-delegate-runs-agents-by-pr-state-from-a-hardcoded-checkpoint-glob-172)
- **`/audit` ships as two staged Claude workflow scripts (#363, closes epic #184).** Opt-in,
  Claude-only syrup; your sign-off happens between the two runs. `/audit` now invokes `/docs`
  instead of copying it (#361), and the spawn-and-collect scaffold has one home in `audit` (#365).
  [Why](DECISIONS.md#2026-09-12-audit-ships-as-two-staged-claude-workflow-scripts--opt-in-claude-scoped-syrup-363-epic-184)
- **Codex coverage has a definition of done (#190).** A content test fails on any literal
  `.claude/…` path in harness-neutral source; the four Claude-dispatch hook workflows are now
  `targets: [claude]`. [Why](DECISIONS.md#2026-09-12-the-codex-toml-carries-no-skill-grant-and-a-sparse-codex-is-the-whole-render-190)
- **Labels: `waffle:<label>` everywhere, one bootstrap table (#451, #452). Breaking default.**
  `waffle-auto-merged` → `waffle:auto-merged`, `waffle-manual-review` → `waffle:manual-review`,
  `Needs Inference` → `waffle:needs-inference`. Rename with `gh label edit` or pin the old names
  via config. Bootstrap block: `schema/SETUP.md` step 4, "Required labels".
  [Why](DECISIONS.md#2026-09-12-harness-labels-live-in-the-waffle-namespace-with-one-bootstrap-list-in-setupmd-451-452)
- **Auto-merge needs three things, and the third is now preflighted (#205).** The required check
  needs branch protection or a ruleset — on GitHub Free, public repos only. New `recommend`-level
  `required-status-check` prerequisite on `orchestration`. [Why](DECISIONS.md#2026-09-12-auto-merge-has-three-prerequisites-and-the-third-is-preflighted-205)
- **Stacks can recommend external plugins (#199).** `recommendedPlugins:` is an offer `setup`
  makes, never an install; no built-in stack declares one yet.
  [Why](DECISIONS.md#2026-09-12-a-stack-may-recommend-external-plugins-that-setup-offers-but-never-installs-199)

## Known issues & things to watch

- **`uninstall`/`reinstall` rough edges (#359, open):** a skipped hand-edit still loses config +
  `.gitignore` block; an incomplete `--yes` exits 0; `reinstall` hard-fails on config-but-no-lock;
  `--no-color` missing from `help`.
- **Hidden deletion gap (#371, open):** a poured syrup file whose whole *stack* was deselected is
  pruned while `list` says `not-installed`.
- **Paid hooks stay disarmed** (no `ANTHROPIC_API_KEY` secret by design). Re-arming waits on
  #343 (pluggable CI engine) and #355 (pr-response hook never dispatches). Both open.
- **Comment burn-down follow-ups (open):** #440 bash essays inside workflow `run:` blocks
  (~420 lines), #441 DECISIONS triage, #442 `AGENTS.md` prose over its 300-line cap.
- **The self-render is committed.** After editing `stacks/**`, re-run
  `node installer/cli.mjs render --allow-unreleased` (flag required, #373) and commit files +
  lock. Two required checks guard it: the `waffle-doctor` drift gate and the `tests` workflow's
  `doctor --allow-missing --verify-render` step.
- **Deliberately gitignored here** (tolerated by `doctor --allow-missing`): `.claude/worktrees/`,
  `.codex/`/`.agents/` (non-targets), `waffle-label-hook.yml`, and the generated `.waffle/`
  overview docs (`CHEATSHEET.md`, `TEAM.md`, both `.html`, `AVATARS.md`, `avatars/`).

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI (also a `require` prerequisite of `orchestration`) |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations (also a `require` prerequisite of `orchestration`) |
| `gh` (GitHub CLI) | authenticated | `github-workflow`, and `orchestration`'s delegate / autopilot / audit skills |
| SVG rasterizer + `WAFFLE_GRAVATAR_TOKEN` | optional | Owner-side only, for `avatars sync` |

## Verify it yourself

```bash
npm test                          # installer test suite (1298 tests, 174 suites)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render --allow-unreleased   # regenerate the render (flag required, #373)
node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # the CI render gate
npm run evals -- --dry-run        # Layer-2 evals (16 cases), mock model, free
```
