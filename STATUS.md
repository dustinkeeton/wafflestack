# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.9.0 (pre-1.0 — the file contract can still change between minor releases)
- **Last updated**: 2026-07-03
- **Health**: 🟢 tests 173/173 (32 suites) · `validate` clean · `doctor` clean (no render drift)
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Stacks

All 8 stacks are shipped and stable. Pick the ones a project needs.
(Reorganized in #38: the `design` stack was dissolved, near-duplicate roles
were consolidated, and the colliding `security-audit` skills were renamed.)

| Stack | Status | What you get |
|--------|--------|--------------|
| `docs-system` | ✅ Shipped | Two-audience docs: machine (`AGENTS.md`) + human (these files) |
| `github-workflow` | ✅ Shipped | Git / GitHub issue / Projects / release workflow + 4 prefab CI workflows (doctor + 3 opt-in syrup hooks); only stack with a `setup:` step |
| `orchestration` | ✅ Shipped | Multi-agent orchestration: project/product management, delegate, audit, docs, standup |
| `code-quality` | ✅ Shipped | Cross-cutting, stack-agnostic practice skills: TDD, codebase-architecture |
| `engineering-team` | ✅ Shipped | 6-agent product-engineering roster (lead-engineer is the general architect) + webapp-security-audit |
| `obsidian-dev` | ✅ Shipped | Obsidian plugin development (plugin-architect + obsidian-plugin-dev + electron-security-audit) |
| `expo-dev` | ✅ Shipped | Expo / React Native app development (mobile-architect + reference skills) |
| `harness-architect` | ✅ Shipped | Single domain agent — expert in building agent harnesses (agent/skill/tool decomposition, subagent teams, hooks, MCP, multi-harness portability) |

Totals: 14 agents and 21 skills across the 8 stacks.

## Installer & CLI

The `wafflestack` CLI (13 pipeline modules under `installer/lib/`) is complete and
tested. All 8 commands work:

`init` · `setup` · `install` · `render` · `upgrade` · `doctor` · `eject` · `validate`

- `install <ref…>` records a stack or a single item in `.waffle/waffle.yaml`
  (resolving dependencies), then renders. Bare `install` just renders.
- `render`/`install` take `--force` to override the overwrite guard (render
  refuses to clobber a pre-existing untracked file without it).
- A **ref** can now name a `files/PATH` payload (a workflow or script), alongside
  `agents/NAME` and `skills/NAME` — and `eject` accepts all three forms.

## Current focus

- **Rebrand — waffles, stacks, syrup (new, #59).** Vocabulary now matches the name: an
  installable item (agent/skill) is a **waffle**, a named group is a **stack** (was
  "bundle" — source dir `stacks/`, manifest `stack.yaml`), and the `files/` payload is
  **syrup** (gated sensitive ones are **opt-in syrup**; manifest key `optIn:`). The one
  breaking consumer change — `.waffle/waffle.yaml` key `bundles:` → `stacks:` — ships a
  0.10.0 migration plus a read-fallback (a plain `render` still works with a deprecation
  warning). Item refs, `include:`/`eject:`, and lock paths are unchanged.
- **Committed self-render + drift gate (new in 0.9.0).** The repo's own rendered
  harness (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json`) and
  `.waffle/waffle.lock.json` are now **committed**, like a consuming project. A
  `waffle-doctor` CI check on `main` fails any PR whose render drifts from source.
- **Live automation loop.** The daily hygiene run and the release-tag hook operate
  on this repo, gated by the required `doctor` check.
- **Opt-in syrup gate.** A stack's sensitive syrup (`files/`) items (the label-hook,
  hygiene, and release workflows) are excluded from default render unless already
  installed or explicitly included — enabling a stack never silently arms a
  workflow that spends API budget or holds write permissions.
- **Config-aware `setup` (new).** Re-running `setup` on an already-configured repo
  prints a live "Current configuration — update mode" section so the pass curates
  an update instead of a fresh install.

## Known issues & things to watch

- **No npm package yet** — install only via `npx github:dustinkeeton/wafflestack`.
- **The self-render is committed** (since 2026-07-03). After editing anything under
  `stacks/**`, `schema/**`, or `installer/**`, re-run
  `node installer/cli.mjs render` and commit the updated files + lock — the
  `waffle-doctor` required check fails PRs on drift.
- **Deliberately gitignored here**: `.claude/worktrees/` (throwaway), `.codex/` /
  `.agents/` (non-targets), the `waffle-label-hook.yml` workflow (would arm a live
  label→harness dispatch), and the generated `.waffle/` overview docs
  (`CHEATSHEET.md`, `TEAM.md`, `cheatsheet.svg`, `team.svg`). `doctor` runs with
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
npm test                          # installer test suite (173 tests, 32 suites)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render     # regenerate this repo's rendered files
node installer/cli.mjs doctor     # confirm no drift vs. the lock
```
