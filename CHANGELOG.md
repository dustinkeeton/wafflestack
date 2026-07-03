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
- **New, automatic — every `render` now writes four overview docs into `.waffle/`.** After a
  render/upgrade your repo gains `.waffle/CHEATSHEET.md` + `.waffle/cheatsheet.svg` (a cheat
  sheet of the installed user-invocable skills) and `.waffle/TEAM.md` + `.waffle/team.svg` (an
  introduction to the installed agents), assembled from the exact items you have installed.
  They are lock-tracked, drift-checked by `doctor`, refreshed on every render, and pruned if a
  later selection stops producing them (a repo with no agents gets no `TEAM.*`, etc.) — so they
  are generated output: **commit them, don't hand-edit them** (edit the item frontmatter, or
  gitignore them as this repo does). Nothing else changes; no config or new keys required. (#58)
- **Behavior change, mostly automatic — the `github-workflow` label-hook workflow is now
  opt-in (“syrup”).** `.github/workflows/waffle-label-hook.yml` — whose jobs need repo
  `issues`/`contents`/`pull-requests` write permissions — no longer renders just because the
  `github-workflow` bundle is enabled. A repo that **already tracks the file** in
  `.waffle/waffle.lock.json` keeps rendering and updating it (no action needed). A repo that
  enables the bundle but never committed the workflow will simply stop rendering it on the
  next `render`/`upgrade` (the frozen-image prune removes the now-unselected file if it was
  lock-tracked, or leaves an untracked copy alone). To keep it, install it explicitly:
  `wafflestack install files/.github/workflows/waffle-label-hook.yml` (persists the ref to
  `include:`). The read-only `waffle-doctor.yml` workflow is unaffected — it still renders by
  default. (#51)
- **Additive — a new `/standup` skill renders for repos with the `orchestration` bundle.**
  `render`/`upgrade` picks up `.claude/skills/standup/` (and the `.agents/` mirror) on the next
  run; no new config keys and no migration. Invoke `/standup` for a one-look, per-agent status
  pulse of the codebase. (#56)

### Added
- **Generated `.waffle/` overview docs — cheat sheet + team intro** (#58): a new
  `installer/lib/waffledocs.mjs` assembles two default documents from the computed render
  selection and emits them through render's `emit()` choke point (so they are lock-tracked,
  `doctor`-drift-checked, pruned when stale, and refreshed every render). `CHEATSHEET.md`
  lists every installed user-invocable skill as `/name` + argument-hint + a one-line
  when-to-use; `TEAM.md` introduces each installed agent with its role, when-to-use, and
  granted skills (hand-offs). Each ships a branded, fully self-contained SVG one-pager
  (`cheatsheet.svg`, `team.svg`) sized to the item count — GitHub-renderable, Golden/Syrup/
  Cocoa palette per `assets/README.md`, waffle chrome in the header only, plain scannable body.
  The installer now parses skill frontmatter (`user-invocable`, `argument-hint`, `description`)
  — a skill is a slash command unless it sets `user-invocable: false` (so a `disable-model-
  invocation`-only skill like `audit` still lists). Descriptions are substituted with the same
  resolver render uses, so `{{project.name}}` reads identically to the rendered item.
  Documented in `schema/FORMAT.md` and `AGENTS.md`. (#58)
- **Syrup — an opt-in tier for sensitive bundle items** (#51): a new `syrup:` list in
  `bundle.yaml` names `files/` items (by ref) that must be poured only on request. Enabling a
  bundle no longer renders its syrup items; each renders only when installed explicitly
  (`install files/<path>`, persisted to `include:`) or when the consuming repo already tracks
  its path in the lock (existing installs keep updating). `loadBundle()` parses the flag,
  `validate` rejects a `syrup:` entry that doesn't resolve to a real item in the bundle,
  `computeSelection()`/`renderProject()` gate the selection on include/prior-lock tracking,
  and `wafflestack setup` lists syrup items under a separate default-do-not-install
  acknowledgement. Documented in `schema/FORMAT.md` and the `schema/SETUP.md` playbook. The
  `github-workflow` bundle marks `waffle-label-hook.yml` as syrup; its inert-by-default
  rendered form (fail-closed empty-label gates, no secret) is unchanged. (#51)
- **`wafflestack setup` is now config-aware on a re-run** (#50): when `.waffle/waffle.yaml`
  already exists, the guide injects a **"Current configuration — update mode"** section
  between the playbook and the inventory — the repo's live targets, enabled bundles,
  individual includes, ejects, per-key current-vs-default config values, any unset required
  keys (the render blockers), and syrup items (installed vs. opt-in) — read with the same
  `loadProjectConfig`/`computeSelection`/`makeResolver` the renderer uses, so the agent
  curates the update from real state instead of re-reading the file by hand. An unconfigured
  repo is unchanged (byte-for-byte the first-install output); a malformed config surfaces its
  load error rather than crashing the guide. `setupGuide()` now takes `cwd`, and
  `schema/SETUP.md` step 0 points at the injected section. (#50)
- No migration required, additive: the lead-engineer's ADR (architecture decision record)
  location is now the optional `lead.adrDir` config key (engineering-team bundle), default
  `docs/adr/`. The default preserves current output, so this is a content-only re-render for
  existing repos. Consumers with a different convention set e.g. `lead.adrDir: docs/decisions/`
  in `.waffle/waffle.yaml` and re-render instead of hand-editing the rendered agent (which
  would trip the `doctor` drift gate). (#48)
- **User-invocable `/standup` skill** (orchestration bundle, #56): rounds up a one-look status
  pulse from the *installed* team. It enumerates the roster dynamically by globbing the harness
  agents dir (`.claude/agents/*.md`) and parsing frontmatter `name`/`description` — not a
  hard-coded list — then fans out a single read-only parallel wave asking each agent for an
  ≤3-line report strictly from its own role's seat. Replies are collected via subagent
  **return values** (no reliance on `SendMessage`/`TaskUpdate`, sidestepping the
  silent-specialist caveat), then printed as one compact digest in roster order with
  truncation. Zero side effects — no team, no tasks, no board writes. Wired into
  `bundles/orchestration/bundle.yaml`'s `skills:` list; no new config keys. (#56)

### Added
- `lead.adrDir` config key (engineering-team bundle, `required: false`, default `docs/adr/`):
  the directory where the lead-engineer agent files architecture decision records. Replaces the
  two hardcoded `docs/adr/` literals in `agents/lead-engineer.md` with `{{lead.adrDir}}`,
  following the `planner.productDocsDir` precedent. (#48)

### Fixed
- The `product-manager` agent template (orchestration bundle) no longer hardcodes the
  hand-off name "lead-engineer"; it renders `{{roster.architectAgent}}` instead, so
  orchestration-only consumers see their configured architect (this repo's
  `general-purpose`) rather than an agent that doesn't exist in their roster.
  `roster.architectAgent` still defaults to `lead-engineer`, so engineering-team consumers
  render identically. Content-only — `render` regenerates it. (#49)

## [0.8.0] - 2026-07-02

### Consumer impact
- **Breaking, but automatic — the consumer config trio moves inside `.waffle/`:**
  `.waffle.yaml` → `.waffle/waffle.yaml`, `.waffle.local.yaml` → `.waffle/waffle.local.yaml`,
  `.waffle.lock.json` → `.waffle/waffle.lock.json` (extensions already lived at
  `.waffle/extensions/`), leaving a single wafflestack entry at the repo root. The **0.8.0**
  migration moves the files in place on the next `render`/`upgrade` — chaining from the
  pre-0.6.0 `.wafflestack.*` names too — and the old locations keep working (with a
  deprecation note) until then. Afterwards: commit the moved config (and lock, if you track
  it) and update your `.gitignore` entries (`.waffle.local.yaml` →
  `.waffle/waffle.local.yaml`, `.waffle.lock.json` → `.waffle/waffle.lock.json`) — the CLI
  never edits `.gitignore` unasked; `wafflestack install --gitignore` re-adds the new paths
  for you, and `render` warns while stale root entries remain. (#43)

### Added
- Migration step (**0.8.0**): moves the root `.waffle.*` config trio into `.waffle/`
  (`waffle.yaml`, `waffle.local.yaml`, `waffle.lock.json`) via the same idempotent
  `migrateLegacyDotfiles` chain that `render` runs at startup, ordered after the 0.6.0
  rename so a pre-0.6.0 repo carries all the way forward in one pass. `resolveDotPath`
  generalizes to an ordered multi-generation fallback (`.waffle/waffle.yaml` →
  `.waffle.yaml` → `.wafflestack.yaml`, same for the local overlay and lock), and
  `staleGitignoreEntries` now also flags now-stale root `.waffle.local.yaml` /
  `.waffle.lock.json` lines. (#43)

### Changed
- Canonical consumer paths are now `.waffle/waffle.yaml`, `.waffle/waffle.local.yaml`, and
  `.waffle/waffle.lock.json` (were repo-root `.waffle.*`); `init` writes the new layout
  directly (creating `.waffle/`), and the recommended `.gitignore` entry becomes
  `.waffle/waffle.local.yaml`. `.waffle/extensions/` is unchanged. (#43)

## [0.7.0] - 2026-07-02

### Consumer impact
- **Breaking if your config references reorganized items — the bundle roster was
  reorganized (#38).** The `design` bundle is dissolved (`ux-designer` lives in
  `engineering-team`), the general-architect agent `lead-developer` is renamed
  **`lead-engineer`**, and the two colliding `security-audit` skills are renamed
  `electron-security-audit` (relocated into `obsidian-dev`) and `webapp-security-audit`
  (engineering-team). Lock-managed repos pick the renames up on the next
  `render`/`upgrade` via the frozen-image prune; update your `.waffle.yaml` where it
  names old items (`bundles: [design]`, per-item `include:` refs, or an
  `audit.complianceAgentType` override) — `validate`/`render` fails loudly on stale
  refs. Final layout: 7 bundles, 13 agents, 17 skills.
- **Breaking, but automatic for lock-managed repos — the shipped doctor CI workflow is
  renamed `.github/workflows/wafflestack-doctor.yml` → `.github/workflows/waffle-doctor.yml`.**
  On the next `render`/`upgrade` the frozen-image contract deletes the old locked path and
  writes the new one, so a repo that commits its render **and** `.waffle.lock.json` gets the
  rename for free. Two edge cases need a one-line manual cleanup, because there the old file
  is not lock-managed: if you **ejected** the workflow, or **rendered before the lock
  existed** (or gitignore your lock), the stale `wafflestack-doctor.yml` is left in place —
  delete it yourself with `git rm .github/workflows/wafflestack-doctor.yml`. If you pin the
  workflow as a branch-protection required check or reference its filename / `name:`
  anywhere, retarget those to `waffle-doctor`, and update your `.gitignore` if it listed the
  old path.
- No migration required, additive: the github-workflow bundle now ships a second workflow,
  `.github/workflows/waffle-label-hook.yml`, plus a `label-hook` skill. It renders on your
  next `render`/`upgrade` but is **inert until you opt in**: it dispatches the Claude harness
  only when one of the configured trigger labels (`labelHook.enrichLabel`, default
  `waffle:enrich`; `labelHook.implementLabel`, default `waffle:implement`) is applied to an
  issue by a human, and it needs an `ANTHROPIC_API_KEY` repo secret — **each dispatch spends
  real API budget**. Repos without the labels/secret only accrue skipped runs on labeled
  events. Opt out entirely with `eject: [files/.github/workflows/waffle-label-hook.yml]`.
  Pushing the new file needs the `workflow` credential scope (same as the doctor workflow). (#27)
- No migration required, and the default is safer: `render` now **refuses to overwrite a
  pre-existing file it does not manage** instead of silently clobbering it. If a render
  stops on a `refusing to overwrite …` error, the named path already exists in your repo
  and is not tracked by `.waffle.lock.json` — move the file aside (or fold it into a
  `.waffle/extensions/` file) and re-render, or pass `--force` to let the toolkit's version
  win. A byte-identical file is adopted silently.
- No migration required: a new optional `doctor.flags` config key (github-workflow bundle,
  empty default) lets the shipped doctor CI workflow run extra flags. Set
  `doctor.flags: --allow-missing` to keep the workflow managed on a repo that gitignores a
  subset of its renders, instead of ejecting it. Default renders are behaviorally unchanged.
- No migration required, additive: `init`, `render`, and `install` gain an opt-in
  `--gitignore` flag that appends the entries wafflestack recommends — `.waffle.local.yaml`
  always, plus the configured `git.worktreesDir` when an enabled bundle declares one.
  Appending is idempotent (lines already present are skipped) and preserves existing content,
  under a `# wafflestack` marker. Without the flag nothing changes — the CLI still never edits
  your `.gitignore` unasked; the guided `setup` playbook now also offers these entries for
  your approval. (#29)

### Added
- Label-event hook primitive (github-workflow bundle): a prefab
  `.github/workflows/waffle-label-hook.yml` that dispatches the Claude Code GitHub Action
  when an allowlisted trigger label is applied to an issue, paired with a `label-hook` skill
  defining the label→action map — `waffle:enrich` runs the issue skill's enrich-in-place
  mode, `waffle:implement` implements the issue and opens a PR per git-workflow. Security
  posture built in: exact-match label gates (the label string is never interpolated into
  shell or prompt), human-sender check, per-job least-privilege permissions, SHA-pinned
  actions, an audit comment per dispatch, and prompt-injection guardrails in the skill. New
  optional config: `labelHook.enrichLabel`, `labelHook.implementLabel`, `labelHook.claudeArgs`.
  First `requires:` entry keyed by a `files/` payload, so a per-item install of the workflow
  pulls the skill closure. Adds a general, opt-in **render-time `pattern:` validation** for
  config keys (a regex the resolved value must match, enforced at every substitution site):
  the three `labelHook.*` keys use it so a hostile or malformed value — a quote, newline, or
  `${{ }}` that would corrupt or subvert the workflow's `if:` gate or `claude_args` scalar —
  fails the render loudly instead of silently. (#27)
- Opt-in `.gitignore` offer (#29): a `--gitignore` flag on `init`/`render`/`install` appends
  the recommended ignore entries through a new idempotent `ensureGitignoreEntries(cwd, entries)`
  helper — `.waffle.local.yaml` always, plus the resolved `git.worktreesDir` when an enabled
  bundle declares it (`recommendedGitignoreEntries`). `schema/SETUP.md` step 6 now instructs
  the setup agent to propose the entries and apply them on approval, and the "CLI never edits
  `.gitignore`" doc stance is refined to "never edits it *unasked*." No behavior change without
  the flag.
- `doctor.flags` config key (github-workflow bundle): appends flags to the doctor CI
  workflow's `npx --yes <ref> doctor` command. A repo that deliberately gitignores a subset
  of its renders can set `doctor.flags: --allow-missing` and keep
  `.github/workflows/waffle-doctor.yml` managed — lock-tracked and doctor-clean — instead of
  ejecting the file and losing managed updates. Empty by default, so existing renders are
  behaviorally unchanged. (#30)
- Unmanaged-collision guard on `render`/`install`: a rendered path that already exists on
  disk but is absent from `.waffle.lock.json` fails the render loudly — naming every
  offending path and writing nothing, so the tree is left untouched — instead of
  overwriting a hand-written consumer file. A content-identical file is adopted silently;
  `--force` overwrites a differing file and takes it under lock management. (#25)

### Changed
- Bundle reorganization (#38): bundles regrouped semantically; `design` dissolved
  (`ux-designer` restored into `engineering-team`), `electron-security-audit` relocated
  into `obsidian-dev`, the `code-quality` skills (`tdd`, `codebase-architecture`)
  de-Obsidianified with the Obsidian-specific material moved into `obsidian-dev`'s
  `obsidian-plugin-dev`, `security-engineer` phrasing generalized, and
  `audit.complianceAgentType` now defaults to `lead-engineer` (the general architect;
  override to a domain architect — e.g. `plugin-architect`, `mobile-architect` — where
  one exists). New optional config key `project.testCmd` on `code-quality` (default
  `npm test`).
- Renamed the github-workflow bundle's shipped doctor CI workflow
  `.github/workflows/wafflestack-doctor.yml` → `.github/workflows/waffle-doctor.yml`,
  completing the v0.6.0 `.wafflestack.*` → `.waffle.*` consumer-facing naming alignment
  (this reverses the 0.6.0 decision to keep the old filename). Its internal `name:` and
  `concurrency.group` move from `wafflestack-doctor` to `waffle-doctor` to match; the
  `wafflestack` CLI/package name and the `wafflestack doctor` command the workflow runs are
  unchanged. No migration step ships — lock-managed repos get the rename via the
  frozen-image prune, while ejected or pre-lock copies are unmanaged files the toolkit must
  not delete (per the #25 no-clobber contract), so their cleanup is documented under
  Consumer impact instead. (#28)

## [0.6.0] - 2026-07-02

### Consumer impact
- **Breaking, but automatic — consumer dotfiles renamed `.wafflestack.*` → `.waffle.*`.**
  The 0.6.0 migration renames your config, local overlay, lock, and extensions dir in place
  on the next `render`/`upgrade`; the legacy `.wafflestack.*` names keep working (with a
  deprecation note) until then. Update your `.gitignore` entries afterwards
  (`.wafflestack.local.yaml` → `.waffle.local.yaml`) — the CLI does not edit `.gitignore`.
  Everything else in this release (upgrade command, per-item install, `files/` payloads,
  doctor CI workflow) is additive.

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
- Per-item install: `wafflestack install <ref…>` adds a single skill/agent (or a whole
  bundle) by ref — `skills/<name>`, `agents/<name>`, or bundle-qualified
  `<bundle>/skills/<name>` — with dependencies resolved transitively (agent `skills:`
  frontmatter plus bundle `requires:`) and the selection persisted in config so later
  renders stay deterministic.
- `files/` bundle payload: bundles can ship arbitrary repo-relative files (CI workflows,
  scripts, config) authored under `bundles/<bundle>/files/…`, rendered verbatim with the
  same `{{key}}` substitution, lock tracking, doctor drift detection, and eject support as
  agents and skills. GitHub Actions `${{ … }}` expressions pass through untouched.
- `doctor --allow-missing`: absent managed files are reported informationally instead of
  failing, so CI checkouts that deliberately gitignore some renders can still gate on
  drift. Modified files still fail, as does a missing lock.
- Installable `wafflestack-doctor` CI workflow (github-workflow bundle):
  `.github/workflows/wafflestack-doctor.yml` renders into a consuming repo and runs
  `wafflestack doctor` on push/PR; `doctor.toolkitRef` config pins the toolkit release it
  runs.
- Apache 2.0 license.

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
