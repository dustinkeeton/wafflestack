# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.12.0 (tagged 2026-07-11; pre-1.0 — the file contract can still change
  between minor releases). A large unreleased batch sits on `main` — see Current focus.
- **Last updated**: 2026-07-15
- **Health**: 🟢 tests 1203/1203 (156 suites) · `validate` clean · CI green on `main`
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 9 stacks are shipped and stable — **14 agents and 37 skills** in total. Pick what a project needs.

| Stack | What you get |
|--------|--------------|
| `docs-system` | Two-audience docs: machine (`AGENTS.md`) + human (these files), plus the writing-craft skills (`prose`, `md-maximalist`, `accurate`) |
| `github-workflow` | Git / GitHub issue / Projects / release skills + 14 prefab `files/` payloads: the doctor drift-gate workflow, **7 opt-in syrup hooks** (label-hook, hygiene, release, post-merge, evals, pr-green, pr-response), and 6 issue/PR/review templates. Only stack with a `setup:` step; declares typed `prerequisites:` |
| `code-quality` | Cross-cutting practice skills: tdd, codebase-architecture, adversarial-review (hostile green-PR review), qa (green PR vs. the linked issue's intent), dry |
| `orchestration` | Multi-agent orchestration: delegate (typed checkpoints, run memory, approval gate), autopilot (unattended backlog runner with opt-in QA / review / audit gates), audit, docs, standup + 3 manager/planner agents |
| `engineering-team` | 6-agent product-engineering roster + webapp-security-audit |
| `obsidian-dev` | Obsidian plugin development (+ electron-security-audit) |
| `expo-dev` | Expo / React Native app development |
| `harness-architect` | Single domain agent — expert in building agent harnesses |
| `wafflestack` | Self-referential: eight `/waffle-*` skills, one per CLI command; dogfooded here |

## Installer & CLI

All 13 commands work (plus `bake`, a pure alias for `render`), over 20 pipeline modules in
`installer/lib/`: `init` · `setup` · `list` · `install` · `render` · `upgrade` · `doctor` ·
`eject` · `uninstall` · `reinstall` · `avatars` · `validate` · `help`

## Current focus — unreleased, on `main`

Everything below is merged but not yet tagged (CHANGELOG `[Unreleased]`; latest tag v0.12.0):

- **The CLI proves what toolkit it is before writing (#373/#374/#372).** An unpinned `npx github:…`
  fetches the default branch, not the latest release — so `render`, `install`, `upgrade`,
  `reinstall`, and `doctor --verify-render` now **refuse** when the CLI is provably not at a
  release tag, naming the exact pinned command. The lock records which toolkit rendered it
  (ref + commit, release-only), and `upgrade` moves `toolkitRef` pins you already chose.
  [Why](DECISIONS.md#2026-07-13-upgrade-rewrites-only-the-pins-a-consumer-already-chose-and-never-re-execs-372)
- **Syrup can scope itself to harness targets (#364).** A `files/` payload with `targets:` renders
  only for enabled harnesses; dropping its last target prunes it. `list` gains `not installable`
  and `PENDING REMOVAL`; every scope malformation is a hard load error, because the prune deletes
  files. [Why](DECISIONS.md#2026-07-13-syrup-can-scope-itself-to-harness-targets--and-every-way-to-get-the-scope-wrong-is-a-hard-load-error-364-pr-370)
- **The CLI surface is complete (epic #346).** `help` exits 0 on stdout; `uninstall`/`reinstall`
  are the first destructive commands — the lock decides what may be deleted, dry run until
  `--yes`. Four rough edges ship with them (#359, see Known issues).
- **Comments are not spec (#388) + pr-response rubric v3 (#385).** Deterministic files carry rules
  in code + behavior tests; a comment-vs-code finding shrinks the comment. The burn-down landed
  across PRs #389–#402; the rubric's Implement bar moves ≥10 → **≥11**, so a merely valid, cheap
  nit now Defers.
- **CI hooks key on out-of-band signals (#338/#354):** commit statuses and a pre-dispatch label,
  never a marker pasted in prose; PR-gate staging paths now also carry the head SHA (#376/#412).
- **Orchestration skills call the tools the harness actually has (#360)** — dead primitives
  (`TeamCreate` etc.) removed, with a source-wide regression sweep.

## Known issues & things to watch

- **The paid-hook disarm is half-landed (#396).** hygiene / pr-green / pr-response left
  `include:` and git tracking, but the committed lock still tracks them — every `render` re-pours
  them onto disk **untracked and not gitignored**. A `git add -A` would re-arm pr-green. Finishing
  it is an owner call; don't "fix" the lock/yaml/gitignore in passing.
  [Details](DECISIONS.md#2026-07-15-the-paid-claude-dispatch-hooks-are-disarmed-while-the-repo-carries-no-api-key-396)
- **`uninstall`/`reinstall` rough edges (#359):** a skipped hand-edit still loses config +
  `.gitignore` block; an incomplete `--yes` exits 0; `reinstall` hard-fails on config-but-no-lock;
  `--no-color` missing from `help`.
- **Hidden deletion gap (#371):** a poured syrup file whose whole *stack* was deselected is pruned
  while `list` says `not-installed`.
- **No npm package yet** — install only via `npx github:dustinkeeton/wafflestack`.
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
| Node.js | ≥ 18 | Running the CLI |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations |
| `gh` (GitHub CLI) | authenticated | Required only by the `github-workflow` stack |
| SVG rasterizer + `WAFFLE_GRAVATAR_TOKEN` | optional | Owner-side only, for `avatars sync` |

## Verify it yourself

```bash
npm test                          # installer test suite (1203 tests, 156 suites)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render --allow-unreleased   # regenerate the render (flag required, #373)
node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased   # the CI render gate
npm run evals -- --dry-run        # Layer-2 evals (15 cases), mock model, free
```
