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
  bundle.yaml              manifest: agents, skills, config schema, env, setup
  agents/<name>.md         neutral agent def (YAML frontmatter + body)
  skills/<name>/SKILL.md   neutral skill def (+ supporting files, copied along)
installer/cli.mjs          bin entry: dispatches commands, global --cwd flag
installer/lib/*.mjs        render pipeline (ES modules)
installer/test/*.test.mjs  node:test suite
schema/FORMAT.md           format reference (owner-voiced)
schema/SETUP.md            agent install playbook (owner-voiced)
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
| `orchestration` | `bundles/orchestration/` | project-manager, task-planner | delegate, audit, docs | Multi-agent orchestration; sets env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Roster + audit compliance step are config. |
| `engineering-team` | `bundles/engineering-team/` | lead-developer, data-engineer, qa-engineer, devops-engineer, product-manager, ux-designer, security-engineer | security-audit | Product-eng roster (browser-app `security-audit`). Slots into `orchestration`'s roster. |
| `expo-dev` | `bundles/expo-dev/` | mobile-architect | expo-ui, expo-app-dev | Expo / React Native app development (@expo/ui, dev loop, EAS). |

Item-name collision (by design): `code-quality` and `engineering-team` both define a skill
named `security-audit` (desktop-plugin vs browser-app variant). Enabling both in one project
is a hard render error (output-conflict guard, `render.mjs:33`). Enable one, or `eject` one.

## Installer module registry

`installer/lib/*.mjs`, ES modules. See signatures block below for exports.

| Module | Purpose |
|--------|---------|
| `installer/lib/render.mjs` | Render pipeline: regenerate all outputs verbatim, delete stale managed files, write lock. Output-conflict + env-prereq checks. |
| `installer/lib/template.mjs` | `{{placeholder}}` substitution: declared-key gate, per-target resolve, depth-capped nested expansion, value formatting. |
| `installer/lib/toolkit.mjs` | Load `toolkit.yaml` + every bundle manifest (agents, skills, config, env, setup); required-key check. |
| `installer/lib/project.mjs` | Load consuming-project config (+ local overlay), valid targets, `harness.*` built-ins, per-target resolver. |
| `installer/lib/util.mjs` | Shared helpers: sha256, YAML read, deep-merge, dotted lookup, frontmatter parse/stringify, fs writes. |
| `installer/lib/doctor.mjs` | Diff managed files against the lock; report modified/missing + version-skew note. |
| `installer/lib/eject.mjs` | `eject` (release an item to project ownership) and `init` (write starter config). |
| `installer/lib/validate.mjs` | Toolkit-developer lint: manifests, frontmatter, placeholder↔declaration sync (both directions). |
| `installer/lib/setup.mjs` | `setup` output: `schema/SETUP.md` playbook + inventory generated from the installed toolkit. |

```js
// render.mjs
export function renderProject({ toolkitRoot, cwd, toolkitVersion, log }) // → { ok, errors, warnings, written, removed }
export function readLock(cwd)                          // → lock object | null
export function normalizeItemRef(ref)                  // → "agents/NAME" | "skills/NAME"

// template.mjs   (PLACEHOLDER = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g; MAX_SUBSTITUTION_DEPTH = 4)
export function substitute(text, resolve, declared, errors, context) // → string
export function formatValue(v)                         // → string (string[] join ", "; else YAML block)
export function placeholderKeys(text)                  // → Set<string>

// toolkit.mjs
export function loadToolkit(rootDir)                   // → { name, description, bundles: Map<name, bundle> }
export function missingRequiredKeys(bundle, values, lookup) // → string[]

// project.mjs
export const CONFIG_FILE, LOCAL_CONFIG_FILE, LOCK_FILE, EXTENSIONS_DIR
export const VALID_TARGETS = ['claude', 'codex', 'agents-dir']
export const HARNESS_BUILTINS                          // { assistantName, attributionPath, skillsDir } per target
export function loadProjectConfig(cwd)                 // → { targets, bundles, values, eject }
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
export function eject({ cwd, item })                   // → { ref, released }
export function init({ cwd })                          // → configFile path

// validate.mjs
export function validateToolkit(rootDir)               // → string[] (problems; [] = clean)

// setup.mjs
export function setupGuide(toolkitRoot, toolkitVersion) // → string
export function toolkitInventory(toolkit, version)      // → string
```

Import DAG (`util.mjs` is the shared leaf; `template.mjs` depends only on `yaml`):

```
cli.mjs
 ├─ render.mjs ──┬─ template.mjs
 │               ├─ toolkit.mjs ─ util.mjs
 │               └─ project.mjs ─ util.mjs
 ├─ doctor.mjs ── render.mjs, project.mjs, util.mjs
 ├─ eject.mjs ─── render.mjs, project.mjs, util.mjs
 ├─ validate.mjs ─ toolkit.mjs, template.mjs, util.mjs
 └─ setup.mjs ─── toolkit.mjs
```

## CLI command registry

Bin `wafflestack` → `installer/cli.mjs`. Global flag `--cwd DIR` targets a project dir
(default: process cwd; `cli.mjs:73`).

| Command | Behavior |
|---------|----------|
| `init` | Write starter `.wafflestack.yaml`; errors if one exists. `eject.mjs:63` |
| `setup` | Print `schema/SETUP.md` playbook + inventory generated from the installed toolkit. `setup.mjs:11` |
| `render` (alias `install`) | Regenerate all managed files verbatim; delete now-unrendered managed files; write lock. Exit 1 on error. `render.mjs:23` |
| `doctor` | Diff managed files vs lock; report modified/missing + version-skew note. Exit 1 on drift. `doctor.mjs:11` |
| `eject <skills/NAME\|agents/NAME>` | Add to config `eject:` list, drop the item's files from the lock; files stay in place, now project-owned. `eject.mjs:13` |
| `validate` | Toolkit-developer lint: manifests parse, frontmatter complete, placeholder↔declaration sync. Exit 1 on problems. `validate.mjs:8` |

## Template semantics

- Placeholders `{{dotted.key}}` (regex `template.mjs:3`) substitute only if the key is
  declared in the bundle's `config:` or is `harness.*` (`template.mjs:34`). Any other braces
  (bash `${...}`, GitHub Actions `${{ }}`, mustache) pass through verbatim.
- Value formatting (`formatValue`, `template.mjs:52`): strings verbatim; string arrays join
  `, `; other structures render as a YAML block.
- `harness.*` — reserved, always-available namespace (never declared), resolved per output
  target (`HARNESS_BUILTINS`, `project.mjs:40`). Override via `config.harness.<sub>` (scalar →
  all targets, or a per-target map).
- Nested substitution — substituted values are re-expanded up to depth 4
  (`MAX_SUBSTITUTION_DEPTH`, `template.mjs:11`; `expandNested`, `template.mjs:44`): a committed
  value can reference a key kept in the gitignored local overlay. Canonical text surviving the
  first pass is never re-scanned; unresolvable nested placeholders pass through.
- Extensions — `.wafflestack/extensions/{agents,skills}/<name>.md` appended to the rendered
  item inside `<!-- BEGIN project extension: … -->` / `<!-- END project extension -->` markers
  (`render.mjs:184`). Agents: appended to body; skills: appended to `SKILL.md` only.
- Output conflict — two enabled bundles emitting the same output path is a hard render error
  (`render.mjs:33`), not last-write-wins.

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
| `.wafflestack.yaml` | committed | version, `targets`, `bundles`, `config`, `eject` (`loadProjectConfig`, `project.mjs:12`) |
| `.wafflestack.local.yaml` | gitignored | deep-merged over committed config, wins on conflict — account-specific values |
| `.wafflestack/extensions/{agents,skills}/<name>.md` | committed | appended to the rendered item inside extension markers |
| `.wafflestack.lock.json` | generated | manifest of rendered file → sha256; `doctor` diffs against it, `render` rewrites it |

## Build / test / verify

Node >= 18. Single runtime dependency: `yaml`.

| Task | Command |
|------|---------|
| test | `npm test` (node:test, `installer/test/*.test.mjs`; 26 tests) |
| validate / typecheck | `npm run validate` = `node installer/cli.mjs validate` |
| build | `npm pack --dry-run` |
| render (dogfood) | `node installer/cli.mjs render` |
| verify render | `node installer/cli.mjs doctor` |

## Dogfood state

This repo renders 3 bundles into itself — `github-workflow`, `docs-system`, `orchestration`
(`targets: [claude]`, see `.wafflestack.yaml`). Rendered output (`.claude/agents/`,
`.claude/skills/`) and `.wafflestack.lock.json` are gitignored here; regenerate with
`node installer/cli.mjs render`. Only `.claude/settings.json` is tracked under `.claude/`
(project-owned; holds the agent-teams env var).

## Owner-voiced docs — do not rewrite

`README.md`, `schema/FORMAT.md`, and `schema/SETUP.md` are owner-voiced canonical documents
(the schema files ship to consumers via npx). Do not rewrite them in a docs pass — flag any
drift instead.
