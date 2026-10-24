---
last-updated: 2026-10-23
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
| `github-workflow` | `stacks/github-workflow/` | (none) | git-workflow, issue, github-project-management, github-project-board, clean-up, label-hook, hygiene, release, pr-response | Git / GitHub issue / Projects v2 / release workflow. Ships 14 `files/` payloads: `waffle-doctor.yml` (default render, read-only drift gate); 7 opt-in syrup workflows (`waffle-label-hook`, `waffle-hygiene`, `waffle-release-hook`, `waffle-post-merge-hook`, `waffle-evals`, `waffle-pr-green-hook`, `waffle-pr-response-hook` — each holds write permissions and/or spends API money, so enabling the stack never renders them; the four Claude-dispatch hooks `label-hook`/`hygiene`/`pr-green-hook`/`pr-response-hook` are `{ path, targets: [claude] }` entries (#190, `stack.yaml:13-23`) — pruned for a codex/agents-dir-only consumer by the #364 gate; doctor/release/post-merge/evals + the templates are unscoped); and 6 default-render inert templates (#337: `.github/ISSUE_TEMPLATE/{config,bug,feature,rough-idea}.yml`, `PULL_REQUEST_TEMPLATE.md`, `REVIEW_TEMPLATE.md` — a template must never auto-apply `labelHook.*` labels, pinned by `content.test.mjs`). 5 of the 7 opt-in workflows carry a `files/`-keyed `requires:` edge to a companion skill (label-hook→label-hook, hygiene→hygiene, release-hook→release, post-merge-hook→clean-up, pr-response-hook→pr-response; `stack.yaml:78`); `waffle-pr-green-hook.yml` and `waffle-evals.yml` have NO edge, so the #74 companion warning never fires for them. `pr-response` posts one append-only `<!-- waffle-pr-response -->` comment per round (#318); rubric v3 (Implement ≥11, #390); the Implement/Decline cutoffs render from `prResponse.rubric.thresholds.{implement,decline}` (defaults 11/4, `range: 0–15`, stack `constraints:` `decline < implement`, #630 slice 1); per-dimension weights render from `prResponse.rubric.weights.{severity,reach,validity,effortRisk,alignment}` (default 1, `range: { min: 0 }`, `anyPositive` constraint, #644) — composite `15 × Σ(wᵢ·sᵢ) / Σ(wᵢ·3)` to one decimal, overrides on raw scores; per-run `--rubric <key>=<n>,…` token (#645: the seven leaf names, resolved in §1 before findings are read, validated merged-over-config with render's rules, whole-token fallback — attended asks, `--yes` falls back to config; footer `source: config | run override`); autopilot pass-through pending #646. pr-green dedupes per green head via the `waffle/adversarial-review` commit status; pr-response-hook bounds its loop with `prResponse.responseLabel` applied BEFORE the paid dispatch (#338: no hook predicate reads a body). Target threading (#355): pr-green uploads a `waffle-pr-target` artifact (`{pr_number, head_sha, head_ref, head_repo}`, 7-day retention) before its harness — an unverified pointer, re-checked downstream (`waffle-pr-green-hook.yml:94-116`); pr-response-hook's `resolve` job (`actions: read` only) reads it via `gh run download <workflow_run.id>`, shape-validates (`jq -s`: exactly one JSON object, else skip), fails closed; a failed download logs gh's flattened stderr, `::warning::` only when it is not the expected no-artifact case (#624) (`waffle-pr-response-hook.yml:15-56`); its gate re-verifies via `pulls/{n}` (open, default-branch base, head still the reviewed SHA, same-repo head) under a per-PR concurrency group (`:61-63`, `:94-101`), and the branch checkout is re-verified against that SHA before install (#623, `:167-182`); re-render both hooks together — without the artifact every run skips (`stack.yaml:862-870`). `waffle-label-hook.yml` (#544): enrich takes the dispatched issue URL as delivery evidence (`:91`), read-only `gh` calls (`gh <noun> list|view`, `gh api` with no mutating method/body) classify SOFT in both jobs (`:111-112`, `:313-314`), and `Bash(gh label list:*)` is on the enrich allowlist (`:49`). `hygiene` task 1 is a docs drift backstop (#586; per-PR `pr-docs` is the main docs path, #572): skips while an open `chore/hygiene-docs-*` PR exists; diffs `origin/<default>` since the last run (`git rev-list -1 --first-parent --before=<window>`, `25 hours ago` for a daily cron); drops tests/fixtures, `CHANGELOG.md`, the `docs` skill's doc files and generated/lock output — nothing left → reports `no drift`, spawns no agents; else runs `docs` with the remaining paths as focus; merges the latest default branch before push (never rebase), a conflict aborts and reports `skipped`, the next run retries (`skills/hygiene/SKILL.md` task 1; setup note `stack.yaml:437`). Config: `issue.*`, `labelHook.*`, `hygiene.{cron,claudeArgs,autoMerge}`, `release.{tagFormat,versionFiles}`, `prGreen.*`, `prResponse.*` (incl. `prResponse.rubric.thresholds.*`, #630, and `prResponse.rubric.weights.*`, #644), `cleanUp.confirmGate`, `evals.{cron,maxCalls,model}`, `autoMerge.label`, `doctor.{toolkitRef,flags}` — `issue.confirmGate` / `prResponse.confirmGate` / `cleanUp.confirmGate` are the first behavioral keys a skill reads (#487: `default: true`, `modes: [true, false, prompt]`, `flag: { on: "--confirm", off: "--yes" }`, `nonInteractive: false`; the skills render `{{key}}` and `{{key.flag.*}}`); `hygiene.autoMerge` is the flag-less one (#488: `default: true`, `modes: [true, false]`, no `flag:`/`prompt` — the hygiene skill's step 6 branches on `{{hygiene.autoMerge}}`; `--execute` stays `clean_up.sh`'s switch behind `cleanUp.confirmGate`, no `cleanUp.execute` key) — label defaults moved to the `waffle:` namespace in #451 (`issue.inferenceLabel` = `waffle:needs-inference` `stack.yaml:1707`, `autoMerge.label` = `waffle:auto-merged` `stack.yaml:1942`; the `label` prerequisites and the rendered `rough-idea.yml` follow); `issue.reassessLabel` = `waffle:reassess` (#504, `stack.yaml:1727`) is a human-applied hold — the `label-hook` implement path declines a reassess-labeled issue with a comment, the `issue` skill never adds or removes it, and orchestration re-declares the key with the same default the way both stacks share `autoMerge.label` (`kind: label` prerequisite scoped to `issue` + `label-hook`; the one automated adder is `/waffle-report`, upstream at filing (#609), and nothing removes it — pinned by `content.test.mjs`'s mutator sweep, whose `ADDERS` allowlist exempts only the waffle-report skill (source + render) and its hold-labels eval from the add ban) — pin `doctor.toolkitRef` to a release tag BEFORE arming `--verify-render` in `doctor.flags` (#322). |
| `code-quality` | `stacks/code-quality/` | (none) | tdd, codebase-architecture, adversarial-review, qa, dry | Cross-cutting practice skills (#117; test command, tiers, module map are config). `adversarial-review` (#112): config-free hostile post-green PR review, auto-triggered by the pr-green hook (#180). `qa` (#228): functional sibling — checks a green PR against the linked issue's intent, own `<!-- waffle-qa -->` marker, report-only, composed by autopilot's `autopilot.qaLoop`. Both skip seeding history from the PR on a deliberately cold spawn (autopilot's cold certification rounds and cap-escape evidence pass; `qa/SKILL.md:361`, `adversarial-review/SKILL.md:310`). `dry` (#116): de-duplication under rule-of-three guardrails. |
| `obsidian-dev` | `stacks/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development + desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `stacks/orchestration/` | project-manager, product-manager, task-planner | delegate, autopilot, audit, docs, standup, pr-docs | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config. Ships 2 `files/` payloads (#363): `.claude/workflows/audit-stage-{1,2}.js` — the `/audit` chain as staged Claude workflow scripts, both `optIn:` AND `targets: [claude]` (`stack.yaml:10-17`; the prose `audit` skill stays the everywhere fallback). `delegate` ships three dependency-free supporting files: `checkpoint.mjs` + `checkpoint.schema.json` (#105/#106, per-phase run checkpoint validator) and `memory.mjs` (#107, byte-capped curated run-memory gate). Config: `delegate.{defaultScope,extraPreflight,checkpointDir,approveBeforePush,autoMerge,batchMode,docsRefresh,memoryFile,memoryMaxBytes}` (`checkpointDir`/`memoryFile` defaults exercise depth-4 nested expansion; `approveBeforePush`/`autoMerge`/`batchMode` declare `modes: [true, false]` with no `flag:` — #488, declaration-only, render unchanged), `autopilot.{autoMerge,planDir,qaLoop,maxQaRounds,reviewLoop,maxReviewRounds,auditStep,holdLabel}` (`holdLabel` default `waffle:manual-review`, `autoMerge.label` default `waffle:auto-merged` — #451, `stack.yaml:808`/`:630`), `issue.reassessLabel` (default `waffle:reassess`, `stack.yaml:639` — #504: re-declared from github-workflow like `autoMerge.label`; delegate's Phase 1 list paths and autopilot's scope resolution exclude reassess-labeled issues and report the held-out count, an explicit `#N` stays actionable, and neither skill ever adds or removes the label). `pr-docs` (#584, part of #572) refreshes docs on one open PR: merge latest base (never rebase) → `git diff --name-only origin/<base>...HEAD` → `docs` skill with those paths as focus (`docs` takes an optional focus argument) → commit + push onto the PR branch; no-op exit (no agents) when every path is tests / `CHANGELOG.md` / docs / generated output; ends with one `pr-docs: no-op|up to date|refreshed|stopped` line. `delegate.docsRefresh` (`modes: [true, false]`, default `true`, `stack.yaml:675`) gates the caller; a hand `/pr-docs` ignores it. Wiring (#585, delegate Phase 4 post-agent verification block): when on, the orchestrator runs `pr-docs <PR#>` per verified PR after verification and before arming, on every path (single-issue, serial, parallel, batch); spawned agents skip self-arming and report `not armed — pending docs refresh`; arming (`gh pr merge --auto --merge`) waits until the PR's remote head equals the post-`pr-docs` commit; a `stopped` result leaves the PR open-but-not-armed; skipped when autopilot's `/audit` step covers the PR — autopilot forces `delegate.docsRefresh` off for its delegate run when its audit step (§4) is on (`content.test.mjs` block `delegate and autopilot wire pr-docs before arming`). `autopilot` (#100/#143) composes delegate (batchMode + per-run autoMerge consent, never sticky) into a per-issue plan→implement→PR loop with three opt-in gates in fixed order: QA (#228), review loop (#220), diff-scoped `/audit` (#221); can't-converge files an `autopilot.holdLabel` follow-up. Hold-queue service level (#511): the Step 5/6 cap hatches (certification catch and errored-twice fallback included) file only should-fix and blocker findings; a nit-only fresh pass files nothing and lists its nits in the run report as reported-not-filed (outcome `cap-reached with nits reported, not filed`); the Step 7 audit gate still files every unresolved Critical/High; every run report closes with the open `holdLabel` queue (number, title, age) or `hold queue: empty`; no cadence/cron is wired (the hygiene cron is a paid dispatch). Loop convergence (#510): only a cold round (round 1, or a fresh unnamed certification reviewer after an anchored round implements 0; the responder stays persistent) that implements 0 ends a QA/review loop; every round, certification included, counts toward the cap; bound = cap+1 reviewer passes and at most cap `pr-response` passes per loop, 10 gate passes per PR per run at the default caps (`skills/autopilot/SKILL.md` Guardrails). Caps are per-run, not per-PR, and never bound a manual `/pr-response` (#357). `requires:` edges: delegate→git-workflow+github-project-management+github-project-board, docs→docs-agent+docs-human, autopilot→delegate+clean-up+git-workflow+github-project-management+qa+adversarial-review+pr-response+audit+issue, audit→docs, pr-docs→docs+git-workflow, `files/…/audit-stage-1.js`→audit, `files/…/audit-stage-2.js`→audit+docs (`stack.yaml:19-46`). Prerequisites (`stack.yaml:53-105`): `require` tool probes node/git/gh; `recommend` gh-auth scope, the three labels above, and two `setting` checks scoped to delegate+autopilot — `allow-auto-merge` (1 of 3) and `required-status-check` (#205: 2 and 3 of 3 — a required check on the default branch via branch protection or a ruleset, which on GitHub Free exists only for public repos; otherwise `gh pr merge --auto` leaves the PR open-but-not-armed). Guardrails: never push main, never `--admin`-merge, merge commits not squash. |
| `engineering-team` | `stacks/engineering-team/` | lead-engineer, data-engineer, qa-engineer, devops-engineer, ux-designer, security-engineer | webapp-security-audit | Product-eng roster (browser-app security variant); lead-engineer is the general architect. Slots into `orchestration`'s roster. |
| `expo-dev` | `stacks/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development; mobile-architect is the domain architect. |
| `harness-architect` | `stacks/harness-architect/` | harness-architect | (none) | Single domain agent — expert in agent harness design. One optional config key (`project.longName`). This repo appends a project extension grounding it in the toolkit's own paradigms. |
| `wafflestack` | `stacks/wafflestack/` | (none) | waffle-init, waffle-setup, waffle-install, waffle-render, waffle-upgrade, waffle-doctor, waffle-eject, waffle-validate, waffle-report, waffle-toggle; mod: waffle-view | Self-referential stack (#70): one user-invocable `/waffle-*` skill per CLI subcommand, each shelling out to `npx <waffle.toolkitRef> <sub>`. `/waffle-report` (#473) wraps `report` and files a toolkit bug UPSTREAM (target resolved from `waffle.toolkitRef`; `bug`/`feature`/`rough-idea` forms; post-redaction gate; no-auth URL fallback). Each filing carries the form label (set by `gh issue create --label`) plus two literal upstream labels, `waffle:reassess` (the hold) and `waffle:consumer-report` (provenance, #609), each added in its own tolerant `gh issue edit --add-label … || echo "warn: …"` call — a missing upstream label is a warning, never a failed filing; the URL fallback carries both via `labels=`; a consumer's `issue.reassessLabel` does not apply (`skills/waffle-report/SKILL.md:102-114`, `:216-251`). On the toolkit tracker both fixed labels are ALSO applied server-side (#640): the project-owned `.github/workflows/consumer-report-hold.yml` (not lock-managed, no stack renders it) fires on `issues: opened`, gates its one job on `contains(github.event.issue.body, REPORT_SUMMARY)` (`installer/lib/report.mjs` export, line 2 of the `<details>` block) AND an `author_association` not in `OWNER`/`MEMBER`/`COLLABORATOR` (#653: maintainer-filed issues are never held; body and `author_association` read only in the `if:`), and runs two `gh issue edit` steps (hold first, so a renamed provenance label cannot block it) with `issues: write` only, no `uses:`, body never in `run:`/`env:` — all pinned by `report.test.mjs`. `waffle:consumer-report` is never a consumer prerequisite (doctor must not check it; pinned by `content.test.mjs`). Ships three eval cases under `stacks/wafflestack/evals/`: `waffle-report-files-with-hold-labels`, `waffle-report-redacts-overlay`, `waffle-report-routes-rough-idea`. `/waffle-toggle` (#476) wraps `toggle` — the per-skill `disable-model-invocation` override — and always drives it by `--disable`/`--enable` flags (the picker needs a TTY). Two optional config keys: `waffle.toolkitRef` (default `github:dustinkeeton/wafflestack#v{{harness.toolkitVersion}}` — the release that rendered, #469) and `waffle.reportConfirmGate` (#487: `default: true`, `modes: [true, false, prompt]`, `flag: { off: "--yes" }`, `nonInteractive: fail` — the one gate with no non-interactive skip). Ships the first built-in mod, `mods/waffle-view` (#562, part of #552): a Claude Code plugin dir (`.claude-plugin/plugin.json`, `hooks/hooks.json` → `hooks/register.tsx`, `hooks/state.ts`, `types/index.d.ts`, `hooks/waffle-view.test.ts`) that registers `/waffle-view` on `session.start`, opens a `Pane` (`$.ui.open`), and draws the `state --json` document — project, keys (value/source/tokens, `value !== canonical` marked), delegate run files, locks, drift — reading ONLY through `$.process.run` of `wafflestack state --json --offline` (`installer/cli.mjs` at the cwd → `node_modules/.bin/wafflestack` → `npx --yes github:dustinkeeton/wafflestack`; `resolveArgv` in `state.ts`). Refreshes after `/waffle-view`, every other `command.run`, `prompt.submit` and the main loop's `turn.complete` while the pane is open; `$.state` atoms `doc`/`error`/`isRefreshing`. Context slicing (#563): a `skill` atom holds the name the person's last prompt invoked (`prompt.submit` text `/name …`, or `command.run`'s `command`; peer/task/scheduled origins never move it; `/waffle-view` itself leaves it alone), and `selectSlice(doc, { skill })` in `state.ts` narrows the pane to `doc.skills[skill]` — its behavioral keys, the other config it reads (from `doc.config`, values line-capped), the run files it writes (delegate facts when among them) — hiding project/locks/drift; a plain prompt, or a name `doc.skills` does not know, restores the full view. Delivered through the root `.claude-plugin/marketplace.json` (#593), not as files (#594): on the claude target `render` merges `extraKnownMarketplaces.wafflestack` (`source: github`, `repo: dustinkeeton/wafflestack`, `ref` = the `#fragment` of `waffle.toolkitRef`, omitted when unpinned — #595) and `enabledPlugins["waffle-view@wafflestack"]: true` into `.claude/settings.json`; Claude Code offers the install on the next trusted session, fallback `/plugin install waffle-view@wafflestack`. `claude plugin validate` runs over its source dir and the marketplace in `npm run validate` when the CLI is present (#564), `claude plugin test` is the mod's own gate. Caveats: the pane follows the person's last typed `/name` (prompt text or `command.run`), not a Skill-tool call the model makes mid-turn; a `/name` that is not a toolkit skill (`/clear`, a project-local skill) reads as the full view; `config` values in `state --json` include the gitignored local overlay. Enabled in this repo's own render. |

Architect seniority rule (#38): `lead-engineer` is the general architect; `plugin-architect`
and `mobile-architect` take seniority in their domains. The output-conflict guard
(`render.mjs:310`) errors if two enabled stacks emit the same path.

## Installer module registry

`installer/lib/*.mjs`, ES modules.

| Module | Purpose | Exports |
|--------|---------|---------|
| `render.mjs` | Render pipeline: sources → selection → outputs → prune → lock. Dual render on overlay (#317) | `renderProject`, `MOD_REF_KEY`, `renderItemInMemory`, `readLock`, `readLocalLock`, `readTreeLock`, `configGuardProblems`, `failingConfigFor`, `collectUsedKeys`, `missingConfigFor`, `summarizeConfigKeys` |
| `refs.mjs` | Ref grammar, resolution, dependency closure, render selection, target-scope gate (#364) | `itemOutputMatcher`, `legacyModDir`, `normalizeItemRef`, `itemsOfKind`, `findItems`, `selectingStack`, `parseRef`, `isWipWaffle`, `resolveRef`, `resolveDepStrict`, `resolveAgentSkill`, `closureFor`, `closureDeps`, `fileMatchesTargets`, `isTargetScoped`, `includeRefMatches`, `includeEjectOverlaps`, `formatEjectOverlap`, `computeSelection`, `skippedSyrupCompanions`, `unpouredRequiredSyrup`, `disabledStackRequires` |
| `template.mjs` | `{{placeholder}}` substitution + `pattern:`/`entryPatterns:`/`modes:`/`range:` guard machinery + stack `constraints:` (#630, #644) | `substitute`, `PROMPT_MODE`, `FLAG_SIDES`, `parseFlagPlaceholder`, `flagPlaceholders`, `undeclaredFlagProblem`, `isModeScalar`, `modeMatches`, `modeProblems`, `makeGuard`, `entryPatternProblems`, `toRangeNumber`, `rangeProblem`, `CONSTRAINT_KINDS`, `constraintViolation`, `constraintProblems`, `LIST_FORMATS`, `formatValue`, `placeholderKeys`, `compilePattern` |
| `toolkit.mjs` | Load `toolkit.yaml` + stack manifests; hard LOAD errors for `targets:` malformations (#364) | `MOD_MANIFEST`, `MOD_TARGETS`, `MOD_ENGINE_LAID`, `isEngineLaid`, `loadToolkit`, `loadToolkitWithSources`, `missingRequiredKeys` |
| `project.mjs` | Consuming-project config + overlay, targets, `harness.*` built-ins/guards, `.gitignore` + YAML splice helpers | `CONFIG_FILE`, `LOCAL_CONFIG_FILE`, `LOCK_FILE`, `LOCAL_LOCK_FILE`, `AVATARS_DIR`, `BASELINE_GITIGNORE_ENTRIES`, `EXTENSIONS_DIR`, `LEGACY_ROOT_CONFIG_FILE`, `LEGACY_ROOT_LOCAL_CONFIG_FILE`, `LEGACY_ROOT_LOCK_FILE`, `LEGACY_CONFIG_FILE`, `LEGACY_LOCAL_CONFIG_FILE`, `LEGACY_LOCK_FILE`, `LEGACY_EXTENSIONS_DIR`, `VALID_TARGETS`, `resolveConfigFile`, `resolveLocalConfigFile`, `resolveLockFile`, `localLockPath`, `migrateLegacyDotfiles`, `staleGitignoreEntries`, `gitignoreMentions`, `GITIGNORE_MARKER`, `ensureGitignoreEntries`, `removeGitignoreEntries`, `recommendedGitignoreEntries`, `renameLegacyStacksKey`, `dropIncludeEntries`, `setScalarIn`, `appendSeqIn`, `removeSeqIn`, `renameKeyIn`, `loadProjectConfig`, `classifyStackSource`, `normalizeStackEntries`, `HARNESS_BUILTINS`, `HARNESS_PATTERNS`, `makeResolver`, `isEmptyValue`, `omitWhenEmptyCycle`, `RETIRED_CONFIG_KEYS`, `retiredConfigProblems` |
| `util.mjs` | sha256, YAML, deep-merge, dotted lookup, frontmatter, fs, semver, `resolveInside` containment guard | `sha256`, `isBinary`, `readYaml`, `exists`, `writeFileEnsuringDir`, `deepMerge`, `parseVersion`, `compareVersions`, `lookupPath`, `FRONTMATTER_RE`, `parseFrontmatter`, `stringifyFrontmatter`, `resolveInside` |
| `doctor.mjs` | Drift check vs `readTreeLock`; generated `.waffle/` docs presence-optional (#528); `--verify-render` temp-dir reproduction (#314); prerequisite checks (#129) | `doctor`, `verifyRenderAgainstLock` |
| `eject.mjs` | `eject` / `installRefs` / `setup`+`init` scaffold | `eject`, `installRefs`, `unejectCollisions`, `init`, `scaffoldConfig` |
| `validate.mjs` | Toolkit-developer lint (consumers never run it over built-ins; render imports only `validateExternalStacks`) | `RESERVED_AGENT_KEYS`, `validateToolkit`, `validateModPlugins`, `formatModPluginChecks`, `validateRegistry`, `validateSourceBytes`, `validateHarnessBuiltins`, `validateExternalStacks`, `validateStack`, `behavioralKeyProblems`, `listKeyProblems`, `rangeKeyProblems`, `stackConstraintProblems` |
| `setup.mjs` | `setup` output: SETUP.md playbook + inventory (+ update-mode section) | `setupGuide`, `toolkitInventory` |
| `model-invocation.mjs` | Per-skill model-invocation override (#476): `skills.modelInvocation` normalization (throws on shape errors, like invalid `targets:`) + the pure `disable-model-invocation` frontmatter patch render applies to the `claude` copy | `MODEL_INVOCATION_KEY`, `CONFIG_PATH`, `emptyOverride`, `normalizeModelInvocation`, `overrideFor`, `frontmatterDisablesModelInvocation`, `sourceDisablesModelInvocation`, `applyModelInvocation` |
| `harness-tools.mjs` | Per-target roster of call-shaped harness tools (#445): `HARNESS_TOOLS` data (`claude` declared; `codex` / `agents-dir` `null` = unverified) + the pure `toolCalls` / `unknownToolCalls` extractor `content.test.mjs` sweeps every source and render with. THE place a harness tool rename or removal is recorded | `HARNESS_TOOLS`, `DEAD_HARNESS_TOOLS`, `toolsForTarget`, `anyTargetTools`, `toolCalls`, `unknownToolCalls` |
| `toggle.mjs` | `toggle` command (#476): per-rendered-skill state model (COMMITTED config, tree lock), plain table, keypress picker over `list.mjs`'s shared loop, comment-preserving minimal write to `waffle.yaml` | `computeToggleModel`, `formatToggleTable`, `toggleChoices`, `interactiveToggle`, `applyToggle` |
| `report.mjs` | `report` bundle (#473): canonical lock + config KEY paths + `doctor({ canonical: true })` summary, then `scrub`/`redact` (cwd → `<repo>`, home → `~`, emails/remotes → placeholders); `formatReportMarkdown` renders the `<details>` block (`--json` is `JSON.stringify` of the bundle in `cli.mjs:138`, no renderer export); `health` does not surface doctor's `absentDocs` (#528) — only `notes` carries them | `collectReport`, `keyPaths`, `scrub`, `redact`, `formatReportMarkdown`, `REPORT_SUMMARY` |
| `state.mjs` | `state` document (#561): every `modes:`/`flag:` key with effective value, source layer (`local-overlay`/`waffle.yaml`/`stack-default`) and tokens; delegate run files (newest checkpoint's last PRESENT phase, memory bytes vs cap); committed vs local lock; plain-`doctor` drift via `readTreeLock` (#317). The overlay is opened ONLY to attribute a layer; `skills: {}` is reserved for #563 | `STATE_SHAPE_VERSION`, `LAYERS`, `CHECKPOINT_PHASES`, `SKILL_RUN_FILE_KEYS`, `collectState`, `resolveConfig`, `resolveSkills`, `resolveBehavioralKeys`, `formatStateText` |
| `migrations.mjs` | Ordered, idempotent, version-keyed migration steps | `MIGRATIONS`, `protectedPathsFromProse`, `migrationCeiling`, `applicableMigrations`, `runMigrations` |
| `registry.mjs` | WAFFLE registry loader + the wip/replaced status gate (#335) | `REGISTRY_FILE`, `WAFFLE_KINDS`, `WAFFLE_STATUSES`, `LIVE_STATUSES`, `REGISTRY_ENTRY_KEYS`, `refKindOf`, `waffleKindOf`, `canonicalWafflePath`, `loadRegistry`, `waffleStatus`, `isWaffleWip`, `replacementFor` |
| `upgrade.mjs` | Version diff, changelog delta, migrations, pin reconcile (#372), render + doctor | `upgrade`, `reconcileToolkitRefPins`, `staleTagMentions`, `forwardRenamedWaffleRefs`, `diffSources`, `diffToolkit`, `changelogBetween` |
| `uninstall.mjs` | `uninstall` / `reinstall` + the pure `planUninstall` they share (#182) | `planUninstall`, `uninstall`, `reinstall` |
| `waffledocs.mjs` | Generated `.waffle/` overview docs + avatars, via render's `emit()` | `GENERATED_DOCS`, `isGeneratedDoc`, `extractBaseEmail`, `deriveAgentEmail`, `withIdentity`, `generateWaffleDocs`, `collectAgentAvatars`, `agentFlavor`, `agentAvatarSvg` |
| `avatars-sync.mjs` | Owner-side Gravatar pipeline behind `avatars sync`/`status` (#285) | `GRAVATAR_BASE`, `TOKEN_ENV`, `emailHash`, `syncAvatars`, `avatarsExitCode`, `enumerateAgentAvatars`, `makeGravatarHttp`, `RASTERIZERS`, `makeShellRasterizer`, `runAvatarsSync` |
| `evals.mjs` | Layer 2 eval harness (#109; runner entry `installer/evals.mjs`) | `DEFAULT_MODEL`, `DEFAULT_MAX_OUTPUT_TOKENS`, `Budget`, `BudgetExceededError`, `discoverCases`, `loadCase`, `validateCase`, `renderTargetPrompt`, `evaluateAssertion`, `parseVerdict`, `runCase`, `runEvals`, `anthropicClient`, `mockClient` |
| `list.mjs` | `list` command: per-item state model + table + interactive picker (#119); exports the keypress loop `toggle` reuses (#476) | `STATUS`, `REMOVAL_REASON`, `computeListModel`, `unmanagedOutputs`, `describeBlockers`, `ANSI`, `formatListTable`, `selectableChoices`, `interactiveSelect`, `keypressMultiSelect` |
| `prerequisites.mjs` | Typed external prerequisites: normalize, scope, probe, bucket (#47/#129) | `PREREQ_KINDS`, `PREREQ_LEVELS`, `RENDER_PROBE_KINDS`, `normalizePrerequisites`, `runCheck`, `findOnPath`, `claudeCli`, `applicablePrerequisites`, `describeProvenance`, `checksDigest`, `looksLikeBranchRef`, `externalCheckGates`, `unacknowledgedStacks`, `formatCheckGate`, `evaluatePrerequisites`, `formatPrereq` |
| `plugins.mjs` | Recommended EXTERNAL harness plugins a stack offers via `setup` (#199); never installed | `PLUGIN_ENTRY_KEYS`, `normalizeRecommendedPlugins`, `offerablePlugins` |
| `settings.mjs` | Lock-managed entries inside `.claude/settings.json` (#594): pointer keys, merge/prune, drift, mod release | `SETTINGS_FILE`, `settingsKey`, `parseSettingsKey`, `marketplaceKey`, `pluginKey`, `ownsModKey`, `lockKeys`, `modSettingsEntries`, `settingsValueAt`, `settingsConflicts`, `applySettings`, `removeSettingsEntries`, `settingsDrift`, `modReleaseKeys`, `settingsLockMap` |
| `marketplace.mjs` | The repo-root `.claude-plugin/marketplace.json` that lists every stack mod's SOURCE dir (#593); validate keeps it in sync | `MARKETPLACE_FILE`, `marketplaceSource`, `marketplacePluginId`, `readMarketplace`, `validateMarketplace` |
| `sources.mjs` | External `source:` resolution: local path or pinned-git cache (#88/#125) | `resolveSource`, `resolveSourceRoot`, `gitFetchCheckout`, `gitHeadCommit`, `gitRemoteOriginUrl`, `gitResolveRefCommit`, `checkoutMatches`, `defaultSourceCacheDir` |
| `toolkit-ref.mjs` | Toolkit self-identification (#373), lock `toolkit` block (#374), write-side pin (#372) | `resolveToolkitIdentity`, `commitFromNpmLockfile`, `shaFromResolved`, `parseLsRemoteTags`, `latestReleaseTag`, `toolkitRef`, `toolkitSource`, `toolkitLockEntry`, `toolkitPinFromLock`, `toolkitPinFromIdentity`, `classifyToolkitRefValue`, `describeToolkitProvenance`, `repoSlug`, `lockRepoSlug`, `parseRepoSlug`, `httpsUrl`, `gitLsRemoteTags`, `gitCapture`, `changelogHasUnreleasedEntries`, `changelogLatestRelease`, `formatUnreleasedRefusal`, `formatProvenanceWarning` |

Import graph (real `import` statements only; `util.mjs` and `template.mjs` depend only on `yaml`):

```
cli.mjs      → render, doctor, eject, validate, setup, report, state, upgrade, uninstall, toolkit,
               prerequisites, list, toggle, toolkit-ref, project, avatars-sync (dynamic)
render.mjs   → template, toolkit-ref, toolkit, sources, refs, validate, prerequisites, waffledocs, model-invocation, marketplace, settings, project, util
doctor.mjs   → render, project, toolkit-ref, toolkit, refs, prerequisites, sources, waffledocs, settings, util
report.mjs   → render, doctor, prerequisites, project, util
state.mjs    → toolkit, sources, refs, render, doctor, template, settings, project, util
upgrade.mjs  → render, doctor, migrations, project, toolkit-ref, registry, refs, util
uninstall.mjs → render, eject, toolkit, settings, project, util
eject.mjs    → render, toolkit, sources, refs, settings, project, util
validate.mjs → toolkit, template, refs, prerequisites, plugins, marketplace, project, registry
setup.mjs    → toolkit, render, project, refs, prerequisites, plugins, registry, marketplace, settings, util
list.mjs     → toolkit, render, refs, settings, project, util
toggle.mjs   → toolkit, sources, refs, render, settings, project, list, model-invocation
model-invocation.mjs → util
harness-tools.mjs → (nothing; test-only consumer: content.test.mjs)
waffledocs.mjs → template, project, refs, util
avatars-sync.mjs → toolkit, project, refs, waffledocs
evals.mjs    → render, template, util
migrations.mjs → project, refs, util
toolkit.mjs  → refs, sources, prerequisites, plugins, registry, project (VALID_TARGETS only), template (flagPlaceholders only), util
prerequisites.mjs → refs
plugins.mjs  → refs
marketplace.mjs → toolkit
refs.mjs     → project (VALID_TARGETS only), registry (the wip/replaced gate; registry.mjs imports only util.mjs — no cycle), settings (ownsModKey; settings.mjs imports only util.mjs)
registry.mjs → util
sources.mjs  → util
toolkit-ref.mjs → util
project.mjs  → util, model-invocation, template (parseFlagPlaceholder only; both import nothing from lib — no cycle)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Usage:
`wafflestack <setup|init|list|toggle|install|render|bake|upgrade|doctor|state|report|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]`
(`USAGE`, `cli.mjs:47`).

Dispatch and exit contract: `help`/`--help`/`-h` print the full help to stdout, exit 0 —
intercepted before the switch (`cli.mjs:52`), so `uninstall --help` explains rather than deletes;
there is no per-command help page (#187, `helpText` `cli.mjs:380`). An unknown command, and bare
`wafflestack`, print banner + usage to stderr, exit 1. Flags are spliced out by name
(`extractFlag` `cli.mjs:519`, `extractCwd` `cli.mjs:510`), so an unrecognized flag survives as a
positional: `render`/`bake`/`upgrade`/`list`/`toggle`/`state`/`report`/`uninstall`/`reinstall` reject it (takes-no-refs
guard), `install`/`eject` fail resolving it as a ref, `avatars` rejects a non-`sync`/`status`
first arg, `init`/`setup`/`doctor`/`validate` silently ignore it.

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
| `--disable SKILL` / `--enable SKILL` | `toggle` | #476: set / clear the per-skill model-invocation override without the picker; repeatable, comma-splittable (`extractValues` `cli.mjs:499`); either flag skips the TTY prompt; a name on both sides, a name no selected stack renders, or a flag with no value exits 1 before anything is written |
| `--no-color` | `list`, `toggle` | suppress ANSI; the `NO_COLOR` env var does the same (`cli.mjs:249`, `cli.mjs:277`); neither is listed in `help`'s flag block (#359) |
| `--allow-unreleased` | every command (spliced globally) | #373: suppress the release gate's refusal (toolkit development only); env twin `WAFFLESTACK_ALLOW_UNRELEASED=1`. Suppresses the refusal, not the truth — identity still resolves, network lookup included, so a genuine release keeps its `ref` under the hatch (#383) |
| `--offline` | every command (spliced globally) | #383: skip the network release lookup (`git ls-remote`); env twin `WAFFLESTACK_OFFLINE=1`. Fails open (identity degrades to `unverified`, `ref: null`); the ONLY switch that skips the lookup — orthogonal to `--allow-unreleased` ("don't refuse me" vs. "don't pay for the answer") |

Release gate (#373; truth in `toolkit-ref.mjs`, gate in `cli.mjs`). Before writing files from
toolkit content, the CLI resolves its own identity and refuses (exit 1, naming the exact pinned
command) when provably not a release. Gated: `render`/`bake`, `install`, `upgrade`, `reinstall`,
`doctor --verify-render`, `list --interactive` (once a selection is applied), `toggle` whenever it
writes (`--disable`/`--enable`, and the TTY picker — gated BEFORE the prompt so a refusal never
follows the user's picks). Not gated: plain `toggle` with no flags (read-only table ⇒ warning),
`doctor` (pure hash-vs-lock; gets the offline identity), `list`/`setup`/`init` (report, or the static starter only ⇒
`formatProvenanceWarning` to stderr), `report` (read-only ⇒ warning, and OFFLINE identity so a
diagnostics dump never stalls on a lookup), `eject`, `uninstall`, `validate`, `avatars`, `help`.
`unverified` (offline / no git / unreadable npm lockfile) proceeds with a warning — fail open on
ignorance, fail closed only on a successful "not a release" lookup. The identity is threaded to
`renderProject`/`upgrade`/`reinstall` and written into the lock's `toolkit` block (#374).

| Command | Behavior |
|---------|----------|
| `setup` / `init` (alias) | #611: one handler (`cli.mjs:210`), byte-identical output. `scaffoldConfig` (`eject.mjs`) writes the starter `.waffle/waffle.yaml` only when `resolveConfigFile` finds no config at any generation (a legacy `.waffle.yaml`/`.wafflestack.yaml` counts as existing); never overwrites. `wrote …` goes to stderr so stdout stays the pure playbook. `--gitignore` always applies `BASELINE_GITIGNORE_ENTRIES` — the three pre-stack-knowable entries (local overlay, local lock, `.waffle/avatars/`; #528), reported on stderr. Exit 0 whether it scaffolded or found a config. Then prints the `schema/SETUP.md` playbook + toolkit inventory; a freshly scaffolded config gets the first-install guide, an existing one adds a live update-mode section — including, when the selection renders a mod, a `## Mods` block with each mod's check/load/install/test lines (#564). `setup.mjs:25` |
| `list` | Per-stack per-item state table (`current`/`outdated`/`not-installed`/`not-installable`/`PENDING REMOVAL` — the last on every deselection path, scope or stack/include, #371); plain aligned table by default (ANSI only on a TTY); `--interactive` multi-select installs + renders. Takes no refs. `list.mjs`, `cli.mjs:226` |
| `toggle` | Per-skill agent-invocation override (#476): one row per RENDERED skill (`agent-invocable` / `slash-only`, `(source)` / `(override)`), read from the COMMITTED config and the tree lock; externals (#471) never listed. No flags + real TTY on stdin AND stdout → keypress picker (checked = agent-invocable; `enter` writes the FULL desired state, `esc` writes nothing); no flags + non-TTY → the plain table, exit 0, readline never opened; `--disable`/`--enable` → write without a prompt. A write persists a MINIMAL `skills.modelInvocation` block (a skill lands in `disabled:`/`enabled:` only where it differs from its source; empty block removed) to `waffle.yaml` comment-preservingly, then runs a full render so the lock records the patched skill. `no change` when every named skill is already in that state. Takes no refs. `toggle.mjs`, `cli.mjs:253` |
| `install [ref…]` | Persist each ref to config (stack → `stacks:`, item → canonical `include:`), then render. An EJECTED item ref is un-ejected, loudly (#497). ANY refused render rolls the config back to the text as found (#548, `cli.mjs:444`); when the refusal is an un-ejected item's differing project-owned copy the error names `--force` and the item stays ejected. Bare `install` = `render`. `eject.mjs:107` |
| `render` | Regenerate all managed files verbatim, prune stale managed files, write lock. Rejects positional refs. Refuses to overwrite a pre-existing untracked file unless `--force` (`render.mjs:190`). `render.mjs:55` |
| `bake` | Pure alias for `render` — a fall-through case sharing its body and guards (#176). |
| `upgrade` | Lock-vs-CLI version diff, CHANGELOG delta, migrations in `(from, to]` (an unreleased toolkit also runs the steps keyed past its version, #501), pin reconcile (#372), render (`refreshSources: true`, reporting source + built-in toolkit commit moves, #374) + doctor. Missing lock degrades to render + doctor; a lock recording no `toolkitVersion` skips migrations and the changelog delta (`upgrade.mjs:51`). Exit follows doctor. `upgrade.mjs:28` |
| `doctor` | Diff managed files vs `readTreeLock`; report `toolkitVersion` + skew note + `toolkit` provenance note (#374, warning only); run selected stacks' `prerequisites:` checks. Exit 1 on drift, an unmet `require` prerequisite, OR an `include:` ∩ `eject:` overlap (#497, `ejectOverlaps` + an `include/eject overlap:` note; needs no toolkit). `--allow-missing`: only modified files count. An absent generated `.waffle/` doc (`isGeneratedDoc`) is a note in every mode, never drift (#528); the all-absent guard (#311) stays flag-independent. `canonical: true` (library option, #473): compare against the committed lock and load the config without the overlay — neither local file is opened. `doctor.mjs:38` |
| `report` | Print a REDACTED diagnostics bundle for an upstream toolkit bug report (#473): committed lock summary (version, `toolkit` block, targets, stacks, include, tracked-file COUNT, external source names), committed config (targets, stacks, external names/refs, eject, config KEY paths — never values), environment (CLI version/status, node, platform, overlay PRESENCE), and a `doctor({ canonical: true })` summary. Never opens `waffle.local.yaml` or `waffle.local.lock.json`; scrubs cwd/home/emails/remotes. Markdown `<details>` by default, `--json` for machines. Takes no refs; never contacts GitHub; exit 0 even on a red doctor. `report.mjs`, `cli.mjs:131` |
| `state` | Print the resolved state (#561): every `modes:`/`flag:` key with its effective value, the layer it came from and its invocation tokens; `delegate.checkpointDir` (newest `<runId>.json`, the last phase whose sections are all PRESENT — shape only; the delegate skill's `checkpoint.mjs` is the validator) and `delegate.memoryFile` (bytes vs `delegate.memoryMaxBytes`); committed vs local lock (presence, toolkit version/status/ref, per-file divergence); plain-`doctor` drift against `readTreeLock` (#317). Human text by default, `--json` for the document below. Takes no refs; read-only, offline, no prerequisite probes, writes nothing; exit 0 even on red drift. `state.mjs`, `cli.mjs:121` |
| `eject <kind/NAME>` | Add to `eject:`, strip matching `include:`, drop the item's files from the lock; files stay in place, project-owned. Never renders (offline, ungated): prints a run-`render` hint naming closure-only deps the dropped include orphaned (#497). `eject.mjs:30` |
| `uninstall` | Remove the whole install, driven entirely off the lock: `remove` only when the sha256 still matches the render; `drifted` skipped unless `--force`; refuses the whole run on an absent lock or a path resolving outside `cwd` (incl. symlink escapes). Also removes `.waffle/` meta (unless `--keep-config`), prunes genuinely-emptied dirs, strips wafflestack's `.gitignore` lines. Dry run until `--yes`. Skips exit 0; errors exit 1 (#359). Read `lockRetained` off the result, not the plan. `uninstall.mjs` (#182) |
| `reinstall` | Refresh in place: snapshot → uninstall(keepConfig+keepLock, force) → re-render, rollback on failure; keeping the lock is load-bearing (the `trackedFiles` re-admission keeps poured opt-in syrup selected). `--clean` = wipe to empty + `init` (requires `--yes`, no render). Both shapes need a lock (#359). `uninstall.mjs` (#182) |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline (#285): `sync` rasters + uploads/assigns each verified agent email's avatar; `status` reports drift only. Token from `WAFFLE_GRAVATAR_TOKEN`; unverified addresses are a manual remainder. `status` exits 1 on drift; any `failed` exits 1. `avatars-sync.mjs`, `cli.mjs:284` |
| `validate` | Toolkit-developer lint (see `validate.mjs` above), (including the `.claude-plugin/marketplace.json` ↔ stack-mods sync, #593), then `claude plugin validate` over the root marketplace and every `stacks/*/mods/<name>/` when `claude` is on PATH — prints `ok:`/`FAIL:` per mod, or one `skipped:` line (not a pass) when the CLI is absent, so CI without it stays honest (#564). Exit 1 on problems. `validate.mjs:59` |
| `help` | Banner + usage + one line per command/flag to stdout, exit 0. `helpText` `cli.mjs:380` (#187) |

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
skill selected from two stacks merges. The waffle-view mod slices by `skills[<last /name>]`.

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
  }
}
```

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, `requires:`) names something installable.
Grammar + resolution in `refs.mjs` (`parseRef` `refs.mjs:167`, `resolveRef` `refs.mjs:236`).
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
every `waffle:*` default) is the "Required labels" table in `schema/SETUP.md:233` (#452).

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
  referenced only inside another key's string default counts as used.
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
  `anyPositive`).
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
  inside `<!-- BEGIN/END project extension -->` markers (`appendExtension`, `render.mjs:757`).
  Agents: appended to body; skills: to `SKILL.md` only.
- Output conflict — two enabled sources emitting the same path is a hard render error
  (`emit`, `render.mjs:310`). Unmanaged-file overwrite guard — a rendered path already on disk
  but not lock-tracked refuses the render pre-write (`render.mjs:190`); byte-identical is
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

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml` (`package.json:31`).

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 1664 tests, 226 suites (2 skipped: the #445 per-target check for `codex` / `agents-dir`, whose rosters are null)) |
| validate | `npm run validate` = `node installer/cli.mjs validate` |
| typecheck | `npm run typecheck` = `tsc -p tsconfig.json` |
| build | `npm run build` = `npm pack --dry-run && node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` |
| render (dogfood) | `node installer/cli.mjs render --allow-unreleased` — flag REQUIRED (#373: a working tree is never at a release tag). Commit the updated render + lock (the doctor drift gate is a required check) |
| verify render | `node installer/cli.mjs doctor` (tree vs lock — not gated) / `node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` (committed inputs reproduce the committed lock — the CI gate, `tests.yml:36`, which gets the env twin from the job `env:` at `tests.yml:21` instead of the flag) |
| evals (metered, #109) | `npm run evals -- --max-calls N` (live, needs `ANTHROPIC_API_KEY`) / `npm run evals -- --dry-run` (mock, free). 19 cases: `code-quality` (2) + `github-workflow` (11) + `orchestration` (4) + `wafflestack` (2). NOT in `npm test` |

Test files (19): `installer.test.mjs` (render pipeline; sets `WAFFLESTACK_ALLOW_UNRELEASED=1` at
module scope — it spawns the real CLI from an untagged checkout), `content.test.mjs` (eval layer
1, #108: key-phrase assertions pinning load-bearing guardrails in the committed render AND every
`stacks/**` source, #360; includes the #172 clean-up delegate-checkpoint sweep guard with its
can-fail fixture, `content.test.mjs:3873`; the #511 block `autopilot skill: the manual-review queue has a service level (#511)` (`content.test.mjs:1263`); and the #445 harness tool allowlist sweep — sources, committed render, temp all-targets render, agent `tools:` frontmatter — with its own can-fail fixtures), `plugins.test.mjs` (#199: `recommendedPlugins:`
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
opt-in gate, cross-stack conflict, load errors, registry reconcile/wip gate, inventory; #562: the built-in `wafflestack/mods/waffle-view` loads with its six files, its manifest/hooks.json point at shipped files, it reads only via `state --json --offline`, and it renders byte-identical into a claude consumer's lock; #563: `config` resolves every declared key with its layer, `skills` lists a skill's referenced keys (flag placeholders folded) and its `SKILL_RUN_FILE_KEYS` files incl. delegate's newest checkpoint; #564: `MOD_ENGINE_LAID` files laid into a fixture mod are skipped at load and absent from the render, `validateModPlugins` with stubbed `locate`/`run` covers the present/ok, present/FAIL and absent/skipped paths plus no-mods silence, and `setupGuide` prints the mods load block with the probe's three states and omits it without the claude target),
`comment-gate.test.mjs` (#388 doctrine enforced mechanically over git-TRACKED `installer/**` and
`stacks/**` `.mjs` plus workflow YAML: comment-ratio ceiling 15% — 20% for `stacks/**/*.mjs`, ≤12
comment lines exempts a small file — plus an 8-line max comment run, typed JSDoc excluded; the
`GRANDFATHERED` ratchet map is EMPTY as of the sweep, so every in-scope file meets the ceilings),
`migrations.test.mjs` (#501: the 0.16.0 overlap migration, overlay never edited, upgrade end-to-end;
#612: the 0.18.0 `docs.protectedDocs` migration; and the release guard — a bump cannot skip a pending migration), `list-keys.test.mjs` (#612: `listFormat`/`omitWhenEmpty`, retired keys; #649: blank entries rejected), `config-modes.test.mjs` (#478:
behavioral-key validate rules, render + doctor guards, locked autopilot consents),
`report.test.mjs` (#473: bundle redaction, CLI surface, scrub/projection helpers; #640: line 2 of the
`<details>` block equals `REPORT_SUMMARY`, and the `report: upstream hold workflow (#640, #653)` suite over
`consumer-report-hold.yml` — a deep-equal of the whole parsed workflow (any added key — `container:`, `defaults:`,
`services:`, a step — fails; pins the `if:` summary marker AND the #653 `OWNER`/`MEMBER`/`COLLABORATOR` exemption, the two
`gh issue edit` steps hold-then-provenance) plus a raw-text check (`github.event.issue.*` refs are exactly `body` then
`author_association`, never `title`; exactly three `${{` — the `env:` values; no `uses:`)),
`sources.test.mjs` (#460: source cache location + checkout verification), `toggle.test.mjs` (#476:
config normalization, frontmatter patch, fixture render + toggle, CLI).

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
`.github/workflows/waffle-hygiene.yml` is lock-managed (`waffle.lock.json:89`) and tracked in git (cron
`0 13 * * *` + `workflow_dispatch`, reads `secrets.ANTHROPIC_API_KEY`; `waffle-hygiene.yml:9-10,37`).
pr-green and pr-response stay DISARMED: `eject:` holds both `files/` refs (`waffle.yaml:202-204`; #414),
neither is in `include:`, the lock tracks neither rendered path, and neither file exists under
`.github/workflows/`. Re-arm one (#343): `install <files/ref>` — un-ejects it, adds the `include:` entry and renders (`eject.mjs:154-161`, `cli.mjs:76-77`; a differing project-owned copy refuses and rolls back without `--force`) — then commit.

The render (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json` — whose `waffle-view@wafflestack` entries are lock-managed, #594) and the lock are
COMMITTED, like a consuming project — the doctor drift gate (required check on main) needs render
+ lock in git. Re-render AND commit after editing `stacks/**`. Gitignored deliberate absences,
tolerated by doctor's `--allow-missing`: `.claude/worktrees/`, `.codex/`/`.agents/` (non-targets),
`.github/workflows/waffle-label-hook.yml` (would arm a live label→harness dispatch), and the
generated `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`, both `.html`, `AVATARS.md`,
`avatars/`).

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
