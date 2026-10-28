# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.18.0 (2026-10-25; pre-1.0 — the file contract can still change between minor releases).
- **Last updated**: 2026-10-25
- **Health**: 🟢 tests 1830 in 241 suites (1828 pass, 2 skipped by design, #445) · `validate` clean · CI green on `main` at `32f668d` (PR #683's merge)
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

All 16 commands work, plus 2 aliases (`init` → `setup` since #611, `bake` → `render`), over 34
pipeline modules in `installer/lib/`: `setup` (alias `init`) · `list` · `toggle` · `install` · `render` · `upgrade` ·
`doctor` · `state` · `config` · `report` · `eject` · `uninstall` · `reinstall` · `avatars` · `validate` · `help`

## Shipped in v0.18.0 — merged 2026-10-15 through 10-24

| Change | What it gives you | State |
|--------|-------------------|-------|
| Wording-only review findings are nits (#682) | The pr-response rubric, `adversarial-review`, and `qa` share one test: a finding rises above nit only if it names wrong behavior, a wrong command, path or label, a missing test for changed behavior, or text that would mislead its reader. A nit is never Deferred: small ones are implemented, the rest declined. The Implement cutoff is unchanged. [Why](DECISIONS.md#2026-10-24-wording-only-review-findings-are-nits-and-a-nit-never-files-a-follow-up-682) | ✅ Merged (PR #683) — re-render; review loops stop filing follow-ups for wording-only findings |
| `/waffle-report` picks the form by structure (#674, #642) | A `bug:` / `feature:` prefix wins; else an `Expected:` or `Actual:` line files `bug.yml`, a `Proposed Solution:` line files `feature.yml`, and anything else files `rough-idea.yml` verbatim. Redaction covers every line of pasted output and a remote's bare `owner/repo`; the reply never echoes a redacted value. [Why](DECISIONS.md#2026-10-24-waffle-report-picks-the-form-by-structure-never-by-wording-674) | ✅ Merged (PRs #666, #676) — re-render; prefix a plain-prose defect with `bug:` to file a bug |
| The `/waffle-report` hold lands without triage rights (#640) | Most filers can't add labels, so their reports used to land unheld. The toolkit's own tracker now runs `.github/workflows/consumer-report-hold.yml` on `issues: opened`: when the body carries the report block's `<summary>` line (`REPORT_SUMMARY` in `installer/lib/report.mjs`), it adds `waffle:reassess` and `waffle:consumer-report` with the repo token. Issues filed by an `OWNER`, `MEMBER`, or `COLLABORATOR` are skipped (#653), so a maintainer's follow-up that quotes a report is not held; their own label adds already apply. Toolkit repo only — no stack renders it; a fork that takes reports copies the workflow. [Why](DECISIONS.md#2026-10-23-the-waffle-report-hold-is-applied-server-side-on-the-toolkit-tracker-640) | ✅ Merged (PRs #651, #656) — re-render for the skill wording only |
| The pr-response rubric's cutoffs are config (#630, slice 1) | `prResponse.rubric.thresholds.implement` (default 11) and `.decline` (default 4) set where Implement and Decline start; they are repo policy, so moving one needs no rubric version bump. Two new manifest guards: a per-key `range: { min, max }` and a stack-level `constraints:` list (one kind, `lessThan`, keeps Decline below Implement). A bad value fails `render` and bare `doctor`. Weights (#644), a per-run `--rubric` token (#645), and autopilot pass-through (#646) followed. [Why](DECISIONS.md#2026-10-23-the-pr-response-cutoffs-are-repo-policy-guarded-by-range-and-constraints-630) | ✅ Merged (PR #650) — re-render; with no config only the Defer band's wording changes ("> 4 and < 11" instead of "5–10") |
| The pr-response composite is weighted (#644, #630 slice 2) | `prResponse.rubric.weights.{severity,reach,validity,effortRisk,alignment}` (default 1, at least 0) scale each dimension; the composite `15 × Σ(wᵢ·sᵢ) / Σ(wᵢ·3)` stays on 0–15, so the cutoffs keep their meaning. A new constraint kind, `anyPositive`, fails `render` and bare `doctor` when every weight is 0. Overrides read raw scores; replies add a `Weighted` column when any weight is not 1 and name the weights in the footer. A per-run `--rubric` token (#645) followed. [Why](DECISIONS.md#2026-10-23-the-pr-response-composite-is-weighted-and-normalized-to-015-644) | ✅ Merged (PR #661) — re-render; with no config verdicts are unchanged |
| `/pr-response --rubric` overrides the rubric for one run (#645, #630 slice 3) | `--rubric implement=12,decline=3,validity=2` sets any subset of the cutoffs and weights for that run only. It is resolved before any finding is read, merged over config, and checked by render's rules. A bad token is ignored as a whole: attended runs ask, `--yes` or a non-interactive run falls back to config and says so. The footer names its source (`config`, `run override`, or `config (--rubric ignored)`). Autopilot pass-through (#646) followed. [Why](DECISIONS.md#2026-10-23-a-pr-response---rubric-override-is-validated-after-merging-and-falls-back-as-a-whole-645) | ✅ Merged (PR #663) — re-render; runs without `--rubric` are unchanged |
| `/autopilot --rubric` forwards a per-run rubric to its responders (#646, #630 slice 4) | `/autopilot #12 +review --rubric implement=12` validates the token once before any work, merged over the rendered rubric, and passes it verbatim as `pr-response <pr> --yes --rubric <spec>` to every QA-gate and review-loop responder spawn (never on a resume). A bad token asks (attended) or stops the run (non-interactive) rather than falling back; two different specs stop. The run report names the effective rubric. [Why](DECISIONS.md#2026-10-23-autopilot-validates---rubric-once-up-front-and-stops-where-pr-response-falls-back-646) | ✅ Merged (PR #664) — re-render; runs without `--rubric` are unchanged |
| Protected docs are a configurable list (#612) | `docs.protectedDocs` (a list of paths, globs allowed) replaces the prose key `docs.voiceGuardrailSection`. The guardrail section is generated from the list in neutral wording and now renders into docs-agent too. An override replaces the default list; `[]` renders no section. Here the list is `CHANGELOG.md` and `.waffle/**`. [Why](DECISIONS.md#2026-10-23-protected-docs-are-a-list-and-the-guardrail-is-generated-from-it-612) | ✅ Merged (PR #647) — **breaking** if you set the old key: `render` fails until `upgrade` runs migration `0.18.0`; otherwise re-render |
| `/waffle-report` requests the hold (#609) | Every filing tries to add `waffle:reassess` (keeps `delegate`, `autopilot`, and `label-hook` off an unreproduced report; only the upstream human removes it) and `waffle:consumer-report` (provenance, upstream tracker only), each in its own call after the issue is created with the form label. Adding a label needs triage or write access, so most filers' adds fail with a warning and the report files without the hold. The toolkit tracker applies the hold server-side instead (#640, row above). [Why](DECISIONS.md#2026-10-22-waffle-report-is-the-reassess-holds-one-automated-entry-point-609) | ✅ Merged (PR #639) — re-render |
| `init` and `setup` are one command (#611) | `setup` writes the starter `.waffle/waffle.yaml` when none exists, then prints the playbook; it never overwrites a config. `init` is a byte-identical alias, and `/waffle-init` aliases `/waffle-setup`. [Why](DECISIONS.md#2026-10-22-init-and-setup-merge-into-one-onboarding-command-611) | ✅ Merged (PR #637) — re-render; `init` on a configured repo now exits 0 instead of 1 |
| project-manager groups issues into epics (#633) | While reviewing the backlog it groups related issues under an `[epic]` parent, after you confirm. `github-project-management` gains a "Link an existing issue to a parent epic" recipe and now queries native sub-issues. | ✅ Merged (PR #634) — re-render |
| Config can turn autopilot's gates off (#626) | `qaLoop`, `reviewLoop`, and `auditStep` accept `false` or `prompt` in config (new `configModes:` field); config `true` still fails `render` and `doctor`. New off tokens `-qa` / `-review` / `-audit`; `+qa:0` / `+review:0` mean off. `autoMerge` stays locked to `prompt`. [Why](DECISIONS.md#2026-10-22-config-may-turn-autopilots-gates-off-never-on-626) | ✅ Merged (PR #635) — re-render |
| pr-response hook finds and re-checks its PR (#355, #334, #622–#624) | pr-green records the reviewed PR in a `waffle-pr-target` artifact; the pr-response hook reads exactly one target, re-verifies the PR and the checked-out commit, and logs a failed download instead of hiding it. Both hooks fold paginated statuses, so a busy head is never double-reviewed. [Why](DECISIONS.md#2026-10-21-pr-response-threads-its-target-through-a-pr-green-artifact-355) | ✅ Merged (PRs #619, #621, #627, #629, #631) — re-render **both** hooks if you opted in |
| Manual-review queue service level (#511) | A cap-reached QA/review loop files a follow-up only for should-fix and blocker findings; a nit-only pass files nothing and lists its nits in the run report as "reported, not filed". The audit gate still files every unresolved Critical/High. Every run report ends with the open hold queue (number, title, age). No cron — hygiene is a paid dispatch. One-time triage done: the queue is now empty. [Why](DECISIONS.md#2026-10-19-the-manual-review-queue-gets-a-severity-floor-on-filing-and-every-run-report-burns-it-down-511) | ✅ Merged (PR #618) — re-render |
| Autopilot gate loops converge on a cold round (#510, #357) | The QA and review loops stop only when a **cold** reviewer (no history of the PR) implements 0 findings; an anchored "clean" triggers one fresh certification round. Bound: cap + 1 reviewer passes per loop, 10 gate passes per PR per run with both loops on at the default caps. The cap stays per-run. [Why](DECISIONS.md#2026-10-19-autopilots-gate-loops-converge-only-on-a-cold-round-the-cap-stays-per-run-510-357) | ✅ Merged (PR #617) — re-render |

## Earlier releases

v0.17.x (docs refresh per PR, mods + `state`, picker hints) and everything before it: see
[CHANGELOG.md](CHANGELOG.md).

## Known issues & things to watch

- **`uninstall`/`reinstall` gaps (#359, open):** a skipped hand-edit still loses config + `.gitignore`
  block; incomplete `--yes` exits 0; `reinstall` fails on config-but-no-lock; `help` omits `--no-color`.
- **Overlay overlaps aren't migrated (#500, open):** `upgrade` never edits `waffle.local.yaml`, so an
  `include:`/`eject:` overlap there is logged "NOT migrated" for a hand fix.
- **`waffle-view` follows typed commands only:** the pane tracks the last `/name` you typed, not a
  skill the model calls mid-turn. Its `config` values include your gitignored overlay.
- **Dogfood hooks:** hygiene is **armed** (daily cron). pr-green and pr-response stay **ejected**;
  #343 (pluggable CI engine) is open. #355 is fixed in source: pr-response reads its target from
  pr-green's `waffle-pr-target` artifact, hardened by #622–#624. The fix is unproven live until both hooks are re-armed (#343).
- **Comment burn-down follow-ups (open):** #440 bash essays in workflow `run:` blocks, #441
  DECISIONS triage, #442 `AGENTS.md` prose trim (652 lines, cap 300; fences gone since #415).
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
npm test                          # installer test suite (1830 tests, 241 suites)
npm run validate                  # manifests + placeholders lint, plus mod validation
node installer/cli.mjs render --allow-unreleased   # regenerate the render (flag required, #373)
node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # the CI render gate
npm run evals -- --dry-run        # Layer-2 evals (28 cases), mock model, free
```
