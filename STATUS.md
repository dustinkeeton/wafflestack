# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.17.2 (2026-10-11; pre-1.0 — the file contract can still change between minor releases).
- **Last updated**: 2026-10-23
- **Health**: 🟢 tests 1696 in 228 suites (1694 pass, 2 skipped by design, #445) · `validate` clean · CI green on `main` at `0e674a0` (PR #589's merge)
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 9 stacks are shipped and stable — **14 agents, 41 skills, and 1 mod** in total. Pick what a project needs.

| Stack | What you get |
|--------|--------------|
| `docs-system` | Two-audience docs: machine (`AGENTS.md`) + human (these files), plus the writing-craft skills (`prose`, `md-maximalist`, `accurate`) and the `diagram` proxy skill |
| `github-workflow` | Git / GitHub issue / Projects / release skills + 14 prefab `files/` payloads: the doctor drift-gate workflow, **7 opt-in syrup hooks** (label-hook, hygiene, release, post-merge, evals, pr-green, pr-response — the four that dispatch Claude are `targets: [claude]`, #190), and 6 issue/PR/review templates. Hygiene's docs task is a drift backstop (#586). Declares typed `prerequisites:` |
| `code-quality` | Cross-cutting practice skills: tdd, codebase-architecture, adversarial-review (hostile green-PR review), qa (green PR vs. the linked issue's intent), dry |
| `orchestration` | Multi-agent orchestration: delegate (typed checkpoints, run memory, approval gate, per-PR docs refresh), autopilot (unattended backlog runner with opt-in QA / review / audit gates), audit, docs, standup, pr-docs (diff-scoped docs refresh on one PR) + 3 manager/planner agents. Also ships `/audit` as **2 opt-in Claude workflow scripts** (#363) |
| `engineering-team` | 6-agent product-engineering roster + webapp-security-audit |
| `obsidian-dev` | Obsidian plugin development (+ electron-security-audit) |
| `expo-dev` | Expo / React Native app development |
| `harness-architect` | Single domain agent — expert in building agent harnesses |
| `wafflestack` | Self-referential: ten `/waffle-*` skills, each wrapping one CLI command, plus the **`waffle-view` mod** (a live state pane, claude target only); dogfooded here |

## Installer & CLI

All 16 commands work (plus `bake`, a pure alias for `render`), over 27 pipeline modules in
`installer/lib/`: `setup` (alias `init`) · `list` · `toggle` · `install` · `render` · `upgrade` ·
`doctor` · `state` · `report` · `eject` · `uninstall` · `reinstall` · `avatars` · `validate` · `help`

## Unreleased — after v0.17.2

| Change | What it gives you | State |
|--------|-------------------|-------|
| The pr-response rubric's cutoffs are config (#630, slice 1) | `prResponse.rubric.thresholds.implement` (default 11) and `.decline` (default 4) set where Implement and Decline start; they are repo policy, so moving one needs no rubric version bump. Two new manifest guards: a per-key `range: { min, max }` and a stack-level `constraints:` list (one kind, `lessThan`, keeps Decline below Implement). A bad value fails `render` and bare `doctor`. Next slices: weights (#644), a per-run `--rubric` token (#645), autopilot pass-through (#646). [Why](DECISIONS.md#2026-10-23-the-pr-response-cutoffs-are-repo-policy-guarded-by-range-and-constraints-630) | 🔄 In review (PR #650) — re-render; with no config only the Defer band's wording changes ("> 4 and < 11" instead of "5–10") |
| Protected docs are a configurable list (#612) | `docs.protectedDocs` (a list of paths, globs allowed) replaces the prose key `docs.voiceGuardrailSection`. The guardrail section is generated from the list in neutral wording and now renders into docs-agent too. An override replaces the default list; `[]` renders no section. Here the list is `CHANGELOG.md` and `.waffle/**`. [Why](DECISIONS.md#2026-10-23-protected-docs-are-a-list-and-the-guardrail-is-generated-from-it-612) | ✅ Merged (PR #647) — **breaking** if you set the old key: `render` fails until `upgrade` runs migration `0.18.0`; otherwise re-render |
| `/waffle-report` files on hold (#609) | Every filing carries the form label plus `waffle:reassess` (keeps `delegate`, `autopilot`, and `label-hook` off an unreproduced report; only the upstream human removes it) and `waffle:consumer-report` (provenance, upstream tracker only). Each label is its own call, so a missing one warns instead of failing the filing. [Why](DECISIONS.md#2026-10-22-waffle-report-is-the-reassess-holds-one-automated-entry-point-609) | ✅ Merged (PR #639) — re-render |
| Config can turn autopilot's gates off (#626) | `qaLoop`, `reviewLoop`, and `auditStep` accept `false` or `prompt` in config (new `configModes:` field); config `true` still fails `render` and `doctor`. New off tokens `-qa` / `-review` / `-audit`; `+qa:0` / `+review:0` mean off. `autoMerge` stays locked to `prompt`. [Why](DECISIONS.md#2026-10-22-config-may-turn-autopilots-gates-off-never-on-626) | ✅ Merged (PR #635) — re-render |
| Manual-review queue service level (#511) | A cap-reached QA/review loop files a follow-up only for should-fix and blocker findings; a nit-only pass files nothing and lists its nits in the run report as "reported, not filed". The audit gate still files every unresolved Critical/High. Every run report ends with the open hold queue (number, title, age). No cron — hygiene is a paid dispatch. One-time triage done: the queue is now empty. [Why](DECISIONS.md#2026-10-19-the-manual-review-queue-gets-a-severity-floor-on-filing-and-every-run-report-burns-it-down-511) | ✅ Merged (PR #618) — re-render |
| Autopilot gate loops converge on a cold round (#510, #357) | The QA and review loops stop only when a **cold** reviewer (no history of the PR) implements 0 findings; an anchored "clean" triggers one fresh certification round. Bound: cap + 1 reviewer passes per loop, 10 gate passes per PR per run with both loops on at the default caps. The cap stays per-run. [Why](DECISIONS.md#2026-10-19-autopilots-gate-loops-converge-only-on-a-cold-round-the-cap-stays-per-run-510-357) | ✅ Merged (PR #617) — re-render |

## Shipped in v0.17.0 — merged 2026-10-06 through 10-09

| Change | What it gives you | State |
|--------|-------------------|-------|
| Docs refresh on every delegated PR (#584, #585) | `/pr-docs <PR#>` refreshes docs scoped to one PR's diff. With `delegate.docsRefresh` on (the default), delegate's orchestrator runs it before arming auto-merge; `stopped` leaves the PR unarmed. Autopilot turns it off when its `/audit` step is on. [Why](DECISIONS.md#2026-10-09-the-orchestrator-not-the-spawned-agent-runs-pr-docs-and-arms-auto-merge-585-part-of-572) | ✅ Merged (PRs #587, #588) — re-render; set the key `false` to opt out |
| Hygiene's docs run is a drift backstop (#586) | Skips while a hygiene docs PR is open; diffs the default branch since the last run; `no drift` spawns no agents. [Why](DECISIONS.md#2026-10-09-hygienes-daily-docs-run-is-narrowed-to-a-drift-backstop-not-removed-572-586) | ✅ Merged (PR #589) — re-render |
| Mods render kind + `waffle-view` + `state` (#552, #560–#564) | Stacks can ship Claude Code mods. Since #592 a mod renders as two `.claude/settings.json` entries — the toolkit's plugin marketplace, pinned to your `waffle.toolkitRef` release, and the enabled plugin — so it loads with no flags. `wafflestack state [--json]` prints resolved config, run files, locks, and drift. [Why](DECISIONS.md#2026-10-06-stacks-can-ship-claude-code-mods-rendered-verbatim-and-read-through-state---json-552-560564) | ✅ Merged (PR #565) — additive |
| Picker blocker hints (#549, #577–#579) | `list` flags missing config, a file in the way, a failing guard, prerequisites, and untrusted external sources before you apply. [Why](DECISIONS.md#2026-10-09-the-picker-warns-about-blockers-before-you-apply-using-renders-own-checks-549-577-578-579) | ✅ Merged — output only |
| Minimal `waffle.yaml` edits (#571, #575) | `install` / `eject` change only their own lines; an already-selected ref persists nothing. [Why](DECISIONS.md#2026-10-09-install-and-eject-edit-only-the-lines-they-change-in-waffleyaml-571-575) | ✅ Merged — no re-render |
| File attachments in `/issue` and `/waffle-report` (#523) | Dragged-in files upload to an orphan `issue-assets` branch and land under `## Attachments` | ✅ Merged (PR #573) — re-render |
| Generated `.waffle/` docs are presence-optional (#528) | Gitignoring them no longer needs `doctor --allow-missing`. [Why](DECISIONS.md#2026-10-06-the-generated-waffle-docs-are-presence-optional-in-doctor-gitignoring-them-no-longer-needs---allow-missing-528) | ✅ Merged (PR #557) — `report`'s health line does not show `absentDocs` yet |
| A refused `install` restores `waffle.yaml` (#548) | Any refused render rolls the saved selection back byte-for-byte | ✅ Merged (PR #554) |
| Enrich runs not reddened by read-only `gh` denials (#544) | The issue URL counts as delivery proof | ✅ Merged (PR #555) — re-render |

## Shipped in v0.16.0

Merged 2026-09-15 through 09-18 (CHANGELOG `[0.16.0]`): `wafflestack report` + `/waffle-report`
(#473), `wafflestack toggle` (#476), the harness tool allowlist (#445), three-mode config keys
(#478), `include:`/`eject:` exclusivity (#497) — both tighten `render` and `doctor` — and the `diagram` proxy skill (#471).

## Known issues & things to watch

- **`uninstall`/`reinstall` gaps (#359, open):** a skipped hand-edit still loses config + `.gitignore`
  block; incomplete `--yes` exits 0; `reinstall` fails on config-but-no-lock; `help` omits `--no-color`.
- **Overlay overlaps aren't migrated (#500, open):** `upgrade` never edits `waffle.local.yaml`, so an
  `include:`/`eject:` overlap there is logged "NOT migrated" for a hand fix.
- **`waffle-view` follows typed commands only:** the pane tracks the last `/name` you typed, not a
  skill the model calls mid-turn. Its `config` values include your gitignored overlay.
- **Dogfood hooks:** hygiene is **armed** (daily cron). pr-green and pr-response stay **ejected**;
  #343 (pluggable CI engine) is open. #355 is fixed in source: pr-response reads its target from
  pr-green's `waffle-pr-target` artifact. The fix is unproven live until both hooks are re-armed (#343).
- **Comment burn-down follow-ups (open):** #440 bash essays in workflow `run:` blocks, #441
  DECISIONS triage, #442 `AGENTS.md` prose trim (608 lines, cap 300; fences gone since #415).
- **The self-render is committed.** After editing `stacks/**`, re-run
  `node installer/cli.mjs render --allow-unreleased` (flag required, #373) and commit files + lock.
- **Deliberately gitignored here:** `.claude/worktrees/`, `.codex/`/`.agents/`, and
  `waffle-label-hook.yml` — why `doctor` runs with `--allow-missing`.

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI (also a `require` prerequisite of `orchestration`) |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations (also a `require` prerequisite of `orchestration`) |
| `gh` (GitHub CLI) | authenticated | `github-workflow`, delegate / autopilot / audit / pr-docs, and `/waffle-report` filing |
| `claude` CLI | optional | `validate`'s `claude plugin validate` over mods (skipped visibly without it); loading a mod |
| SVG rasterizer + `WAFFLE_GRAVATAR_TOKEN` | optional | Owner-side only, for `avatars sync` |

## Verify it yourself

```bash
npm test                          # installer test suite (1696 tests, 228 suites)
npm run validate                  # manifests + placeholders lint, plus mod validation
node installer/cli.mjs render --allow-unreleased   # regenerate the render (flag required, #373)
node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # the CI render gate
npm run evals -- --dry-run        # Layer-2 evals (19 cases), mock model, free
```
