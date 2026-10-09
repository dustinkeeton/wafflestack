# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.16.1 (tagged 2026-09-18; pre-1.0 — the file contract can still change
  between minor releases). `main` carries unreleased work on top — see below.
- **Last updated**: 2026-10-06
- **Health**: 🟢 tests 1576 in 215 suites (2 skipped by design, #445) · `validate` clean · CI green on `main` at `5e28be6` (PR #557's merge)
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 9 stacks are shipped and stable — **14 agents and 41 skills** in total. Pick what a project needs.

| Stack | What you get |
|--------|--------------|
| `docs-system` | Two-audience docs: machine (`AGENTS.md`) + human (these files), plus the writing-craft skills (`prose`, `md-maximalist`, `accurate`) and the `diagram` proxy skill |
| `github-workflow` | Git / GitHub issue / Projects / release skills + 14 prefab `files/` payloads: the doctor drift-gate workflow, **7 opt-in syrup hooks** (label-hook, hygiene, release, post-merge, evals, pr-green, pr-response — the four that dispatch Claude are `targets: [claude]`, #190), and 6 issue/PR/review templates. Only stack with a `setup:` step; declares typed `prerequisites:` |
| `code-quality` | Cross-cutting practice skills: tdd, codebase-architecture, adversarial-review (hostile green-PR review), qa (green PR vs. the linked issue's intent), dry |
| `orchestration` | Multi-agent orchestration: delegate (typed checkpoints, run memory, approval gate), autopilot (unattended backlog runner with opt-in QA / review / audit gates), audit, docs, standup, pr-docs (diff-scoped docs refresh on one PR) + 3 manager/planner agents. Also ships `/audit` as **2 opt-in Claude workflow scripts** (#363) |
| `engineering-team` | 6-agent product-engineering roster + webapp-security-audit |
| `obsidian-dev` | Obsidian plugin development (+ electron-security-audit) |
| `expo-dev` | Expo / React Native app development |
| `harness-architect` | Single domain agent — expert in building agent harnesses |
| `wafflestack` | Self-referential: ten `/waffle-*` skills, each wrapping one CLI command; dogfooded here |

## Installer & CLI

All 15 commands work (plus `bake`, a pure alias for `render`), over 26 pipeline modules in
`installer/lib/`: `init` · `setup` · `list` · `toggle` · `install` · `render` · `upgrade` ·
`doctor` · `report` · `eject` · `uninstall` · `reinstall` · `avatars` · `validate` · `help`

## Unreleased on `main` — merged 2026-10-06

| Change | What it gives you | State |
|--------|-------------------|-------|
| Generated `.waffle/` docs are presence-optional; `.waffle/avatars/` joins the gitignore baseline (#528) | Gitignoring the overview docs no longer needs `doctor --allow-missing`: absent is a note, an edited copy still fails. `--gitignore` now offers `avatars/` too. [Why](DECISIONS.md#2026-10-06-the-generated-waffle-docs-are-presence-optional-in-doctor-gitignoring-them-no-longer-needs---allow-missing-528) | ✅ Merged (PR #557) — `report`'s health line does not show the new `absentDocs` count yet |
| A refused `install` restores `waffle.yaml` for any reason (#548) | Missing config values, collisions, guards — every refused render rolls the just-saved selection back byte-for-byte, not only an un-eject collision. [Why](DECISIONS.md#2026-10-06-a-refused-install-restores-waffleyaml-byte-for-byte-whatever-the-refusal-548) | ✅ Merged (PR #554) |
| Enrich runs are not reddened by read-only `gh` denials (#544) | The label-hook enrich job accepts the dispatched issue's URL as delivery proof; `gh … list\|view` and read-only `gh api` denials are warnings in both jobs. hygiene / pr-response guards unchanged (#342/#408). [Why](DECISIONS.md#2026-10-06-an-enrich-run-proves-delivery-with-the-issue-url-and-a-read-only-gh-denial-is-a-warning-544) | ✅ Merged (PR #555) — re-render to pick up the workflow |

## Shipped in v0.16.0

Merged 2026-09-15 through 09-18 and ships in v0.16.0 (CHANGELOG `[0.16.0]`):

| Feature | What it gives you | State |
|---------|-------------------|-------|
| `wafflestack report` + `/waffle-report` (#473) | A redacted diagnostics bundle, and a skill that files a toolkit bug **upstream** behind a confirmation gate. Never opens your private overlay. [Why](DECISIONS.md#2026-09-15-report-is-a-cli-command-behind-a-thin-skill-wrapper-and-its-redaction-is-structural-473) | ✅ Shipped |
| `wafflestack toggle` + `/waffle-toggle` (#476) | Per skill: may an agent invoke it on its own, or only you via `/slash`? A committed `skills.modelInvocation` block; Claude target only. [Why](DECISIONS.md#2026-09-16-toggle-makes-agent-invocation-a-per-project-config-input-not-a-hand-edit-476) | ✅ Shipped |
| Harness tool allowlist (#445) | `npm test` fails on any `Tool(` call a skill or agent makes outside the per-target roster. No consumer impact. [Why](DECISIONS.md#2026-09-16-harness-tool-calls-are-checked-against-a-per-target-allowlist-not-a-denylist-445) | ✅ Shipped — `codex` / `agents-dir` rosters undeclared, so those 2 checks skip |
| Three-mode config keys (#478) | Behavioral keys declare `modes:` / `flag:` / `lockMode:` / `nonInteractive:`. **Tightening:** an autopilot consent set in config now fails `render` and `doctor` — remove the line. [Why](DECISIONS.md#2026-09-16-behavioral-skill-flags-become-three-mode-config-keys--modes-flag-lockmode-noninteractive-478-slices-12) | 🟡 Partial — schema, validator and flag inventory only (PR #493); slices #486–#490 open |
| `include:` / `eject:` are mutually exclusive (#497) | **Tightening:** an item in both lists now fails `render` and `doctor`. `install` on an ejected item un-ejects it — and refuses, restoring `waffle.yaml`, if your project-owned copy differs (`--force` overrides). [Why](DECISIONS.md#2026-09-16-include-and-eject-are-mutually-exclusive-install-un-ejects-eject-never-renders-497) | ✅ Shipped (PR #499) |
| Overlap migration `0.16.0` (#501) | `upgrade` drops an overlapping `include:` entry from the committed `waffle.yaml` for you. A test fails a release bump numbered below the migration's version, and an unreleased toolkit runs pending steps too. [Why](DECISIONS.md#2026-09-16-a-migration-may-be-keyed-to-the-next-release-the-key-is-guarded-and-unreleased-toolkits-run-it-501) | ✅ Lands with PR #503 — overlay overlaps are not migrated (#500) |

Also in v0.16.0: the `diagram` proxy skill (#471), the `docs.voiceGuardrailSection` default
(#472), and `WebFetch` + `WebSearch` granted as a pair across the shipped agents (#474).
**Earlier releases** (v0.15.0's `waffle:` label namespace, `/audit` workflow scripts, `/clean-up`
sweep, plugin recommendations): CHANGELOG `[0.15.0]` and the 2026-09-12 entries in DECISIONS.md.

## Known issues & things to watch

- **`uninstall`/`reinstall` gaps (#359, open):** a skipped hand-edit still loses config + `.gitignore`
  block; incomplete `--yes` exits 0; `reinstall` fails on config-but-no-lock; `help` omits `--no-color`.
- **Hidden deletion gap (#371, open):** a poured syrup file whose whole *stack* was deselected is
  pruned while `list` says `not-installed`.
- **Include/eject follow-ups (open):** #500 — `upgrade` never edits `waffle.local.yaml`, so an
  overlap involving that overlay is logged "NOT migrated" for a hand fix. #502 — `render` still warns
  an ejected opt-in hook "was not installed", and the `install` it advises would un-eject it.
- **Dogfood hooks:** hygiene is **armed** — daily cron, workflow tracked in git (PRs #495, #496).
  pr-green and pr-response stay **ejected**; #343 (pluggable CI engine) and #355 (pr-response
  never dispatches) are both open.
- **Comment burn-down follow-ups (open):** #440 bash essays in workflow `run:` blocks, #441
  DECISIONS triage, #442 `AGENTS.md` prose over its 300-line cap.
- **The self-render is committed.** After editing `stacks/**`, re-run
  `node installer/cli.mjs render --allow-unreleased` (flag required, #373) and commit files +
  lock. Two required checks guard it: `waffle-doctor` and the `tests` workflow's render gate.
- **Deliberately gitignored here:** `.claude/worktrees/`, `.codex/`/`.agents/`, and
  `waffle-label-hook.yml` — these are why `doctor` runs with `--allow-missing`. The generated
  `.waffle/` overview docs and `avatars/` are gitignored too but need no flag since #528.

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI (also a `require` prerequisite of `orchestration`) |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations (also a `require` prerequisite of `orchestration`) |
| `gh` (GitHub CLI) | authenticated | `github-workflow`, `orchestration`'s delegate / autopilot / audit skills, and `/waffle-report` filing |
| SVG rasterizer + `WAFFLE_GRAVATAR_TOKEN` | optional | Owner-side only, for `avatars sync` |

## Verify it yourself

```bash
npm test                          # installer test suite (1576 tests, 215 suites)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render --allow-unreleased   # regenerate the render (flag required, #373)
node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # the CI render gate
npm run evals -- --dry-run        # Layer-2 evals (18 cases), mock model, free
```
