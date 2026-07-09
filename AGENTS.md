---
last-updated: 2026-07-09
---

# AGENTS.md — wafflestack

Canonical, harness-neutral agent/skill definitions grouped into stacks; the `wafflestack`
CLI renders them into harness-native files (`.claude/`, `.codex/`, `.agents/`) inside a
consuming project. Rendered files are generated output — edit source (`stacks/**`,
`schema/**`, `installer/**`), project config, or a project extension, never the rendered files.

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

`toolkit.yaml` lists 9 stacks (14 agents + 32 skills; reorganized in #38 — `design`
dissolved, roles consolidated, `security-audit` variants renamed). Per-stack config schema,
env, prerequisites, and setup notes live in each `stack.yaml` (authoritative — this table summarizes).

| Stack | Path | Agents | Skills | Purpose |
|--------|------|--------|--------|---------|
| `docs-system` | `stacks/docs-system/` | docs-agent, docs-human | docs-agent, docs-human | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. |
| `github-workflow` | `stacks/github-workflow/` | (none) | git-workflow, issue, github-project-management, github-project-board, clean-up, label-hook, hygiene, release | Git / GitHub issue / Projects v2 / release workflow. `github-project-management` reads/updates board items; `github-project-board` (#54) provisions/standardizes the board itself to the canonical Kanban spec (Status/Priority/Size/Start/Target; Table/Kanban/Roadmap views) — the only create-side board skill. Ships seven prefab CI workflows as `files/` (syrup) payloads: `waffle-doctor` (read-only drift gate, default render) plus six **opt-in syrup** hooks — `waffle-label-hook` (label→enrich/implement Claude dispatch), `waffle-hygiene` (daily scheduled `docs`→auto-merge PR), `waffle-release-hook` (deterministic tag-on-merge, `contents: write`, no Claude), `waffle-post-merge-hook` (deterministic remote merged-head-branch delete, `contents: write`, pairs with `clean-up`), `waffle-evals` (nightly Layer-2 LLM eval runner, `node installer/evals.mjs`, no Claude dispatch), and `waffle-pr-green-hook` (#112/#180 — on a PR's checks going green, dispatch the harness to run `adversarial-review` and post one hostile pre-merge review; deduped per green head by a `<!-- waffle-adversarial-review -->` marker) — each wired to its companion skill/waffle via a `files/`-keyed `requires:` edge. Declares typed `prerequisites:` (tool probes `require`; secrets/scopes/labels/settings/services `recommend`). Config: `labelHook.*`, `hygiene.{cron,claudeArgs}`, `release.{tagFormat,versionFiles}`, `prGreen.{watchWorkflows,claudeArgs}`, `evals.{cron,maxCalls,model}`, `autoMerge.label` (`waffle-auto-merged`, #134). Only stack with a `setup:` block (gh auth, labels, board, git identity, hook opt-ins). |
| `code-quality` | `stacks/code-quality/` | (none) | tdd, codebase-architecture, adversarial-review, qa, dry | Cross-cutting, project-agnostic practice skills (#117; test command, tiers, module map, settings type are config). `adversarial-review` (#112) is a config-free `/adversarial-review <PR#>` hostile post-green PR review (reads `gh pr diff`, posts a severity-tagged review); auto-triggered by the github-workflow `waffle-pr-green-hook` syrup (#180). `qa` (#228) is its functional sibling — `/qa <PR#>` checks a green PR against the linked issue's intent/acceptance criteria, best-effort runs `project.testCmd` and assesses diff test coverage, posts one review under its own `<!-- waffle-qa -->` marker (distinct from adversarial-review's, so pr-green/pr-response automation never cross-fires); report-only, composed by autopilot's opt-in QA gate (`autopilot.qaLoop`). `dry` (#116) is de-duplication under the rule-of-three + semantic-sameness guardrails. |
| `obsidian-dev` | `stacks/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development (API, manifest, esbuild, testing patterns) + the desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `stacks/orchestration/` | project-manager, product-manager, task-planner | delegate, autopilot, audit, docs, standup | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config (defaults: `lead-engineer` architect + compliance, `security-engineer` security; override compliance to a domain architect where one exists). Uses `requires:` for its skill deps (delegate→git-workflow+github-project-management+github-project-board, docs→docs-agent+docs-human). `delegate` ships three dependency-free supporting files (copied with the skill): `checkpoint.mjs` + `checkpoint.schema.json` (#105/#106) validate the one-JSON-doc-per-run phase checkpoint at every phase boundary (`node checkpoint.mjs --file F --phase fetch\|classify\|plan\|execute\|report`; schema sections per phase plus cross-reference checks — executed branch = planned branch, every issue traces to fetch, parallel⇒worktree/serial⇒none; exit 1 = STOP); `memory.mjs` (#107) gates the curated per-repo run-memory doc (`node memory.mjs --file F [--max-bytes N]`; missing file valid; hard byte cap + required Why/Since/Area fields per entry; exit 1 = curate, never truncate — memory loads in Classify, informs Plan grouping, injects Area-matched entries into agent prompts, is curated in Report). Opt-in approval gate (`delegate.approveBeforePush`): agents commit locally and STOP before `git push`/`gh pr create`; orchestrator collects human approval via AskUserQuestion; rejection stays local, recorded `skipped` with `approval`/`approvedBy` in the checkpoint. Config: `delegate.{defaultScope,extraPreflight,checkpointDir,approveBeforePush,autoMerge,batchMode,memoryFile,memoryMaxBytes}` — `checkpointDir`/`memoryFile` defaults are themselves placeholders (`{{git.worktreesDir}}/.delegate`, `{{delegate.checkpointDir}}/memory.md`), exercising depth-4 nested expansion. Two batch/autopilot opt-ins: `delegate.autoMerge` (#98/#141, default false — after `gh pr create`, arm `gh pr merge --auto --merge` so the PR merges itself once the base branch's required checks pass; arm-only-on-a-required-check, never an immediate or `--admin` merge; per-run, records `autoMergeArmed` per PR) and `delegate.batchMode` (#99/#142, default false — non-interactive: explicit scope stands in for the Phase-3 plan-approval gate and an ambiguous classification falls back to serial-in-main; composes with `autoMerge`, never weakens the `approveBeforePush` pre-push gate). `autopilot` (#100/#143) is the unattended backlog runner — a prose playbook that composes `delegate` (with `batchMode` + the run's `autoMerge` engaged), `clean-up`, and `git-workflow` into a per-issue **plan→implement→PR** loop over a REQUIRED issue scope, re-implementing none of that machinery. Instantiation contract, captured before any work: (1) an explicit issue **scope** — an issue list, `milestone:<name>`, a label, or `all-open` — which is also what activates delegate's batch mode, so a run is never unscoped; and (2) per-run auto-merge **consent** (`autopilot.autoMerge`, default false, captured fresh each run, **never sticky** — never read back from a prior run/checkpoint/memory). Per issue: one read-only planning context writes `{{autopilot.planDir}}/issue-<N>.md`, injected into a fresh delegate-spawned implementer as a *brief, not a contract*; delegate opens the PR; on consent each PR self-arms on green, else it is left for human review; per merged PR autopilot runs post-merge housekeeping (verify the issue closed, board→Done, `clean-up git --yes`). Guardrails inherited verbatim from `hygiene`/`delegate.autoMerge`: never push `main`, never `--admin`-merge, merge-commits-not-squash, one retry then stop-and-report, a blocked serial chain stops its dependents. Three further opt-in, per-run gates run between PR verification and the merge-wait, in fixed pipeline order — the QA gate (#228: `qa <PR#>` → `pr-response <PR#> --yes` rounds, functional QA against the linked issue's intent, `autopilot.qaLoop` consent / `+qa`, capped at `autopilot.maxQaRounds`), the review loop (#220: `adversarial-review` → `pr-response` rounds, `autopilot.reviewLoop` / `+review`, capped at `autopilot.maxReviewRounds`), and the diff-scoped `/audit` gate (#221: `autopilot.auditStep` / `+audit`, hard-blocks on unresolved Critical/High) — with auto-merge arming deferred to the last enabled gate, convergence read as a 0-implemented round, and a can't-converge cap filing an `autopilot.holdLabel` (`waffle-manual-review`) follow-up that automatic scope thereafter skips. `requires:` `delegate` + `clean-up` + `git-workflow` + `github-project-management` + `qa` + `adversarial-review` + `pr-response` + `audit` + `issue`. Config: `autopilot.{autoMerge,planDir,qaLoop,maxQaRounds,reviewLoop,maxReviewRounds,auditStep,holdLabel}` (`planDir` default `{{git.worktreesDir}}/.autopilot` — gitignored throwaway plan files). `standup` rounds up a per-agent status pulse — dynamic `.claude/agents/*.md` roster, one read-only parallel wave, collect-via-return-values, no side effects. |
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
| `installer/lib/render.mjs` | Render pipeline: resolve external sources (`loadToolkitWithSources`), validate external stacks pre-write (#126), compute selection, regenerate all outputs verbatim, delete stale managed files, write lock (+ per-source `sources` provenance, #125). Output-conflict + scoped required-config + env/prerequisite render-warnings (cheap `tool`/`env` probes only) + unmanaged-file overwrite guard (refuses to clobber a pre-existing untracked file unless `force`; `render.mjs:245`) + external opt-in-syrup trust-boundary warnings. Passes the prior lock's file paths to `computeSelection` as `trackedFiles` so already-installed opt-in syrup keeps rendering. |
| `installer/lib/refs.mjs` | Ref grammar, toolkit-wide resolution, transitive cross-stack dependency closure + render-selection computation, and `itemOutputMatcher(kind,name)` (item→lock-path predicate, shared with eject/list). Pure leaf (no local imports). Shared by install / render / validate / eject / list. |
| `installer/lib/template.mjs` | `{{placeholder}}` substitution: declared-key gate, per-target resolve, depth-capped nested expansion, value formatting, optional per-key `pattern:` value validation. |
| `installer/lib/toolkit.mjs` | Load `toolkit.yaml` + every stack manifest (agents, skills, `files` payloads with sniffed `binary` flag, `optIn` opt-in set, `requires`, `prerequisites`, config, env, setup); scoped required-key check. `loadToolkitWithSources` (#88) additionally resolves each external `source:` entry to a toolkit root and merges its named stack (with `provenance`) into one registry; a cross-source stack-name collision is a hard error naming both. |
| `installer/lib/project.mjs` | Load consuming-project config (+ local overlay), valid targets, `harness.*` built-ins (incl. CI-dispatcher `action*` keys + their injection-guard patterns, #131), per-target resolver; parse/validate `stacks:` bare names vs `{name,source,ref}` external entries (#88); multi-generation legacy-name read fallback + in-place dotfile migration chain (`.wafflestack.*` → `.waffle.*` → `.waffle/waffle.*`). |
| `installer/lib/util.mjs` | Shared helpers: sha256, YAML read, deep-merge, dotted lookup, frontmatter parse/stringify, fs writes, semver parse/compare. |
| `installer/lib/doctor.mjs` | Diff managed files against the lock; always report the rendered `toolkitVersion` + a skew note pointing at `upgrade`. Attributes each drifted external file to its source (#125). Runs the selected stacks' typed `prerequisites:` checks (#129): an unmet `require` fails doctor (exit 1), `recommend` only reports; best-effort (a load failure is a note, not a break). |
| `installer/lib/eject.mjs` | `eject` (release an item, self-cleaning its `include:`), `installRefs` (persist stack/item refs to config), `init` (starter config). |
| `installer/lib/validate.mjs` | Toolkit-developer lint: manifests, frontmatter, placeholder↔declaration sync, agent-skill + `requires:` ref integrity, config `pattern:` compilability + default-match. |
| `installer/lib/setup.mjs` | `setup` output: `schema/SETUP.md` playbook + inventory generated from the installed toolkit. On an already-configured `cwd`, injects a "Current configuration — update mode" section (live targets/stacks/includes/ejects/effective config/unset required keys/opt-in syrup state) so a re-run curates an update pass. |
| `installer/lib/migrations.mjs` | Migration registry (`MIGRATIONS`) + runner: ordered, idempotent, version-keyed steps `{ version, description, run(cwd) }`; applies steps in `(fromVersion, toVersion]`. Ships the 0.6.0 `.wafflestack.*`→`.waffle.*` rename, the 0.8.0 root→`.waffle/` config move, and the 0.10.0 consumer `bundles:`→`stacks:` key rename (#59). |
| `installer/lib/upgrade.mjs` | `upgrade` flow: lock-vs-toolkit version diff, `CHANGELOG.md` delta printout, run migrations, then render (`refreshSources: true` — re-fetch each git pin so a moved ref is observed) + doctor. Diffs re-resolved source commits against the lock to report per-source moves (`diffSources`, #125). Also exports the changelog-section parser. |
| `installer/lib/waffledocs.mjs` | Generate the `.waffle/` overview docs from the render selection: `CHEATSHEET.md` (user-invocable skills) + `TEAM.md` (installed agents), each with a branded, self-contained HTML page (`cheatsheet.html`/`team.html`; hybrid font strategy — Google Fonts link + system-font fallback, fonts the only external ref). Assembles from item frontmatter (skill `user-invocable`/`argument-hint`/`description`; agent `name`/`description`/`skills`), substituted with render's resolver. Emitted via `render.mjs`'s `emit()`, so lock-tracked + doctor-checked + pruned. |
| `installer/lib/evals.mjs` | Layer 2 eval harness (#109): discover/validate `stacks/*/evals/*.eval.yaml` cases, render a case's target through `renderProject` into a temp project (rendered body → system prompt), drive a model, evaluate transcript assertions (`includes`/`excludes`/`regex` deterministic; `judge` LLM-graded). `Budget` enforces a hard call cap BEFORE each call (`BudgetExceededError` stops the run, remaining cases skipped). `anthropicClient` (fetch-based, no SDK dep) for live runs; `mockClient` for dry-run/tests. Driven by `installer/evals.mjs` (`npm run evals`), never by `npm test`. |
| `installer/lib/list.mjs` | `list` command (#119): compose `loadToolkit`/`loadProjectConfig`/`computeSelection`/`readLock`/doctor-style sha256 into a per-stack per-item state model classifying each item `current`/`outdated`/`not-installed`; render it as a plain aligned agent-parseable table (default, TTY-gated ANSI) or drive a hand-rolled keypress multi-select (`--interactive`, needs a real TTY, applies via `installRefs`+render). Built-in surface only (external `source:` stacks list as a selection error, like `setup`). |
| `installer/lib/prerequisites.mjs` | Typed external prerequisites (#47/#129): normalize a stack's `prerequisites:` list, scope it to a selection (`applicablePrerequisites`, like `requires:`), run each `check` shell command (`runCheck`, exit 0 = satisfied, stdio ignored, timeout-bounded) and bucket by level (`evaluatePrerequisites` → `{unmetRequired,unmetRecommended,met}`). `RENDER_PROBE_KINDS` = `{tool,env}` (the cheap kinds render probes; doctor probes all). Imported by `doctor.mjs` + `render.mjs`. |
| `installer/lib/sources.mjs` | External `source:` resolution (#88/#125): turn a `{name,source,sourceType,ref}` entry into a local toolkit root — a local path read in place, or a git URL fetched at the pinned `ref` into a content-addressed cache (reused unless `refresh`), returning `{root,commit}` for lock provenance. Rejects a leading-`-` git source/ref (argument-injection guard, belt-and-braces with the `--` end-of-options marker). `gitFetch`/`gitResolveCommit` injectable for hermetic tests. |

```js
// render.mjs
export function renderProject({ toolkitRoot, cwd, toolkitVersion, force = false, log, sourceCacheDir, refreshSources = false }) // → { ok, errors, warnings, written, removed, sources }  (force overrides the unmanaged-file overwrite guard, render.mjs:245; refreshSources re-fetches each git source)
export function readLock(cwd)                          // → lock object | null  (lock also carries an optional `sources` block, #125)

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
export function computeSelection(toolkit, project, trackedFiles = new Set()) // → { items:[{stackName,stack,kind,item}], closures, errors }  (trackedFiles = prior lock's file paths; ungates already-installed opt-in syrup)
export function skippedSyrupCompanions(toolkit, selection)                    // → [{ fileRef, stackName, companions:["kind/name"…] }]  (#74: reverse the requires: edge — opt-in syrup gated out of a selection whose companion waffle IS selected; drives the install/render warning + setup update-mode flag)

// template.mjs   (PLACEHOLDER = /(?<!\$)\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g; MAX_SUBSTITUTION_DEPTH = 4)
export function substitute(text, resolve, declared, errors, context, patterns) // → string (patterns: Map<key,RegExp> render-time value validation)
export function formatValue(v)                         // → string (string[] join ", "; else YAML block)
export function placeholderKeys(text)                  // → Set<string>
export function compilePattern(pattern)                // → RegExp (full-match ^(?:…)$; compiles a config key's pattern:)

// toolkit.mjs
export function loadToolkit(rootDir)                   // → { name, description, stacks: Map<name, stack> }  (per stack via loadStack; stack also gains .files [{name,path,binary}], .optIn Set<"files/…">, .requires, .prerequisites)
export function loadToolkitWithSources({ builtinRoot, externalStacks = [], cwd, cacheDir, gitFetch, gitResolveCommit, refreshSources = false }) // → merged toolkit; each external stack registered under its name with a .provenance record; cross-source name collision throws (#88/#125)
export function missingRequiredKeys(stack, values, lookup, usedKeys = null) // → string[]  (usedKeys Set scopes to referenced keys)
// loadStack throws on a stale manifest `syrup:` key (renamed to `optIn:` in 0.10.0, #59) so a dropped gate can't un-gate opt-in syrup

// project.mjs
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, EXTENSIONS_DIR   // .waffle/waffle.* consumer paths (one .waffle/ dir owns everything)
export const LEGACY_ROOT_CONFIG_FILE, LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_ROOT_LOCK_FILE // 0.6.0–0.7.x repo-root .waffle.* names
export const LEGACY_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE, LEGACY_LOCK_FILE, LEGACY_EXTENSIONS_DIR // pre-0.6.0 .wafflestack.* names
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir']
export const HARNESS_BUILTINS                          // per-target { assistantName, attributionPath, skillsDir } + target-independent CI-dispatcher scalars { actionRef, actionVersion, apiKeySecret } (#131)
export const HARNESS_PATTERNS                          // injection-guard regexes for actionRef/actionVersion/apiKeySecret (reject `${{`, quotes, newlines); seeded into render's pattern map + checked by validate (#131)
export function loadProjectConfig(cwd, notes = [])     // → { targets, stacks, externalStacks, include, values, eject }; splits `stacks:` bare names vs `{name,source,ref}` entries; reads legacy `bundles:` as `stacks:` fallback (stacks: wins); pushes legacy-read deprecation notes
export function classifyStackSource(source)            // → 'git' | 'path'  (URL scheme / scp `user@host:` / `.git` suffix ⇒ git, else local path)
export function normalizeStackEntries(raw)             // → { stacks:[name…], externalStacks:[{name,source,sourceType,ref}] }; validates shape, unique names, git-needs-ref / path-forbids-ref, unknown-key rejection (#88)
export function renameLegacyStacksKey(doc)             // in-place rename of a YAML doc's `bundles:` key → `stacks:` (comment-preserving); → true if renamed (shared by installRefs + the 0.10.0 migration)
export function resolveConfigFile(cwd)                 // → { file, legacy, note } (prefers .waffle/waffle.yaml, else legacy .waffle.yaml, else .wafflestack.yaml)
export function resolveLocalConfigFile(cwd)            // → { file, legacy, note }
export function resolveLockFile(cwd)                   // → { file, legacy, note }
export function migrateLegacyDotfiles(cwd)             // chain .wafflestack.* → .waffle.* → .waffle/waffle.* in place; → [{ from, to }] (idempotent)
export function staleGitignoreEntries(cwd)             // → stale root .waffle.* / legacy .wafflestack.* lines still in .gitignore (self-clearing reminder)
export const GITIGNORE_MARKER = '# wafflestack'        // comment prefixing wafflestack's appended .gitignore block
export function ensureGitignoreEntries(cwd, entries)   // idempotent append of approved .gitignore lines (--gitignore/setup); → entries added (skips present, preserves content)
export function recommendedGitignoreEntries(toolkit, project) // → baseline offer: [.waffle/waffle.local.yaml, + resolved git.worktreesDir when an enabled stack declares it]
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
export function doctor({ cwd, toolkitVersion, allowMissing = false, toolkitRoot = null, sourceCacheDir }) // → { ok, modified, missing, notes, attribution, allowMissing, prerequisites }  (notes always name the rendered toolkitVersion; unmet `require` prerequisite fails ok; attribution maps external files → source label)

// migrations.mjs
export const MIGRATIONS                                // → [{ version, description, run(cwd) }]  (ordered, idempotent; 0.6.0 dotfile rename, 0.8.0 config move, 0.10.0 bundles:→stacks:)
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) // → steps in (from, to], ascending
export function runMigrations({ cwd, fromVersion, toVersion, migrations, log }) // → steps that ran; runs each step.run(cwd) in order

// upgrade.mjs
export function upgrade({ toolkitRoot, cwd, toolkitVersion, migrations, changelog, sourceCacheDir, log }) // → { ok, status, fromVersion, toVersion, changelogDelta, migrationsRun, render, doctor, sourceMoves, notes }  (re-renders with refreshSources: true)
export function diffSources(oldSources, newSources)    // → [{ name, ref, sourceType, from, to, status:'moved'|'added'|'removed' }]  (per-source commit moves vs the lock, #125)
export function changelogBetween(text, fromVersion, toVersion) // → markdown of `## [X.Y.Z]` sections in (from, to], newest first | null

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
export function generateWaffleDocs({ toolkit, project, selection, errors = [] }) // → [{ rel, content }] for .waffle/{CHEATSHEET.md,cheatsheet.html,TEAM.md,team.html}; each pair omitted when its item set is empty
export function agentFlavor(name)                      // → deterministic per-agent palette/persona seed (name-hashed)
export function agentAvatarSvg(name, skillCount = 0, opts) // → inline wafflebot avatar SVG for team.html (#161)

// list.mjs
export const STATUS                                    // { CURRENT:'current', OUTDATED:'outdated', NOT_INSTALLED:'not-installed' }
export function computeListModel({ toolkitRoot, cwd, toolkitVersion }) // → { toolkitName, toolkitVersion, lockVersion, hasLock, hasConfig, versionSkew, configError, notes, errors, stacks:[{name,description,enabled,rows}], counts }
export function formatListTable(model, { color = false } = {})        // → aligned plain-text table (trailing \n); color gates ANSI
export function selectableChoices(model)               // → actionable rows (everything not `current`; `outdated` pre-checked)  (pure)
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
cli.mjs      → render, doctor, eject, list, validate, setup, upgrade, toolkit, prerequisites, project  (command dispatch)
render.mjs   → refs, template, toolkit, project, util, waffledocs, sources, validate, prerequisites
waffledocs.mjs → template, project, util
doctor.mjs   → render, project, toolkit, refs, prerequisites, sources, util
eject.mjs    → render, toolkit, refs, project, util
validate.mjs → toolkit, template, refs, prerequisites, project, util
setup.mjs    → toolkit, render, project, refs, prerequisites, util
upgrade.mjs  → render, doctor, migrations, project, util
list.mjs     → toolkit, render, refs, project, util
migrations.mjs → util
toolkit.mjs  → util, refs, sources, prerequisites
prerequisites.mjs → refs
sources.mjs  → util
project.mjs  → util
template.mjs → (yaml)
refs.mjs     → (none)
util.mjs     → (none)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Global flag `--cwd DIR` targets a project dir
(spliced out before ref parsing; default: process cwd; `cli.mjs:26`, `extractCwd` `cli.mjs:190`).
`render`/`install` also take `--force` (`extractFlag`, `cli.mjs:199`) to override the overwrite guard.
Usage: `wafflestack <init|setup|list|install|render|upgrade|doctor|eject|validate> [refs…] [--cwd DIR]`.

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.waffle/waffle.yaml` (targets / stacks / include / config / eject scaffold, creating `.waffle/`); errors if one exists at any generation. `--gitignore` also appends `.waffle/waffle.local.yaml` (only that — no stack chosen yet). `eject.mjs:167` |
| `setup` | Print `schema/SETUP.md` playbook + inventory generated from the installed toolkit; when `--cwd` (or the invoked repo) is already configured, also prints a live "Current configuration — update mode" section. `setup.mjs:25` |
| `list` | Report the whole toolkit surface per stack/item vs. what this repo has installed (`installed & current` / `out of date` / `not installed`) as an aligned plain table (default — agent/CI-safe; ANSI only on a TTY, `--no-color` opts out). `--interactive` (real TTY both ends) drives a keypress multi-select that installs/updates the chosen refs then renders; degrades to the table without a TTY. Takes no refs. `list.mjs`, `cli.mjs:113` |
| `install [ref…]` | Persist each ref to config (stack → `stacks:`, item → canonical `include:`; resolves up front, reports pulled-in deps), then render. Bare `install` = `render`. `--force` overrides the overwrite guard; `--gitignore` appends recommended entries after a clean render. `eject.mjs:86` |
| `render` | Regenerate all managed files verbatim for the current selection; delete now-unrendered managed files; write lock. Rejects positional refs. Refuses to overwrite a pre-existing file not tracked by the lock unless `--force` (guard `render.mjs:245`). Exit 1 on error. `--gitignore` appends recommended entries after a clean render (`ensureGitignoreEntries` + `recommendedGitignoreEntries`, `offerGitignore` in `cli.mjs`). `render.mjs:33` |
| `upgrade` | Read lock `toolkitVersion`, print `CHANGELOG.md` delta to the invoked version, run migrations in `(from, to]`, then render (re-fetching external source pins, reporting per-source commit moves) + doctor. Missing lock/version degrades to render + doctor with a note. Rejects positional refs. Exit follows doctor. `upgrade.mjs:33` |
| `doctor` | Diff managed files vs lock; always report the rendered `toolkitVersion` + a skew note; run the selected stacks' typed `prerequisites:` checks. Exit 1 on drift OR an unmet `require`-level prerequisite (`recommend` only reports; `--allow-missing`: only modified files count as drift). `doctor.mjs:39` |
| `eject <skills/NAME\|agents/NAME\|files/PATH>` | Add to `eject:`, strip any matching `include:` entry, drop the item's files from the lock; files stay in place, now project-owned. `eject.mjs:24` |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter complete, placeholder↔declaration sync, agent-skill/`requires:` refs resolve, `prerequisites:` fields + `items:` refs, harness.* defaults match their guards. Exit 1 on problems. `validate.mjs:11` |

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
  stays non-interactive.
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
| `.waffle/waffle.local.yaml` | gitignored | deep-merged over committed config, wins on conflict — account-specific values |
| `.waffle/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.waffle/waffle.lock.json` | generated | manifest of rendered file → sha256 (+ toolkitVersion, targets, stacks, include, and an optional `sources` provenance block for external stacks, #125); `doctor` diffs against it, `render` rewrites it |
| `.waffle/{CHEATSHEET,TEAM}.md` + `.waffle/{cheatsheet,team}.html` | generated (committed by consumers) | overview of the installed selection — cheat sheet of user-invocable skills + team intro of agents, Markdown source of truth + branded self-contained HTML (hybrid font strategy: Google Fonts link + system fallback). Emitted via `emit()` (`waffledocs.mjs`), so lock-tracked, doctor-checked, and pruned like any managed file |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml`.

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 363 tests, 62 suites) |
| validate / typecheck | `npm run validate` = `node installer/cli.mjs validate` |
| build | `npm pack --dry-run` |
| render (dogfood) | `node installer/cli.mjs render` |
| verify render | `node installer/cli.mjs doctor` |
| evals (metered, LLM tier — #109) | `npm run evals -- --max-calls N` (live, needs `ANTHROPIC_API_KEY`) / `npm run evals -- --dry-run` (mock, free). 8 cases across `github-workflow` (6) + `orchestration` (2); scheduled nightly by the opt-in `waffle-evals` syrup. **Not** in `npm test`. |

Test files: `installer.test.mjs` (render pipeline machinery), `checkpoint.test.mjs` /
`memory.test.mjs` (the delegate skill's shipped validator CLIs), `content.test.mjs`
(eval layer 1, #108: deterministic key-phrase assertions on rendered stack prompts —
reads the committed `.claude/skills/**` render, renders the gitignored label-hook workflow
to a temp dir; pins load-bearing guardrails so rewording passes but removing one fails CI),
`evals.test.mjs` (eval layer 2 harness, #109: discovery/validation, target render, assertion
+ budget logic, and a dry-run over the shipped seed case — all with the mock model, so it runs
free inside `npm test`; the metered runner itself is `npm run evals`, never `npm test`).

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

## Owner-voiced docs — do not rewrite

`README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are owner-voiced canonical documents
(the schema files ship to consumers via npx). Do not rewrite them in a docs pass — flag any
drift instead.
