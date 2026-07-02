# Decisions

Why wafflestack is built the way it is — the choices that shaped the toolkit,
newest first. Each entry records the situation, what was decided, what else was
weighed, and what it affects.

For *what exists today* see [STATUS.md](STATUS.md); for *how it fits together*
see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 2026-07-01: Dogfood the docs-system and orchestration bundles

**Context**: The repo already rendered the `github-workflow` bundle into itself.
The documentation, project-manager, and task-planner agents (plus the
`/delegate`, `/audit`, and `/docs` skills) would also help develop the toolkit.

**Decision**: Enable `docs-system` and `orchestration` in `.wafflestack.yaml`
with repo-shaped config — a single root `AGENTS.md` registry instead of the
default per-feature layout, `schema/FORMAT.md` as the architecture reference, a
general-purpose specialist roster, an "all-open" delegate scope (this repo has no
milestones), and a toolkit-integrity compliance check (validate + test + render +
doctor). Added the agent-teams environment flag the orchestration bundle needs.

**Alternatives considered**: Keep developing the toolkit without its own agents;
hand-write the docs.

**Rationale**: The best proof the toolkit works is using it. The config overrides
also exercise the doc-set parameterization added in v0.4.0.

**Impact**: This is why the root `AGENTS.md` and these `DECISIONS.md` /
`STATUS.md` / `ARCHITECTURE.md` files exist — they are produced by the toolkit's
own documentation agents.

---

## 2026-07-01: Gitignore the rendered output in the toolkit repo (v0.5.0)

**Context**: Self-hosting means this repo renders bundles into its own
`.claude/` directory. A normal consuming project commits that rendered output —
but the toolkit repo is not a normal consumer.

**Decision**: Gitignore all rendered output (`.claude/agents/`,
`.claude/skills/`, `.codex/`, `.agents/`) and the lock file. Only
`.claude/settings.json` (project-owned) is tracked. Regenerate on demand with
`node installer/cli.mjs render`.

**Alternatives considered**: Commit the rendered copy, exactly as a consuming
project would.

**Rationale**: A committed second copy of every skill would pollute code search
and invite edits to generated files — the one thing the toolkit forbids.

**Impact**: Contributors must re-render after changing a bundle. Nothing
generated lives in git.

---

## 2026-07-01: Agent-driven setup wizard (v0.5.0)

**Context**: Manual install (init → edit YAML → render) expects a human to know
every bundle, config key, and external prerequisite up front.

**Decision**: `wafflestack setup` prints an install playbook (`schema/SETUP.md`)
plus a generated inventory of every bundle's items, config schema, environment
prerequisites, and service-side setup notes (a new optional `setup:` field in
`bundle.yaml`). A coding agent runs the whole flow.

**Alternatives considered**: A traditional interactive prompt-based CLI wizard.

**Rationale**: A coding agent can detect the project's targets and commands, fill
in config, verify externals (e.g. `gh` auth and labels), render, and report — far
more capable than a fixed question-and-answer script.

**Impact**: Installing is now "tell your agent to set up wafflestack."
`schema/SETUP.md` and the `setup:` field are owner-voiced.

---

## 2026-07-01: Documentation shapes are project config (v0.4.0)

**Context**: A second consumer had documentation that was not shaped like a
`src/`-based application, which the doc skills had assumed.

**Decision**: The machine- and human-documentation shapes became config keys
(`docs.machineDocSet`/`Spec`, `docs.humanDocSet`/`Spec`), with the original
`src/`-app layout kept as the default. Added optional voice-guardrail and
privacy-guardrail sections and a configurable architecture-reference skill.

**Alternatives considered**: Hard-code the `src/`-feature documentation layout in
the skills.

**Rationale**: Documentation conventions vary by project; parameterize the skill
rather than fork it.

**Impact**: This repo overrides the machine-doc shape to a single `AGENTS.md`
registry while keeping the default human-doc shape (these three files).

---

## 2026-07-01: Enabling two bundles that emit the same file is a hard error

**Context**: Two bundles can define an item with the same name — for example, two
`security-audit` variants (desktop-plugin vs. browser-app).

**Decision**: Rendering the same output path from two enabled bundles fails the
render, rather than silently letting the last one win.

**Alternatives considered**: Last-write-wins, or a silent merge.

**Rationale**: Same-named items are *alternative implementations* of one
interface; enabling both is a project mistake worth catching loudly.

**Impact**: Enable one variant, or `eject` one of them.

---

## 2026-07-01: Recursive (nested) template substitution

**Context**: Some committed config values need to reference account-specific
values that must stay out of version control.

**Decision**: A substituted value may itself contain `{{placeholders}}`, expanded
recursively up to a depth of 4. Expansion only descends into substituted values,
so canonical `${{ ... }}` (GitHub Actions) and similar syntax pass through
untouched.

**Alternatives considered**: Flat, single-pass substitution only.

**Rationale**: A committed value (such as a git command) can reference a key kept
in the gitignored local overlay — secrets and identities stay local while the
template stays committed.

**Impact**: Avoid config key names that collide with literal template syntax you
embed in values.

---

## 2026-07-01: Rename agent-toolkit → wafflestack (v0.2.0)

**Context**: The project shipped early under the name "agent-toolkit."

**Decision**: Rebrand the repo, the CLI binary, and the entire consumer file
contract (`.agent-toolkit.*` → `.wafflestack.*`, extensions directory moved).

**Alternatives considered**: Keep the original name.

**Rationale**: A better name, and the rename happened before the first consuming
project merged — so the breaking change cost nothing.

**Impact**: Breaking for any consumer, but there were none yet.

---

## 2026-07-01: One canonical source per item, rendered per harness (v0.1.0)

**Context**: The same agent or skill must render slightly differently for each
harness (e.g. Claude vs. Codex attribution, different skills directory).

**Decision**: A reserved `harness.*` namespace resolves per output target, and
substitution runs once per target — so one source file renders every harness
variant. Naming convention settled here: `project.name` is the bare name,
`project.longName` is the prose descriptor.

**Alternatives considered**: Maintain a separate source file per harness.

**Rationale**: No duplication; the per-harness differences are small and
mechanical.

**Impact**: Adding a new harness means extending the built-ins, not forking every
file.

---

## 2026-07-01: The frozen-image render contract (v0.1.0 foundation)

**Context**: Reusable agent/skill definitions need to be both *shareable* and
*updatable* without clobbering each project's local tweaks.

**Decision**: Adopt a shadcn-style model — one canonical source repo, rendered
verbatim into each project. Rendered files are generated output and are never
edited; a lock manifest (a sha256 per file) lets `doctor` detect drift, `render`
regenerate and prune stale files, and `eject` release an item to project
ownership. Per-project changes live in config values and extension files.

**Alternatives considered**: Distribute as an npm dependency imported at runtime;
a git submodule; or copy-paste with no update path.

**Rationale**: Updates become simple re-renders. Projects keep full ownership of
the files while staying in sync with upstream, and config and extensions survive
every re-render.

**Impact**: The core contract everything else is built on. Never edit rendered
files — put additions in `.wafflestack.yaml` (config) or
`.wafflestack/extensions/` (appended content).
