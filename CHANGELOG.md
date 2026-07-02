# Changelog

All notable changes to WaffleStack are recorded here. This file is also the source that
`wafflestack upgrade` reads to show a consumer what changed between the toolkit version
their repo last rendered from and the version they are upgrading to.

The format follows [Keep a Changelog](https://keepachangelog.com/); versions map to git
tags (`vX.Y.Z`). Each release carries a **Consumer impact** line so you know at a glance
whether an upgrade is a plain re-render or needs a migration.

## What a version bump means for a consumer

WaffleStack versions are semver, read from the perspective of a *consuming* repo:

- **patch** (`0.5.0 → 0.5.1`) — content-only fixes. `render` regenerates; nothing else to do.
- **minor** (`0.5.0 → 0.6.0`) — new bundles/items or additive config. `render` picks them
  up; existing config and extensions are untouched.
- **major / breaking** — a renamed or removed bundle/item, a new *required* config key, or
  a changed file layout. These ship a **migration** and are called out under Consumer impact.

**Canonical upgrade command** — run the toolkit at the tag you want and let it walk you across:

```bash
npx github:dustinkeeton/wafflestack#<newtag> upgrade
```

`upgrade` compares your lock's `toolkitVersion` to the invoked toolkit, prints the entries
below that fall in between, runs any registered migrations in order, then re-renders and
runs `doctor`. A plain re-render (`… render`) still works for patch/minor moves; `upgrade`
is what you reach for across a breaking one.

## [Unreleased]

### Consumer impact
- **Breaking, but automatic — consumer dotfiles renamed `.wafflestack.*` → `.waffle.*`.**
  The 0.6.0 migration renames your config, local overlay, lock, and extensions dir in place
  on the next `render`/`upgrade`; the legacy `.wafflestack.*` names keep working (with a
  deprecation note) until then. Update your `.gitignore` entries afterwards
  (`.wafflestack.local.yaml` → `.waffle.local.yaml`) — the CLI does not edit `.gitignore`.
  The new `upgrade` command and this changelog are otherwise additive.

### Added
- `wafflestack upgrade`: compares the lock's `toolkitVersion` to the invoked toolkit,
  prints the changelog delta, runs registered migrations in `(lockVersion, toolkitVersion]`
  order, then re-renders and runs `doctor`.
- Migration registry + runner (`installer/lib/migrations.mjs`): ordered, idempotent,
  version-keyed steps (`{ version, description, run(cwd) }`).
- First migration step (**0.6.0**): renames the legacy `.wafflestack.*` consumer dotfiles
  to `.waffle.*` (config, local overlay, lock, extensions dir). Shares one idempotent
  `migrateLegacyDotfiles` helper with `render`, so `upgrade` and a plain re-render converge.
- Legacy-name read fallback: `render`, `doctor`, `eject`, and `install` read a legacy
  `.wafflestack.*` file with a deprecation note when the `.waffle.*` name is absent.
- `CHANGELOG.md` (this file), wired into `upgrade` and the `files` allow-list so it ships
  in the package.

### Changed
- Consumer dot-paths are now `.waffle.yaml`, `.waffle.local.yaml`, `.waffle.lock.json`, and
  `.waffle/extensions/` (were `.wafflestack.*`). A plain `render` migrates a legacy repo and
  warns when `.gitignore` still lists the old names. The `wafflestack` package/CLI name, npx
  specs, and the `wafflestack-doctor.yml` workflow filename are unchanged.
- `doctor` now reports the rendered `toolkitVersion` unconditionally (not only on skew),
  and points at `wafflestack upgrade` when the lock and CLI versions differ.

## [0.5.0] - 2026-07-01

### Consumer impact
- No migration required. Re-render (`… render`) to pick up the setup wizard and the
  self-hosted `github-workflow` bundle.

### Added
- Agent-driven `setup` command: prints an install playbook plus an inventory generated
  from the installed toolkit (bundles, config keys, env prerequisites, setup notes).
- Self-hosted `github-workflow` bundle (git / issue / Projects v2 / clean-up).

_Releases before 0.5.0 (`v0.1.0`–`v0.4.0`) predate this changelog; see the git tags for
their history._
