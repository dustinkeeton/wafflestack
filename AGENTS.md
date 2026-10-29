---
last-updated: 2026-10-28
---

# AGENTS.md — wafflestack

Canonical, harness-neutral agent/skill definitions grouped into stacks; the `wafflestack`
CLI renders them into harness-native files (`.claude/`, `.codex/`, `.agents/`) inside a
consuming project. Rendered files are generated output — edit source (`stacks/**`,
`schema/**`, `installer/**`), project config, or a project extension, never the rendered files.
Comments in deterministic files (JS/YAML/shell) are orientation, not spec — rules live in code
and behavior tests; agent-behavior rules live in skill/agent markdown, which is the program
(DECISIONS.md 2026-07-15, #388).

Entry points: `installer/cli.mjs` (bin `wafflestack`) · `toolkit.yaml` (stack registry) ·
`stacks/registry.yaml` (waffle registry) · `schema/FORMAT.md` (format reference).

## Repository layout

```
toolkit.yaml               registry: name + ordered stack list
stacks/registry.yaml       WAFFLE registry (#335): one entry per agent/skill/mod — name, kind, stack, path, status (stable|wip|deprecated|replaced), replacedBy
stacks/<name>/
  stack.yaml               manifest: recommended, recommendedPlugins, agents, skills, files, mods, optIn, requires, prerequisites, config, constraints, env, setup
  agents/<name>.md         neutral agent def (YAML frontmatter + body)
  skills/<name>/SKILL.md   neutral skill def (+ supporting files, copied along)
  files/<repo-rel-path>    neutral syrup payload (CI workflow/script/config), rendered verbatim to that path
  mods/<name>/             Claude Code mod (plugin dir: .claude-plugin/plugin.json + hooks), rendered as `.claude/settings.json` entries (marketplace + `enabledPlugins`) for the claude target only (#560, #594) — no files; engine-laid `tsconfig.json` + `.claude-plugin/types/` are skipped at load (#564)
  evals/<name>.eval.yaml   Layer 2 behavioral eval case (metered; inert to render/validate/lock)
installer/cli.mjs          bin entry: dispatches commands, global --cwd flag
installer/evals.mjs        eval runner entry (`npm run evals`, metered — NOT in npm test)
installer/lib/*.mjs        render pipeline + eval harness (ES modules)
installer/test/*.test.mjs  node:test suite
schema/FORMAT.md           format reference
schema/SETUP.md            agent install playbook
schema/AUTHORING-EXTERNAL-STACKS.md  third-party `source:` stack authoring guide
docs/                      design notes (gitignore.md, skills-vs-workflows.md, upgrades.md)
assets/                    brand assets + brand guide (assets/README.md)
```

## Stack registry

`toolkit.yaml` lists 9 stacks (14 agents + 41 skills). Per-stack config schema, env,
prerequisites, requires edges, and setup notes live in each `stack.yaml` (authoritative —
this table summarizes).

`stacks/registry.yaml` is the WAFFLE registry (#335): one entry per agent/skill/mod —
`{ name, kind: agent|skill|mod, stack, path, status: stable|wip|deprecated|replaced, replacedBy?, note? }`
(the `mod` kind landed in #560; its first live entry is `waffle-view`, #562).
All 54 are currently `stable`. It is ENFORCED, not advisory: `validateRegistry` reconciles it
against the filesystem AND every `stack.yaml`, so a rename/move/add cannot land without it (a
rename is a three-part edit: files, `stack.yaml`, tombstone + new entry). `wip` waffles are gated
out of every consumer-facing surface (`resolveRef` refuses, stack expansion skips,
`resolveAgentSkill` drops, the setup inventory omits); a `replaced` tombstone FORWARDS a stale
`include:` ref at render (warned) and `upgrade` rewrites it. Syrup (`files/`) and external
(`provenance`-bearing) stacks are out of registry scope; an absent registry file = ungated,
unenforced (a fork), a corrupt one = hard error.

| Stack | Path | Agents | Skills | Purpose |
|--------|------|--------|--------|---------|
| `docs-system` | `stacks/docs-system/` | docs-agent, docs-human | docs-agent, docs-human, prose, md-maximalist, accurate, diagram | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. Protected-docs guardrail (#612): `docs.protectedDocs` (list, `listFormat: code-bullets`, 10-path default, `stack.yaml:150`; overriding replaces the list; `[]` = no section) feeds the generated `docs.protectedDocsSection` (`omitWhenEmpty: docs.protectedDocs`, `stack.yaml:170`), placed in BOTH writers — agents `docs-agent`/`docs-human` and their `SKILL.md`s (docs-agent had no guardrail before; replaces retired `docs.voiceGuardrailSection`). Writing-craft skills (#224): `prose` + `md-maximalist` granted to docs-human, `accurate` to docs-agent — split is orthogonal by audience (#299): `accurate` is deliberately NOT granted to docs-human. All three user-invocable (`/prose`, `/md-maximalist`, `/accurate`). One `requires:` edge: `skills/prose` → `skills/md-maximalist`. `diagram` (#471) is a proxy skill granted to docs-human: ordered providers (archify → Mermaid floor), detection at invocation, never self-installs; archify is the first shipped `recommendedPlugins:` entry, scoped `items: [skills/diagram]`. |
| `github-workflow` | `stacks/github-workflow/` | (none) | git-workflow, issue, github-project-management, github-project-board, clean-up, label-hook, hygiene, release, pr-response | Git / GitHub issue / Projects v2 / release workflow. `github-project-management` recipe "Link an existing issue to a parent epic" (#633): resolve both node IDs, query the child's current parent, then `addSubIssue` with header `GraphQL-Features: sub_issues`; an issue has at most one parent, `replaceParent: true` re-parents in one call (`skills/github-project-management/SKILL.md:365-397`). Ships 14 `files/` payloads: `waffle-doctor.yml` (default render, read-only drift gate); 7 opt-in syrup workflows (`waffle-label-hook`, `waffle-hygiene`, `waffle-release-hook`, `waffle-post-merge-hook`, `waffle-evals`, `waffle-pr-green-hook`, `waffle-pr-response-hook` — each holds write permissions and/or spends API money, so enabling the stack never renders them; the four Claude-dispatch hooks `label-hook`/`hygiene`/`pr-green-hook`/`pr-response-hook` are `{ path, targets: [claude] }` entries (#190, `stack.yaml:13-23`) — pruned for a codex/agents-dir-only consumer by the #364 gate; doctor/release/post-merge/evals + the templates are unscoped); and 6 default-render inert templates (#337: `.github/ISSUE_TEMPLATE/{config,bug,feature,rough-idea}.yml`, `PULL_REQUEST_TEMPLATE.md`, `REVIEW_TEMPLATE.md` — a template must never auto-apply `labelHook.*` labels, pinned by `content.test.mjs`). 5 of the 7 opt-in workflows carry a `files/`-keyed `requires:` edge to a companion skill (label-hook→label-hook, hygiene→hygiene, release-hook→release, post-merge-hook→clean-up, pr-response-hook→pr-response; `stack.yaml:78`); `waffle-pr-green-hook.yml` and `waffle-evals.yml` have NO edge, so the #74 companion warning never fires for them. `pr-response` posts one append-only `<!-- waffle-pr-response -->` comment per round (#318); rubric v3 (Implement ≥11, #390; wording-only findings are nits, never Deferred, #682); the Implement/Decline cutoffs render from `prResponse.rubric.thresholds.{implement,decline}` (defaults 11/4, `range: 0–15`, stack `constraints:` `decline < implement`, #630 slice 1); per-dimension weights render from `prResponse.rubric.weights.{severity,reach,validity,effortRisk,alignment}` (default 1, `range: { min: 0 }`, `anyPositive` constraint, #644) — composite `15 × Σ(wᵢ·sᵢ) / Σ(wᵢ·3)` to one decimal, overrides on raw scores; per-run `--rubric <key>=<n>,…` token (#645: the seven leaf names, resolved in §1 before findings are read, validated merged-over-config with render's rules in a fixed 10-step order, whole-token fallback — attended asks, `--yes`/non-interactive falls back to config; footer `source: config | run override (--rubric …) over config | config (--rubric ignored)`, `skills/pr-response/SKILL.md:59-127`, `:596-601`); autopilot forwards it to its responders (#646). A `## Fix branch` block in the invocation overrides §1's `gh pr checkout` and §5 items 1 and 6 (#733, #754): work only in the named worktree on the named branch cut from the PR head, open the PR the block specifies, report its number; reply and `waffle/pr-response` status stay on the reviewed PR (`skills/pr-response/SKILL.md:341`). pr-green dedupes per green head via the `waffle/adversarial-review` commit status; pr-response-hook bounds its loop with `prResponse.responseLabel` applied BEFORE the paid dispatch (#338: no hook predicate reads a body). Target threading (#355): pr-green uploads a `waffle-pr-target` artifact (`{pr_number, head_sha, head_ref, head_repo}`, 7-day retention) before its harness — an unverified pointer, re-checked downstream (`waffle-pr-green-hook.yml:94-116`); pr-response-hook's `resolve` job (`actions: read` only) reads it via `gh run download <workflow_run.id>`, shape-validates (`jq -s`: exactly one JSON object, else skip), fails closed; a failed download logs gh's flattened stderr, `::warning::` only when it is not the expected no-artifact case (#624) (`waffle-pr-response-hook.yml:15-56`); its gate re-verifies via `pulls/{n}` (open, default-branch base, head still the reviewed SHA, same-repo head) under a per-PR concurrency group (`:61-63`, `:94-101`), and the branch checkout is re-verified against that SHA before install (#623, `:167-182`); re-render both hooks together — without the artifact every run skips (`stack.yaml:862-870`). `waffle-label-hook.yml` (#544): enrich takes the dispatched issue URL as delivery evidence (`:91`), read-only `gh` calls (`gh <noun> list|view`, `gh api` with no mutating method/body) classify SOFT in both jobs (`:111-112`, `:313-314`), and `Bash(gh label list:*)` is on the enrich allowlist (`:49`). `hygiene` task 1 is a docs drift backstop (#586; per-PR `pr-docs` is the main docs path, #572): skips while an open `chore/hygiene-docs-*` PR exists; diffs `origin/<default>` since the last run (`git rev-list -1 --first-parent --before=<window>`, `25 hours ago` for a daily cron); drops tests/fixtures, `CHANGELOG.md`, the `docs` skill's doc files and generated/lock output — nothing left → reports `no drift`, spawns no agents; else runs `docs` with the remaining paths as focus; merges the latest default branch before push (never rebase), a conflict aborts and reports `skipped`, the next run retries (`skills/hygiene/SKILL.md` task 1; setup note `stack.yaml:437`). Config: `issue.*`, `labelHook.*`, `hygiene.{cron,claudeArgs,autoMerge}`, `release.{tagFormat,versionFiles}`, `prGreen.*`, `prResponse.*` (incl. `prResponse.rubric.thresholds.*`, #630, and `prResponse.rubric.weights.*`, #644), `cleanUp.confirmGate`, `evals.{cron,maxCalls,model}`, `autoMerge.label`, `doctor.{toolkitRef,flags}` — `issue.confirmGate` / `prResponse.confirmGate` / `cleanUp.confirmGate` are the first behavioral keys a skill reads (#487: `default: true`, `modes: [true, false, prompt]`, `flag: { on: "--confirm", off: "--yes" }`, `nonInteractive: false`; the skills render `{{key}}` and `{{key.flag.*}}`); `hygiene.autoMerge` is the flag-less one (#488: `default: true`, `modes: [true, false]`, no `flag:`/`prompt` — the hygiene skill's step 6 branches on `{{hygiene.autoMerge}}`; `--execute` stays `clean_up.sh`'s switch behind `cleanUp.confirmGate`, no `cleanUp.execute` key) — label defaults moved to the `waffle:` namespace in #451 (`issue.inferenceLabel` = `waffle:needs-inference` `stack.yaml:1707`, `autoMerge.label` = `waffle:auto-merged` `stack.yaml:1942`; the `label` prerequisites and the rendered `rough-idea.yml` follow); `issue.reassessLabel` = `waffle:reassess` (#504, `stack.yaml:1727`) is a human-applied hold — the `label-hook` implement path declines a reassess-labeled issue with a comment, the `issue` skill never adds or removes it, and orchestration re-declares the key with the same default the way both stacks share `autoMerge.label` (`kind: label` prerequisite scoped to `issue` + `label-hook`; the one automated adder is `/waffle-report`, upstream at filing (#609), and nothing removes it — pinned by `content.test.mjs`'s mutator sweep, whose `ADDERS` allowlist exempts only the waffle-report skill (source + render) and its hold-labels eval from the add ban) — pin `doctor.toolkitRef` to a release tag BEFORE arming `--verify-render` in `doctor.flags` (#322). |
| `code-quality` | `stacks/code-quality/` | (none) | tdd, codebase-architecture, adversarial-review, qa, dry | Cross-cutting practice skills (#117; test command, tiers, module map are config). `adversarial-review` (#112): config-free hostile post-green PR review, auto-triggered by the pr-green hook (#180); `--integration` (#733) instead reviews an autopilot integration → `main` PR for decision preservation — inputs the run's merged PRs into `<integ>`, their linked issues, `DECISIONS.md` at the head, the combined diff; a finding must cite a `DECISIONS.md` heading or `#PR (closes #I)` plus a head `file:line`; no nit tier; always cold; replaces sections 2–4, sections 5–7 still apply (`adversarial-review/SKILL.md:48`). `qa` (#228): functional sibling — checks a green PR against the linked issue's intent, own `<!-- waffle-qa -->` marker, report-only, composed by autopilot's `autopilot.qaLoop`. Both skip seeding history from the PR on a deliberately cold spawn (autopilot's cold certification rounds and cap-escape evidence pass; `qa/SKILL.md:361`, `adversarial-review/SKILL.md:310`). `dry` (#116): de-duplication under rule-of-three guardrails. |
| `obsidian-dev` | `stacks/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development + desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `stacks/orchestration/` | project-manager, product-manager, task-planner | delegate, autopilot, audit, docs, standup, pr-docs | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config. `project-manager` responsibility 7 (#633): group related open issues under an `[epic]` parent (existing, or filed via `issue`), linking each child as a native sub-issue via the `github-project-management` recipe below; nothing is linked until the user confirms the epic, children, and any re-parenting (`agents/project-manager.md:26`, `:51`). Ships 2 `files/` payloads (#363): `.claude/workflows/audit-stage-{1,2}.js` — the `/audit` chain as staged Claude workflow scripts, both `optIn:` AND `targets: [claude]` (`stack.yaml:10-17`; the prose `audit` skill stays the everywhere fallback). `delegate` ships three dependency-free supporting files: `checkpoint.mjs` + `checkpoint.schema.json` (#105/#106, per-phase run checkpoint validator) and `memory.mjs` (#107, byte-capped curated run-memory gate). Config: `delegate.{defaultScope,extraPreflight,checkpointDir,approveBeforePush,autoMerge,batchMode,docsRefresh,memoryFile,memoryMaxBytes}` (`checkpointDir`/`memoryFile` defaults exercise depth-4 nested expansion; `approveBeforePush`/`autoMerge`/`batchMode` declare `modes: [true, false]` with no `flag:` — #488, declaration-only, render unchanged), `autopilot.{autoMerge,planDir,qaLoop,maxQaRounds,reviewLoop,maxReviewRounds,auditStep,holdLabel,integration,waffleCmd,integrationChecks}` (`integration`, #731, part of #720: `modes: [true, false]`, default `false`, `+integration`/`-integration`, a routing mode config may set — cuts a per-run `autopilot/integration/<UTC timestamp>` branch from `origin/main`, retargets every run PR to it, defers Step 9 close/Done, runs integration gate stage 1 (#747: merge `origin/main` into `autopilot/sync/<ts>` in a gate worktree, resolve only a lock conflict, land it via a sync PR into `<integ>` armed only with `+automerge`; any stop holds the final PR as integration-held with a `holdLabel` follow-up), ends with one integration → `main` PR `<F>`, and runs stage 2 on it (#733: rides review-loop consent, else `stage 2: not run (review loop off)`; up to `min(2, effective review cap)` cold rounds of `adversarial-review <F> --integration`, responder `respond-int-pr<F>` gets a `## Fix branch` block and lands fixes via an `autopilot/stage2/<ts>-r<k>` fix PR into `<integ>`, never a push; outcome passed / integration-held, and a cap reached with fixes still implemented holds; #754: the green wait ends on Step 8's blocked exits, a pass also needs a `waffle/adversarial-review` success status on `<sha>`, and the responder works in an orchestrator-cut `autopilot-stage2-<ts>` worktree, `-r<k>-retry` on a retry), then stage 3 (#734: with `+audit`, the audit gate moves off each run PR to `<F>`, runs once over `git diff origin/main...origin/<integ>` in its own worktree with `delegate.docsRefresh` off per PR, lands fixes via an `autopilot/stage3/<ts>` fix PR into `<integ>`, and an unresolved Critical/High holds `<F>` as integration-held), then arms `<F>` (#735: only with `+automerge`, only when every enabled stage passed or was not run because its consent is off, no stage-2/stage-3 fix PR merged into `<integ>` (they merged unreviewed), `<F>`'s head equals `origin/<integ>` and the head stage 1 passed on, no PR is open against `<integ>`, and, after a stage 2 pass, that head carries a `waffle/adversarial-review` success status; else not armed, for a human; waits by Step 8's blocked rule; after `MERGED`, Step 9 items 1–2 for every issue `<F>` closes, then deletes `<integ>` by a probe-verified `git push origin --delete` or reports it left open); `waffleCmd`, #747: CLI prefix, default `npx --yes {{waffle.toolkitRef}}` (#750: follows the value, through `waffle.toolkitRef` re-declared from the wafflestack stack with the same default); this repo sets `env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs`; `integrationChecks`, #748: `listFormat: code-bullets`, commands the gate runs on the synced head after the `skills/autopilot/overwrites.mjs` overwrite detector (exit 0 clean / 1 findings / 2 error; #752: it walks the remover's branch to the commit that dropped the line, and an ordinary commit whose parent holds the line and the adder's merge is a `NOTE:`, while a removal in a merge commit is a finding; `--pr` must be on `--head`'s first-parent history, any order; `--rebase --before/--after/--onto` checks Step 3's pre-gate rebase, and a finding marks the PR rebase-held: never armed, or the final PR is held in integration mode), each must exit 0 or the final PR is held; default `{{autopilot.waffleCmd}} doctor --allow-missing`, this repo adds `--verify-render` and the comment-gate test), `project.installCmd` (#747: re-declared from github-workflow, same default/pattern, run in the gate worktree before render) (`holdLabel` default `waffle:manual-review`, `autoMerge.label` default `waffle:auto-merged` — #451, `stack.yaml:863`/`:643`), `issue.reassessLabel` (default `waffle:reassess`, `stack.yaml:652` — #504: re-declared from github-workflow like `autoMerge.label`; delegate's Phase 1 list paths and autopilot's scope resolution exclude reassess-labeled issues and report the held-out count, an explicit `#N` stays actionable, and neither skill ever adds or removes the label), `prResponse.rubric.{thresholds.{implement,decline},weights.*}` + both `constraints:` (`stack.yaml:667`/`:967` — #646: re-declared from github-workflow so autopilot can validate a per-run `--rubric <spec>` merged over the rendered rubric before any work; malformed asks (attended) or stops (non-interactive), two different specs stop; forwarded verbatim as `pr-response <pr> --yes --rubric <spec>` on every Step 5/6 responder spawn incl. re-spawns/retries, never on a resume; per-run, never stored). `pr-docs` (#584, part of #572) refreshes docs on one open PR: merge latest base (never rebase) → `git diff --name-only origin/<base>...HEAD` → `docs` skill with those paths as focus (`docs` takes an optional focus argument) → commit + push onto the PR branch; no-op exit (no agents) when every path is tests / `CHANGELOG.md` / docs / generated output; ends with one `pr-docs: no-op|up to date|refreshed|stopped` line. `delegate.docsRefresh` (`modes: [true, false]`, default `true`, `stack.yaml:730`) gates the caller; a hand `/pr-docs` ignores it. Wiring (#585, delegate Phase 4 post-agent verification block): when on, the orchestrator runs `pr-docs <PR#>` per verified PR after verification and before arming, on every path (single-issue, serial, parallel, batch); spawned agents skip self-arming and report `not armed — pending docs refresh`; arming (`gh pr merge --auto --merge`) waits until the PR's remote head equals the post-`pr-docs` commit; a `stopped` result leaves the PR open-but-not-armed; skipped when autopilot's `/audit` step covers the PR — autopilot forces `delegate.docsRefresh` off for its delegate run when its audit step (§4) is on (`content.test.mjs` block `delegate and autopilot wire pr-docs before arming`). `autopilot` (#100/#143) composes delegate (batchMode + per-run autoMerge consent, never sticky) into a per-issue plan→implement→PR loop with three opt-in gates in fixed order: QA (#228), review loop (#220), diff-scoped `/audit` (#221); can't-converge files an `autopilot.holdLabel` follow-up. Hold-queue service level (#511): the Step 5/6 cap hatches (certification catch and errored-twice fallback included) file only should-fix and blocker findings; a nit-only fresh pass files nothing and lists its nits in the run report as reported-not-filed (outcome `cap-reached with nits reported, not filed`); the Step 7 audit gate still files every unresolved Critical/High; every run report closes with the open `holdLabel` queue (number, title, age) or `hold queue: empty`; no cadence/cron is wired (the hygiene cron is a paid dispatch). Loop convergence (#510): only a cold round (round 1, or a fresh unnamed certification reviewer after an anchored round implements 0; the responder stays persistent) that implements 0 ends a QA/review loop; every round, certification included, counts toward the cap; bound = cap+1 reviewer passes and at most cap `pr-response` passes per loop, 10 gate passes per PR per run at the default caps (`skills/autopilot/SKILL.md` Guardrails). Caps are per-run, not per-PR, and never bound a manual `/pr-response` (#357). `requires:` edges: delegate→git-workflow+github-project-management+github-project-board, docs→docs-agent+docs-human, autopilot→delegate+clean-up+git-workflow+github-project-management+qa+adversarial-review+pr-response+audit+issue, audit→docs, pr-docs→docs+git-workflow, `files/…/audit-stage-1.js`→audit, `files/…/audit-stage-2.js`→audit+docs (`stack.yaml:19-46`). Prerequisites (`stack.yaml:53-111`): `require` tool probes node/git/gh; `recommend` gh-auth scope, the three labels above, and two `setting` checks scoped to delegate+autopilot — `allow-auto-merge` (1 of 3) and `required-status-check` (#205: 2 and 3 of 3 — a required check on the default branch via branch protection or a ruleset, which on GitHub Free exists only for public repos; otherwise `gh pr merge --auto` leaves the PR open-but-not-armed), plus `integration-required-status-check` scoped to autopilot (#731: a ruleset requiring checks on `autopilot/integration/**`). Guardrails: never push main, never `--admin`-merge, merge commits not squash. |
| `engineering-team` | `stacks/engineering-team/` | lead-engineer, data-engineer, qa-engineer, devops-engineer, ux-designer, security-engineer | webapp-security-audit | Product-eng roster (browser-app security variant); lead-engineer is the general architect. Slots into `orchestration`'s roster. |
| `expo-dev` | `stacks/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development; mobile-architect is the domain architect. |
| `harness-architect` | `stacks/harness-architect/` | harness-architect | (none) | Single domain agent — expert in agent harness design. One optional config key (`project.longName`). This repo appends a project extension grounding it in the toolkit's own paradigms. |
| `wafflestack` | `stacks/wafflestack/` | (none) | waffle-init, waffle-setup, waffle-install, waffle-render, waffle-upgrade, waffle-doctor, waffle-eject, waffle-validate, waffle-report, waffle-toggle; mod: waffle-view | Self-referential stack (#70): one user-invocable `/waffle-*` skill per CLI subcommand, each shelling out to `npx <waffle.toolkitRef> <sub>`. `/waffle-report` (#473) wraps `report` and files a toolkit bug UPSTREAM (target resolved from `waffle.toolkitRef`; `bug`/`feature`/`rough-idea` forms picked by structure, never wording (#674): a `bug:`/`feature:` prefix wins outright, else an `Expected:` or `Actual:` line → `bug.yml`, a `Proposed Solution:` line or heading → `feature.yml`, anything else → `rough-idea.yml` with the user's words verbatim (#642); no form invents a field the user did not give; redaction covers each line of pasted command output and the bare `owner/repo` of a remote; the reply never echoes a redacted value (category only); pinned by `content.test.mjs` #642 and #674 tests; post-redaction gate; no-auth URL fallback). Each filing requests the form label (set by `gh issue create --label`) plus two literal upstream labels, `waffle:reassess` (the hold) and `waffle:consumer-report` (provenance, #609), each added in its own tolerant `gh issue edit --add-label … || echo "warn: …"` call, then read back via `gh issue view --json labels`; the adds need triage/write access on the toolkit repo, so for most filers they fail with a warning, never a failed filing, and the client-side hold is best-effort; the URL fallback requests both via `labels=`, which GitHub drops without triage rights; a consumer's `issue.reassessLabel` does not apply (`skills/waffle-report/SKILL.md:101-112`, `:236-293`). On the toolkit tracker both fixed labels are ALSO applied server-side (#640): the project-owned `.github/workflows/consumer-report-hold.yml` (not lock-managed, no stack renders it) fires on `issues: opened`, gates its one job on `contains(github.event.issue.body, REPORT_SUMMARY)` (`installer/lib/report.mjs` export, line 2 of the `<details>` block) AND an `author_association` not in `OWNER`/`MEMBER`/`COLLABORATOR` (#653: maintainer-filed issues are never held; body and `author_association` read only in the `if:`), and runs two `gh issue edit` steps (hold first, so a renamed provenance label cannot block it) with `issues: write` only, no `uses:`, body never in `run:`/`env:` — all pinned by `report.test.mjs`. `waffle:consumer-report` is never a consumer prerequisite (doctor must not check it; pinned by `content.test.mjs`). Ships six eval cases under `stacks/wafflestack/evals/`: `waffle-report-files-with-hold-labels`, `waffle-report-redacts-overlay`, `waffle-report-routes-feature-prefix-over-fields`, `waffle-report-routes-filled-sections-to-bug`, `waffle-report-routes-proposed-solution-to-feature`, `waffle-report-routes-rough-idea`. `/waffle-toggle` (#476) wraps `toggle` — the per-skill `disable-model-invocation` override — and always drives it by `--disable`/`--enable` flags (the picker needs a TTY). Three optional config keys: `waffle.toolkitRef` (default `github:dustinkeeton/wafflestack#v{{harness.toolkitVersion}}` — the release that rendered, #469), `waffle.reportConfirmGate` (#487: `default: true`, `modes: [true, false, prompt]`, `flag: { off: "--yes" }`, `nonInteractive: fail` — the one gate with no non-interactive skip), and `waffleView.editor` (#616: `default: cursor`; a launcher string or an argv array; read only by the mod, by its literal in `state.ts`). Ships the first built-in mod, `mods/waffle-view` (#562, part of #552): a Claude Code plugin dir (`.claude-plugin/plugin.json`, `hooks/hooks.json` → `hooks/register.tsx`, `hooks/state.ts`, `types/index.d.ts`, `hooks/waffle-view.test.ts`) that registers `/waffle-view` on `session.start`, opens a `Pane` (`$.ui.open`), and draws the `state --json` document — project, keys (value/source/tokens, `value !== canonical` marked), delegate run files, locks, drift — reading ONLY through `$.process.run` of `wafflestack state --json` (no `--offline` since #608, so the cached newer-release check runs; `WAFFLESTACK_OFFLINE=1` still forces it; `installer/cli.mjs` at the cwd → `node_modules/.bin/wafflestack` → `npx --yes github:dustinkeeton/wafflestack`; `resolveArgv` in `state.ts`). Refreshes after `/waffle-view`, every other `command.run`, `prompt.submit` and the main loop's `turn.complete` while the pane is open; a subagent's `turn.complete` (has `agentId`) updates the `wave` atom instead, and `agent.spawn` (#699) only observes (`register.tsx:155-177`); `$.state` atoms `doc`/`error`/`isRefreshing`/`wave`. A newer release (`doc.update.available`, #608) adds a Syrup `· vX.Y.Z available` badge to the headline and the remedy command dim beneath it (`updateBadge` in `state.ts`; `update` is optional in the types — an older CLI omits it). An `Open in <editor>` `Button` (#616, key `open-editor`) closes both views once a `state --json` read has succeeded (#696: none before the first read or after a failed first read; a later failed refresh keeps it): `editorArgv(doc, cwd)` reads `doc.config['waffleView.editor']` (string → one executable, never split; non-empty string array → argv; a missing or malformed key → `cursor`) and appends `$.session.cwd()`, `editorLabel` names the editor, and the press runs `$.process.run` (15 s timeout; a rejection at the timeout reads as still running, not as a start failure); `openEditor` does nothing with no document and never throws (a pre-launch failure also lands in `launchError`); a rejection or non-zero exit lands inline as `open in editor failed: …` via the `launchError` atom (`editorLaunchError`), which a refresh leaves and a good launch clears. Context slicing (#563): a `skill` atom holds the name the person's last prompt invoked (`prompt.submit` text `/name …`, or `command.run`'s `command`; peer/task/scheduled origins never move it; `/waffle-view` itself leaves it alone), and `selectSlice(doc, { skill })` in `state.ts` narrows the pane to `doc.skills[skill]` — its behavioral keys, the other config it reads (from `doc.config`, values line-capped), the run files it writes (delegate facts when among them) — hiding project/locks/drift; a plain prompt, or a name `doc.skills` does not know, restores the full view. The `/standup` slice (#610) adds `Agents (n)` — `selectAgents(doc, slice)` in `state.ts` (`STANDUP_SKILL`) returns `doc.agents` in roster order — in place of the empty keys list (a `/standup` that reads keys keeps both); each row leads with a live marker (#699, `waveMarker`): `○` pending (dim), `◐` running (Syrup), `●` done (success), `✗` failed (error) — the `wave` atom (`EMPTY_WAVE`, `waveReset`, `waveSpawned`, `waveClosed`, `waveCompleted` in `state.ts:276-302`) counts only top-level `agent.spawn`s (no `parentAgentId`) while the `skill` atom is `/standup` and the main loop's `turn.complete` has not yet closed the wave (later spawns stay out; subagent completions still land); a `/standup` typed over a running turn (`prompt.submit` `turnId` set — the engine queues it) resets the wave as `queued`, which ignores spawns until the next main-loop `turn.complete` re-empties and arms it instead of closing it (a `command.run` reset keeps `queued`), done means `reason === 'answer'` and anything else failed, and the next typed `/standup` resets it while a peer's does not; an empty roster reads dim `no installed agents to round up`, a CLI without `agents` reads dim `this CLI predates the agent roster — upgrade wafflestack`. Above the roster `/standup` (#698) draws `Current focus` — milestones (`formatDue`), epics (`formatProgress`: `n of m`), In Progress and In Review, each capped at `FOCUS_MAX_ROWS` (8) then `… N more` — from `selectBoard(doc, slice)`; `--board` is appended (`resolveArgv`) only when `wantsBoard` sees the `skill` atom is `/standup`, and a CLI that rejects it (`boardFlagRejected`: non-zero exit, stderr naming `--board`) is re-run once without it; an absent or errored board reads dim `board unavailable`, and `boardHint` replaces the two item lists with a dim reason (unset `project.name`, failed lookup, no board of that title). Delivered through the root `.claude-plugin/marketplace.json` (#593), not as files (#594): on the claude target `render` merges `extraKnownMarketplaces.wafflestack` (`source: github`, `repo: dustinkeeton/wafflestack`, `ref` = the `#fragment` of `waffle.toolkitRef`, omitted when unpinned — #595; plus `autoUpdate: true` beside `source` — #730) and `enabledPlugins["waffle-view@wafflestack"]: true` into `.claude/settings.json`; Claude Code offers the install on the next trusted session, fallback `/plugin install waffle-view@wafflestack`. `claude plugin validate` runs over its source dir and the marketplace in `npm run validate` when the CLI is present (#564), `claude plugin test` is the mod's own gate (`hooks/waffle-view.test.ts`; #610: `selectAgents` units, `/standup` → `/issue` → plain-prompt mount, empty-roster and older-CLI dim fallbacks; #698: `boardFlagRejected`, `boardHint`, `selectBoard`, `formatDue`/`formatProgress`/`itemRef` units, `--board` argv per slice; #699: `waveReset`/`waveSpawned`/`waveClosed`/`waveCompleted`/`waveMarker` units, live markers through a wave and its reset by `command.run` and by a typed prompt, pre-`/standup`, nested, denied and post-close spawns and peer `/standup` ignored, a `/standup` queued over a running turn ignores that turn's spawns and arms when it ends, a `/standup` turn that ends before spawning closes the wave; #696: a failed first read shows no button, a later good read shows `Open in VS Code`, a failed refresh keeps it, nothing launches before a read). Caveats: the pane follows the person's last typed `/name` (prompt text or `command.run`), not a Skill-tool call the model makes mid-turn; a `/name` that is not a toolkit skill (`/clear`, a project-local skill) reads as the full view; `config` values in `state --json` include the gitignored local overlay; wave status is keyed by `subagentType`, so two spawns of one agent share a row (last write wins); a model's Skill-tool `/standup` never arms the wave. Enabled in this repo's own render. |

Architect seniority rule (#38): `lead-engineer` is the general architect; `plugin-architect`
and `mobile-architect` take seniority in their domains. The output-conflict guard
(`render.mjs:316`) errors if two enabled stacks emit the same path.

## Installer module registry

`installer/lib/*.mjs`, ES modules.

| Module | Purpose | Exports |
|--------|---------|---------|
| `render.mjs` | Render pipeline: sources → selection → outputs → prune → lock. Dual render on overlay (#317) | `renderProject`, `MOD_REF_KEY`, `renderItemInMemory`, `readLock`, `readLocalLock`, `readTreeLock`, `configGuardProblems`, `failingConfigFor`, `collectUsedKeys` (re-export of `config-catalog.mjs`), `missingConfigFor`, `summarizeConfigKeys` |
| `refs.mjs` | Ref grammar, resolution, dependency closure, render selection, target-scope gate (#364) | `itemOutputMatcher`, `legacyModDir`, `normalizeItemRef`, `itemsOfKind`, `findItems`, `selectingStack`, `parseRef`, `isWipWaffle`, `resolveRef`, `resolveDepStrict`, `resolveAgentSkill`, `closureFor`, `closureDeps`, `fileMatchesTargets`, `isTargetScoped`, `includeRefMatches`, `includeEjectOverlaps`, `formatEjectOverlap`, `computeSelection`, `skippedSyrupCompanions`, `unpouredRequiredSyrup`, `disabledStackRequires` |
| `template.mjs` | `{{placeholder}}` substitution + `pattern:`/`entryPatterns:`/`modes:`/`range:` guard machinery + stack `constraints:` (#630, #644) | `substitute`, `PROMPT_MODE`, `FLAG_SIDES`, `parseFlagPlaceholder`, `flagPlaceholders`, `undeclaredFlagProblem`, `isModeScalar`, `modeMatches`, `modeProblems`, `makeGuard`, `entryPatternProblems`, `toRangeNumber`, `rangeProblem`, `CONSTRAINT_KINDS`, `constraintViolation`, `constraintProblems`, `LIST_FORMATS`, `formatValue`, `placeholderKeys`, `compilePattern` |
| `toolkit.mjs` | Load `toolkit.yaml` + stack manifests; hard LOAD errors for `targets:` malformations (#364) | `MOD_MANIFEST`, `MOD_TARGETS`, `MOD_ENGINE_LAID`, `isEngineLaid`, `loadToolkit`, `loadToolkitWithSources`, `missingRequiredKeys` |
| `project.mjs` | Consuming-project config + overlay, targets, `harness.*` built-ins/guards, `.gitignore` + YAML splice helpers | `CONFIG_FILE`, `LOCAL_CONFIG_FILE`, `LOCK_FILE`, `LOCAL_LOCK_FILE`, `AVATARS_DIR`, `BASELINE_GITIGNORE_ENTRIES`, `EXTENSIONS_DIR`, `LEGACY_ROOT_CONFIG_FILE`, `LEGACY_ROOT_LOCAL_CONFIG_FILE`, `LEGACY_ROOT_LOCK_FILE`, `LEGACY_CONFIG_FILE`, `LEGACY_LOCAL_CONFIG_FILE`, `LEGACY_LOCK_FILE`, `LEGACY_EXTENSIONS_DIR`, `VALID_TARGETS`, `resolveConfigFile`, `resolveLocalConfigFile`, `resolveLockFile`, `localLockPath`, `migrateLegacyDotfiles`, `staleGitignoreEntries`, `gitignoreMentions`, `GITIGNORE_MARKER`, `ensureGitignoreEntries`, `removeGitignoreEntries`, `recommendedGitignoreEntries`, `renameLegacyStacksKey`, `dropIncludeEntries`, `setScalarIn`, `appendSeqIn`, `removeSeqIn`, `renameKeyIn`, `loadProjectConfig`, `classifyStackSource`, `normalizeStackEntries`, `HARNESS_BUILTINS`, `HARNESS_PATTERNS`, `makeResolver`, `isEmptyValue`, `omitWhenEmptyCycle`, `RETIRED_CONFIG_KEYS`, `retiredConfigProblems` |
| `util.mjs` | sha256, YAML, deep-merge, dotted lookup, frontmatter, fs, semver, `resolveInside` containment guard | `sha256`, `isBinary`, `readYaml`, `exists`, `writeFileEnsuringDir`, `deepMerge`, `parseVersion`, `compareVersions`, `lookupPath`, `FRONTMATTER_RE`, `parseFrontmatter`, `stringifyFrontmatter`, `resolveInside` |
| `doctor.mjs` | Drift check vs `readTreeLock`; generated `.waffle/` docs presence-optional (#528); `--verify-render` temp-dir reproduction (#314); prerequisite checks (#129); `update` verdict param → informational newer-release note, never flips `ok` (#608, `doctor.mjs:111-117`); `pluginsDir` param → informational stale-installed-mod notes + `staleMods` (#730, null skips) | `doctor`, `verifyRenderAgainstLock` |
| `eject.mjs` | `eject` / `installRefs` / `setup`+`init` scaffold | `eject`, `installRefs`, `unejectCollisions`, `init`, `scaffoldConfig` |
| `validate.mjs` | Toolkit-developer lint (consumers never run it over built-ins; render imports only `validateExternalStacks`) | `RESERVED_AGENT_KEYS`, `validateToolkit`, `validateModPlugins`, `formatModPluginChecks`, `validateRegistry`, `validateSourceBytes`, `validateHarnessBuiltins`, `validateExternalStacks`, `validateStack`, `behavioralKeyProblems`, `listKeyProblems`, `rangeKeyProblems`, `stackConstraintProblems` |
| `setup.mjs` | `setup` output: SETUP.md playbook + inventory (+ update-mode section) | `setupGuide`, `toolkitInventory` |
| `model-invocation.mjs` | Per-skill model-invocation override (#476): `skills.modelInvocation` normalization (throws on shape errors, like invalid `targets:`) + the pure `disable-model-invocation` frontmatter patch render applies to the `claude` copy | `MODEL_INVOCATION_KEY`, `CONFIG_PATH`, `emptyOverride`, `normalizeModelInvocation`, `overrideFor`, `frontmatterDisablesModelInvocation`, `sourceDisablesModelInvocation`, `applyModelInvocation` |
| `harness-tools.mjs` | Per-target roster of call-shaped harness tools (#445): `HARNESS_TOOLS` data (`claude` declared; `codex` / `agents-dir` `null` = unverified) + the pure `toolCalls` / `unknownToolCalls` extractor `content.test.mjs` sweeps every source and render with. THE place a harness tool rename or removal is recorded | `HARNESS_TOOLS`, `DEAD_HARNESS_TOOLS`, `toolsForTarget`, `anyTargetTools`, `toolCalls`, `unknownToolCalls` |
| `toggle.mjs` | `toggle` command (#476): per-rendered-skill state model (COMMITTED config, tree lock), plain table, keypress picker over `list.mjs`'s shared loop, comment-preserving minimal write to `waffle.yaml` | `computeToggleModel`, `formatToggleTable`, `toggleChoices`, `interactiveToggle`, `applyToggle` |
| `report.mjs` | `report` bundle (#473): canonical lock + config KEY paths + `doctor({ canonical: true })` summary, then `scrub`/`redact` (cwd → `<repo>`, home → `~`, emails/remotes → placeholders); `formatReportMarkdown` renders the `<details>` block (`--json` is `JSON.stringify` of the bundle in `cli.mjs:155`, no renderer export); `health` does not surface doctor's `absentDocs` (#528) — only `notes` carries them | `collectReport`, `keyPaths`, `scrub`, `redact`, `formatReportMarkdown`, `REPORT_SUMMARY` |
| `state.mjs` | `state` document (#561): every `modes:`/`flag:` key with effective value, source layer (`local-overlay`/`waffle.yaml`/`stack-default`) and tokens; delegate run files (newest checkpoint's last PRESENT phase, memory bytes vs cap); committed vs local lock; plain-`doctor` drift via `readTreeLock` (#317). The overlay is opened ONLY to attribute a layer; `resolveSkills` → the `skills` map (#563, `state.mjs:225`); `collectState`'s `update` param → the `update` block (null → `NO_UPDATE_VERDICT`, `state.mjs:186`) and a ` · vX.Y.Z available` suffix on the text `cli:` line (#608, `state.mjs:521-523`); `agentRoster` → the `agents` array, the `/standup` roster (#610, `state.mjs:260`), and the text line before `cli:` — `agents: N in <dir> — a, b, …` or `agents: none installed` (`state.mjs:517-520`) | `STATE_SHAPE_VERSION`, `LAYERS`, `CHECKPOINT_PHASES`, `SKILL_RUN_FILE_KEYS`, `collectState`, `resolveConfig`, `resolveSkills`, `agentRoster`, `resolveBehavioralKeys`, `firstSentence`, `layerOf` (both re-exports of `config-catalog.mjs`), `expandKey`, `formatStateText` |
| `config-catalog.mjs` | Leaf config-key catalog (#701, moved out of `config`/`state`/`render` in #703 to break the cycle): `collectUsedKeys` (placeholder keys a selection's sources reference), `configCatalog`, `mergeCatalog`, `layerOf`, `firstSentence`, plus the `summaryOf`/`specFacts` formatters `config` and the reference file share — re-exported from their old modules, so every old import path still works | `firstSentence`, `layerOf`, `collectUsedKeys`, `configCatalog`, `mergeCatalog`, `SUMMARY_MAX`, `summaryOf`, `specFacts` |
| `config-reference.mjs` | `.waffle/waffle.reference.yaml` (#703): `configReferenceYaml(merged)` reads declarations only. Layout: `## ` lines are notes, `# ` lines are YAML (strip one `# ` → valid config). Header, then `## Must set` (required with no default, never shown as values), `## Locked` (`lockMode:` keys), then the commented `# config:` tree. Multi-line, over-110-char, `null`/no-default, conflicting and leaf-and-prefix keys become comment-only leaves pointing at `wafflestack config <key>`. `generateConfigReference` runs the catalog with `values: {}`. `harness.*` is excluded (a one-line FORMAT.md pointer) | `CONFIG_REFERENCE`, `configReferenceYaml`, `generateConfigReference` |
| `config.mjs` | `config [key-prefix]` lookup (#701): `configCatalog` — the per-stack, render-scoped (#77) key catalog `setup`'s "Config values" section ALSO prints (one function, no drift) — with value, `set` and source file (`default`/`waffle.yaml`/`waffle.local.yaml`, via `layerOf`) — both defined in `config-catalog.mjs` and re-exported here; `mergeCatalog` folds multi-stack keys and flags declarations that disagree on anything but `description`; `collectConfig` loads like `state` (`loadToolkitWithSources`, tree lock); `queryConfig` = all / exact key / dotted prefix / error with a nearest-match hint; plain-text `formatConfig` | `configCatalog`, `mergeCatalog`, `collectConfig`, `nearestKey`, `queryConfig`, `formatConfig` |
| `migrations.mjs` | Ordered, idempotent, version-keyed migration steps | `MIGRATIONS`, `EXTENSIONLESS_FILES_0_18`, `protectedPathsFromProse`, `migrationCeiling`, `applicableMigrations`, `runMigrations` |
| `registry.mjs` | WAFFLE registry loader + the wip/replaced status gate (#335) | `REGISTRY_FILE`, `WAFFLE_KINDS`, `WAFFLE_STATUSES`, `LIVE_STATUSES`, `REGISTRY_ENTRY_KEYS`, `refKindOf`, `waffleKindOf`, `canonicalWafflePath`, `loadRegistry`, `waffleStatus`, `isWaffleWip`, `replacementFor` |
| `upgrade.mjs` | Version diff, changelog delta, migrations, pin reconcile (#372), render + doctor; `pluginsDir` param → threaded to doctor's stale-mod note (#730, null skips) | `upgrade`, `reconcileToolkitRefPins`, `staleTagMentions`, `forwardRenamedWaffleRefs`, `diffSources`, `diffToolkit`, `changelogBetween` |
| `uninstall.mjs` | `uninstall` / `reinstall` + the pure `planUninstall` they share (#182) | `planUninstall`, `uninstall`, `reinstall` |
| `waffledocs.mjs` | Generated `.waffle/` overview docs + avatars + the config reference, via render's `emit()` | `GENERATED_DOCS` (incl. `CONFIG_REFERENCE`), `isGeneratedDoc`, `extractBaseEmail`, `deriveAgentEmail`, `withIdentity`, `generateWaffleDocs`, `collectAgentAvatars`, `agentFlavor`, `agentAvatarSvg` |
| `avatars-sync.mjs` | Owner-side Gravatar pipeline behind `avatars sync`/`status` (#285) | `GRAVATAR_BASE`, `TOKEN_ENV`, `emailHash`, `syncAvatars`, `avatarsExitCode`, `enumerateAgentAvatars`, `makeGravatarHttp`, `RASTERIZERS`, `makeShellRasterizer`, `runAvatarsSync` |
| `evals.mjs` | Layer 2 eval harness (#109; runner entry `installer/evals.mjs`) | `DEFAULT_MODEL`, `DEFAULT_MAX_OUTPUT_TOKENS`, `Budget`, `BudgetExceededError`, `discoverCases`, `loadCase`, `validateCase`, `renderTargetPrompt`, `evaluateAssertion`, `parseVerdict`, `runCase`, `runEvals`, `anthropicClient`, `mockClient` |
| `list.mjs` | `list` command: per-item state model + table + interactive picker (#119); exports the keypress loop `toggle` reuses (#476) | `STATUS`, `REMOVAL_REASON`, `computeListModel`, `unmanagedOutputs`, `describeBlockers`, `ANSI`, `formatListTable`, `selectableChoices`, `interactiveSelect`, `keypressMultiSelect` |
| `prerequisites.mjs` | Typed external prerequisites: normalize, scope, probe, bucket (#47/#129) | `PREREQ_KINDS`, `PREREQ_LEVELS`, `RENDER_PROBE_KINDS`, `normalizePrerequisites`, `runCheck`, `findOnPath`, `claudeCli`, `applicablePrerequisites`, `describeProvenance`, `checksDigest`, `looksLikeBranchRef`, `externalCheckGates`, `unacknowledgedStacks`, `formatCheckGate`, `evaluatePrerequisites`, `formatPrereq` |
| `plugins.mjs` | Recommended EXTERNAL harness plugins a stack offers via `setup` (#199); never installed | `PLUGIN_ENTRY_KEYS`, `normalizeRecommendedPlugins`, `offerablePlugins` |
| `settings.mjs` | Lock-managed entries inside `.claude/settings.json` (#594): pointer keys, merge/prune, drift, mod release | `SETTINGS_FILE`, `settingsKey`, `parseSettingsKey`, `marketplaceKey`, `pluginKey`, `ownsModKey`, `enabledPluginIds`, `lockKeys`, `modSettingsEntries`, `settingsValueAt`, `settingsConflicts`, `applySettings`, `removeSettingsEntries`, `settingsDrift`, `modReleaseKeys`, `settingsLockMap` |
| `installed-mods.mjs` | Stale installed mods (#730): enabled mods whose Claude Code `installed_plugins.json` record (user scope, or project/local for this cwd) is older than the toolkit's mod `plugin.json` `version`; every read failure is silence | `defaultPluginsDir`, `readInstalledPlugins`, `staleMods`, `formatStaleMod` |
| `marketplace.mjs` | The repo-root `.claude-plugin/marketplace.json` that lists every stack mod's SOURCE dir (#593); validate keeps it in sync | `MARKETPLACE_FILE`, `marketplaceSource`, `marketplacePluginId`, `readMarketplace`, `validateMarketplace` |
| `sources.mjs` | External `source:` resolution: local path or pinned-git cache (#88/#125) | `resolveSource`, `resolveSourceRoot`, `gitFetchCheckout`, `gitHeadCommit`, `gitRemoteOriginUrl`, `gitResolveRefCommit`, `checkoutMatches`, `defaultSourceCacheDir` |
| `toolkit-ref.mjs` | Toolkit self-identification (#373), lock `toolkit` block (#374), write-side pin (#372) | `resolveToolkitIdentity`, `commitFromNpmLockfile`, `shaFromResolved`, `parseLsRemoteTags`, `latestReleaseTag`, `toolkitRef`, `toolkitSource`, `toolkitLockEntry`, `toolkitPinFromLock`, `toolkitPinFromIdentity`, `classifyToolkitRefValue`, `describeToolkitProvenance`, `repoSlug`, `lockRepoSlug`, `parseRepoSlug`, `httpsUrl`, `gitLsRemoteTags` (optional `{ timeoutMs }`, default 15 s), `newerRelease` (#608: the one `{tag, command}` newer-than-running verdict `upgrade`/`doctor`/`state` share; remedy `npx --yes github:<repo>#<tag> upgrade`, `command: null` with no repo), `gitCapture`, `changelogHasUnreleasedEntries`, `changelogLatestRelease`, `formatUnreleasedRefusal`, `formatProvenanceWarning` |
| `update-check.mjs` | Newer-release check behind `doctor`/`state` (#608): a checkout answers from its local tags, else its CHANGELOG (`source` `local-tags`/`changelog`, from `ToolkitIdentity.latestTagSource`, #694); an install reads a fresh `$XDG_CACHE_HOME/wafflestack/latest-release.json` entry (keyed by repo; 24 h TTL, 1 h for a negative entry), else one 2 s `git ls-remote` that writes it, else the identity's CHANGELOG value. `--offline` reads the cache, never asks or writes. Never throws — failure is "no verdict" | `UPDATE_CHECK_TIMEOUT_MS`, `UPDATE_CACHE_TTL_MS`, `UPDATE_FAIL_TTL_MS`, `defaultUpdateCacheFile`, `readUpdateCache`, `writeUpdateCache`, `resolveLatestRelease`, `updateVerdict`, `NO_UPDATE_VERDICT` |
| `board.mjs` | `state --board` team-focus read (#697, part of #610): up to three `gh api graphql` calls run in the repo dir (`{owner}`/`{repo}` resolved by gh) — (1) open milestones (soonest due first); (2) open epics with native sub-issue progress (an epic is an open issue with sub-issues — parents come from the newest 100 open issues, since search has no sub-issue qualifier — or an `[epic]` title); (3) only when `project.name` is set, the owner's Projects v2 board matched to it case-insensitively, with its In Progress / In Review items. Call 3 is separate because `projectsV2` needs gh's opt-in `project` scope: its failure sets `projectError` and keeps milestones and epics. 5 s per call, 8 s for the whole read; 60 s cache in `board.json` beside `latest-release.json`, keyed by repo dir + project name, failures cached too. Offline → `error: 'offline'`, no read. Never throws; the gh runner is injectable | `BOARD_CALL_TIMEOUT_MS`, `BOARD_BUDGET_MS`, `BOARD_CACHE_TTL_MS`, `BOARD_STATUSES`, `BOARD_ERRORS`, `defaultBoardCacheFile`, `ghRun`, `emptyBoard`, `readBoard`, `describeGhError` |

Import graph (real `import` statements only; `util.mjs` and `template.mjs` depend only on `yaml`):

```
cli.mjs      → render, doctor, eject, validate, setup, report, state, config, upgrade, uninstall, toolkit,
               prerequisites, list, toggle, toolkit-ref, update-check, board, project, installed-mods, avatars-sync (dynamic)
render.mjs   → template, toolkit-ref, toolkit, sources, refs, validate, prerequisites, waffledocs, config-catalog, model-invocation, marketplace, settings, project, util
doctor.mjs   → render, project, toolkit-ref, toolkit, refs, prerequisites, sources, waffledocs, settings, installed-mods, util
installed-mods.mjs → marketplace, toolkit, settings, util
report.mjs   → render, doctor, prerequisites, project, util
state.mjs    → toolkit, sources, refs, render, doctor, template, settings, project, util, config-catalog, update-check (NO_UPDATE_VERDICT)
config.mjs   → toolkit, sources, refs, render, settings, project, util, config-catalog, state (expandKey)
config-catalog.mjs → project, template, util
upgrade.mjs  → render, doctor, migrations, project, toolkit-ref, registry, refs, util
uninstall.mjs → render, eject, toolkit, settings, project, util
eject.mjs    → render, toolkit, sources, refs, settings, project, util
validate.mjs → toolkit, template, refs, prerequisites, plugins, marketplace, project, registry
setup.mjs    → toolkit, render, config, project, refs, prerequisites, plugins, registry, marketplace, settings, util
list.mjs     → toolkit, render, refs, settings, project, util
toggle.mjs   → toolkit, sources, refs, render, settings, project, list, model-invocation
model-invocation.mjs → util
harness-tools.mjs → (nothing; test-only consumer: content.test.mjs)
waffledocs.mjs → template, project, refs, util, config-reference
config-reference.mjs → config-catalog
avatars-sync.mjs → toolkit, project, refs, waffledocs
evals.mjs    → render, template, util
migrations.mjs → project, refs, util
board.mjs    → update-check (defaultUpdateCacheFile)
toolkit.mjs  → refs, sources, prerequisites, plugins, registry, project (VALID_TARGETS only), template (flagPlaceholders only), util
prerequisites.mjs → refs
plugins.mjs  → refs
marketplace.mjs → toolkit
refs.mjs     → project (VALID_TARGETS only), registry (the wip/replaced gate; registry.mjs imports only util.mjs — no cycle), settings (ownsModKey; settings.mjs imports only util.mjs)
registry.mjs → util
sources.mjs  → util
toolkit-ref.mjs → util
update-check.mjs → toolkit-ref
project.mjs  → util, model-invocation, template (parseFlagPlaceholder only; both import nothing from lib — no cycle)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Usage:
`wafflestack <setup|init|list|toggle|install|render|bake|upgrade|doctor|state|config|report|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]`
(`USAGE`, `cli.mjs:50`).

Dispatch and exit contract: `help`/`--help`/`-h` print the full help to stdout, exit 0 —
intercepted before the switch (`cli.mjs:55`), so `uninstall --help` explains rather than deletes;
there is no per-command help page (#187, `helpText` `cli.mjs:406`). An unknown command, and bare
`wafflestack`, print banner + usage to stderr, exit 1. Flags are spliced out by name
(`extractFlag` `cli.mjs:550`, `extractCwd` `cli.mjs:541`), so an unrecognized flag survives as a
positional: `setup`/`init`/`render`/`bake`/`upgrade`/`list`/`toggle`/`state`/`report`/`uninstall`/`reinstall` reject it
(takes-no-refs guard, exit 1 — `setup --force` / `init --yes` fail; `setup`/`init` refuse before
scaffolding, so nothing is written), `install`/`eject` fail resolving it as a ref, `avatars` rejects a
non-`sync`/`status` first arg, `config` takes at most ONE positional (a key or prefix — a stray
flag becomes that query and fails as an unknown key; two positionals exit 1), `doctor`/`validate` silently ignore it.

| Flag | Commands | Effect |
|------|----------|--------|
| `--cwd DIR` | every command | run against DIR; spliced out before ref parsing |
| `--help`, `-h` | every command | print help to stdout, exit 0; intercepted before dispatch |
| `--force` | `render`, `bake`, `install`, `reinstall` | override render's unmanaged-file overwrite guard |
| `--force` | `uninstall`, `reinstall --clean` | also delete drifted (hand-edited) managed files |
| `--gitignore` | `setup`, `init`, `render`, `bake`, `install` | append the recommended `.gitignore` entries |
| `--yes` | `uninstall` | actually delete; without it `uninstall` is a dry run |
| `--yes` | `reinstall` | required by `--clean` only; a plain refresh needs none |
| `--keep-config` | `uninstall` | keep `.waffle/` — config, overlay, `extensions/` and both locks |
| `--clean` | `reinstall` | wipe incl. config, then re-scaffold via lib `init()` (requires `--yes`) |
| `--allow-missing` | `doctor`, `uninstall` | tolerate managed files absent from disk (the generated `.waffle/` docs are presence-optional without it, #528) |
| `--verify-render` | `doctor` | re-render committed inputs in a temp dir vs the committed lock |
| `--interactive` | `list` | keypress multi-select; needs a real TTY, else degrades to the table |
| `--check-prereqs` | `list` | run the hinted prerequisite checks (shells out) and show only the unmet ones; a broken probe reads as unknown (#579) |
| `--json` | `report`, `state` | print the report bundle / state document as JSON on stdout instead of Markdown / human text |
| `--board` | `state` | #697: add the `board` block (milestones, epics, In Progress / In Review) read via `gh`; the one `state` path that calls `gh`. Best-effort: a failure sets `board.error`, never the exit code; `--offline` / `WAFFLESTACK_OFFLINE=1` skip it (`error: "offline"`) |
| `--disable SKILL` / `--enable SKILL` | `toggle` | #476: set / clear the per-skill model-invocation override without the picker; repeatable, comma-splittable (`extractValues` `cli.mjs:530`); either flag skips the TTY prompt; a name on both sides, a name no selected stack renders, or a flag with no value exits 1 before anything is written |
| `--no-color` | `list`, `toggle` | suppress ANSI; the `NO_COLOR` env var does the same (`cli.mjs:264`, `cli.mjs:292`); neither is listed in `help`'s flag block (#359) |
| `--allow-unreleased` | every command (spliced globally) | #373: suppress the release gate's refusal (toolkit development only); env twin `WAFFLESTACK_ALLOW_UNRELEASED=1`. Suppresses the refusal, not the truth — identity still resolves, network lookup included, so a genuine release keeps its `ref` under the hatch (#383) |
| `--offline` | every command (spliced globally) | #383: skip the network release lookup (`git ls-remote`); env twin `WAFFLESTACK_OFFLINE=1`. On `doctor`/`state` it also skips the newer-release lookup (#608), which still reads a fresh cache entry. Fails open (identity degrades to `unverified`, `ref: null`); the ONLY switch that skips the lookup — orthogonal to `--allow-unreleased` ("don't refuse me" vs. "don't pay for the answer") |

Release gate (#373; truth in `toolkit-ref.mjs`, gate in `cli.mjs`). Before writing files from
toolkit content, the CLI resolves its own identity and refuses (exit 1, naming the exact pinned
command) when provably not a release. Gated: `render`/`bake`, `install`, `upgrade`, `reinstall`,
`doctor --verify-render`, `list --interactive` (once a selection is applied), `toggle` whenever it
writes (`--disable`/`--enable`, and the TTY picker — gated BEFORE the prompt so a refusal never
follows the user's picks). Not gated: plain `toggle` with no flags (read-only table ⇒ warning),
`doctor` (pure hash-vs-lock; gets the offline identity), `list`/`setup`/`init` (report, or the static starter only ⇒
`formatProvenanceWarning` to stderr), `report` and `config` (read-only ⇒ warning, and OFFLINE identity so a
diagnostics dump or key lookup never stalls on a lookup), `eject`, `uninstall`, `validate`, `avatars`, `help`.
`unverified` (offline / no git / unreadable npm lockfile) proceeds with a warning — fail open on
ignorance, fail closed only on a successful "not a release" lookup. The identity is threaded to
`renderProject`/`upgrade`/`reinstall` and written into the lock's `toolkit` block (#374).

| Command | Behavior |
|---------|----------|
| `setup` / `init` (alias) | #611: one handler (`cli.mjs:227`), byte-identical output. `scaffoldConfig` (`eject.mjs`) writes the starter `.waffle/waffle.yaml` only when `resolveConfigFile` finds no config at any generation (a legacy `.waffle.yaml`/`.wafflestack.yaml` counts as existing); never overwrites. `wrote …` goes to stderr so stdout stays the pure playbook. `--gitignore` always applies `BASELINE_GITIGNORE_ENTRIES` — the three pre-stack-knowable entries (local overlay, local lock, `.waffle/avatars/`; #528), reported on stderr. Exit 0 whether it scaffolded or found a config. Then prints the `schema/SETUP.md` playbook + toolkit inventory; a freshly scaffolded config gets the first-install guide, an existing one adds a live update-mode section — including, when the selection renders a mod, a `## Mods` block with each mod's check/load/install/test lines (#564). `setup.mjs:26` |
| `list` | Per-stack per-item state table (`current`/`outdated`/`not-installed`/`not-installable`/`PENDING REMOVAL` — the last on every deselection path, scope or stack/include, #371); plain aligned table by default (ANSI only on a TTY); `--interactive` multi-select installs + renders. Takes no refs. `list.mjs`, `cli.mjs:241` |
| `toggle` | Per-skill agent-invocation override (#476): one row per RENDERED skill (`agent-invocable` / `slash-only`, `(source)` / `(override)`), read from the COMMITTED config and the tree lock; externals (#471) never listed. No flags + real TTY on stdin AND stdout → keypress picker (checked = agent-invocable; `enter` writes the FULL desired state, `esc` writes nothing); no flags + non-TTY → the plain table, exit 0, readline never opened; `--disable`/`--enable` → write without a prompt. A write persists a MINIMAL `skills.modelInvocation` block (a skill lands in `disabled:`/`enabled:` only where it differs from its source; empty block removed) to `waffle.yaml` comment-preservingly, then runs a full render so the lock records the patched skill. `no change` when every named skill is already in that state. Takes no refs. `toggle.mjs`, `cli.mjs:268` |
| `install [ref…]` | Persist each ref to config (stack → `stacks:`, item → canonical `include:`), then render. An EJECTED item ref is un-ejected, loudly (#497). ANY refused render rolls the config back to the text as found (#548, `cli.mjs:475`); when the refusal is an un-ejected item's differing project-owned copy the error names `--force` and the item stays ejected. Bare `install` = `render`. `eject.mjs:118` |
| `render` | Regenerate all managed files verbatim, prune stale managed files, write lock. Rejects positional refs. Refuses to overwrite a pre-existing untracked file unless `--force` (`render.mjs:193`). `render.mjs:58` |
| `bake` | Pure alias for `render` — a fall-through case sharing its body and guards (#176). |
| `upgrade` | Lock-vs-CLI version diff, CHANGELOG delta, migrations in `(from, to]` (an unreleased toolkit also runs the steps keyed past its version, #501), pin reconcile (#372), render (`refreshSources: true`, reporting source + built-in toolkit commit moves, #374) + doctor. Missing lock degrades to render + doctor; a lock recording no `toolkitVersion` skips migrations and the changelog delta (`upgrade.mjs:51`). Exit follows doctor. `upgrade.mjs:28` |
| `doctor` | Diff managed files vs `readTreeLock`; report `toolkitVersion` + skew note + `toolkit` provenance note (#374, warning only) + a newer-release note (#608, informational, never flips `ok`; `update-check.mjs`) + a stale-installed-mod note per enabled mod whose Claude Code install is older than the toolkit's (#730, informational, never flips `ok`; `installed-mods.mjs`, also surfaced by `upgrade`); run selected stacks' `prerequisites:` checks. Exit 1 on drift, an unmet `require` prerequisite, OR an `include:` ∩ `eject:` overlap (#497, `ejectOverlaps` + an `include/eject overlap:` note; needs no toolkit). `--allow-missing`: only modified files count. An absent generated `.waffle/` doc (`isGeneratedDoc`) is a note in every mode, never drift (#528); the all-absent guard (#311) stays flag-independent. `canonical: true` (library option, #473): compare against the committed lock and load the config without the overlay — neither local file is opened. `doctor.mjs:39` |
| `report` | Print a REDACTED diagnostics bundle for an upstream toolkit bug report (#473): committed lock summary (version, `toolkit` block, targets, stacks, include, tracked-file COUNT, external source names), committed config (targets, stacks, external names/refs, eject, config KEY paths — never values), environment (CLI version/status, node, platform, overlay PRESENCE), and a `doctor({ canonical: true })` summary. Never opens `waffle.local.yaml` or `waffle.local.lock.json`; scrubs cwd/home/emails/remotes. Markdown `<details>` by default, `--json` for machines. Takes no refs; never contacts GitHub; exit 0 even on a red doctor. `report.mjs`, `cli.mjs:148` |
| `state` | Print the resolved state (#561): every `modes:`/`flag:` key with its effective value, the layer it came from and its invocation tokens; `delegate.checkpointDir` (newest `<runId>.json`, the last phase whose sections are all PRESENT — shape only; the delegate skill's `checkpoint.mjs` is the validator) and `delegate.memoryFile` (bytes vs `delegate.memoryMaxBytes`); committed vs local lock (presence, toolkit version/status/ref, per-file divergence); plain-`doctor` drift against `readTreeLock` (#317). Human text by default, `--json` for the document below. Plus an `agents` array (#610) — the roster `/standup` spawns — and an `update` block (#608) — whether a newer toolkit release exists, via `update-check.mjs`. Takes no refs; read-only, offline identity, no prerequisite probes, writes nothing in the repo (the newer-release check may refresh its user-cache file, and `--board` its `board.json` user-cache file, unless `--offline`); exit 0 even on red drift. `--board` (#697) adds the `board` block — the only `gh` call `state` makes, best-effort and cached (`board.mjs`). `state.mjs`, `cli.mjs:124` |
| `config [key-prefix]` | #701, read-only (writes nothing; offline identity ⇒ provenance warning only). Lists every config key the selection references, directly or through another key's default template / `omitWhenEmpty:` gate — `configCatalog`, the SAME function `setup`'s "Config values" section uses — one block per key: `key = value   [default\|waffle.yaml\|waffle.local.yaml\|required ⚠]`, first-sentence summary (≤110 chars), then default / `range` / stack `constraints:` / `config may set:` (`configModes`) or else `modes:` / `flag:` tokens / declaring stacks; multi-line or long values point at the exact lookup. Multi-stack keys whose declarations disagree (requiredness, default, range, modes, configModes, flag, lockMode — never description) print `⚠ declarations disagree` with each stack's resolved value. Argument (leading `config.` stripped): exact key → full value/`expands to:`/default/description (+ keys under it); dotted prefix (segment boundary) → filtered list; else exit 1 with `declared by stack(s) X but nothing in this selection references it`, a `harness.*` pointer to FORMAT.md, or `unknown config key or prefix` + `did you mean`. Selection problems → stderr. Loads like `state` (`loadToolkitWithSources`) while `setup` uses built-in `loadToolkit` — they differ only for external stacks. No `--json` (machines read `state --json`'s `config` map). `config.mjs`, `cli.mjs:137` |
| `eject <kind/NAME>` | Add to `eject:`, strip matching `include:`, drop the item's files from the lock; files stay in place, project-owned. Never renders (offline, ungated): prints a run-`render` hint naming closure-only deps the dropped include orphaned (#497). `eject.mjs:32` |
| `uninstall` | Remove the whole install, driven entirely off the lock: `remove` only when the sha256 still matches the render; `drifted` skipped unless `--force`; refuses the whole run on an absent lock or a path resolving outside `cwd` (incl. symlink escapes). Also removes `.waffle/` meta (unless `--keep-config`), prunes genuinely-emptied dirs, strips wafflestack's `.gitignore` lines. Dry run until `--yes`. Skips exit 0; errors exit 1 (#359). Read `lockRetained` off the result, not the plan. `uninstall.mjs` (#182) |
| `reinstall` | Refresh in place: snapshot → uninstall(keepConfig+keepLock, force) → re-render, rollback on failure; keeping the lock is load-bearing (the `trackedFiles` re-admission keeps poured opt-in syrup selected). `--clean` = wipe to empty + `init` (requires `--yes`, no render). Both shapes need a lock (#359). `uninstall.mjs` (#182) |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline (#285): `sync` rasters + uploads/assigns each verified agent email's avatar; `status` reports drift only. Token from `WAFFLE_GRAVATAR_TOKEN`; unverified addresses are a manual remainder. `status` exits 1 on drift; any `failed` exits 1. `avatars-sync.mjs`, `cli.mjs:299` |
| `validate` | Toolkit-developer lint (see `validate.mjs` above), (including the `.claude-plugin/marketplace.json` ↔ stack-mods sync, #593), then `claude plugin validate` over the root marketplace and every `stacks/*/mods/<name>/` when `claude` is on PATH — prints `ok:`/`FAIL:` per mod, or one `skipped:` line (not a pass) when the CLI is absent, so CI without it stays honest (#564). Exit 1 on problems. `validate.mjs:59` |
| `help` | Banner + usage + one line per command/flag to stdout, exit 0. `helpText` `cli.mjs:406` (#187) |

### `state --json` shape (#561)

One document, `version: 1`. Additive fields keep the version; a renamed or removed field bumps it.
`keys[].value` is the effective mode (overlay included — what this machine renders); `keys[].canonical`
is the committed-inputs mode (what the shared lock renders, #317); `source` is one of `LAYERS`; `flag`
is null when the key declares no `flag:` (an unnamed side is null); `modes` is `[]` for a flag-only
key; `description` is the first sentence. `runFiles.delegate` is null unless a selected stack declares
`delegate.checkpointDir`; `latest.lastPhase` walks fetch → classify → plan → execute → report and stops
at the first phase whose sections are missing. `locks.tree` names the lock describing the disk;
`inSync` (same toolkit version + commit) and `divergence` are null without a local lock. `drift` is
plain `doctor()` with no toolkit root. `config` (#563) is EVERY declared key across the selected stacks
resolved through the same layers (`value` with nested `{{…}}` expanded, `source`, `stacks`) — `keys` is
its behavioral subset with the mode machinery. `skills` (#563) maps each selected skill to the declared
keys its own files reference (`collectUsedKeys` over the skill, `<key>.flag.<side>` folded onto `<key>`,
sorted) and the run files it writes: `SKILL_RUN_FILE_KEYS` expanded (`delegate` → checkpoint dir, its
newest checkpoint when one exists, memory file; `autopilot` → plan dir), `[]` for every other skill. A
skill selected from two stacks merges. The waffle-view mod slices by `skills[<last /name>]`. `agents` (#610)
is the roster `/standup` spawns, found by its Step 1 rule: `harness.skillsDir` (for `claude` when targeted,
else the first target) with its trailing segment swapped for `agents`, top-level `*.md` only, files with no
frontmatter `name` or unparseable YAML skipped, sorted by `name`; `description` is the first sentence, `file`
repo-relative; `[]` when the directory is absent. Local reads only, no `gh`. `update` (#608) is
always present: `latestTag`, `available` (newer than `cli.version`), `command` (the pinned remedy, null
with no repo), `checkedAt` (ISO time of the remote answer, else null), `source` (`remote`/`cache`/
`local-tags`/`changelog`/null — a checkout with no local `v*` tags reports `changelog`, #694);
all-null/false when there is no verdict. `board` (#697) is present ONLY under `--board` (`board.mjs`):
`milestones[{title,dueOn}]`, `epics[{number,title,done,total}]`, `inProgress[]`/`inReview[]` of
`{number,title,kind}` (`kind` `issue`/`pr`/`draft`, `number` null for a draft), `projectName` (the `project.name`
searched for; null means it is unset and no board lookup ran — text prints `project.name unset — no board lookup`), `project` (`{number,title}`
of the matched board, null when none matches — then both item lists are empty, not an error), `projectError`
(null, or why the board lookup failed — e.g. `gh failed: …required scopes…` without gh's `project` scope, or
`timed out` when the 8 s budget ran out before it; `project` is null and both item lists empty, but milestones
and epics stand and `error` stays null), `error` (null, or one of `offline`, `gh not found`, `gh timed out`,
`unexpected gh response`, `gh failed: <first stderr line>`; on any error every list is empty and `project` is null),
`checkedAt` (ISO time of the gh read, null offline), `source` (`remote`/`cache`/null).

```json
{
  "version": 1,
  "cli": { "version": "0.16.1", "status": "release", "commit": "<40-char sha or null>" },
  "project": { "targets": ["claude"], "stacks": ["github-workflow", "orchestration"], "include": [], "eject": [], "localOverlay": false, "errors": [] },
  "keys": [
    {
      "key": "issue.confirmGate", "stacks": ["github-workflow"],
      "value": true, "source": "stack-default", "canonical": true, "default": true,
      "modes": [true, false, "prompt"], "prompt": false, "nonInteractive": false, "lockMode": null, "configModes": null,
      "flag": { "on": "--confirm", "off": "--yes" },
      "description": "Whether `/issue` pauses at the plan gate before mutating GitHub — create, enrich, and label."
    },
    {
      "key": "autopilot.autoMerge", "stacks": ["orchestration"],
      "value": "prompt", "source": "stack-default", "canonical": "prompt", "default": "prompt",
      "modes": [true, false, "prompt"], "prompt": true, "nonInteractive": false, "lockMode": "prompt", "configModes": null,
      "flag": { "on": "+automerge", "off": null },
      "description": "Per-run auto-merge consent for the autopilot backlog runner — whether an autopilot run may arm `gh pr merge --auto --merge` on the PRs it opens."
    }
  ],
  "runFiles": {
    "delegate": {
      "checkpoints": {
        "path": ".claude/worktrees/.delegate", "exists": true, "runs": 1,
        "latest": { "file": ".claude/worktrees/.delegate/delegate-1700000000.json", "runId": "delegate-1700000000", "mtime": "2026-10-06T12:00:00.000Z", "lastPhase": "plan", "sections": ["scope", "issues", "classification", "plan"], "parseError": null }
      },
      "memory": { "path": ".claude/worktrees/.delegate/memory.md", "exists": true, "bytes": 812, "maxBytes": 4096, "overCap": false }
    }
  },
  "locks": {
    "committed": { "path": ".waffle/waffle.lock.json", "present": true, "toolkitVersion": "0.16.1", "toolkitStatus": "release", "toolkitRef": "v0.16.1", "files": 67 },
    "local": { "path": ".waffle/waffle.local.lock.json", "present": false, "toolkitVersion": null, "toolkitStatus": null, "toolkitRef": null, "files": 0 },
    "tree": "committed", "inSync": null, "divergence": null
  },
  "drift": { "ok": true, "modified": [], "missing": [], "absentDocs": [], "notes": ["rendered by toolkit 0.16.1; installed CLI is 0.16.1"] },
  "config": {
    "delegate.checkpointDir": { "value": ".claude/worktrees/.delegate", "source": "stack-default", "stacks": ["orchestration"] },
    "issue.confirmGate": { "value": true, "source": "stack-default", "stacks": ["github-workflow"] },
    "issue.priorityLabels": { "value": "| Signal in issue content | Label |\n|---|---|\n…", "source": "stack-default", "stacks": ["github-workflow"] },
    "project.name": { "value": "wafflestack", "source": "waffle.yaml", "stacks": ["github-workflow", "orchestration"] }
  },
  "skills": {
    "delegate": {
      "keys": ["autoMerge.label", "delegate.approveBeforePush", "delegate.autoMerge", "delegate.batchMode", "delegate.checkpointDir", "delegate.memoryFile", "…"],
      "files": [".claude/worktrees/.delegate", ".claude/worktrees/.delegate/delegate-1700000000.json", ".claude/worktrees/.delegate/memory.md"]
    },
    "git-workflow": { "keys": ["git.cmd", "git.coAuthorTrailer", "…"], "files": [] },
    "issue": { "keys": ["issue.confirmGate", "issue.inferenceLabel", "issue.priorityLabels", "issue.reassessLabel", "issue.typeLabels", "project.name"], "files": [] }
  },
  "agents": [
    { "name": "docs-agent", "description": "Agent-optimized documentation writer.", "file": ".claude/agents/docs-agent.md" },
    { "name": "harness-architect", "description": "Expert in designing and building agent harnesses — …", "file": ".claude/agents/harness-architect.md" }
  ],
  "update": { "latestTag": "v0.17.0", "available": true, "command": "npx --yes github:dustinkeeton/wafflestack#v0.17.0 upgrade", "checkedAt": "2026-10-11T12:00:00.000Z", "source": "cache" }
}
```

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, `requires:`) names something installable.
Grammar + resolution in `refs.mjs` (`parseRef` `refs.mjs:169`, `resolveRef` `refs.mjs:238`).
Kinds: `agents`, `skills`, `files` (a payload byte/text-copied to its repo-relative path), `mods`
(a Claude Code plugin dir, enabled through `.claude/settings.json` entries, claude target only — #560, #594).

| Form | Example | Meaning |
|------|---------|---------|
| stack | `github-workflow` | a whole stack |
| item | `skills/issue`, `files/.github/workflows/waffle-hygiene.yml`, `mods/waffle-view` | unqualified; must be unique toolkit-wide |
| qualified | `engineering-team/skills/webapp-security-audit` | disambiguates cross-stack collisions |

`canonicalRef` is the minimal re-resolvable form — what `install` writes to `include:`.

Render selection (`computeSelection`, `refs.mjs:513`):

```
rendered = union(items of enabled stacks:) ∪ closure(each include: item) − eject:
```

- Opt-in syrup gate — a stack's `optIn:` `files/` items are excluded from default expansion
  unless already lock-tracked (`trackedFiles`) or explicitly `include:`-ed (`refs.mjs:542`):
  an existing install keeps updating, a fresh stack enable never silently arms a sensitive
  workflow. When a gated file's `requires:` companion IS selected, `render`/`install` warns
  with the exact pour command (`skippedSyrupCompanions`, #74). Warn-only; the CLI stays
  non-interactive.
- Target scope gate (#364) — a `files:` item with `targets:` is selected only when the project
  enables ≥1 of them (`fileMatchesTargets`); no `targets:` ⇒ unconditional. The gate sits after
  the `trackedFiles` re-admission, so scope overrides tracking: a poured file whose last target
  is disabled is PRUNED like a dropped stack. Loud on every path where silence would hide a
  deletion: `include:` skips warn (`targetSkipped`), broken `requires:` edges warn
  (`targetBrokenRequires`, naming both steps when the dep is also opt-in), `list` reports a
  poured scoped-out file as `PENDING REMOVAL`. Every `targets:` malformation is a hard LOAD
  error in `toolkit.mjs` (an unknown name like `[claud]` is `targets: []` spelled differently).
  Invariants: an unscoped file can never be pruned; an ejected file is never pruned, and
  `targetBrokenRequires` skips it. `list` asks the same prune question on EVERY deselection path
  (#371): a live lock path no selected item produces is `PENDING REMOVAL`, with a `removalReason`
  of `scope` (never offered by the picker) or `deselected` (offered — re-installing it renders);
  target-blind, so a fan-out prune is under-reported, never invented. The forward `requires:`
  edge onto un-poured opt-in syrup warns with the pour command (`unpouredRequiredSyrup`, #371) —
  `skippedSyrupCompanions` walks the edge the other way and cannot see it. The same forward
  edge onto ANY item (agent, skill, or non-opt-in file) in a stack the project does not enable
  warns too (`disabledStackRequires`, #520): expansion never pulls another stack's items in,
  so the remedy is enable the stack or `install` the item — never a silent enable. The #74
  companion warning is eject-aware (#502): `skippedSyrupCompanions` reads `selection.ejected`
  and never advises the `install` that would un-eject the item (#497); the setup playbook
  marks such a file `ejected — project-owned` instead.
- Dependency closure — installing an item pulls transitive cross-stack deps (BFS, deduped).
  Direct deps = agent frontmatter `skills:` (lenient) + stack `requires:` (strict). Recomputed
  every render, never persisted.
- Grouping — config/env checks run per stack over selected items only; required-config is
  scoped to placeholder keys the selected items reference (`missingRequiredKeys` `usedKeys`).
- `eject:` wins over `stacks:` and over a dependency closure. `include:` ∩ `eject:` is a hard
  error (#497): `includeEjectOverlaps` (pure over the config; a qualified `include:` matches its
  unqualified `eject:` twin) feeds `computeSelection().errors` + `.ejectOverlaps`, so `render`,
  `list` and `toggle` refuse, and `doctor` notes it and exits 1 (`ejectOverlaps`). The commands
  keep the lists apart: `eject` strips a matching `include:`; `installRefs` UN-EJECTS a requested
  item. The un-ejected file is untracked, so the #25 collision guard protects it — identical is
  adopted, differing refuses without `--force`. Every refused render calls `rollback()` (#548),
  leaving `waffle.yaml` as found; `unejectCollisions` against the render's `collisions` only
  picks the collision-specific message.
  `eject` is render-free by decision: it returns `orphaned` (closure-only deps of a dropped
  include, best-effort selection diff) and the CLI prints a run-`render` hint.

## External stack sources

A `stacks:` entry is either a bare built-in name or `{ name, source, ref }` naming a third-party
source (#88). Parsed by `normalizeStackEntries` (`project.mjs`), resolved at render by
`loadToolkitWithSources` → `resolveSource` (`sources.mjs`). Guide: `schema/AUTHORING-EXTERNAL-STACKS.md`.

| Field | Rule |
|-------|------|
| `name` | required; unique across ALL `stacks:` entries; collision = hard error naming both sources |
| `source` | required; git URL (`https://`, `ssh://`, `git@host:o/r`, `*.git`) or local path (`classifyStackSource`) |
| `ref` | git source: REQUIRED; local path: MUST be omitted |
| `acknowledgedChecks` | optional; sha256 digest (`checksDigest`) of the stack's `prerequisites[].check` strings the consumer reviewed (#458); mismatch/absent = checks skipped + listed, never run |

Git sources fetch at the pinned `ref` into a content-addressed cache (reused unless refresh);
a leading-`-` source/ref is rejected (argument-injection guard). External files get lock
`sources` provenance (`{ name, source, sourceType, ref, commit, files }`); `doctor` attributes
drift per source, `upgrade` reports commit moves. `render` lints every external stack pre-write
(#126) and warns extra when external opt-in syrup is poured. An external stack's `check:` commands
are NOT run until `acknowledgedChecks` matches (#458): `render`/`doctor` list them
(`formatCheckGate`) and bucket them under `notRun`; a branch-shaped `ref` gets an extra warning.

## Stack prerequisites

Typed external prerequisites (#129) — environment facts a copy-in install can neither provide nor
verify (distinct from `requires:` render-closure edges). Schema (`prerequisites.mjs`):

```yaml
prerequisites:
  - kind: tool           # tool|secret|scope|label|setting|service|env
    name: gh
    level: require       # require (fails doctor) | recommend (reports only)
    check: command -v gh # deterministic shell command; exit 0 = satisfied
    items: [skills/issue] # optional scope to specific waffles; omit = stack-wide
```

`doctor` runs every applicable check (unmet `require` = exit 1); `render` probes only the cheap
`RENDER_PROBE_KINDS` (`tool`/`env`) as non-blocking warnings. An EXTERNAL stack's checks run only
once `acknowledgedChecks` on its `stacks:` entry equals `checksDigest(stack)` (#458); otherwise
they land in `notRun` (never met/unmet, never gating) and the command list is printed. The legacy `env:` map is subsumed
as the `env` kind, read-compatibly. The `label` kinds' bootstrap (`gh label create --force` for
every `waffle:*` default) is the "Required labels" table in `schema/SETUP.md:327` (#452).

## Recommended external plugins

External harness plugins a stack suggests pairing with (#199) — Claude Code plugins/marketplace
entries, not waffles. Schema (`plugins.mjs`):

```yaml
recommendedPlugins:
  - name: acme-reviewer
    source: acme/claude-plugins   # marketplace ref or URL, surfaced verbatim; never fetched
    why: Adds inline review comments the pr-response skill then answers.
    items: [skills/pr-response]   # optional: waffle-level scope (same shape as prerequisites items:)
    targets: [claude]             # optional, ADVISORY: printed, never a render/inventory filter
```

Purely advisory and **weaker than `recommended:`**: `setup` lists offerable entries per stack under
`### recommended plugins` (plus a gated intro paragraph) and SETUP.md tells the agent to offer, not
install. `render`/`doctor`/lock are untouched — enabling the key cannot change an output byte.
`validate` requires `name`/`source`/`why`, rejects unknown keys and duplicate names, and resolves
`items:`/`targets:`; malformed entries are lint problems (never load errors) and are not offered.
Waffle-level recommendation = `items:` scoping; there is deliberately no per-waffle key and no
registry entry (a plugin has no path, no render, nothing to prune).

## Template semantics

- Placeholders `{{dotted.key}}` (regex at `template.mjs:4`) substitute only if the key is
  declared in the stack's `config:` or is `harness.*`. Other braces (bash `${...}`, mustache)
  pass through verbatim; `$`-prefixed `${{ }}` (GitHub Actions) is excluded by negative
  lookbehind, so workflow payloads carry those untouched.
- Value formatting (`formatValue`, `template.mjs`): strings verbatim; string arrays join
  `, ` unless the key declares `listFormat: code-bullets` (one `` - `entry` `` line each; entries
  must be non-empty, one-line, and backtick-free, #612/#649); other structures render as a YAML block.
- List keys (#612) — a composed key may declare `omitWhenEmpty: <key>`: `makeResolver` returns
  `""` for it while that key resolves to `[]`/`""`/null, so a section renders nothing without a
  template conditional (`docs.protectedDocsSection` gated on `docs.protectedDocs`). Linted by
  `listKeyProblems` (an `omitWhenEmptyCycle` loop is a problem; `makeResolver` throws on one); a key
  referenced only inside another key's string default counts as used, as does one a mod of the
  stack spells as a quoted literal in its source (`'waffleView.editor'`, #616; not its tests or `.d.ts`).
- Retired config keys (`RETIRED_CONFIG_KEYS`, `project.mjs`) fail `render` with the replacement
  named: `docs.voiceGuardrailSection` (removed 0.18.0 → `docs.protectedDocs`; migration `0.18.0`).
  Migration `0.18.0` (`migrations.mjs:57`), like 0.16.0, edits COMMITTED config only: an overlay
  setting the old key is reported `NOT migrated`, never edited; prose → list of its backticked
  path-shaped tokens (`protectedPathsFromProse(text, { exclude }) → { paths, skipped }`, #648):
  camelCase `docs.*` keys and the committed (else frozen 0.18.0 default) `docs.machineDocSet` /
  `docs.humanDocSet` paths are skipped; all-caps (2+ chars: `LICENSE`, `TODO`), `_`-led, and
  frozen known extensionless names (`EXTENSIONLESS_FILES_0_18`: `Makefile`, `Dockerfile`, …) and
  `@ + ~ ? {} [] , !` are kept, other capitalized words (`Never`, #655) are `not a path`; skipped tokens are logged with reasons on one `not carried` line;
  custom wording not carried; empty/non-string → `docs.protectedDocs: []`; `protectedDocs` already
  set → old key just dropped; prose naming no usable paths is left alone with a `NOT migrated` note
  (after the `not carried` line, if any).
- `harness.*` — reserved, always-available namespace resolved per target (`HARNESS_BUILTINS`,
  `project.mjs:730`). Override via `config.harness.<sub>` (scalar → all targets, or per-target
  map). Guarded keys (`HARNESS_PATTERNS`, `project.mjs:754`): `agentsDir`, `skillsDir`, and the
  three target-independent CI-dispatcher scalars `actionRef`/`actionVersion`/`apiKeySecret`
  (#131) spliced into rendered workflow `uses:`/`with:` lines — each rejects `${{`, quotes,
  newlines, so an override can repin the action without ejecting the workflow. One key is
  supplied at run time rather than built in: `harness.toolkitVersion`, the CLI's `package.json`
  version (`makeResolver`'s `runtime` arg, threaded by `renderProject`/`setupGuide`/
  `generateWaffleDocs`), which the github-workflow stack's `doctor.toolkitRef` default nests to
  pin `waffle-doctor.yml` to the release that rendered the lock (#461).
- Nested substitution — substituted values re-expand up to depth 4 (`MAX_SUBSTITUTION_DEPTH`,
  `template.mjs:7`): a committed value can reference a key kept in the local overlay. Canonical
  text surviving the first pass is never re-scanned.
- Value guards — a scalar config key may declare `pattern:` (full-match regex on the resolved
  value, which must be a STRING — a list/map value fails rather than dodging the guard via
  flattening, #341) plus optional `patternHint:` prose printed on rejection (#218). A map-valued
  key declares `entryPatterns:` instead — `<leaf>: <regex>` applied to every entry; unknown
  leaves fail (#156). Guards are unioned toolkit-wide (a key guarded in two stacks must satisfy
  both, #244) and enforced in `substitute` at render and by `configGuardProblems` in bare
  `doctor`; linted by `validate`.
- Numeric keys (#630) — a key may declare `range: { min, max }` (inclusive, either optional):
  the RAW value must be a finite YAML number or a decimal string (`toRangeNumber`) inside the
  bounds (`rangeProblem`); exclusive with `pattern`/`entryPatterns`/`modes`/`listFormat`
  (`rangeKeyProblems`). A stack-level `constraints:` list adds cross-key checks — closed kinds
  (`CONSTRAINT_KINDS`: `lessThan` over two `range:` keys; `anyPositive` over one or more, #644),
  evaluated by `constraintViolation` / `constraintProblems` on resolved values when a selected item
  uses any of its keys: `renderProject` bails that stack,
  `renderItemInMemory` returns `null`, `configGuardProblems` (bare `doctor`) and
  `failingConfigFor` (`pattern` bucket) report it;
  `stackConstraintProblems` lints kind, keys, and defaults. First user:
  `prResponse.rubric.thresholds.{implement,decline}` (0–15, `decline < implement`); then
  `prResponse.rubric.weights.{severity,reach,validity,effortRisk,alignment}` (default 1, min 0,
  `anyPositive`); orchestration re-declares both families (same `required`/`default`/`range`) and
  both constraints (#646, drift-guarded by `installer/test/autopilot-rubric.test.mjs:47-56`).
- Behavioral keys (#478) — a key declares a closed `modes:` list (scalars; `prompt` = ask the
  human) instead of a `pattern:`, optional `flag: { on, off }` invocation tokens, optional
  `lockMode: <mode>` (config may not set anything else; `default:` must equal it), optional
  `configModes: [..]` (#626 — the subset of `modes` config may say; `default:` must be in it;
  exclusive with `lockMode`, and may not list every mode), and `nonInteractive:` (a mode or `fail`; required iff `prompt` ∈ modes). Precedence: explicit
  token → `waffle.local.yaml` → `waffle.yaml` → `default:`. Membership is judged on rendered
  text; enforced at the same points as `pattern:` (`modeProblems`, `template.mjs`). A skill reads
  the resolved mode as `{{key}}` and the tokens as `{{key.flag.on}}` / `{{key.flag.off}}` (#486):
  `loadStack` adds each declared side to `stack.declared` (`flagPlaceholders`), `makeResolver`
  answers it from the stack's `flag:` map before any project value, and a side the key does not
  name fails `validate` and the render (`undeclaredFlagProblem`). A token is optional to reference.
  The four `autopilot.*` consents default to `prompt` with `nonInteractive: false` (#489):
  `autopilot.autoMerge` is `lockMode: prompt` (config may only say `prompt`; `+automerge` is the
  per-run on-switch), while `qaLoop`/`reviewLoop`/`auditStep` are `configModes: [false, prompt]`
  (#626 — config may pre-answer *off*, never *on*) with two-sided `+qa`/`-qa`, `+review`/`-review`,
  `+audit`/`-audit` tokens. Schema: `schema/FORMAT.md` § Behavioral keys.
- Project command values — `project.{lint,typecheck,test,build}Cmd` (13 declarations, one
  byte-identical `pattern:`, `stacks/code-quality/stack.yaml:66`; `project.installCmd` and
  `sec.auditCmd` sit outside it by design) render into a `Bash(<cmd>:*)` grant, so each must be ONE
  program: no `;` `|` `&` `,` `(` `)` `'`, no `$(…)`/backtick/`${{ }}`, no `cd ` prefix, no CR/LF,
  no leading/trailing whitespace, non-empty (`"` and `:` allowed). A project with no such check
  sets the shell no-op `true`; `true` must never ship as a `default:` (it passes vacuously).
- Extensions — `.waffle/extensions/{agents,skills}/<name>.md` appended to the rendered item
  inside `<!-- BEGIN/END project extension -->` markers (`appendExtension`, `render.mjs:760`).
  Agents: appended to body; skills: to `SKILL.md` only.
- Output conflict — two enabled sources emitting the same path is a hard render error
  (`emit`, `render.mjs:316`). Unmanaged-file overwrite guard — a rendered path already on disk
  but not lock-tracked refuses the render pre-write (`render.mjs:193`); byte-identical is
  adopted silently; `--force` overwrites.

| `harness.*` key | claude | codex | agents-dir |
|-----------------|--------|-------|------------|
| `harness.assistantName` | Claude | Codex | Codex |
| `harness.attributionPath` | claude-code | Codex | Codex |
| `harness.skillsDir` | .claude/skills | .agents/skills | .agents/skills |
| `harness.agentsDir` | .claude/agents | .agents/agents | .agents/agents |

Target-independent (#131): `harness.actionRef` = `anthropics/claude-code-action`,
`harness.actionVersion` = pinned SHA + preserved `# vX.Y.Z` comment,
`harness.apiKeySecret` = `ANTHROPIC_API_KEY` (`project.mjs:744`).

Render targets (`VALID_TARGETS`, `project.mjs:70`) — every target renders both kinds (#94):

| Source | claude | codex | agents-dir |
|--------|--------|-------|------------|
| agent `agents/<n>.md` | `.claude/agents/<n>.md` (frontmatter + `claude:` passthrough; body) | `.codex/agents/<n>.toml` (name, description, developer_instructions=body) | `.agents/agents/<n>.md` (neutral frontmatter, no passthrough; body) |
| skill `skills/<n>/` | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |

codex + agents-dir share `.agents/skills/<n>/` (`renderSkill` dedupes by output dir). Skills
render byte-for-byte except substitution + extension append; non-`.md` supporting files copy
verbatim. Expected `.codex/` layout: `agents/<n>.toml` only (plus a consumer's own
`config.toml`) — skills are in `.agents/skills/`; a sparse `.codex/` is the complete render (#190).
The codex TOML carries no skill grant by decision: Codex's `[[skills.config]]` (`path` + `enabled`)
is a per-skill enable/disable override with undocumented relative-path resolution, not a grant, so
`agentToml` conveys skill access in body prose only (`DECISIONS.md` 2026-09-12; guarded by
`content.test.mjs` #224 + the #190 literal-Claude-path sweep over sources and a codex/agents-dir
scratch render).

## Consuming-project contract

Everything lives in the one `.waffle/` directory (0.8.0 layout; legacy root `.waffle.*` and
pre-0.6.0 `.wafflestack.*` names still read with a deprecation note, migrated in place):

| File | Tracked | Role |
|------|---------|------|
| `.waffle/waffle.yaml` | committed | version, `targets`, `stacks`, `include`, `config`, `eject`, `skills.modelInvocation` (#476: `{ disabled: [..], enabled: [..] }` of skill names; shape-validated on load, throws like invalid `targets:`) (`loadProjectConfig`, `project.mjs:543`); `install`/`eject`/`upgrade`/`toggle` edit it comment-preservingly |
| `.waffle/waffle.local.yaml` | gitignored | deep-merged over committed config, wins on conflict. Private, never canonical (#317): shapes only this machine's bytes, excluded from the committed lock |
| `.waffle/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.waffle/waffle.lock.json` | generated (committed) | rendered file → sha256 map + toolkitVersion + optional `toolkit` (#374) and `sources` (#125) provenance blocks. Hashes the CANONICAL render (committed inputs only, #317) — byte-identical on every machine; `doctor --verify-render` reproduces it |
| `.waffle/waffle.local.lock.json` | gitignored | the render this machine actually wrote; written only when the overlay changes an output byte. `readTreeLock` prefers it |
| `.waffle/{CHEATSHEET,TEAM}.md` + `{cheatsheet,team}.html` | generated (committed or gitignored by consumers) | overview of the installed selection; emitted via `emit()` so lock-tracked, pruned, hash-checked when present — absence is a doctor note, not drift (#528) |
| `.waffle/AVATARS.md` + `.waffle/avatars/<agent>.svg` | generated (committed or gitignored by consumers) | deterministic per-agent avatar SVGs + Gravatar-registration manifest with derived commit emails (#157). Same `emit()` lifecycle; `--gitignore` offers `.waffle/avatars/` (#528) |
| `.waffle/waffle.reference.yaml` | generated (committed or gitignored by consumers) | every config key the selection can set, commented out under `config:` (#703). Built from declarations only (`values: {}`), so no `waffle.yaml`/`waffle.local.yaml` value reaches it (#317); same `emit()` lifecycle, absence is a doctor note |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml` (`package.json:31`).

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 1945 tests, 266 suites (2 skipped: the #445 per-target check for `codex` / `agents-dir`, whose rosters are null)) |
| validate | `npm run validate` = `node installer/cli.mjs validate` |
| typecheck | `npm run typecheck` = `tsc -p tsconfig.json` |
| build | `npm run build` = `npm pack --dry-run && node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` |
| render (dogfood) | `node installer/cli.mjs render --allow-unreleased` — flag REQUIRED (#373: a working tree is never at a release tag). Commit the updated render + lock (the doctor drift gate is a required check) |
| verify render | `node installer/cli.mjs doctor` (tree vs lock — not gated) / `node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` (committed inputs reproduce the committed lock — the CI gate, `tests.yml:36`, which gets the env twin from the job `env:` at `tests.yml:21` instead of the flag) |
| evals (metered, #109) | `npm run evals -- --max-calls N` (live, needs `ANTHROPIC_API_KEY`) / `npm run evals -- --dry-run` (mock, free). 28 cases: `code-quality` (2) + `github-workflow` (15) + `orchestration` (5) + `wafflestack` (6). NOT in `npm test` |

Test files (34): `installer.test.mjs` (render pipeline; sets `WAFFLESTACK_ALLOW_UNRELEASED=1` at
module scope — it spawns the real CLI from an untagged checkout), `content.test.mjs` (eval layer
1, #108: key-phrase assertions pinning load-bearing guardrails in the committed render AND every
`stacks/**` source, #360; includes the #172 clean-up delegate-checkpoint sweep guard with its
can-fail fixture, `content.test.mjs:3897`; the #511 block `autopilot skill: the manual-review queue has a service level (#511)` (`content.test.mjs:1296`); and the #445 harness tool allowlist sweep — sources, committed render, temp all-targets render, agent `tools:` frontmatter — with its own can-fail fixtures), `plugins.test.mjs` (#199: `recommendedPlugins:`
normalize/offer/lint over a one-stack fixture),
`evals.test.mjs` (eval layer 2 harness with the mock model, free inside `npm test`),
`checkpoint.test.mjs` / `memory.test.mjs` / `identity.test.mjs` (the delegate skill's shipped
validator/preflight scripts), `telemetry.test.mjs` (#227: rendered token-spend jq/bash programs
against fixtures), `avatars-sync.test.mjs` (#285: injected HTTP + rasterizer),
`typecheck-gate.test.mjs` (#177), `provenance.test.mjs` (#373/#374/#372: identity, release gate,
lock toolkit block, pin reconcile — hermetic, strips the env var per spawn),
`preflight-ci-parity.test.mjs` (#375: the four `project.*Cmd` config slots mirror `tests.yml`'s
required `test` job), `registry.test.mjs` (#335: waffle registry gating/rename reconciliation),
`mods.test.mjs` (#560: the `mods/` kind on a fixture stack — load shape, ref grammar, verbatim
claude-only render → lock → doctor hand-edit → eject → prune on target change, include-skip warning,
opt-in gate, cross-stack conflict, load errors, registry reconcile/wip gate, inventory; #562: the built-in `wafflestack/mods/waffle-view` loads with its six files, its manifest/hooks.json point at shipped files, it reads only via `state --json` (no `--offline`, #608), and it renders byte-identical into a claude consumer's lock; #616: the stack declares `waffleView.editor` (default `cursor`, no `modes`), `state.ts` spells it as a literal, `collectState` resolves it as `stack-default` and an argv-array override as `waffle.yaml`, and a fixture mod's quoted literal keeps a declared key referenced (gone → "never referenced"); #610 (`state.test.mjs`): `agentRoster` keeps top-level named `*.md` only (nameless, bad-YAML, `.txt`, nested skipped), sorts by name, reads `.agents/agents` for codex and the Claude roster under `[codex, claude]`, follows a `harness.skillsDir` override, matches this repo's committed `.claude/agents/` in JSON and text, and pins the standup SKILL.md roster sentences; #563: `config` resolves every declared key with its layer, `skills` lists a skill's referenced keys (flag placeholders folded) and its `SKILL_RUN_FILE_KEYS` files incl. delegate's newest checkpoint; #564: `MOD_ENGINE_LAID` files laid into a fixture mod are skipped at load and absent from the render, `validateModPlugins` with stubbed `locate`/`run` covers the present/ok, present/FAIL and absent/skipped paths plus no-mods silence, and `setupGuide` prints the mods load block with the probe's three states and omits it without the claude target),
`comment-gate.test.mjs` (#388 doctrine enforced mechanically over git-TRACKED `installer/**` and
`stacks/**` `.mjs` plus workflow YAML: comment-ratio ceiling 15% — 20% for `stacks/**/*.mjs`, ≤12
comment lines exempts a small file — plus an 8-line max comment run, typed JSDoc excluded; the
`GRANDFATHERED` ratchet map is EMPTY as of the sweep, so every in-scope file meets the ceilings),
`migrations.test.mjs` (#501: the 0.16.0 overlap migration, overlay never edited, upgrade end-to-end;
#612: the 0.18.0 `docs.protectedDocs` migration; #670: the frozen 0.18.0 extensionless-filename list deep-equaled to a literal; and the release guard — a bump cannot skip a pending migration), `list-keys.test.mjs` (#612: `listFormat`/`omitWhenEmpty`, retired keys; #649: blank entries rejected), `config-modes.test.mjs` (#478:
behavioral-key validate rules, render + doctor guards, locked autopilot consents),
`report.test.mjs` (#473: bundle redaction, CLI surface, scrub/projection helpers; #640: line 2 of the
`<details>` block equals `REPORT_SUMMARY`, and the `report: upstream hold workflow (#640, #653)` suite over
`consumer-report-hold.yml` — a deep-equal of the whole parsed workflow (any added key — `container:`, `defaults:`,
`services:`, a step — fails; pins the `if:` summary marker AND the #653 `OWNER`/`MEMBER`/`COLLABORATOR` exemption, the two
`gh issue edit` steps hold-then-provenance) plus a raw-text check (`github.event.issue.*` refs are exactly `body` then
`author_association`, never `title`; exactly three `${{` — the `env:` values; no `uses:`)),
`sources.test.mjs` (#460: source cache location + checkout verification), `config.test.mjs` (#701:
`config` lookup on a two-stack fixture — setup parity, source attribution incl. the overlay, constraints,
multi-stack conflicts, prefix/near-miss/out-of-scope errors, long text; CLI guards and the starter-config pointer), `toggle.test.mjs` (#476:
config normalization, frontmatter patch, fixture render + toggle, CLI), `update-check.test.mjs` (#608:
`newerRelease`, cached/offline/failed `resolveLatestRelease`, `updateVerdict`, doctor's note keeps `ok`, checkout CLI writes no cache),
`autopilot-integration.test.mjs` (#731: `autopilot.integration` declaration/resolution and its SKILL.md wiring; #742: Step 8's merge wait polls `state` + `mergeStateStatus` and ends as blocked on a red check, DIRTY/BEHIND/CLOSED or a two-hour stall; #744: red check reads `gh pr checks --required` only, decided from output, so an optional check never counts; #745: an all-infra red check is rerun once by run id, a disarmed PR ends the wait, and a red-check retry disarms and closes the PR first, then cuts a fresh `-retry` branch; #741: the end-of-run integration wait reuses Step 8's rule and every final `gh pr create --base main` carries `--title`; #747: integration gate stage 1 sync PR, lock-only conflict resolution, hold path, `waffleCmd`/`installCmd` defaults; #750: `--cleanup=strip` sync commit, a fork `toolkitRef` drives `waffleCmd`, verify-then-label on the sync and fix PRs; #733: adversarial-review `--integration` mode, stage 2 consent/cold rounds/fix-PR path/hold, pr-response `## Fix branch` override; #734: stage 3 audit on the final PR, its worktree, fix PR and hard-block hold, the per-PR audit gate off in integration mode; #735: the final PR arms only on a green gate, never after a fix PR merged, with the stage 2 status proof, then closes out and deletes `<integ>`; #754: stage 2's bounded green wait, its status-proof pass condition, and the responder worktree `<a2>`/`<b2>` with its `-retry` branch and cleanup; #756: the final PR body's per-stage run/not-run lines, the one audit hand-off linked from every path that skips stage 3, stage 3's HEAD/branch stray-edit record),
`autopilot-overwrites.test.mjs` (#748: `overwrites.mjs` on temp repos with real `--no-ff` merges — clean, blind conflict clobber flagged, built-on rewrite as NOTE, sync label, outside-run removal, deleted file, rename followed, blanks, lock/`--ignore`, exit 2 on bad args; #752: catch-up-then-edit NOTE, catch-up-merge drop and hand-edited merge findings, `--pr` order-free with exit 2 off first-parent, `--rebase` drop/keep-both/clean/modify-delete/lock/exit 2, the rebase-held SKILL wiring; the gate's rendered step 4 and `integrationChecks` default),
`autopilot-rubric.test.mjs` (#646: autopilot `--rubric` pass-through and rubric base line render), `rubric-override.test.mjs` (#645: pr-response `--rubric` run override),
`rubric-thresholds.test.mjs` (#630: pr-response rubric thresholds render/doctor, `range:`/`constraints:` guards and lint), `rubric-weights.test.mjs` (#644: rubric weights render/doctor, `anyPositive` constraint kind),
`blockers.test.mjs` (#549/#579: picker blockers, prerequisite and external-source trust hints, upgrade names stale tag mentions), `board.test.mjs` (#697: `readBoard`, state text board block, CLI flag),
`config-reference.test.mjs` (#703: `configReferenceYaml` formatter, the real toolkit reference, uncommented tree passes render + doctor, #317 no config value leaks), `installed-mods.test.mjs` (#730: doctor names the `claude plugin update` for a stale installed mod),
`post-merge-delete.test.mjs` (#212: post-merge hook branch-delete probe — confirmed 404 vs failed check; skipped without bash).

### Harness tool roster (#445)

`installer/lib/harness-tools.mjs` is the single place a harness tool rename or removal is
recorded. `content.test.mjs` ("every tool call is in the harness roster") extracts every
call-shaped `Name(` from each `stacks/**` skill/agent source, the committed `.claude/` render, a
temp all-targets render, and each agent's `tools:` frontmatter, and fails with file, line and
name on any call outside the target's roster. Maintenance rule: adding a `Tool(` call to any
skill or agent means adding the name to `HARNESS_TOOLS.<target>` on purpose, in the same PR — a
missing roster entry is a bug in the PR that introduced the call, never grounds for a stop-list
entry. The stop-list is syntactic only (constructors, declarations, member calls, `(s)` plurals),
never a name. A target whose roster is `null` is unverified and its check skips visibly; declare
`[]` to assert that nothing rendered there calls any tool. `TeamCreate` / `TeamDelete` /
`TeamList` (#360) are asserted absent from every roster.

## Dogfood state

This repo renders 5 stacks into itself — `github-workflow`, `docs-system`, `orchestration`,
`harness-architect`, `wafflestack` (`targets: [claude]`; `.waffle/waffle.yaml`). `include:` arms
`files/.github/workflows/waffle-release-hook.yml`, `files/.github/workflows/waffle-post-merge-hook.yml`,
`code-quality/skills/adversarial-review` (run by pr-green when armed), `code-quality/skills/qa`
(autopilot's opt-in QA gate), and the two orchestration syrup scripts
`files/.claude/workflows/audit-stage-{1,2}.js` (#363: inert until a session invokes them, no spend —
poured so the render + lock exercise the opt-in `targets:` path; tracked in git), and
`files/.github/workflows/waffle-hygiene.yml` (`waffle.yaml:22`). Paid Claude-dispatch hooks: hygiene is
ARMED — PR #495 re-added its `include:` line, PR #496 dropped its `eject:` entry and re-rendered, so
`.github/workflows/waffle-hygiene.yml` is lock-managed (`waffle.lock.json:83`) and tracked in git (cron
`0 13 * * *` + `workflow_dispatch`, reads `secrets.ANTHROPIC_API_KEY`; `waffle-hygiene.yml:9-10,37`).
pr-green and pr-response stay DISARMED: `eject:` holds both `files/` refs (`waffle.yaml:199-201`; #414),
neither is in `include:`, the lock tracks neither rendered path, and neither file exists under
`.github/workflows/`. Re-arm one (#343): `install <files/ref>` — un-ejects it, adds the `include:` entry and renders (`eject.mjs:169-180`, `cli.mjs:79-80`; a differing project-owned copy refuses and rolls back without `--force`) — then commit.

The render (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json` — whose `waffle-view@wafflestack` entries are lock-managed, #594) and the lock are
COMMITTED, like a consuming project — the doctor drift gate (required check on main) needs render
+ lock in git. Re-render AND commit after editing `stacks/**`. Gitignored deliberate absences,
tolerated by doctor's `--allow-missing`: `.claude/worktrees/`, `.codex/`/`.agents/` (non-targets),
`.github/workflows/waffle-label-hook.yml` (would arm a live label→harness dispatch), and the
generated `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`, both `.html`, `AVATARS.md`,
`avatars/`, `waffle.reference.yaml`).

CI render gate (#314/#316): `.github/workflows/tests.yml` (project-owned — NOT lock-managed) runs
`npm test` + `npm run validate` + `npm run typecheck` (`tests.yml:30-32`), then
`WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs doctor --allow-missing --verify-render`
with the checkout's OWN CLI
(`tests.yml:36`) — catching a `stacks/**` edit whose re-render was forgotten. The job supplies
`WAFFLESTACK_ALLOW_UNRELEASED: '1'` at its `env:` block (`tests.yml:21-22`; `actions/checkout`
fetches no tags, so the checkout is `unreleased` by construction — the flag suppresses the
refusal, not the truth). This gate cannot live in `doctor.flags`: the shipped waffle-doctor
workflow renders via `npx github:dustinkeeton/wafflestack` (main's toolkit), wrong for this
repo's own PRs in both directions. Toolkit-local CLI calls in this repo's config prompts
(`delegate.extraPreflight`, `audit.compliancePrompt`) pass `--allow-unreleased` on `render` for
the same reason.

`.github/workflows/consumer-report-hold.yml` (#640) is also project-owned — NOT lock-managed, no
stack renders it: on `issues: opened` it adds `waffle:reassess` + `waffle:consumer-report` to
issues whose body carries `REPORT_SUMMARY`, unless the author is `OWNER`/`MEMBER`/`COLLABORATOR` (#653); pinned by `report.test.mjs`.

## Protected docs

`config.docs.protectedDocs` in `.waffle/waffle.yaml` lists the paths docs passes flag instead of
rewriting: `CHANGELOG.md` and `.waffle/**`. `README.md` and the `schema/*.md` docs are normal
docs-pass targets (#612).
