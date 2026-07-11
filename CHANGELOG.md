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
- **minor** (`0.5.0 → 0.6.0`) — new stacks/items or additive config. `render` picks them
  up; existing config and extensions are untouched.
- **major / breaking** — a renamed or removed stack/item, a new *required* config key, or
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

### Added
- **Dedicated writing-craft skills for the two docs agents (#224).** The docs agents' writing
  standards previously lived entirely in the injected `docs.humanDocSpec` / `docs.machineDocSpec`
  config blobs, which say *which files* to write and how to structure them — but nothing about **how
  to write them**. Three new `docs-system` skills carry that craft as named, reusable standards:
  **`prose`** (plain language, one idea per sentence, conclusion first, headings + bold leads alone
  must carry the story), **`md-maximalist`** (markdown's full range — tables, callouts, task lists,
  collapsibles, fenced blocks — with form chosen from the content's shape and every choice held to
  one test: does it speed up a scanning reader; richness in service of scanning, never decoration),
  and **`accurate`** (docs as code — every claim traceable to a file actually read, omission over
  invention, no hedging as cover, a wrong doc is a bug). Each is granted to its agent in **both** the
  frontmatter `skills:` list and the agent's **body prose** — the latter is load-bearing because the
  codex target drops frontmatter grants — and all three are `user-invocable: true`, so `/prose`,
  `/md-maximalist`, and `/accurate` also work as ad-hoc slash commands on any file.
  **Consumer impact:** additive/minor. Pure stack authoring — no installer, schema, or config change,
  and no new config keys. A `render` picks up the three new skills and the two reworded agent bodies;
  nothing existing is renamed or removed and no migration is required.
- **Default co-author trailer credits the consuming repo's owner (#284).** Two new lockstep config
  keys — **`git.ownerName`** / **`git.ownerEmail`** — are declared in both the `github-workflow` and
  `orchestration` stacks (byte-identical guard patterns and defaults, pinned by a deep-equal lockstep
  test), and the **`git.coAuthorTrailer` default flips** from
  `Co-Authored-By: {{harness.assistantName}} <noreply@anthropic.com>` (an email mapped to no GitHub
  account) to `Co-authored-by: {{git.ownerName}} <{{git.ownerEmail}}>` (nested substitution). GitHub
  grants contribution-graph credit to a verified co-author email on default-branch commits, so
  agent-authored commits the owner initiates and merges now count toward **the owner's** heatmap while
  the agent keeps its displayed author identity. The setup note documents the mechanics: the owner
  email must be **verified on the owner's GitHub account** (the `ID+user@users.noreply.github.com`
  form earns credit while staying private), credit accrues only on **default-branch** commits, and —
  like `git.botEmail` — repos rendering in CI/worktrees should commit the values in
  `.waffle/waffle.yaml`, not the gitignored overlay.
  **Consumer impact:** additive/minor. Unset owner keys fall back to declared placeholder defaults
  (`Repository Owner <owner@users.noreply.github.com>` — passes the guards but credits nobody, so set
  the real values), and an explicit `git.coAuthorTrailer` override is honored unchanged. A repo that
  commits its render will see a re-render diff where the trailer text changed. No migration required —
  the default resolves at render; no consumer file is mutated.
- **Programmatic Gravatar pipeline for per-agent avatars (#285, builds on #157/#156).** The manual
  Gravatar registration `.waffle/AVATARS.md` used to document is now a mostly-automated owner-side
  command. New **`wafflestack avatars sync`** enumerates the installed agent roster with its derived
  commit emails (the *same* derivation the manifest prints, via a new shared
  `waffledocs.mjs#collectAgentAvatars`), rasterizes each deterministic avatar SVG→512px **G-rated**
  PNG, and for every email **already verified** on the Gravatar account uploads and assigns it over
  the Gravatar v3 REST API. **`wafflestack avatars status`** probes without writing and reports
  **roster drift** (an installed agent whose address is unregistered), exiting non-zero so CI can
  gate. Gravatar exposes **no API to add or verify a new email**, so an unverified address is
  reported as a manual "verify at gravatar.com, then re-run" remainder — the one tolerated manual
  step. The owner-only OAuth2 token is read from `WAFFLE_GRAVATAR_TOKEN` at runtime (never a flag,
  never rendered into a committed file); the HTTP client and SVG→PNG rasterizer are **injected**, so
  the unit suite mocks both and `npm test` makes no network or native calls. `.waffle/AVATARS.md`
  regenerates to describe the pipeline (owner runs sync; consumers on defaults inherit; overriders
  re-run against their own domain) instead of the manual procedure, keeping the smoke test and every
  subaddressability/override caveat branch.
  **Consumer impact:** the **default `git.botEmail` flips** from the `wafflebot@users.noreply.github.com`
  placeholder to the toolkit-owned, subaddressable **`bot@wafflenet.io`** — a project **on defaults**
  now gets distinct per-agent `bot+<slug>@…` author emails (and, once the toolkit owner runs
  `avatars sync`, per-agent avatars on GitHub) with zero setup. The trade-off: default commits carry
  a toolkit-domain author email unless overridden, and the old noreply default's "Verified badge for
  free" property is forfeited on defaults (avatars XOR a verified sub-agent). A repo that sets its own
  `git.botEmail` is unaffected; a repo that commits its render will see a re-render diff where it
  leaned on the old default. No migration required — `render` picks it up.
- **Per-PR token accounting + a global counter badge (#227).** The four Claude-dispatching
  workflows (label-hook enrich/implement, hygiene, pr-green, pr-response) each gain a final
  **`Record token spend`** step: it jq-extracts `usage`/`total_cost_usd` from the existing
  execution log and folds it into ONE marker-keyed comment (`<!-- waffle-token-count -->`) on
  the run's PR (implement/hygiene resolve it from the result's PR URL; enrich posts on the
  issue) — one row per `run_id.run_attempt`, totals always recomputed from the full run map,
  and the step can never red a run (`always()` + `continue-on-error` + an exit-0-only script
  that skips missing/malformed/zero-usage logs, the invalid-API-key shape included). On merge,
  `waffle-post-merge-hook` (new step, plus `pull-requests: read`) sums the comment's
  machine-readable data line into `.waffle/telemetry/tokens.json` on the orphan
  **`waffle-telemetry`** branch — the file doubles as a shields.io endpoint-badge JSON — via
  pure `gh api` (orphan bootstrap through the Git Data API, sha-conditional PUT with bounded
  retry, per-PR dedup map; no checkout, no local git, so the #160 identity-neutrality holds by
  construction). Setup notes document the counter, the consumer badge line, and per-hook
  token-spend subsections; the jq prerequisite now also lists the pr-response/post-merge
  workflows (drive-by fix); this repo's README gains the badge. Content tests pin the step's
  presence/harmlessness, the sibling-marker collision guard (a token comment must never
  contain another hook's marker substring), and the post-merge counter invariants. Local
  interactive-session spend is a documented v1 gap tracked as a follow-up spike issue.
- **Per-agent avatars on GitHub commit views (#157, builds on #156).** Each agent now has a distinct
  avatar wherever its identity shows up — including GitHub. `render` emits one **static**,
  deterministic waffle SVG per installed agent to `.waffle/avatars/<agent>.svg` (the same name-seeded
  character `team.html` already draws, minus the SMIL animation, sized 512px for upload), plus a
  generated `.waffle/AVATARS.md` manifest pairing every agent with **the exact commit email it
  authors under** — derived by new `waffledocs.mjs` helpers `extractBaseEmail`/`deriveAgentEmail`,
  kept in lockstep with the delegate skill's prose rules and pinned by tests to the documented
  examples. Both flow through `emit()`, so they are lock-tracked, doctor-drift-checked, and pruned
  when a selection drops every agent. The `identity:` block gains an optional **`avatar`** key (a
  repo-relative path or `https://` URL — the allowlist admits those two shapes and nothing else: no
  other scheme, no leading `/`, no `//` authority, no percent-encoding, no `..`; absent means the
  generated default), which renders through to `.claude/agents/*.md`
  and `.agents/agents/*.md`. **The mechanism, stated honestly:** GitHub picks a commit avatar from the
  author email — an account's avatar if the email is registered there, otherwise that email's
  **Gravatar**, otherwise the gray Octocat. Because the derived `bot+<agent>@…` aliases belong to no
  GitHub account, they land on the Gravatar path. **Registering one Gravatar per agent email is a
  manual, one-time step this toolkit does not and cannot perform**, so the manifest ships the exact
  addresses, one-line SVG→PNG conversion commands (no raster dependency is added to the installer),
  the registration procedure, and a smoke test — plus the caveat that GitHub caches the email→avatar
  association. It also states the anti-recommendation: never add these aliases as secondary emails on
  the bot's GitHub account, which would relink every agent to one profile and one avatar. A project
  with no bot identity (bare `git.cmd`), or one whose base email cannot subaddress, gets a manifest
  that says exactly that instead of inventing an address.
  **Consumer note:** the new avatar files and manifest appear on the next `render`; a repo that
  commits its render will see new lock entries. The manifest's contents depend on `git.cmd` /
  `git.agentIdentities`, so changing those (correctly) drifts the lock.
- **Per-agent virtualized git identities (#156, `orchestration` + `github-workflow`).** Every agent
  spawned by the `delegate` skill used to commit under the same identity with a byte-identical
  `Co-Authored-By` trailer — two different agents produced indistinguishable attribution. Agents now
  carry an optional `identity: { displayName }` frontmatter block (documented in `schema/FORMAT.md`,
  declared on all 14 shipped agents), and the delegate skill derives each spawned agent's git author
  at spawn time: the display name, plus the bot email **plus-addressed** with the agent's own slug
  (`bot@x.com` → `bot+lead-engineer@x.com`). `git.agentIdentities` overrides that derived default
  per field. **The opt-in is unchanged and singular:** a bare `git.cmd` means no bot identity is
  configured, so nothing is virtualized and the map is inert — the toolkit still never clobbers a
  human's git config. Two honest caveats, stated in the skill: attribution is per agent *type*, not
  per spawn (two parallel `lead-engineer`s share an author); a plus-addressed alias is a distinct
  email to GitHub, so such commits do not link to the bot account unless the alias is registered
  there; and a base email that **cannot** subaddress — a `*.noreply.github.com` domain, or a local
  part that already carries a `+` (GitHub's canonical `<id>+<user>@users.noreply.github.com`) — is
  used **verbatim** rather than mangled into an address that routes nowhere, so those agents differ
  by display name only. The `claude:` frontmatter passthrough may not shadow a reserved key
  (`name`/`description`/`skills`/`identity`); `validate` and the external-stack gate reject it, so
  an unvalidated `identity` cannot be hoisted over the validated one. Also new: `harness.agentsDir`
  (the Markdown agent-definitions path per target, sibling of `harness.skillsDir`), so the derivation
  rule reads agent frontmatter without hardcoding `.claude/`. Both path built-ins are now
  injection-guarded, and codex points at `.agents/agents` (its own render is TOML, which carries no
  `identity`) so codex and agents-dir keep the identical `harness.*` values that `renderSkill`'s
  shared-output dedupe relies on.
  **Consumer note:** a repo that commits its render must re-render to pick up the new agent
  frontmatter and the rewritten delegate skill.
- **`entryPatterns:` — render-time shape validation for map-valued config keys (#156).** The
  map-valued sibling of `pattern:`. A key declares the leaf shape of one entry
  (`botName`/`botEmail`/`signingKey` for `git.agentIdentities`) and every entry in the resolved value
  must satisfy it: each entry a map, each leaf key declared (an **unknown leaf fails the render**, so
  a typoed `botEmial:` cannot ride along unguarded), each leaf value a string fully matching its
  regex. An explicit `signingKey: ""` fails the render — the leaf is optional, so empty carries no
  information and would only render a `-c user.signingkey=` that git rejects only when the command
  signs (a non-signing recipe carries the empty flag silently).
  Enforced at both the top-level and nested substitution paths, and compiled **toolkit-wide**
  like `pattern:`, so the guard travels with the key rather than with whichever stack happens to be
  installed. This closes the hole #154 documented: `git.agentIdentities` leaves now land in an
  agent-executed shell command, and a value like `botEmail: "$(id)@x.com"` — which rendered cleanly
  before — now fails the render loudly. An agent's `identity.displayName` is guarded at the same
  trust boundary (`validate`, and `validateExternalStacks` at render for third-party stacks) against
  the same allowlist as `git.botName`, since it lands inside the quotes of `-c user.name="…"`.
- **The main bot identity is now wired through `git.cmd` (#155, `github-workflow`).** #154 declared
  the identity keys; nothing consumed them. A project now opts into a managed bot identity with one
  config line — `cmd: git -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}` — which
  injects the identity via `-c` flags into the rendered examples that actually record a committer
  (`commit`), leaving the machine's ambient `user.name` / `user.email` untouched. Identity-free
  commands (`push`, `checkout`, `diff`, `log`) stay a bare `git`: they write no committer, so the
  flags were noise. `{{git.cmd}}` now also threads through the `release`
  skill's commit and the `delegate` skill's spawned-agent commit instruction, and `git-workflow` renders
  the resolved `git.cmd` so an agent can see whether an identity is in effect. `git.coAuthorTrailer`
  is unchanged by design: with a bot identity the commit *author* is the bot, while the trailer
  credits the AI harness.
  **Deliberately not an engine conditional.** `git.cmd` keeps its bare `git` default and there is no
  "if a bot identity is configured" branch in the renderer. A conditional keyed on merged config
  would make renders irreproducible — the trigger input would include the gitignored
  `.waffle/waffle.local.yaml`, which is absent in CI and in fresh `git worktree` checkouts, so a
  rendered `git.cmd` would differ per machine and trip the doctor drift gate. The config recipe *is*
  the conditional.
  **Two rules the docs now state.** (1) Quote `user.name`: `git.botName` admits single interior
  spaces and `git.cmd` splices it into an unquoted shell word. (2) Set **both** `git.botName` and
  `git.botEmail` as real project-config values rather than leaning on their stack defaults — stacks
  that declare `git.cmd` but not the identity keys (e.g. `orchestration`) resolve nested keys from
  project *values* only, so a defaults-only recipe renders a literal `{{git.botEmail}}` into their
  skills, silently. Also new: a repo that commits its render and re-renders in CI should commit
  `git.botEmail` too (use a noreply-style address) rather than hiding it in the local overlay — the
  overlay split assumes local-only rendering. `git.signingKey` stays out of the recipe (#158).
  **Signing is not covered by `git.cmd`.** It overrides the identity and nothing else, so an ambient
  `commit.gpgsign = true` still signs a bot-authored commit with the developer's key (GitHub then
  attributes the vouching to the human), and a prompting signer blocks the non-interactive commit.
  Setup-note rule (4) now says so and gives the remedy — `-c commit.gpgsign=false` when the bot holds
  no `signingKey`, which this repo's own `git.cmd` now uses. A real signing model is #158.
  **Consumer impact: no default changed, but the `git.cmd` accepted-value contract narrowed**
  (claim corrected by #244 — this passage originally said "no behavior change"). No command default
  changed and no key became required; a *default* consumer re-renders byte-identically
  (`release/SKILL.md` is unchanged), except that `git-workflow/SKILL.md` gains the opt-in prose and
  a resolved-`git.cmd` block, so `render` rewrites that one file. A consumer who had **already set
  `git.cmd`**, however, now has the identity values composed into it validated against their
  declaring stack's `pattern:` guards, unioned toolkit-wide — so a pre-existing recipe whose
  `git.botName` / `git.botEmail` / `git.signingKey` values carry `${{ … }}`, quotes, or shell
  metacharacters newly **fails `render`** where it previously rendered silently. **Migration:**
  bring the value into the allowlisted shape the error names (it cites the failing pattern and its
  declaring stack), or stop composing that key into `git.cmd` — the failure is the guard working,
  not a regression. Adopting the bot identity is an explicit opt-in; the `wafflestack init`
  scaffold and `schema/SETUP.md` now show the recipe. Enforcement is prompt-level (agents follow
  the rendered examples) — #159/#160 harden it. This toolkit repo dogfoods the opt-in and now
  commits agent work as `Wafflebot <bot@wafflenet.io>`.
- **First-class GitHub identity config keys (#154, `github-workflow`).** `git.botName`,
  `git.botEmail`, `git.signingKey`, and `git.agentIdentities` are now declared in the stack's
  `config:` schema with placeholder defaults, and a rendered "Bot identity (config)" reference
  block in the `git-workflow` skill. This is the foundation the rest of the identity model (#153)
  builds on. Layering is unchanged: put the shared `git.botName` in the committed
  `.waffle/waffle.yaml` and the account-specific `git.botEmail` / `git.signingKey` in the
  gitignored `.waffle/waffle.local.yaml`; `git.agentIdentities` entries may straddle both (they
  deep-merge, local winning per key). `git.signingKey` takes a GPG key ID or SSH public-key path —
  never private key material, since config values render into committed files.
  **What the `pattern:`s guarantee.** `git.botName` / `git.botEmail` / `git.signingKey` are guarded
  by **allowlist** patterns: each value must be drawn from an explicit safe character set (letters,
  digits and a short punctuation set; `botEmail` additionally requires a TLD), and each carries the
  `^(?!.*\$\{\{)` guard the stack's other patterns use, so a `${{ … }}` cannot ride through the
  renderer verbatim. Shell metacharacters (`` ` ``, `$`, `;`, `|`, `&`, `\`), quotes, newlines and
  leading/trailing whitespace are all rejected — a violating value fails the render loudly rather
  than corrupting the shell word `git.cmd` splices it into. `git.agentIdentities` is a map, so a
  `pattern:` (string scalars only) could not guard it — #156 closes that with `entryPatterns:`.
  **Consumer note:** all four keys were previously *undeclared* dotted paths that only resolved
  through nested substitution. Now that they are declared, a value like
  `git.cmd: git -c user.email={{git.botEmail}}` that references them *without* defining them
  resolves to the placeholder default (`wafflebot@users.noreply.github.com`) instead of passing the
  `{{git.botEmail}}` text through verbatim. Watch `git.signingKey` in particular: its default is the
  **empty string**, so an undefined-but-referenced `{{git.signingKey}}` now renders
  `git -c user.signingkey= …` — a silent, run-time-only failure, where before it left the obviously
  broken literal `{{git.signingKey}}` in the output. Define them if you reference them.
- **`todo-column` board scope for `delegate.defaultScope` (#206, `orchestration`).** A third
  default-scope value alongside `current-milestone` and `all-open`: delegate **exactly the open
  issues in the project board's Status = "Todo" column**, resolved via the
  `github-project-management` GraphQL catalog (board by title — with the `organization(login:)`
  variant for org-owned repos → Status field's "Todo" option → items filtered client-side to this
  repo's open Todo issues, with `pageInfo` detection of the `items(first: 100)` bound: paginate or
  stop, never trust a truncated set; the intersection carries a raised `--limit 500` bound plus a
  count invariant). A missing board or missing Todo option falls back to `all-open` — the
  documented contract of choosing the value, but **explicit, never silent**: the Phase 3 plan
  leads with the fallback line, interactive runs still gate the widened set, batch runs log it,
  and the checkpoint records what actually ran (`mode: "all-open"` with the fallback provenance in
  `description`). A **failed** board lookup (API error, missing Projects v2 token scope) is not a
  missing board — it stops the run rather than falling back, so a transient error never widens an
  unattended batch run. An empty-but-present Todo column is **not** a fallback — it stops the run
  as "nothing to delegate". Batch mode counts the `todo-column` default as an explicit-scope
  signal, same as `all-open`. Phase 1 also captures the In Progress / In Review option IDs so
  Board Setup's reuse of the Phase 1 lookups keeps kanban sync intact. The checkpoint schema's
  `scope.mode` enum gains `todo-column` (additive — old checkpoints stay valid, no version bump).
  - **Consumer impact:** additive, prompt-only. **No new config keys** — the existing
    `delegate.defaultScope` key accepts the new value; its default stays `current-milestone`. A
    plain re-render picks it up; behavior is unchanged unless a repo sets
    `delegate.defaultScope: todo-column`.
- **Per-run round caps for autopilot's gate loops — `+qa:N` / `+review:N` (#230,
  `orchestration`).** The QA-gate and review-loop consent flags may now carry an optional round
  count using the same colon syntax as `milestone:<name>`: `+review:3` consents to the review
  loop AND caps it at 3 rounds for this run; `+qa:1` does the same for the QA gate. Bare `+qa` /
  `+review` keep the rendered defaults (`autopilot.maxQaRounds` / `autopilot.maxReviewRounds`,
  both default 2), and when consent is captured interactively via `AskUserQuestion` the round
  count is captured in the same exchange. The effective caps follow the same per-run,
  never-sticky rule as the consents (this invocation only — the rendered defaults govern every
  future run), are restated in the recorded mandate and the end-of-run report, and bound the
  loops everywhere the rendered caps applied before (loop bound, cap-reached handling, guardrails,
  failure handling); cap-reached behavior is unchanged (proceed + `autopilot.holdLabel`
  follow-up). The audit gate's error-retry bound stays hardcoded ("retry once") — it is failure
  handling, not a quality loop, so there is no `+audit:N`.
  - **Consumer impact:** additive, prompt-only. **No new config keys** — the existing
    `autopilot.maxQaRounds` / `autopilot.maxReviewRounds` keys are reframed as render-time
    defaults, overridable per run. A plain re-render picks it up; behavior is unchanged unless an
    invocation passes `+qa:N` / `+review:N`.
- **`/qa` skill + opt-in autopilot QA gate (#228, `code-quality` + `orchestration`).** The
  functional sibling of `adversarial-review`: `/qa <PR#>` checks a **green PR against its linked
  issue's intent** — it reads the diff plus the issue's acceptance criteria, best-effort runs
  `project.testCmd` and exercises the changed behavior, assesses whether the diff carries real
  test coverage, and posts **one** PR review (inline comments + summary verdict) under its own
  dedup marker `<!-- waffle-qa -->` — deliberately distinct from adversarial-review's, so the
  pr-green dedup guard and the pr-response hook never mistake one gate's post for the other's.
  "No QA concerns" is a valid outcome; the skill reports only (`pr-response` is the applying
  half). Autopilot composes it as a **fifth instantiation-contract entry (fourth consent)** (`+qa` /
  `autopilot.qaLoop`, per-run, never sticky, default OFF): a new Step 5 between PR verification
  and the review loop that loops `qa <pr>` → `pr-response <pr> --yes` up to
  `autopilot.maxQaRounds` rounds (0 findings implemented = converged; cap reached = safety cap,
  not a merge blocker — file an `autopilot.holdLabel` follow-up and proceed). Auto-merge arming
  defers to the **last enabled gate**: QA gate (Step 5) → review loop (Step 6) → audit gate
  (Step 7).
  - **Consumer impact:** additive. `code-quality` gains the `qa` skill (renders
    `.claude/skills/qa/SKILL.md`; reuses `project.testCmd`, **no new required keys**);
    `orchestration` gains two optional keys — `autopilot.qaLoop` (default `false`) and
    `autopilot.maxQaRounds` (default `2`) — and a `skills/autopilot → skills/qa` requires edge,
    so installing `skills/autopilot` by ref now pulls the qa skill into the render. A plain
    re-render picks everything up; behavior is unchanged unless a run opts in with `+qa`.
- **`/pr-response` skill — rubric-scored PR review triage (#194, `github-workflow`).** The consuming
  side of `adversarial-review`: resolve a PR, read every review + review comment, score each finding
  0–3 on four dimensions (Severity · Validity · Effort/Risk · Alignment), and record an
  **Implement (≥8) / Defer (4–7) / Decline (≤3)** verdict with its score and a one-line reason.
  Accepted fixes are applied per `git-workflow`; one reply carrying a `<!-- waffle-pr-response -->`
  dedup marker summarizes the verdict table and is updated in place on re-runs. Two rules override
  the arithmetic: a **confirmed blocker is always Implement**, a **false positive is always
  Decline**. Because the recorded scores are the calibration dataset, the skill documents *how to
  recalibrate* its own thresholds. Agent callers pass `--yes` to skip the confirmation gate (the
  `clean-up` convention).
  - **Consumer impact:** additive. Enabling `github-workflow` renders one new file,
    `.claude/skills/pr-response/SKILL.md`; `render` picks it up. **No new config keys.**
- **`waffle-pr-response-hook` workflow — auto-answer an adversarial review (#195,
  `github-workflow`, opt-in syrup).** On `pull_request_review: [submitted]`, gated to reviews
  carrying the `<!-- waffle-adversarial-review -->` marker, it dispatches the harness to run
  `/pr-response` against the PR: score the findings, apply the accepted fixes, push them to the PR
  branch, and post one marked reply. It closes the loop `waffle-pr-green-hook` opens. Unlike
  pr-green it **commits** — the job holds `contents: write` + `pull-requests: write` — so two guards
  carry the design:
  - **Fork-head guard.** `pull_request_review` runs in *base-repo* context (this repo's secrets, a
    write token) even for a fork's PR, so the job-level `if:` requires
    `github.event.pull_request.head.repo.full_name == github.repository`. Fork PRs get no automated
    response; answer them by running `/pr-response` locally.
  - **Loop bound, per PR — not per head SHA.** pr-green dedups per head commit, so it re-reviews
    every new SHA, and every fix this hook pushes mints one; a per-SHA bound here would cycle
    forever. The gate skips when **any** `<!-- waffle-pr-response -->` comment already exists on the
    PR, and is fail-closed (an unverifiable bound never authorizes a paid, committing run). One
    automated response per pull request, ever.

  Delivery is verified against the API (a marked reply on the PR), not guessed from the harness's
  free-form output; a sandbox-escape attempt is always red. The execution log uploads as
  `claude-execution-log-pr-response`.
  - **Consumer impact:** additive and inert by default — the workflow is **opt-in syrup**, so
    enabling `github-workflow` does not render it. Pour it with
    `wafflestack install files/.github/workflows/waffle-pr-response-hook.yml` (its `requires:` edge
    pulls the `pr-response` skill). **One new config key**, `prResponse.claudeArgs` (optional,
    defaults to `""`, same injection-guarded shape as `prGreen.claudeArgs`). Arming it needs the
    `ANTHROPIC_API_KEY` secret and a `contents` + `pull-requests` write token — prefer a PAT in
    `WAFFLE_HYGIENE_TOKEN` so the pushed fixes re-run the PR's required checks.

### Changed
- **`/issue` plans read-only first and confirms before it mutates (#288).** The skill used to write
  to GitHub immediately — `gh issue create` in create mode, an in-place title/body/label rewrite in
  enrich mode — before the user had seen a word of the drafted content, so a bad inference (wrong
  classification, off-base proposed solution, overwritten nuance) had to be repaired *after* it had
  already landed on the tracker. All three modes now run as **plan phase → confirmation gate → act
  phase**: context-gathering, classification, drafting, priority inference, and board placement all
  happen read-only, then the gate presents the proposed title, body, labels, and placement and waits
  for an explicit yes before the first mutation. **Declining leaves GitHub state untouched.** Batch
  mode drafts the *whole* `{{issue.inferenceLabel}}` queue before touching any of it and presents
  **one combined review** — approve the batch or a subset; unapproved issues keep their lifecycle
  label for a later pass. The gate covers **mutating, not reading**, so the plan phase is always safe
  to run. Two callers skip it: **`--yes`** (same convention as `pr-response` / `clean-up`) and any
  **agent or CI invocation** — for those, the agent invocation *is* the explicit signal that stands
  in for the confirmation, the same precedent as `delegate` batch mode's `confirmedVia:
  "batch-scope"`. That auto-skip is load-bearing, not a convenience: label-hook dispatches enrich
  mode from a headless Actions job that can never answer a prompt, so a model honoring the gate there
  would hang the run until it timed out (label-hook's own `enrich` section now says so too). Agent
  callers **log** the drafted plan before applying it, so an unattended run stays auditable after the
  fact instead of being unreviewable in the moment.
  *Consumer impact:* re-render. Interactive `/issue` now pauses where it previously acted — pass
  `--yes` for the old straight-through behavior. Agent, hook, and autopilot invocations are unchanged.
- **Autopilot's gate subloops reuse persistent named agents across rounds (#295).** Steps 5 (QA)
  and 6 (review) no longer re-invoke their gate skills fresh every round: round 1 spawns each half
  as a **named agent** (`qa-pr<N>` / `respond-qa-pr<N>`, `review-pr<N>` / `respond-rev-pr<N>`) and
  later rounds **resume the same agent** with `SendMessage` ("the PR head moved to `<sha>` — re-run
  your pass on the new diff"). The agent keeps the diff, the issue's acceptance criteria, and its
  own verdict history, so a later round neither re-derives the PR from scratch nor re-litigates a
  finding an earlier round already declined. The **structured return contract is unchanged** —
  per-severity counts from `qa`/`adversarial-review`, per-verdict + implemented counts from
  `pr-response` — so convergence (0 implemented), the caps, the review markers, and the posted-review
  format are all untouched. Three guardrails bound the optimization: a **vanished agent degrades to a
  fresh spawn** (correctness never depends on persistence), each cap hatch's **evidence pass is still
  spawned fresh** (an agent that lived through every fix round is the wrong context to certify the
  result — #234's clean-fresh-pass semantics), and **no gate agent outlives its loop** (teardown is
  unconditional, including the red-round and errored-round stop paths; an errored round retries on a
  fresh spawn rather than re-entering a wedged context). The `qa`, `adversarial-review`, and
  `pr-response` skills now document being resumed with a new PR head: re-read the diff fresh from the
  new head, keep the finding/verdict history, and — for `pr-response` — never flip a settled verdict
  without new evidence, keeping F-numbering stable across rounds.
  **Consumer impact:** prose-only change to four SKILL.md files; no config or schema change;
  consuming repos pick it up on re-render.
- **Autopilot codifies implement-ahead for an independent next issue (#277).** The per-issue
  loop's Step 3 now documents that when issue N+1 is independent of the in-flight one under
  delegate's parallelization rules, the orchestrator MAY start N+1's implementer (Steps 2–3)
  in its own delegate-provisioned worktree while PR N is still in its gate loops (Steps 5–7)
  or merge-wait (Step 8) — so N+1's PR is open the moment N merges. Gates stay serial: N+1's
  gate loops do not start until PR N reads `MERGED` and Step 9 housekeeping has run, and N+1's
  branch rebases onto the freshly merged main before its gates begin (the reconciliation point
  for the accepted, bounded pre-merge base staleness). Serial-dependent chains and the Step 8
  merge-wait are unchanged, and Failure handling now covers an implement-ahead branch
  invalidated by PR N's gate fixes (re-plan/re-implement counts as the one retry).
  **Consumer impact:** prose-only change to the autopilot SKILL.md; no config or schema change;
  consuming repos pick it up on re-render.
- **Autopilot codifies the plan-ahead overlap for the next issue's planning context (#276).**
  The per-issue loop's Step 1 now documents that while PR N is in its gate loops (Steps 5–7)
  or merge-wait (Step 8), the orchestrator MAY spawn issue N+1's Step 1 planning context
  early — the planner is read-only and writes only its own gitignored throwaway plan file
  under `autopilot.planDir`, so it is conflict-free by construction against the in-flight PR.
  Serial semantics are unchanged: N+1's plan is still handed to a fresh implementer only
  after Step 8 confirms `MERGED` for a dependent chain, and the plan stays a brief (Step 2's
  authority language already covers staleness). **Consumer impact:** prose-only change to the
  autopilot SKILL.md; no config or schema change; consuming repos pick it up on re-render.
- **The subloop cap escape hatch now briefs from a fresh post-cap review pass (#235).** When
  autopilot's QA gate (Step 5) or review loop (Step 6) exhausts its round cap with the final round
  still implementing fixes, the escape hatch previously filed its hold-labeled `/issue` follow-up
  from the **last round's** findings — which that same round's `pr-response --yes` had already
  fixed, handing a human a stale brief (#234 was a live occurrence). Autopilot now runs one extra
  `qa` / `adversarial-review` pass (outside the cap, no `pr-response` after it — cap+1 passes,
  each with a one-retry error bound, still strictly bounded) purely as the brief's source:
  findings → the follow-up is filed from **those** findings; a clean pass → the filing is
  **skipped** entirely, since a clean pass over the fixed code is the convergence evidence the cap
  denied the loop. Filing, like arming, belongs to the last enabled fix loop: when the review loop
  follows the QA gate in the same run, the QA hatch's filing defers to Step 6 — its `pr-response`
  rounds triage the fresh-pass findings, so no follow-up is filed that the same run then fixes.
  The fresh pass runs **before** arming so an armed PR can't merge mid-pass; if the pass errors
  twice, the hatch falls back to the last round's findings with a staleness note, and the run
  report gains buckets for the handed-off and fallback outcomes. The audit gate's escape hatch (Step 7)
  is a hard block and is unchanged. **Consumer impact:** prose + placeholder-description change
  only (autopilot SKILL.md and the `autopilot.maxQaRounds` / `autopilot.maxReviewRounds` /
  `autopilot.holdLabel` descriptions); no config or schema change; consuming repos pick it up on
  re-render.
- **entryPattern validation now reports every malformed entry/leaf in one pass (#246, deferred
  F5 from #245's review).** `entryPatternProblems` (né `entryPatternProblem`) walks the whole
  map-valued config value instead of short-circuiting on the first bad entry, so a
  `git.agentIdentities` map with three independent mistakes surfaces all three errors in one
  render/validate run instead of one per fix-and-retry cycle. Each individual message is
  byte-identical to before; only the multiplicity changed. Also renames the internal
  `compilePatterns` to `compileGuards` — it returns the `{ patterns, entryPatterns }` guards
  object, not a patterns Map. **Consumer impact:** error-output only; no config, schema, or
  rendered-file change, no re-render needed.
- **CI workflow identity aligned with the identity model (#160).** CI attribution was decided
  entirely by whichever token created the event, and the relationship was documented nowhere.
  The fix is deliberately *not* a `git config user.*` step in the workflows: `git.botName` /
  `git.botEmail` carry placeholder defaults, so pinning an identity in a workflow would impose a
  fake bot on every consumer who never opted in. **The no-clobber rule extends to CI.**
  The model, now written down in the github-workflow setup note as **"CI identity — token vs. git
  config"**: the *event* identity (PR/comment/tag author) is decided by the **token**
  (`WAFFLE_HYGIENE_TOKEN` / `WAFFLE_RELEASE_TOKEN`, else `github.token` → `github-actions[bot]`,
  which triggers no further workflows); the *commit* identity is decided by the resolved
  **`git.cmd`** in the committed, rendered git-workflow skill — which wins because `git -c`
  outranks the **repo-local** config the pinned dispatcher writes on every run (`git config
  user.name "claude[bot]"`, its `bot_name`/`bot_id` defaults). So an opted-in repo's CI commits
  have carried the bot identity since #155, with nothing further to configure; a repo on a bare
  `git.cmd` commits as **`claude[bot]`**, not as the runner. The note also splits the two
  precedences the toolkit must avoid: a `git config user.*` step *loses* to `git -c` (but
  clobbers a bare repo), while a `GIT_COMMITTER_*` env var *beats* it. Making the *PR* show the
  bot requires the PAT to belong to the bot account; the toolkit cannot configure that.
  One behavioral change: **`waffle-label-hook`'s implement job now dispatches with
  `github_token: ${{ secrets.WAFFLE_HYGIENE_TOKEN || github.token }}`**, matching hygiene and
  pr-response — so implement PRs are authored by the same account as hygiene PRs and trigger the
  repo's required CI. **Consumer impact:** no-op for repos without the secret. Repos that *have*
  it should read the blast-radius note, now spelled out in the setup note — with the secret set the
  job's `permissions:` block no longer bounds the run (it scopes `github.token` only), the
  attacker-authored issue body reaches the harness prompt, and the dispatcher writes the token into
  `.git/config`. Use a GitHub App installation token or a **repo-scoped fine-grained PAT**; a
  classic PAT turns applying a label into an account-wide escalation. The harness-driven workflows carry
  identity-neutrality design comments, and the release hook's lightweight tag (which stores no
  tagger identity at all) is pinned by test against an `-a`/`-m` upgrade.
- **A defined signing model for bot and agent authors (#158, closes the #153 epic's last gap).**
  The toolkit configured no signing, so `git.cmd` — which overrides the identity and *nothing else* —
  left `commit.gpgsign` ambient. On a signing machine that meant a bot-authored commit signed with
  the **human's** key (GitHub says "Verified", vouched by the human), and a *prompting* signer
  (1Password's SSH agent, a passphrase-guarded GPG key) hung the non-interactive agent commit
  outright. Both are strictly worse than an unsigned commit. Resolved as **prose, not a new engine
  key**: `git.cmd` already *is* the composed-flags surface, so the model is a resolution rule plus
  three named recipes.
  **The rule: the recipe owns the signing posture; keys own key selection.** `git.cmd` decides
  whether and how commits are signed, for the bot and every agent derived from it; a per-agent
  `git.agentIdentities[<agent>].signingKey` appends `-c user.signingkey=` *after* the base flags, so
  git's last-wins `-c` semantics make it the effective key **only when the base recipe signs**. Under
  the canonical recipe it is **deliberately inert** — one map leaf never overturns a project-wide
  "do not sign".
  **The canonical opt-in recipe now pins the posture** (recipe A, deliberately unsigned):
  `git -c commit.gpgsign=false -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}` — a
  no-op where nothing signs, and prevention of both failure modes where something does. Recipes
  **B** (SSH: `commit.gpgsign=true` + pinned `gpg.format=ssh` + `user.signingkey`) and **C** (GPG)
  are documented upgrades that *reference* `git.signingKey`, which is why that key stays out of the
  default recipe (its empty default would render `git -c user.signingkey=`, which git rejects only
  when the command signs — loudly under B/C, silently tolerated under a non-signing recipe). Both
  require a **non-prompting signer**; the surrounding plumbing (`gpg.ssh.program`,
  allowed-signers, pinentry) is named as a machine concern, not prescribed.
  **Verified status is now intentional and documented.** An unsigned commit shows **no badge**
  (neutral); a signed-but-unverifiable one shows the yellow **"Unverified"** — so recipe A yields
  cleaner history than signing with a key GitHub cannot check. A verification matrix in the
  github-workflow setup note covers all three tiers, including the honest trade-off with #157:
  making sub-agent commits Verified means registering each `bot+<slug>@…` alias on the bot account,
  which relinks every agent to one profile and one avatar — **per-agent avatars XOR verified
  sub-agent commits** — and a repo with **required signatures** branch protection cannot use
  plus-addressed sub-agent authors at all.
  **The non-interactive stall is closed at the guardrail, not by bypassing signing.** The rendered
  `git.cmd` *is* the project's explicit, committed, reviewable posture: the git-workflow skill now
  forbids deviating from it per-invocation **in either direction**, and the delegate skill instructs
  a spawned agent whose commit hangs on a signing prompt to **stop and surface it** rather than add
  `-c commit.gpgsign=false` itself.
  **Consumer impact: none — no config keys added or removed, no engine change, `git.cmd`'s bare
  default untouched.** Re-render picks up the reworded git-workflow / delegate skills. Projects
  already on a bot identity should add `-c commit.gpgsign=false` to their `git.cmd` (or adopt recipe
  B/C); the old recipe still renders, it just leaves the posture ambient.

### Fixed
- **Five fresh-pass findings from the PR #250 signing model (#252, follow-up to #158).** Recipes
  A/B/C now pin the tag posture — `tag.gpgSign=false` (A) / `tag.gpgSign=true` (B/C) — everywhere
  they are quoted: the setup note, both stacks' `git.cmd` descriptions, the git-workflow skill's
  opt-in fence, the `wafflestack init` scaffold, `schema/SETUP.md`, and this repo's own config
  (`git.cmd`'s description scopes in an annotated tag; the recipe now owns that posture too
  instead of leaving it ambient). The "git rejects an empty signingkey" claim is corrected to its
  true conditional form in all three places it shipped — git rejects it only when the command
  signs, loudly under B/C, silently tolerated under a non-signing recipe. The per-agent
  `signingKey` ↔ pinned `gpg.format` constraint is now documented at the key (both stacks'
  `git.agentIdentities` descriptions) and in the delegate skill's signing-resolution rule — a key
  whose shape contradicts the base's pinned format fails that one agent's every commit at its
  first signature; the identity gate WARNs on the mismatch. The `[Unreleased]` section order is
  fixed to Added → Changed → Fixed, and the verification matrix's noreply row now answers
  "Verified attainable?" per tier instead of silently assuming B/C.
  **Consumer impact: guidance/recipe text only** — no engine change, no schema change; old
  recipes still render (the #254 pattern admits both old and new forms). Projects on a bot
  identity should add `-c tag.gpgSign=false` (A) or `-c tag.gpgSign=true` (B/C) to their
  `git.cmd`; a re-render picks up the reworded git-workflow/delegate skills.
- **`git.cmd` now carries its own allowlist `pattern:` in both declaring stacks (#254, deferred
  F5 from #253's review).** The value is spliced verbatim into shell command literals in rendered
  skill text — the git-workflow/release commit instructions and the delegate identity preflight's
  single-quoted `--git-cmd '{{git.cmd}}'` — but the existing quote guards protected only the
  identity keys composed *inside* it, so a plain `.waffle/waffle.yaml` value like
  `git -c user.name=Bot' ; touch /tmp/PWNED ; '` rendered every file with no error. Both
  `stacks/github-workflow/stack.yaml` and `stacks/orchestration/stack.yaml` now declare a
  byte-identical (lockstep-pinned) pattern: letters, digits, spaces,
  `=` `.` `_` `/` `~` `+` `:` `@` `%` `[` `]` `-`, balanced `"…"` runs (`"` is structural, not a
  free character — an unbalanced quote would pair across the splice and silently corrupt the
  rendered command example), and whole `{{key}}` placeholder tokens — the guard tests the
  *expanded* value per render site (pinned through an unguarded nested key), and an
  orchestration-side nested miss
  survives as a literal `{{git.botName}}`, which must pass. `'`, backtick, `$` (everywhere,
  including `${{ … }}`), `;`, `&`, `|`, `<`, `>`, `\`, newlines, unbalanced quotes and the
  empty string are
  rejected; the delegate tokenizer's no-single-quote assumption is now enforced at render time,
  and the SKILL.md preflight note plus the identity.mjs comment say so instead of disclaiming it.
  **Consumer impact: a narrowed `git.cmd` contract.** The stock recipes A/B/C, the bare default,
  and every value the setup note documents all pass; a repo whose `git.cmd` uses characters
  outside the allowlist (env-var prefixes, `$HOME`, parentheses, subshells) now **fails the
  render** with an error naming the pattern and both declaring stacks — intended tightening, as
  such values already broke or subverted the rendered shell literals they land in.
- **Four identity/avatar guard findings from the PR #248 fresh pass (#249, follow-up to
  #157/#248).** All four sit on the #156/#157 identity surface; two are trust-boundary
  hardenings of the same guard-and-consumer-drift class #247 tracks. **F1:** `withIdentity`
  interpolated the display name and email into `String.replace` **replacement strings**, where
  `$&`/`$1`/`` $` `` re-expand — a `$&`-bearing email duplicated the `-c user.email` flag, so
  the smoke test committed under a different address than the manifest advertises. Both swaps
  now use replacement *functions*, immune regardless of value (latent, not reachable through
  validated config today: the `botEmail` guard excludes `$` — but the swap must be safe on its
  own). **F2:** with **every** agent's email overridden via `git.agentIdentities`, the AVATARS.md
  registration section still claimed the "derived addresses above land in" the base inbox — over
  an empty derived set, with a sign-in step naming an inbox no agent commits under; exactly the
  state the shared-address caveat's own remedy produces. The copy now distinguishes three states
  (no overrides renders byte-identically to before; the mixed state scopes its sign-in
  parenthetical to "every derived address" — per the PR #262 review, a separately-owned `‡`
  inbox is not covered by the base account; all-overridden gets honest copy: every address is
  verbatim, each verified at the inbox that receives its mail). **F3:** a
  literal raw NUL byte in `waffledocs.mjs` made ripgrep classify the file as binary and silently
  skip it — every `rg` over `installer/lib/` missed the file. Now the two-character `\0` escape
  (identical runtime string), plus a control-byte lint in `validateToolkit` that scans
  `installer/` and `stacks/` text sources (`.mjs/.md/.yaml/.yml/.json/.sh` — `.sh` added per the
  PR #262 review; the scanned roots ship one shell script) for control bytes other
  than tab/LF/CR, so the regression class fails `npm run validate`. **F4:** `IDENTITY_AVATAR_RE`'s
  URL alternative admitted `@`, so a userinfo authority (`https://good.tld@evil.tld/x.png` —
  displayed host ≠ fetch host) passed the guard its own comment enumerates as strict. The class
  now excludes `@` entirely (deliberate tightening: also blocks `@` in URL paths; nothing in the
  avatar contract needs it), a `(?!.*%40)` lookahead closes the percent-encoded form the class's
  own `%` would otherwise smuggle through (#262 review), and the rejection message names the new
  rule. **Consumer impact:** no config or schema change. Rendered-file change only for a project
  in the mixed-overrides state (one reworded AVATARS.md line — re-render at leisure); every other
  state, including this repo's, renders byte-identically (verified: the lock is byte-stable
  across a re-render). A pre-existing `identity.avatar` URL carrying `@` or `%40` would newly
  fail validate — which is the point.
- **The agent slug is now guarded at the identity trust boundary, and the duplicated
  `entryPatterns` are pinned in lockstep (#247, follow-up to #156/#245).** The delegate skill
  splices TWO values into the same agent-executed `git -c user.name="…" -c user.email=…` command:
  `identity.displayName` was policed by `validateStack` (and by `validateExternalStacks` at render
  for third-party stacks), but the agent slug beside it — the agent's filename — was checked
  nowhere, despite reaching the command always (as the `bot+<slug>@…` plus-address) and, when
  `displayName` is absent, as the title-cased `user.name` fallback that the displayName allowlist
  never sees. `validateStack` now rejects any agent whose name falls outside `[A-Za-z0-9._-]+`
  (with at least one letter or digit — a separator-only slug like `---` title-cases to an empty
  `user.name`), unconditionally (not gated on an `identity:` block), closing the asymmetry for
  both the toolkit's own `validate` and the external-stack render gate. Per the PR #260 review,
  `loadStack` also rejects `agents:`/`skills:` manifest entries carrying path separators or dot
  segments *before* the first `path.join` — previously a traversal entry like `../../secret` was
  dereferenced as a path at load, reading outside the toolkit root before any guard ran (`files:`
  entries always had this load-time check; agent/skill names now do too). Separately, the
  byte-identical `git.agentIdentities.entryPatterns` declarations in `github-workflow` and
  `orchestration` are now pinned deep-equal by a test, so a one-sided edit fails the test suite
  instead of silently weakening the guard in single-stack installs (note the pin binds where the
  suite runs — locally and in any consumer's checks; the toolkit's own merge path currently gates
  on `doctor` only), and the orchestration lockstep comment now names the loosening hazard, not
  just the tightening one. **Consumer impact:** validate/load-time errors only — every shipped
  slug already conforms; no config, schema, or rendered-file change, no re-render needed.
- **Pattern-guard rejections now name the declaring stack and the failing pattern (#244, engine).**
  `pattern:` / `entryPatterns:` guards are unioned toolkit-wide (deliberately — the guard travels
  with the KEY; see the #155-review entry below), which meant a stack the project never installs
  could veto a config value with an error naming neither the stack nor the regex. Rejections now
  append `` `<pattern>` (declared by stack "<name>") `` for every guard the value fails — failing
  guards only, never ones it satisfies, on both the scalar and `entryPatterns` paths (one shared
  filter serves both) — and the reserved `harness.*` guards identify themselves. The pattern is
  backtick-delimited (shipped regexes end in spaces and groups that would otherwise abut the
  attribution), and identical patterns declared by several stacks are grouped, printed once with
  their sources joined. The multi-stack AND ("a key guarded by more than one stack must satisfy
  all of its patterns") was previously untested since no shipped key is dual-declared with
  differing regexes; a two-stack fixture test now pins it on both paths (the byte-identical
  `entryPatterns` dual-declaration is live: `git.agentIdentities` in `github-workflow` and
  `orchestration`). The #155 entry's "no behavior
  change" consumer-impact claim is corrected in place to the narrowed-contract statement it should
  have made. **Consumer impact:** error messages only — no config or schema change, no re-render
  needed.
- **Config `pattern:` guards are compiled toolkit-wide, not per stack (#155 review, security).**
  `render` compiled each stack's `pattern:` guards while rendering *that stack's* items, so a guard
  only applied where its declaring stack happened to be installed. Only `github-workflow` declares
  `git.botName` / `git.botEmail`, so an **orchestration-only** install — the configuration
  `orchestration`'s own `git.cmd` description steers users into — spliced *unvalidated* project
  config into an agent-executed shell command: `botEmail: "$(id)@x.com"` and a quote-breaking
  `botName` both rendered `ok=true` into `delegate/SKILL.md`, while the identical values were
  rejected the moment `github-workflow` was co-installed. Guards now compile once across every
  stack, so a guard travels with the **key**; a key guarded by more than one stack must satisfy all
  of its patterns. **Consumer impact:** a render that was silently accepting a value violating a
  guard declared in a stack you do not install will now fail loudly — which is the point. No
  conforming config changes behavior.
- **`waffle-post-merge-hook` — broaden the undeletable-branch warning.** The `else`-branch
  `::warning` (and its matching comments) now name a transient API error (5xx / rate-limit / network)
  alongside "protected" and "missing `contents: write`", since that branch also fires when the ref
  still exists after a flaky delete. Message-only; no behavior change (#189 review nit).
- **PR-green hook could never post its review (#188, `github-workflow` + `code-quality`).** The
  `waffle-pr-green-hook` dispatch prompt asks the harness for single-program commands so the CI
  allowlist can match them, while `adversarial-review` instructed a `gh api … --input - <<'EOF'`
  **heredoc**. A multi-line command never matches a `Bash(gh api:*)` prefix, so on the hook's first
  live run every delivery call was denied and the completed review was thrown away. Three changes:
  `adversarial-review` now stages its payload with `Write` and posts single-line
  (`gh api … --input <file>` / `gh pr review … --body-file <file>`) and emits the
  `<!-- waffle-adversarial-review -->` marker itself rather than relying on the workflow prompt to
  inject it; the hook's allowlist gains `Write` (mandatory — a multi-line review body needs a file,
  and nothing else could create one) plus read-only `git log`/`diff`/`show`/`status`; and the
  `Check harness result` guard now **verifies delivery against the API** — it asks GitHub whether a
  marker-carrying review exists on the head commit — instead of guessing from the harness's
  free-form final text. A denied read-only call no longer reds a run that demonstrably posted, and
  a run that did *not* post still fails. Sandbox escapes remain unconditionally red, never
  downgraded. Fail-closed: an API error is never read as proof of delivery.
  - **Consumer impact:** re-render. Nothing to configure; `Bash(git:*)` is deliberately still
    excluded, as the job holds `contents: read` only.

- **Coherence holes in the persistent-gate-agent playbook (#297, follow-up to #295).** #295 made each
  gate loop's responder spawn **lazily** (only once a review surfaces findings), but three statements
  in autopilot's Steps 5/6 still assumed it always exists — so a zero-finding round 1 was told to
  `shutdown_request` an agent that was never spawned and to read convergence from a `pr-response`
  return that never happened. Teardown is now scoped to **each agent the loop actually spawned**, and
  the reviewer's own clean summary ("no QA concerns" / "no holes found") is named as the stop signal
  when no responder ran. The `qa` and `adversarial-review` skills gain the **cold-start recovery rule**
  #295 gave `pr-response`: a reviewer re-spawned cold by autopilot's vanished-agent fallback now seeds
  its finding/verdict history from the PR's own marked reviews and the `<!-- waffle-pr-response -->`
  verdict table instead of re-raising every settled finding. Both cap hatches' fresh evidence pass is
  now specified as **unnamed** (it runs once and is never resumed, and the standing agent still holds
  the gate name until its deferred teardown). The lazy spawn's trigger is scoped to **untriaged
  findings on the head**, with disposal read from the marked `<!-- waffle-pr-response -->` reply's
  **verdict table** rather than from the reply's mere existence (one reply is PATCHed in place across
  rounds, so it exists as soon as any responder has run) and *when in doubt, spawn the responder* as
  the tie-break — so a clean round over a head still carrying another gate's untriaged findings, such
  as the QA cap hatch's un-triaged evidence pass, cannot converge and arm a merge over them. Both
  teardown lists (item 3 and Failure handling) now name the **spawned set** rather than a fixed pair:
  a never-green PR stops before round 1 and spawned neither agent.
  - **Consumer impact:** re-render. Prose-only; no config, no behavior change to the gates' contracts.

## [0.11.0] - 2026-07-08

### Consumer impact
- **New capability, additive — third-party stacks: pull a stack from a pinned git source or a
  local path (#88, #124–#127).** A `stacks:` entry in `.waffle/waffle.yaml` may now be **either** a
  bare built-in name (unchanged) **or** a `{ name, source, ref }` mapping pointing at an external
  toolkit — a git URL (pinned to a **required** `ref`) or a local filesystem path. External sources
  are resolved and merged into one registry, so a **single render / lock / `doctor` / `upgrade`
  pipeline handles built-in and external stacks alike**. Provenance is recorded in the lock (a
  `sources` block), `doctor` attributes any drift to its source, and `upgrade` re-resolves each pin
  and reports commit moves. External stacks are lint-validated **before any byte is written**, and
  pouring their opt-in syrup asks for an extra trust-boundary acknowledgement. **Purely additive** —
  a repo using only built-in names renders byte-identically (the `sources` lock block is omitted when
  empty), and `list`/`setup` still operate on the built-in surface only. Authoring guide:
  `schema/AUTHORING-EXTERNAL-STACKS.md`.
- **Additive; no re-render diff, but `doctor` now checks prerequisites, `setup` surfaces them, and
  the CI dispatcher is now repointable (#129/#130/#131).** The typed `prerequisites:` block does not
  render into any file, so a re-render produces no output/lock change. A repo that runs
  `waffle-doctor.yml` (or `wafflestack doctor`) will, on its next run, start verifying the selected
  stacks' declared prerequisites — an unmet `require` fails the check. The seeded `require`s are only
  `command -v node/git/gh` (present on any CI runner and dev machine); everything
  environment-specific is `recommend` (reports, never fails), so a correctly-set-up repo stays green.
  An existing `env:` map is unchanged. `setup` now lists each stack's prerequisites by kind and flags
  unmet `require`s as blockers in update mode (#130). Three reserved `harness.*` keys
  (`harness.actionRef` / `harness.actionVersion` / `harness.apiKeySecret`, #131) let a consumer pin a
  different action version or rename the billing secret **without ejecting** the rendered CI
  workflows; the built-in defaults reproduce today's pinned action byte-for-byte, so an unconfigured
  repo's render/lock is unchanged.
- **New CLI command, additive — `list` (#119).** `wafflestack list` prints an aligned, agent/CI-safe
  plain-text table classifying every stack and item **installed & current** / **out of date** / **not
  installed** (`--no-color`/`NO_COLOR` honored); `--interactive` (real TTY) drives a keypress
  multi-select — out-of-date items pre-checked — that installs/updates the chosen refs and re-renders.
  Read-only by default; no render/config change and no new dependency. CLI command count 8 → 9.
- **Re-render to pick up — full codex/agents-dir target coverage closes the render asymmetry (#94).**
  Previously `codex` got agents but no skills and the cross-tool `.agents/` dir got skills but no
  agents; now **every target renders both**. A consumer rendering the `codex` target gains its stack's
  skills (in the `.agents/skills/` dir Codex already scans), and one rendering `agents-dir` gains
  agents as neutral Markdown at `.agents/agents/<name>.md`. Re-render adds those files; no config
  change, no migration. Repos rendering only the `claude` target are unaffected.
- **Opt-in — enable/upgrade `code-quality` and re-render for two new skills, now project-agnostic
  (#112/#116/#117).** `adversarial-review` (`/adversarial-review <PR#>`, defaults to the current
  branch's PR) reviews a finished, CI-green PR from a hostile reviewer's seat — correctness edge
  cases, error handling, test depth, API/naming, simplification — and posts an honest-severity review
  (blocker / should-fix / nit), where "no holes found" is a valid outcome; distinct from the built-in
  `/code-review`, which reviews the author's *uncommitted* diff. `dry` (`/dry <path>`) removes genuine
  duplication under rule-of-three and semantic-sameness guardrails. Neither adds config keys. The
  stack also shed its Obsidian/Synapse-specific assumptions, so it now drops cleanly into any project
  (#117). **The PR-green auto-trigger now ships** as opt-in syrup in `github-workflow`
  (`waffle-pr-green-hook.yml`): it dispatches `adversarial-review` the moment a PR's required checks go
  green (once per green transition, deduped by a review marker), and can render just the one skill via
  the qualified `code-quality/skills/adversarial-review` ref alongside the workflow. This repo now
  dogfoods both. A repo that doesn't enable `code-quality` (or install the workflow) is unaffected.
- **Additive, opt-in, default-off — the autopilot backlog runner and its two delegate opt-ins
  (#98/#99/#100/#101).** The new `autopilot` orchestration skill composes `delegate` + `clean-up` +
  `git-workflow` into an unattended per-issue **plan → implement → PR** loop; every run captures an
  explicit issue scope and a fresh, never-sticky auto-merge consent, and its guardrails never push to
  `main`, never `--admin`-merge, and always leave a PR. It rides on two new default-off delegate keys:
  `delegate.autoMerge` (#98 — arm `gh pr merge --auto --merge` after `gh pr create`, only where the
  repo allows auto-merge and a required check exists) and `delegate.batchMode` (#99 — skip delegate's
  Phase-3 plan-approval pause when explicit scope is given, without weakening `approveBeforePush`). Two
  optional keys `autopilot.autoMerge` / `autopilot.planDir` are added. Re-render to pick them up; a
  repo that never invokes these is unchanged.
- **Re-render for the skills, opt-in for the hook — post-merge close-out and a faster clean-up
  (#67/#114).** The `git-workflow` and `clean-up` skills gain a post-merge convention (verify each
  linked issue closed, board Status → Done, then `clean-up git --yes`), and a new opt-in syrup
  workflow `waffle-post-merge-hook.yml` deterministically deletes a merged same-repo head branch on
  the remote (no Claude dispatch, no API spend; fork heads and the default branch skipped). Separately,
  `clean-up --execute` now fast-forwards the local default branch to the freshly-fetched remote tip —
  **only** when you are on it with a clean tree, and only as a fast-forward (never a merge, switch, or
  rebase), previewed in the dry-run plan (#114). Re-render for the skill changes; the hook is opt-in.
- **Additive, re-render + create one label — armed PRs are tagged `waffle-auto-merged` (#134).**
  Wherever the toolkit arms `gh pr merge --auto` (the hygiene and delegate skills), it now applies a
  configurable label on a successful arm as a durable paper trail that automation queued the merge
  (`is:pr label:waffle-auto-merged`). New optional key `autoMerge.label` (default `waffle-auto-merged`,
  declared in both the `github-workflow` and `orchestration` stacks). Re-render to pick it up, and
  create the label — `gh pr edit --add-label` will not.
- **Re-render (repos running the syrup hooks) — hygiene/CI fixes (#85/#97).** The dispatched-harness
  guard in `waffle-hygiene.yml` and both `waffle-label-hook.yml` jobs is now **delivery-aware**: when a
  run reports a PR URL (proof it landed its work) its hard denials are downgraded to a warning instead
  of red — a `dangerouslyDisableSandbox` escape is the sole always-red exception — ending the
  green-mission/red-check that trained alert fatigue (#85). And the `hygiene` skill now arms auto-merge
  with a **merge commit** (`gh pr merge --auto --merge`) rather than `--squash`, which errors on a
  squash-disabled repo, while `clean-up`'s branch detection is documented as merge-method-agnostic
  (#97). Re-render; repos that never installed these syrup hooks are unaffected.
- **Additive, one optional secret — release-hook `WAFFLE_RELEASE_TOKEN` fallback (#76).**
  `waffle-release-hook.yml`'s checkout now reads `${{ secrets.WAFFLE_RELEASE_TOKEN || github.token }}`,
  so a tag it pushes can trigger a consumer's downstream `on: push: tags` CI (a tag pushed by the
  ambient `GITHUB_TOKEN` cannot, by GitHub's anti-recursion rule). Zero-config behavior is unchanged;
  supply the PAT/App-token secret only if you need downstream workflows to fire. Re-render (repos
  running the release hook).
- **Re-render regenerates them — per-agent waffle avatars in the `.waffle/` overview docs
  (#128/#161).** `team.html` and `cheatsheet.html` now show a branded per-agent "wafflebot" avatar,
  every trait a pure function of the agent name (so renders stay byte-identical and doctor-clean) with
  the installed-skill count encoded in the waffle pockets, plus deep-link anchors and a hover ID card.
  These are generated output — commit them, don't hand-edit — and refresh on the next render; a repo
  with no agents gets no `team.html`.
- **Docs only — no re-render needed (#80).** `schema/FORMAT.md` now documents the
  "how do I know a file is wafflestack-managed?" story: the lock manifest
  (`.waffle/waffle.lock.json`) is the authoritative marker, backed by `render`'s
  refuse-to-clobber behavior and `doctor` drift detection. Records the decision to **not**
  adopt a `.wfl.md` filename convention — a suffix breaks skill (`SKILL.md`) and syrup
  (load-bearing path) discovery and would apply to agents only, so the lock manifest already
  answers the question authoritatively for every render kind. No config, render, or lock
  changes.
- **Dev / CI tooling — no consumer render or config change.** The Layer 2 eval harness and its cases
  (#109/#110) are authoring/CI surface inert to `render`/`validate`/`doctor`; their only
  consumer-facing surface is an **off-by-default opt-in syrup** workflow `waffle-evals.yml` (#111), so
  nothing arms until you install it. The #47 entry is a **design-only ADR** (no code shipped). This
  repo also installs the toolkit's own `wafflestack` self-stack (#120) and repositions itself in the
  README (#86) — neither touches a consuming repo — and `wafflestack setup`'s render-blocker report is
  now scoped accurately to the selected items' keys (#77).
- **No migration ships in this release** — it is a **minor, additive** move (contrast 0.10.0, which
  carried one). A plain re-render picks up every rendered change above; the opt-in items (external
  stacks, the `code-quality` skills, `autopilot`, and the syrup workflows) arm only when you install
  them.

### Added
- **External third-party stacks — pinned git / local source, resolved through one pipeline** (#88,
  #124–#127). `loadProjectConfig` classifies each `stacks:` entry as a built-in name or a validated
  `{ name, source, ref }` external source (source required; a git source must be pinned with `ref`, a
  local path must not carry one; names unique across all sources). A new `installer/lib/sources.mjs`
  resolves a git source (clone + checkout at the pinned ref into a content-addressed cache) or a local
  path (read in place); `loadToolkitWithSources` merges built-in + external roots into one registry and
  makes a stack name defined by two sources a **hard error naming both** (never a silent shadow).
  `render` lint-validates every external stack before writing (`validateExternalStacks`), writes a
  per-source `sources` provenance block to the lock (source, ref, resolved commit, files), and adds an
  extra trust-boundary acknowledgement when external opt-in syrup is poured; `doctor` attributes drift
  to its source and `upgrade` re-resolves each pin and reports `sourceMoves`. Authoring guide
  `schema/AUTHORING-EXTERNAL-STACKS.md` documents the source side. (#88, #124, #125, #126, #127)
- **Declarative `prerequisites:` schema + `doctor` gate (#129, first increment of #47).** A stack
  may now declare the **external** things it leans on — a `tool`, `secret`, `scope`, `label`,
  `setting`, `service`, or `env` — as a typed `prerequisites:` list in `stack.yaml`, distinct from
  the internal-only `requires:` keyword. Each entry carries a `kind`, `name`, `description`, a
  deterministic `check` (a shell command; exit 0 = satisfied), a `level` (`require` | `recommend`),
  and an optional `items:` list scoping it to specific waffles like `requires:`. `wafflestack
  doctor` runs each **selected** entry's check and **exits 1** on an unmet `require` (a `recommend`
  only reports), so a repo running the shipped `waffle-doctor.yml` gate verifies prerequisites on
  the same CI run; `render` additionally warns for each unmet cheaply-probed (`tool`/`env`)
  prerequisite. `validate` checks the block's shape. The legacy `env:` map is subsumed as the `env`
  kind **read-compatibly** (it keeps working, still warned at render — no stack must migrate). The
  `github-workflow` + `orchestration` stacks are seeded from the #47 inventory: only `command -v`
  tool probes (node/git/gh) are `require`; every secret/scope/label/setting/service is `recommend`.
  Documented in `schema/FORMAT.md`. New module `installer/lib/prerequisites.mjs`.
- **Prerequisites surfaced in `setup` + the SETUP.md playbook** (#130). The setup inventory lists each
  stack's whole `prerequisites:` block grouped by kind (with level, item scope, and check); update mode
  runs the applicable checks the way `doctor` does and flags unmet `require`s as blockers; and
  `schema/SETUP.md` step 4 becomes a required, structured walk of the block — shared-state kinds
  (secret/label/setting/service) still gated on the user's explicit go-ahead (warn-don't-provision). No
  new interactive CLI surface.
- **Repointable CI dispatcher — reserved `harness.*` keys** (#131). `harness.actionRef` /
  `harness.actionVersion` / `harness.apiKeySecret` render into the `uses:`/`with:` lines of both
  dispatch workflow templates, so a consumer can pin a different action version, repoint the ref, or
  rename the billing secret via config without ejecting. Injection-guarded (rejects `${{`, quotes,
  newlines; `apiKeySecret` restricted to a secret identifier) and enforced at render + `validate`;
  built-in defaults reproduce today's pinned action byte-for-byte.
- **`list` CLI command** (#119). New `installer/lib/list.mjs` composes `loadToolkit` +
  `loadProjectConfig` + `computeSelection` + the lock and doctor-style sha256 drift + version skew to
  classify every stack/waffle/syrup file **current** / **out of date** / **not installed**. Default
  output is a plain, non-TTY-safe aligned table (status the fixed-width leading column); `--interactive`
  drives a hand-rolled `node:readline` + ANSI multi-select that applies via the existing
  `installRefs()` + `renderProject()` path — **no new dependency**. The item→output-path matcher is
  extracted into `refs.mjs` (`itemOutputMatcher`), shared with `eject`. README Commands table updated.
- **`adversarial-review` skill + PR-green auto-trigger** (#112, `code-quality` + `github-workflow`).
  The config-free `/adversarial-review <PR#>` skill (defaults to the current branch's PR) reviews a
  finished, CI-green PR from a hostile reviewer's seat and posts an honest-severity review; the opt-in
  syrup `waffle-pr-green-hook.yml` dispatches it when a PR's required checks go green, once per green
  transition (deduped by a head-commit review marker; draft/bot/fork/idempotency gates,
  least-privilege perms). Adds optional `prGreen.watchWorkflows` / `prGreen.claudeArgs` (both
  injection-guarded). Dogfooded/armed in this repo.
- **`dry` skill** (#116, `code-quality`). A project-agnostic `/dry <path>` skill that removes genuine
  duplication under rule-of-three and semantic-sameness guardrails, then proves behavior unchanged via
  `{{project.testCmd}}` (reuses the existing key; no new config). Both user-invocable and agent-granted.
- **`autopilot` skill + the delegate opt-ins it composes** (#100/#101, orchestration; #98/#99,
  orchestration). `autopilot` is a prose playbook that composes `delegate` (batch mode + auto-merge),
  `clean-up`, and `git-workflow` into an unattended plan → implement → PR loop with a required issue
  scope and per-run, non-sticky auto-merge consent; two optional keys `autopilot.autoMerge` /
  `autopilot.planDir`, `requires:` delegate + clean-up + git-workflow + github-project-management. It
  rides `delegate.autoMerge` (#98 — arm `gh pr merge --auto --merge` after create; `autoMergeArmed`
  checkpoint field) and `delegate.batchMode` (#99 — skip the Phase-3 plan-approval pause under explicit
  scope; `confirmedVia` checkpoint field), both default-off.
- **Post-merge automation** (#67, `github-workflow`). New "After a PR merges" section in `git-workflow`
  and "Post-merge convention" in `clean-up` (verify issue closed → board Done → `clean-up git --yes`),
  plus opt-in syrup `waffle-post-merge-hook.yml` — a deterministic `pull_request: closed` + `merged`
  job (`contents: write`, no Claude dispatch) that deletes the merged same-repo head branch on the
  remote and emits a prune signal, skipping fork heads and the default branch.
- **`autoMerge.label` — a `waffle-auto-merged` paper trail on armed PRs** (#134). New optional key
  (default `waffle-auto-merged`), applied on a successful `gh pr merge --auto` arm at both live arming
  sites (the hygiene skill and both delegate arming paths); declared in the `github-workflow` and
  `orchestration` stacks. Setup notes instruct creating the label.
- **`WAFFLE_RELEASE_TOKEN` fallback in the release hook** (#76, `github-workflow`).
  `waffle-release-hook.yml`'s `actions/checkout` reads `${{ secrets.WAFFLE_RELEASE_TOKEN ||
  github.token }}`, mirroring the `WAFFLE_HYGIENE_TOKEN` pattern, so a tag it pushes runs under a
  PAT/App token when supplied and triggers downstream CI. Setup note + `release` skill caveat document
  the GitHub anti-recursion limitation.
- **Layer 2 eval harness + per-stack case format (#109).** A metered, LLM-driven eval tier
  (Layer 2 of #89, on top of the Layer 1 content assertions in #108). Behavioral cases live
  next to their stack at `stacks/<stack>/evals/<name>.eval.yaml`: a declarative case is a
  render target (skill/agent, resolved within the stack) + a scenario prompt + one or more
  transcript-level assertions (`includes`/`excludes`/`regex` deterministic; `judge` LLM-graded).
  The runner (`installer/lib/evals.mjs`, driven by `npm run evals`) renders the target through
  the real pipeline, drives a model against the scenario, and evaluates the assertions,
  returning structured pass/fail with the transcript. Because it costs real API money it is a
  **separate entry point, never part of `npm test`**, and every run is bounded by an explicit,
  enforced `--max-calls` budget (the runner refuses to start a call once the cap is reached).
  A `--dry-run` mock mode (and the `installer/test/evals.test.mjs` unit test) exercises the
  whole harness with no API key and no cost. Format documented in `schema/FORMAT.md`; ships a
  seed case under `stacks/github-workflow/evals/`.
- **Layer 2 eval cases + a scheduled runner** (#110, #111). Initial behavioral cases pin the costliest
  guardrails of the four highest-risk skills — `label-hook` (constant dispatch token, no fan-out),
  `issue` (template sections + sensible labels), `release` (never tags/pushes `main`; stamps the
  CHANGELOG), and `delegate` (>2-agent confirmation gate; a failed checkpoint halts) — each with a
  deterministic assertion plus a judge rubric (#110). The opt-in syrup `waffle-evals.yml` runs the
  metered tier nightly + on dispatch as a plain Node job (no Claude dispatch, `contents: read`, needs
  only `ANTHROPIC_API_KEY`), bounded by `evals.maxCalls` and reporting an `eval-results` artifact; adds
  `evals.cron` / `evals.maxCalls` / `evals.model` config (#111).
- **Per-agent waffle avatars in the overview docs** (#128, #161). The docs generator draws a branded
  per-agent avatar as inline SVG in `team.html` (with `id="agent-<name>"` deep-link anchors) and mini
  avatars badging each skill in `cheatsheet.html` (with a CSS-only ID-card popover). Every trait is a
  pure function of the agent name and the installed-skill count encodes into the waffle pockets, so
  renders stay byte-identical and doctor-drift-clean. #161 redesigns them to the "wafflebot" reference
  (waffle-iron + antenna, 10 expressive lid presets, six syrup flavors, gentle deterministic SMIL
  animation).

### Changed
- **Full codex / agents-dir render coverage** (#94). `renderAgent` gains an agents-dir branch
  (neutral Markdown at `.agents/agents/<name>.md` — `name`/`description`/`skills` frontmatter + body,
  no Claude `claude:` passthrough) and `renderSkill` gains a codex branch that shares the `.agents/skills`
  render with `agents-dir` (deduped by output dir, first target wins). `eject` learned the new
  `.agents/agents/<name>.md` path. README / ARCHITECTURE / FORMAT / AGENTS.md now describe full
  coverage.
- **`code-quality` made project-agnostic** (#117). `codebase-architecture` generalizes the Obsidian
  `onload()/onunload()` lifecycle to a neutral register/teardown contract and drops the hardcoded file
  tree for generic structure guidance; `tdd` gains an explicit "how and when to use" section; and the
  stack's config descriptions are scrubbed of Obsidian/Synapse example strings. No config keys added
  or removed.
- **`clean-up` fast-forwards the local default branch** (#114). After `git fetch --prune`,
  `clean_up.sh --execute` fast-forwards the local default branch to the remote tip when you are on it
  with a clean tree — ff-only, previewed in the dry-run plan — and the "never touched" guarantee and
  report format are reworded to match.
- **Docs & dogfooding.** README gains a "Where this fits" market-positioning section (#86); this repo
  installs the toolkit's own `wafflestack` self-stack (#120); and the machine/human doc registries
  (`AGENTS.md`, `STATUS.md`, `DECISIONS.md`) are refreshed for the autopilot loop and the 2026-07-08
  feature work (#101 doc pass; internal doc-registry sync).

### Fixed
- **`setup` over-reported render blockers** (#77). Setup iterated a stack's entire `config` schema
  whenever any of its items was selected and tested the raw value (ignoring defaults), so a partial
  selection saw phantom blockers and a defaulted required key read "unset". It now derives `usedKeys`
  from the **selected** items (`collectUsedKeys`, newly exported from `render.mjs`) and resolves through
  the default-aware `makeResolver` — exactly as `render` computes them — for both the blocker list and
  the "Config values" ⚠ markers.
- **The CI guard false-redded delivered hygiene/label-hook runs** (#85). The #82 guard classified a
  delivered run's denials as HARD and failed the job even though it had opened a PR seconds earlier. The
  guard is now delivery-aware across the hygiene template and both label-hook jobs: hard delivery
  denials are downgraded to a warning when the run's final text reports a PR URL (a
  `dangerouslyDisableSandbox` escape stays always-red), the dispatch prompts steer to single-program
  (no-`cd`) commands so allowlisted `git`/`gh` calls actually match, and `Bash(gh repo view:*)` is
  allowlisted for read-only inspection.
- **Auto-merge assumed squash-merge** (#97). The `hygiene` skill's `gh pr merge --auto --squash` errors
  on a squash-disabled repo; it now uses `--merge` (a merge commit), and `clean-up`'s merged-branch
  detection is reworded as merge-method-agnostic (it always read PR state via `gh`, never the merge
  method).
- **Argument-injection guard on external git sources** (#124). A `source`/`ref` from `waffle.yaml` that
  begins with `-` (e.g. `--upload-pack=…` on a `.git` source, or an ssh `-oProxyCommand=…`) would be
  parsed by git as an option; `resolveSourceRoot` now rejects a leading-dash git source or ref before
  any git call, with a `--` end-of-options marker on the clone as defense in depth.

## [0.10.0] - 2026-07-07

### Consumer impact
- **Breaking, migration ships — rebrand: bundles are now stacks, files are syrup (#59).** The
  vocabulary changes to match the name: an installable item (agent or skill) is a **waffle**, a
  named group of waffles is a **stack** (formerly "bundle"), and the generic `files/` payload is
  **syrup**. **The one breaking consumer change is the `.waffle/waffle.yaml` key `bundles:` →
  `stacks:`.** A 0.10.0 migration renames it in place (comment-preserving, across the config and
  its `.local` overlay); `wafflestack upgrade` runs it for you. A plain `render` also keeps
  working off a legacy `bundles:` key via a read-fallback, emitting a deprecation warning that
  points at `upgrade`. **Toolkit authors:** the source dir is `stacks/`, the manifest is
  `stack.yaml`, the `toolkit.yaml` key is `stacks:`, and the opt-in gate key `syrup:` is renamed
  to `optIn:` (a stale `syrup:` now fails `validate`/`loadStack` loudly rather than silently
  un-gating). The lock's `bundles` field becomes `stacks` — write-only, so it self-heals on the
  next render with no migration. **Explicitly unchanged** (no action needed): item refs
  (`skills/x`, `agents/y`, `files/z`), your `include:` / `eject:` entries, lock file paths, the
  `files:` manifest key, and the `wafflestack` package/CLI name. **Re-render after upgrading.**
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
- **Enhancement, content-only — installs no longer silently half-arm a paired flow (#74).** When a
  render/install selection includes a waffle whose opt-in syrup companion is gated out — e.g. the
  `release` skill without its `waffle-release-hook.yml` tag-on-merge hook — `render`/`install` now
  prints a `warning:` naming the skipped syrup and the exact `wafflestack install files/<path>`
  command to pour it, and `setup` update-mode flags the same pairing. `schema/SETUP.md` promotes its
  opt-in-syrup guidance from advisory to a **required** both/one/neither question the installing
  agent must ask. The CLI stays deliberately non-interactive (no TTY prompt). **Re-render costs
  nothing** — warnings only, no config/lock/render-output change and no migration; a repo whose
  paired syrup is already installed or tracked stays quiet.
- **Enhancement, content-only — the generated overview one-pagers are now branded HTML, not SVG
  (#75).** `render` used to emit `.waffle/cheatsheet.svg` + `.waffle/team.svg`; it now emits
  `.waffle/cheatsheet.html` + `.waffle/team.html` — self-contained pages with selectable,
  searchable, reflowing text and the full brand type stack (Baloo 2 / Outfit / JetBrains Mono via
  Google Fonts, with a brand-styled system-font fallback so they render correctly offline). The
  Markdown cheat sheet/team docs are unchanged. **Re-render to pick it up** — the old `.svg` files
  are pruned automatically by render's frozen-image sweep (they were previously-managed paths this
  render no longer produces); no config key changes and no migration. If your `.gitignore` listed
  the old `.svg` overview paths, swap them for the `.html` names.

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
- **Layer 1 eval tier: deterministic content assertions on rendered stack prompts** (Part of #89).
  New `installer/test/content.test.mjs` (picked up by the existing `npm test` glob) asserts the
  load-bearing *behavior* baked into the highest-risk rendered prompts — not just that they render
  byte-correctly. Covers: label-hook's constant action-token rule and untrusted-input/no-fan-out
  refusals; delegate's >2-agent confirmation gate, pre-flight checklist, hard checkpoint gate, and
  opt-in-and-off-by-default approval gate; the issue and release template sections and tag-safety
  guardrails; frontmatter presence across every rendered skill/agent; and no leftover config
  placeholders. The label-hook workflow (gitignored, not committed) is rendered fresh into a temp
  project via the real render pipeline and asserted on there — the bot-sender gate on both dispatch
  jobs and the exact-match label gate. Dev-only; no consumer-facing change. The LLM eval tier is
  tracked as sub-issues of #89.

### Changed
- **Overview one-pagers: branded self-contained HTML replaces the SVGs** (#75). `waffledocs.mjs`
  swaps its `cheatsheetSvg`/`teamSvg` generators for `cheatsheetHtml`/`teamHtml`, emitting
  `.waffle/cheatsheet.html` + `.waffle/team.html` through the same `generateWaffleDocs` → `emit()`
  path (so they stay lock-tracked, doctor-checked, and pruned). Each page is a valid standalone
  HTML5 document: semantic `<ul>` rows of the same skill/agent frontmatter, the waffle glyph inline
  as SVG, the wafflestack palette (dark by default, warm-paper light via `prefers-color-scheme`),
  and a hybrid font strategy — Google Fonts `<link>` tags for the brand type as progressive
  enhancement, backed by a brand-styled system-font stack, with those font links the only external
  reference. The retired `.svg` paths are pruned on the next render via render's frozen-image sweep.
  Docs (`schema/FORMAT.md`, `AGENTS.md`, `.gitignore`) and the installer tests are updated to match.

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
- **Enhancement, content-only — typed checkpoints between `delegate` phases (`orchestration`, #91).**
  The `/delegate` skill now writes one schema-validated JSON checkpoint per run and validates it at
  every phase boundary (Fetch → Classify → Plan → Execute → Report). Each phase appends its section
  (`scope`, `issues`, `classification`, `plan`, `execution`, `report`) and load-bearing fields — issue
  number, branch, worktree path — are read from the checkpoint as the single source of truth rather
  than re-derived from prose. Two files ship beside `SKILL.md`: `checkpoint.schema.json` (the documented
  contract) and `checkpoint.mjs` (a dependency-free validator that also cross-checks references — every
  classified/assigned/executed issue traces back to a fetched one, worktree presence matches group mode,
  and an executed branch must equal the branch the plan assigned, catching a hallucinated branch). A
  corrupt or drifted checkpoint exits non-zero and stops the run instead of drifting silently. Adds one
  optional config key `delegate.checkpointDir` (default `{{git.worktreesDir}}/.delegate`, gitignored
  run state). **Re-render to pick it up** — additive, no migration; a repo that never runs `/delegate`
  is unaffected.
- **Enhancement, content-only — opt-in approval gate before push in `delegate` runs (`orchestration`,
  #92).** A new optional config key `delegate.approveBeforePush` (default `false`) adds a human gate
  immediately before a delegated agent's branch leaves the machine. When on, each agent runs its
  pre-flight, commits **locally**, and STOPS before `git push` / `gh pr create`; the orchestrator
  assembles a compact per-agent summary (branch, target issue, diffstat, commit list), collects the
  human's decision via `AskUserQuestion` (Approve / Approve all / Reject), and only an explicit
  approval releases the push and opens the PR. A rejection leaves the worktree and local branch intact
  for inspection (never cleaned up) and is recorded in the run. The decision is part of the run's typed
  state: `checkpoint.schema.json` gains `approval` (`approved`/`rejected`) and `approvedBy` on each
  `execution` entry, and `checkpoint.mjs` enforces that a rejected push is `status: skipped` with a
  null PR — so a rejection can never masquerade as a merged PR — with tests covering both. The Report
  phase adds an "Approved by" column when the gate was active. **Re-render to pick it up** — additive,
  no migration, and **default-off leaves existing `/delegate` behavior unchanged**; a repo that never
  runs `/delegate` (or never enables the flag) is unaffected.
- **Enhancement, content-only — curated, capped run-memory doc for `delegate` runs (`orchestration`,
  #93).** The `/delegate` skill now keeps ONE small, durable memory doc per repo of forward-useful
  lessons (repo quirks, recurring failures, issue entanglements) that carry between runs. It is
  **curated and hard-capped**, never an append-only log: the Report phase distils this run's lessons in —
  pruning stale entries, never blind-appending — and the Classify/Plan phases read it back (each spawned
  agent gets only the entries whose **Area** matches its issue). Every entry carries a **Why**, a
  **Since** (the issue/PR that taught it — its staleness anchor), and an **Area**, so pruning is judged
  rather than FIFO. A dependency-free validator ships beside `SKILL.md` — `memory.mjs` — that enforces
  the byte cap **and** the entry format at the Report boundary: over cap or a malformed entry exits
  non-zero and blocks the run until curation brings it back within budget (a missing doc is valid — a
  fresh repo simply has none yet). Adds two optional config keys: `delegate.memoryFile` (default
  `{{delegate.checkpointDir}}/memory.md`, gitignored, per-clone like the checkpoints) and
  `delegate.memoryMaxBytes` (default `4096`). **Re-render to pick it up** — additive, no migration; a
  repo that never runs `/delegate` is unaffected.

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
