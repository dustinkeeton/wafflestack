# Decisions

Why wafflestack is built the way it is — the choices that shaped the toolkit,
newest first. Each entry records the situation, what was decided, what else was
weighed, and what it affects.

For *what exists today* see [STATUS.md](STATUS.md); for *how it fits together*
see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 2026-07-07: Close the render-target asymmetry — every target renders both agents and skills (#94)

**Context**: The multi-harness story was only half true. `renderAgent` emitted for `claude`
and `codex` but had no `agents-dir` branch; `renderSkill` emitted for `claude` and
`agents-dir` but had no `codex` branch. So Codex got agents but no skills, the cross-tool
agents dir got skills but no agents, and only Claude got both. The README and setup output
presented all three as full harnesses — exactly the docs-vs-reality drift the toolkit exists
to prevent, and a consumer enabling `codex` or `agents-dir` silently lost half their bundle.

**Decision**: Implement the two missing cells (Option A — full coverage, not a scoped-back
claim). **Codex skills** render to the cross-tool `.agents/skills/<name>/` directory: OpenAI's
docs confirm Codex scans `.agents/skills` from the cwd up to the repo root, which is exactly
where the existing `harness.skillsDir` codex built-in already pointed — so no built-in changed,
and Codex shares the one skill render with `agents-dir`. `renderSkill` dedupes by output dir
(first target wins) so enabling both writes `.agents/skills` once, not twice. **agents-dir
agents** render to `.agents/agents/<name>.md` as harness-neutral Markdown — frontmatter
`name`/`description`/the neutral `skills:` grant-pointer plus body, dropping the Claude-only
`claude:` passthrough block. `eject` learned the new `.agents/agents/<n>.md` path.

**Alternatives considered**: (a) *Docs-only (Option B)* — annotate the limitation and scope the
README's claim honestly. Rejected: the whole point of a compiler is that its targets actually
compile; a permanently half-implemented second target is a worse answer than finishing it.
(b) *Give Codex its own `.codex/skills/` namespace* (symmetric per-target dirs). Rejected: Codex
does not read a `.codex/skills` dir — it reads `.agents/skills` — so a per-namespace render
would be output the harness never loads. Following the harness's real convention beats internal
tidiness. (c) *A `.agents/agents/` external standard* — none exists; the AGENTS.md ecosystem
standardizes `.agents/skills/` and `AGENTS.md`, not agent-persona files. `.agents/agents/` is
wafflestack's own symmetric choice, mirroring `.claude/agents` + `.claude/skills`.

**Impact**: `render.mjs` (`renderAgent` agents-dir branch, `renderSkill` codex branch + dir
dedup), `eject.mjs` (agent release paths), the installer test matrix (new per-target coverage
suite), and every coverage surface (README, ARCHITECTURE, FORMAT, AGENTS.md matrix). The
acceptance bar — no surface implies coverage the renderer doesn't deliver — is met by delivering
the coverage rather than trimming the claim.

## 2026-07-07: Declare, check, and inject dependencies — typed `prerequisites:`, a doctor gate, and harness injection on `harness.*` (#47)

**Context**: The shadcn-style install copies rendered files into the consuming repo — there
is no package-manager `postinstall` hook, so nothing installs or verifies the external things
a stack silently depends on. Those prerequisites are prose-only today and warn-at-best: the
github-workflow stack's `setup:` note tells an agent to check `gh auth status`, create the
trigger labels, set `ANTHROPIC_API_KEY`, and flip repo settings — but nothing *checks* any of
it, so a consumer discovers the gap when a label hook dispatches into a repo with no secret and
bills for a no-op. The one structured seam that exists — a stack's `env:` map, warned at
render (`checkEnvPrerequisites`, `render.mjs`) and printed in the setup inventory
(`setup.mjs`) — covers only harness env vars, not the CLI tools, secrets, auth scopes, labels,
or repo settings the stacks actually lean on. Separately, the rendered CI workflows hardcode
one harness — `anthropics/claude-code-action` pinned to a SHA in `waffle-label-hook.yml` and
`waffle-hygiene.yml` — with no seam to pin a different version or inject a different dispatcher
(raised by #46). This is the HMW: how might we *declare*, *check*, and *inject* the
dependencies wafflestack uses — including the harness itself as an injectable dependency of the
workflows it renders.

**Inventory (grounds the schema)**: Sweeping every stack surfaced these implicit
prerequisites, by kind — this is what a declarative block must be able to express:

- **CLI tools**: `node` >= 18 (renderer, all stacks); `git` (github-workflow, orchestration
  worktrees); `gh` + a live `gh auth status` (every github-workflow skill); `npx` (the
  `waffle-doctor.yml` CI job); `jq` (the rendered hooks' `Check harness result` step); the
  project toolchain behind `project.installCmd`/`lintCmd`/`typecheckCmd`/`testCmd`/`buildCmd`
  (npm by default).
- **Secrets**: `ANTHROPIC_API_KEY` (label-hook, hygiene); `WAFFLE_HYGIENE_TOKEN` (hygiene
  auto-merge, optional fallback).
- **gh auth scopes**: `project` (`gh auth refresh -s project`, the board skills); the
  `workflow` credential scope (pushing any `.github/workflows/*` file).
- **Trigger labels**: `waffle:enrich`/`waffle:implement` (label-hook), `waffle:release`
  (release-hook), and the `issue.typeLabels`/`issue.priorityLabels`/`issue.inferenceLabel`
  taxonomy (issue skill — applying a missing label fails `gh issue edit`).
- **Repo settings**: "Allow GitHub Actions to create and approve pull requests" (implement
  job); `allow_auto_merge` (hygiene); a required status check on the base branch (hygiene
  auto-merge); Actions workflow permissions not locked read-only (release-hook `contents:
  write`); branch protection on the default branch (all three write-scoped hooks); a GitHub
  remote (all github-workflow skills).
- **Services / external state**: a Projects v2 board matching `project.name` (optional —
  skipped with a warning); Anthropic API billing (a cost, not a check).
- **Harness env vars**: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (orchestration — already the
  one thing `env:` covers).

**Decision**: Adopt a three-part design, distinct from the internal-only `requires:` keyword
(which maps render-closure edges between waffles, not external prerequisites):

1. **A declarative `prerequisites:` block per stack** (`stack.yaml`), a typed list where each
   entry names a **kind** (`tool` | `secret` | `scope` | `label` | `setting` | `service`), the
   thing needed, a human `description`, a **`check`** (the deterministic probe — `command -v
   gh`, `gh auth status`, `gh label list`, `gh secret list`, a repo-settings API GET), and a
   **`level`** (`require` vs `recommend`). The existing `env:` map is subsumed as the `env`
   kind (kept read-compatible so no stack must migrate at once). Only *declared* prerequisites
   are surfaced — no magic inference — and, like `requires:`, the block is **scoped to the
   selected items**, so a partial install is asked only for the prerequisites its own waffles
   need.

2. **Three enforcement tiers over one declaration**, escalating from advisory to blocking:
   - **`render` warnings** — generalize the existing env-warning path so every declared
     prerequisite that can be cheaply probed emits a `warning:` (non-blocking, no effect on
     `doctor`), and the `setup` inventory lists the whole block per stack. This is the
     already-shipped, lowest-friction tier.
   - **`doctor` gate** — `doctor` runs each entry's `check` and **exits 1** on an unmet
     `require`-level prerequisite (a `recommend` entry only reports). This reuses doctor's
     existing "report + exit 1 in CI" contract, so a repo that runs the `waffle-doctor.yml`
     drift gate gets prerequisite verification on the same job — the structured upgrade from
     "the prose said to check" to "CI checks."
   - **The setup playbook is the postinstall-prompt analog** — `schema/SETUP.md` step 4 reads
     the structured block and puts the human questions (create these labels? set this secret?
     flip this repo setting?) the same way #74 made the both/one/neither syrup question
     required. Anything that creates or mutates shared external state still needs the user's
     explicit go-ahead.
   - **The CLI stays non-interactive** — no TTY postinstall prompt, consistent with #74:
     `render`/`doctor` warn and gate, the agent-driven playbook owns the human conversation.

3. **Harness injection layers on the reserved `harness.*` namespace** — a config key selects
   which dispatcher the workflow templates render. `harness.*` is already always-available and
   per-target, and already abstracts per-harness differences (attribution, skills dir), so it
   is the natural home. The first, minimal step parameterizes the hardcoded
   `uses: anthropics/claude-code-action@<sha>` and `anthropic_api_key:` lines behind
   `harness.actionRef` / `harness.actionVersion` / `harness.apiKeySecret` (defaults = today's
   pinned claude-code-action), so a consumer can pin a different version or repoint the action
   without ejecting the workflow. A *fully* swappable dispatcher (Codex or another harness,
   whose `with:` input shape differs from claude-code-action's) needs a per-harness dispatch
   snippet the template composes — a partials/include mechanism the render engine does not yet
   have — so that is explicitly deferred to a follow-up rather than forced into a single
   scalar.

**Recommended first increment**: ship **(1) the `prerequisites:` schema + (2a) the `doctor`
gate and render warnings**, seeded from the inventory above for the github-workflow and
orchestration stacks. Deterministic checks in CI are the highest-value, lowest-risk slice: they
turn the existing prose into a machine-checked gate on the drift job consumers already run,
reuse doctor's exit-1 contract, and need no new interactive surface. Harness injection ships as
a **separate track** (the pin/ref step first; the full dispatch-profile mechanism later).
Interactive TTY installers are **not** recommended and are not scheduled — the setup playbook
plus render/doctor already close the loop without forking CLI behavior by stdin shape.

**Alternatives considered**: *Overloading `requires:`* to also carry external prerequisites —
rejected: `requires:` resolves to installable item refs inside the toolkit and drives the
render closure; a `gh` binary or an `ANTHROPIC_API_KEY` secret is neither, and conflating them
would muddy both. *A TTY postinstall prompt in the CLI* (the literal shadcn/npm analog) —
rejected for the same reasons #74 rejected it: the CLI is deliberately headless (it runs in CI
and under an agent), a prompt would need a non-TTY fallback anyway, and it would duplicate the
playbook contract that already owns the human conversation. *Auto-installing/creating
prerequisites* (running `gh label create`, `gh secret set` for the user) — rejected outright:
these mutate shared external state and often cost money (arming a paid hook), the exact thing
the opt-in gate and the "explicit go-ahead" rule exist to prevent; the toolkit checks and
prompts, it never provisions unasked. *A single `harness.action` scalar* capturing the whole
dispatcher — rejected as insufficient: different harnesses have different `with:` inputs, so a
scalar can pin a version but cannot swap the dispatcher; the honest first step is the ref/version
pin, with the profile mechanism called out as deferred. *Magic inference of prerequisites from
skill content* — rejected: brittle and implicit; declaration keeps the surface auditable, the
same principle as only substituting declared config keys.

**Relationship to #88 / #126**: External-stack support (#88 slice 1, #123) lets `stacks:`
entries pull a third-party stack from a pinned git `source`; #126 adds install-time `validate`
+ an extra syrup-tier confirmation for those external stacks. This design is **adjacent, not
overlapping**: #126 governs the *trust boundary* of external stack *content*; `prerequisites:`
governs the *environment* a stack (built-in or external) needs. They compose — an external
stack ships its own `prerequisites:` block, checked by the same doctor gate — and neither
subsumes the other.

**Impact**: Design-only — no code, config, or migration ships in this entry; it records the
decision and splits the work. Follow-up implementation issues filed on GitHub: **#129** — the
`prerequisites:` schema + doctor gate + render warnings (the first increment); **#130** — the
setup-inventory / SETUP.md surfacing of the block (the postinstall-prompt analog); **#131** —
the `harness.*` injection key + parameterized workflow templates. Interactive TTY installers
are recorded here as deliberately deferred (no issue — the rejected alternative). When the first
increment lands, `env:` becomes one kind under `prerequisites:` (read-compatibly), and a repo's
existing `waffle-doctor.yml` job starts verifying prerequisites with no workflow edit.

---

## 2026-07-06: Layer-1 evals — deterministic content assertions on the rendered prompts (#89/#108)

**Context**: The test suite proved the render *machinery* (bytes in → bytes out) but nothing
asserted the **behavior** baked into the rendered prompts. A refactor or a hygiene rewording
pass could silently drop a load-bearing guardrail — the label-hook's constant-token rule, the
delegate confirmation gate — and every test would stay green.

**Decision**: Add `installer/test/content.test.mjs`, a first eval layer of **deterministic
key-phrase assertions** run by plain `npm test`. Assertions pin *meaning*, not bytes: rewording
a prompt passes, but removing a guardrail fails CI. They run against the **committed
`.claude/skills/**` render** (the artifact consumers actually get); the one gitignored piece
(the label-hook workflow) is rendered fresh into a temp project through the real render
pipeline and asserted there. Coverage: label-hook's constant action-token and
untrusted-input/no-fan-out refusals, delegate's confirmation/checkpoint/approval gates, the
issue and release templates and tag-safety guardrails, frontmatter presence everywhere, and
no leftover unsubstituted placeholders.

**Alternatives considered**: Byte-exact snapshot tests — rejected: they fail on every harmless
rewording, so they train people to regenerate them blindly, which defeats the guard. Starting
with LLM-judged evals — deferred: non-deterministic and paid, the wrong first layer for a CI
gate (tracked as sub-issues of #89 as the future layer 2). Asserting on the *source* files
instead of the render — rejected: it would miss substitution and render bugs.

**Rationale**: The highest-risk artifacts are the rendered prompts themselves, and the cheapest
useful protection is a deterministic phrase check on exactly what ships. Testing the committed
render also means the assertions and the doctor drift gate protect the same artifact.

**Impact**: Suite grows to 241 tests / 43 suites. Dev-only — no consumer-facing change, no
config, no migration. Removing or gutting a pinned guardrail in any stack now fails CI.

---

## 2026-07-06: Curated, hard-capped run memory — never an append-only log (#93/#107)

**Context**: A `/delegate` run had no durable memory between runs. Lessons — repo quirks,
recurring failures, issue entanglements — evaporated with the orchestrator's context window,
so successive runs repeated the same mistakes.

**Decision**: ONE curated Markdown memory doc per repo, **hard-capped** (default 4096 bytes)
and format-gated by a shipped, dependency-free validator (`memory.mjs`, beside the delegate
`SKILL.md`). Every entry must carry a **Why** (why it's forward-useful), a **Since** (the
issue/PR that taught it — its staleness anchor), and an **Area** (a module tag). The Report
phase *distils* lessons in — pruning stale entries and rewriting, never blind-appending;
Classify and Plan read the doc back, and each spawned agent receives only the entries whose
Area matches its issue. Over the cap or a malformed entry → exit 1 and the run is blocked
until curation brings it back within budget; the validator **never silently truncates**. A
missing doc is valid (a fresh repo has no memory yet). Config: `delegate.memoryFile` (default
`{{delegate.checkpointDir}}/memory.md`) and `delegate.memoryMaxBytes` (default 4096).

**Alternatives considered**: An append-only log — rejected outright: it bloats until it
poisons the context it was meant to help. Auto-truncation (FIFO) at the cap — rejected:
pruning should be *judged* (that's what Why/Since anchor), and silent truncation hides the
loss. Committing the memory to the repo — not the default: it lives under the gitignored
worktrees dir, accepting the documented trade-off that memory is per-clone and doesn't follow
the repo to another machine.

**Rationale**: Same pattern the typed checkpoints established — an LLM curates, a
deterministic script enforces. The cap forces the doc to stay a compact working set; the
required fields make every entry auditable and pruneable on evidence rather than age.

**Impact**: Adds `memory.mjs` to the delegate skill's shipped files and two optional config
keys. Additive, default paths inherit the worktrees gitignore, no migration; repos that never
run `/delegate` are unaffected.

---

## 2026-07-06: Opt-in human approval gate before push (#92/#106)

**Context**: Delegated agents pushed branches and opened PRs autonomously. Some projects want
a human look *before* anything leaves the machine, and there was no seam between "agent
committed locally" and "branch is public" to put one.

**Decision**: One optional flag — `delegate.approveBeforePush`, **default false**. When on,
each delegated agent runs its pre-flight, commits **locally**, and STOPS before `git push` /
`gh pr create`. The orchestrator assembles a compact per-agent summary (branch, target issue,
diffstat, commit list), collects the human's decision via AskUserQuestion (Approve / Approve
all / Reject), and only an explicit approval releases the push and opens the PR. A rejection
leaves the worktree and local branch intact for inspection and is recorded in the typed
checkpoint (`approval`/`approvedBy` per execution entry; the validator enforces that a
rejected push is `status: skipped` with no PR — a rejection can never masquerade as delivered).

**Alternatives considered**: An always-on gate — rejected: it would slow every existing
autonomous flow; default-off leaves behavior unchanged for everyone who doesn't ask. A TTY
prompt in the CLI — rejected: the CLI is deliberately non-interactive; the harness's question
tool is the interactive layer. Reviewing after push (draft PRs) — rejected: the branch has
already left the machine, which is exactly what the gate exists to prevent.

**Rationale**: The gate slots into the checkpoint contract rather than beside it — the
approval decision is typed run state, so the run report and the validator both see it, and a
skipped push is auditable, not just remembered.

**Impact**: New optional config key; checkpoint schema + validator gain approval fields; the
Report phase gains an "Approved by" column when active. Additive, default-off, no migration.

---

## 2026-07-06: Typed checkpoints — a schema-validated gate at every delegate phase boundary (#91/#105)

**Context**: A `/delegate` run's state — which issues, which branch, which worktree — lived
only as prose in the orchestrator's context. Long runs drifted: a dropped field or a
hallucinated branch name surfaced downstream as a confusing agent failure instead of being
caught at the seam where it appeared.

**Decision**: Each run writes ONE JSON checkpoint, validated at **every phase boundary**
(Fetch → Classify → Plan → Execute → Report) by a shipped, dependency-free validator. Two
files ship beside the delegate `SKILL.md`: `checkpoint.schema.json` (the documented contract)
and `checkpoint.mjs` (`node checkpoint.mjs --file F --phase <phase>`). Each phase appends its
section, and load-bearing fields (issue number, branch, worktree path) are *read from the
checkpoint* as the single source of truth, never re-derived from prose. The validator also
cross-checks references: every classified/assigned/executed issue traces back to a fetched
one, worktree presence matches the group's parallel/serial mode, and an executed branch must
equal the branch the plan assigned — catching a hallucinated branch. **Exit 1 = hard STOP**:
the run halts and reports (the checkpoint doubles as the resume point) instead of improvising.
Config: `delegate.checkpointDir`, default `{{git.worktreesDir}}/.delegate` — a default that is
itself a placeholder, exercising the template engine's depth-4 nested expansion.

**Alternatives considered**: Keeping prose state — that *is* the failure mode being fixed.
LLM self-verification ("re-read your plan before executing") — rejected: non-deterministic,
and a model can't reliably catch its own hallucination; the gate must be a script. A
schema-library validator (e.g. ajv) — rejected: the script runs inside consuming repos that
may have no npm deps installed, so it's Node built-ins only, reading the co-located schema.

**Rationale**: Determinism at the boundaries, judgment in between. The phases stay agentic;
the hand-offs become machine-checked, so drift fails loudly at the boundary where it happened.

**Impact**: The delegate skill now ships supporting files that render into consuming repos
alongside `SKILL.md`. One new optional config key; checkpoint files are throwaway run state
under the gitignored worktrees dir. Additive, no migration. #106 (approval) and #107 (memory)
both build on this contract.

---

## 2026-07-06: Overview one-pagers become self-contained branded HTML, not SVG (#75/#104)

**Context**: `render` emitted `.waffle/cheatsheet.svg` and `.waffle/team.svg` — pictures of
text. Not selectable, not searchable, fixed layout, and awkward font handling for what is
fundamentally a text document.

**Decision**: Replace them with `.waffle/cheatsheet.html` + `.waffle/team.html` — each a valid
standalone HTML5 page: semantic lists built from the same skill/agent frontmatter, the waffle
glyph inlined as SVG, the brand palette (dark by default, warm-paper light via
`prefers-color-scheme`), and a **hybrid font strategy** — Google Fonts links for the brand
type as progressive enhancement, backed by a brand-styled system-font stack, with those font
links the pages' only external reference (they still render correctly offline). Emitted
through the same `generateWaffleDocs` → `emit()` path, so they stay lock-tracked,
doctor-checked, and pruned. The Markdown cheat sheet / team docs are unchanged and remain the
source of truth.

**Alternatives considered**: Keeping the SVGs — rejected: the images-of-text problems were the
whole motivation. Fully inlining the webfonts for zero external references — not taken: the
hybrid strategy keeps the generated pages small while degrading gracefully offline.

**Rationale**: The one-pagers exist to be read and searched; HTML is the right medium for
text. Routing them through `emit()` keeps them under the same frozen-image contract as every
other managed file.

**Impact**: The retired `.svg` paths are pruned automatically on the next render (they were
previously-managed paths the render no longer produces). Consumers who gitignored the old
`.svg` names swap them for `.html`. No config key changes, no migration.

---

## 2026-07-06: A self-referential `wafflestack` stack — one `/waffle-*` skill per CLI command (#70/#103)

**Context**: Inside a consuming repo, the toolkit's own lifecycle commands (`init`, `setup`,
`install`, `render`, `upgrade`, `doctor`, `eject`, `validate`) had to be remembered and typed
as `npx github:dustinkeeton/wafflestack …`. A toolkit whose whole product is installable
skills shipped no skills for operating *itself*.

**Decision**: Ship a ninth stack, `wafflestack`: eight user-invocable `/waffle-*` skills, one
per CLI subcommand. Each is deliberately a **thin wrapper** — it shells out to
`npx <waffle.toolkitRef> <subcommand>` and adds agent judgment around the output (e.g.
`/waffle-upgrade` reviews the render diff; `/waffle-eject` confirms before releasing a file).
One optional config key, `waffle.toolkitRef` (default `github:dustinkeeton/wafflestack`) — pin
it to a release tag to freeze the version the wrappers run, or point it at a local checkout
while developing the toolkit. The stack is **not** enabled in this repo's own render.

**Alternatives considered**: Reimplementing command logic in skill prose — rejected: the CLI
is the single implementation, and fat skills would drift from it. Leaving the commands to
docs alone (`schema/SETUP.md`) — that covers first install, but leaves day-2 lifecycle
operations without an in-harness entry point.

**Rationale**: The CLI stays authoritative; the skills add exactly what a CLI can't — judgment
and conversation. And the toolkit now dogfoods its own delivery mechanism: its lifecycle ships
the same way everything else it makes does.

**Impact**: Stack count 8 → 9, skill count 21 → 29. Purely additive — no agents, no
migration, and no effect on repos that don't enable it.

---

## 2026-07-06: Surface skipped syrup companions — warn, don't prompt (#74)

**Context**: Opt-in syrup pairs with a companion waffle through a `requires:` edge — the
github-workflow stack's `release` skill with the `waffle-release-hook.yml` tag-on-merge
workflow, `hygiene` with `waffle-hygiene.yml`, `label-hook` with `waffle-label-hook.yml`. The
render only ever walked that edge forward (installing the *syrup* pulls the *skill*), so
enabling a stack — or including just the skill — rendered the manual half of a flow and
silently gated out the automated half. A consumer ended up with a release flow whose
tag-on-merge hook was never rendered and never mentioned (#76). The only "ask first" surface
was advisory playbook prose aimed at AI agents; a bare `wafflestack install <stack>` with no
agent in the loop surfaced nothing.

**Decision**: Walk the companion edge in reverse (`skippedSyrupCompanions`, `refs.mjs`). When a
render/install selection includes a waffle whose opt-in syrup companion is gated out,
`render`/`install` emits a `warning:` naming the skipped syrup and the exact
`wafflestack install files/<path>` command to pour it; `setup` update-mode flags the same
pairing. The `schema/SETUP.md` playbook is promoted from advisory ("consider asking") to a
**required** both/one/neither question the agent must put to the user before finishing
setup/install. The CLI stays **warn-only** — it does **not** grow a TTY prompt.

**Alternatives considered**: An interactive TTY prompt when stdin is a TTY — rejected. The CLI
is deliberately non-interactive (every command runs headless in CI, and the whole install is
agent-driven through the setup playbook); a prompt would fork behavior by stdin shape, need a
non-TTY fallback anyway, and duplicate the playbook contract that already owns the human
conversation. Auto-installing the companion syrup — rejected outright: it would silently arm a
sensitive, write-scoped workflow, the exact thing the opt-in gate exists to prevent. Staying
advisory-only — rejected: it left the non-agent path (`install <stack>`) with no signal at all.

**Rationale**: The warning is the machine-readable stand-in for the playbook's human question,
so both the agent path (SETUP.md) and the bare-CLI path (stderr warning) surface the choice
without either arming syrup on its own. Warnings don't fail a render, don't affect `doctor`, and
fire only when a companion is actually selected but its syrup is neither included nor
lock-tracked — so an existing install (syrup already tracked) and an unrelated stack stay quiet.

**Impact**: Consumers enabling a stack with paired opt-in syrup now get a copy-paste pour
command instead of a silent gap. No config, lock, or render-output change — the reverse-edge
walk only adds warnings and a setup annotation, so `doctor` is unaffected and no migration
ships.

---

## 2026-07-06: Rebrand — waffles, stacks, and syrup (#59)

**Context**: The toolkit's vocabulary had drifted from its own name. Installable items were
"items", their named groups were "bundles", the generic `files/` payload was just "files",
and the opt-in gate key was `syrup:`. The name "wafflestack" implies a food metaphor the
terms never carried, and "bundle" collides with the ubiquitous JS/build sense (a webpack
bundle, `bundle install`), muddying every doc, help string, and error message.

**Decision**: Adopt a consistent food taxonomy. An individual installable item — an agent or
a skill — is a **waffle** (user-facing vocabulary only; no directory or key renames). A named
group of waffles is a **stack** (formerly "bundle"): the source dir becomes `stacks/`, the
manifest `stack.yaml`, and the key `stacks:` in `toolkit.yaml`, the consumer
`.waffle/waffle.yaml`, the lock field, and internal identifiers. The generic `files/` payload
is **syrup** (prose only — the `files:` manifest key and the `files/` ref prefix are
unchanged); sensitive syrup gated behind explicit opt-in is **opt-in syrup**, and the manifest
gate key `syrup:` becomes **`optIn:`**. Load-bearing surfaces stay put: the item-ref prefixes
(`skills/`, `agents/`, `files/`), the `agents/`/`skills/` dirs inside each stack, `.waffle/`
dotfile names, and the package/CLI name `wafflestack`.

**Alternatives considered**: Renaming the item-ref prefixes and harness dirs too (e.g.
`waffles/`) — rejected as churny and compatibility-breaking for lock keys and consumer
`include:`/`eject:` lists, with no vocabulary gain. Keeping `bundle` — rejected: the JS/build
collision and the missed metaphor were the whole motivation. A silent read-through of a stale
`syrup:` manifest key — rejected: a silently-ignored gate key would un-gate sensitive
workflows, so `loadStack` throws on it instead.

**Rationale**: The rename breaks exactly one consumer surface — the `bundles:` key in
`.waffle/waffle.yaml` — so it ships a 0.10.0 migration (`bundles:` → `stacks:`,
comment-preserving, across the config and its `.local` overlay) plus a read-fallback: a plain
`render` still works off a legacy `bundles:` key, emitting a deprecation warning that points
at `wafflestack upgrade`. Everything else the consumer touches — item refs, `include:` /
`eject:` entries, lock file paths — is unchanged, so the blast radius is a single key. The
lock's `bundles` field → `stacks` is write-only and self-heals on the next render (no migration
needed).

**Impact**: Toolkit authors rename `bundle.yaml` → `stack.yaml`, the `bundles:` registry key →
`stacks:`, and the `syrup:` gate key → `optIn:`; a stale `syrup:` now fails `loadStack` loudly.
Consumers already on `stacks:` are unaffected; consumers still on `bundles:` get a warning and
a one-command migration. `schema/FORMAT.md`, `schema/SETUP.md`, and the generated setup
inventory adopt the new vocabulary. The package/CLI name, item-ref grammar, and `.waffle/`
layout are untouched.

---

## 2026-07-03: Commit the self-render and arm the hygiene/doctor automation loop

**Context**: Activating the dogfooded hygiene hook (#46) required its CI-dispatched
harness to read the committed `.claude/skills/` — but this repo gitignored its whole
render (2026-07-01 decision below). Auto-merge on the daily hygiene PR also could not
arm: the repo had no CI at all, so no required status check existed to wait on.

**Decision**: Partially reverse the 2026-07-01 decision. Commit the rendered
`.claude/` output, `.waffle/waffle.lock.json`, and the `waffle-doctor` CI workflow
(running with `--allow-missing`); keep the label-hook workflow and the generated
`.waffle/` overview docs untracked. Protect `main` with the `doctor` job as a
required status check. With the `ANTHROPIC_API_KEY` + `WAFFLE_HYGIENE_TOKEN` secrets
set and auto-merge enabled, the daily hygiene PR merges itself once doctor passes.

**Alternatives considered**: Committing only the skills/agents without the CI gate —
hygiene PRs would open but auto-merge could never arm, leaving a manual merge every
day. A plain `npm test` workflow as the required check — doctor is the bundle-shipped
gate and additionally protects the now-committed generated files from hand-edits.

**Rationale**: The 2026-07-01 rationale ("a committed copy invites edits to generated
files") inverts once the lock is committed: the doctor gate *enforces* that generated
files match the render, which gitignoring never could. Search pollution from the
committed copies is the accepted cost of a live automation loop.

**Impact**: Contributors must commit the re-rendered output + lock with any
`bundles/**` change, or the required check fails their PR. The hygiene schedule
spends API budget daily. `main` gains its first branch protection (required `doctor`
check; admin bypass stays available).

---

## 2026-07-03: "Syrup" — an opt-in tier for sensitive bundle items (#51)

**Context**: The `github-workflow` bundle grew several `files/` workflow payloads —
the label hook, the daily hygiene run, and the release hook — that hold repo write
permissions and/or spend Anthropic API budget on every trigger. The render model
was all-or-nothing: enabling a bundle rendered *every* item it declared. That meant
turning on `github-workflow` for its issue/git skills would also drop a
live, permission-holding workflow into a consumer's repo with no explicit consent.

**Decision**: Add a `syrup:` list to `bundle.yaml` that names the `files/` items
which must be poured only on request. Enabling a bundle no longer renders its syrup
items. Each renders only when (a) the consumer installs the ref explicitly
(`install files/<path>`, persisted to `include:`), or (b) the repo already tracks
that path in its lock — so an existing install keeps updating, but a fresh enable
never silently arms it. `validate` rejects a `syrup:` entry that doesn't resolve to
a real item, and `setup` lists syrup items under a separate "do not install by
default" acknowledgement.

**Alternatives considered**:

- **Leave the workflows out of the bundle entirely** (ship them as copy-paste
  snippets). Rejected — they benefit from the same render pipeline (placeholder
  substitution, lock tracking, drift checking, `requires:` closure) as any other
  item; excluding them would forfeit all of that.
- **A separate "dangerous" bundle.** Rejected — the hooks are git/GitHub-native and
  reuse the same `issue`/`git-workflow` skills; splitting them off would duplicate
  the gh-auth/setup surface for no gain.
- **Render them but disabled/commented.** Rejected — a rendered-but-inert workflow
  still lands a file the consumer didn't ask for and invites accidental enabling.

**Rationale**: Sensitive automation should be an explicit, deliberate act, not a
side effect of wanting a bundle's ordinary skills. Gating on "installed the ref, or
already tracks it in the lock" keeps upgrades frictionless for adopters while making
first-time arming a conscious choice.

**Impact**: The `waffle-label-hook.yml` workflow became opt-in — a repo that enabled
`github-workflow` but never committed the file simply stops rendering it. Adopters
install the ref (or already track it) and are unaffected. Threaded through
`loadBundle()`, `computeSelection()`/`renderProject()` (via the prior lock's tracked
files), `validate`, and `setup`; documented in `schema/FORMAT.md` and `schema/SETUP.md`.
Additive and minor — no migration.

---

## 2026-07-02: Ship the label-event hook as a github-workflow prefab (workflow + skill) (#27)

**Context**: Consumers want a GitHub label applied to an issue to immediately trigger an
automated harness action — the concrete driver is obsidian-synapse#379, which wants an
`on: labeled` workflow that dispatches the Claude harness with the issue context. Every
consumer had to hand-roll that workflow *and* all of its security gating. WaffleStack shipped
nothing label-reactive: the only prefab workflow was the doctor CI, and "labels" appeared only
as issue taxonomy in the `issue` skill.

**Decision**: Extend `github-workflow` with one `files/` payload
(`.github/workflows/waffle-label-hook.yml`), one skill (`label-hook`), three `labelHook.*`
config keys, and a `requires:` block. Two label→action mappings ship in v1 — **enrich** and
**implement** — as separate GHA jobs with per-job least-privilege permissions. Trigger is
`issues: [labeled]` only. The dispatched harness receives a **constant action token + numeric
issue id**; the raw label string never reaches a shell, a prompt, or an env var — the label
appears only in each job's exact-match `if:` gate. The action is SHA-pinned
(`anthropics/claude-code-action@6c0083bb… # v1.0.162`). Because the action's *agent mode*
(direct `prompt:`) does **not** expand slash commands — that path is reserved for @mention/tag
mode's multi-block SDK message — the dispatch prompt names the skill in natural language
(`Execute the label-hook skill …: action "enrich", issue #N`) rather than `/label-hook …`,
preserving the constant-token contract without depending on slash expansion.

An adversarial review then flagged a second plane: the trigger-label and `claudeArgs` config
values are spliced into structured contexts (the workflow `if:` gate and a double-quoted YAML
scalar), where a quote, newline, or `${{ }}` in the value could break YAML, inject a sibling
`with:` key, subvert the allowlist gate, or exfiltrate a secret via GHA expansion — all with
no render-time error. Fix chosen: a general, opt-in **render-time `pattern:`** on config keys
(the resolved value must fully match, enforced at every substitution site), applied to the
three `labelHook.*` keys. Validation, not escaping: textual substitution can't know its target
context (YAML scalar vs. `if:` expression vs. shell word), so context-correct escaping is
impossible in general — a pattern instead makes a bad value fail the render loudly rather than
silently corrupt the gate. As defense in depth the core prompt-injection guardrails are also
inlined into the dispatch prompt (a floor even if a consumer forgets to commit the skill).

**Alternatives considered**:

- **A standalone/sibling bundle.** Rejected — the hook is git/GitHub-native and reuses the
  `issue` + `git-workflow` skills; a sibling bundle would duplicate the gh-auth/setup surface.
  Extending github-workflow keeps those deps one `requires:` edge away.
- **Default `labelHook.enrichLabel` to `issue.inferenceLabel`** (couple the hook to the
  lifecycle label). Rejected as the default — applying the enrich label spends API budget
  immediately, while the lifecycle label merely queues; silently coupling them would make
  tagging an issue "Needs Inference" cost money. Documented as an opt-in (set both equal).
- **`pull_request: [labeled]` in v1.** Deferred — labeled fork PRs raise the
  fork-code-with-secrets question, and the primitive that would carry it (`pull_request_target`)
  is banned by our security posture. `issues: [labeled]` runs the default-branch workflow with
  no fork-code risk; PR support can arrive later, explicitly scoped.
- **A collaborator-permission API gate** (verify the sender's write/triage before dispatch).
  Rejected as redundant — GitHub already restricts label application to users with triage+
  permission, and the `sender.type != 'Bot'` check adds loop defense on top; an API round-trip
  would re-check what the label ACL already enforced.
- **A configurable action ref/version config key.** Rejected — the SHA pin *is* the security
  posture; a version knob invites drift to an unvetted ref. Bumps go through a reviewed toolkit
  update or `eject`, like any other pinned action.
- **A dedicated agent payload.** Deferred — the skill delegates to existing skills; a bespoke
  agent adds a roster surface without new v1 capability.

**Rationale**: A vetted, bolt-on primitive beats every consumer reinventing the workflow and
its gating. The parts that are easy to get wrong by hand — label allowlist, human-sender check,
per-job least privilege, SHA pins, audit comment, no event-controlled string in shell/prompt,
and prompt-injection guardrails in the skill — are exactly the parts that belong in the shipped
artifact.

**Impact**: The toolkit's **first `requires:` entry keyed by a `files/` payload** — a per-item
install of just the workflow (`include: [files/.github/workflows/waffle-label-hook.yml]`) pulls
the `label-hook` → `issue` + `git-workflow` skill closure. Introduces a new consumer-prerequisite
class: a **repo secret** (`ANTHROPIC_API_KEY`); the hook is inert until the trigger labels and
the secret exist, and **each dispatch spends real API budget**. Adds three optional `labelHook.*`
keys and the `label-hook` skill (17th skill), with per-job permissions the workflow documents
(`issues: write` on both jobs; `contents: write` + `pull-requests: write` on implement). Touches
the github-workflow `bundle.yaml`, the new workflow + skill, the payload tests, and this repo's
`.gitignore` (self-render stays gitignored). The security hardening also adds a general,
reusable capability — optional `pattern:` value validation on any bundle config key (threaded
through `template.mjs`/`render.mjs`, linted by `validate.mjs`, documented in `schema/FORMAT.md`)
— which any future bundle can adopt for values that reach a structured context. Additive and
minor — no migration.

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
