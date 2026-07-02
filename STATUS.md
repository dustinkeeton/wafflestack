# Status

**Snapshot of where wafflestack is today.** For history and reasoning see
[DECISIONS.md](DECISIONS.md); for the design see [ARCHITECTURE.md](ARCHITECTURE.md).

- **Version**: v0.5.0 (pre-1.0 — the file contract can still change between minor releases)
- **Last updated**: 2026-07-02
- **Health**: 🟢 tests 26/26 · `validate` clean · `doctor` clean (no render drift)
- **Install**: `npx github:dustinkeeton/wafflestack setup` (no npm publish yet)

## Bundles

All 8 bundles are shipped and stable. Pick the ones a project needs.

| Bundle | Status | What you get |
|--------|--------|--------------|
| `docs-system` | ✅ Shipped | Two-audience docs: machine (`AGENTS.md`) + human (these files) |
| `github-workflow` | ✅ Shipped | Git / GitHub issue / Projects workflow (only bundle with a `setup:` step) |
| `orchestration` | ✅ Shipped | Multi-agent orchestration: delegate, audit, docs |
| `code-quality` | ✅ Shipped | Architect + security specialists; TDD, security-audit, architecture skills |
| `engineering-team` | ✅ Shipped | 7-agent product-engineering roster |
| `design` | ✅ Shipped | Brand SVG / icon / banner asset production |
| `obsidian-dev` | ✅ Shipped | Obsidian plugin development |
| `expo-dev` | ✅ Shipped | Expo / React Native app development |

Totals: 16 agents and 16 skills across the 8 bundles.

## Installer & CLI

The `wafflestack` CLI (9 pipeline modules under `installer/lib/`) is complete and
tested. All 6 commands work:

`init` · `setup` · `render` (alias `install`) · `doctor` · `eject` · `validate`

## Current focus

- **Dogfooding.** The repo now renders 3 of its own bundles into itself —
  `github-workflow`, `docs-system`, and `orchestration` — so the toolkit's own
  agents and skills are available when developing it.
- These human docs and the root `AGENTS.md` are the newest product of that work.

## Known issues & things to watch

- **No npm package yet** — install only via `npx github:dustinkeeton/wafflestack`.
- **Rendered output is gitignored in this repo** (unlike consuming projects).
  Always re-run `node installer/cli.mjs render` after editing anything under
  `bundles/**`, `schema/**`, or `installer/**`.
- **`code-quality` and `engineering-team` both define a `security-audit` skill.**
  They are alternatives — enabling both in one project is a hard render error.
  Enable one, or `eject` one.

## Dependencies

| Dependency | Version / need | Used for |
|------------|----------------|----------|
| Node.js | ≥ 18 | Running the CLI |
| `yaml` | ^2.4.5 | The only runtime dependency (parsing manifests/config) |
| `git` | any | All git operations |
| `gh` (GitHub CLI) | authenticated | Required only by the `github-workflow` bundle |

## Verify it yourself

```bash
npm test                          # installer test suite (26 tests)
npm run validate                  # manifests + placeholders lint
node installer/cli.mjs render     # regenerate this repo's rendered files
node installer/cli.mjs doctor     # confirm no drift vs. the lock
```
