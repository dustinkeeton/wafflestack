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
  stack.yaml               manifest: recommended, agents, skills, files, optIn, requires, prerequisites, config, env, setup
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
docs/                      design notes (gitignore.md, skills-vs-workflows.md)
assets/                    brand assets + brand guide (assets/README.md)
```

## Stack registry

`toolkit.yaml` lists 9 stacks (14 agents + 37 skills). Per-stack config schema, env,
prerequisites, requires edges, and setup notes live in each `stack.yaml` (authoritative —
this table summarizes).

| Stack | Path | Agents | Skills | Purpose |
|--------|------|--------|--------|---------|
| `docs-system` | `stacks/docs-system/` | docs-agent, docs-human | docs-agent, docs-human, prose, md-maximalist, accurate | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. Writing-craft skills (#224): `prose` + `md-maximalist` granted to docs-human, `accurate` to docs-agent — split is orthogonal by audience (#299): `accurate` is deliberately NOT granted to docs-human. All three user-invocable (`/prose`, `/md-maximalist`, `/accurate`). One `requires:` edge: `skills/prose` → `skills/md-maximalist`. |
| `github-workflow` | `stacks/github-workflow/` | (none) | git-workflow, issue, github-project-management, github-project-board, clean-up, label-hook, hygiene, release, pr-response | Git / GitHub issue / Projects v2 / release workflow. Ships 14 `files/` payloads: `waffle-doctor.yml` (default render, read-only drift gate); 7 opt-in syrup workflows (`waffle-label-hook`, `waffle-hygiene`, `waffle-release-hook`, `waffle-post-merge-hook`, `waffle-evals`, `waffle-pr-green-hook`, `waffle-pr-response-hook` — each holds write permissions and/or spends API money, so enabling the stack never renders them); and 6 default-render inert templates (#337: `.github/ISSUE_TEMPLATE/{config,bug,feature,rough-idea}.yml`, `PULL_REQUEST_TEMPLATE.md`, `REVIEW_TEMPLATE.md` — a template must never auto-apply `labelHook.*` labels, pinned by `content.test.mjs`). 5 of the 7 opt-in workflows carry a `files/`-keyed `requires:` edge to a companion skill (label-hook→label-hook, hygiene→hygiene, release-hook→release, post-merge-hook→clean-up, pr-response-hook→pr-response; `stack.yaml:67`); `waffle-pr-green-hook.yml` and `waffle-evals.yml` have NO edge, so the #74 companion warning never fires for them. `pr-response` posts one append-only `<!-- waffle-pr-response -->` comment per round (#318); rubric v3 (Implement ≥11, #390). pr-green dedupes per green head via the `waffle/adversarial-review` commit status; pr-response-hook bounds its loop with `prResponse.responseLabel` applied BEFORE the paid dispatch (#338: no hook predicate reads a body). Config: `issue.*`, `labelHook.*`, `hygiene.{cron,claudeArgs}`, `release.{tagFormat,versionFiles}`, `prGreen.*`, `prResponse.*`, `evals.{cron,maxCalls,model}`, `autoMerge.label`, `doctor.{toolkitRef,flags}` — pin `doctor.toolkitRef` to a release tag BEFORE arming `--verify-render` in `doctor.flags` (#322). Only stack with a `setup:` block. |
| `code-quality` | `stacks/code-quality/` | (none) | tdd, codebase-architecture, adversarial-review, qa, dry | Cross-cutting practice skills (#117; test command, tiers, module map are config). `adversarial-review` (#112): config-free hostile post-green PR review, auto-triggered by the pr-green hook (#180). `qa` (#228): functional sibling — checks a green PR against the linked issue's intent, own `<!-- waffle-qa -->` marker, report-only, composed by autopilot's `autopilot.qaLoop`. `dry` (#116): de-duplication under rule-of-three guardrails. |
| `obsidian-dev` | `stacks/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development + desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `stacks/orchestration/` | project-manager, product-manager, task-planner | delegate, autopilot, audit, docs, standup | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config. `delegate` ships three dependency-free supporting files: `checkpoint.mjs` + `checkpoint.schema.json` (#105/#106, per-phase run checkpoint validator) and `memory.mjs` (#107, byte-capped curated run-memory gate). Config: `delegate.{defaultScope,extraPreflight,checkpointDir,approveBeforePush,autoMerge,batchMode,memoryFile,memoryMaxBytes}` (`checkpointDir`/`memoryFile` defaults exercise depth-4 nested expansion), `autopilot.{autoMerge,planDir,qaLoop,maxQaRounds,reviewLoop,maxReviewRounds,auditStep,holdLabel}`. `autopilot` (#100/#143) composes delegate (batchMode + per-run autoMerge consent, never sticky) into a per-issue plan→implement→PR loop with three opt-in gates in fixed order: QA (#228), review loop (#220), diff-scoped `/audit` (#221); can't-converge files an `autopilot.holdLabel` follow-up. `requires:` edges: delegate→git-workflow+github-project-management+github-project-board, docs→docs-agent+docs-human, autopilot→delegate+clean-up+git-workflow+github-project-management+qa+adversarial-review+pr-response+audit+issue. Guardrails: never push main, never `--admin`-merge, merge commits not squash. |
| `engineering-team` | `stacks/engineering-team/` | lead-engineer, data-engineer, qa-engineer, devops-engineer, ux-designer, security-engineer | webapp-security-audit | Product-eng roster (browser-app security variant); lead-engineer is the general architect. Slots into `orchestration`'s roster. |
| `expo-dev` | `stacks/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development; mobile-architect is the domain architect. |
| `harness-architect` | `stacks/harness-architect/` | harness-architect | (none) | Single domain agent — expert in agent harness design. One optional config key (`project.longName`). This repo appends a project extension grounding it in the toolkit's own paradigms. |
| `wafflestack` | `stacks/wafflestack/` | (none) | waffle-init, waffle-setup, waffle-install, waffle-render, waffle-upgrade, waffle-doctor, waffle-eject, waffle-validate | Self-referential stack (#70): one user-invocable `/waffle-*` skill per CLI subcommand, each shelling out to `npx <waffle.toolkitRef> <sub>`. One optional config key (`waffle.toolkitRef`, default `github:dustinkeeton/wafflestack`). Enabled in this repo's own render. |

Architect seniority rule (#38): `lead-engineer` is the general architect; `plugin-architect`
and `mobile-architect` take seniority in their domains. The output-conflict guard
(`render.mjs:308`) errors if two enabled stacks emit the same path.

## Installer module registry

`installer/lib/*.mjs`, ES modules.

| Module | Purpose |
|--------|---------|
| `render.mjs` | Render pipeline: sources → selection → outputs → prune → lock. Dual render on overlay (#317) |
| `refs.mjs` | Ref grammar, resolution, dependency closure, render selection, target-scope gate (#364) |
| `template.mjs` | `{{placeholder}}` substitution + `pattern:`/`entryPatterns:` guard machinery |
| `toolkit.mjs` | Load `toolkit.yaml` + stack manifests; hard LOAD errors for `targets:` malformations (#364) |
| `project.mjs` | Consuming-project config + overlay, targets, `harness.*` built-ins/guards, `.gitignore` + YAML splice helpers |
| `util.mjs` | sha256, YAML, deep-merge, dotted lookup, frontmatter, fs, semver |
| `doctor.mjs` | Drift check vs `readTreeLock`; `--verify-render` temp-dir reproduction (#314); prerequisite checks (#129) |
| `eject.mjs` | `eject` / `installRefs` / `init` |
| `validate.mjs` | Toolkit-developer lint (consumers never run it over built-ins; render imports only `validateExternalStacks`) |
| `setup.mjs` | `setup` output: SETUP.md playbook + inventory (+ update-mode section) |
| `migrations.mjs` | Ordered, idempotent, version-keyed migration steps |
| `upgrade.mjs` | Version diff, changelog delta, migrations, pin reconcile (#372), render + doctor |
| `uninstall.mjs` | `uninstall` / `reinstall` + the pure `planUninstall` they share (#182) |
| `waffledocs.mjs` | Generated `.waffle/` overview docs + avatars, via render's `emit()` |
| `avatars-sync.mjs` | Owner-side Gravatar pipeline behind `avatars sync`/`status` (#285) |
| `evals.mjs` | Layer 2 eval harness (#109; runner entry `installer/evals.mjs`) |
| `list.mjs` | `list` command: per-item state model + table + interactive picker (#119) |
| `prerequisites.mjs` | Typed external prerequisites: normalize, scope, probe, bucket (#47/#129) |
| `sources.mjs` | External `source:` resolution: local path or pinned-git cache (#88/#125) |
| `toolkit-ref.mjs` | Toolkit self-identification (#373), lock `toolkit` block (#374), write-side pin (#372) |

Exports with signatures:

```js
// render.mjs — render pipeline: resolve sources, validate external stacks pre-write (#126), compute
// selection, regenerate outputs, prune stale managed files, write lock (+ sources/toolkit provenance,
// #125/#374). Renders twice when a local overlay exists (#317): effective render → disk, canonical
// render (committed inputs only) → committed lock; divergent hashes → gitignored local lock.
export function renderProject({ toolkitRoot, cwd, sourceBaseDir = cwd, toolkitVersion, toolkitIdentity = null, force = false, log, sourceCacheDir, refreshSources = false }) // → { ok, errors, warnings, written, removed, sources, toolkit, identity } (force overrides the unmanaged-file overwrite guard; absent toolkitIdentity ⇒ lock's toolkit block omitted)
export function readLock(cwd)                  // → committed lock | null — the CANONICAL render (committed inputs only, #317)
export function readLocalLock(cwd)             // → gitignored .waffle/waffle.local.lock.json | null — this machine's EFFECTIVE render
export function readTreeLock(cwd)              // → readLocalLock(cwd) ?? readLock(cwd) — manifest of the files ON DISK (doctor drift, list status, render prune/clobber; --verify-render deliberately does NOT read it)
export function configGuardProblems({ toolkit, project, selection }) // → string[] — the guard failures a render WOULD produce, without rendering (#218; runs the real substitute() per used guarded key, so bare doctor enforces pattern:/entryPatterns:)
export function collectUsedKeys(items)         // → Set<string> placeholder keys referenced by a selection's source content

// refs.mjs — ref grammar, resolution, dependency closure, selection (imports only VALID_TARGETS from project.mjs)
export function itemOutputMatcher(kind, name)  // → (rel) => boolean — item → lock-path predicate (eject + list; stack-BLIND, matches by path)
export function normalizeItemRef(ref)          // → "agents/NAME" | "skills/NAME"
export function itemsOfKind(stack, kind)       // → stack.agents | stack.skills
export function findItems(toolkit, kind, name) // → [{ stackName, item }] across the toolkit
export function parseRef(raw)                  // → { form: 'qualified'|'item'|'stack', … }
export function resolveRef(toolkit, raw)       // → { type:'stack',name } | { type:'item',kind,name,stack,item,canonicalRef }; throws
export function resolveDepStrict(toolkit, refString, preferStack) // → { kind,name,stack,item }; throws (authored requires: dep)
export function resolveAgentSkill(toolkit, name, preferStack)     // → { kind:'skills',name,stack,item } | null (lenient grant-pointer)
export function closureFor(toolkit, root)      // → [{ kind,name,stack,item }] BFS closure, root first, deduped
export function closureDeps(toolkit, root)     // → ["kind/name"…] non-root deps
export function includeRefMatches(includeRef, kind, name) // → boolean
export function fileMatchesTargets(item, targets) // → boolean (#364: no targets: ⇒ renders unconditionally; scoped ⇒ ≥1 declared target enabled; non-files items always match)
export function computeSelection(toolkit, project, trackedFiles = new Set()) // → { items, closures, errors, targets, targetSkipped, targetBrokenRequires } — trackedFiles (prior lock paths) re-admits poured opt-in syrup; targets carried on the result (#364); targetSkipped = include:d files item with every target disabled; targetBrokenRequires = selected item whose requires: edge lands on a scoped-out files item (.optIn = the dep is opt-in in ITS OWN stack). Both always set, both eject-filtered
export function skippedSyrupCompanions(toolkit, selection) // → [{ fileRef, stackName, companions, scopedTo }] (#74: opt-in syrup gated out while its companion skill IS selected; scopedTo non-null ⇒ target scope excludes this project, warning withholds the pour command but is still issued, #364)

// template.mjs — {{placeholder}} substitution (PLACEHOLDER regex template.mjs:7; MAX_SUBSTITUTION_DEPTH = 4, template.mjs:15)
export function substitute(text, resolve, declared, errors, context, guards) // → string; guards = { patterns: Map<key,guard[]>, entryPatterns: Map<key,Map<leaf,guard[]>> } built by render's compileGuards (render.mjs:713)
export function makeGuard(pattern, source, hint = '')   // → { re, pattern, source, hint } compiled guard record
export function entryPatternProblems(guards, key, value) // → string[] — map-valued key vs its declared entryPatterns: leaves; reports all problems, not the first (#246); [] when clean or unguarded
export function formatValue(v)                 // → string (string[] joins ", "; else YAML block)
export function placeholderKeys(text)          // → Set<string>
export function compilePattern(pattern)        // → RegExp (full-match ^(?:…)$)

// toolkit.mjs — load toolkit.yaml + stack manifests
export function loadToolkit(rootDir)           // → { name, description, stacks: Map } — stack gains .files [{name,path,binary,targets}] (targets = string[] | null; every targets: malformation — unknown map key, non-list, empty [], unknown target NAME — is a hard LOAD error, #364, because the prune DELETES a poured copy), .optIn Set<"files/…">, .requires, .prerequisites, .recommended (bool, manifest `recommended: true` → setup wizard pre-selects the stack, advisory only, #201); stale manifest `syrup:` key throws (0.10.0, #59)
export function loadToolkitWithSources({ builtinRoot, externalStacks = [], cwd, cacheDir, gitFetch, gitResolveCommit, refreshSources = false }) // → merged toolkit; external stacks carry .provenance; cross-source name collision throws (#88/#125)
export function missingRequiredKeys(stack, values, lookup, usedKeys = null) // → string[] (usedKeys Set scopes to referenced keys)

// project.mjs — consuming-project config, targets, harness built-ins, .gitignore + YAML write helpers
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, LOCAL_LOCK_FILE, EXTENSIONS_DIR // .waffle/waffle.* paths (project.mjs:34)
export const LEGACY_ROOT_CONFIG_FILE, LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_ROOT_LOCK_FILE // 0.6.0–0.7.x root .waffle.* names
export const LEGACY_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE, LEGACY_LOCK_FILE, LEGACY_EXTENSIONS_DIR // pre-0.6.0 .wafflestack.* names
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir'] // project.mjs:58
export const HARNESS_BUILTINS                  // per-target { assistantName, attributionPath, skillsDir, agentsDir } + target-independent CI-dispatcher scalars { actionRef, actionVersion, apiKeySecret } (#131/#156; project.mjs:563)
export const HARNESS_PATTERNS                  // injection-guard regexes for agentsDir, skillsDir, actionRef, actionVersion, apiKeySecret (reject `${{`, quotes, newlines; project.mjs:587); seeded into render's guards + checked by validate
export function loadProjectConfig(cwd, notes = [], { canonical = false } = {}) // → { targets, stacks, externalStacks, include, values, eject }; merges the .local overlay UNLESS canonical (#317); splits bare vs {name,source,ref} stacks: entries; legacy bundles: read fallback
export function classifyStackSource(source)    // → 'git' | 'path'
export function normalizeStackEntries(raw)     // → { stacks, externalStacks } (#88; unique names, git-needs-ref / path-forbids-ref, unknown-key rejection)
export function renameLegacyStacksKey(doc)     // in-place comment-preserving bundles:→stacks: KEY rename; → true if renamed
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
export function makeResolver(stack, values, target)   // → (key) => value | undefined (harness.* override → built-in fallback; else config value → stack default)

// util.mjs — shared helpers
export function sha256(content)                // → hex string
export function isBinary(buffer)               // → boolean (NUL byte in first 8000)
export function readYaml(file)                 // → parsed YAML
export function exists(file)                   // → boolean
export function writeFileEnsuringDir(file, content) // mkdir -p + write
export function deepMerge(a, b)                // → merged (b wins; arrays/scalars replace)
export function lookupPath(obj, dotted)        // → value | undefined (nested keys only — a flat literal "a.b": key is inert)
export function parseFrontmatter(text)         // → { data, body }
export function stringifyFrontmatter(data, body) // → string
export function parseVersion(v)                // → [major, minor, patch] | null
export function compareVersions(a, b)          // → -1 | 0 | 1 (unparseable sorts low)

// doctor.mjs — drift check against the lock that describes the tree (readTreeLock, #317)
export function doctor({ cwd, toolkitVersion, toolkitIdentity = null, allowMissing = false, verifyRender = false, toolkitRoot = null, sourceCacheDir = defaultSourceCacheDir() }) // → { ok, modified, missing, notes, attribution, allowMissing, nothingPresent, prerequisites, render, configProblems, toolkitProvenance } — unmet `require` prerequisite fails ok; attribution maps external files → source; toolkitProvenance (#374) is a NOTE ONLY, deliberately absent from ok
export function verifyRenderAgainstLock({ cwd, lock, toolkitRoot, toolkitVersion, toolkitIdentity = null, sourceCacheDir }) // → { evaluated, ok, checked, stale, absent, unexpected, errors } — re-renders the COMMITTED inputs (no overlay) into a temp dir and diffs against the canonical lock; the working tree is never touched (#314/#317)

// migrations.mjs
export const MIGRATIONS                        // [{ version, description, run(cwd) }] — 0.6.0 dotfile rename, 0.8.0 config move, 0.10.0 bundles:→stacks:
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) // → steps in (from, to], ascending
export function runMigrations({ cwd, fromVersion, toVersion, migrations, log }) // → steps that ran

// upgrade.mjs — version diff, changelog delta, migrations, pin reconcile (#372), re-render + doctor
export function upgrade({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, migrations, changelog, sourceCacheDir, log }) // → { ok, status, fromVersion, toVersion, identity, changelogDelta, migrationsRun, render, doctor, sourceMoves, toolkitMove, pinMoves, newerRelease, notes } — renders with refreshSources: true; call order: runMigrations → reconcileToolkitRefPins → renderProject (render re-reads waffle.yaml, so one run bakes the new pin into the render); runs on EVERY status incl. current; newerRelease = { tag, command } | null names the pinned command a stale pinned CLI cannot itself run (no re-exec, #373); pinMoves/newerRelease ride the render-failed early return too
export function reconcileToolkitRefPins({ cwd, identity = null, log }) // → pinMoves [{ key, from, to, action: 'bumped'|'unchanged'|'left'|'skipped', reason }] (#372) — rewrites config.doctor.toolkitRef / config.waffle.toolkitRef in the COMMITTED waffle.yaml (never the .local overlay) to toolkitPinFromIdentity(identity), iff the value is already a shorthand release pin; byte-verbatim via setScalarIn, dirty-guarded; null pin (unreleased/unverified/checkout-release) ⇒ nothing written, reason logged; a URL-form pin (#386 F3) is read but never rewritten — reported `left` with the remedy
export function diffSources(oldSources, newSources) // → [{ name, ref, sourceType, from, to, status: 'moved'|'added'|'removed' }] (#125)
export function diffToolkit(prev, next, { fromVersion, toVersion }) // → { from, to, fromRef, toRef, fromVersion, toVersion, fromStatus, toStatus, status: 'moved'|'unchanged'|'added'|'removed'|'unknown' } | null (#374; 'moved' at the SAME version = a re-cut tag; 'unknown' = one side recorded no commit)
export function changelogBetween(text, fromVersion, toVersion) // → markdown of `## [X.Y.Z]` sections in (from, to], newest first | null

// uninstall.mjs — the only destructive command (#182); the lock is the sole authority for what is ours
export function planUninstall({ cwd, toolkitRoot = null, force = false, keepConfig = false, keepLock = false, keepLockOnSkip = true }) // → { lock: 'canonical'|'local'|null, lockFile, remove, drifted, absent, refused, meta, prunedDirs, gitignore, ejected, lockRetained, notes } — pure, touches no disk; classifies each tracked path remove (sha256 matches) / drifted (hand-edited, skipped unless force) / absent / refused (resolves outside cwd — resolveInside rejects lexical ../ escapes AND realpaths the deepest existing ancestor against symlink escapes; any refusal aborts the whole run)
export function uninstall({ cwd, toolkitRoot, force = false, allowMissing = false, keepConfig = false, keepLock = false, keepLockOnSkip = true, dryRun = true, log }) // → { ok, dryRun, plan, removed, skipped, errors } — dryRun DEFAULTS TRUE at the library boundary; ok = no errors (a skipped-only run is ok:true); the returned plan's lockRetained is the OUTCOME, reconciled after execution
export function reinstall({ toolkitRoot, cwd, toolkitVersion, toolkitIdentity = null, clean = false, force = false, log }) // → { ok, uninstall, render, initialized, restored, errors } — refresh: snapshot doomed bytes → uninstall(keepConfig+keepLock, force:true) → renderProject, snapshot restored if either leg fails; clean: uninstall-everything(keepLockOnSkip:false) → init, no render

// eject.mjs
export function eject({ cwd, item })           // → { ref, released } (drops the item's files from the lock, strips a matching include: entry; files stay in place, project-owned)
export function installRefs({ toolkitRoot, cwd, refs, log }) // → { added, closures } (persist refs to config; caller renders after)
export function init({ cwd })                  // → configFile path (starter .waffle/waffle.yaml)

// validate.mjs — toolkit-developer lint (render imports only validateExternalStacks; targets: is NOT
// linted here — all four malformations are hard LOAD errors in toolkit.mjs, a gate a fork cannot skip)
export const RESERVED_AGENT_KEYS = ['name', 'description', 'skills', 'identity'] // validate.mjs:74
export function validateToolkit(rootDir)       // → string[] problems ([] = clean): manifests, frontmatter, placeholder↔declaration sync, requires: integrity, pattern:/entryPatterns: compilability + default-match, prerequisites fields, harness built-ins
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
export function renderTargetPrompt(toolkitRoot, { stack, target, config = {} }) // → rendered target body via renderProject into a temp project (becomes the system prompt)
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

// prerequisites.mjs — typed external prerequisites (#47/#129)
export const PREREQ_KINDS = ['tool','secret','scope','label','setting','service','env'], PREREQ_LEVELS = ['require','recommend']
export const RENDER_PROBE_KINDS                // Set{'tool','env'} — the cheap kinds render probes (doctor probes all)
export function normalizePrerequisites(raw)    // → [{ kind, name, description, check, level, items }] (tolerant; linted by validate)
export function runCheck(check, cwd, { timeoutMs = 15000 } = {}) // → { ran, ok } (shell check, exit 0 = ok, stdio ignored)
export function applicablePrerequisites(toolkit, selection) // → flat [{ …prereq, stackName }] scoped to the selection
export function evaluatePrerequisites(prereqs, cwd, { kinds = null, timeoutMs } = {}) // → { unmetRequired, unmetRecommended, met }
export function formatPrereq(p)                // → one actionable CLI line

// sources.mjs — external source: resolution (#88/#125)
export function resolveSource(ext, { cwd, cacheDir, gitFetch, gitResolveCommit, refresh = false } = {}) // → { root, commit } (local path in place, or git fetched at the pinned ref into a content-addressed cache; rejects leading-`-` source/ref)
export function resolveSourceRoot(ext, opts)   // → root path only (back-compat wrapper)
export function gitFetchCheckout(source, ref, dest) // default git clone + checkout (injectable)
export function gitHeadCommit(dir)             // → resolved HEAD SHA (injectable)
export function defaultSourceCacheDir()        // → os.tmpdir()/wafflestack-sources

// toolkit-ref.mjs — toolkit self-identification (#373) + the lock's toolkit block (#374) + the write-side pin (#372).
// INVARIANT: ref/commit are recorded IFF status === 'release'; identity failure fails OPEN (unverified → warn + proceed);
// an unverified render carries the previous toolkit block forward when version + files map are unchanged.
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
cli.mjs      → render, doctor, eject, validate, setup, upgrade, uninstall, toolkit,
               prerequisites, list, toolkit-ref, project, avatars-sync (dynamic)
render.mjs   → template, toolkit-ref, toolkit, sources, refs, validate, prerequisites, waffledocs, project, util
doctor.mjs   → render, project, toolkit-ref, toolkit, refs, prerequisites, sources, util
upgrade.mjs  → render, doctor, migrations, project, toolkit-ref, util
uninstall.mjs → render, eject, toolkit, project, util
eject.mjs    → render, toolkit, refs, project, util
validate.mjs → toolkit, template, refs, prerequisites, project, util
setup.mjs    → toolkit, render, project, refs, prerequisites, util
list.mjs     → toolkit, render, refs, project, util
waffledocs.mjs → template, project, refs, util
avatars-sync.mjs → toolkit, project, refs, waffledocs
evals.mjs    → render, template, util
migrations.mjs → project, util
toolkit.mjs  → refs, sources, prerequisites, project (VALID_TARGETS only), util
prerequisites.mjs → refs
refs.mjs     → project (VALID_TARGETS only; project.mjs imports no sibling but util.mjs — no cycle)
sources.mjs  → util
toolkit-ref.mjs → util
project.mjs  → util
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Usage:
`wafflestack <init|setup|list|install|render|bake|upgrade|doctor|eject|uninstall|reinstall|avatars|validate|help> [refs…] [--cwd DIR]`
(`USAGE`, `cli.mjs:53`).

Dispatch and exit contract: `help`/`--help`/`-h` print the full help to stdout, exit 0 —
intercepted before the switch (`cli.mjs:61`), so `uninstall --help` explains rather than deletes;
there is no per-command help page (#187, `helpText` `cli.mjs:375`). An unknown command, and bare
`wafflestack`, print banner + usage to stderr, exit 1. Flags are spliced out by name
(`extractFlag` `cli.mjs:459`, `extractCwd` `cli.mjs:450`), so an unrecognized flag survives as a
positional: `render`/`bake`/`upgrade`/`list`/`uninstall`/`reinstall` reject it (takes-no-refs
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
| `--no-color` | `list` | suppress ANSI; the `NO_COLOR` env var does the same (`cli.mjs:264`); neither is listed in `help`'s flag block (#359) |
| `--allow-unreleased` | every command (spliced globally) | #373: suppress the release gate's refusal (toolkit development only); env twin `WAFFLESTACK_ALLOW_UNRELEASED=1`. Suppresses the refusal, not the truth — identity still resolves, network lookup included, so a genuine release keeps its `ref` under the hatch (#383) |
| `--offline` | every command (spliced globally) | #383: skip the network release lookup (`git ls-remote`); env twin `WAFFLESTACK_OFFLINE=1`. Fails open (identity degrades to `unverified`, `ref: null`); the ONLY switch that skips the lookup — orthogonal to `--allow-unreleased` ("don't refuse me" vs. "don't pay for the answer") |

Release gate (#373; truth in `toolkit-ref.mjs`, gate in `cli.mjs`). Before writing files from
toolkit content, the CLI resolves its own identity and refuses (exit 1, naming the exact pinned
command) when provably not a release. Gated: `render`/`bake`, `install`, `upgrade`, `reinstall`,
`doctor --verify-render`, `list --interactive` (once a selection is applied). Not gated: plain
`doctor` (pure hash-vs-lock; gets the offline identity), `list`/`setup` (read-only ⇒
`formatProvenanceWarning` to stderr), `init`, `eject`, `uninstall`, `validate`, `avatars`, `help`.
`unverified` (offline / no git / unreadable npm lockfile) proceeds with a warning — fail open on
ignorance, fail closed only on a successful "not a release" lookup. The identity is threaded to
`renderProject`/`upgrade`/`reinstall` and written into the lock's `toolkit` block (#374).

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.waffle/waffle.yaml`; errors if one exists at any generation. `--gitignore` appends the two pre-stack-knowable entries (local overlay + local lock). `eject.mjs:200` |
| `setup` | Print `schema/SETUP.md` playbook + toolkit inventory; already-configured cwd adds a live update-mode section. `setup.mjs:25` |
| `list` | Per-stack per-item state table (`current`/`outdated`/`not-installed`/`not-installable`/`PENDING REMOVAL`); plain aligned table by default (ANSI only on a TTY); `--interactive` multi-select installs + renders. Takes no refs. `list.mjs`, `cli.mjs:238` |
| `install [ref…]` | Persist each ref to config (stack → `stacks:`, item → canonical `include:`), then render. Bare `install` = `render`. `eject.mjs:98` |
| `render` | Regenerate all managed files verbatim, prune stale managed files, write lock. Rejects positional refs. Refuses to overwrite a pre-existing untracked file unless `--force` (`render.mjs:199`). `render.mjs:43` |
| `bake` | Pure alias for `render` — a fall-through case sharing its body and guards (#176). |
| `upgrade` | Lock-vs-CLI version diff, CHANGELOG delta, migrations in `(from, to]`, pin reconcile (#372), render (`refreshSources: true`, reporting source + built-in toolkit commit moves, #374) + doctor. Missing lock degrades to render + doctor. Exit follows doctor. `upgrade.mjs:61` |
| `doctor` | Diff managed files vs `readTreeLock`; report `toolkitVersion` + skew note + `toolkit` provenance note (#374, warning only); run selected stacks' `prerequisites:` checks. Exit 1 on drift OR unmet `require` prerequisite. `--allow-missing`: only modified files count. `doctor.mjs:47` |
| `eject <kind/NAME>` | Add to `eject:`, strip matching `include:`, drop the item's files from the lock; files stay in place, project-owned. `eject.mjs:25` |
| `uninstall` | Remove the whole install, driven entirely off the lock: `remove` only when the sha256 still matches the render; `drifted` skipped unless `--force`; refuses the whole run on an absent lock or a path resolving outside `cwd` (incl. symlink escapes). Also removes `.waffle/` meta (unless `--keep-config`), prunes genuinely-emptied dirs, strips wafflestack's `.gitignore` lines. Dry run until `--yes`. Skips exit 0; errors exit 1 (#359). Read `lockRetained` off the result, not the plan. `uninstall.mjs` (#182) |
| `reinstall` | Refresh in place: snapshot → uninstall(keepConfig+keepLock, force) → re-render, rollback on failure; keeping the lock is load-bearing (the `trackedFiles` re-admission keeps poured opt-in syrup selected). `--clean` = wipe to empty + `init` (requires `--yes`, no render). Both shapes need a lock (#359). `uninstall.mjs` (#182) |
| `avatars <sync\|status>` | Owner-side Gravatar pipeline (#285): `sync` rasters + uploads/assigns each verified agent email's avatar; `status` reports drift only. Token from `WAFFLE_GRAVATAR_TOKEN`; unverified addresses are a manual remainder. `status` exits 1 on drift; any `failed` exits 1. `avatars-sync.mjs`, `cli.mjs:268` |
| `validate` | Toolkit-developer lint (see `validate.mjs` above). Exit 1 on problems. `validate.mjs:77` |
| `help` | Banner + usage + one line per command/flag to stdout, exit 0. `helpText` `cli.mjs:375` (#187) |

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, `requires:`) names something installable.
Grammar + resolution in `refs.mjs` (`parseRef` `refs.mjs:148`, `resolveRef` `refs.mjs:184`).
Kinds: `agents`, `skills`, `files` (a payload byte/text-copied to its repo-relative path).

| Form | Example | Meaning |
|------|---------|---------|
| stack | `github-workflow` | a whole stack |
| item | `skills/issue`, `files/.github/workflows/waffle-hygiene.yml` | unqualified; must be unique toolkit-wide |
| qualified | `engineering-team/skills/webapp-security-audit` | disambiguates cross-stack collisions |

`canonicalRef` is the minimal re-resolvable form — what `install` writes to `include:`.

Render selection (`computeSelection`, `refs.mjs:407`):

```
rendered = union(items of enabled stacks:) ∪ closure(each include: item) − eject:
```

- Opt-in syrup gate — a stack's `optIn:` `files/` items are excluded from default expansion
  unless already lock-tracked (`trackedFiles`) or explicitly `include:`-ed (`refs.mjs:443`):
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
  Invariants: an unscoped file can never be pruned; an ejected file is never pruned or warned
  about. Known gap (#371): a poured file whose STACK was deselected is pruned while `list`
  says `not-installed` — a hidden deletion, predates #364.
- Dependency closure — installing an item pulls transitive cross-stack deps (BFS, deduped).
  Direct deps = agent frontmatter `skills:` (lenient) + stack `requires:` (strict). Recomputed
  every render, never persisted.
- Grouping — config/env checks run per stack over selected items only; required-config is
  scoped to placeholder keys the selected items reference (`missingRequiredKeys` `usedKeys`).
- `eject:` wins over both `stacks:` and `include:`; `eject` self-cleans a matching `include:`.

## External stack sources

A `stacks:` entry is either a bare built-in name or `{ name, source, ref }` naming a third-party
source (#88). Parsed by `normalizeStackEntries` (`project.mjs`), resolved at render by
`loadToolkitWithSources` → `resolveSource` (`sources.mjs`). Guide: `schema/AUTHORING-EXTERNAL-STACKS.md`.

| Field | Rule |
|-------|------|
| `name` | required; unique across ALL `stacks:` entries; collision = hard error naming both sources |
| `source` | required; git URL (`https://`, `ssh://`, `git@host:o/r`, `*.git`) or local path (`classifyStackSource`) |
| `ref` | git source: REQUIRED; local path: MUST be omitted |

Git sources fetch at the pinned `ref` into a content-addressed cache (reused unless refresh);
a leading-`-` source/ref is rejected (argument-injection guard). External files get lock
`sources` provenance (`{ name, source, sourceType, ref, commit, files }`); `doctor` attributes
drift per source, `upgrade` reports commit moves. `render` lints every external stack pre-write
(#126) and warns extra when external opt-in syrup is poured.

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
`RENDER_PROBE_KINDS` (`tool`/`env`) as non-blocking warnings. The legacy `env:` map is subsumed
as the `env` kind, read-compatibly.

## Template semantics

- Placeholders `{{dotted.key}}` (regex at `template.mjs:7`) substitute only if the key is
  declared in the stack's `config:` or is `harness.*`. Other braces (bash `${...}`, mustache)
  pass through verbatim; `$`-prefixed `${{ }}` (GitHub Actions) is excluded by negative
  lookbehind, so workflow payloads carry those untouched.
- Value formatting (`formatValue`, `template.mjs:245`): strings verbatim; string arrays join
  `, `; other structures render as a YAML block.
- `harness.*` — reserved, always-available namespace resolved per target (`HARNESS_BUILTINS`,
  `project.mjs:563`). Override via `config.harness.<sub>` (scalar → all targets, or per-target
  map). Guarded keys (`HARNESS_PATTERNS`, `project.mjs:587`): `agentsDir`, `skillsDir`, and the
  three target-independent CI-dispatcher scalars `actionRef`/`actionVersion`/`apiKeySecret`
  (#131) spliced into rendered workflow `uses:`/`with:` lines — each rejects `${{`, quotes,
  newlines, so an override can repin the action without ejecting the workflow.
- Nested substitution — substituted values re-expand up to depth 4 (`MAX_SUBSTITUTION_DEPTH`,
  `template.mjs:15`): a committed value can reference a key kept in the local overlay. Canonical
  text surviving the first pass is never re-scanned.
- Value guards — a scalar config key may declare `pattern:` (full-match regex on the resolved
  value, which must be a STRING — a list/map value fails rather than dodging the guard via
  flattening, #341) plus optional `patternHint:` prose printed on rejection (#218). A map-valued
  key declares `entryPatterns:` instead — `<leaf>: <regex>` applied to every entry; unknown
  leaves fail (#156). Guards are unioned toolkit-wide (a key guarded in two stacks must satisfy
  both, #244) and enforced in `substitute` at render and by `configGuardProblems` in bare
  `doctor`; linted by `validate`.
- Extensions — `.waffle/extensions/{agents,skills}/<name>.md` appended to the rendered item
  inside `<!-- BEGIN/END project extension -->` markers (`appendExtension`, `render.mjs:601`).
  Agents: appended to body; skills: to `SKILL.md` only.
- Output conflict — two enabled sources emitting the same path is a hard render error
  (`emit`, `render.mjs:308`). Unmanaged-file overwrite guard — a rendered path already on disk
  but not lock-tracked refuses the render pre-write (`render.mjs:199`); byte-identical is
  adopted silently; `--force` overwrites.

| `harness.*` key | claude | codex | agents-dir |
|-----------------|--------|-------|------------|
| `harness.assistantName` | Claude | Codex | Codex |
| `harness.attributionPath` | claude-code | Codex | Codex |
| `harness.skillsDir` | .claude/skills | .agents/skills | .agents/skills |
| `harness.agentsDir` | .claude/agents | .agents/agents | .agents/agents |

Target-independent (#131): `harness.actionRef` = `anthropics/claude-code-action`,
`harness.actionVersion` = pinned SHA + preserved `# vX.Y.Z` comment,
`harness.apiKeySecret` = `ANTHROPIC_API_KEY` (`project.mjs:563`).

Render targets (`VALID_TARGETS`, `project.mjs:58`) — every target renders both kinds (#94):

| Source | claude | codex | agents-dir |
|--------|--------|-------|------------|
| agent `agents/<n>.md` | `.claude/agents/<n>.md` (frontmatter + `claude:` passthrough; body) | `.codex/agents/<n>.toml` (name, description, developer_instructions=body) | `.agents/agents/<n>.md` (neutral frontmatter, no passthrough; body) |
| skill `skills/<n>/` | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.agents/skills/<n>/` |

codex + agents-dir share `.agents/skills/<n>/` (`renderSkill` dedupes by output dir). Skills
render byte-for-byte except substitution + extension append; non-`.md` supporting files copy
verbatim.

## Consuming-project contract

Everything lives in the one `.waffle/` directory (0.8.0 layout; legacy root `.waffle.*` and
pre-0.6.0 `.wafflestack.*` names still read with a deprecation note, migrated in place):

| File | Tracked | Role |
|------|---------|------|
| `.waffle/waffle.yaml` | committed | version, `targets`, `stacks`, `include`, `config`, `eject` (`loadProjectConfig`, `project.mjs:386`); `install`/`eject`/`upgrade` edit it comment-preservingly |
| `.waffle/waffle.local.yaml` | gitignored | deep-merged over committed config, wins on conflict. Private, never canonical (#317): shapes only this machine's bytes, excluded from the committed lock |
| `.waffle/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.waffle/waffle.lock.json` | generated (committed) | rendered file → sha256 map + toolkitVersion + optional `toolkit` (#374) and `sources` (#125) provenance blocks. Hashes the CANONICAL render (committed inputs only, #317) — byte-identical on every machine; `doctor --verify-render` reproduces it |
| `.waffle/waffle.local.lock.json` | gitignored | the render this machine actually wrote; written only when the overlay changes an output byte. `readTreeLock` prefers it |
| `.waffle/{CHEATSHEET,TEAM}.md` + `{cheatsheet,team}.html` | generated (committed by consumers) | overview of the installed selection; emitted via `emit()` so lock-tracked, doctor-checked, pruned |
| `.waffle/AVATARS.md` + `.waffle/avatars/<agent>.svg` | generated (committed by consumers) | deterministic per-agent avatar SVGs + Gravatar-registration manifest with derived commit emails (#157). Same `emit()` lifecycle |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml` (`package.json:30`).

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 1207 tests, 156 suites) |
| validate | `npm run validate` = `node installer/cli.mjs validate` |
| typecheck | `npm run typecheck` = `tsc -p tsconfig.json` |
| build | `npm run build` = `npm pack --dry-run && node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` |
| render (dogfood) | `node installer/cli.mjs render --allow-unreleased` — flag REQUIRED (#373: a working tree is never at a release tag). Commit the updated render + lock (the doctor drift gate is a required check) |
| verify render | `node installer/cli.mjs doctor` (tree vs lock — not gated) / `node installer/cli.mjs doctor --allow-missing --verify-render --allow-unreleased` (committed inputs reproduce the committed lock — the CI gate, `tests.yml:72`, which gets the env twin from the job `env:` at `tests.yml:36` instead of the flag) |
| evals (metered, #109) | `npm run evals -- --max-calls N` (live, needs `ANTHROPIC_API_KEY`) / `npm run evals -- --dry-run` (mock, free). 15 cases: `code-quality` (2) + `github-workflow` (10) + `orchestration` (3). NOT in `npm test` |

Test files (11): `installer.test.mjs` (render pipeline; sets `WAFFLESTACK_ALLOW_UNRELEASED=1` at
module scope — it spawns the real CLI from an untagged checkout), `content.test.mjs` (eval layer
1, #108: key-phrase assertions pinning load-bearing guardrails in the committed render),
`evals.test.mjs` (eval layer 2 harness with the mock model, free inside `npm test`),
`checkpoint.test.mjs` / `memory.test.mjs` / `identity.test.mjs` (the delegate skill's shipped
validator/preflight scripts), `telemetry.test.mjs` (#227: rendered token-spend jq/bash programs
against fixtures), `avatars-sync.test.mjs` (#285: injected HTTP + rasterizer),
`typecheck-gate.test.mjs` (#177), `provenance.test.mjs` (#373/#374/#372: identity, release gate,
lock toolkit block, pin reconcile — hermetic, strips the env var per spawn),
`preflight-ci-parity.test.mjs` (#375: the four `project.*Cmd` config slots mirror `tests.yml`'s
required `test` job).

## Dogfood state

This repo renders 5 stacks into itself — `github-workflow`, `docs-system`, `orchestration`,
`harness-architect`, `wafflestack` (`targets: [claude]`; `.waffle/waffle.yaml`). `include:` arms
`files/.github/workflows/waffle-release-hook.yml`, `files/.github/workflows/waffle-post-merge-hook.yml`,
`code-quality/skills/adversarial-review` (run by pr-green when armed), and `code-quality/skills/qa`
(autopilot's opt-in QA gate). The paid Claude-dispatch hooks (hygiene, pr-green, pr-response) are
DISARMED while the repo deliberately carries no `ANTHROPIC_API_KEY` secret: #396 (2026-07-15)
removed them from `include:` and from git tracking, and #414 (PR #417, 2026-07-16) finished the
disarm by `eject:`-ing the three `files/` refs via the CLI — the lock no longer tracks their
rendered paths, so `render` produces nothing under `.github/workflows/waffle-{hygiene,pr-green-hook,pr-response-hook}.yml`.
Re-arm (#343): remove the three `eject:` entries, re-install the refs + `include:` lines, re-render
and commit — a funded key must exist first. (Their SOURCES under `stacks/github-workflow/files/`
stay toolkit content, tracked by the lock as sources.)

The render (`.claude/agents/`, `.claude/skills/`, `.claude/settings.json`) and the lock are
COMMITTED, like a consuming project — the doctor drift gate (required check on main) needs render
+ lock in git. Re-render AND commit after editing `stacks/**`. Gitignored deliberate absences,
tolerated by doctor's `--allow-missing`: `.claude/worktrees/`, `.codex/`/`.agents/` (non-targets),
`.github/workflows/waffle-label-hook.yml` (would arm a live label→harness dispatch), and the
generated `.waffle/` overview docs (`CHEATSHEET.md`, `TEAM.md`, both `.html`, `AVATARS.md`,
`avatars/`).

CI render gate (#314/#316): `.github/workflows/tests.yml` (project-owned — NOT lock-managed) runs
`npm test` + `npm run validate` + `npm run typecheck` (`tests.yml:44-46`), then
`WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs doctor --allow-missing --verify-render`
with the checkout's OWN CLI
(`tests.yml:72`) — catching a `stacks/**` edit whose re-render was forgotten. The job supplies
`WAFFLESTACK_ALLOW_UNRELEASED: '1'` at its `env:` block (`tests.yml:36`; `actions/checkout`
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
