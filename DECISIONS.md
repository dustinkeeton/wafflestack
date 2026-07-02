# Decisions

Why wafflestack is built the way it is — the choices that shaped the toolkit,
newest first. Each entry records the situation, what was decided, what else was
weighed, and what it affects.

For *what exists today* see [STATUS.md](STATUS.md); for *how it fits together*
see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 2026-07-02: Offer opt-in `.gitignore` entries during setup/install (#29)

**Context**: The CLI deliberately never edited `.gitignore` — a consumer owns it — and
gitignore guidance was prose-only (`schema/SETUP.md` step 6, the README rules), while render
merely *warned* about stale legacy entries (`staleGitignoreEntries`). Sound as a default, but
it left two footguns: forgetting to ignore `.waffle.local.yaml` commits account-specific
config, and the "dev-only waffle" case (a consumer who wants a render only in their working
environment, not committed) had to hand-maintain the ignores — a pattern documented only as
the toolkit repo's own self-hosting exception.

**Decision**: Keep the never-edit-*silently* stance; add an opt-in **offer**, refining the
doc stance from "never edits `.gitignore`" to "never edits it **unasked**." Implement **both**
UX surfaces the issue proposed, because they cover different drivers:

- **Playbook step** — `schema/SETUP.md` step 6 now tells the driving agent to *propose* the
  concrete entries and apply them on the user's approval (the agent is the interactive layer
  the non-interactive CLI lacks).
- **Explicit CLI flag** — `--gitignore` on `init`/`render`/`install` (mirroring how #25 wired
  `--force`). The explicit flag *is* the consumer's consent, so writing `.gitignore` behind it
  doesn't violate the stance.

Two new pure helpers in `installer/lib/project.mjs`: `ensureGitignoreEntries(cwd, entries)`
appends idempotently (exact-line dedupe, existing content preserved, a missing trailing
newline added, one `# wafflestack` marker) and returns what it added;
`recommendedGitignoreEntries(toolkit, project)` computes the baseline offer —
`.waffle.local.yaml` always, plus the resolved `git.worktreesDir` when an enabled bundle
declares that key. `init --gitignore` seeds only the local overlay (no bundle chosen yet).
Dev-only / self-hosting mode (also gitignoring the renders + `.waffle.lock.json`, paired with
`doctor.flags: --allow-missing` as the CI companion) stays a separate, agent-proposed choice,
not part of the flag's automatic baseline.

**Alternatives considered**:

- **Playbook step only** (no flag). Rejected — leaves a manual, error-prone hand-edit as the
  only mechanized path; the flag makes the common case one idempotent command.
- **Flag only** (no playbook change). Rejected — the guided setup is the primary install path;
  an agent needs the instruction to *offer* before it will act.
- **Edit `.gitignore` automatically on every render** (no opt-in). Rejected for the same
  reason 0.6.0 rejected auto-rewriting it — a consumer owns their `.gitignore`; silent edits
  violate the frozen-image spirit and the #25 no-clobber contract. The offer is opt-in only.
- **A dedicated `gitignore` subcommand.** Rejected — heavier than warranted; a flag on the
  commands that already run at setup time (`init`/`install`) fits the existing idiom.

**Rationale**: The two footguns are real and the fix is cheap, but consent must stay explicit.
An agent offer plus an explicit flag are two consent channels for the same append-only,
idempotent helper — neither writes `.gitignore` without being asked, so the original stance
holds, just refined.

**Impact**: New `--gitignore` flag on `init`/`render`/`install`; default behavior unchanged
(no flag → `.gitignore` untouched, same as before). New exports `ensureGitignoreEntries` /
`recommendedGitignoreEntries` / `GITIGNORE_MARKER` in `installer/lib/project.mjs`, wired
through `cli.mjs` (`offerGitignore`). Docs refined in `schema/SETUP.md` (step 6 + the legacy
rename note) and `README.md` (command table, rule 2, the 0.6.0 rename note) from "never edits
`.gitignore`" to "never edits it unasked." No migration; additive and minor.

---

## 2026-07-02: Rename the shipped doctor workflow `wafflestack-doctor.yml` → `waffle-doctor.yml` (#28)

**Context**: v0.6.0 shortened every consumer-facing dot-path to `.waffle.*` but
deliberately kept three `wafflestack`-named artifacts — the package/CLI name, the npx
specs, and the shipped `.github/workflows/wafflestack-doctor.yml` workflow (see the 0.6.0
decision below). The CLI/package name genuinely should stay, but the workflow filename is a
**consumer-visible rendered artifact** — the one remaining piece that lands in a consuming
repo still carrying the long prefix — so keeping it left the naming alignment half-done.

**Decision**: Rename the shipped workflow to `.github/workflows/waffle-doctor.yml` and align
its internal identity (`name: waffle-doctor`, `concurrency.group: waffle-doctor-…`) with the
filename, **reversing** the 0.6.0 choice to keep the old name. The `wafflestack`
package/CLI name and the `wafflestack doctor` command the workflow invokes stay — only the
rendered artifact moves, mirroring how 0.6.0 moved only the consumer's dotfiles. Ship **no
migration step**: lock-managed consumers get the rename automatically from the frozen-image
render contract (the prune deletes the old locked path and writes the new one), and the two
edge cases where an old copy lingers — an **ejected** workflow, or a **pre-lock / untracked**
render — are files the toolkit does not manage. A one-line manual cleanup (`git rm …
wafflestack-doctor.yml`) is documented in the changelog for those instead.

**Alternatives considered**:

- **Keep `wafflestack-doctor.yml`** (the 0.6.0 status quo). Rejected — it is the last
  consumer-visible artifact off the `.waffle` convention; finishing that alignment is the
  whole point of this change.
- **Add a `MIGRATIONS` entry that deletes the old file** (modeled on 0.6.0's
  `migrateLegacyDotfiles`). Rejected — that helper is safe only because it *renames*
  toolkit-owned files under an `exists(from) && !exists(to)` guard. A workflow cleanup would
  have to `rm` a path that, in the only cases where it survives a re-render, is
  **unmanaged**: an ejected copy the consumer now owns (and may have customized) or an
  untracked pre-lock render. Blindly deleting it would be data loss and directly contradict
  the just-adopted #25 "refuse to clobber unmanaged files" contract. There is also no stable
  byte signature to recognize "our old render" (it carried a `{{doctor.toolkitRef}}`
  substitution). For lock-managed repos a migration is redundant anyway — `upgrade`
  re-renders and the prune already handles it.

**Rationale**: The rename finishes the v0.6.0 ergonomics work on the one artifact that
reaches consumers. Leaning on the frozen-image prune instead of a migration keeps the common
path automatic while honoring #25 — the toolkit never deletes a file it does not own; it
documents the manual step for the consumer who does.

**Impact**: Breaking for consumers that pin the old filename or `name:` (e.g. a
branch-protection required check) — called out in the changelog and landing in a minor
release. Lock-managed repos re-render clean with no action. Ejected / pre-lock repos keep a
stale `wafflestack-doctor.yml` until they `git rm` it. Touches the shipped workflow, the
github-workflow `bundle.yaml` manifest + prose (including the `eject:` ref),
`schema/SETUP.md`, the payload test, and this repo's own `.gitignore`.

---

## 2026-07-02: Refuse to clobber pre-existing unmanaged files on render (#25)

**Context**: Every render output was written through `writeFileEnsuringDir` — an
unconditional `writeFileSync` with no existence check. Two collision classes were already
guarded: two enabled bundles emitting the same rel path fail loudly (`emit()`), and files
tracked in `.waffle.lock.json` are drift-checked by `doctor`. Neither protected a
**pre-existing, unmanaged** consumer file: a repo with a hand-written
`.claude/skills/issue/SKILL.md` running its first render with a bundle that produces that
same path had the file silently overwritten. Render targets are namespaced only by
kind-dir + item name, so such name collisions are entirely plausible.

**Decision**: Detect the untracked-collision case at the render chokepoint and **fail loud
by default**. A target path is an unmanaged collision when it (1) is in the new render
outputs, (2) exists on disk, and (3) is absent from the previous lock's `files` (so it is
the consumer's own file, not a prior render of ours). On detection, render returns
non-zero naming every offending path — in the style of the `emit()` conflict message — and
**writes nothing**: the check runs before any prune or write, so the tree is left
untouched. Two overrides: a **byte-identical** file (hash match) is **adopted silently**
(the write is a no-op and the new lock records it either way), and a `--force` flag on
`render`/`install` overwrites the differing file and takes it under management.

**Alternatives considered**:

- **Per-toolkit namespacing** of output paths (the alternative from the original report;
  see [gstack](https://github.com/garrytan/gstack) for prior art). Rejected as the primary
  fix: harnesses dictate the agent/skill layout (`.claude/skills/<name>/`), so a
  per-toolkit prefix cannot apply to agents or skills — it is viable only for `files/`
  payloads, leaving the most likely collisions (skills) unprotected. Fail-loud covers all
  three payload types uniformly.
- **Silent last-write-wins** (status quo). Rejected — it is exactly the data-loss bug.
- **An interactive prompt.** Rejected — the CLI is non-interactive and agent-driven; a
  flag plus a clear error fits the existing `doctor --allow-missing` / `emit()` idiom.

**Rationale**: A consumer's own file is theirs; overwriting it without consent is data
loss. Fail-loud + `--force` mirrors the existing conflict-handling style and is uniform
across agents, skills, and files. Silent adopt for identical content keeps the common
"already rendered, lost the lock" case frictionless.

**Impact**: A first render against a repo with a conflicting unmanaged file now exits
non-zero and leaves the file untouched; `--force` (on `render` or `install`) overwrites and
records it in the lock; a content-identical file is adopted with no flag. Managed-file
re-render (the frozen-image restore) is unchanged — locked paths are never treated as
collisions. `upgrade` re-renders without `--force`, so it inherits the same guard (safe by
default for the rare newly-colliding path). Lives in `renderProject`
(`installer/lib/render.mjs`); the flag is parsed in `installer/cli.mjs`.

---

## 2026-07-02: Shorten consumer dotfiles `.wafflestack.*` → `.waffle.*` (v0.6.0)

**Context**: Every consumer-facing dot-path carried the full project name —
`.wafflestack.yaml`, `.wafflestack.local.yaml`, `.wafflestack.lock.json`,
`.wafflestack/extensions/`. The shorter `.waffle` prefix is friendlier and quicker
to type, and just as unambiguous inside a consuming repo. Unlike the v0.2.0
rebrand, consuming projects now exist — so this is a genuine breaking change and
needs a migration, not just a constant swap.

**Decision**: Rename the four consumer dot-paths to `.waffle.*`. The `wafflestack`
package/CLI name, npx specs, and the `wafflestack-doctor.yml` workflow filename all
stay — only the consumer's own dotfiles move. Ship three compatibility layers so no
consumer breaks: (1) every read falls back to the legacy `.wafflestack.*` name with a
deprecation note when the `.waffle.*` name is absent; (2) a plain `render`/`upgrade`
renames the legacy config, local overlay, lock, and extensions dir in place (and
reminds the consumer to update their `.gitignore` — the CLI never edits it); (3) the
first real migration-registry entry, keyed to **0.6.0**, runs that same rename so
`wafflestack upgrade` applies it across the version bump.

**Alternatives considered**:

- Bare constant rename with no migration. Rejected — it would silently orphan every
  existing consumer's config on the next render.
- Have the CLI rewrite `.gitignore` automatically. Rejected — a consumer owns their
  `.gitignore`; we surface a reminder instead of editing it behind their back.

**Rationale**: The rename is cheap ergonomics; the compatibility story is what makes
it safe. Because the migration is version-keyed to 0.6.0, it fires exactly once, on a
real upgrade, while the read-fallback and render-time auto-rename protect repos in the
meantime.

**Impact**: Breaking for existing consumers, but automatic. First `render`/`upgrade`
after adopting ≥0.6.0 renames the dotfiles and prints a `.gitignore` reminder; the
legacy names keep working (with a deprecation note) until then. Shared rename lives in
`installer/lib/project.mjs` (`migrateLegacyDotfiles`), reused by `render` and the 0.6.0
migration step.

---

## 2026-07-02: Install (and depend on) individual skills and agents

**Context**: You could only enable whole bundles. Wanting a single skill — say
`skills/issue` — meant adopting its bundle's entire roster. And cross-bundle
dependencies (the `/delegate` skill needs the git-workflow and
github-project-management skills; the `/docs` skill needs both documentation
skills) lived in prose only, so a partial install could silently miss them.

**Decision**: Add per-item install. `wafflestack install <ref…>` now accepts:

- a **bundle** name — `github-workflow`
- a single **item** — `skills/issue`, `agents/project-manager`
- a **bundle-qualified item** — `code-quality/skills/security-audit` (needed only
  when a name exists in two bundles)

It resolves each ref, pulls in dependencies automatically (transitively, across
bundles), persists the choice — bundles into `bundles:`, items into a new
top-level `include:` list in `.waffle.yaml` — and then runs a full render.
Dependencies come from an agent's frontmatter `skills:` list plus a new optional
`requires:` map in `bundle.yaml`.

**Alternatives considered**:

- Keep bundle-only install (status quo).
- Have `install` render *only* the named item (a scoped render). Deferred — the
  first cut keeps it simple: `install` persists the choice, then re-renders the
  whole current selection. Scoped render can come later.
- Persist the resolved dependency list too. Rejected — the closure is recomputed
  every render, so it can never go stale; only your chosen refs are stored.

**Rationale**: Projects want à-la-carte pieces without swallowing a whole bundle,
and automatic dependency resolution means a partial install still works.
Recomputing the closure each render keeps `.waffle.yaml` small and honest.

**Impact**:

- New `include:` list in `.waffle.yaml`. Rendered set =
  `union(bundles:) ∪ closure(include:) − eject:`.
- `eject:` wins over `include:` and now self-cleans a matching entry, so no dead
  refs are left behind.
- Required config is scoped to the placeholders the selected items actually use —
  a one-item install no longer demands config only its unselected siblings need.
- New module `installer/lib/refs.mjs` (ref grammar + resolution + dependency
  closure); `validate` now checks agent-skill and `requires:` references.

---

## 2026-07-02: Lenient agent-skill deps, strict `requires:` deps

**Context**: Dependency resolution pulls skills from two sources with different
guarantees. An agent's frontmatter `skills:` list is a harness *grant-pointer*
that can name skills living outside this toolkit — for example the `designer`
agent lists `brand-guidelines`, which the toolkit does not ship. A bundle's
`requires:` map, by contrast, is authored by the toolkit and should always point
at a real item.

**Decision**: Resolve the two differently. Names in an agent's `skills:` list
resolve **leniently** — an unknown or ambiguous name is skipped, not an error.
Entries in `requires:` resolve **strictly** — a dangling or ambiguous ref fails
and is treated as a toolkit bug (caught by `validate`).

**Alternatives considered**: Treat both the same — either both strict (installing
`agents/designer` would then error on the external `brand-guidelines`) or both
lenient (a typo in a `requires:` entry would silently do nothing).

**Rationale**: The two lists mean different things. An agent's skill grants may
legitimately reference skills from outside the toolkit; an authored dependency is
a promise the toolkit must keep.

**Impact**: Installing `agents/designer` pulls its in-toolkit skills
(`git-workflow`, `issue`) and quietly skips `brand-guidelines`. A broken
`requires:` entry is a hard `validate` failure.

---

## 2026-07-01: Dogfood the docs-system and orchestration bundles

**Context**: The repo already rendered the `github-workflow` bundle into itself.
The documentation, project-manager, and task-planner agents (plus the
`/delegate`, `/audit`, and `/docs` skills) would also help develop the toolkit.

**Decision**: Enable `docs-system` and `orchestration` in `.waffle.yaml`
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
files — put additions in `.waffle.yaml` (config) or
`.waffle/extensions/` (appended content).
