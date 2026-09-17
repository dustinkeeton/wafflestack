---
last-updated: 2026-09-17
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
stacks/registry.yaml       WAFFLE registry (#335): one entry per agent/skill — name, kind, stack, path, status (stable|wip|deprecated|replaced), replacedBy
stacks/<name>/
  stack.yaml               manifest: recommended, recommendedPlugins, agents, skills, files, optIn, requires, prerequisites, config, env, setup
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
docs/                      design notes (gitignore.md, skills-vs-workflows.md, upgrades.md)
assets/                    brand assets + brand guide (assets/README.md)
```

## Stack registry

`toolkit.yaml` lists 9 stacks (14 agents + 40 skills). Per-stack config schema, env,
prerequisites, requires edges, and setup notes live in each `stack.yaml` (authoritative —
this table summarizes).

`stacks/registry.yaml` is the WAFFLE registry (#335): one entry per agent/skill —
`{ name, kind: agent|skill, stack, path, status: stable|wip|deprecated|replaced, replacedBy?, note? }`.
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
| `docs-system` | `stacks/docs-system/` | docs-agent, docs-human | docs-agent, docs-human, prose, md-maximalist, accurate, diagram | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. Writing-craft skills (#224): `prose` + `md-maximalist` granted to docs-human, `accurate` to docs-agent — split is orthogonal by audience (#299): `accurate` is deliberately NOT granted to docs-human. All three user-invocable (`/prose`, `/md-maximalist`, `/accurate`). One `requires:` edge: `skills/prose` → `skills/md-maximalist`. `diagram` (#471) is a proxy skill granted to docs-human: ordered providers (archify → Mermaid floor), detection at invocation, never self-installs; archify is the first shipped `recommendedPlugins:` entry, scoped `items: [skills/diagram]`. |
| `github-workflow` | `stacks/github-workflow/` | (none) | git-workflow, issue, github-project-management, github-project-board, clean-up, label-hook, hygiene, release, pr-response | Git / GitHub issue / Projects v2 / release workflow. Ships 14 `files/` payloads: `waffle-doctor.yml` (default render, read-only drift gate); 7 opt-in syrup workflows (`waffle-label-hook`, `waffle-hygiene`, `waffle-release-hook`, `waffle-post-merge-hook`, `waffle-evals`, `waffle-pr-green-hook`, `waffle-pr-response-hook` — each holds write permissions and/or spends API money, so enabling the stack never renders them; the four Claude-dispatch hooks `label-hook`/`hygiene`/`pr-green-hook`/`pr-response-hook` are `{ path, targets: [claude] }` entries (#190, `stack.yaml:13-23`) — pruned for a codex/agents-dir-only consumer by the #364 gate; doctor/release/post-merge/evals + the templates are unscoped); and 6 default-render inert templates (#337: `.github/ISSUE_TEMPLATE/{config,bug,feature,rough-idea}.yml`, `PULL_REQUEST_TEMPLATE.md`, `REVIEW_TEMPLATE.md` — a template must never auto-apply `labelHook.*` labels, pinned by `content.test.mjs`). 5 of the 7 opt-in workflows carry a `files/`-keyed `requires:` edge to a companion skill (label-hook→label-hook, hygiene→hygiene, release-hook→release, post-merge-hook→clean-up, pr-response-hook→pr-response; `stack.yaml:78`); `waffle-pr-green-hook.yml` and `waffle-evals.yml` have NO edge, so the #74 companion warning never fires for them. `pr-response` posts one append-only `<!-- waffle-pr-response -->` comment per round (#318); rubric v3 (Implement ≥11, #390). pr-green dedupes per green head via the `waffle/adversarial-review` commit status; pr-response-hook bounds its loop with `prResponse.responseLabel` applied BEFORE the paid dispatch (#338: no hook predicate reads a body). Config: `issue.*`, `labelHook.*`, `hygiene.{cron,claudeArgs}`, `release.{tagFormat,versionFiles}`, `prGreen.*`, `prResponse.*`, `evals.{cron,maxCalls,model}`, `autoMerge.label`, `doctor.{toolkitRef,flags}` — label defaults moved to the `waffle:` namespace in #451 (`issue.inferenceLabel` = `waffle:needs-inference` `stack.yaml:1671`, `autoMerge.label` = `waffle:auto-merged` `stack.yaml:1878`; the `label` prerequisites and the rendered `rough-idea.yml` follow) — pin `doctor.toolkitRef` to a release tag BEFORE arming `--verify-render` in `doctor.flags` (#322). Only stack with a `setup:` block. |
| `code-quality` | `stacks/code-quality/` | (none) | tdd, codebase-architecture, adversarial-review, qa, dry | Cross-cutting practice skills (#117; test command, tiers, module map are config). `adversarial-review` (#112): config-free hostile post-green PR review, auto-triggered by the pr-green hook (#180). `qa` (#228): functional sibling — checks a green PR against the linked issue's intent, own `<!-- waffle-qa -->` marker, report-only, composed by autopilot's `autopilot.qaLoop`. `dry` (#116): de-duplication under rule-of-three guardrails. |
| `obsidian-dev` | `stacks/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development + desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `stacks/orchestration/` | project-manager, product-manager, task-planner | delegate, autopilot, audit, docs, standup | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config. Ships 2 `files/` payloads (#363): `.claude/workflows/audit-stage-{1,2}.js` — the `/audit` chain as staged Claude workflow scripts, both `optIn:` AND `targets: [claude]` (`stack.yaml:10-17`; the prose `audit` skill stays the everywhere fallback). `delegate` ships three dependency-free supporting files: `checkpoint.mjs` + `checkpoint.schema.json` (#105/#106, per-phase run checkpoint validator) and `memory.mjs` (#107, byte-capped curated run-memory gate). Config: `delegate.{defaultScope,extraPreflight,checkpointDir,approveBeforePush,autoMerge,batchMode,memoryFile,memoryMaxBytes}` (`checkpointDir`/`memoryFile` defaults exercise depth-4 nested expansion), `autopilot.{autoMerge,planDir,qaLoop,maxQaRounds,reviewLoop,maxReviewRounds,auditStep,holdLabel}` (`holdLabel` default `waffle:manual-review`, `autoMerge.label` default `waffle:auto-merged` — #451, `stack.yaml:746`/`:605`). `autopilot` (#100/#143) composes delegate (batchMode + per-run autoMerge consent, never sticky) into a per-issue plan→implement→PR loop with three opt-in gates in fixed order: QA (#228), review loop (#220), diff-scoped `/audit` (#221); can't-converge files an `autopilot.holdLabel` follow-up. `requires:` edges: delegate→git-workflow+github-project-management+github-project-board, docs→docs-agent+docs-human, autopilot→delegate+clean-up+git-workflow+github-project-management+qa+adversarial-review+pr-response+audit+issue, audit→docs, `files/…/audit-stage-1.js`→audit, `files/…/audit-stage-2.js`→audit+docs (`stack.yaml:19-42`). Prerequisites (`stack.yaml:50-96`): `require` tool probes node/git/gh; `recommend` gh-auth scope, the two labels above, and two `setting` checks scoped to delegate+autopilot — `allow-auto-merge` (1 of 3) and `required-status-check` (#205: 2 and 3 of 3 — a required check on the default branch via branch protection or a ruleset, which on GitHub Free exists only for public repos; otherwise `gh pr merge --auto` leaves the PR open-but-not-armed). Guardrails: never push main, never `--admin`-merge, merge commits not squash. |
| `engineering-team` | `stacks/engineering-team/` | lead-engineer, data-engineer, qa-engineer, devops-engineer, ux-designer, security-engineer | webapp-security-audit | Product-eng roster (browser-app security variant); lead-engineer is the general architect. Slots into `orchestration`'s roster. |
| `expo-dev` | `stacks/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development; mobile-architect is the domain architect. |
| `harness-architect` | `stacks/harness-architect/` | harness-architect | (none) | Single domain agent — expert in agent harness design. One optional config key (`project.longName`). This repo appends a project extension grounding it in the toolkit's own paradigms. |
| `wafflestack` | `stacks/wafflestack/` | (none) | waffle-init, waffle-setup, waffle-install, waffle-render, waffle-upgrade, waffle-doctor, waffle-eject, waffle-validate, waffle-report, waffle-toggle | Self-referential stack (#70): one user-invocable `/waffle-*` skill per CLI subcommand, each shelling out to `npx <waffle.toolkitRef> <sub>`. `/waffle-report` (#473) wraps `report` and files a toolkit bug UPSTREAM (target resolved from `waffle.toolkitRef`; `bug`/`feature`/`rough-idea` forms; post-redaction gate; no-auth URL fallback); it ships two eval cases under `stacks/wafflestack/evals/`. `/waffle-toggle` (#476) wraps `toggle` — the per-skill `disable-model-invocation` override — and always drives it by `--disable`/`--enable` flags (the picker needs a TTY). One optional config key (`waffle.toolkitRef`, default `github:dustinkeeton/wafflestack#v{{harness.toolkitVersion}}` — the release that rendered, #469). Enabled in this repo's own render. |

Architect seniority rule (#38): `lead-engineer` is the general architect; `plugin-architect`
and `mobile-architect` take seniority in their domains. The output-conflict guard
(`render.mjs:292`) errors if two enabled stacks emit the same path.

## Installer module registry

`installer/lib/*.mjs`, ES modules.

| Module | Purpose |
|--------|---------|
| `render.mjs` | Render pipeline: sources → selection → outputs → prune → lock. Dual render on overlay (#317) |
| `refs.mjs` | Ref grammar, resolution, dependency closure, render selection, target-scope gate (#364) |
| `template.mjs` | `{{placeholder}}` substitution + `pattern:`/`entryPatterns:`/`modes:` guard machinery |
| `toolkit.mjs` | Load `toolkit.yaml` + stack manifests; hard LOAD errors for `targets:` malformations (#364) |
| `project.mjs` | Consuming-project config + overlay, targets, `harness.*` built-ins/guards, `.gitignore` + YAML splice helpers |
| `util.mjs` | sha256, YAML, deep-merge, dotted lookup, frontmatter, fs, semver, `resolveInside` containment guard |
| `doctor.mjs` | Drift check vs `readTreeLock`; `--verify-render` temp-dir reproduction (#314); prerequisite checks (#129) |
| `eject.mjs` | `eject` / `installRefs` / `init` |
| `validate.mjs` | Toolkit-developer lint (consumers never run it over built-ins; render imports only `validateExternalStacks`) |
| `setup.mjs` | `setup` output: SETUP.md playbook + inventory (+ update-mode section) |
| `model-invocation.mjs` | Per-skill model-invocation override (#476): `skills.modelInvocation` normalization (throws on shape errors, like invalid `targets:`) + the pure `disable-model-invocation` frontmatter patch render applies to the `claude` copy |
| `harness-tools.mjs` | Per-target roster of call-shaped harness tools (#445): `HARNESS_TOOLS` data (`claude` declared; `codex` / `agents-dir` `null` = unverified) + the pure `toolCalls` / `unknownToolCalls` extractor `content.test.mjs` sweeps every source and render with. THE place a harness tool rename or removal is recorded |
| `toggle.mjs` | `toggle` command (#476): per-rendered-skill state model (COMMITTED config, tree lock), plain table, keypress picker over `list.mjs`'s shared loop, comment-preserving minimal write to `waffle.yaml` |
| `report.mjs` | `report` bundle (#473): canonical lock + config KEY paths + `doctor({ canonical: true })` summary, then `scrub`/`redact` (cwd → `<repo>`, home → `~`, emails/remotes → placeholders); `formatReportMarkdown` renders the `<details>` block (`--json` is `JSON.stringify` of the bundle in `cli.mjs:126`, no renderer export) |
| `migrations.mjs` | Ordered, idempotent, version-keyed migration steps |
| `registry.mjs` | WAFFLE registry loader + the wip/replaced status gate (#335) |
| `upgrade.mjs` | Version diff, changelog delta, migrations, pin reconcile (#372), render + doctor |
| `uninstall.mjs` | `uninstall` / `reinstall` + the pure `planUninstall` they share (#182) |
| `waffledocs.mjs` | Generated `.waffle/` overview docs + avatars, via render's `emit()` |
| `avatars-sync.mjs` | Owner-side Gravatar pipeline behind `avatars sync`/`status` (#285) |
| `evals.mjs` | Layer 2 eval harness (#109; runner entry `installer/evals.mjs`) |
| `list.mjs` | `list` command: per-item state model + table + interactive picker (#119); exports the keypress loop `toggle` reuses (#476) |
| `prerequisites.mjs` | Typed external prerequisites: normalize, scope, probe, bucket (#47/#129) |
| `plugins.mjs` | Recommended EXTERNAL harness plugins a stack offers via `setup` (#199); never installed |
| `sources.mjs` | External `source:` resolution: local path or pinned-git cache (#88/#125) |
| `toolkit-ref.mjs` | Toolkit self-identification (#373), lock `toolkit` block (#374), write-side pin (#372) |

Exports with signatures:

```js
// render.mjs — see the module table; dual render on overlay (#317): effective → disk, canonical → committed lock, divergent hashes → gitignored local lock
export function renderProject({ toolkitRoot, cwd, sourceBaseDir = cwd, toolkitVersion, toolkitIdentity = null, force = false, log, sourceCacheDir, refreshSources = false }) // → { ok, errors, warnings, written, removed, sources, toolkit, identity } (force overrides the unmanaged-file overwrite guard — that refusal alone also carries `collisions: string[]`, the refused paths, #497; absent toolkitIdentity ⇒ lock's toolkit block omitted)
export function readLock(cwd)                  // → committed lock | null — the CANONICAL render (committed inputs only, #317)
export function readLocalLock(cwd)             // → gitignored .waffle/waffle.local.lock.json | null — this machine's EFFECTIVE render
export function readTreeLock(cwd)              // → readLocalLock(cwd) ?? readLock(cwd) — manifest of the files ON DISK (doctor drift, list status, render prune/clobber; --verify-render deliberately does NOT read it)
export function configGuardProblems({ toolkit, project, selection }) // → string[] — the guard failures a render WOULD produce, without rendering (#218; runs the real substitute() per used guarded key, so bare doctor enforces pattern:/entryPatterns:/modes:/lockMode:)
export function collectUsedKeys(items)         // → Set<string> placeholder keys referenced by a selection's source content

// refs.mjs — ref grammar, resolution, dependency closure, selection (imports only VALID_TARGETS from project.mjs + the registry gate from registry.mjs)
export function itemOutputMatcher(kind, name)  // → (rel) => boolean — item → lock-path predicate (eject + list; stack-BLIND, matches by path)
export function normalizeItemRef(ref)          // → "agents/NAME" | "skills/NAME"
export function itemsOfKind(stack, kind)       // → stack.agents | stack.skills
export function findItems(toolkit, kind, name) // → [{ stackName, item }] across the toolkit
export function parseRef(raw)                  // → { form: 'qualified'|'item'|'stack', … }
export function resolveRef(toolkit, raw)       // → { type:'stack',name } | { type:'item',kind,name,stack,item,canonicalRef,forwardedFrom? }; throws — registry-gated (#335): a `wip` ref is REFUSED (its own message, not "unknown"; wip matches are filtered before the unknown/ambiguous count decides), a `replaced` ref is FORWARDED to its successor with forwardedFrom set
export function resolveDepStrict(toolkit, refString, preferStack) // → { kind,name,stack,item }; throws (authored requires: dep)
export function resolveAgentSkill(toolkit, name, preferStack)     // → { kind:'skills',name,stack,item } | null (lenient grant-pointer; null also for a `wip` skill, #335)
export function isWipWaffle(toolkit, stackName, kind, name) // → boolean — the registry gate, toolkit-shaped (#335); false for an unregistered waffle or a registry-less toolkit
export function closureFor(toolkit, root)      // → [{ kind,name,stack,item }] BFS closure, root first, deduped
export function closureDeps(toolkit, root)     // → ["kind/name"…] non-root deps
export function includeRefMatches(includeRef, kind, name) // → boolean
export function includeEjectOverlaps(project)  // → [{ include, eject }] — include: ∩ eject: (#497); pure over the config; only an unqualified eject: entry counts (all the selection honors)
export function formatEjectOverlap(overlap)    // → string — the render error / doctor note, remedy included
export function fileMatchesTargets(item, targets) // → boolean (#364: no targets: ⇒ renders unconditionally; scoped ⇒ ≥1 declared target enabled; non-files items always match)
export function computeSelection(toolkit, project, trackedFiles = new Set()) // → { items, closures, errors, targets, targetSkipped, targetBrokenRequires, forwarded, ejectOverlaps } — trackedFiles (prior lock paths) re-admits poured opt-in syrup; targets carried on the result (#364); targetSkipped = include:d files item with every target disabled; targetBrokenRequires = selected item whose requires: edge lands on a scoped-out files item (.optIn = the dep is opt-in in ITS OWN stack). Both always set; targetBrokenRequires is eject-filtered (refs.mjs:579), targetSkipped is not (an ejected include: is an ejectOverlaps error, #497); forwarded = include: refs the registry carried across a rename (#335), warned by render, rewritten by upgrade; stack expansion skips `wip` waffles
export function skippedSyrupCompanions(toolkit, selection) // → [{ fileRef, stackName, companions, scopedTo }] (#74: opt-in syrup gated out while its companion skill IS selected; scopedTo non-null ⇒ target scope excludes this project, warning withholds the pour command but is still issued, #364; NOT eject-aware — an ejected syrup file still lands here, #502)

// template.mjs — {{placeholder}} substitution (PLACEHOLDER regex template.mjs:4; MAX_SUBSTITUTION_DEPTH = 4, template.mjs:7)
export function substitute(text, resolve, declared, errors, context, guards) // → string; guards = { patterns: Map<key,guard[]>, entryPatterns: Map<key,Map<leaf,guard[]>>, modes: Map<key,{modes,lockMode,source}[]> } built by render's compileGuards (render.mjs:672)
export function modeProblems(guards, key, raw, expanded) // → string|null — a behavioral key's raw value must be a scalar and its expanded text one of its modes: (and equal to lockMode: when locked); first problem, null when clean or unguarded (#478)
export const PROMPT_MODE = 'prompt'      // the reserved never-assume mode; isModeScalar(v) / modeMatches(mode, value) are the shared membership rules
export function makeGuard(pattern, source, hint = '')   // → { re, pattern, source, hint } compiled guard record
export function entryPatternProblems(guards, key, value) // → string[] — map-valued key vs its declared entryPatterns: leaves; NEVER short-circuits, it reports EVERY malformed entry and leaf (#246, template.mjs:127); [] when clean or unguarded
export function formatValue(v)                 // → string (string[] joins ", "; else YAML block)
export function placeholderKeys(text)          // → Set<string>
export function compilePattern(pattern)        // → RegExp (full-match ^(?:…)$)

// registry.mjs — the WAFFLE registry (#335): stacks/registry.yaml → identity, location, availability
export const REGISTRY_FILE = 'stacks/registry.yaml'
export const WAFFLE_KINDS = ['agent', 'skill']        // SINGULAR item vocabulary; syrup is out of scope
export const WAFFLE_STATUSES = ['stable', 'wip', 'deprecated', 'replaced']
export const LIVE_STATUSES = ['stable', 'wip', 'deprecated']   // statuses that still exist on disk
export const REGISTRY_ENTRY_KEYS = ['name','kind','stack','path','status','replacedBy','note']
export function refKindOf(kind)                // 'agent'|'skill' → 'agents'|'skills' | null
export function waffleKindOf(kind)             // 'agents'|'skills' → 'agent'|'skill' | null ('files' ⇒ null, out of scope)
export function canonicalWafflePath(stack, kind, name) // → the ONLY path loadStack could load it from | null
export function loadRegistry(rootDir)          // → { present, file, entries, live: Map<"stack::kind/name">, replaced: Map<"kind/name"> } — absent file ⇒ { present:false } (silent no-op); present-but-unreadable ⇒ THROWS; per-entry shape defers to validate
export function waffleStatus(registry, stackName, refKind, name) // → status | null (null = unregistered = available; keyed on the OWNING stack, since a name is not toolkit-unique)
export function isWaffleWip(registry, stackName, refKind, name) // → boolean — fail-open: ONLY the exact string 'wip' gates, because gating DELETES a poured waffle
export function replacementFor(registry, refKind, name) // → { ref, name, via } | null — walks the replacedBy chain transitively; null on a cycle or >8 hops

// toolkit.mjs — load toolkit.yaml + stack manifests
export function loadToolkit(rootDir)           // → { name, description, stacks: Map, registry } (registry = loadRegistry(rootDir), #335) — stack gains .skills [{kind,name,dir,files,data}] (data = SKILL.md frontmatter parsed ONCE at load; toggle, waffledocs and validate read it, never the file, #485), .files [{name,path,binary,targets}] (targets = string[] | null; every targets: malformation — unknown map key, non-list, empty [], unknown target NAME — is a hard LOAD error, #364, because the prune DELETES a poured copy), .optIn Set<"files/…">, .requires, .prerequisites, .recommended (bool, manifest `recommended: true` → setup wizard pre-selects the stack, advisory only, #201), .recommendedPlugins [{name,source,why,items,targets,…}] (external harness plugins `setup` OFFERS; never installed/rendered/locked — plugins.mjs, #199); stale manifest `syrup:` key throws (0.10.0, #59)
export function loadToolkitWithSources({ builtinRoot, externalStacks = [], cwd, cacheDir, gitFetch, gitResolveCommit, refreshSources = false }) // → merged toolkit; external stacks carry .provenance; cross-source name collision throws (#88/#125); carries the BUILT-IN registry unchanged — external waffles are unregistered here, hence never gated (#335); with no externalStacks NOTHING is fetched — it reduces exactly to loadToolkit(builtinRoot) (toolkit.mjs:133)
export function missingRequiredKeys(stack, values, lookup, usedKeys = null) // → string[] (usedKeys Set scopes to referenced keys)

// project.mjs — consuming-project config, targets, harness built-ins, .gitignore + YAML write helpers
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, LOCAL_LOCK_FILE, EXTENSIONS_DIR // .waffle/waffle.* paths (project.mjs:37)
export const LEGACY_ROOT_CONFIG_FILE, LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_ROOT_LOCK_FILE // 0.6.0–0.7.x root .waffle.* names
export const LEGACY_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE, LEGACY_LOCK_FILE, LEGACY_EXTENSIONS_DIR // pre-0.6.0 .wafflestack.* names
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'] // project.mjs:61
export const HARNESS_BUILTINS                  // per-target { assistantName, attributionPath, skillsDir, agentsDir } + target-independent CI-dispatcher scalars { actionRef, actionVersion, apiKeySecret } (#131/#156; project.mjs:599); `harness.toolkitVersion` is NOT here — it is a runtime value the CLI hands `makeResolver` (#461)
export const HARNESS_PATTERNS                  // injection-guard regexes for agentsDir, skillsDir, actionRef, actionVersion, apiKeySecret (reject `${{`, quotes, newlines; project.mjs:623); seeded into render's guards + checked by validate
export function loadProjectConfig(cwd, notes = [], { canonical = false } = {}) // → { targets, stacks, externalStacks, include, values, eject, modelInvocation: { disabled, enabled } }; merges the .local overlay UNLESS canonical (#317); splits bare vs {name,source,ref,acknowledgedChecks} stacks: entries; legacy bundles: read fallback
export function classifyStackSource(source)    // → 'git' | 'path'
export function normalizeStackEntries(raw)     // → { stacks, externalStacks } (#88; unique names, git-needs-ref / path-forbids-ref, unknown-key rejection; optional non-empty acknowledgedChecks, #458)
export function renameLegacyStacksKey(doc)     // in-place comment-preserving bundles:→stacks: KEY rename; → true if renamed
export function dropIncludeEntries(doc, shouldDrop) // → dropped refs, file order — removes matching include: items IN PLACE (sibling comments survive), deletes an emptied key; shared by eject() and the 0.16.0 migration (#501)
export function setScalarIn(source, keyPath, value) // → new text | null (#372/#386: splices ONE scalar's own bytes via node.range, re-parse-verified; NEVER creates a key — missing key/parent, non-scalar, or already-equal value → null, writes nothing)
export function resolveConfigFile(cwd), resolveLocalConfigFile(cwd), resolveLockFile(cwd) // → { file, legacy, note }
export function localLockPath(cwd)             // → absolute .waffle/waffle.local.lock.json (no legacy generations)
export function migrateLegacyDotfiles(cwd)     // → [{ from, to }] — in-place chain .wafflestack.* → .waffle.* → .waffle/waffle.* (idempotent)
export function staleGitignoreEntries(cwd)     // → stale legacy .gitignore lines still present
export function gitignoreMentions(cwd, entry)  // → boolean (literal basename substring, no glob semantics)
export const GITIGNORE_MARKER = '# wafflestack'
export function ensureGitignoreEntries(cwd, entries)  // consent-gated idempotent append (exact-line dedupe); → entries added
export function removeGitignoreEntries(cwd, entries)  // exact-line inverse (#182); strips the marker only once it labels nothing
export function recommendedGitignoreEntries(toolkit, project) // → [local overlay, local lock, + resolved git.worktreesDir when an enabled stack declares it]
export function makeResolver(stack, values, target, runtime = {})   // → (key) => value | undefined (harness.* override → built-in → `runtime[sub]` fallback, the CLI-supplied `toolkitVersion` (#461); else config value → stack default)

// util.mjs — shared helpers
export function sha256(content)                // → hex string
export function isBinary(buffer)               // → boolean (NUL byte in first 8000)
export function readYaml(file)                 // → parsed YAML
export function exists(file)                   // → boolean
export function writeFileEnsuringDir(file, content) // mkdir -p + write
export function deepMerge(a, b)                // → merged (b wins; arrays/scalars replace)
export function lookupPath(obj, dotted)        // → value | undefined (nested keys only — a flat literal "a.b": key is inert)
export const FRONTMATTER_RE                    // /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/ — THE frontmatter grammar (groups: open, block, close); shared by parseFrontmatter and the model-invocation patcher (#485); an empty block matches neither
export function parseFrontmatter(text)         // → { data, body } (FRONTMATTER_RE; no match → { data: {}, body: text })
export function stringifyFrontmatter(data, body) // → string
export function parseVersion(v)                // → [major, minor, patch] | null
export function compareVersions(a, b)          // → -1 | 0 | 1 (unparseable sorts low)
export function resolveInside(cwd, rel)        // → abs path | null — null when `rel` escapes cwd (lexical `../`, or a symlinked parent realpathing outside); shared by uninstall and render's stale-prune (#182, #459)

// doctor.mjs — drift check against the lock that describes the tree (readTreeLock, #317)
export function doctor({ cwd, toolkitVersion, toolkitIdentity = null, allowMissing = false, verifyRender = false, toolkitRoot = null, sourceCacheDir = defaultSourceCacheDir(), canonical = false }) // → { ok, modified, missing, notes, attribution, allowMissing, nothingPresent, prerequisites, render, configProblems, ejectOverlaps, toolkitProvenance } — unmet `require` prerequisite fails ok, as does a non-empty ejectOverlaps (#497); attribution maps external files → source; toolkitProvenance (#374) is a NOTE ONLY, deliberately absent from ok
export function verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, toolkitIdentity = null, sourceCacheDir }) // → { evaluated, ok, checked, stale, absent, unexpected, errors } — re-renders the COMMITTED inputs (no overlay) into a temp dir and diffs against the canonical lock; the working tree is never touched (#314/#317). Disagreement kinds (doctor.mjs:217-223): stale = same path, different hash; absent = the lock tracks a path the config no longer produces; unexpected = the config produces a path the lock does not track

// migrations.mjs — AUTHOR CONTRACT (migrations.mjs:15): key a step by the version that SHIPS the change; run(cwd, { log }) must be IDEMPOTENT — no applied-bookkeeping is persisted, so every upgrade whose (from, to] window covers a step re-invokes it. A key past package.json's version is PENDING (#501): it must be announced under CHANGELOG [Unreleased] as "migration `X.Y.Z`" (migrations.test.mjs release guard — a bump below the key fails CI), and an UNRELEASED toolkit runs it anyway
export const MIGRATIONS                        // [{ version, description, run(cwd, { log }) }] — 0.6.0 dotfile rename, 0.8.0 config move, 0.10.0 bundles:→stacks:, 0.16.0 drop include: ∩ eject: from the COMMITTED config via includeEjectOverlaps + dropIncludeEntries (never the overlay — its lists replace wholesale, #500; overlay overlaps are logged)
export function migrationCeiling(version, migrations = MIGRATIONS) // → the newest step version past `version`, else `version` — what an unreleased toolkit migrates up to
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) // → steps in (from, to], ascending
export function runMigrations({ cwd, fromVersion, toVersion, migrations, log }) // → steps that ran

// upgrade.mjs — version diff, changelog delta, migrations, pin reconcile (#372), re-render + doctor
export function upgrade({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, migrations, changelog, sourceCacheDir, log }) // → { ok, status, fromVersion, toVersion, identity, changelogDelta, migrationsRun, render, doctor, sourceMoves, toolkitMove, pinMoves, waffleMoves, newerRelease, notes } — renders with refreshSources: true; call order: runMigrations → reconcileToolkitRefPins → forwardRenamedWaffleRefs (#335) → renderProject (render re-reads waffle.yaml, so one run bakes the new pin into the render); runs on EVERY status incl. current; migrations run in (from, to] on status `upgrade` — and an UNRELEASED identity lifts `to` to migrationCeiling on `upgrade`/`current`, so its pending steps run (#501); newerRelease = { tag, command } | null names the pinned command a stale pinned CLI cannot itself run (no re-exec, #373); pinMoves/newerRelease ride the render-failed early return too
export function forwardRenamedWaffleRefs({ toolkitRoot, cwd, log, writeScalar = setScalarIn }) // → [{ from, to, action: 'forwarded'|'unwritable' }] (#335) — rewrites `include:` refs naming a `replaced` waffle to its successor in the COMMITTED waffle.yaml only; unqualified target (the successor may live in another stack); byte-verbatim via setScalarIn, dirty-guarded; never touches stacks:/eject:; a corrupt/absent registry writes nothing
export function reconcileToolkitRefPins({ cwd, identity = null, log, writeScalar = setScalarIn }) // → pinMoves [{ key, from, to, action: 'bumped'|'unchanged'|'left'|'skipped'|'unwritable', reason }] (#372; 'unwritable' = setScalarIn declined the splice, so nothing was written and it is never reported as a bump, #387, upgrade.mjs:236) — rewrites config.doctor.toolkitRef / config.waffle.toolkitRef in the COMMITTED waffle.yaml (never the .local overlay) to toolkitPinFromIdentity(identity), iff the value is already a shorthand release pin; byte-verbatim via setScalarIn, dirty-guarded; null pin (unreleased/unverified/checkout-release) ⇒ nothing written, reason logged; a URL-form pin (#386 F3) is read but never rewritten — reported `left` with the remedy
export function diffSources(oldSources, newSources) // → [{ name, ref, sourceType, from, to, status: 'moved'|'added'|'removed' }] (#125)
export function diffToolkit(prev, next, { fromVersion, toVersion }) // → { from, to, fromRef, toRef, fromVersion, toVersion, fromStatus, toStatus, status: 'moved'|'unchanged'|'added'|'removed'|'unknown' } | null (#374; 'moved' at the SAME version = a re-cut tag; 'unknown' = one side recorded no commit)
export function changelogBetween(text, fromVersion, toVersion) // → markdown of `## [X.Y.Z]` sections in (from, to], newest first | null

// uninstall.mjs — the only destructive command (#182); the lock is the sole authority for what is ours
export function planUninstall({ cwd, toolkitRoot = null, force = false, keepConfig = false, keepLock = false, keepLockOnSkip = true }) // → { lock: 'canonical'|'local'|null, lockFile, remove, drifted, absent, refused, meta, prunedDirs, gitignore, ejected, lockRetained, notes } — pure, touches no disk; classifies each tracked path remove (sha256 matches) / drifted (hand-edited, skipped unless force) / absent / refused (resolves outside cwd — resolveInside rejects lexical ../ escapes AND realpaths the deepest existing ancestor against symlink escapes; any refusal aborts the whole run)
export function uninstall({ cwd, toolkitRoot, force = false, allowMissing = false, keepConfig = false, keepLock = false, keepLockOnSkip = true, dryRun = true, log }) // → { ok, dryRun, plan, removed, skipped, errors } — dryRun DEFAULTS TRUE at the library boundary; ok = no errors (a skipped-only run is ok:true); the returned plan's lockRetained is the OUTCOME, reconciled after execution
export function reinstall({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, clean = false, force = false, log }) // → { ok, uninstall, render, initialized, restored, errors } — refresh: snapshot doomed bytes → uninstall(keepConfig+keepLock, force:true) → renderProject, snapshot restored if either leg fails; clean: uninstall-everything(keepLockOnSkip:false) → init, no render

// eject.mjs
export function eject({ cwd, item, toolkitRoot = null, log }) // → { ref, released, orphaned } (drops the item's files from the lock, strips a matching include: entry; files stay in place, project-owned; NEVER renders — orphaned = closure-only deps the next render prunes, [] without toolkitRoot, #497)
export function installRefs({ toolkitRoot, cwd, refs, log }) // → { added, closures, unejected: [{ ref, kind, name }], rollback() } (persist refs to config; an ejected item ref is un-ejected, #497; rollback() restores the config text as found; caller renders after)
export function unejectCollisions(unejected, collisions = []) // → string[] — the refused render collisions that are an un-ejected item's project-owned files (#497); non-empty ⇒ the CLI rolls the install back
export function init({ cwd })                  // → configFile path (starter .waffle/waffle.yaml)

// validate.mjs — see the module table; targets: is NOT linted here (every malformation is a hard LOAD error in toolkit.mjs)
export const RESERVED_AGENT_KEYS = ['name', 'description', 'skills', 'identity'] // validate.mjs:55
export function validateToolkit(rootDir)       // → string[] problems ([] = clean): manifests, frontmatter, placeholder↔declaration sync, requires: integrity, pattern:/entryPatterns: compilability + default-match, behavioral-key fields (modes:/flag:/lockMode:/nonInteractive:, #478), prerequisites fields, harness built-ins, waffle-registry reconcile
export function behavioralKeyProblems(spec)    // → string[] — the #478 lint for one config: spec: modes non-empty/distinct scalars with default a member and no pattern:; lockMode = default and ∈ modes; flag { on, off } single tokens on boolean modes; nonInteractive required iff prompt ∈ modes
export function validateRegistry(rootDir, toolkit) // → string[] — the registry ↔ filesystem ↔ stack.yaml three-way reconcile (#335): entry shape/unknown keys, duplicates, stack+path must be the loader's path and exist, stack.yaml must list it, tombstone must NOT still resolve and its replacedBy chain must end live, un-registered waffles on disk OR in a manifest, and an offered waffle requiring a `wip` one. [] when the toolkit ships no registry (fork/fixture) or the stack is external
export function validateSourceBytes(rootDir)   // → string[] — raw control bytes in installer/ + stacks/ text sources
export function validateHarnessBuiltins()      // → string[] — every HARNESS_PATTERNS guard compiles and its built-in default satisfies it
export function validateExternalStacks(toolkit) // → string[] — lint only source-bearing stacks (render calls pre-write, #126)
export function validateStack(toolkit, stack, ctx) // → string[] (one stack; reused for external lint)

// setup.mjs
export function setupGuide(toolkitRoot, toolkitVersion, cwd) // → string — schema/SETUP.md playbook + inventory; on an already-configured cwd injects a "Current configuration — update mode" section
export function toolkitInventory(toolkit, version) // → string

// waffledocs.mjs — generated .waffle/ overview docs, emitted via render's emit() (lock-tracked + pruned)
export function generateWaffleDocs({ toolkit, project, selection, errors = [] }) // → [{ rel, content }] for .waffle/{CHEATSHEET.md,cheatsheet.html,TEAM.md,team.html,AVATARS.md,avatars/<agent>.svg}; each set omitted when its item set is empty
export function agentFlavor(name)              // → deterministic per-agent palette/persona seed (name-hashed)
export function agentAvatarSvg(name, skillCount = 0, opts) // → inline wafflebot avatar SVG (#161)
export function extractBaseEmail(gitCmd)       // → the `-c user.email=` value of a resolved git.cmd | null (#157)
export function deriveAgentEmail(baseEmail, slug) // → base plus-addressed with +<slug>, or verbatim when it cannot subaddress; null base → null (#157)
export function withIdentity(gitCmd, displayName, email) // → git.cmd with -c user.name/-c user.email swapped in place (#157)
export function collectAgentAvatars({ toolkit, project, selection }) // → { rows: [{ name, email, svg, skillCount, overridden, … }], git } — the same rows/emails AVATARS.md describes; consumed by avatars-sync (#285)

// avatars-sync.mjs — owner-side Gravatar pipeline (#285); never exercised by npm test against a real network
export const GRAVATAR_BASE = 'https://api.gravatar.com/v3', TOKEN_ENV = 'WAFFLE_GRAVATAR_TOKEN'
export function emailHash(email)               // → sha256 hex of lowercased-trimmed email
export async function syncAvatars({ agents, token, http, rasterize, log, mode = 'sync' }) // → { synced, pending, skipped, failed, mode } — probe /me/associated-email → upload/rate-G/assign; unverified emails → pending remainder; per-agent errors isolated into failed[]; throws NO_TOKEN on falsy token
export function avatarsExitCode({ mode, pending, failed }) // → 0|1 — any failed ⇒ 1; status + pending drift ⇒ 1 (pure)
export function enumerateAgentAvatars({ toolkitRoot, cwd }) // → { rows, git } via collectAgentAvatars
export function makeGravatarHttp(fetchImpl = globalThis.fetch) // → { getAssociatedEmail, uploadAvatar, setRating, associateAvatarEmail }
export const RASTERIZERS                       // ordered SVG→PNG converters probed by --version: rsvg-convert, magick, convert, npx svgexport
export function makeShellRasterizer()          // → async (svg) => Buffer (512px PNG; throws if none on PATH)
export async function runAvatarsSync({ toolkitRoot, cwd, mode = 'sync', env = process.env, log, http, rasterize }) // → syncAvatars result (wires real client unless injected; short-circuits with no bot identity)

// evals.mjs — Layer 2 eval harness (#109); driven by installer/evals.mjs (`npm run evals`), never npm test
export const DEFAULT_MODEL = 'claude-opus-4-8', DEFAULT_MAX_OUTPUT_TOKENS = 2048
export class Budget                            // hard call cap enforced BEFORE each call
export class BudgetExceededError               // stops the run; remaining cases skipped
export function discoverCases(toolkitRoot, { onlyStack = null } = {}) // → stacks/*/evals/*.eval.yaml case files
export function loadCase(file, stackName)      // → case object
export function validateCase(raw)              // → string[] problems
export function renderTargetPrompt(toolkitRoot, { stack, target, config = {} }) // → { body, description, rendered, leftover } — renderProject into a temp project; body becomes the system prompt; leftover = load-bearing config placeholders that survived substitution, i.e. an authoring bug (evals.mjs:201)
export async function evaluateAssertion(assertion, transcript, { callModel } = {}) // includes/excludes/regex deterministic; judge LLM-graded
export function parseVerdict(text)             // → judge verdict
export async function runCase(caseObj, { toolkitRoot, callModel, budget, model = DEFAULT_MODEL })
export async function runEvals(cases, { toolkitRoot, callModel, makeCallModel, budget, model = DEFAULT_MODEL, onResult } = {})
export function anthropicClient({ apiKey, defaultModel = DEFAULT_MODEL, fetchImpl = globalThis.fetch }) // fetch-based, no SDK dep
export function mockClient({ scenarioText = null } = {}) // dry-run/test client

// list.mjs — `list` command (#119); built-in surface only (external source: stacks list as a selection error)
export const STATUS                            // { CURRENT, OUTDATED, NOT_INSTALLED, NOT_INSTALLABLE, PENDING_REMOVAL } — the last two = target-scoped syrup this project cannot render; PENDING_REMOVAL = poured under an older targets:, on disk + in the lock NOW, deleted by the next render (#364; asks render's own prune question, not a bare on-disk check, because itemOutputMatcher is stack-blind)
export function computeListModel({ toolkitRoot, cwd, toolkitVersion }) // → { toolkitName, toolkitVersion, lockVersion, hasLock, hasConfig, versionSkew, configError, notes, errors, stacks: [{ name, description, enabled, rows }], counts }
export function formatListTable(model, { color = false } = {}) // → aligned plain-text table; color gates ANSI
export function selectableChoices(model)       // → actionable rows (not current, not scoped out; outdated pre-checked) (pure)
export function interactiveSelect(model, { input, output } = {}) // → Promise<{ applied, refs, reason? }> (keypress multi-select; TTY-guarded by caller)
export function keypressMultiSelect({ title, choices, label, input, output }) // → Promise<{ applied, checked }> — the shared ↑/↓/space/a/enter/esc loop behind `list --interactive` and `toggle` (#476); mutates choices[].checked; TTY-guarded by caller
export const ANSI                              // escape codes the tables and pickers share

// model-invocation.mjs — per-skill `disable-model-invocation` override (#476); pure, imports only util
export const MODEL_INVOCATION_KEY = 'disable-model-invocation', CONFIG_PATH = ['skills', 'modelInvocation']
export const emptyOverride = ()               // → { disabled: [], enabled: [] } — a fresh normalized override; what normalizeModelInvocation returns for an absent block
export function normalizeModelInvocation(rawSkills, configFile) // → { disabled: string[], enabled: string[] } — validates the `skills:` block (map, allowed keys, string lists, no name on both sides; `skills/` prefix shed, deduped); THROWS on any shape error
export function overrideFor(override, name)     // → true (disable) | false (enable) | null (source wins)
export function frontmatterDisablesModelInvocation(data) // → boolean — parsed frontmatter (`SkillItem.data`) has the literal `true`; what toggle reads (#485)
export function sourceDisablesModelInvocation(source) // → boolean — the same verdict from SKILL.md text
export function applyModelInvocation(content, disable) // → patched text: true sets the key (in place, else appended as the last frontmatter line), false strips it, null returns the input untouched; no frontmatter → untouched

// harness-tools.mjs — per-target harness tool roster (#445); pure, no imports (Target is a JSDoc type import)
export const HARNESS_TOOLS                     // Readonly<Record<Target, ReadonlyArray<string> | null>> — sorted, unique; null = no declared call-shaped surface (per-target check SKIPS visibly; [] would assert "calls nothing")
export const DEAD_HARNESS_TOOLS                // ['TeamCreate','TeamDelete','TeamList'] (#360) — asserted absent from every roster
export const toolsForTarget = (target)         // → ReadonlyArray<string> | null
export const anyTargetTools = ()               // → Set<string> — the union every harness-neutral SOURCE is checked against
export function toolCalls(text)                // → [{ name, line }] — `Name(` with the paren ATTACHED (`PR (draft)` is prose); skips `new X(` / `new {{k}}X(`, `function X(`, `a.X(`, and `X(s)` plurals
export function unknownToolCalls(text, roster) // → the toolCalls whose name is outside `roster`

// toggle.mjs — `toggle` command (#476); rendered skills only, externals never listed (#471)
export function computeToggleModel({ toolkitRoot, cwd }) // → { hasClaude, rows: [{ name, stack, sourceDisabled, disabled, override }], carried: { disabled, enabled }, errors } — COMMITTED config (canonical), tree lock for the selection
export function formatToggleTable(model, { color = false } = {}) // → plain table (agent-invocable | slash-only, (source) | (override)); color gates ANSI
export function toggleChoices(model)           // → picker rows, checked = agent-invocable (pure)
export function interactiveToggle(model, { input, output } = {}) // → Promise<{ applied, disable, enable, reason? }> — the FULL desired state; TTY-guarded by caller
export function applyToggle({ cwd, model, disable = [], enable = [] }) // → { changed, disabled, enabled, unknown } — minimal block (only where a skill differs from its source) written comment-preservingly to waffle.yaml; empty block removed; unknown names write nothing — this is THE unknown-name check; the CLI only formats `unknown` with the rendered list (#485)

// report.mjs — `report` bundle (#473); the overlay and the local lock are never opened
export function collectReport({ cwd, toolkitRoot, toolkitVersion, toolkitIdentity = null, home = os.homedir(), platform = process.platform, nodeVersion = process.version }) // → redacted bundle { cli: { version, status, commit }, lock, config, environment: { node, platform, localOverlay, localLock }, health } — config loaded canonical, doctor run canonical, then redact() over every string
export function keyPaths(obj, prefix = '')     // → string[] sorted dotted key paths; arrays and scalars are leaves, values dropped
export function scrub(text, { cwd, home } = {}) // → string — cwd → `<repo>`, home → `~`, git remote URLs → `<git-remote>`, emails → `<email>` (in that order)
export function redact(value, scope)           // → value with scrub applied to every string in the tree, object keys included
export function formatReportMarkdown(b)        // → string — the collapsed Markdown `<details>` block; the only renderer export

// prerequisites.mjs — typed external prerequisites (#47/#129)
export const PREREQ_KINDS = ['tool','secret','scope','label','setting','service','env'], PREREQ_LEVELS = ['require','recommend']
export const RENDER_PROBE_KINDS                // Set{'tool','env'} — the cheap kinds render probes (doctor probes all)
export function normalizePrerequisites(raw)    // → [{ kind, name, description, check, level, items }] (tolerant; linted by validate)
export function runCheck(check, cwd, { timeoutMs = 15000 } = {}) // → { ran, ok } (shell check, exit 0 = ok, stdio ignored)
export function applicablePrerequisites(toolkit, selection) // → flat [{ …prereq, stackName }] scoped to the selection
export function evaluatePrerequisites(prereqs, cwd, { kinds = null, timeoutMs, skipStacks = new Set() } = {}) // → { unmetRequired, unmetRecommended, met, notRun } — a prereq whose stackName is in skipStacks is bucketed notRun, never spawned (#458)
export function describeProvenance(prov)       // → `source@ref` | `source`
export function checksDigest(stack)            // → sha256 hex of prerequisites[].check (manifest order) | null when none would run
export function looksLikeBranchRef(ref)        // → true unless SHA-shaped or v1.2.3-shaped
export function externalCheckGates(toolkit, project) // → [{ stackName, stack, provenance, digest, recorded, acknowledged }] per enabled external stack with checks (#458)
export function unacknowledgedStacks(gates)    // → Set<stackName> whose checks must not run
export function formatCheckGate(gate)          // → multi-line trust-boundary listing (source, ref, every [level] kind name — check, the acknowledgedChecks line; branch-ref warning)
export function formatPrereq(p)                // → one actionable CLI line

// plugins.mjs — recommended EXTERNAL harness plugins (#199): stack.yaml `recommendedPlugins:` → an OFFER `setup` makes; never fetched/rendered/locked (rationale: FORMAT.md)
export const PLUGIN_ENTRY_KEYS                 // ['name','source','why','items','targets'] — anything else is a validate problem
export function normalizeRecommendedPlugins(raw) // → [{ index, name, source, why, items, targets, unknownKeys, raw }] — never throws; a non-list value becomes ONE unusable entry so validate reports it; items normalized to kind/name refs; targets advisory (printed, never a filter)
export function offerablePlugins(plugins)      // → entries with a usable name + source; malformed ones are validate's report and are not shown

// sources.mjs — external source: resolution (#88/#125)
export function resolveSource(ext, { cwd, cacheDir, gitFetch, gitResolveCommit, gitOriginUrl, gitRefCommit, refresh = false } = {}) // → { root, commit } (local path in place, or git fetched at the pinned ref into a content-addressed cache; rejects leading-`-` source/ref; a present `.git` is served ONLY if checkoutMatches, else discarded + re-fetched (#460))
export function resolveSourceRoot(ext, opts)   // → root path only (back-compat wrapper)
export function gitFetchCheckout(source, ref, dest) // default git clone + checkout (injectable)
export function gitHeadCommit(dir)             // → resolved HEAD SHA (injectable)
export function gitRemoteOriginUrl(dir)        // → `origin` remote URL (injectable)
export function gitResolveRefCommit(dir, ref)  // → SHA `ref^{commit}` resolves to in the checkout (injectable)
export function checkoutMatches(dir, ext, { gitResolveCommit, gitOriginUrl, gitRefCommit } = {}) // → boolean: HEAD resolves AND origin === ext.source AND ref^{commit} === HEAD; any throw → false
export function defaultSourceCacheDir(env = process.env) // → $XDG_CACHE_HOME/wafflestack/sources (absolute only), else ~/.cache/wafflestack/sources; created 0700 — never os.tmpdir() (#460)

// toolkit-ref.mjs — see the module table. INVARIANT: ref/commit recorded IFF status === 'release'; identity failure fails OPEN (unverified → warn + proceed); an unverified render carries the previous toolkit block forward when version + files map are unchanged
export function resolveToolkitIdentity({ toolkitRoot, lsRemote, runGit, offline }) // → { status: 'release'|'unreleased'|'unverified', version, commit, tag, ref, origin: 'checkout'|'npm-install'|'unknown', repo, latestTag, lookupError } — checkout resolves via `git describe --tags --exact-match` (offline); npm-install reads the SHA from npm's hidden lockfile then classifies via ONE `git ls-remote --tags` (never the REST API); lookup skipped ONLY by `offline`, never by the hatch (#383); lsRemote/runGit injectable
export function commitFromNpmLockfile(toolkitRoot, pkgName) // → sha40 | null (from ../.package-lock.json `resolved`)
export function shaFromResolved(resolved)      // → sha40 | null
export function parseLsRemoteTags(stdout)      // → tag→SHA map (peeled ^{} wins; non-vX.Y.Z filtered)
export function latestReleaseTag(tags)         // → highest vX.Y.Z tag
export function toolkitRef(slug, tag)          // → `github:<owner>/<repo>#<tag>`
export function toolkitSource(repo)            // → `github:owner/repo`
export function toolkitLockEntry(identity, { prevLock, newFiles, toolkitVersion }) // → { source, sourceType:'git', ref, commit, status } | null (null ⇒ block omitted)
export function toolkitPinFromLock(lock)       // → `github:<owner>/<repo>#<tag>` | null (#372's read-back — never string surgery on the lock)
export function toolkitPinFromIdentity(identity) // → pin | null — literally toolkitPinFromLock({toolkit: toolkitLockEntry(identity)}), so the pin upgrade writes IS the value render locks
export function classifyToolkitRefValue(value) // → { kind: 'absent'|'unpinned'|'release-pin'|'other-pin'|'not-github', slug?, fragment?, form?: 'shorthand'|'url' } — only a shorthand release-pin may be rewritten; url form is read but never rewritten (#386 F3)
export function describeToolkitProvenance({ lockToolkit, lockVersion, identity }) // → { status: 'not-recorded'|'unpinnable'|'unverifiable'|'match'|'recut'|'mismatch', notes } — 'recut' = same version, different commit
export function repoSlug({ toolkitRoot, pkg, runGit }) // → { owner, repo } | null
export function lockRepoSlug({ toolkitRoot, pkg }) // → slug from npm lockfile resolved URL, else pkg.repository
export function parseRepoSlug(url)             // → { owner, repo } | null — the ONE gate on the host (lookalike hosts and path segments are not github)
export function httpsUrl(slug)                 // → https clone URL (normalizes git+ssh so unauthenticated ls-remote works)
export function gitLsRemoteTags(url)           // → raw ls-remote stdout (no --refs; GIT_TERMINAL_PROMPT=0; non-zero exit throws → 'unverified')
export function gitCapture(cwd, args)          // → stdout | null (null is data: `git describe --exact-match` fails when HEAD is untagged)
export function changelogHasUnreleasedEntries(text) // → boolean (offline corroborator: non-empty ## [Unreleased] tightens unverified → unreleased)
export function changelogLatestRelease(text)   // → latest released version in the shipped CHANGELOG
export function formatUnreleasedRefusal(identity, command) // → refusal text naming the exact pinned command
export function formatProvenanceWarning(identity) // → stderr warning for non-gated commands
```

Import graph (real `import` statements only; `util.mjs` and `template.mjs` depend only on `yaml`):

```
cli.mjs      → render, doctor, eject, validate, setup, report, upgrade, uninstall, toolkit,
               prerequisites, list, toggle, toolkit-ref, project, avatars-sync (dynamic)
render.mjs   → template, toolkit-ref, toolkit, sources, refs, validate, prerequisites, waffledocs, model-invocation, project, util
doctor.mjs   → render, project, toolkit-ref, toolkit, refs, prerequisites, sources, util
report.mjs   → render, doctor, prerequisites, project, util
upgrade.mjs  → render, doctor, migrations, project, toolkit-ref, registry, refs, util
uninstall.mjs → render, eject, toolkit, project, util
eject.mjs    → render, toolkit, sources, refs, project, util
validate.mjs → toolkit, template, refs, prerequisites, plugins, project, registry
setup.mjs    → toolkit, render, project, refs, prerequisites, plugins, registry, util
list.mjs     → toolkit, render, refs, project, util
toggle.mjs   → toolkit, sources, refs, render, project, list, model-invocation
model-invocation.mjs → util
harness-tools.mjs → (nothing; test-only consumer: content.test.mjs)
waffledocs.mjs → template, project, refs, util
avatars-sync.mjs → toolkit, project, refs, waffledocs
evals.mjs    → render, template, util
migrations.mjs → project, refs, util
toolkit.mjs  → refs, sources, prerequisites, plugins, registry, project (VALID_TARGETS only), util
prerequisites.mjs → refs
plugins.mjs  → refs
refs.mjs     → project (VALID_TARGETS only), registry (the wip/replaced gate; registry.mjs imports only util.mjs — no cycle)
registry.mjs → util
sources.mjs  → util
toolkit-ref.mjs → util
project.mjs  → util, model-invocation (model-invocation.mjs imports only util.mjs — no cycle)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Usage:
`wafflestack <init|setup|list|toggle|install|render|bake|upgrade|doctor|report|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]`
(`USAGE`, `cli.mjs:47`).

Dispatch and exit contract: `help`/`--help`/`-h` print the full help to stdout, exit 0 —
intercepted before the switch (`cli.mjs:52`), so `uninstall --help` explains rather than deletes;
there is no per-command help page (#187, `helpText` `cli.mjs:363`). An unknown command, and bare
`wafflestack`, print banner + usage to stderr, exit 1. Flags are spliced out by name
(`extractFlag` `cli.mjs:495`, `extractCwd` `cli.mjs:486`), so an unrecognized flag survives as a
positional: `render`/`bake`/`upgrade`/`list`/`toggle`/`report`/`uninstall`/`reinstall` reject it (takes-no-refs
guard), `install`/`eject` fail resolving it as a ref, `avatars` rejects a non-`sync`/`status`
first arg, `init`/`setup`/`doctor`/`validate` silently ignore it.

| Flag | Commands | Effect |
|------|----------|--------|
| `--cwd DIR` | every command | run against DIR; spliced out before ref parsing |
| `--help`, `-h` | every command | print help to stdout, exit 0; intercepted before dispatch |
| `--force` | `render`, `bake`, `install`, `reinstall` | override render's unmanaged-file overwrite guard |
| `--force` | `uninstall`, `reinstall --clean` | also delete drifted (hand-edited) managed files |
| `--gitignore` | `init`, `render`, `bake`, `install` | append the recommended `.gitignore` entries |
| `--yes` | `uninstall` | actually delete; without it `uninstall` is a dry run |
| `--yes` | `reinstall` | required by `--clean` only; a plain refresh needs none |
| `--keep-config` | `uninstall` | keep `.waffle/` — config, overlay, `extensions/` and both locks |
| `--clean` | `reinstall` | wipe incl. config, then re-scaffold via `init` (requires `--yes`) |
| `--allow-missing` | `doctor`, `uninstall` | tolerate managed files absent from disk |
| `--verify-render` | `doctor` | re-render committed inputs in a temp dir vs the committed lock |
| `--interactive` | `list` | keypress multi-select; needs a real TTY, else degrades to the table |
| `--json` | `report` | print the diagnostics bundle as JSON on stdout instead of the Markdown `<details>` block |
| `--disable SKILL` / `--enable SKILL` | `toggle` | #476: set / clear the per-skill model-invocation override without the picker; repeatable, comma-splittable (`extractValues` `cli.mjs:475`); either flag skips the TTY prompt; a name on both sides, a name no selected stack renders, or a flag with no value exits 1 before anything is written |
| `--no-color` | `list`, `toggle` | suppress ANSI; the `NO_COLOR` env var does the same (`cli.mjs:236`, `cli.mjs:264`); neither is listed in `help`'s flag block (#359) |
| `--allow-unreleased` | every command (spliced globally) | #373: suppress the release gate's refusal (toolkit development only); env twin `WAFFLESTACK_ALLOW_UNRELEASED=1`. Suppresses the refusal, not the truth — identity still resolves, network lookup included, so a genuine release keeps its `ref` under the hatch (#383) |
| `--offline` | every command (spliced globally) | #383: skip the network release lookup (`git ls-remote`); env twin `WAFFLESTACK_OFFLINE=1`. Fails open (identity degrades to `unverified`, `ref: null`); the ONLY switch that skips the lookup — orthogonal to `--allow-unreleased` ("don't refuse me" vs. "don't pay for the answer") |

Release gate (#373; truth in `toolkit-ref.mjs`, gate in `cli.mjs`). Before writing files from
toolkit content, the CLI resolves its own identity and refuses (exit 1, naming the exact pinned
command) when provably not a release. Gated: `render`/`bake`, `install`, `upgrade`, `reinstall`,
`doctor --verify-render`, `list --interactive` (once a selection is applied), `toggle` whenever it
writes (`--disable`/`--enable`, and the TTY picker — gated BEFORE the prompt so a refusal never
follows the user's picks). Not gated: plain `toggle` with no flags (read-only table ⇒ warning),
`doctor` (pure hash-vs-lock; gets the offline identity), `list`/`setup` (read-only ⇒
`formatProvenanceWarning` to stderr), `report` (read-only ⇒ warning, and OFFLINE identity so a
diagnostics dump never stalls on a lookup), `init`, `eject`, `uninstall`, `validate`, `avatars`, `help`.
`unverified` (offline / no git / unreadable npm lockfile) proceeds with a warning — fail open on
ignorance, fail closed only on a successful "not a release" lookup. The identity is threaded to
`renderProject`/`upgrade`/`reinstall` and written into the lock's `toolkit` block (#374).

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.waffle/waffle.yaml`; errors if one exists at any generation. `--gitignore` appends the two pre-stack-knowable entries (local overlay + local lock). `eject.mjs:234` |
| `setup` | Print `schema/SETUP.md` playbook + toolkit inventory; already-configured cwd adds a live update-mode section. `setup.mjs:22` |
| `list` | Per-stack per-item state table (`current`/`outdated`/`not-installed`/`not-installable`/`PENDING REMOVAL`); plain aligned table by default (ANSI only on a TTY); `--interactive` multi-select installs + renders. Takes no refs. `list.mjs`, `cli.mjs:214` |
| `toggle` | Per-skill agent-invocation override (#476): one row per RENDERED skill (`agent-invocable` / `slash-only`, `(source)` / `(override)`), read from the COMMITTED config and the tree lock; externals (#471) never listed. No flags + real TTY on stdin AND stdout → keypress picker (checked = agent-invocable; `enter` writes the FULL desired state, `esc` writes nothing); no flags + non-TTY → the plain table, exit 0, readline never opened; `--disable`/`--enable` → write without a prompt. A write persists a MINIMAL `skills.modelInvocation` block (a skill lands in `disabled:`/`enabled:` only where it differs from its source; empty block removed) to `waffle.yaml` comment-preservingly, then runs a full render so the lock records the patched skill. `no change` when every named skill is already in that state. Takes no refs. `toggle.mjs`, `cli.mjs:240` |
| `install [ref…]` | Persist each ref to config (stack → `stacks:`, item → canonical `include:`), then render. An EJECTED item ref is un-ejected, loudly (#497); if the render then refuses to overwrite its project-owned copy (no `--force`), the config is rolled back and the item stays ejected. Bare `install` = `render`. `eject.mjs:100` |
| `render` | Regenerate all managed files verbatim, prune stale managed files, write lock. Rejects positional refs. Refuses to overwrite a pre-existing untracked file unless `--force` (`render.mjs:181`). `render.mjs:52` |
| `bake` | Pure alias for `render` — a fall-through case sharing its body and guards (#176). |
| `upgrade` | Lock-vs-CLI version diff, CHANGELOG delta, migrations in `(from, to]` (an unreleased toolkit also runs the steps keyed past its version, #501), pin reconcile (#372), render (`refreshSources: true`, reporting source + built-in toolkit commit moves, #374) + doctor. Missing lock degrades to render + doctor; a lock recording no `toolkitVersion` skips migrations and the changelog delta (`upgrade.mjs:51`). Exit follows doctor. `upgrade.mjs:28` |
| `doctor` | Diff managed files vs `readTreeLock`; report `toolkitVersion` + skew note + `toolkit` provenance note (#374, warning only); run selected stacks' `prerequisites:` checks. Exit 1 on drift, an unmet `require` prerequisite, OR an `include:` ∩ `eject:` overlap (#497, `ejectOverlaps` + an `include/eject overlap:` note; needs no toolkit). `--allow-missing`: only modified files count. `canonical: true` (library option, #473): compare against the committed lock and load the config without the overlay — neither local file is opened. `doctor.mjs:37` |
| `report` | Print a REDACTED diagnostics bundle for an upstream toolkit bug report (#473): committed lock summary (version, `toolkit` block, targets, stacks, include, tracked-file COUNT, external source names), committed config (targets, stacks, external names/refs, eject, config KEY paths — never values), environment (CLI version/status, node, platform, overlay PRESENCE), and a `doctor({ canonical: true })` summary. Never opens `waffle.local.yaml` or `waffle.local.lock.json`; scrubs cwd/home/emails/remotes. Markdown `<details>` by default, `--json` for machines. Takes no refs; never contacts GitHub; exit 0 even on a red doctor. `report.mjs`, `cli.mjs:119` |
| `eject <kind/NAME>` | Add to `eject:`, strip matching `include:`, drop the item's files from the lock; files stay in place, project-owned. Never renders (offline, ungated): prints a run-`render` hint naming closure-only deps the dropped include orphaned (#497). `eject.mjs:26` |
| `uninstall` | Remove the whole install, driven entirely off the lock: `remove` only when the sha256 still matches the render; `drifted` skipped unless `--force`; refuses the whole run on an absent lock or a path resolving outside `cwd` (incl. symlink escapes). Also removes `.waffle/` meta (unless `--keep-config`), prunes genuinely-emptied dirs, strips wafflestack's `.gitignore` lines. Dry run until `--yes`. Skips exit 0; errors exit 1 (#359). Read `lockRetained` off the result, not the plan. `uninstall.mjs` (#182) |
| `reinstall` | Refresh in place: snapshot → uninstall(keepConfig+keepLock, force) → re-render, rollback on failure; keeping the lock is load-bearing (the `trackedFiles` re-admission keeps poured opt-in syrup selected). `--clean` = wipe to empty + `init` (requires `--yes`, no render). Both shapes need a lock (#359). `uninstall.mjs` (#182) |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline (#285): `sync` rasters + uploads/assigns each verified agent email's avatar; `status` reports drift only. Token from `WAFFLE_GRAVATAR_TOKEN`; unverified addresses are a manual remainder. `status` exits 1 on drift; any `failed` exits 1. `avatars-sync.mjs`, `cli.mjs:271` |
| `validate` | Toolkit-developer lint (see `validate.mjs` above). Exit 1 on problems. `validate.mjs:58` |
| `help` | Banner + usage + one line per command/flag to stdout, exit 0. `helpText` `cli.mjs:363` (#187) |

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, `requires:`) names something installable.
Grammar + resolution in `refs.mjs` (`parseRef` `refs.mjs:133`, `resolveRef` `refs.mjs:201`).
Kinds: `agents`, `skills`, `files` (a payload byte/text-copied to its repo-relative path).

| Form | Example | Meaning |
|------|---------|---------|
| stack | `github-workflow` | a whole stack |
| item | `skills/issue`, `files/.github/workflows/waffle-hygiene.yml` | unqualified; must be unique toolkit-wide |
| qualified | `engineering-team/skills/webapp-security-audit` | disambiguates cross-stack collisions |

`canonicalRef` is the minimal re-resolvable form — what `install` writes to `include:`.

Render selection (`computeSelection`, `refs.mjs:467`):

```
rendered = union(items of enabled stacks:) ∪ closure(each include: item) − eject:
```

- Opt-in syrup gate — a stack's `optIn:` `files/` items are excluded from default expansion
  unless already lock-tracked (`trackedFiles`) or explicitly `include:`-ed (`refs.mjs:496`):
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
  `targetBrokenRequires` skips it. Known gap (#371): a poured file whose STACK was deselected is
  pruned while `list` says `not-installed` — a hidden deletion, predates #364. Known gap (#502,
  open): the #74 companion warning still fires for an EJECTED syrup file, and the `install` it
  advises un-ejects the item (#497).
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
  adopted, differing refuses without `--force`, and the CLI then calls `rollback()`
  (`unejectCollisions` against the render's `collisions`), leaving `waffle.yaml` as found.
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
- Value formatting (`formatValue`, `template.mjs:188`): strings verbatim; string arrays join
  `, `; other structures render as a YAML block.
- `harness.*` — reserved, always-available namespace resolved per target (`HARNESS_BUILTINS`,
  `project.mjs:599`). Override via `config.harness.<sub>` (scalar → all targets, or per-target
  map). Guarded keys (`HARNESS_PATTERNS`, `project.mjs:623`): `agentsDir`, `skillsDir`, and the
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
- Behavioral keys (#478) — a key declares a closed `modes:` list (scalars; `prompt` = ask the
  human) instead of a `pattern:`, optional `flag: { on, off }` invocation tokens, optional
  `lockMode: <mode>` (config may not set anything else; `default:` must equal it), and
  `nonInteractive:` (a mode or `fail`; required iff `prompt` ∈ modes). Precedence: explicit
  token → `waffle.local.yaml` → `waffle.yaml` → `default:`. Membership is judged on rendered
  text; enforced at the same points as `pattern:` (`modeProblems`, `template.mjs`). The four
  `autopilot.*` consents ship `lockMode: false`. Schema: `schema/FORMAT.md` § Behavioral keys.
- Project command values — `project.{lint,typecheck,test,build}Cmd` (13 declarations, one
  byte-identical `pattern:`, `stacks/code-quality/stack.yaml:66`; `project.installCmd` and
  `sec.auditCmd` sit outside it by design) render into a `Bash(<cmd>:*)` grant, so each must be ONE
  program: no `;` `|` `&` `,` `(` `)` `'`, no `$(…)`/backtick/`${{ }}`, no `cd ` prefix, no CR/LF,
  no leading/trailing whitespace, non-empty (`"` and `:` allowed). A project with no such check
  sets the shell no-op `true`; `true` must never ship as a `default:` (it passes vacuously).
- Extensions — `.waffle/extensions/{agents,skills}/<name>.md` appended to the rendered item
  inside `<!-- BEGIN/END project extension -->` markers (`appendExtension`, `render.mjs:580`).
  Agents: appended to body; skills: to `SKILL.md` only.
- Output conflict — two enabled sources emitting the same path is a hard render error
  (`emit`, `render.mjs:291`). Unmanaged-file overwrite guard — a rendered path already on disk
  but not lock-tracked refuses the render pre-write (`render.mjs:181`); byte-identical is
  adopted silently; `--force` overwrites.

| `harness.*` key | claude | codex | agents-dir |
|-----------------|--------|-------|------------|
| `harness.assistantName` | Claude | Codex | Codex |
| `harness.attributionPath` | claude-code | Codex | Codex |
| `harness.skillsDir` | .claude/skills | .agents/skills | .agents/skills |
| `harness.agentsDir` | .claude/agents | .agents/agents | .agents/agents |

Target-independent (#131): `harness.actionRef` = `anthropics/claude-code-action`,
`harness.actionVersion` = pinned SHA + preserved `# vX.Y.Z` comment,
`harness.apiKeySecret` = `ANTHROPIC_API_KEY` (`project.mjs:599`).

Render targets (`VALID_TARGETS`, `project.mjs:61`) — every target renders both kinds (#94):

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
| `.waffle/waffle.yaml` | committed | version, `targets`, `stacks`, `include`, `config`, `eject`, `skills.modelInvocation` (#476: `{ disabled: [..], enabled: [..] }` of skill names; shape-validated on load, throws like invalid `targets:`) (`loadProjectConfig`, `project.mjs:412`); `install`/`eject`/`upgrade`/`toggle` edit it comment-preservingly |
| `.waffle/waffle.local.yaml` | gitignored | deep-merged over committed config, wins on conflict. Private, never canonical (#317): shapes only this machine's bytes, excluded from the committed lock |
| `.waffle/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.waffle/waffle.lock.json` | generated (committed) | rendered file → sha256 map + toolkitVersion + optional `toolkit` (#374) and `sources` (#125) provenance blocks. Hashes the CANONICAL render (committed inputs only, #317) — byte-identical on every machine; `doctor --verify-render` reproduces it |
| `.waffle/waffle.local.lock.json` | gitignored | the render this machine actually wrote; written only when the overlay changes an output byte. `readTreeLock` prefers it |
| `.waffle/{CHEATSHEET,TEAM}.md` + `{cheatsheet,team}.html` | generated (committed by consumers) | overview of the installed selection; emitted via `emit()` so lock-tracked, doctor-checked, pruned |
| `.waffle/AVATARS.md` + `.waffle/avatars/<agent>.svg` | generated (committed by consumers) | deterministic per-agent avatar SVGs + Gravatar-registration manifest with derived commit emails (#157). Same `emit()` lifecycle |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml` (`package.json:31`).

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 1469 tests, 203 suites (2 skipped: the #445 per-target check for `codex` / `agents-dir`, whose rosters are null)) |
| validate | `npm run validate` = `node installer/cli.mjs validate` |
| typecheck | `npm run typecheck` = `tsc -p tsconfig.json` |
| build | `npm run build` = `npm pack --dry-run && node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` |
| render (dogfood) | `node installer/cli.mjs render --allow-unreleased` — flag REQUIRED (#373: a working tree is never at a release tag). Commit the updated render + lock (the doctor drift gate is a required check) |
| verify render | `node installer/cli.mjs doctor` (tree vs lock — not gated) / `node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` (committed inputs reproduce the committed lock — the CI gate, `tests.yml:36`, which gets the env twin from the job `env:` at `tests.yml:21` instead of the flag) |
| evals (metered, #109) | `npm run evals -- --max-calls N` (live, needs `ANTHROPIC_API_KEY`) / `npm run evals -- --dry-run` (mock, free). 18 cases: `code-quality` (2) + `github-workflow` (11) + `orchestration` (3) + `wafflestack` (2). NOT in `npm test` |

Test files (19): `installer.test.mjs` (render pipeline; sets `WAFFLESTACK_ALLOW_UNRELEASED=1` at
module scope — it spawns the real CLI from an untagged checkout), `content.test.mjs` (eval layer
1, #108: key-phrase assertions pinning load-bearing guardrails in the committed render AND every
`stacks/**` source, #360; includes the #172 clean-up delegate-checkpoint sweep guard with its
can-fail fixture, `content.test.mjs:2884`; and the #445 harness tool allowlist sweep — sources, committed render, temp all-targets render, agent `tools:` frontmatter — with its own can-fail fixtures), `plugins.test.mjs` (#199: `recommendedPlugins:`
normalize/offer/lint over a one-stack fixture),
`evals.test.mjs` (eval layer 2 harness with the mock model, free inside `npm test`),
`checkpoint.test.mjs` / `memory.test.mjs` / `identity.test.mjs` (the delegate skill's shipped
validator/preflight scripts), `telemetry.test.mjs` (#227: rendered token-spend jq/bash programs
against fixtures), `avatars-sync.test.mjs` (#285: injected HTTP + rasterizer),
`typecheck-gate.test.mjs` (#177), `provenance.test.mjs` (#373/#374/#372: identity, release gate,
lock toolkit block, pin reconcile — hermetic, strips the env var per spawn),
`preflight-ci-parity.test.mjs` (#375: the four `project.*Cmd` config slots mirror `tests.yml`'s
required `test` job), `registry.test.mjs` (#335: waffle registry gating/rename reconciliation),
`comment-gate.test.mjs` (#388 doctrine enforced mechanically over git-TRACKED `installer/**` and
`stacks/**` `.mjs` plus workflow YAML: comment-ratio ceiling 15% — 20% for `stacks/**/*.mjs`, ≤12
comment lines exempts a small file — plus an 8-line max comment run, typed JSDoc excluded; the
`GRANDFATHERED` ratchet map is EMPTY as of the sweep, so every in-scope file meets the ceilings),
`migrations.test.mjs` (#501: the 0.16.0 overlap migration, overlay never edited, upgrade end-to-end,
and the release guard — a bump cannot skip a pending migration), `config-modes.test.mjs` (#478:
behavioral-key validate rules, render + doctor guards, locked autopilot consents),
`report.test.mjs` (#473: bundle redaction, CLI surface, scrub/projection helpers),
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
`files/.github/workflows/waffle-hygiene.yml` (`waffle.yaml:22-29`). Paid Claude-dispatch hooks: hygiene is
ARMED — PR #495 re-added its `include:` line, PR #496 dropped its `eject:` entry and re-rendered, so
`.github/workflows/waffle-hygiene.yml` is lock-managed (`waffle.lock.json:82`) and tracked in git (cron
`0 13 * * *` + `workflow_dispatch`, reads `secrets.ANTHROPIC_API_KEY`; `waffle-hygiene.yml:9-10,37`).
pr-green and pr-response stay DISARMED: `eject:` holds both `files/` refs (`waffle.yaml:280-282`; #414),
neither is in `include:`, the lock tracks neither rendered path, and neither file exists under
`.github/workflows/`. Re-arm one (#343): `install <files/ref>` — un-ejects it, adds the `include:` entry and renders (`eject.mjs:151-155`, `cli.mjs:76-77`; a differing project-owned copy refuses and rolls back without `--force`) — then commit.

The render (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json`) and the lock are
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

## Owner-voiced docs — do not rewrite

`README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are owner-voiced canonical documents
(the schema files ship to consumers via npx). Do not rewrite them in a docs pass — flag any
drift instead.
