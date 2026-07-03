---
last-updated: 2026-07-03
---

# AGENTS.md — wafflestack

Canonical, harness-neutral agent/skill definitions grouped into bundles; the `wafflestack`
CLI renders them into harness-native files (`.claude/`, `.codex/`, `.agents/`) inside a
consuming project. Rendered files are generated output — edit source (`bundles/**`,
`schema/**`, `installer/**`), project config, or a project extension, never the rendered files.

Entry points: `installer/cli.mjs` (bin `wafflestack`) · `toolkit.yaml` (bundle registry) ·
`schema/FORMAT.md` (format reference).

## Repository layout

```
toolkit.yaml               registry: name + ordered bundle list
bundles/<name>/
  bundle.yaml              manifest: agents, skills, requires, config schema, env, setup
  agents/<name>.md         neutral agent def (YAML frontmatter + body)
  skills/<name>/SKILL.md   neutral skill def (+ supporting files, copied along)
installer/cli.mjs          bin entry: dispatches commands, global --cwd flag
installer/lib/*.mjs        render pipeline (ES modules)
installer/test/*.test.mjs  node:test suite
schema/FORMAT.md           format reference (owner-voiced)
schema/SETUP.md            agent install playbook (owner-voiced)
assets/                    brand assets (marks, favicons, social card) + brand guide (assets/README.md)
```

## Bundle registry

`toolkit.yaml` lists 7 bundles (13 agents + 18 skills; reorganized in #38 — `design`
dissolved, roles consolidated, `security-audit` variants renamed). Per-bundle config schema,
env, and setup notes live in each `bundle.yaml` (authoritative — this table summarizes).

| Bundle | Path | Agents | Skills | Purpose |
|--------|------|--------|--------|---------|
| `docs-system` | `bundles/docs-system/` | docs-agent, docs-human | docs-agent, docs-human | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. |
| `github-workflow` | `bundles/github-workflow/` | (none) | git-workflow, issue, github-project-management, clean-up, label-hook | Git / GitHub issue / Projects v2 workflow. Ships two prefab CI workflows as `files/` payloads (`waffle-doctor`; `waffle-label-hook` — the label→harness hook wired to `label-hook` via the toolkit's only `files/`-keyed `requires:`). Only bundle with a `setup:` block (gh auth, labels, board, git identity). |
| `code-quality` | `bundles/code-quality/` | (none) | tdd, codebase-architecture | Cross-cutting, stack-agnostic practice skills (test command, tiers, module map, settings type are config). |
| `obsidian-dev` | `bundles/obsidian-dev/` | plugin-architect | obsidian-plugin-dev, electron-security-audit | Obsidian plugin development (API, manifest, esbuild, testing patterns) + the desktop-app security-audit variant; plugin-architect is the domain architect. |
| `orchestration` | `bundles/orchestration/` | project-manager, product-manager, task-planner | delegate, audit, docs, standup | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config (defaults: `lead-engineer` architect + compliance, `security-engineer` security; override compliance to a domain architect where one exists). Uses `requires:` for its skill deps (delegate→git-workflow+github-project-management, docs→docs-agent+docs-human). `standup` rounds up a per-agent status pulse — dynamic `.claude/agents/*.md` roster, one read-only parallel wave, collect-via-return-values, no side effects. |
| `engineering-team` | `bundles/engineering-team/` | lead-engineer, data-engineer, qa-engineer, devops-engineer, ux-designer, security-engineer | webapp-security-audit | Product-eng roster (browser-app security variant); lead-engineer is the general architect. Slots into `orchestration`'s roster. |
| `expo-dev` | `bundles/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development (@expo/ui, dev loop, EAS); mobile-architect is the domain architect. |

Architect seniority rule (#38): `lead-engineer` is the general architect; `plugin-architect`
and `mobile-architect` take seniority for problems specific to their domains. The former
`security-audit` name collision is resolved by the `electron-`/`webapp-` renames; the
output-conflict guard (`render.mjs:34`) still errors if two enabled bundles ever emit the
same path.

## Installer module registry

`installer/lib/*.mjs`, ES modules. See signatures block below for exports.

| Module | Purpose |
|--------|---------|
| `installer/lib/render.mjs` | Render pipeline: compute selection, regenerate all outputs verbatim, delete stale managed files, write lock. Output-conflict + scoped required-config + env-prereq checks. |
| `installer/lib/refs.mjs` | Ref grammar, toolkit-wide resolution, and transitive cross-bundle dependency closure + render-selection computation. Pure leaf (no local imports). Shared by install / render / validate. |
| `installer/lib/template.mjs` | `{{placeholder}}` substitution: declared-key gate, per-target resolve, depth-capped nested expansion, value formatting, optional per-key `pattern:` value validation. |
| `installer/lib/toolkit.mjs` | Load `toolkit.yaml` + every bundle manifest (agents, skills, `requires`, config, env, setup); scoped required-key check. |
| `installer/lib/project.mjs` | Load consuming-project config (+ local overlay), valid targets, `harness.*` built-ins, per-target resolver; multi-generation legacy-name read fallback + in-place dotfile migration chain (`.wafflestack.*` → `.waffle.*` → `.waffle/waffle.*`). |
| `installer/lib/util.mjs` | Shared helpers: sha256, YAML read, deep-merge, dotted lookup, frontmatter parse/stringify, fs writes, semver parse/compare. |
| `installer/lib/doctor.mjs` | Diff managed files against the lock; always report the rendered `toolkitVersion` + a skew note pointing at `upgrade`. |
| `installer/lib/eject.mjs` | `eject` (release an item, self-cleaning its `include:`), `installRefs` (persist bundle/item refs to config), `init` (starter config). |
| `installer/lib/validate.mjs` | Toolkit-developer lint: manifests, frontmatter, placeholder↔declaration sync, agent-skill + `requires:` ref integrity, config `pattern:` compilability + default-match. |
| `installer/lib/setup.mjs` | `setup` output: `schema/SETUP.md` playbook + inventory generated from the installed toolkit. |
| `installer/lib/migrations.mjs` | Migration registry (`MIGRATIONS`) + runner: ordered, idempotent, version-keyed steps `{ version, description, run(cwd) }`; applies steps in `(fromVersion, toVersion]`. Ships the 0.6.0 `.wafflestack.*`→`.waffle.*` rename and the 0.8.0 root→`.waffle/` config move. |
| `installer/lib/upgrade.mjs` | `upgrade` flow: lock-vs-toolkit version diff, `CHANGELOG.md` delta printout, run migrations, then render + doctor. Also exports the changelog-section parser. |
| `installer/lib/waffledocs.mjs` | Generate the `.waffle/` overview docs from the render selection: `CHEATSHEET.md` (user-invocable skills) + `TEAM.md` (installed agents), each with a branded self-contained SVG. Assembles from item frontmatter (skill `user-invocable`/`argument-hint`/`description`; agent `name`/`description`/`skills`), substituted with render's resolver. Emitted via `render.mjs`'s `emit()`, so lock-tracked + doctor-checked + pruned. |

```js
// render.mjs
export function renderProject({ toolkitRoot, cwd, toolkitVersion, log }) // → { ok, errors, warnings, written, removed }
export function readLock(cwd)                          // → lock object | null

// refs.mjs  (pure leaf — no local imports; ref grammar + resolution + dependency closure)
export function normalizeItemRef(ref)                 // → "agents/NAME" | "skills/NAME"
export function itemsOfKind(bundle, kind)             // → bundle.agents | bundle.skills
export function findItems(toolkit, kind, name)        // → [{ bundleName, item }] across the toolkit
export function parseRef(raw)                          // → { form: 'qualified'|'item'|'bundle', … }
export function resolveRef(toolkit, raw)              // → { type:'bundle',name } | { type:'item',kind,name,bundle,item,canonicalRef }; throws
export function resolveDepStrict(toolkit, refString, preferBundle) // → { kind,name,bundle,item }; throws (authored requires: dep)
export function resolveAgentSkill(toolkit, name, preferBundle)     // → { kind:'skills',name,bundle,item } | null (lenient grant-pointer)
export function closureFor(toolkit, root)            // → [{ kind,name,bundle,item }] BFS closure, root first, deduped
export function closureDeps(toolkit, root)           // → ["kind/name"…] non-root deps
export function includeRefMatches(includeRef, kind, name) // → boolean
export function computeSelection(toolkit, project)  // → { items:[{bundleName,bundle,kind,item}], closures, errors }

// template.mjs   (PLACEHOLDER = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g; MAX_SUBSTITUTION_DEPTH = 4)
export function substitute(text, resolve, declared, errors, context, patterns) // → string (patterns: Map<key,RegExp> render-time value validation)
export function formatValue(v)                         // → string (string[] join ", "; else YAML block)
export function placeholderKeys(text)                  // → Set<string>
export function compilePattern(pattern)                // → RegExp (full-match ^(?:…)$; compiles a config key's pattern:)

// toolkit.mjs
export function loadToolkit(rootDir)                   // → { name, description, bundles: Map<name, bundle> }  (bundle gains .requires)
export function missingRequiredKeys(bundle, values, lookup, usedKeys = null) // → string[]  (usedKeys Set scopes to referenced keys)

// project.mjs
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, EXTENSIONS_DIR   // .waffle/waffle.* consumer paths (one .waffle/ dir owns everything)
export const LEGACY_ROOT_CONFIG_FILE, LEGACY_ROOT_LOCAL_CONFIG_FILE, LEGACY_ROOT_LOCK_FILE // 0.6.0–0.7.x repo-root .waffle.* names
export const LEGACY_CONFIG_FILE, LEGACY_LOCAL_CONFIG_FILE, LEGACY_LOCK_FILE, LEGACY_EXTENSIONS_DIR // pre-0.6.0 .wafflestack.* names
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir']
export const HARNESS_BUILTINS                          // { assistantName, attributionPath, skillsDir } per target
export function loadProjectConfig(cwd, notes = [])     // → { targets, bundles, include, values, eject }; pushes legacy-read deprecation notes
export function resolveConfigFile(cwd)                 // → { file, legacy, note } (prefers .waffle/waffle.yaml, else legacy .waffle.yaml, else .wafflestack.yaml)
export function resolveLocalConfigFile(cwd)            // → { file, legacy, note }
export function resolveLockFile(cwd)                   // → { file, legacy, note }
export function migrateLegacyDotfiles(cwd)             // chain .wafflestack.* → .waffle.* → .waffle/waffle.* in place; → [{ from, to }] (idempotent)
export function staleGitignoreEntries(cwd)             // → stale root .waffle.* / legacy .wafflestack.* lines still in .gitignore (self-clearing reminder)
export const GITIGNORE_MARKER = '# wafflestack'        // comment prefixing wafflestack's appended .gitignore block
export function ensureGitignoreEntries(cwd, entries)   // idempotent append of approved .gitignore lines (--gitignore/setup); → entries added (skips present, preserves content)
export function recommendedGitignoreEntries(toolkit, project) // → baseline offer: [.waffle/waffle.local.yaml, + resolved git.worktreesDir when an enabled bundle declares it]
export function makeResolver(bundle, values, target)   // → (key: string) => value | undefined

// util.mjs
export function sha256(content)                        // → hex string
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
export function doctor({ cwd, toolkitVersion, allowMissing }) // → { ok, modified, missing, notes, allowMissing }  (notes always name the rendered toolkitVersion)

// migrations.mjs
export const MIGRATIONS                                // → [{ version, description, run(cwd) }]  (ordered, idempotent; carries the 0.6.0 dotfile rename)
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) // → steps in (from, to], ascending
export function runMigrations({ cwd, fromVersion, toVersion, migrations, log }) // → steps that ran; runs each step.run(cwd) in order

// upgrade.mjs
export function upgrade({ toolkitRoot, cwd, toolkitVersion, migrations, changelog, log }) // → { ok, status, fromVersion, toVersion, changelogDelta, migrationsRun, render, doctor, notes }
export function changelogBetween(text, fromVersion, toVersion) // → markdown of `## [X.Y.Z]` sections in (from, to], newest first | null

// eject.mjs
export function eject({ cwd, item })                   // → { ref, released }  (also strips a matching include: entry)
export function installRefs({ toolkitRoot, cwd, refs, log }) // → { added, closures }  (persist refs; caller renders after)
export function init({ cwd })                          // → configFile path

// validate.mjs
export function validateToolkit(rootDir)               // → string[] (problems; [] = clean)

// setup.mjs
export function setupGuide(toolkitRoot, toolkitVersion) // → string
export function toolkitInventory(toolkit, version)      // → string

// waffledocs.mjs
export function generateWaffleDocs({ toolkit, project, selection, errors }) // → [{ rel, content }] for .waffle/{CHEATSHEET.md,cheatsheet.svg,TEAM.md,team.svg}; each pair omitted when its item set is empty
```

Import graph (`util.mjs` and `refs.mjs` are pure leaves; `template.mjs` depends only on `yaml`):

```
cli.mjs      → render, doctor, eject, validate, setup, upgrade   (command dispatch)
render.mjs   → refs, template, toolkit, project, util, waffledocs
waffledocs.mjs → template, project, util
doctor.mjs   → render, project, util
eject.mjs    → render, toolkit, refs, project, util
validate.mjs → toolkit, template, refs, util
setup.mjs    → toolkit
upgrade.mjs  → render, doctor, migrations, project, util
migrations.mjs → util
toolkit.mjs  → util
project.mjs  → util
template.mjs → (yaml)
refs.mjs     → (none)
util.mjs     → (none)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Global flag `--cwd DIR` targets a project dir
(spliced out before ref parsing; default: process cwd; `cli.mjs:16`, `extractCwd` `cli.mjs:94`).
Usage: `wafflestack <init|setup|install|render|upgrade|doctor|eject|validate> [refs…] [--cwd DIR]`.

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.waffle/waffle.yaml` (targets / bundles / include / config / eject scaffold, creating `.waffle/`); errors if one exists at any generation. `--gitignore` also appends `.waffle/waffle.local.yaml` (only that — no bundle chosen yet). `eject.mjs:166` |
| `setup` | Print `schema/SETUP.md` playbook + inventory generated from the installed toolkit. `setup.mjs:11` |
| `install [ref…]` | Persist each ref to config (bundle → `bundles:`, item → canonical `include:`; resolves up front, reports pulled-in deps), then render. Bare `install` = `render`. `--gitignore` appends recommended entries after a clean render. `eject.mjs:74` |
| `render` | Regenerate all managed files verbatim for the current selection; delete now-unrendered managed files; write lock. Rejects positional refs. Exit 1 on error. `--gitignore` appends recommended entries after a clean render (`ensureGitignoreEntries` + `recommendedGitignoreEntries`, `offerGitignore` in `cli.mjs`). `render.mjs:24` |
| `upgrade` | Read lock `toolkitVersion`, print `CHANGELOG.md` delta to the invoked version, run migrations in `(from, to]`, then render + doctor. Missing lock/version degrades to render + doctor with a note. Rejects positional refs. Exit follows doctor. `upgrade.mjs:23` |
| `doctor` | Diff managed files vs lock; always report the rendered `toolkitVersion` + a skew note. Exit 1 on drift (`--allow-missing`: only modified files fail). `doctor.mjs:17` |
| `eject <skills/NAME\|agents/NAME>` | Add to `eject:`, strip any matching `include:` entry, drop the item's files from the lock; files stay in place, now project-owned. `eject.mjs:17` |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter complete, placeholder↔declaration sync, agent-skill/`requires:` refs resolve. Exit 1 on problems. `validate.mjs:9` |

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, and `requires:`) names something installable.
Grammar + resolution live in `refs.mjs` (`parseRef` `refs.mjs:38`, `resolveRef` `refs.mjs:64`).

| Form | Example | Meaning |
|------|---------|---------|
| bundle | `github-workflow` | a whole bundle (unknown name → error) |
| item | `skills/issue`, `agents/project-manager` | an item; unqualified, must be unique toolkit-wide |
| qualified | `engineering-team/skills/webapp-security-audit` | an item in a named bundle (disambiguates cross-bundle name collisions) |

A bare item name resolves only when unique across the toolkit; otherwise it must be
bundle-qualified. `canonicalRef` is the minimal re-resolvable form (qualified only when
ambiguous) — that is what `install` writes to `include:`.

Render selection (`computeSelection`, `refs.mjs:222`):

```
rendered = union(items of enabled bundles:) ∪ closure(each include: item) − eject:
```

- Dependency closure — installing an item pulls its transitive cross-bundle deps (BFS, deduped
  by bundle+kind+name). Direct deps of a node = agent frontmatter `skills:` (lenient — absent
  or ambiguous names skipped) + bundle `requires:[kind/name]` (strict — a dangling entry is a
  toolkit bug). The closure is recomputed every render, never persisted.
- Grouping — selected items are grouped by owning bundle; config/env checks run per bundle over
  only the selected items. Required-config is scoped to placeholder keys the selected items
  reference (`missingRequiredKeys` `usedKeys`), so a partial install does not demand config only
  a bundle's other items use. Env prerequisites still warn when any item from a bundle renders.
- `eject:` wins over both `bundles:` and `include:`; `eject` self-cleans a matching `include:`.

## Template semantics

- Placeholders `{{dotted.key}}` (regex `template.mjs:3`) substitute only if the key is
  declared in the bundle's `config:` or is `harness.*` (`template.mjs:34`). Any other braces
  (bash `${...}`, GitHub Actions `${{ }}`, mustache) pass through verbatim.
- Value formatting (`formatValue`, `template.mjs:52`): strings verbatim; string arrays join
  `, `; other structures render as a YAML block.
- `harness.*` — reserved, always-available namespace (never declared), resolved per output
  target (`HARNESS_BUILTINS`, `project.mjs:229`). Override via `config.harness.<sub>` (scalar →
  all targets, or a per-target map).
- Nested substitution — substituted values are re-expanded up to depth 4
  (`MAX_SUBSTITUTION_DEPTH`, `template.mjs:11`; `expandNested`, `template.mjs:44`): a committed
  value can reference a key kept in the gitignored local overlay. Canonical text surviving the
  first pass is never re-scanned; unresolvable nested placeholders pass through.
- Value patterns — a config key may declare `pattern:` (a regex); the fully-resolved value must
  fully match at render or the render fails, like a missing required key (`compilePattern`
  `template.mjs`, enforced in `substitute`, linted by `validate`). For values spliced into
  structured contexts (a workflow `if:`, a YAML scalar) where context-correct escaping is impossible.
- Extensions — `.waffle/extensions/{agents,skills}/<name>.md` appended to the rendered
  item inside `<!-- BEGIN project extension: … -->` / `<!-- END project extension -->` markers
  (`appendExtension`, `render.mjs:191`). Agents: appended to body; skills: appended to
  `SKILL.md` only.
- Output conflict — two enabled sources emitting the same output path is a hard render error
  (`emit`, `render.mjs:34`), not last-write-wins.

| `harness.*` key | claude | codex | agents-dir |
|-----------------|--------|-------|------------|
| `harness.assistantName` | Claude | Codex | Codex |
| `harness.attributionPath` | claude-code | Codex | Codex |
| `harness.skillsDir` | .claude/skills | .agents/skills | .agents/skills |

Render targets (`VALID_TARGETS`, `project.mjs:27`):

| Source | claude | codex | agents-dir |
|--------|--------|-------|------------|
| agent `agents/<n>.md` | `.claude/agents/<n>.md` (frontmatter name/description/skills + `claude:` passthrough; body) | `.codex/agents/<n>.toml` (name, description, developer_instructions=body) | — |
| skill `skills/<n>/` | `.claude/skills/<n>/` | — | `.agents/skills/<n>/` |

Skills render byte-for-byte except substitution + extension append; non-`.md` supporting
files are copied verbatim.

## Consuming-project contract

Everything lives inside the one `.waffle/` directory (0.8.0 layout; legacy root `.waffle.*`
and pre-0.6.0 `.wafflestack.*` names still read with a deprecation note and are moved in
place by `render`/`upgrade`):

| File | Tracked | Role |
|------|---------|------|
| `.waffle/waffle.yaml` | committed | version, `targets`, `bundles`, `include`, `config`, `eject` (`loadProjectConfig`, `project.mjs:196`). `install`/`eject` edit it comment-preservingly. |
| `.waffle/waffle.local.yaml` | gitignored | deep-merged over committed config, wins on conflict — account-specific values |
| `.waffle/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.waffle/waffle.lock.json` | generated | manifest of rendered file → sha256 (+ toolkitVersion, targets, bundles, include); `doctor` diffs against it, `render` rewrites it |
| `.waffle/{CHEATSHEET,TEAM}.md` + `.waffle/{cheatsheet,team}.svg` | generated (committed by consumers) | overview of the installed selection — cheat sheet of user-invocable skills + team intro of agents, Markdown source of truth + branded SVG. Emitted via `emit()` (`waffledocs.mjs`), so lock-tracked, doctor-checked, and pruned like any managed file |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml`.

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 147 tests, 28 suites) |
| validate / typecheck | `npm run validate` = `node installer/cli.mjs validate` |
| build | `npm pack --dry-run` |
| render (dogfood) | `node installer/cli.mjs render` |
| verify render | `node installer/cli.mjs doctor` |

## Dogfood state

This repo renders 3 bundles into itself — `github-workflow`, `docs-system`, `orchestration`
(`targets: [claude]`, no `include:`; see `.waffle/waffle.yaml`). Rendered output
(`.claude/agents/`, `.claude/skills/`) and `.waffle/waffle.lock.json` are gitignored here;
regenerate with `node installer/cli.mjs render`. Only `.claude/settings.json` is tracked under
`.claude/` (project-owned; holds the agent-teams env var).

## Owner-voiced docs — do not rewrite

`README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are owner-voiced canonical documents
(the schema files ship to consumers via npx). Do not rewrite them in a docs pass — flag any
drift instead.
