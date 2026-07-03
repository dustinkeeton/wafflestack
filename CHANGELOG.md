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
- **Bug fix, content-only — the scheduled `waffle-hygiene` hook can finally succeed
  (`github-workflow`).** As shipped it dispatched the CI harness with an empty `claude_args`, so
  the headless run began with no `--allowedTools`; in CI there is no human to answer permission
  prompts, so every gated `Write`/`Edit`/`Bash` call was auto-denied and the daily cron billed
  ~$4–5 for a guaranteed no-op (no docs, no commit, no PR). The workflow now bakes a default
  `--allowedTools` covering the full hygiene → docs → git-workflow chain, with
  `hygiene.claudeArgs` folded on the end for your extras. **Re-render to pick it up** — no config
  key changes and no migration; a repo that never installed the syrup hook is unaffected. (#71)
- **Bug fix, content-only — the opt-in `waffle-label-hook` jobs can finally do their work
  (`github-workflow`).** Same defect as #71 in the label hook: both the `enrich` and `implement`
  jobs dispatched the CI harness with an empty `claude_args`, so the headless run began with no
  `--allowedTools` and CI auto-denied every gated `Write`/`Edit`/`Bash` call — enrich could not run
  its `gh issue`/board mutations and implement could not branch, commit, push, or open a PR, so
  every human-applied trigger label billed for a no-op. Each job now bakes a per-job default
  `--allowedTools` (enrich: `gh issue` + `gh api` board calls only, no file edits or git;
  implement: the full `Edit`/`Write` + git + `gh pr` + `gh issue` chain plus the git-workflow
  pre-flight), with `labelHook.claudeArgs` folded on the end for your extras. **Re-render to pick
  it up** — no config key changes and no migration; a repo that never installed the syrup hook is
  unaffected. (#72)
- **Enhancement, content-only — dispatched-harness failures are now visible in CI, not silent
  (`github-workflow`).** The `waffle-hygiene` and `waffle-label-hook` workflows dispatched the paid
  harness with its output hidden and with denials that did not fail the job, so a run blocked from
  every write (the #71/#72 defect) showed a green check with nothing landed — the very failure this
  would have caught on day one. Each dispatch job now (a) uploads its execution log as a
  `claude-execution-log*` workflow artifact (`if: always()`, 7-day retention) and (b) gains a
  `Check harness result` guard that **fails the job on `permission_denials`** (all jobs) and, for
  hygiene, warns on a no-op that reports neither a PR URL nor `no drift`/`skipped`. The action's
  `show_full_output` stays OFF (it streams tool output — possibly secrets — into the
  public-repo-readable run log); the repo-scoped, self-expiring artifact is the safer default.
  **Re-render to pick it up** — no config keys change and no migration; a repo that never installed
  either syrup hook is unaffected. (#73)
- **Bug fix, mostly content-only — the guarded `waffle-hygiene` / `waffle-label-hook` harness can
  finally complete a real run (`github-workflow`).** The first guarded live hygiene run still could
  not finish: the baked allowlist (#71/#72) covered the write chain but not three command classes a
  real CI session needs, and the #73 guard — which failed on *any* denial — then reddened the run
  over all 16. Three fixes close the gap: (1) a deterministic **`Install project dependencies`** step
  (`project.installCmd`, default `npm install`) runs BEFORE the paid dispatch in the hygiene job and
  the label-hook `implement` job, so a fresh checkout has its `node_modules` and the pre-flight
  actually runs — the harness never needs (and never gets) install permission; (2) the `Check harness
  result` guard now **classifies** denials — a blocked file edit, a `git`/`gh` push·PR, or a
  `dangerouslyDisableSandbox` escape still fails the job, but ad-hoc **read-only** shell
  (`grep|sed|sort`, `find`, `for`-loops) is downgraded to a warning, so a legitimately-behaving run
  is no longer reddened just for exploring; (3) a repo whose own skills call a project CLI directly
  extends the allowlist through `hygiene.claudeArgs`/`labelHook.claudeArgs` (this repo adds
  `Bash(node installer/cli.mjs:*)`). **Re-render to pick it up** — `project.installCmd` is a new
  *optional* key (default `npm install`), so this is additive with no migration; a repo that never
  installed either syrup hook is unaffected. (#82)

### Added
- **CI observability for the dispatched harness — surface output + fail on denials** (#73,
  `github-workflow`). Both harness-dispatching workflows (`waffle-hygiene.yml`,
  `waffle-label-hook.yml`) gain, per dispatch job: an `id: harness` on the dispatch step; an
  `actions/upload-artifact` step (SHA-pinned `# v4.6.2`, `if: always()`, 7-day retention) that
  preserves the execution log — previously written to `$RUNNER_TEMP/claude-execution-output.json`
  and then discarded — as the `claude-execution-log*` artifact; and a `Check harness result` guard
  (`if: always()`) that parses the log **as data via `jq`** (never eval'd) and `exit 1`s when the
  final result message carries any denials (read as `permission_denials_count`, falling back to the
  raw `permission_denials` array length). The hygiene job additionally emits a `::warning::` when its
  run reports neither a PR URL nor an explicit `no drift`/`skipped` (the hygiene skill's Report
  contract) — a conservative heuristic over free-form text, so it warns rather than fails; a missing
  or unparsable log warns without crash-looping. The surfacing choice (execution-log artifact over
  `show_full_output: true`) and the debug flow are documented in the bundle setup notes for both
  hooks. Grounded in `anthropics/claude-code-action` v1.0.162: the `execution_file` output, the
  `show_full_output` input's secret-exposure warning, and the log's raw-message-array shape. (#73)

### Fixed
- **`waffle-hygiene.yml` denied every write, so the daily hook was a paid no-op** (#71,
  `github-workflow`). The template rendered `claude_args: "{{hygiene.claudeArgs}}"` and the
  config default is `""`, leaving the headless harness with no allowlist — which in CI
  auto-denies all gated tool calls (the first scheduled run logged 28 permission denials and
  produced nothing while still exiting "success"). `claude_args` is now a `>-` block scalar
  carrying a baked default
  `--allowedTools 'Edit,Write,Bash(git:*),Bash(gh pr:*),Bash(<pre-flight>:*)'` with
  `{{hygiene.claudeArgs}}` folded onto the end (the Claude CLI unions repeated `--allowedTools`,
  so consumer extras extend the default rather than replace it). The pre-flight patterns render
  from `project.lintCmd` / `project.typecheckCmd` / `project.testCmd` / `project.buildCmd` — the
  same keys the `git-workflow` pre-flight executes — so the allowlist tracks whatever the project
  configured. The `hygiene.claudeArgs` description and the hygiene setup note now document the
  default allowlist and how to extend it. The identical latent bug in `waffle-label-hook.yml` is
  tracked separately in #72. (#71)
- **`waffle-label-hook.yml` denied every write in both jobs, so each dispatch was a paid no-op**
  (#72, `github-workflow`). The template rendered `claude_args: "{{labelHook.claudeArgs}}"` in the
  `enrich` and `implement` jobs and the config default is `""`, leaving the headless harness with
  no allowlist — which in CI auto-denies all gated tool calls (the sibling hygiene run logged 28
  permission denials and produced nothing). Both jobs now render `claude_args` as a `>-` block
  scalar carrying a per-job baked default `--allowedTools`, with `{{labelHook.claudeArgs}}` folded
  onto the end (the Claude CLI unions repeated `--allowedTools`, so consumer extras extend the
  default rather than replace it). The two jobs get distinct defaults matched to their least
  privilege: `enrich` (holds `issues: write`) gets the narrow read-mostly set
  `Bash(gh issue:*),Bash(gh api:*)` — no `Edit`/`Write`, no git; `implement` mirrors the hygiene
  chain plus `Bash(gh issue:*)` for the PR-link comment, its pre-flight patterns rendering from
  `project.lintCmd` / `project.typecheckCmd` / `project.testCmd` / `project.buildCmd` — the same
  keys the `git-workflow` pre-flight executes. The `labelHook.claudeArgs` description and the
  label-hook setup note now document the per-job defaults and how to extend them. Live hook
  verification (labeling a test issue) is deferred to a follow-up, per the issue. (#72)
- **The guarded `waffle-hygiene` live run was denied 16 setup/read calls and reddened** (#82,
  `github-workflow`). Run 28681795718 proved the #73 guard's red path — but the run legitimately
  needed three command classes the #71/#72 allowlist did not cover: a dependency bootstrap
  (`npm install`, tried three ways), direct toolkit-CLI calls (`node installer/cli.mjs
  validate`/`doctor --allow-missing`), and generic read-only shell (`grep|sed|sort`, `find`,
  `for`-loops over `bundles/`); the guard then failed the job on all 16 (3 of them
  `dangerouslyDisableSandbox` retries). Resolved per class:
  (a) **bootstrap OUTSIDE the harness** — a new `Install project dependencies` step runs
  `project.installCmd` (default `npm install`; override for a non-npm toolchain, or `true` to skip)
  after checkout and before the dispatch, in the hygiene job and the label-hook `implement` job (the
  read-only `enrich` job needs no deps); the install stays a plain workflow step so the harness
  allowlist grows no install/network permission, and the pre-flight (`npm test` / `npm run validate`)
  finally has a populated `node_modules` to run against.
  (b) **toolkit-CLI** via the documented consumer-extras hook — this repo sets
  `hygiene.claudeArgs: --allowedTools 'Bash(node installer/cli.mjs:*)'`, unioned onto the baked
  default (the direct CLI calls come from this repo's own `docs.auditChecklist` / `audit` / `delegate`
  config, so the fix is repo-side, not a template default every consumer inherits).
  (c) **read-only shell vs. guard nuance** — the `Check harness result` guard no longer fails on every
  denial; it classifies each (still jq-only, read strictly as data, no eval, `EXECUTION_FILE` via
  env) and fails ONLY on delivery denials (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or a `git`/`gh`
  and other mutating/exfil command matched at a command boundary) and sandbox escapes
  (`dangerouslyDisableSandbox` — *never* downgraded), while WARNING on read-only exploration that
  never blocked delivery. A denied call never ran, so the downgrade changes only the red-vs-yellow
  signal, not what the harness could execute — the allowlist stays the real control. Adds an optional
  `project.installCmd` config key (injection-guarded pattern: no `${{ }}`, no newline); updates both
  workflow templates and the hygiene + label-hook setup notes; installer tests cover the install
  step's presence (hygiene + implement) and absence (enrich), the key's override and hostile-value
  rejection, and EXECUTE the rendered guard scripts against the real 16-denial shape (3 sandbox → red),
  read-only-only (→ warn, green), a blocked Edit/git push (→ red), and a clean run (→ green). Live
  re-verification (guard green, a hygiene PR lands) is deferred to after merge and a credit top-up,
  per the issue. (#82)

## [0.9.0] - 2026-07-03

### Consumer impact
- **Additive, opt-in — a new scheduled repo-hygiene workflow (`github-workflow`).** A new
  syrup item `.github/workflows/waffle-hygiene.yml` (+ a `hygiene` skill) runs the `docs`
  skill on a daily cron and opens an auto-merge PR with the result. Like the label hook it is
  **opt-in** — enabling the bundle does NOT render it; install it explicitly
  (`wafflestack install files/.github/workflows/waffle-hygiene.yml`). New optional config keys
  `hygiene.cron` (default `0 13 * * *` UTC ≈ 5am Pacific) and `hygiene.claudeArgs` are both
  defaulted, so an existing render is unaffected until you adopt the workflow. **A scheduled
  trigger spends Anthropic API money daily** — read the bundle setup note (API key secret,
  committed render, "Allow auto-merge", and a PAT/App token in `WAFFLE_HYGIENE_TOKEN` so
  auto-merge can actually fire) before pouring it. No migration required. (#46)
- **New, additive — a `github-project-board` skill can provision and standardize your
  Projects v2 board.** No migration: `render`/`upgrade` picks up the new skill (the
  `github-workflow` bundle gains it, and the orchestration `project-manager` agent is granted
  it), and existing config/extensions are untouched. Until now every board-touching skill only
  *consumed* a board and degraded with a warning when none existed; this skill is the create
  side — run `/github-project-board` (or let the project-manager use it) to create a board to
  the canonical Kanban spec, or reconcile a partial one up to it. It **asks before it creates
  or mutates** and never runs inline during delegation/issue creation, so enabling the bundle
  changes no existing behavior. Board mutations need the `project` token scope
  (`gh auth refresh -s project`). (#54)
- **New bundle, fully additive — no migration.** The `harness-architect` bundle ships a
  single domain agent for designing and building agent harnesses. Enable it by adding
  `harness-architect` under `bundles:` (or `wafflestack install agents/harness-architect`);
  its one config key `project.longName` is optional (defaults to a generic phrase), so no
  new required config. Existing installs are unaffected until they opt in. (#60)
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
- **Additive — release automation in `github-workflow`.** New `release` skill and a
  `waffle-release-hook.yml` workflow, plus config keys `labelHook.releaseLabel` (default
  `waffle:release`), `release.tagFormat` (default `v{version}`), and `release.versionFiles`
  (default empty). All optional with back-compatible defaults, and the workflow is **syrup**
  (opt-in) — so an existing repo sees only a plain content re-render and nothing new arms until
  you install the hook and create the label. To adopt: `wafflestack install
  files/.github/workflows/waffle-release-hook.yml`, `gh label create "waffle:release"`, and
  confirm Actions may write `contents`. Point `release.versionFiles` at your own version files.
  (#39)
- **Additive — a new `/standup` skill renders for repos with the `orchestration` bundle.**
  `render`/`upgrade` picks up `.claude/skills/standup/` (and the `.agents/` mirror) on the next
  run; no new config keys and no migration. Invoke `/standup` for a one-look, per-agent status
  pulse of the codebase. (#56)

### Added
- **Scheduled repo-hygiene workflow — `waffle-hygiene.yml` + a `hygiene` skill** (#46): the
  `github-workflow` bundle gains a daily (cron + `workflow_dispatch`) CI workflow that
  dispatches the Claude Code action to work a **hygiene task list** — first entry runs the
  `docs` skill, then lands the result as a PR per the `git-workflow` skill with
  `gh pr merge --auto --squash`. Reuses the label hook's SHA-pinned dispatch and injection-safe
  config-render hardening: `hygiene.cron` is validated against a cron allowlist (blocks quotes/
  `${{`/newlines and rejects empty — fail-closed loud), and `hygiene.claudeArgs` mirrors
  `labelHook.claudeArgs`. It is **syrup** (its job holds `contents`/`pull-requests` write and it
  bills daily) — wired to its skill via a `files/`-keyed `requires:` edge, the skill to
  `git-workflow`. Auto-merge needs a required check to wait on, but PRs opened with the default
  `GITHUB_TOKEN` do not trigger the repo's own CI — so the workflow reads an optional
  `WAFFLE_HYGIENE_TOKEN` (PAT/App token) secret and falls back to `GITHUB_TOKEN`; the token +
  repo-settings recipe (incl. `allow_auto_merge`) is documented in the bundle `setup:` block
  alongside the daily-cost warning. (#46)
- **`github-project-board` skill** (github-workflow bundle, #54): the toolkit's first
  *create-side* board skill. Encodes the standard board spec — **Status** (Backlog / Todo /
  In Progress / In Review / Done), **Priority** (Critical / High / Medium / Low), **Size**
  (S / M / L), and **Start** / **Target** date fields, with Table / Kanban / Roadmap views —
  and a GraphQL mutation catalog to realize it: `createProjectV2` + `linkProjectV2ToRepository`
  for the no-board path, `createProjectV2Field` for missing fields/options, and
  `updateProjectV2Field` for reconciling an existing single-select (documented as a full
  replace, with the option-ID/assignment-loss and built-in-Status caveats called out). Honest
  about API limits: Projects v2 **views are not creatable via the public API**, so it offers
  `copyProjectV2` from a template board (clones fields *and* views) or prints guided manual
  view steps; board discovery matches `project.name` case-insensitively (normalized, exact).
  Wired like the delegate→github-project-management pattern: listed in the github-workflow
  bundle `skills:`, granted in the `project-manager` agent frontmatter, and pulled into a
  standalone `install skills/delegate` via a new orchestration `requires:` edge. The
  github-workflow `setup:` note and the `delegate` / `issue` "no board" warnings now point at
  it. (#54)
- **`harness-architect` bundle — an expert in building agent harnesses** (#60): a single
  domain agent (`bundles/harness-architect/`) versed in agent/skill/tool decomposition,
  subagent teams and orchestration, hooks, MCP servers, slash-command ergonomics, and
  multi-harness portability (Claude Code / Codex / cross-tool `.agents`). Registered in
  `toolkit.yaml`; one optional config key (`project.longName`). WaffleStack dogfoods it via a
  project extension (`.waffle/extensions/agents/harness-architect.md`, appended at render by
  `render.mjs`'s extension markers) that grounds the agent in the stack's own paradigms — the
  `AGENTS.md` module/pipeline registry, the `schema/FORMAT.md` authoring contract, the
  governing `DECISIONS.md` ADRs (one-canonical-source, the frozen-image render contract,
  lenient agent→skill vs. strict `requires:` deps), and the `validate` / `test` / `render` +
  `doctor` gates. This split dogfoods the extension mechanism: the generalized agent ships to
  any consumer, while this repo's install carries the deep wafflestack knowledge. (#60)
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
- **Automated releases: `release` skill + tag-on-merge hook** (#39, `github-workflow` bundle).
  The `release` skill (user- and agent-invocable) does the bump-PR half: pick the semver level
  from changes since the last tag (or take an explicit version), `npm version
  --no-git-tag-version`, sync the files in `release.versionFiles`, stamp `CHANGELOG.md`
  (`[Unreleased]` → `[X.Y.Z]`), re-render if generated output tracks the version, run the
  pre-flight, open a `chore/bump-X.Y.Z` PR carrying the consumer-impact notes, and apply the
  release label. It never pushes the tag. The new syrup `waffle-release-hook.yml` does that:
  when a PR carrying `labelHook.releaseLabel` is **merged**, a deterministic `contents: write`
  job (NO Claude dispatch, NO API spend) pushes a lightweight tag from `release.tagFormat` on
  the merge commit, reading the version from the merged `package.json` and refusing any
  non-semver value. Config keys `labelHook.releaseLabel`, `release.tagFormat`, and
  `release.versionFiles` are added with injection-safe patterns on the first two (fail-closed
  empty label; `{version}`-token tag format). The release-flow spec is documented in the
  `git-workflow` skill, and the `label-hook` skill's guardrails now forbid an implement run
  from applying the release label. Dogfooded here: this repo installs the hook, commits the
  rendered workflow (a `.gitignore` carve-out), and creates the `waffle:release` label. (#39)
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
