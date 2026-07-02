---
last-updated: 2026-07-02
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

`toolkit.yaml` lists 8 bundles. Per-bundle config schema, env, and setup notes live in each
`bundle.yaml` (authoritative — this table summarizes).

| Bundle | Path | Agents | Skills | Purpose |
|--------|------|--------|--------|---------|
| `docs-system` | `bundles/docs-system/` | docs-agent, docs-human | docs-agent, docs-human | Two-audience doc system; doc-set shapes (`docs.machineDocSet/Spec`, `docs.humanDocSet/Spec`) are config. |
| `github-workflow` | `bundles/github-workflow/` | (none) | git-workflow, issue, github-project-management, clean-up | Git / GitHub issue / Projects v2 workflow. Only bundle with a `setup:` block (gh auth, labels, board, git identity). |
| `code-quality` | `bundles/code-quality/` | architect, security | tdd, security-audit, codebase-architecture | Code-quality specialists (desktop-plugin `security-audit`). Pairs with `obsidian-dev`. |
| `design` | `bundles/design/` | designer | (none) | Brand SVG/icon/banner asset production with a render-verify loop. |
| `obsidian-dev` | `bundles/obsidian-dev/` | plugin-architect | obsidian-plugin-dev | Obsidian plugin development (API, manifest, esbuild). |
| `orchestration` | `bundles/orchestration/` | project-manager, task-planner | delegate, audit, docs | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance are config. Only bundle with `requires:` (delegate→git-workflow+github-project-management, docs→docs-agent+docs-human). |
| `engineering-team` | `bundles/engineering-team/` | lead-developer, data-engineer, qa-engineer, devops-engineer, product-manager, ux-designer, security-engineer | security-audit | Product-eng roster (browser-app `security-audit`). Slots into `orchestration`'s roster. |
| `expo-dev` | `bundles/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development (@expo/ui, dev loop, EAS). |

Item-name collision (by design): `code-quality` and `engineering-team` both define a skill
named `security-audit` (desktop-plugin vs browser-app variant). Enabling both whole bundles is
a hard render error (output-conflict guard, `render.mjs:34`); to install just one, use a
bundle-qualified ref (`code-quality/skills/security-audit`).

## Installer module registry

`installer/lib/*.mjs`, ES modules. See signatures block below for exports.

| Module | Purpose |
|--------|---------|
| `installer/lib/render.mjs` | Render pipeline: compute selection, regenerate all outputs verbatim, delete stale managed files, write lock. Output-conflict + scoped required-config + env-prereq checks. |
| `installer/lib/refs.mjs` | Ref grammar, toolkit-wide resolution, and transitive cross-bundle dependency closure + render-selection computation. Pure leaf (no local imports). Shared by install / render / validate. |
| `installer/lib/template.mjs` | `{{placeholder}}` substitution: declared-key gate, per-target resolve, depth-capped nested expansion, value formatting. |
| `installer/lib/toolkit.mjs` | Load `toolkit.yaml` + every bundle manifest (agents, skills, `requires`, config, env, setup); scoped required-key check. |
| `installer/lib/project.mjs` | Load consuming-project config (+ local overlay), valid targets, `harness.*` built-ins, per-target resolver. |
| `installer/lib/util.mjs` | Shared helpers: sha256, YAML read, deep-merge, dotted lookup, frontmatter parse/stringify, fs writes. |
| `installer/lib/doctor.mjs` | Diff managed files against the lock; report modified/missing + version-skew note. |
| `installer/lib/eject.mjs` | `eject` (release an item, self-cleaning its `include:`), `installRefs` (persist bundle/item refs to config), `init` (starter config). |
| `installer/lib/validate.mjs` | Toolkit-developer lint: manifests, frontmatter, placeholder↔declaration sync, agent-skill + `requires:` ref integrity. |
| `installer/lib/setup.mjs` | `setup` output: `schema/SETUP.md` playbook + inventory generated from the installed toolkit. |

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
export function substitute(text, resolve, declared, errors, context) // → string
export function formatValue(v)                         // → string (string[] join ", "; else YAML block)
export function placeholderKeys(text)                  // → Set<string>

// toolkit.mjs
export function loadToolkit(rootDir)                   // → { name, description, bundles: Map<name, bundle> }  (bundle gains .requires)
export function missingRequiredKeys(bundle, values, lookup, usedKeys = null) // → string[]  (usedKeys Set scopes to referenced keys)

// project.mjs
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, EXTENSIONS_DIR
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir']
export const HARNESS_BUILTINS                          // { assistantName, attributionPath, skillsDir } per target
export function loadProjectConfig(cwd)                 // → { targets, bundles, include, values, eject }
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

// doctor.mjs
export function doctor({ cwd, toolkitVersion })        // → { ok, modified, missing, notes }

// eject.mjs
export function eject({ cwd, item })                   // → { ref, released }  (also strips a matching include: entry)
export function installRefs({ toolkitRoot, cwd, refs, log }) // → { added, closures }  (persist refs; caller renders after)
export function init({ cwd })                          // → configFile path

// validate.mjs
export function validateToolkit(rootDir)               // → string[] (problems; [] = clean)

// setup.mjs
export function setupGuide(toolkitRoot, toolkitVersion) // → string
export function toolkitInventory(toolkit, version)      // → string
```

Import graph (`util.mjs` and `refs.mjs` are pure leaves; `template.mjs` depends only on `yaml`):

```
cli.mjs      → render, doctor, eject, validate, setup   (command dispatch)
render.mjs   → refs, template, toolkit, project, util
doctor.mjs   → render, project, util
eject.mjs    → render, toolkit, refs, project, util
validate.mjs → toolkit, template, refs, util
setup.mjs    → toolkit
toolkit.mjs  → util
project.mjs  → util
template.mjs → (yaml)
refs.mjs     → (none)
util.mjs     → (none)
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Global flag `--cwd DIR` targets a project dir
(spliced out before ref parsing; default: process cwd; `cli.mjs:16`, `extractCwd` `cli.mjs:94`).
Usage: `wafflestack <init|setup|install|render|doctor|eject|validate> [refs…] [--cwd DIR]`.

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.wafflestack.yaml` (targets / bundles / include / config / eject scaffold); errors if one exists. `eject.mjs:150` |
| `setup` | Print `schema/SETUP.md` playbook + inventory generated from the installed toolkit. `setup.mjs:11` |
| `install [ref…]` | Persist each ref to config (bundle → `bundles:`, item → canonical `include:`; resolves up front, reports pulled-in deps), then render. Bare `install` = `render`. `eject.mjs:74` |
| `render` | Regenerate all managed files verbatim for the current selection; delete now-unrendered managed files; write lock. Rejects positional refs. Exit 1 on error. `render.mjs:24` |
| `doctor` | Diff managed files vs lock; report modified/missing + version-skew note. Exit 1 on drift. `doctor.mjs:11` |
| `eject <skills/NAME\|agents/NAME>` | Add to `eject:`, strip any matching `include:` entry, drop the item's files from the lock; files stay in place, now project-owned. `eject.mjs:17` |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter complete, placeholder↔declaration sync, agent-skill/`requires:` refs resolve. Exit 1 on problems. `validate.mjs:9` |

## Item refs and render selection

A ref (used by `install`, `include:`, `eject`, and `requires:`) names something installable.
Grammar + resolution live in `refs.mjs` (`parseRef` `refs.mjs:38`, `resolveRef` `refs.mjs:64`).

| Form | Example | Meaning |
|------|---------|---------|
| bundle | `github-workflow` | a whole bundle (unknown name → error) |
| item | `skills/issue`, `agents/project-manager` | an item; unqualified, must be unique toolkit-wide |
| qualified | `engineering-team/skills/security-audit` | an item in a named bundle (disambiguates cross-bundle name collisions) |

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
  target (`HARNESS_BUILTINS`, `project.mjs:41`). Override via `config.harness.<sub>` (scalar →
  all targets, or a per-target map).
- Nested substitution — substituted values are re-expanded up to depth 4
  (`MAX_SUBSTITUTION_DEPTH`, `template.mjs:11`; `expandNested`, `template.mjs:44`): a committed
  value can reference a key kept in the gitignored local overlay. Canonical text surviving the
  first pass is never re-scanned; unresolvable nested placeholders pass through.
- Extensions — `.wafflestack/extensions/{agents,skills}/<name>.md` appended to the rendered
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

Render targets (`VALID_TARGETS`, `project.mjs:9`):

| Source | claude | codex | agents-dir |
|--------|--------|-------|------------|
| agent `agents/<n>.md` | `.claude/agents/<n>.md` (frontmatter name/description/skills + `claude:` passthrough; body) | `.codex/agents/<n>.toml` (name, description, developer_instructions=body) | — |
| skill `skills/<n>/` | `.claude/skills/<n>/` | — | `.agents/skills/<n>/` |

Skills render byte-for-byte except substitution + extension append; non-`.md` supporting
files are copied verbatim.

## Consuming-project contract

| File | Tracked | Role |
|------|---------|------|
| `.wafflestack.yaml` | committed | version, `targets`, `bundles`, `include`, `config`, `eject` (`loadProjectConfig`, `project.mjs:12`). `install`/`eject` edit it comment-preservingly. |
| `.wafflestack.local.yaml` | gitignored | deep-merged over committed config, wins on conflict — account-specific values |
| `.wafflestack/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.wafflestack.lock.json` | generated | manifest of rendered file → sha256 (+ toolkitVersion, targets, bundles, include); `doctor` diffs against it, `render` rewrites it |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml`.

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 53 tests, 11 suites) |
| validate / typecheck | `npm run validate` = `node installer/cli.mjs validate` |
| build | `npm pack --dry-run` |
| render (dogfood) | `node installer/cli.mjs render` |
| verify render | `node installer/cli.mjs doctor` |

## Dogfood state

This repo renders 3 bundles into itself — `github-workflow`, `docs-system`, `orchestration`
(`targets: [claude]`, no `include:`; see `.wafflestack.yaml`). Rendered output
(`.claude/agents/`, `.claude/skills/`) and `.wafflestack.lock.json` are gitignored here;
regenerate with `node installer/cli.mjs render`. Only `.claude/settings.json` is tracked under
`.claude/` (project-owned; holds the agent-teams env var).

## Owner-voiced docs — do not rewrite

`README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are owner-voiced canonical documents
(the schema files ship to consumers via npx). Do not rewrite them in a docs pass — flag any
drift instead.
