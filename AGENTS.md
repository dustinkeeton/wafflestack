---
last-updated: 2026-07-15
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
`schema/FORMAT.md` (format reference).

## Repository layout

```
toolkit.yaml               registry: name + ordered stack list
stacks/<name>/
  stack.yaml              manifest: agents, skills, files, optIn, requires, prerequisites, config, env, setup
  agents/<name>.md         neutral agent def (YAML frontmatter + body)
  skills/<name>/SKILL.md   neutral skill def (+ supporting files, copied along)
  files/<repo-rel-path>    neutral syrup payload (CI workflow/script/config), rendered verbatim to that path
  evals/<name>.eval.yaml   Layer 2 behavioral eval case (metered; inert to render/validate/lock)
installer/cli.mjs          bin entry: dispatches commands, global --cwd flag
installer/evals.mjs        eval runner entry (`npm run evals`, metered — NOT in npm test)
installer/lib/*.mjs        render pipeline + eval harness (ES modules)
installer/test/*.test.mjs  node:test suite
schema/FORMAT.md           format reference (owner-voiced)
schema/SETUP.md            agent install playbook (owner-voiced)
schema/AUTHORING-EXTERNAL-STACKS.md  third-party `source:` stack authoring guide (owner-voiced)
assets/                    brand assets (marks, favicons, social card) + brand guide (assets/README.md)
```

## Stack registry

`toolkit.yaml` lists 9 stacks (14 agents + 37 skills; reorganized in #38 — `design`
dissolved, roles consolidated, `security-audit` variants renamed). Per-stack config schema,
env, prerequisites, and setup notes live in each `stack.yaml` (authoritative — this table summarizes).

| Stack | Path | Agents | Skills | Purpose |
|--------|------|--------|--------|---------|
| `docs-system` | `stacks/docs-system/` | docs-agent, docs-human | docs-agent, docs-human, prose, md-maximalist, accurate | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. Three writing-craft skills (#224) carry the *how to write*, which the doc-set config does not: `prose` (plain language, conclusion first, skimmable by headings alone) and `md-maximalist` (markdown's full range, form chosen from the content's shape, richness only where it speeds a scanning reader) are granted to docs-human; `accurate` (every claim traced to a file actually read, omission over invention, a wrong doc is a bug) to docs-agent. The split is **orthogonal by audience, not overlapping virtues** (#299): docs-human owns human digestibility, docs-agent owns machine-trustworthy claims — so `accurate` is deliberately NOT granted to docs-human. That is not a license to be inaccurate: docs-human's accuracy is **provenance, not protocol** — it is a derivative of docs-agent, so its specifics come from the already-verified machine docs or a file it actually read, and the anti-fabrication counterweight lives natively in `prose` §5 (sourced numbers only) rather than being imported as `accurate`'s per-claim verification protocol. All three are `user-invocable` — `/prose`, `/md-maximalist`, `/accurate` (so docs-human can still run `/accurate` ad hoc) — and are granted in both agent frontmatter and body prose, since the codex target drops frontmatter `skills:`. One `requires:` edge: `skills/prose` → `skills/md-maximalist`, since `prose` §4 delegates form choice to it by name (whole-stack installs render both regardless; the edge only affects single-item installs). |
| `github-workflow` | `stacks/github-workflow/` | (none) | git-workflow, issue, github-project-management, github-project-board, clean-up, label-hook, hygiene, release, pr-response | Git / GitHub issue / Projects v2 / release workflow. `pr-response` triages a PR's review findings (five-dimension rubric v3 → Implement/Defer/Decline with recorded scores), applies accepted fixes, and posts exactly one `<!-- waffle-pr-response -->`-marked comment per round — **append-only (#318)**: a later round posts a NEW comment, never edits/PATCHes a prior reply, so the verdict trail accumulates oldest-first. `github-project-management` reads/updates board items; `github-project-board` (#54) provisions/standardizes the board itself to the canonical Kanban spec (Status/Priority/Size/Start/Target; Table/Kanban/Roadmap views) — the only create-side board skill. Ships seven prefab CI workflows as `files/` (syrup) payloads: `waffle-doctor` (read-only drift gate, default render) plus six **opt-in syrup** hooks — `waffle-label-hook` (label→enrich/implement Claude dispatch), `waffle-hygiene` (daily scheduled `docs`→auto-merge PR), `waffle-release-hook` (deterministic tag-on-merge, `contents: write`, no Claude), `waffle-post-merge-hook` (deterministic remote merged-head-branch delete, `contents: write`, pairs with `clean-up`), `waffle-evals` (nightly Layer-2 LLM eval runner, `node installer/evals.mjs`, no Claude dispatch), and `waffle-pr-green-hook` (#112/#180 — on a PR's checks going green, dispatch the harness to run `adversarial-review` and post one hostile pre-merge review; deduped per green head by the `waffle/adversarial-review` **commit status** the harness writes on the reviewed SHA — #338: no hook predicate reads a body, so a marker quoted in any review or comment changes nothing about which jobs fire). `waffle-pr-response-hook` is triggered by `workflow_run` on `waffle-pr-green-hook` (a body cannot raise that event), verifies delivery via a `waffle/pr-response` commit status, and **bounds its loop with the `prResponse.responseLabel` label, applied by the workflow BEFORE the paid dispatch** — one automated response per PR, ever; the label must pre-exist or the fail-closed bound reds the job — each wired to its companion skill/waffle via a `files/`-keyed `requires:` edge. Also ships six **default-render** (not opt-in) templates as `files/` syrup (#337): `.github/ISSUE_TEMPLATE/{config,bug,feature,rough-idea}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/REVIEW_TEMPLATE.md` — inert markdown/YAML with no permissions, job, or API spend, so the opt-in argument that gates the workflows does not apply. The bug/feature forms mirror the `issue` skill's body template (Problem / Proposed Solution / [Sub-issues] / Context) and apply `issue.bugLabel` / `issue.featureLabel`; the rough-idea form auto-applies `issue.inferenceLabel` (the enrichment QUEUE marker the `issue` skill's batch mode reads — no workflow dispatches on it). A template must **never** auto-apply `labelHook.{enrich,implement,release}Label`: a form-applied label is attributed to the human filer and so passes the label-hook's bot-sender gate, which would let any issue author dispatch a paid harness run (pinned by tests in `installer/test/content.test.mjs`). The PR template renders its test plan from the four `project.*Cmd` keys, so it tracks the `git-workflow` pre-flight. `REVIEW_TEMPLATE.md` is a human-facing companion only — the canonical finding/verdict shapes stay **skill-rendered** (`adversarial-review` severity ladder, `pr-response` rubric) so a copy in `.github/` cannot drift out from under the skills. (Before #338 the hooks keyed their guards on the markers those skills emit; they no longer do — a pasted marker is now hygiene, not a safety hazard.) Declares typed `prerequisites:` (tool probes `require`; secrets/scopes/labels/settings/services `recommend`). Config: `issue.{inferenceLabel,typeLabels,priorityLabels,bugLabel,featureLabel,blankIssuesEnabled,contactLinks}`, `labelHook.*`, `hygiene.{cron,claudeArgs}`, `release.{tagFormat,versionFiles}`, `prGreen.{watchWorkflows,claudeArgs}`, `prResponse.{claudeArgs,responseLabel}`, `evals.{cron,maxCalls,model}`, `autoMerge.label` (`waffle-auto-merged`, #134), `doctor.{toolkitRef,flags}` — pin-before-arm rule (#322): pin `doctor.toolkitRef` to a release tag BEFORE adding `--verify-render` to `doctor.flags`, because that flag re-renders with whatever toolkit npx fetched (the one flag that makes the toolkit load-bearing); on the unpinned default an upstream release can turn a consumer's unrelated PR red. Only stack with a `setup:` block (gh auth, labels, board, git identity, hook opt-ins). |
| `code-quality` | `stacks/code-quality/` | (none) | tdd, codebase-architecture, adversarial-review, qa, dry | Cross-cutting, project-agnostic practice skills (#117; test command, tiers, module map, settings type are config). `adversarial-review` (#112) is a config-free `/adversarial-review <PR#>` hostile post-green PR review (reads `gh pr diff`, posts a severity-tagged review); auto-triggered by the github-workflow `waffle-pr-green-hook` syrup (#180). `qa` (#228) is its functional sibling — `/qa <PR#>` checks a green PR against the linked issue's intent/acceptance criteria, best-effort runs `project.testCmd` and assesses diff test coverage, posts one review under its own `<!-- waffle-qa -->` marker (distinct from adversarial-review's, so pr-green/pr-response automation never cross-fires); report-only, composed by autopilot's opt-in QA gate (`autopilot.qaLoop`). `dry` (#116) is de-duplication under the rule-of-three + semantic-sameness guardrails. |
| `obsidian-dev` | `stacks/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development (API, manifest, esbuild, testing patterns) + the desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `stacks/orchestration/` | project-manager, product-manager, task-planner | delegate, autopilot, audit, docs, standup | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config (defaults: `lead-engineer` architect + compliance, `security-engineer` security; override compliance to a domain architect where one exists). Uses `requires:` for its skill deps (delegate→git-workflow+github-project-management+github-project-board, docs→docs-agent+docs-human). `delegate` ships three dependency-free supporting files (copied with the skill): `checkpoint.mjs` + `checkpoint.schema.json` (#105/#106) validate the one-JSON-doc-per-run phase checkpoint at every phase boundary (`node checkpoint.mjs --file F --phase fetch\|classify\|plan\|execute\|report`; schema sections per phase plus cross-reference checks — executed branch = planned branch, every issue traces to fetch, parallel⇒worktree/serial⇒none; exit 1 = STOP); `memory.mjs` (#107) gates the curated per-repo run-memory doc (`node memory.mjs --file F [--max-bytes N]`; missing file valid; hard byte cap + required Why/Since/Area fields per entry; exit 1 = curate, never truncate — memory loads in Classify, informs Plan grouping, injects Area-matched entries into agent prompts, is curated in Report). Opt-in approval gate (`delegate.approveBeforePush`): agents commit locally and STOP before `git push`/`gh pr create`; orchestrator collects human approval via AskUserQuestion; rejection stays local, recorded `skipped` with `approval`/`approvedBy` in the checkpoint. Config: `delegate.{defaultScope,extraPreflight,checkpointDir,approveBeforePush,autoMerge,batchMode,memoryFile,memoryMaxBytes}` — `defaultScope` is `current-milestone`\|`all-open`\|`todo-column` (#206: `todo-column` delegates exactly the board's Status="Todo" open issues via the github-project-management GraphQL catalog; missing board/Todo option falls back to `all-open` explicitly — checkpoint records `mode: "all-open"` with provenance in `description` — while an empty Todo column stops instead of widening and a FAILED board lookup (API error/missing scope) stops rather than falling back); `checkpointDir`/`memoryFile` defaults are themselves placeholders (`{{git.worktreesDir}}/.delegate`, `{{delegate.checkpointDir}}/memory.md`), exercising depth-4 nested expansion. Two batch/autopilot opt-ins: `delegate.autoMerge` (#98/#141, default false — after `gh pr create`, arm `gh pr merge --auto --merge` so the PR merges itself once the base branch's required checks pass; arm-only-on-a-required-check, never an immediate or `--admin` merge; per-run, records `autoMergeArmed` per PR) and `delegate.batchMode` (#99/#142, default false — non-interactive: explicit scope stands in for the Phase-3 plan-approval gate and an ambiguous classification falls back to serial-in-main; composes with `autoMerge`, never weakens the `approveBeforePush` pre-push gate). `autopilot` (#100/#143) is the unattended backlog runner — a prose playbook that composes `delegate` (with `batchMode` + the run's `autoMerge` engaged), `clean-up`, and `git-workflow` into a per-issue **plan→implement→PR** loop over a REQUIRED issue scope, re-implementing none of that machinery. Instantiation contract, captured before any work: (1) an explicit issue **scope** — an issue list, `milestone:<name>`, a label, or `all-open` — which is also what activates delegate's batch mode, so a run is never unscoped; and (2) per-run auto-merge **consent** (`autopilot.autoMerge`, default false, captured fresh each run, **never sticky** — never read back from a prior run/checkpoint/memory). Per issue: one read-only planning context writes `{{autopilot.planDir}}/issue-<N>.md`, injected into a fresh delegate-spawned implementer as a *brief, not a contract*; delegate opens the PR; on consent each PR self-arms on green, else it is left for human review; per merged PR autopilot runs post-merge housekeeping (verify the issue closed, board→Done, `clean-up git --yes`). Guardrails inherited verbatim from `hygiene`/`delegate.autoMerge`: never push `main`, never `--admin`-merge, merge-commits-not-squash, one retry then stop-and-report, a blocked serial chain stops its dependents. Three further opt-in, per-run gates run between PR verification and the merge-wait, in fixed pipeline order — the QA gate (#228: `qa <PR#>` → `pr-response <PR#> --yes` rounds, functional QA against the linked issue's intent, `autopilot.qaLoop` consent / `+qa`, capped per run at `+qa:N` else the `autopilot.maxQaRounds` default — #230), the review loop (#220: `adversarial-review` → `pr-response` rounds, `autopilot.reviewLoop` / `+review`, capped per run at `+review:N` else the `autopilot.maxReviewRounds` default — #230), and the diff-scoped `/audit` gate (#221: `autopilot.auditStep` / `+audit`, hard-blocks on unresolved Critical/High) — with auto-merge arming deferred to the last enabled gate, convergence read as a 0-implemented round, and a can't-converge cap filing an `autopilot.holdLabel` (`waffle-manual-review`) follow-up that automatic scope thereafter skips. `requires:` `delegate` + `clean-up` + `git-workflow` + `github-project-management` + `qa` + `adversarial-review` + `pr-response` + `audit` + `issue`. Config: `autopilot.{autoMerge,planDir,qaLoop,maxQaRounds,reviewLoop,maxReviewRounds,auditStep,holdLabel}` (`planDir` default `{{git.worktreesDir}}/.autopilot` — gitignored throwaway plan files). `standup` rounds up a per-agent status pulse — dynamic `.claude/agents/*.md` roster, one read-only parallel wave, collect-via-return-values, no side effects. |
| `engineering-team` | `stacks/engineering-team/` | lead-engineer, data-engineer, qa-engineer, devops-engineer, ux-designer, security-engineer | webapp-security-audit | Product-eng roster (browser-app security variant); lead-engineer is the general architect. Slots into `orchestration`'s roster. |
| `expo-dev` | `stacks/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development (@expo/ui, dev loop, EAS); mobile-architect is the domain architect. |
| `harness-architect` | `stacks/harness-architect/` | harness-architect | (none) | Single domain agent — expert in building agent harnesses (agent/skill/tool decomposition, subagent teams, hooks, MCP, slash-command UX, multi-harness portability). One optional config key (`project.longName`). This repo appends a project extension grounding it in the stack's own paradigms (AGENTS.md registry, schema/FORMAT.md contract, DECISIONS.md ADRs, validation gates). |
| `wafflestack` | `stacks/wafflestack/` | (none) | waffle-init, waffle-setup, waffle-install, waffle-render, waffle-upgrade, waffle-doctor, waffle-eject, waffle-validate | Self-referential stack (#70): one user-invocable `/waffle-*` skill per CLI subcommand, each a thin wrapper that shells out to `npx <waffle.toolkitRef> <sub>` and interprets the output with agent judgment (e.g. `/waffle-upgrade` reviews the render diff, `/waffle-eject` confirms before releasing a file). Dogfoods the toolkit's own delivery mechanism. One optional config key (`waffle.toolkitRef`, default `github:dustinkeeton/wafflestack` — pin to a tag or a local checkout). Enabled in this repo's own render (dogfooded). |

Architect seniority rule (#38): `lead-engineer` is the general architect; `plugin-architect`
and `mobile-architect` take seniority in their domains. The former `security-audit` name
collision is resolved by the `electron-`/`webapp-` renames; the output-conflict guard
(`render.mjs:100`) still errors if two enabled stacks ever emit the same path.

## Installer module registry

`installer/lib/*.mjs`, ES modules. See signatures block below for exports.

| Module | Purpose |
|--------|---------|
| `installer/lib/render.mjs` | Render pipeline: resolve external sources (`loadToolkitWithSources`), validate external stacks pre-write (#126), compute selection, regenerate all outputs verbatim, delete stale managed files, write lock (+ per-source `sources` provenance, #125; + the built-in toolkit's `toolkit` provenance block, #374 — `toolkitLockEntry`, written into BOTH locks, each carrying forward from its OWN predecessor). **Renders twice when a local overlay exists (#317)**: the *effective* render (committed config + `.waffle/waffle.local.yaml`) is written to disk, the *canonical* render (committed inputs only) is hashed into `.waffle/waffle.lock.json` — so a private overlay value never propagates through the shared lock. On divergence, the effective hashes go to the gitignored `.waffle/waffle.local.lock.json` (`readTreeLock`), which the prune/clobber/`trackedFiles` bookkeeping reads instead. A canonical-only render failure (a `required:` key with no `default:` held only in the overlay) is a hard, tree-untouched error. `computeOutputs` is the per-config pure core. Output-conflict + scoped required-config + env/prerequisite render-warnings (cheap `tool`/`env` probes only) + unmanaged-file overwrite guard (refuses to clobber a pre-existing untracked file unless `force`) + external opt-in-syrup trust-boundary warnings. |
| `installer/lib/refs.mjs` | Ref grammar, toolkit-wide resolution, transitive cross-stack dependency closure + render-selection computation, `itemOutputMatcher(kind,name)` (item→lock-path predicate, shared with eject/list), and `fileMatchesTargets(item,targets)` (the `files:` `targets:` scope predicate, #364). Imports only `VALID_TARGETS` from project.mjs (which imports no sibling but `util.mjs` — no cycle). Shared by install / render / validate / eject / list. |
| `installer/lib/template.mjs` | `{{placeholder}}` substitution: declared-key gate, per-target resolve, depth-capped nested expansion, value formatting, optional per-key `pattern:` value validation. |
| `installer/lib/toolkit.mjs` | Load `toolkit.yaml` + every stack manifest (agents, skills, `files` payloads with sniffed `binary` flag and optional `targets:` harness scope — bare-string or `{path,targets}` map form; **four** hard LOAD errors (#364), because EVERY malformation of `targets:` is destructive (the prune DELETES an already-poured copy from the consumer's tree): an unknown map key (a `target:` singular typo would leave the payload silently unscoped), a non-list `targets:`, an **empty `targets: []`** (scoped to nothing ⇒ can never render), and an **unknown target NAME** — `[claud]` resolves to nothing, so it IS `targets: []` spelled differently, and even a *partially*-valid `[claude, codxe]` deletes the poured copy out of a codex consumer's tree. A name outside `VALID_TARGETS` can only ever be an authoring bug, so the loader owns all of them; `validate` no longer lints target names at all. `optIn` opt-in set, `requires`, `prerequisites`, config, env, setup); scoped required-key check. `loadToolkitWithSources` (#88) additionally resolves each external `source:` entry to a toolkit root and merges its named stack (with `provenance`) into one registry; a cross-source stack-name collision is a hard error naming both. |
| `installer/lib/project.mjs` | Load consuming-project config (+ local overlay; `{ canonical: true }` skips the overlay — the committed-inputs-only config the lock is built from, #317), valid targets, `harness.*` built-ins (incl. CI-dispatcher `action*` keys + their injection-guard patterns, #131), per-target resolver; parse/validate `stacks:` bare names vs `{name,source,ref}` external entries (#88); multi-generation legacy-name read fallback + in-place dotfile migration chain (`.wafflestack.*` → `.waffle.*` → `.waffle/waffle.*`). `.gitignore` is written in exactly two places, both consent-gated and both deliberately literal: `ensureGitignoreEntries` (append-only, exact-line dedupe, `# wafflestack` marker written once) and its inverse `removeGitignoreEntries` (#182 — removes only exact-line matches of entries the toolkit itself offered, plus the marker *once it labels nothing*; never a "marker to blank line" span, which would eat consumer lines appended under it). **Non-destructive YAML writes** to the hand-authored `.waffle/waffle.yaml` are two helpers with two different mechanisms. `renameLegacyStacksKey(doc)` (key scalar, #59) mutates the live key node in place — here `doc.set` genuinely would drop the pair's comments, because a **key** rename is a delete+insert. `setScalarIn(source, keyPath, value)` (value scalar, #372; **text in, text out**, #386) splices ONLY the scalar's own source bytes (`node.range`) and returns the new text, or `null` when not one byte may change — so a pin bump lands as a one-line diff instead of a whole-file reflow (`doc.toString()` re-pads flow collections, folds plain scalars at 80 columns, and collapses double-spaced inline comments — it re-serializes the *entire* document, not the line you changed). It is guarded by re-parsing the splice and proving `value` reads back at `keyPath`; a block scalar trips that and falls back to a re-serialize. `setScalarIn` **never creates**: a missing key, a missing parent, a non-scalar, or a value that is already `value` all return `null` and write nothing (so a caller's dirty guard can trust it) — and *that*, not comment preservation, is why it exists instead of `doc.setIn`, which would invent a `toolkitRef` the consumer never chose. **`doc.setIn` does NOT drop comments on a scalar→scalar overwrite** (`yaml` v2's `YAMLMap.set` keeps the old node, its comments and its anchors); the pre-#386 claim that it did was false, and is not a reason to reach for either helper. Note `lookupPath` resolves only NESTED keys, so a flat literal `"doctor.toolkitRef":` key is inert config — and `setScalarIn` correspondingly does not find it. |
| `installer/lib/util.mjs` | Shared helpers: sha256, YAML read, deep-merge, dotted lookup, frontmatter parse/stringify, fs writes, semver parse/compare. |
| `installer/lib/doctor.mjs` | Diff managed files against the lock **that describes the tree** (`readTreeLock` — the gitignored local lock when an overlay shaped this machine's render, else the committed one; #317); always report the rendered `toolkitVersion` + a skew note pointing at `upgrade` + (#374) a `toolkitProvenance` NOTE comparing the lock's `toolkit` block to the running CLI — including **same version, different commit** (a re-cut tag), which the version string cannot express. **That note never touches `ok`**, and `--verify-render`'s comparison stays `files`-ONLY: both would otherwise red every consumer's unpinned-by-default required check on our next merge. Attributes each drifted external file to its source (#125). `--verify-render` (#314) re-renders the **committed** inputs (no overlay) into a temp dir and diffs the result against the **committed, canonical** lock — the working tree is never touched; `--allow-missing --verify-render` is the gate for the lock-only posture (a consumer arming it via `doctor.flags` must pin `doctor.toolkitRef` first, #322; this repo dogfoods it in `tests.yml` — see Dogfood state). Runs the selected stacks' typed `prerequisites:` checks (#129): an unmet `require` fails doctor (exit 1), `recommend` only reports; best-effort (a load failure is a note, not a break). |
| `installer/lib/eject.mjs` | `eject` (release an item, self-cleaning its `include:`), `installRefs` (persist stack/item refs to config), `init` (starter config). |
| `installer/lib/validate.mjs` | Toolkit-developer lint: manifests, frontmatter, placeholder↔declaration sync, agent-skill + `requires:` ref integrity, config `pattern:` compilability + default-match. Deliberately does **no** `files:` `targets:` lint (#364): every malformation of that field is DESTRUCTIVE, and `validate` is developer lint consumers never run over built-in stacks (`render` imports only `validateExternalStacks`), so all four are hard LOAD errors in `toolkit.mjs` instead — a gate a forked toolkit cannot skip. `validate` still REPORTS them, via the load error it catches. |
| `installer/lib/setup.mjs` | `setup` output: `schema/SETUP.md` playbook + inventory generated from the installed toolkit. On an already-configured `cwd`, injects a "Current configuration — update mode" section (live targets/stacks/includes/ejects/effective config/unset required keys/opt-in syrup state) so a re-run curates an update pass. |
| `installer/lib/migrations.mjs` | Migration registry (`MIGRATIONS`) + runner: ordered, idempotent, version-keyed steps `{ version, description, run(cwd) }`; applies steps in `(fromVersion, toVersion]`. Ships the 0.6.0 `.wafflestack.*`→`.waffle.*` rename, the 0.8.0 root→`.waffle/` config move, and the 0.10.0 consumer `bundles:`→`stacks:` key rename (#59). |
| `installer/lib/upgrade.mjs` | `upgrade` flow: lock-vs-toolkit version diff, `CHANGELOG.md` delta printout, run migrations, **reconcile the pinned `toolkitRef` config keys (#372)**, then render (`refreshSources: true` — re-fetch each git pin so a moved ref is observed) + doctor. Diffs re-resolved source commits against the lock to report per-source moves (`diffSources`, #125) and the built-in toolkit's commit move (`diffToolkit`, #374). Also exports the changelog-section parser. **`reconcileToolkitRefPins({cwd, identity, log})` → `pinMoves: [{key, from, to, action: 'bumped'\|'unchanged'\|'left'\|'skipped', reason}]`** rewrites `config.doctor.toolkitRef` / `config.waffle.toolkitRef` in the COMMITTED `.waffle/waffle.yaml` (never the `.local` overlay, #317) to `toolkitPinFromIdentity(identity)` — **iff the value is already a release-shaped pin**. Absent → never introduced; unpinned `github:owner/repo` → left floating; `#main`/`#<sha>`/non-`vX.Y.Z` → left + noted; non-github/local path → untouched; **null pin (unreleased/unverified/#383/checkout-release) → NOTHING written, and the reason logged**. Byte-verbatim (`setScalarIn` splices the pin scalar's own bytes; never `doc.toString()`, which reflows the whole hand-authored file, and never `doc.setIn`, which would CREATE an absent key) + dirty-guarded on the bytes themselves, so a no-op run does not write the file at all. **Call site is load-bearing: AFTER `runMigrations`, BEFORE `renderProject`** — render re-reads `waffle.yaml` from disk, so one run bakes the new pin into `waffle-doctor.yml` and all 9 `waffle-*` skills. Runs on EVERY status incl. `current` (the already-red-CI repo heals). Also returns **`newerRelease: {tag, command} \| null`** when `identity.latestTag > toVersion` — the pinned-CLI escape hatch: it NAMES the pinned command it cannot itself run. **No re-exec, ever** (#373). Both fields ride the render-failed early return too (the config writes already happened). |
| `installer/lib/uninstall.mjs` | `uninstall` / `reinstall` (#182), plus the pure `planUninstall` they share. **The lock is the only authority for what is ours to delete:** `planUninstall` reads `readTreeLock` (the same lock `doctor` drift-checks — the local one on an overlay machine, else the canonical one) and classifies every tracked path as `remove` (present, sha256 still matches what was rendered), `drifted` (present, hand-edited — skipped unless `force`), `absent` (a no-op), or `refused` (a key resolving outside `cwd` — the whole run aborts, deleting nothing). `resolveInside` is the single gate between a lock key and an `fs.rmSync`: it rejects a lexical `../…` escape AND realpaths the deepest existing ancestor, so a key under an in-tree symlink pointing out of the tree cannot carry a delete outside the repo (a symlink travels in a git checkout, and `--force` drops the hash gate, so the escape would otherwise be content-independent); the delete loop re-checks it. It also computes the `.waffle/` meta to drop, the dirs the removals would leave empty (candidate dirs come from *every* tracked path so an orphan dir the consumer emptied is swept too; only a genuinely empty dir is ever pruned), the `.gitignore` lines to strip, and the ejected items to announce — all **without touching disk**, so the dry run and the real run are the same computation and cannot disagree. `uninstall` is that plan plus `fs`; it **defaults to `dryRun: true`** at the library boundary, not just behind the CLI's `--yes`, and returns the plan with `lockRetained` reconciled to what execution actually did (a failed removal keeps the meta, which no plan can foresee). `reinstall` = snapshot the doomed bytes → uninstall(`keepConfig`+`keepLock`, `force: true`) → re-render, restoring the snapshot if either leg fails or throws (`snapshotFiles`/`restoreFiles`, private); `--clean` = uninstall-everything (`keepLockOnSkip: false`) → `init`, with no render and no snapshot to restore. |
| `installer/lib/waffledocs.mjs` | Generate the `.waffle/` overview docs from the render selection: `CHEATSHEET.md` (user-invocable skills) + `TEAM.md` (installed agents), each with a branded, self-contained HTML page (`cheatsheet.html`/`team.html`; hybrid font strategy — Google Fonts link + system-font fallback, fonts the only external ref); plus a static `avatars/<agent>.svg` per agent and the `AVATARS.md` Gravatar-registration manifest (#157), whose per-agent commit emails are derived by `extractBaseEmail`/`deriveAgentEmail` **in lockstep with the delegate skill's prose rules**. Assembles from item frontmatter (skill `user-invocable`/`argument-hint`/`description`; agent `name`/`description`/`skills`/`identity`), substituted with render's resolver. Emitted via `render.mjs`'s `emit()`, so lock-tracked + doctor-checked + pruned. Also exports `collectAgentAvatars({toolkit,project,selection})` (#285) — the same avatar rows + derived emails as `AVATARS.md`, each paired with its rendered SVG, consumed by `avatars-sync.mjs` so the pipeline and the manifest never drift. |
| `installer/lib/avatars-sync.mjs` | Owner-side Gravatar pipeline behind `wafflestack avatars sync`/`status` (#285). `emailHash` (sha256 of lowercased-trimmed email), `syncAvatars` (the pure engine — probe `GET /me/associated-email`, then upload/rate-G/assign over Gravatar v3, or collect the manual "verify then re-run" remainder; HTTP + rasterizer **injected** for tests; per-agent errors isolated into a `failed[]` remainder), `avatarsExitCode` (pure drift/failure exit gate — any `failed` ⇒ 1, `status` + `pending` drift ⇒ 1), `makeGravatarHttp` (fetch-based v3 client), `makeShellRasterizer` (SVG→512px PNG via `rsvg-convert`/`magick`/`convert`/`npx svgexport`), `enumerateAgentAvatars` (roster rows via `collectAgentAvatars`), `runAvatarsSync` (CLI wiring). Token read from `WAFFLE_GRAVATAR_TOKEN`, never rendered or flagged. Never exercised by `npm test` against a real network. |
| `installer/lib/evals.mjs` | Layer 2 eval harness (#109): discover/validate `stacks/*/evals/*.eval.yaml` cases, render a case's target through `renderProject` into a temp project (rendered body → system prompt), drive a model, evaluate transcript assertions (`includes`/`excludes`/`regex` deterministic; `judge` LLM-graded). `Budget` enforces a hard call cap BEFORE each call (`BudgetExceededError` stops the run, remaining cases skipped). `anthropicClient` (fetch-based, no SDK dep) for live runs; `mockClient` for dry-run/tests. Driven by `installer/evals.mjs` (`npm run evals`), never by `npm test`. |
| `installer/lib/list.mjs` | `list` command (#119): compose `loadToolkit`/`loadProjectConfig`/`computeSelection`/`readTreeLock`/doctor-style sha256 into a per-stack per-item state model classifying each item `current`/`outdated`/`not-installed`/`not-installable`/`pending-removal` (the last two = target-scoped syrup none of whose `targets:` this project enables — it cannot render here, so it is reported but never offered as a choice, #364; `pending-removal` is that same file when a prior render already POURED it — it is on disk and in the lock right now, and the next `render` DELETES it, so `list`, the surface consulted BEFORE re-rendering, must announce the deletion rather than call an installed file "not installable". `pending-removal` asks `render`'s OWN prune question — is this live lock path produced by no selected item? — not a bare on-disk check: `itemOutputMatcher` matches the lock by path and is stack-BLIND, so two stacks legally declaring the same output path would otherwise make `list` announce a deletion for a file an enabled stack still produces); render it as a plain aligned agent-parseable table (default, TTY-gated ANSI) or drive a hand-rolled keypress multi-select (`--interactive`, needs a real TTY, applies via `installRefs`+render). Built-in surface only (external `source:` stacks list as a selection error, like `setup`). |
| `installer/lib/prerequisites.mjs` | Typed external prerequisites (#47/#129): normalize a stack's `prerequisites:` list, scope it to a selection (`applicablePrerequisites`, like `requires:`), run each `check` shell command (`runCheck`, exit 0 = satisfied, stdio ignored, timeout-bounded) and bucket by level (`evaluatePrerequisites` → `{unmetRequired,unmetRecommended,met}`). `RENDER_PROBE_KINDS` = `{tool,env}` (the cheap kinds render probes; doctor probes all). Imported by `doctor.mjs` + `render.mjs`. |
| `installer/lib/sources.mjs` | External `source:` resolution (#88/#125): turn a `{name,source,sourceType,ref}` entry into a local toolkit root — a local path read in place, or a git URL fetched at the pinned `ref` into a content-addressed cache (reused unless `refresh`), returning `{root,commit}` for lock provenance. Rejects a leading-`-` git source/ref (argument-injection guard, belt-and-braces with the `--` end-of-options marker). `gitFetch`/`gitResolveCommit` injectable for hermetic tests. |
| `installer/lib/toolkit-ref.mjs` | Toolkit self-identification (#373) — "what am I, and what ref reproduces me?". `resolveToolkitIdentity({toolkitRoot, lsRemote, runGit, allowUnreleased, offline})` → `{status: 'release'\|'unreleased'\|'unverified', version, commit, tag, ref, origin: 'checkout'\|'npm-install'\|'unknown', repo, latestTag, lookupError}`, where `ref` is exactly `github:<owner>/<repo>#<tag>` and non-null **only** when `status === 'release'`. Two origins: a **checkout** (`<toolkitRoot>/.git` exists) resolves via `git describe --tags --exact-match HEAD` — **never touches the network**; an **npm-install** (`npx github:…`, no `.git`) reads the cloned SHA offline from npm's hidden lockfile (`../.package-lock.json` `resolved` `#<sha40>`), then classifies it with ONE `git ls-remote --tags` (**not** the GitHub REST API — its 60/hr unauthenticated limit is a live hazard on shared CI IPs). `lsRemote`/`runGit` are injectable (mirrors `sources.mjs`), so `npm test` is hermetic. Everything degrades to `unverified` rather than throwing: identity failure **fails OPEN** (warn + proceed) so no consumer's CI ever depends on the toolkit's reachability; fail-CLOSED applies only to a *successful* lookup that says "not a release". Offline corroborator: the SHIPPED `CHANGELOG.md` carrying a **non-empty** `## [Unreleased]` section proves the build is past the tag, tightening `unverified` → `unreleased`. Also exports `parseLsRemoteTags` (peeled `^{}` annotated-tag SHA wins; non-`vX.Y.Z` names filtered), `latestReleaseTag`, `toolkitRef`, `repoSlug`/`parseRepoSlug`/`httpsUrl` (normalizes npm's `git+ssh://` → https, or an unauthenticated `ls-remote` would demand an ssh key), `commitFromNpmLockfile`, `shaFromResolved`, `changelogHasUnreleasedEntries`, `changelogLatestRelease`, `formatUnreleasedRefusal(identity, command)`, `formatProvenanceWarning(identity)`. The GATE itself lives in `cli.mjs`, not here — this module only establishes the truth. **Also owns the lock's `toolkit` block (#374)**: `toolkitSource(repo)` (`"owner/repo"` → `github:owner/repo`), `toolkitLockEntry(identity, {prevLock, newFiles, toolkitVersion})` → `{source, sourceType:'git', ref, commit, status}` | `null` when no identity is supplied (the block is then OMITTED — a library caller's lock keeps the pre-#374 shape), `toolkitPinFromLock(lock)` → `github:<owner>/<repo>#<tag>` | `null` (**#372's read-back — never do string surgery on the lock**), `describeToolkitProvenance({lockToolkit, lockVersion, identity})` → `{status: 'not-recorded'|'unpinnable'|'unverifiable'|'match'|'recut'|'mismatch', notes}`. **And the write-side pin (#372)**: `toolkitPinFromIdentity(identity)` — literally `toolkitPinFromLock({toolkit: toolkitLockEntry(identity)})`, so the value `upgrade` writes into `doctor.toolkitRef`/`waffle.toolkitRef` IS the value the render writes into the lock, by construction rather than by promise; it inherits every null rule (unreleased/unverified/#383/**checkout-release** → null → nothing is written) — plus `classifyToolkitRefValue(value)` → `{kind: 'absent'|'unpinned'|'release-pin'|'other-pin'|'not-github', slug?, fragment?, form?: 'shorthand'|'url'}`, the pure rule for which committed values `upgrade` may move (only a `release-pin` in `shorthand` form; a bare `#0.12.0` IS read as one, and is rewritten to the real `v`-prefixed tag). **`form` is the second axis (#386 F3)**: the same pin written as a git URL (`git+https://github.com/o/r#v0.12.0`, `git@github.com:o/r.git#…`) is a valid npx spec no `pattern:` rejects, so it is READ (`form: 'url'`) but NEVER rewritten — normalizing it would change the consumer's fetch transport, and splicing its fragment would write a pin that is not `toolkitPinFromIdentity`. It is reported `left` with the remedy instead; classifying it as `not-github` (which skipped it in SILENCE, diverging the pin from the lock) was the bug. `parseRepoSlug` is the ONE gate on the host — a lookalike (`github.com.evil.com`) or a path segment (`https://evil.com/github.com/x`) is `not-github`, and a bare `owner/repo` never qualifies in either form. **THE INVARIANT: `commit` is recorded IF AND ONLY IF `status === 'release'`** — no field may be a function of a moving HEAD, or the committed lock churns on every commit and names content it did not produce. An `unverified` render CARRIES THE PREVIOUS BLOCK FORWARD when (and only when) the version and the whole `files` map are unchanged, so a network blip cannot rewrite a good `release` block to nulls. |

```js
// render.mjs
export function renderProject({ toolkitRoot, cwd, sourceBaseDir = cwd, toolkitVersion, toolkitIdentity = null, force = false, log, sourceCacheDir, refreshSources = false }) // → { ok, errors, warnings, written, removed, sources, toolkit, identity }  (force overrides the unmanaged-file overwrite guard; refreshSources re-fetches each git source; sourceBaseDir re-bases a relative external `source:` — only doctor --verify-render passes it; toolkitIdentity (#373) is written into the lock's `toolkit` block (#374) and echoed back — ABSENT → the block is OMITTED and the lock keeps its pre-#374 bytes; `toolkit` is the block as WRITTEN, which the `unverified` carry-forward can make differ from `identity`)
export function readLock(cwd)                          // → committed lock | null — the CANONICAL render (committed inputs only, no .local overlay; #317). Optional `sources` block (#125)
export function readLocalLock(cwd)                     // → gitignored .waffle/waffle.local.lock.json | null — the EFFECTIVE render this machine wrote; exists only when the overlay changed an output byte
export function readTreeLock(cwd)                      // → readLocalLock(cwd) ?? readLock(cwd) — the manifest of the files actually ON DISK. Every tree-hashing check reads this (doctor drift, list status, render prune/clobber); --verify-render deliberately does NOT (it stays on the canonical pair)
export function collectUsedKeys(items)                 // → Set<string> placeholder keys referenced by a selection's source content (shared with setup)

// refs.mjs  (pure leaf — no local imports; ref grammar + resolution + dependency closure)
export function itemOutputMatcher(kind, name)         // → (rel:string) => boolean  (predicate matching an item's rendered lock paths; shared by eject + list)
export function normalizeItemRef(ref)                 // → "agents/NAME" | "skills/NAME"
export function itemsOfKind(stack, kind)             // → stack.agents | stack.skills
export function findItems(toolkit, kind, name)        // → [{ stackName, item }] across the toolkit
export function parseRef(raw)                          // → { form: 'qualified'|'item'|'stack', … }
export function resolveRef(toolkit, raw)              // → { type:'stack',name } | { type:'item',kind,name,stack,item,canonicalRef }; throws
export function resolveDepStrict(toolkit, refString, preferStack) // → { kind,name,stack,item }; throws (authored requires: dep)
export function resolveAgentSkill(toolkit, name, preferStack)     // → { kind:'skills',name,stack,item } | null (lenient grant-pointer)
export function closureFor(toolkit, root)            // → [{ kind,name,stack,item }] BFS closure, root first, deduped
export function closureDeps(toolkit, root)           // → ["kind/name"…] non-root deps
export function includeRefMatches(includeRef, kind, name) // → boolean
export function computeSelection(toolkit, project, trackedFiles = new Set()) // → { items:[{stackName,stack,kind,item}], closures, errors, targets:string[], targetSkipped:[{ref,targets}], targetBrokenRequires:[{ref,requiredBy,stackName,targets,optIn}] }  (trackedFiles = prior lock's file paths; ungates already-installed opt-in syrup. targets = the enabled targets this selection was filtered by (project.targets, defaulted to VALID_TARGETS when absent) — carried on the RESULT so a downstream consumer cannot judge scope against a different set than the one that produced these items, #364. targetSkipped = include:d files/ items every one of whose targets: is disabled — nothing renders, so render warns, #364. targetBrokenRequires = a SELECTED item whose requires: edge lands on a scoped-out files/ item: the dependent renders, its declared dependency never does — render warns, since the renderer only walks the edge forward and nothing else would notice, #364/#74. optIn = the dependency is opt-in syrup in ITS OWN stack (dep.stack, not the dependent's), so enabling a target is necessary but NOT sufficient and the warning must state both steps: enabling only the target renders nothing AND clears this condition, so the warning would vanish while the dependency still does not exist. Both eject-filtered. Both are ALWAYS set — neither needs a `?? []` guard.)
export function fileMatchesTargets(item, targets)                            // → boolean  (#364: a files/ item with no targets: renders unconditionally; a scoped one iff ≥1 declared target is enabled. Non-files items always match — agents/skills FAN OUT across targets, they do not gate on them)
export function skippedSyrupCompanions(toolkit, selection) // → [{ fileRef, stackName, companions:["kind/name"…], scopedTo:string[]|null }]  (#74: reverse the requires: edge — opt-in syrup gated out of a selection whose companion waffle IS selected; drives the install/render warning + setup update-mode flag. Reads the enabled targets off `selection.targets` — it was a defaulted third PARAMETER until the default, VALID_TARGETS ("every target enabled"), was spotted as the one value that silently restores pre-#364 behavior for a caller who forgets it; there is now no argument to forget, and it cannot disagree with the selection it is judging. scopedTo=null ⇒ pourable, offer `install <fileRef>`; non-null ⇒ its targets: scope excludes this project, so the pairing CANNOT be completed here — state it WITHOUT a pour command that would render nothing, and never suppress it: dropping the notification is #74 itself, #364)

// template.mjs   (PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g; MAX_SUBSTITUTION_DEPTH = 4)
export function substitute(text, resolve, declared, errors, context, patterns) // → string (patterns: Map<key,RegExp> render-time value validation)
export function formatValue(v)                         // → string (string[] join ", "; else YAML block)
export function placeholderKeys(text)                  // → Set<string>
export function compilePattern(pattern)                // → RegExp (full-match ^(?:…)$; compiles a config key's pattern:)

// toolkit.mjs
export function loadToolkit(rootDir)                   // → { name, description, stacks: Map<name, stack> }  (per stack via loadStack; stack also gains .files [{name,path,binary,targets}] — targets = string[] | null, null = unscoped = renders unconditionally (#364) — .optIn Set<"files/…">, .requires, .prerequisites)
export function loadToolkitWithSources({ builtinRoot, externalStacks = [], cwd, cacheDir, gitFetch, gitResolveCommit, refreshSources = false }) // → merged toolkit; each external stack registered under its name with a .provenance record; cross-source name collision throws (#88/#125)
export function missingRequiredKeys(stack, values, lookup, usedKeys = null) // → string[]  (usedKeys Set scopes to referenced keys)
// loadStack throws on a stale manifest `syrup:` key (renamed to `optIn:` in 0.10.0, #59) so a dropped gate can't un-gate opt-in syrup

// project.mjs
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, LOCAL_LOCK_FILE, EXTENSIONS_DIR   // .waffle/waffle.* consumer paths (one .waffle/ dir owns everything). LOCAL_LOCK_FILE = .waffle/waffle.local.lock.json — gitignored, this machine's render (#317)
export const LEGACY_ROOT_CONFIG_FILE, LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_ROOT_LOCK_FILE // 0.6.0–0.7.x repo-root .waffle.* names
export const LEGACY_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE, LEGACY_LOCK_FILE, LEGACY_EXTENSIONS_DIR // pre-0.6.0 .wafflestack.* names
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir']
export const HARNESS_BUILTINS                          // per-target { assistantName, attributionPath, skillsDir } + target-independent CI-dispatcher scalars { actionRef, actionVersion, apiKeySecret } (#131)
export const HARNESS_PATTERNS                          // injection-guard regexes for actionRef/actionVersion/apiKeySecret (reject `${{`, quotes, newlines); seeded into render's pattern map + checked by validate (#131)
export function loadProjectConfig(cwd, notes = [], { canonical = false } = {}) // → { targets, stacks, externalStacks, include, values, eject }; merges the .local overlay over the committed config UNLESS `canonical` (#317 — the committed-inputs-only config the lock is hashed from); splits `stacks:` bare names vs `{name,source,ref}` entries; reads legacy `bundles:` as `stacks:` fallback (stacks: wins); pushes legacy-read deprecation notes
export function classifyStackSource(source)            // → 'git' | 'path'  (URL scheme / scp `user@host:` / `.git` suffix ⇒ git, else local path)
export function normalizeStackEntries(raw)             // → { stacks:[name…], externalStacks:[{name,source,sourceType,ref}] }; validates shape, unique names, git-needs-ref / path-forbids-ref, unknown-key rejection (#88)
export function renameLegacyStacksKey(doc)             // in-place rename of a YAML doc's `bundles:` key → `stacks:` (comment-preserving); → true if renamed (shared by installRefs + the 0.10.0 migration)
export function resolveConfigFile(cwd)                 // → { file, legacy, note } (prefers .waffle/waffle.yaml, else legacy .waffle.yaml, else .wafflestack.yaml)
export function resolveLocalConfigFile(cwd)            // → { file, legacy, note }
export function resolveLockFile(cwd)                   // → { file, legacy, note }
export function localLockPath(cwd)                     // → absolute .waffle/waffle.local.lock.json (no legacy generations — born inside .waffle/)
export function migrateLegacyDotfiles(cwd)             // chain .wafflestack.* → .waffle.* → .waffle/waffle.* in place; → [{ from, to }] (idempotent)
export function staleGitignoreEntries(cwd)             // → stale root .waffle.* / legacy .wafflestack.* lines still in .gitignore (self-clearing reminder)
export function gitignoreMentions(cwd, entry)          // → boolean; literal basename substring test (no glob semantics). render uses it to warn when it writes a local lock .gitignore doesn't cover (#317)
export const GITIGNORE_MARKER = '# wafflestack'        // comment prefixing wafflestack's appended .gitignore block
export function ensureGitignoreEntries(cwd, entries)   // idempotent append of approved .gitignore lines (--gitignore/setup); → entries added (skips present, preserves content)
export function recommendedGitignoreEntries(toolkit, project) // → baseline offer: [.waffle/waffle.local.yaml, .waffle/waffle.local.lock.json, + resolved git.worktreesDir when an enabled stack declares it]
export function makeResolver(stack, values, target)   // → (key: string) => value | undefined

// util.mjs
export function sha256(content)                        // → hex string
export function isBinary(buffer)                        // → boolean (NUL byte in first 8000 → binary; sets files item .binary)
export function readYaml(file)                         // → parsed YAML
export function exists(file)                           // → boolean
export function writeFileEnsuringDir(file, content)    // mkdir -p + write
export function deepMerge(a, b)                         // → merged (b wins; arrays/scalars replace)
export function lookupPath(obj, dotted)                // → value | undefined
export function parseFrontmatter(text)                 // → { data, body }
export function stringifyFrontmatter(data, body)       // → string
export function parseVersion(v)                        // → [major, minor, patch] | null  (ignores pre-release suffix)
export function compareVersions(a, b)                  // → -1 | 0 | 1  (unparseable sorts low)

// doctor.mjs
export function doctor({ cwd, toolkitVersion, toolkitIdentity = null, allowMissing = false, verifyRender = false, toolkitRoot = null, sourceCacheDir = defaultSourceCacheDir() }) // → { ok, modified, missing, notes, attribution, allowMissing, nothingPresent, prerequisites, render, configProblems, toolkitProvenance }  (render = the --verify-render result, inert { evaluated:false } unless verifyRender; notes always name the rendered toolkitVersion; unmet `require` prerequisite fails ok; attribution maps external files → source label; toolkitProvenance (#374) compares the lock's `toolkit` block to this CLI and is a **NOTE ONLY — it is DELIBERATELY absent from `ok`**, because `doctor.toolkitRef` ships UNPINNED so an error would red every consumer's required check the moment anything merges to main, and `--verify-render` already gates on CONTENT)

// migrations.mjs
export const MIGRATIONS                                // → [{ version, description, run(cwd) }]  (ordered, idempotent; 0.6.0 dotfile rename, 0.8.0 config move, 0.10.0 bundles:→stacks:)
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) // → steps in (from, to], ascending
export function runMigrations({ cwd, fromVersion, toVersion, migrations, log }) // → steps that ran; runs each step.run(cwd) in order

// upgrade.mjs
export function upgrade({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, migrations, changelog, sourceCacheDir, log }) // → { ok, status, fromVersion, toVersion, identity, changelogDelta, migrationsRun, render, doctor, sourceMoves, toolkitMove, notes }  (re-renders with refreshSources: true; `status` enum UNCHANGED — #372 branches on it)
export function diffSources(oldSources, newSources)    // → [{ name, ref, sourceType, from, to, status:'moved'|'added'|'removed' }]  (per-source commit moves vs the lock, #125)
export function diffToolkit(prev, next, { fromVersion, toVersion }) // → { from, to, fromRef, toRef, fromVersion, toVersion, fromStatus, toStatus, status:'moved'|'unchanged'|'added'|'removed'|'unknown' } | null  (the BUILT-IN toolkit's commit move, #374 — mirrors diffSources. 'moved' at the SAME version = a re-cut tag, which is #372's self-upgrade trap said out loud; 'unknown' = one side recorded no commit, so no move can be honestly asserted)
export function changelogBetween(text, fromVersion, toVersion) // → markdown of `## [X.Y.Z]` sections in (from, to], newest first | null

// uninstall.mjs   (#182 — the only destructive command; the lock is the sole authority for what is ours)
export function planUninstall({ cwd, toolkitRoot = null, force = false, keepConfig = false, keepLock = false, keepLockOnSkip = true }) // → { lock:'canonical'|'local'|null, lockFile, remove, drifted, absent, refused, meta, prunedDirs, gitignore, ejected, lockRetained, notes }  (pure — touches no disk, so the dry run and the real run are the same computation; lock:null ⇒ no lock ⇒ uninstall hard-fails)
export function uninstall({ cwd, toolkitRoot, force = false, allowMissing = false, keepConfig = false, keepLock = false, keepLockOnSkip = true, dryRun = true, log }) // → { ok, dryRun, plan, removed, skipped, errors }  (dryRun DEFAULTS TRUE at the library boundary; ok = no errors, so a run that only SKIPPED drifted files is ok:true; errors are returned, never logged — the caller prints them once; the returned plan's lockRetained is the OUTCOME, not the prediction)
export function reinstall({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, clean = false, force = false, log }) // → { ok, uninstall, render, initialized, restored, errors }  (refresh: snapshot → uninstall(keepConfig+keepLock, force:true) → renderProject, rolling the snapshot back if either leg fails or throws; clean: uninstall-everything(keepLockOnSkip:false) → init, render null)

// eject.mjs
export function eject({ cwd, item })                   // → { ref, released }  (also strips a matching include: entry)
export function installRefs({ toolkitRoot, cwd, refs, log }) // → { added, closures }  (persist refs; caller renders after)
export function init({ cwd })                          // → configFile path

// validate.mjs
export function validateToolkit(rootDir)               // → string[] (problems; [] = clean)  (also lints prerequisites kind/level/fields + items: refs, and the harness.* built-in defaults against HARNESS_PATTERNS)
export function validateStack(toolkit, stack, ctx)     // → string[] (one stack's problems; reused for external-stack lint)
export function validateExternalStacks(toolkit)        // → string[] (lint only the source-bearing stacks; render calls this pre-write, #126)
export function validateHarnessBuiltins()              // → string[] (reserved harness.* defaults must satisfy HARNESS_PATTERNS)

// setup.mjs
export function setupGuide(toolkitRoot, toolkitVersion, cwd) // → string (playbook + [current-config update section when cwd is already configured] + inventory)
export function toolkitInventory(toolkit, version)      // → string

// waffledocs.mjs
export function generateWaffleDocs({ toolkit, project, selection, errors = [] }) // → [{ rel, content }] for .waffle/{CHEATSHEET.md,cheatsheet.html,TEAM.md,team.html,AVATARS.md,avatars/<agent>.svg}; each set omitted when its item set is empty
export function agentFlavor(name)                      // → deterministic per-agent palette/persona seed (name-hashed)
export function agentAvatarSvg(name, skillCount = 0, opts) // → inline wafflebot avatar SVG for team.html (#161)
export function extractBaseEmail(gitCmd)               // → the `-c user.email=` value of a resolved git.cmd, else null (no bot identity / unresolved placeholder) (#157)
export function deriveAgentEmail(baseEmail, slug)      // → base plus-addressed with +<slug>, or verbatim when it cannot subaddress (*.noreply.github.com, local part already has `+`); null base → null (#157)
export function withIdentity(gitCmd, displayName, email) // → git.cmd with `-c user.name=`/`-c user.email=` swapped in place, every other flag preserved (delegate rule 4) (#157)
export function collectAgentAvatars({ toolkit, project, selection }) // → { rows:[{name,email,svg,skillCount,overridden,…}], git }  (shared avatar-row enumeration, #285; the same rows/emails AVATARS.md describes, consumed by avatars-sync so pipeline + manifest never drift. Refactor #289 shares makeDocSubstitutor/enumerateAgents with generateWaffleDocs — private, byte-identical output)

// avatars-sync.mjs   (GRAVATAR_BASE = 'https://api.gravatar.com/v3'; TOKEN_ENV = 'WAFFLE_GRAVATAR_TOKEN')
export function emailHash(email)                       // → sha256 hex of lowercased-trimmed email (Gravatar email id)
export async function syncAvatars({ agents, token, http, rasterize, log, mode = 'sync' }) // → { synced, pending, skipped, failed, mode }  (probe GET /me/associated-email → upload/rate-G/assign, or collect unverified into pending; throws NO_TOKEN-coded error on falsy token; per-agent errors isolated into failed[])
export function avatarsExitCode({ mode, pending, failed }) // → 0|1  (any failed ⇒ 1; status + pending drift ⇒ 1; else 0 — pure, so the gate is unit-testable)
export function enumerateAgentAvatars({ toolkitRoot, cwd }) // → { rows:[{name,email,svg,…}], git }  (selection's avatar rows via collectAgentAvatars)
export function makeGravatarHttp(fetchImpl = globalThis.fetch) // → v3 client { getAssociatedEmail, uploadAvatar, setRating, associateAvatarEmail }
export const RASTERIZERS                                // ordered SVG→PNG converters probed by --version: rsvg-convert, magick, convert, npx svgexport
export function makeShellRasterizer()                  // → async (svg) => Buffer  (512px PNG via first available converter; throws if none on PATH)
export async function runAvatarsSync({ toolkitRoot, cwd, mode = 'sync', env = process.env, log, http, rasterize }) // → syncAvatars result  (wires real client + shell rasterizer unless injected; short-circuits with no bot identity; status mode needs no rasterizer)

// list.mjs
export const STATUS                                    // { CURRENT:'current', OUTDATED:'outdated', NOT_INSTALLED:'not-installed', NOT_INSTALLABLE:'not-installable', PENDING_REMOVAL:'pending-removal' }  (NOT_INSTALLABLE = target-scoped syrup this project cannot render; PENDING_REMOVAL = the same, but a prior render POURED it — on disk + in the lock now, DELETED by the next render — #364)
export function computeListModel({ toolkitRoot, cwd, toolkitVersion }) // → { toolkitName, toolkitVersion, lockVersion, hasLock, hasConfig, versionSkew, configError, notes, errors, stacks:[{name,description,enabled,rows}], counts }
export function formatListTable(model, { color = false } = {})        // → aligned plain-text table (trailing \n); color gates ANSI
export function selectableChoices(model)               // → actionable rows (everything not `current` and not scoped out — neither `not-installable` nor `pending-removal`, since nothing the picker can DO changes either; `outdated` pre-checked)  (pure)
export function interactiveSelect(model, { input = process.stdin, output = process.stdout } = {}) // → Promise<{ applied, refs, reason? }>  (keypress multi-select; TTY-guarded by caller)

// prerequisites.mjs
export const PREREQ_KINDS                              // ['tool','secret','scope','label','setting','service','env']
export const PREREQ_LEVELS                             // ['require','recommend']
export const RENDER_PROBE_KINDS                        // Set{'tool','env'} — the cheap kinds render probes (doctor probes all)
export function normalizePrerequisites(raw)            // → [{ kind, name, description, check, level, items:["kind/name"…] }]  (tolerant; linted by validate)
export function runCheck(check, cwd, { timeoutMs = 15000 } = {}) // → { ran, ok }  (shell check, exit 0 = ok, stdio ignored, timeout-bounded)
export function applicablePrerequisites(toolkit, selection) // → flat [{ …prereq, stackName }] scoped to the selection, deterministic order
export function evaluatePrerequisites(prereqs, cwd, { kinds = null, timeoutMs } = {}) // → { unmetRequired, unmetRecommended, met }
export function formatPrereq(p)                        // → one actionable CLI line

// sources.mjs
export function resolveSource(ext, { cwd, cacheDir, gitFetch, gitResolveCommit, refresh = false } = {}) // → { root, commit }  (local path in place, or git fetched at pinned ref into a content-addressed cache; rejects leading-`-` source/ref)
export function resolveSourceRoot(ext, opts)           // → root path only (back-compat wrapper)
export function gitFetchCheckout(source, ref, dest)    // default git clone + checkout <ref> (injectable)
export function gitHeadCommit(dir)                     // → resolved HEAD SHA (injectable; lock provenance)
export function defaultSourceCacheDir()                // → os.tmpdir()/wafflestack-sources
```

Import graph (`util.mjs` and `refs.mjs` are pure leaves; `template.mjs` depends only on `yaml`;
`sources.mjs`→util and `prerequisites.mjs`→refs are near-leaves):

```
cli.mjs      → render, doctor, eject, list, validate, setup, upgrade, uninstall, toolkit, prerequisites, project, avatars-sync (dynamic)  (command dispatch)
render.mjs   → refs, template, toolkit, project, util, waffledocs, sources, validate, prerequisites
waffledocs.mjs → template, project, util, refs
avatars-sync.mjs → toolkit, project, refs, waffledocs
doctor.mjs   → render, project, toolkit, refs, prerequisites, sources, util
eject.mjs    → render, toolkit, refs, project, util
validate.mjs → toolkit, template, refs, prerequisites, project, util
setup.mjs    → toolkit, render, project, refs, prerequisites, util
upgrade.mjs  → render, doctor, migrations, project, util
uninstall.mjs → render, eject, toolkit, project, util
list.mjs     → toolkit, render, refs, project, util
migrations.mjs → util
toolkit.mjs  → util, refs, sources, prerequisites, project (VALID_TARGETS only — the load-time targets: name check, #364; project.mjs imports no sibling but util.mjs, so no cycle)
prerequisites.mjs → refs
sources.mjs  → util
project.mjs  → util
template.mjs → (yaml)
refs.mjs     → (none)
util.mjs     → (none)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Usage:
`wafflestack <init|setup|list|install|render|bake|upgrade|doctor|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]`
(`USAGE`, `cli.mjs:35`).

Dispatch and exit contract:

- `help` / `--help` / `-h` print the banner, usage and a one-line description per command and per
  listed flag to stdout, exit 0 (#187, `helpText` `cli.mjs:271`).
- `--help`/`-h` anywhere after a command prints that same full help instead of running the command
  — intercepted before the switch (`cli.mjs:43`), so `uninstall --help` explains rather than
  deletes. It is the whole help text, not a per-command page.
- An unknown command, and bare `wafflestack` with no command, print the banner + usage to stderr
  and exit 1. Bare invocation is deliberately on the error path so a script passing an empty
  argument sees a failure.
- Flags are spliced out of `args` by name (`extractFlag` `cli.mjs:347`, `extractCwd` `cli.mjs:338`),
  so an unrecognized flag is never consumed and survives as a positional. What happens to it is
  per-command, not uniform: `render`/`bake`/`upgrade`/`list`/`uninstall`/`reinstall` reject any
  leftover arg via their takes-no-refs guard (exit 1); `install`/`eject` treat it as a ref, so
  resolution fails (exit 1); `avatars` rejects a first arg that is not `sync`/`status`;
  `init`/`setup`/`doctor`/`validate` have no guard and silently ignore it.

| Flag | Commands | Effect |
|------|----------|--------|
| `--cwd DIR` | every command | run against DIR instead of process cwd; spliced out before ref parsing (`cli.mjs:29`) |
| `--help`, `-h` | every command | print help to stdout, exit 0; intercepted before dispatch |
| `--force` | `render`, `bake`, `install`, `reinstall` | override render's unmanaged-file overwrite guard |
| `--force` | `uninstall`, `reinstall --clean` | also delete drifted (hand-edited) managed files |
| `--gitignore` | `init`, `render`, `bake`, `install` | append the recommended `.gitignore` entries |
| `--yes` | `uninstall` | actually delete; without it `uninstall` is a dry run |
| `--yes` | `reinstall` | required by `--clean` only; a plain refresh needs none |
| `--keep-config` | `uninstall` | keep `.waffle/` — config, overlay, `extensions/` and both locks |
| `--clean` | `reinstall` | wipe incl. the config, then re-scaffold via `init` (requires `--yes`) |
| `--allow-missing` | `doctor`, `uninstall` | tolerate managed files absent from disk |
| `--verify-render` | `doctor` | also check the committed config still renders what the lock records |
| `--interactive` | `list` | keypress multi-select; needs a real TTY, else degrades to the table |
| `--no-color` | `list` | suppress ANSI (not listed in `help`'s flag block — #359) |
| `--allow-unreleased` | every command (spliced globally, before any takes-no-refs guard) | #373: suppress the release gate's REFUSAL — write files from a toolkit that is not a release (a working tree, or an unpinned `npx github:…` fetch of the default branch). Env twin: `WAFFLESTACK_ALLOW_UNRELEASED=1` (`1`/`true`/`yes`). It suppresses the refusal, **not the truth** — identity still resolves to `unreleased` — and it short-circuits the network lookup, which is what keeps `npm test` and every local `render` offline. Toolkit development only; a consumer pins the ref instead. |

Release gate (#373, `cli.mjs`; truth established in `toolkit-ref.mjs`). Before writing files from
toolkit content, the CLI resolves what it IS and **refuses** when it is provably not a release,
naming the exact pinned command. The scoping is the load-bearing decision — gate the write path
only, or the shipped unpinned-by-default `waffle-doctor.yml` goes red for every consumer:

| Gated (refuse when `unreleased`, exit 1) | Not gated |
|---|---|
| `render` / `bake`, `install`, `upgrade`, `reinstall` — they write files from toolkit content | plain `doctor` — pure hash-vs-lock, reads no toolkit content, correct from any toolkit. Gets the **offline** identity (no network) purely so its version-skew remedy names a command that works. |
| `doctor --verify-render` — it *renders* (the #314 gate that #373 broke) | `list`, `setup` — read-only reports ⇒ `formatProvenanceWarning` to stderr, never a refusal |
| `list --interactive`, only once a selection is applied (`installRefs` + `runRender`) | `init`, `eject`, `uninstall`, `validate`, `avatars`, `help` — never read toolkit content |

`unverified` (offline / no git / unreadable npm lockfile) **proceeds with a warning** — fail open on
ignorance. The resolved identity is threaded to `renderProject({toolkitIdentity})` /
`upgrade({toolkitIdentity})` / `reinstall({toolkitIdentity})` and echoed on their results; the lock
does **not** yet carry it (that is #374).

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.waffle/waffle.yaml` (targets / stacks / include / config / eject scaffold, creating `.waffle/`); errors if one exists at any generation. `--gitignore` appends the two entries knowable before any stack is chosen — `.waffle/waffle.local.yaml` and `.waffle/waffle.local.lock.json` (`cli.mjs:189`); the worktrees dir is added later by `install --gitignore` once a stack declaring it is enabled. `eject.mjs:200` |
| `setup` | Print `schema/SETUP.md` playbook + inventory generated from the installed toolkit; when `--cwd` (or the invoked repo) is already configured, also prints a live "Current configuration — update mode" section. `setup.mjs:25` |
| `list` | Report the whole toolkit surface per stack/item vs. what this repo has installed (`installed & current` / `out of date` / `not installed` / `not installable` / `PENDING REMOVAL` — the last two name a target-scoped syrup file this project cannot render, and both are excluded from the `--interactive` picker's choices; `PENDING REMOVAL` is the case where the file was already poured under an older `targets:` and is still on disk + in the lock, so the next `render` DELETES it — `list` runs before a re-render, so it must not report an installed file as merely "not installable", #364) as an aligned plain table (default — agent/CI-safe; ANSI only on a TTY, `--no-color` opts out). `--interactive` (real TTY both ends) drives a keypress multi-select that installs/updates the chosen refs then renders; degrades to the table without a TTY. Takes no refs. `list.mjs`, `cli.mjs:196` |
| `install [ref…]` | Persist each ref to config (stack → `stacks:`, item → canonical `include:`; resolves up front, reports pulled-in deps), then render. Bare `install` = `render`. `--force` overrides the overwrite guard; `--gitignore` appends recommended entries after a clean render. `eject.mjs:98` |
| `render` | Regenerate all managed files verbatim for the current selection; delete now-unrendered managed files; write lock. Rejects positional refs. Refuses to overwrite a pre-existing file not tracked by the lock unless `--force` (guard `render.mjs:245`). Exit 1 on error. `--gitignore` appends recommended entries after a clean render (`ensureGitignoreEntries` + `recommendedGitignoreEntries`, `offerGitignore` in `cli.mjs`). `render.mjs:71` |
| `bake` | Pure alias for `render` — a fall-through case sharing its body, flags and no-refs guard (the guard names whichever word was typed). `cli.mjs` (#176) |
| `upgrade` | Read lock `toolkitVersion`, print `CHANGELOG.md` delta to the invoked version, run migrations in `(from, to]`, then render (re-fetching external source pins, reporting per-source commit moves **and the built-in toolkit's own commit move, #374 — including at an unchanged version, which is #372's self-upgrade trap**) + doctor. Missing lock/version degrades to render + doctor with a note. Rejects positional refs. Exit follows doctor. `upgrade.mjs:33` |
| `doctor` | Diff managed files vs lock; always report the rendered `toolkitVersion` + a skew note + the `toolkit` provenance note (#374, **warning only — never fails the gate**); run the selected stacks' typed `prerequisites:` checks. Exit 1 on drift OR an unmet `require`-level prerequisite (`recommend` only reports; `--allow-missing`: only modified files count as drift). `doctor.mjs:83` |
| `eject <skills/NAME\|agents/NAME\|files/PATH>` | Add to `eject:`, strip any matching `include:` entry, drop the item's files from the lock; files stay in place, now project-owned. `eject.mjs:25` |
| `uninstall` | The toolkit's only destructive command. Removes the whole install, driven entirely off the lock (`readTreeLock` — the local lock when an overlay shaped this tree, else the canonical one). Per tracked path: deleted only if the lock tracks it AND its sha256 still equals what was rendered (the same compare `doctor` makes); `drifted` (hand-edited) is skipped and reported unless `--force`; an unreadable file classifies as drifted too (an unverifiable hash cannot prove the file is ours, so the read-only preview classifies it instead of throwing `EACCES`); `absent` is a no-op (`--allow-missing` only silences the per-file line). Then: remove the `.waffle/` meta (config, overlay, both locks, `extensions/`) — the one exception to the lock invariant, since `extensions/` holds consumer-authored render *inputs* the lock cannot track, so `--keep-config` spares them and keeps both locks with them (`computeSelection` keeps a poured opt-in syrup selected *because its path is in the lock*, so a config without its lock is half a selection and the next `render` silently un-pours) — prune directories the removals left empty (bounded to `cwd`, only when genuinely empty: a `.claude/` still holding consumer files survives), strip wafflestack's own `.gitignore` lines + an orphaned `# wafflestack` marker (exact-line match, `removeGitignoreEntries`), and announce ejected items as project-owned and left in place. REFUSES the whole run, deleting nothing: an absent lock, or a lock key that resolves outside `cwd` — both a lexical `../…` escape and a key whose parent directory is an in-tree SYMLINK pointing out of the tree (`resolveInside` realpaths the deepest existing ancestor, since `path.resolve` collapses `..` textually but does not follow links; re-checked in the delete loop, narrowing the TOCTOU window). PARTIAL RUNS are not symmetric: a failed removal keeps the whole `.waffle/` meta and leaves `.gitignore` untouched, while a skip keeps only the locks — the config, overlay and `extensions/` are still deleted and the `.gitignore` lines still stripped (#359). Lock retention is one decision, reconciled after the removals run: `uninstall` returns the plan with `lockRetained` set to what execution actually did (plan-time it is only a prediction — a skip, or an explicit `keepLock`), and the skip messages read that one answer, so the report can never say "now project-owned" about a file the surviving lock still tracks. Read `lockRetained` off the result, not off a bare plan. The post-run report names what was actually removed/pruned, not what the plan predicted. Dry run until `--yes` (the CLI is non-interactive by design — the flag is the consent). Exit 1 only on an error (absent lock, refused key, a removal or prune that failed); a run that merely skipped drifted files exits 0 although the uninstall is incomplete (#359). Rejects positional refs (points at `eject`). `uninstall.mjs` (#182) |
| `reinstall` | Default = refresh in place: snapshot the bytes of every file the uninstall leg will delete, uninstall with `keepConfig`/`keepLock` and `force: true`, then re-render the same selection. Keeping the lock is load-bearing, not tidy — `computeSelection` keeps an already-poured opt-in (syrup) `files/` item selected *because its path is in the lock*, so dropping it would silently un-pour any syrup not also named in `include:`. Drifted files are deleted rather than skipped (any plain `render` rewrites a managed path regardless of hash, so a skip would preserve nothing), which is exactly why they are snapshotted with the rest. Needs no `--yes`: every file it removes, the render writes straight back — and if either leg fails (the uninstall leg reporting a failed removal, or the render leg returning `ok: false` or throwing) the snapshot is restored and the run says so; a file the snapshot could not READ is named as gone rather than certified restored. `--clean` = wipe to empty: uninstall everything incl. the config (with `keepLockOnSkip: false`, so a skipped hand-edited file is announced project-owned instead of being promised a `--force` re-run the missing lock could not honour), then `init` a starter scaffold; no render (nothing is selected), and it requires `--yes`. `--force` overrides whichever safety refusal is live on the path taken (render's unmanaged-clobber guard on a refresh; uninstall's drift skip on `--clean`). Both shapes run the uninstall leg, so both need a lock: a configured-but-never-rendered repo (config, no lock) fails there, exit 1 (#359). `uninstall.mjs` (#182) |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline (#285). Enumerate the installed agent roster with its derived commit emails (same derivation as `AVATARS.md`), and for each email **already verified** on the Gravatar account: `sync` rasters the avatar SVG→512px PNG and uploads/assigns it (rating G); `status` only probes and reports drift (an installed agent whose address is unregistered). Reads an owner-only OAuth2 token from `WAFFLE_GRAVATAR_TOKEN`; Gravatar has no add/verify-email API, so an unverified address is reported as a manual "verify then re-run" remainder. HTTP + rasterizer are injected (unit-tested with mocks). `status` exits 1 on drift; a per-agent `failed` remainder (transient API errors, isolated so one failure never aborts the roster) exits 1 in either mode (`avatarsExitCode`). `avatars-sync.mjs`, `cli.mjs:222` |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter complete, placeholder↔declaration sync, agent-skill/`requires:` refs resolve, `prerequisites:` fields + `items:` refs, harness.* defaults match their guards. Exit 1 on problems. `validate.mjs:77` |
| `help` | Print the banner, usage, one line per command and one line per listed flag to stdout; exit 0. Also reachable as `--help` / `-h`, before or after a command (intercepted before dispatch, `cli.mjs:43`). The rendered flag block lists every flag except `--no-color` (#359). `helpText` `cli.mjs:271` (#187) |

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, and `requires:`) names something installable.
Grammar + resolution live in `refs.mjs` (`parseRef` `refs.mjs:64`, `resolveRef` `refs.mjs:91`).
The item kind is one of `agents`, `skills`, `files` (a `files/` payload — a workflow or script
byte/text-copied to that repo-relative path).

| Form | Example | Meaning |
|------|---------|---------|
| stack | `github-workflow` | a whole stack (unknown name → error) |
| item | `skills/issue`, `agents/project-manager`, `files/.github/workflows/waffle-hygiene.yml` | an item; unqualified, must be unique toolkit-wide |
| qualified | `engineering-team/skills/webapp-security-audit` | an item in a named stack (disambiguates cross-stack name collisions) |

A bare item name resolves only when unique across the toolkit; otherwise it must be
stack-qualified. `canonicalRef` is the minimal re-resolvable form (qualified only when
ambiguous) — that is what `install` writes to `include:`.

Render selection (`computeSelection`, `refs.mjs:252`):

```
rendered = union(items of enabled stacks:) ∪ closure(each include: item) − eject:
```

- Opt-in syrup gate — a stack's `optIn:` `files/` items are excluded from default expansion
  unless the path is already lock-tracked (`trackedFiles`, from the prior lock via
  `renderProject`) or explicitly `include:`-ed (`refs.mjs:268`) — an existing install keeps
  updating, a fresh enable never silently arms a sensitive workflow. When a gated opt-in syrup
  file's `requires:` companion IS in the selection (its skill is rendering), `render`/`install`
  emits a warning naming the file + the exact `wafflestack install files/<path>` pour command
  (`skippedSyrupCompanions`, `refs.mjs`) — the non-interactive stand-in for the both/one/neither
  question `schema/SETUP.md` step 2 requires an agent to ask (#74). Warn-only by design; the CLI
  stays non-interactive. A **target-scoped** companion is not exempt from this (#364): it cannot be
  poured here, so the warning withholds the `install` command — but it is still ISSUED, naming the
  scope instead (`scopedTo`). Suppressing it would hand the consumer the manual half of the flow,
  deny them the automated half, and say nothing: #74 itself, wearing a new hat. `setup`'s playbook
  states the pairing on the same file for the same reason — its scope note must not silently outrank
  a pairing it never learned about.
- Target scope gate (#364) — a `files:` item that declares `targets:` is selected only when the
  project enables ≥1 of them (`fileMatchesTargets`); one with no `targets:` renders
  unconditionally, the pre-#364 contract. The gate sits in `addItem`, the choke point ALL three
  entry paths funnel through, so an explicit `include:` cannot bypass a scope — and it sits
  *after* the opt-in `trackedFiles` re-admission, so scope overrides tracking: a poured file whose
  last target is disabled leaves the selection, drops out of `outputs`, and is **pruned** by the
  same stale-removal loop that handles a dropped stack. An `include:`d file skipped this way is
  reported (`selection.targetSkipped`) and `render` warns; a stack-expansion skip is silent, like
  the opt-in gate. Agents and skills are never scoped — they fan out across targets.
  The gate is **loud on every path where silence would hide something**, because the prune DELETES
  files from a consumer's repo: a `requires:` edge landing on a scoped-out file warns
  (`selection.targetBrokenRequires` — the dependent renders, its dependency never does, and the
  renderer only walks that edge forward, so nothing else would notice), and when that dependency is
  **opt-in** syrup the warning names BOTH steps — enabling a target is necessary but not sufficient,
  since the opt-in gate still holds the file back, and doing only the first step renders nothing
  while clearing the scope-broken condition that produced the warning (a remedy that silences its
  own warning without fixing anything is worse than no remedy); a scoped-out opt-in
  companion still states its #74 pairing, minus the pour command; `list` reports an already-poured
  scoped-out file as `PENDING REMOVAL`, not "not installable", since it is on disk NOW and the next
  render destroys it; and **every** malformation of `targets:` is a hard LOAD error, not a `validate`
  lint a forked toolkit could skip — an empty `targets: []`, AND an unknown target NAME. The name
  check is not cosmetic: `[claud]` resolves to nothing, so it IS `targets: []` spelled differently
  and prunes the poured copy out of every consumer's tree; and even a *partially*-valid
  `[claude, codxe]` prunes it out of a **codex** consumer's tree. There is no inert case — a
  surviving valid name does not make the entry safe, it only narrows WHICH consumers it destroys —
  so a rule keyed on "resolves to zero valid names" would have closed only half the hole. The
  consumer's own config has always hard-errored on an unknown target name (`project.mjs`); the
  manifest is the side that can DESTROY a file, so it is not the side that gets to be lenient.
  `PENDING REMOVAL` is itself held to that bar: it asks `render`'s own prune question (is this live
  lock path produced by NO selected item?) rather than a bare on-disk check, because `owned` matches
  the lock by PATH and is stack-BLIND — two stacks may legally declare the same output path, so a
  bare check would announce a deletion for a file an enabled stack still produces. A status that
  exists to stop a false deletion claim must not make one.
  Two invariants hold throughout: an **unscoped** file can never be pruned (`fileMatchesTargets`
  short-circuits on `!item.targets`, and the string form always parses to `targets: null`), and an
  **ejected** file is never pruned or warned about (`eject` drops it from both locks, so the prune
  never sees it and it is project-owned from then on).
  **Known gap (#371):** the mirror-image case on the NOT_INSTALLED path — a poured file whose STACK
  was deselected IS pruned, and `list` still reports it "not-installed" — is a *hidden* deletion
  (a lie of omission) rather than an invented one. It predates #364 and needs the offerability split
  and target fan-out #371 carries; it is not closed here.
- Dependency closure — installing an item pulls its transitive cross-stack deps (BFS, deduped
  by stack+kind+name). Direct deps of a node = agent frontmatter `skills:` (lenient — absent
  or ambiguous names skipped) + stack `requires:[kind/name]` (strict — a dangling entry is a
  toolkit bug). The closure is recomputed every render, never persisted.
- Grouping — selected items are grouped by owning stack; config/env checks run per stack over
  only the selected items. Required-config is scoped to placeholder keys the selected items
  reference (`missingRequiredKeys` `usedKeys`), so a partial install does not demand config only
  a stack's other items use. Env prerequisites still warn when any item from a stack renders.
- `eject:` wins over both `stacks:` and `include:`; `eject` self-cleans a matching `include:`.

## External stack sources

A `stacks:` entry is either a bare built-in name or a `{ name, source, ref }` mapping naming a
third-party source (#88). Parsed by `normalizeStackEntries` (`project.mjs`), resolved at render by
`loadToolkitWithSources` → `resolveSource` (`sources.mjs`). Authoring guide:
`schema/AUTHORING-EXTERNAL-STACKS.md`.

| Field | Rule |
|-------|------|
| `name` | required; unique across ALL `stacks:` entries (built-in + external); a collision is a hard error naming both sources |
| `source` | required; a git URL (`https://`, `ssh://`, `git@host:owner/repo`, `*.git`) or a local filesystem path (`classifyStackSource`) |
| `ref` | git source: REQUIRED (tag/branch/commit); local path: MUST be omitted |

- Resolution — a git source is fetched at the pinned `ref` into a content-addressed cache, reused
  unless `refresh`; a local path is read in place. `name` selects `stacks/<name>/` (toolkit-root
  source) or a root `stack.yaml` (single-stack source).
- Security — a git `source`/`ref` beginning with `-` is rejected (argument-injection guard),
  belt-and-braces with the `--` end-of-options marker at the git exec site.
- Provenance — external files are recorded in the lock `sources` block (`{ name, source,
  sourceType, ref, commit, files }`); `doctor` attributes drift per source, `upgrade` re-resolves
  each pin and reports commit moves (`diffSources`).
- Trust boundary — `render` lint-validates every external stack before writing a byte (#126,
  `validateExternalStacks`) and emits an extra acknowledgement warning when external opt-in syrup
  is poured.

## Stack prerequisites

Typed external prerequisites (#129) — the environment things a copy-in install can neither provide
nor verify (distinct from `requires:`, which maps render-closure edges between waffles). Schema
(`prerequisites.mjs`; kinds `PREREQ_KINDS`, levels `PREREQ_LEVELS`):

```yaml
prerequisites:
  - kind: tool           # tool|secret|scope|label|setting|service|env
    name: gh
    level: require       # require (fails doctor) | recommend (reports only)
    check: command -v gh # deterministic shell command; exit 0 = satisfied
    items: [skills/issue] # optional: scope to specific waffles (like requires:); omit = stack-wide
    description: …
```

- Scope — `applicablePrerequisites` limits entries to the selected items, like `requires:`.
- Doctor gate — `doctor` runs every applicable `check`; an unmet `require` fails (exit 1, so the
  shipped `waffle-doctor` CI job verifies it), a `recommend` only reports. Surfaced in `setup`
  inventory and `schema/SETUP.md`.
- Render — only the cheap `RENDER_PROBE_KINDS` (`tool`/`env`) are probed at render as non-blocking
  warnings; the network/auth kinds (secret/scope/label/setting/service) are left to the `doctor` gate.
- The legacy `env:` map is subsumed as the `env` kind, read-compatibly (both may coexist).

## Template semantics

- Placeholders `{{dotted.key}}` (regex `/(?<!\$)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g`,
  `template.mjs:7`) substitute only if the key is declared in the stack's `config:` or is
  `harness.*` (`template.mjs:38`). Any other braces (bash `${...}`, mustache) pass through
  verbatim; a `$`-prefixed `${{ }}` (GitHub Actions) is hard-excluded by the negative
  lookbehind, so `files/` workflow payloads carry those expressions untouched and unpoliced.
- Value formatting (`formatValue`, `template.mjs:67`): strings verbatim; string arrays join
  `, `; other structures render as a YAML block.
- `harness.*` — reserved, always-available namespace (never declared), resolved per output
  target (`HARNESS_BUILTINS`, `project.mjs:386`). Override via `config.harness.<sub>` (scalar →
  all targets, or a per-target map). Also carries three target-independent CI-dispatcher scalars
  (`actionRef`/`actionVersion`/`apiKeySecret`, #131) spliced into the rendered workflow `uses:` /
  `with:` lines; each is injection-guarded at render by `HARNESS_PATTERNS` (rejects `${{`, quotes,
  newlines), so an override can repin/repoint the action without ejecting the workflow.
- Nested substitution — substituted values are re-expanded up to depth 4
  (`MAX_SUBSTITUTION_DEPTH`, `template.mjs:15`; `expandNested`, `template.mjs:59`): a committed
  value can reference a key kept in the gitignored local overlay. Canonical text surviving the
  first pass is never re-scanned; unresolvable nested placeholders pass through.
- Value patterns — a config key may declare `pattern:` (a regex); the fully-resolved value must
  fully match at render or the render fails like a missing required key (`compilePattern`
  `template.mjs`, enforced in `substitute`, linted by `validate`) — for values spliced into
  structured contexts (a workflow `if:`, a YAML scalar) where escaping is impossible.
- Extensions — `.waffle/extensions/{agents,skills}/<name>.md` appended to the rendered
  item inside `<!-- BEGIN project extension: … -->` / `<!-- END project extension -->` markers
  (`appendExtension`, `render.mjs:419`). Agents: appended to body; skills: appended to
  `SKILL.md` only.
- Output conflict — two enabled sources emitting the same output path is a hard render error
  (`emit`, `render.mjs:100`), not last-write-wins.
- Unmanaged-file overwrite guard — a render that would produce a path already on disk but not
  tracked by the previous lock (a consumer's hand-written file) is refused before any write or
  prune, leaving the tree untouched (`render.mjs:245`); a byte-identical file is adopted
  silently. `--force` overwrites.

| `harness.*` key | claude | codex | agents-dir |
|-----------------|--------|-------|------------|
| `harness.assistantName` | Claude | Codex | Codex |
| `harness.attributionPath` | claude-code | Codex | Codex |
| `harness.skillsDir` | .claude/skills | .agents/skills | .agents/skills |

Target-independent CI-dispatcher scalars (#131; same value on every target):

| `harness.*` key | default |
|-----------------|---------|
| `harness.actionRef` | `anthropics/claude-code-action` |
| `harness.actionVersion` | current pinned SHA + preserved `# vX.Y.Z` comment |
| `harness.apiKeySecret` | `ANTHROPIC_API_KEY` |

Render targets (`VALID_TARGETS`, `project.mjs:27`):

| Source | claude | codex | agents-dir |
|--------|--------|-------|------------|
| agent `agents/<n>.md` | `.claude/agents/<n>.md` (frontmatter name/description/skills + `claude:` passthrough; body) | `.codex/agents/<n>.toml` (name, description, developer_instructions=body) | `.agents/agents/<n>.md` (neutral Markdown: frontmatter name/description/skills, no `claude:` passthrough; body) |
| skill `skills/<n>/` | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |

Full matrix — every target renders both kinds (#94). codex + agents-dir share the cross-tool
`.agents/skills/<n>/` skill dir (Codex scans `.agents/skills` cwd→repo-root, matching
`harness.skillsDir`); `renderSkill` dedupes it by output dir (first target wins) so enabling
both writes it once. Skills render byte-for-byte except substitution + extension append;
non-`.md` supporting files are copied verbatim.

## Consuming-project contract

Everything lives inside the one `.waffle/` directory (0.8.0 layout; legacy root `.waffle.*`
and pre-0.6.0 `.wafflestack.*` names still read with a deprecation note and are moved in
place by `render`/`upgrade`):

| File | Tracked | Role |
|------|---------|------|
| `.waffle/waffle.yaml` | committed | version, `targets`, `stacks` (bare built-in names or `{name,source,ref}` external mappings), `include`, `config`, `eject` (`loadProjectConfig`, `project.mjs:212`). `install`/`eject` edit it comment-preservingly. |
| `.waffle/waffle.local.yaml` | gitignored | deep-merged over committed config, wins on conflict — account-specific values. **Private, and never canonical (#317)**: it shapes the bytes on *your* disk and is excluded from the lock, so it cannot reach a teammate or CI. Extensions are the deliberate contrast — committed, therefore canonical, therefore they DO propagate. |
| `.waffle/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.waffle/waffle.lock.json` | generated (committed) | manifest of rendered file → sha256 (+ toolkitVersion, an optional `toolkit` provenance block for the BUILT-IN toolkit (#374: `{source, sourceType, ref, commit, status}` — `ref`/`commit` non-null only when `status === 'release'`, so it is BYTE-STABLE across commits and this repo's own lock reads `{ref: null, commit: null, status: 'unreleased'}` forever), targets, stacks, include, and an optional `sources` provenance block for external stacks, #125). Hashes the **canonical** render — committed inputs only (#317) — so it is byte-identical on every machine. `doctor --verify-render` reproduces it; `render` rewrites it |
| `.waffle/waffle.local.lock.json` | gitignored | manifest of the render **this machine actually wrote** (overlay values included). Written only when the overlay changes an output byte, removed when it stops. `doctor`/`list`/`render`'s prune+clobber read it in preference to the committed lock (`readTreeLock`), so a hand-edit is still caught locally while the committed lock stays canonical (#317) |
| `.waffle/{CHEATSHEET,TEAM}.md` + `.waffle/{cheatsheet,team}.html` | generated (committed by consumers) | overview of the installed selection — cheat sheet of user-invocable skills + team intro of agents, Markdown source of truth + branded self-contained HTML (hybrid font strategy: Google Fonts link + system fallback). Emitted via `emit()` (`waffledocs.mjs`), so lock-tracked, doctor-checked, and pruned like any managed file |
| `.waffle/AVATARS.md` + `.waffle/avatars/<agent>.svg` | generated (committed by consumers) | one static, deterministic waffle SVG per installed agent, plus the manifest pairing each with its exact derived commit email and the manual Gravatar-registration procedure that makes GitHub render it on commit views (#157). Same `emit()` lifecycle |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml`.

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 966 tests, 128 suites) |
| validate / typecheck | `npm run validate` = `node installer/cli.mjs validate` |
| build | `npm pack --dry-run` |
| render (dogfood) | `node installer/cli.mjs render --allow-unreleased` — the flag is **required** (#373): `render` refuses from a toolkit that is not at a release tag, and a working tree never is. Commit the updated render + lock (the `doctor` drift gate is a required check). |
| verify render | `node installer/cli.mjs doctor` (tree vs lock — **not** gated, needs no flag) / `node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` (committed inputs reproduce the committed lock — the CI gate in `.github/workflows/tests.yml`, #316). `--verify-render` **renders**, so it is gated (#373) and needs `--allow-unreleased` when run by hand from a branch; the `tests` job supplies the env twin `WAFFLESTACK_ALLOW_UNRELEASED: '1'` instead, which is why line 72 there carries no flag. |
| evals (metered, LLM tier — #109) | `npm run evals -- --max-calls N` (live, needs `ANTHROPIC_API_KEY`) / `npm run evals -- --dry-run` (mock, free). 9 cases across `github-workflow` (7) + `orchestration` (2); scheduled nightly by the opt-in `waffle-evals` syrup. **Not** in `npm test`. |

Test files: `installer.test.mjs` (render pipeline machinery), `checkpoint.test.mjs` /
`memory.test.mjs` (the delegate skill's shipped validator CLIs), `content.test.mjs`
(eval layer 1, #108: deterministic key-phrase assertions on rendered stack prompts —
reads the committed `.claude/skills/**` render, renders the gitignored label-hook workflow
to a temp dir; pins load-bearing guardrails so rewording passes but removing one fails CI),
`evals.test.mjs` (eval layer 2 harness, #109: discovery/validation, target render, assertion
+ budget logic, and a dry-run over the shipped seed case — all with the mock model, so it runs
free inside `npm test`; the metered runner itself is `npm run evals`, never `npm test`),
`identity.test.mjs` (the delegate skill's shipped identity-preflight script, exercised directly),
`telemetry.test.mjs` (#227: executes the rendered token-spend telemetry jq/bash programs against
fixture logs + a stubbed `gh`), `avatars-sync.test.mjs` (Gravatar pipeline with injected HTTP +
rasterizer, #285), `typecheck-gate.test.mjs` (guards the JSDoc typecheck gate itself, #177),
`provenance.test.mjs` (#373: toolkit self-identification and the release gate — identity from a
real temp git repo and from a synthesized npm-install layout, the `ls-remote` parse, the offline
CHANGELOG corroborator, the `github:<owner>/<repo>#<tag>` ref format, and the per-command gate
matrix driven through real CLI spawns. Hermetic by construction: `lsRemote` is injected, or the
origin is a checkout, which resolves offline. #374 and #372 extend this file rather than
`installer.test.mjs`).

`installer.test.mjs` sets `process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1'` at module scope: it
spawns the real CLI ~a dozen times, half of them gated commands, from an untagged checkout. The
gate is asserted in `provenance.test.mjs`, which strips the variable per spawn.

## Dogfood state

This repo renders 5 stacks into itself — `github-workflow`, `docs-system`, `orchestration`,
`harness-architect`, `wafflestack` (`targets: [claude]`, plus `include:` refs arming three opt-in
syrup workflows — `files/.github/workflows/waffle-hygiene.yml`, `.../waffle-release-hook.yml`,
`.../waffle-pr-green-hook.yml` — and the qualified `code-quality/skills/adversarial-review` the
PR-green hook runs plus `code-quality/skills/qa` for autopilot's opt-in QA gate;
`.waffle/waffle.yaml`). The render (`.claude/agents/`, `.claude/skills/`,
`.claude/settings.json`) and `.waffle/waffle.lock.json` are COMMITTED — like a consuming
project — because the CI hygiene harness reads the committed skills and the doctor drift gate
(required check on main) needs render + lock in git. Re-render AND commit after editing
`stacks/**`. Gitignored: `.claude/worktrees/` (throwaway), `.codex/`/`.agents/` (non-targets),
`.github/workflows/waffle-label-hook.yml` (would arm a live label→harness dispatch), and the
generated `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`, `cheatsheet.html`, `team.html`) —
these deliberate absences are tolerated by doctor's `--allow-missing`.

CI render gate (#314/#316): `.github/workflows/tests.yml` (project-owned — NOT lock-managed,
edited directly) runs `npm test` + `npm run validate` + `npm run typecheck`, then
`WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs doctor --allow-missing --verify-render`
with the checkout's OWN CLI — catching a `stacks/**` or config edit whose re-render was forgotten
(files and lock go stale together, so the plain `waffle-doctor` drift gate stays green). The env
twin is shown inline here because that is what *executes*; the job supplies it once at the `env:`
block rather than per-step (`tests.yml:72` therefore carries no flag — see below). Running that
step **by hand** from a branch needs `--allow-unreleased`, since `--verify-render` renders and is
gated (#373). This gate cannot live in
`doctor.flags`: the shipped waffle-doctor workflow renders via
`npx github:dustinkeeton/wafflestack` (main's toolkit), which is the wrong toolkit for the
toolkit's own PRs in both directions (`tests.yml:37`).

The `test` job sets `WAFFLESTACK_ALLOW_UNRELEASED: '1'` at the job `env:` (#373). Both the CLI
spawns in `npm test` and the `--verify-render` step above are **gated commands run from an
untagged checkout** — `actions/checkout` fetches no tags, so this checkout is `unreleased` by
construction. Rendering the working tree is the entire point of a toolkit-development CI run, and
the flag suppresses the refusal, not the truth (identity still resolves to `unreleased`, which is
what keeps this repo's dogfooded lock honest). Removing it reds the whole job.

Toolkit-local CLI calls in this repo's own config prompts (`.waffle/waffle.yaml`:
`delegate.extraPreflight`, `audit.compliancePrompt`) pass `--allow-unreleased` on `render` for the
same reason — they run in fresh worktrees and CI checkouts, which are never at a tag.

## Owner-voiced docs — do not rewrite

`README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are owner-voiced canonical documents
(the schema files ship to consumers via npx). Do not rewrite them in a docs pass — flag any
drift instead.
