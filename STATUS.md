# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.8.0 (pre-1.0 — the file contract can still change between minor releases)
- **Last updated**: 2026-07-03
- **Health**: 🟢 tests 158/158 · `validate` clean · `doctor` clean (no render drift)
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Bundles

All 7 bundles are shipped and stable. Pick the ones a project needs.
(Reorganized in #38: the `design` bundle was dissolved, near-duplicate roles
were consolidated, and the colliding `security-audit` skills were renamed.)

| Bundle | Status | What you get |
|--------|--------|--------------|
| `docs-system` | ✅ Shipped | Two-audience docs: machine (`AGENTS.md`) + human (these files) |
| `github-workflow` | ✅ Shipped | Git / GitHub issue / Projects workflow + label→harness hook (only bundle with a `setup:` step) |
| `orchestration` | ✅ Shipped | Multi-agent orchestration: project/product management, delegate, audit, docs |
| `code-quality` | ✅ Shipped | Cross-cutting, stack-agnostic practice skills: TDD, codebase-architecture |
| `engineering-team` | ✅ Shipped | 6-agent product-engineering roster (lead-engineer is the general architect) + webapp-security-audit |
| `obsidian-dev` | ✅ Shipped | Obsidian plugin development (plugin-architect + obsidian-plugin-dev + electron-security-audit) |
| `expo-dev` | ✅ Shipped | Expo / React Native app development (mobile-architect + reference skills) |

Totals: 13 agents and 17 skills across the 7 bundles.

## Installer & CLI

The `wafflestack` CLI (10 pipeline modules under `installer/lib/`) is complete and
tested. All 7 commands work:

`init` · `setup` · `install` · `render` · `doctor` · `eject` · `validate`

`install <ref…>` is the newest: it records a bundle or a single item in
`.waffle/waffle.yaml` (resolving dependencies), then renders. Bare `install` with no
refs just renders.

## Current focus

- **Brand identity (new).** WaffleStack now carries the WaffleWorks-family brand:
  marks, palette, type, and usage rules live in [`assets/`](assets/README.md)
  (from the Claude Design project "WaffleWorks brand extension"). Applied to the
  README, the CLI usage splash, and the GitHub repo (description, topics, social
  preview card).
- **`.waffle/` config layout (new in 0.8.0).** The consumer config trio now lives
  inside `.waffle/` (`waffle.yaml`, `waffle.local.yaml`, `waffle.lock.json`) next to
  `extensions/` — one wafflestack entry at the repo root, with an automatic in-place
  migration on `render`/`upgrade` (#43).
- **Dogfooding.** The repo renders 4 of its own bundles into itself —
  `github-workflow`, `docs-system`, `orchestration`, and `harness-architect` — so
  the toolkit's own agents and skills are available when developing it. As of
  2026-07-03 the automation loop is live: the daily hygiene run and the
  release-tag hook operate on this repo, gated by the required `doctor` check.

## Known issues & things to watch

- **No npm package yet** — install only via `npx github:dustinkeeton/wafflestack`.
- **The self-render is committed** (since 2026-07-03; the label-hook workflow and
  `.waffle/` overview docs stay gitignored). After editing anything under
  `bundles/**`, `schema/**`, or `installer/**`, re-run
  `node installer/cli.mjs render` and commit the updated files + lock — the
  `waffle-doctor` required check fails PRs on drift.
- ~~Obsidian-plugin phrasing leaks / `security-audit` name collision~~ —
  resolved in #38: the variants are renamed (`electron-security-audit`, now in
  `obsidian-dev`; `webapp-security-audit`), and the `code-quality` skills plus
  `security-engineer` were generalized (Obsidian-specific material relocated
  into `obsidian-plugin-dev`).

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations |
| `gh` (GitHub CLI) | authenticated | Required only by the `github-workflow` bundle |

## Verify it yourself

```bash
npm test                          # installer test suite (158 tests)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render     # regenerate this repo's rendered files
node installer/cli.mjs doctor     # confirm no drift vs. the lock
```
