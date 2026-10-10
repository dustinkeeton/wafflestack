# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.17.1 (2026-10-09; pre-1.0 — the file contract can still change
  between minor releases).
- **Last updated**: 2026-10-09
- **Health**: 🟢 tests 1664 in 226 suites (2 skipped by design, #445) · `validate` clean · CI green on `main` at `0e674a0` (PR #589's merge)
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
`installer/lib/`: `init` · `setup` · `list` · `toggle` · `install` · `render` · `upgrade` ·
`doctor` · `state` · `report` · `eject` · `uninstall` · `reinstall` · `avatars` · `validate` · `help`

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

Merged 2026-09-15 through 09-18 (CHANGELOG `[0.16.0]`); v0.16.1 followed the same day with fixes.

| Feature | What it gives you |
|---------|-------------------|
| `wafflestack report` + `/waffle-report` (#473) | A redacted diagnostics bundle, and a skill that files a toolkit bug **upstream** behind a confirmation gate |
| `wafflestack toggle` + `/waffle-toggle` (#476) | Per skill: may an agent invoke it on its own, or only you via `/slash`? Claude target only |
| Harness tool allowlist (#445) | `npm test` fails on any `Tool(` call outside the per-target roster; `codex` / `agents-dir` rosters undeclared, so those 2 checks skip |
| Three-mode config keys (#478, #486–#490) | Behavioral keys declare `modes:` / `flag:` / `lockMode:` / `nonInteractive:`; the skills now read them. **Tightening:** an autopilot consent set in config fails `render` and `doctor` |
| `include:` / `eject:` mutually exclusive (#497, #501) | **Tightening:** an item in both fails `render` and `doctor`; `upgrade` migrates the overlap out of `waffle.yaml` |

Also in v0.16.0: the `diagram` proxy skill (#471), `docs.voiceGuardrailSection` (#472), `WebFetch`
+ `WebSearch` granted as a pair (#474), and the `list` deletion-visibility fixes (#371, #502).

## Known issues & things to watch

- **`uninstall`/`reinstall` gaps (#359, open):** a skipped hand-edit still loses config + `.gitignore`
  block; incomplete `--yes` exits 0; `reinstall` fails on config-but-no-lock; `help` omits `--no-color`.
- **Overlay overlaps aren't migrated (#500, open):** `upgrade` never edits `waffle.local.yaml`, so an
  `include:`/`eject:` overlap there is logged "NOT migrated" for a hand fix.
- **`waffle-view` follows typed commands only:** the pane tracks the last `/name` you typed, not a
  skill the model calls mid-turn. Its `config` values include your gitignored overlay.
- **Dogfood hooks:** hygiene is **armed** (daily cron). pr-green and pr-response stay **ejected**;
  #343 (pluggable CI engine) and #355 (pr-response never dispatches) are both open.
- **Comment burn-down follow-ups (open):** #440 bash essays in workflow `run:` blocks, #441
  DECISIONS triage, #442 `AGENTS.md` prose over its 300-line cap.
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
npm test                          # installer test suite (1664 tests, 226 suites)
npm run validate                  # manifests + placeholders lint, plus mod validation
node installer/cli.mjs render --allow-unreleased   # regenerate the render (flag required, #373)
node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # the CI render gate
npm run evals -- --dry-run        # Layer-2 evals (19 cases), mock model, free
```
