# Skills vs. workflows — settling an overloaded word

wafflestack says "workflow" to mean three unrelated things. Two of them belong to somebody
else. This document settles which one keeps the word, classifies every skill in the toolkit
against the distinction, and takes a position on adopting Claude Code's real `Workflow`
primitive.

> [!NOTE]
> **This is a spike write-up** ([#184](https://github.com/dustinkeeton/wafflestack/issues/184),
> under epic [#347](https://github.com/dustinkeeton/wafflestack/issues/347)). It records a
> decision and files follow-ups; it ships no production code. The short version of the decision
> is in [DECISIONS.md](../DECISIONS.md); the reasoning is here.

**The headline, up front:** the motivating bug — `/audit` overlapping `/docs` — **is not a
workflow problem at all.** It is a composition problem, it is fixable today with no new
primitive, and adopting workflows would not have fixed it. See [§4](#4-the-collisions).

---

## 1. The problem: one word, three owners

| Sense | Where it lives | Who owns the word | Can we rename it? |
|---|---|---|---|
| **GitHub Actions workflow** | `.github/workflows/*.yml` — **7 rendered in this repo** (6 toolkit syrup + `tests.yml`, which is the repo's own and not toolkit-managed). The source dir `stacks/github-workflow/files/.github/workflows/` holds **8**; `waffle-evals.yml` and `waffle-label-hook.yml` are not selected here. Plus the `github-workflow` stack and the `git-workflow` skill. | GitHub | **No.** GitHub mandates the path. The stack and skill names are consumer surfaces — lock keys, `include:`/`eject:` refs, `.waffle/waffle.yaml` entries. |
| **Claude workflow** | `.claude/workflows/*.js` — a real, first-class primitive. **Unused by wafflestack today** (no `.claude/workflows/` exists in this repo). | Anthropic | **No.** It is the vendor's word for a vendor's feature. |
| **"any deterministic multi-phase process"** | Prose only — `SKILL.md` bodies, `stack.yaml` descriptions, `DECISIONS.md`, `ARCHITECTURE.md`, `STATUS.md`, `AGENTS.md`. | **wafflestack** | **Yes — and it is the only one we own.** |

That table settles the question before any argument starts. Two of the three senses are
un-renameable — one by GitHub's filesystem contract, one by a vendor's product vocabulary. The
generic sense is the only lever we have, so it is the one that must yield.

This is not a preference. It is the only move on the board.

---

## 2. What a Claude workflow actually is

Verified against the live docs ([code.claude.com/docs/en/workflows](https://code.claude.com/docs/en/workflows),
re-checked 2026-07-13 — a different page from `/docs/en/common-workflows`, which is a prose
how-to guide and *not* about this primitive).

> **A dynamic workflow is a JavaScript script that orchestrates subagents at scale. Claude
> writes the script for the task you describe, and a runtime executes it in the background
> while your session stays responsive.**

The docs compare four primitives. One row is the entire taxonomy:

| | Subagents | **Skills** | Agent teams | **Workflows** |
|---|---|---|---|---|
| What it is | A worker Claude spawns | **Instructions Claude follows** | A lead agent supervising peer sessions | **A script the runtime executes** |
| **Who decides what runs next** | Claude, turn by turn | **Claude, following the prompt** | The lead agent, turn by turn | **The script** |
| Where results live | Claude's context | Claude's context | A shared task list | Script variables |
| Scale | A few per turn | Same as subagents | A handful of peers | Dozens to hundreds per run |

**"Who decides what runs next" *is* the skill/workflow line.** A skill is instructions an agent
*interprets*; a workflow is code a runtime *executes*. Everything else follows from that.

Worth noticing: **there are four primitives here, not two.** wafflestack's orchestrators are
written as *skills* but reach for the **agent teams** row — a lead agent, a shared task list,
peer sessions. `/audit` literally calls `TeamCreate` and builds a task DAG. That mismatch is
[§5](#5-why-prose-orchestration-rots).

### The mechanics

- **File:** `.claude/workflows/*.js` (project, shared via git) or `~/.claude/workflows/*.js`
  (personal). Each file becomes a `/<name>` command.
- **Body:** plain JavaScript with top-level `await`, opening with a literal
  `export const meta = { name, description }`.
- **Execution model — and it is not a plain ES module.** This is easy to get wrong and the rest of
  this document depends on it. `meta` **must be a pure literal** (no variables, calls, spreads, or
  interpolation), which is what lets the runtime **extract it statically, before evaluating
  anything**. The remaining body then **runs in an async context** — which is why top-level `await`
  works. The consequence worth stating out loud: **top-level `return` is legal too**, and the
  vendor's own documented scripts use it (their canonical example opens with `export const meta` and
  ends `return { confirmed }`). So a workflow body is *"module header + async function body"*, not a
  module. **`node --check` on a workflow script will reject it** — `SyntaxError: Illegal return
  statement` — and that is the checker being wrong about the file's kind, not the file being wrong.
  See the note in [§9](#9-illustrative-sketch-audit-as-a-workflow), which is exactly where this bites.
- **Input:** a saved workflow reads invocation arguments from a global named `args`.
- **Gates:** Claude Code **v2.1.154+**; **paid plans only** (Pro requires a `/config` toggle);
  also available on the Anthropic API, Bedrock, Google Cloud's Agent Platform, and Microsoft
  Foundry. Kill switches: `disableWorkflows: true` or `CLAUDE_CODE_DISABLE_WORKFLOWS=1`, settable
  org-wide.
- **Limits:** up to **16 concurrent agents**, **1,000 agents total per run**.

### Three properties that decide the recommendation

**① A workflow cannot stop to ask a human anything.** From the docs' own constraints table:

> **No mid-run user input** — Only agent permission prompts can pause a run. **For sign-off
> between stages, run each stage as its own workflow.**

This one line is load-bearing, and it lands directly on the skill the issue proposed converting.
See [§8](#8-position-on-adoption-not-yet-and-here-is-the-trigger-list).

**② The in-script API *is* specified — in the tool entry, not the narrative page.** The docs page
names and demonstrates exactly two functions:

> The body is plain JavaScript with top-level `await`. **`agent()` spawns one subagent and
> `pipeline()` runs one per item in a list.**

For anything beyond that it defers to the tool reference *"for the full set of options"* — and
**that reference does specify the rest.** The `Workflow` tool's own entry carries a section headed
literally **`Script body hooks:`**, with signatures:

```
agent(prompt, opts?: { label?, phase?, schema?, model?, effort?, isolation?, agentType? }): Promise<any>
pipeline(items, stage1, stage2, ...): Promise<any[]>
parallel(thunks: Array<() => Promise<any>>): Promise<any[]>   // barrier — awaits every thunk
phase(title: string): void                                    // groups subsequent agent() calls
log(message: string): void
workflow(nameOrRef: string | { scriptPath: string }, args?: any): Promise<any>
args: any
budget: { total: number | null, spent(): number, remaining(): number }
```

…plus `meta`'s contract (required `name`/`description`; must be a **pure literal**), the
**16-concurrent / 1,000-total** agent caps, the **4,096-item** cap on a single
`parallel()`/`pipeline()` call, and `resumeFromRunId` resume semantics.

> [!NOTE]
> **Verified first-hand — the same method [§5](#5-why-prose-orchestration-rots) uses on the missing
> team tools.** The agent that wrote this section read the `Workflow` tool's description in its own
> session's tool schema and found `Script body hooks:` there verbatim, `parallel()` and `phase()`
> included.
>
> An earlier draft of this spike asserted the API exposed `parallel()` and `phase()`. A later draft
> **retracted that as an error**, on the strength of the narrative page alone. **The retraction was
> the error — the earlier draft was right.** The lesson survives, but it is a different and better
> one than the one this document nearly shipped: **a source that omits something is not a source
> that denies it.** The specification is *fragmented* — the narrative page teaches by example, the
> tool entry holds the spec — and the fix is to read the tool schema, which is the harness reporting
> on itself. Introspection was already this document's authoritative method for `TeamCreate`; it
> should have been pointed at `Workflow` too.

So the residual risk is **not** an unspecified API. It is an API specified in a **tool description
rather than a versioned reference** — no changelog, no deprecation policy, no compatibility
contract. That is a real hazard for a compiler that renders against it, but it is a **much weaker**
objection than the one this document originally raised, and
[§8](#8-position-on-adoption-not-yet-and-here-is-the-trigger-list) now scores it accordingly.

**③ The vendor says you are not supposed to hand-author these.**

> Each one asks Claude to write and run a workflow for that task; **you don't write the script
> yourself.**

> **You usually don't need to edit it**, but here is the shape of a small one so you can
> recognize what Claude generated. […] If you want to edit a script by hand, ask Claude to walk
> you through the change.

The intended authoring path is **run-then-save** (`/workflows` → `s`), not author-from-scratch.
For a toolkit whose entire model is *author once, render many*, that is a real philosophical
collision — and [§8](#8-position-on-adoption-not-yet-and-here-is-the-trigger-list) shows the way
through it, because the docs also name our exact migration path.

### One thing we already got right

> **Custom commands have been merged into skills.**

`.claude/commands/x.md` and `.claude/skills/x/SKILL.md` both produce `/x`. wafflestack is already
aligned — `installer/lib/waffledocs.mjs:59` reads *"A skill is a slash command unless it
explicitly opts out with `user-invocable: false`."* **No change needed, and do not introduce
"slash command" as a separate category in the taxonomy.**

---

## 3. Inventory: which skills are really orchestrators

**37 `SKILL.md` files** on disk. The test applied to each: *does it **create and sequence** agents
or tasks, and does it have fixed phases?* Five say yes.

The prong is **create and sequence**, not merely *touches the task tools* — teardown-only
bookkeeping does not make an orchestrator. That distinction is not a hedge; it is load-bearing, and
it names exactly one deliberate near-miss ([`clean-up`](#the-other-32-are-genuinely-skills), below).

### The five orchestrators

| Skill | Lines | The structure that makes the verdict | Verdict |
|---|---|---|---|
| **`audit`** | 177 | A **fixed 6-pass chain** (architecture → security-1 → compliance → docs-agent → docs-human → security-2). `TeamCreate`, six `TaskCreate`s wired with `addBlockedBy`, six sequential `Agent()` spawns, **a hard human gate after pass 1**, then `TeamDelete`. `disable-model-invocation: true`. | **Workflow-shaped** — a hand-written DAG. But see the gate. |
| **`docs`** | 43 | 3 fixed steps, fixed agent chain (`{{roster.architectAgent}}` → `docs-agent` → `docs-human`); step 1's output is threaded into steps 2 and 3 as `{step-1 output}`. | **Workflow-shaped.** |
| **`standup`** | 63 | Dynamic roster discovery, **one parallel read-only wave**, then a digest. Its own body admits it *"reuses their spawn-and-collect scaffold minus the team and the task dependencies."* | **Workflow-shaped** — this is `pipeline()`, hand-rolled. |
| **`delegate`** | 775 | 5 named phases (Fetch → Classify → Plan → Execute → Report). **It has already reinvented a workflow runtime in prose + Node:** a typed JSON checkpoint (`checkpoint.schema.json`) validated at *every phase boundary* by `checkpoint.mjs`, plus worktree isolation for parallel agents. That checkpoint schema *is* `agent(…, { schema })`, hand-built. | **Hybrid — the strongest workflow case.** But Classify and Plan carry genuine judgment that must stay prose. |
| **`autopilot`** | 441 | 9 steps, a per-issue loop, opt-in gates (`+qa`/`+review`/`+audit`), **round caps**, convergence checks. | **Hybrid.** Deterministic *control flow* wrapping judgment-heavy *inner steps*. Control flow → script; inner steps → agents. |

### The other 32 are genuinely skills

Zero agent spawns, zero phase machinery. (The apparent exceptions — `qa`,
`adversarial-review`, `pr-response`, `issue`, `git-workflow` — match `spawn` only in prose
*describing being spawned by* autopilot. They never fan out.)

> [!NOTE]
> **The deliberate near-miss: `clean-up`.** It is the one skill outside the five that touches task
> bookkeeping at all — it calls `TaskStop`
> (`stacks/github-workflow/skills/clean-up/SKILL.md:124`) and `TeamDelete` (`:131`), and
> [§5](#5-why-prose-orchestration-rots) names it among the four skills still calling the
> now-dead team tools.
>
> It is still **not** an orchestrator, and the prong above is written to say so precisely: `clean-up`
> only ever **tears down** what something else created. It spawns no agent, sequences no phase, and
> creates no task. Bookkeeping *at the end of* someone else's fan-out is not orchestration — which is
> why the test asks whether a skill **creates and sequences**, and not merely whether it touches the
> task tools. Naming the near-miss is cheaper than leaving a reader to find it.

They fall in three groups:

- **Guidance** — prose standards a model interprets: `prose`, `accurate`, `md-maximalist`,
  `codebase-architecture`, `tdd`, `dry`, `docs-agent`, `docs-human`, `git-workflow`,
  `github-project-management`, and the expo/obsidian/security reference skills.
- **Single-context procedures** — deterministic steps, one agent, no fan-out: `issue`, `release`,
  `clean-up`, `hygiene`, `label-hook`, `pr-response`, `qa`, `adversarial-review`,
  `github-project-board`.
- **CLI wrappers** — the eight `waffle-*` skills.

> [!IMPORTANT]
> **The orchestrator boundary falls exactly on the `orchestration` stack boundary** — 5 of 5
> orchestrators inside it, 0 of 32 outside. Whatever we eventually do about workflows is
> **contained to one stack**. That is a much cheaper migration than it first looked.

---

## 4. The collisions

### 4.1 `/audit` ⊃ `/docs` — and the two copies have *already drifted*

`/audit`'s passes 1, 4 and 5 do what `/docs`'s steps 1, 2 and 3 do: they spawn the same three
agents (`{{roster.architectAgent}}`, `docs-agent`, `docs-human`) over the same doc sets
(`{{docs.machineDocSet}}`, `{{docs.humanDocSet}}`).

**The manifest admits it in writing.** `stacks/orchestration/stack.yaml:484` documents
`roster.architectAgent` as:

> Name of the architecture-audit agent spawned by **the audit chain and the docs pipeline**.

One roster entry, two pipelines, and **`/audit` never once references `/docs`.** It
re-implements it.

Now, the duplication is subtler than "the prompts were copy-pasted" — both pipelines correctly
delegate the *content* of a doc pass to the same underlying `docs-agent` / `docs-human` skills.
What is duplicated is the **pipeline**: the sequence, the wiring, the contract between steps.

**And that duplicated pipeline has already diverged.** Two verifiable drifts:

| | `docs` | `audit` | Consequence |
|---|---|---|---|
| **Is the architecture pass read-only?** | **Yes.** *"Output ONLY the change report. Do NOT modify any files."* + *"Step 1 is read-only — the audit agent only reports"* (`docs/SKILL.md:19,42`) | **No.** *"Fix all issues."* (`audit/SKILL.md:136`) | The same named agent both may and may not write, depending on which caller reached it. |
| **Does the change report feed the doc passes?** | **Yes.** Step 2 receives `{step-1 output}` verbatim; step 3 builds on step 2 (`docs/SKILL.md:27,35`) | **No.** Passes 4 and 5 are independent spawns that receive no upstream report (`audit/SKILL.md:144–150`) | `/audit`'s doc passes are strictly worse-informed than `/docs`'s — they rediscover what pass 1 already found. |

This is the prediction — *"two copies, free to drift apart"* — **already realized, in the tree,
today.** It is the single strongest piece of evidence in this document, and it is what makes the
fix urgent independent of any workflow decision.

> [!CAUTION]
> **This is a composition bug, not a workflow bug.** Adopting the workflow primitive would not
> fix it — you would simply hold the same duplication in JavaScript instead of prose. Only
> composition fixes it: **`/audit` should *invoke* `/docs` for its documentation passes rather
> than re-spawning `docs-agent` and `docs-human` itself.** That fix is available today, at zero
> cost, with no new primitive. It is filed as a follow-up.

### 4.2 The same scaffold, hand-copied three times

- **`autopilot` re-implements `audit`'s team lifecycle** — it "owns the Team lifecycle (create →
  run → `TeamDelete`, even on failure)", duplicating `audit`'s steps 1 and 4.
- **`standup` hand-copies the spawn-and-collect scaffold a third time**, by its own admission.

Three hand-written copies of one pattern — precisely the DRY violation a real orchestration
runtime erases at a stroke.

---

## 5. Why prose orchestration rots

Open issue [#360](https://github.com/dustinkeeton/wafflestack/issues/360) establishes something
uncomfortable: **`/audit` is unrunnable as written.** An agent that follows its Execution Steps
literally calls tools that do not exist.

- **`TeamCreate` / `TeamDelete` are gone from the harness.** They are absent from the tool list
  *and* the deferred-tools list. The `Agent` tool's own schema explains why — `team_name` is now
  documented as *"Deprecated; ignored. The session has a single implicit team."*
- **`TaskCreate`'s signature is stale.** The skills call
  `TaskCreate(description:, team_name:, addBlockedBy:)`. The real tool takes **`subject` +
  `description`**; there is no `team_name`, and no `addBlockedBy` at create time — dependencies
  are set afterwards via `TaskUpdate`.

`audit`, `delegate`, `autopilot` and `clean-up` all still call them.

> [!NOTE]
> **Verified first-hand while writing this document.** The agent that authored this file runs in
> the current harness. Its tool list contains **no `TeamCreate` and no `TeamDelete`**; its
> `TaskUpdate` schema has **no `team_name`**; and its `Agent` schema carries the *"Deprecated;
> ignored. The session has a single implicit team"* line verbatim. This is not a report about the
> harness — it is the harness reporting on itself.

**Here is the general principle, and it is the real argument of this document:**

> [!IMPORTANT]
> **Prose orchestration has no compiler.** Nothing type-checks a `SKILL.md` against the harness's
> actual tool list. So it drifts silently, and you discover the drift at runtime — in `/audit`'s
> case, mid-audit, having already spawned agents. A workflow *script* is **parsed before a single
> agent is spawned**: a syntax error fails it at the door, for free, and it **never runs**.
>
> **Precisely, though — it is the *runtime's* parser that must accept it, not `node --check`.** A
> workflow body is not a standalone ES module ([§2, "Execution model"](#the-mechanics)), so `node
> --check` rejects a perfectly valid script on its top-level `return`. The asymmetry this section
> claims is real and survives intact — *something* mechanically checks a script and *nothing*
> mechanically checks prose — but the checker is the workflow runtime, and this document should not
> imply a guarantee from a tool that does not hold the right grammar. The argument is strong enough
> without the overclaim.

That asymmetry — silent rot vs. loud failure — is the strongest argument *for* the primitive.
[§8](#8-position-on-adoption-not-yet-and-here-is-the-trigger-list) explains why it still is not
enough. Yet.

---

## 6. The taxonomy

### 6.1 The word gets exactly two licensed uses. The third is banned.

| Term | Means | Rule |
|---|---|---|
| **"GitHub Actions workflow"** | `.github/workflows/*.yml` | **Always qualified** on first use in a document. Never bare "workflow". As *installable payloads* these already have a name: **syrup**. |
| **"workflow"** *(bare)* | The Claude Code primitive — a JS script in `.claude/workflows/` that deterministically orchestrates subagents. **The script decides what runs next.** | **Reserved.** Never use this word for anything else. We do not own it. |
| ~~"workflow" = any deterministic multi-phase process~~ | — | **BANNED.** Say the **phases** or **steps** of a skill instead. |

### 6.2 The generic sense gets no replacement noun — it gets decomposed

This is the opinionated core of the recommendation: **the generic category should not exist.**

Every "deterministic multi-phase process" in wafflestack is already one of exactly two things:

- **a skill** — prose that *one* agent context reads and interprets. Its internal structure is
  **steps** or **phases**. It is never "a workflow."
- **an orchestrator skill** — a skill whose job is to spawn and sequence *other* agents and
  skills (`audit`, `docs`, `standup`, `delegate`, `autopilot`). Purely descriptive; no new
  metaphor. This is precisely the thing a Claude *workflow* would one day replace.

**Why coin nothing:** a spike whose purpose is to *reduce* naming overload must not answer it by
minting a third noun. Naming the generic category would preserve the very ambiguity we are
killing.

### 6.3 Alternatives considered

- **Coin a food word — "recipe", "playbook", "pipeline" — for the generic sense.** `recipe` is
  genuinely on-brand (the house metaphor is waffles / stacks / syrup / `bake`), and
  [#183](https://github.com/dustinkeeton/wafflestack/issues/183) is already extending it
  (extension → topping). **Rejected here, deferred there:** coining a noun *re-legitimises the
  third category* — the exact thing this spike exists to abolish. If the owner does want a food
  word for "orchestrator skill", it belongs in the #347/#183 rename pass, not in a spike about
  disambiguation. Flagged, not decided.
- **Qualify every use** — "GitHub Actions workflow" / "Claude workflow" / "generic workflow".
  **Rejected:** it keeps three meanings alive and depends on every author remembering the
  adjective forever. Discipline that requires perpetual vigilance is not discipline.
- **Rename the GitHub sense.** **Rejected:** the path is GitHub's, and the repo already has the
  right word for these as payloads — **syrup**.

### 6.4 What is *not* renamed — following the repo's own #59 precedent

The [#59 rebrand](../DECISIONS.md) (waffles / stacks / syrup) set the pattern: **rename the
user-facing vocabulary; leave the load-bearing surfaces alone.** It renamed "bundle" → "stack"
precisely because *"bundle collides with the ubiquitous JS/build sense"* — the identical argument
#184 makes about "workflow" — while explicitly rejecting a rename of the item-ref prefixes as
*"churny and compatibility-breaking for lock keys and consumer `include:`/`eject:` lists, with no
vocabulary gain."*

Applied verbatim:

- **The `github-workflow` stack and the `git-workflow` skill keep their names.** They are consumer
  surfaces — lock keys, `.waffle/waffle.yaml` `stacks:` entries, `include:`/`eject:` refs,
  rendered directory names. And *"git workflow"* is idiomatic English for a branching strategy;
  there is no ambiguity to gain. A rename costs a migration and buys nothing.
- **`.github/workflows/*.yml` is untouchable.** GitHub mandates it.

### 6.5 The architectural rule the collisions actually need

> **A skill is the unit of work. Orchestration is only ever sequencing.**
>
> - A skill **never duplicates another skill's content** — it **invokes** it.
> - An orchestrator holds *only* sequencing, gates, fan-out, and loops.

Apply that rule to [§4.1](#41-audit--docs--and-the-two-copies-have-already-drifted) and the
`/audit` ⊃ `/docs` collision dissolves — with no new primitive, no schema change, and no vendor
dependency.

---

## 7. Per-target degradation: there is no portable workflow primitive

| Target | Deterministic in-harness orchestration? | What it actually has |
|---|---|---|
| **`claude`** | **Yes** — `.claude/workflows/*.js` ([§2](#2-what-a-claude-workflow-actually-is)). Claude-only, paid-plans-only, v2.1.154+. | subagents, skills, hooks, agent teams, workflows |
| **`codex`** | **No.** Subagents exist (`.codex/agents/*.toml`) but orchestration is **model-driven**: *"ChatGPT or Codex handles orchestration across agents… spawning new subagents, routing follow-up instructions, waiting for results."* `agents.max_depth` defaults to `1`. The lone exception, `spawn_agents_on_csv`, is a fan-out map, not a workflow. Deterministic driving exists only **outside** the harness (`codex exec --json --output-schema`, the Codex SDK). `~/.codex/prompts/` is deprecated in favour of skills. | AGENTS.md, agent TOML, hooks, skills, headless `exec` |
| **`agents-dir`** | **None at all.** agents.md: *"AGENTS.md is just standard Markdown… the agent simply parses the text you provide."* The Agent Skills spec defines a directory + `SKILL.md` + optional `scripts/`, and **no orchestration, sequencing, or execution semantics** whatsoever. | prose, period |

**Across every harness surveyed, deterministic multi-phase driving lives *outside* the agent
loop** — in CI, or in a shell/SDK script calling a headless CLI. (The one genuinely code-driven
agentic system found in the survey, GitHub's `gh-aw`, gets its determinism from **GitHub
Actions** — a striking echo of this repo's own `.github/workflows/` syrup.)

This creates the constraint that decides [§8](#8-position-on-adoption-not-yet-and-here-is-the-trigger-list):

> [!WARNING]
> **A Claude-only `workflow` item kind would reintroduce exactly the asymmetry
> [#94](../DECISIONS.md) was fought to remove.** That decision — *"Close the render-target
> asymmetry — every target renders both agents and skills"* — deliberately eliminated
> half-covered harnesses, on the rationale that *"the whole point of a compiler is that its
> targets actually compile; a permanently half-implemented second target is a worse answer than
> finishing it."* `ARCHITECTURE.md` restates it as a rule: *"Every target renders both agents and
> skills — there is no half-covered harness."*
>
> Any proposal to add workflows as a **fourth portable source kind** must answer #94. It cannot.

---

## 8. Position on adoption: **not yet** — and here is the trigger list

The orchestrators *are* workflow-shaped ([§3](#3-inventory-which-skills-are-really-orchestrators)).
Prose orchestration *does* provably rot ([§5](#5-why-prose-orchestration-rots)). The pull is real
and should be acknowledged rather than argued away.

An earlier draft of this section listed **five blockers** and promised to revisit *"when all five
clear."* That promise was **unsatisfiable**, and the table said so itself: blocker ④'s own *"clears
when"* column read **"Never fully."** A gate that can never open is the very shrug the section opens
by disclaiming. Worse, the five were not the same *kind* of thing — a permanent constraint, a
decision we owe ourselves, and a dated event do not belong in one column.

So separate them. **One is a gate. One is already cleared. Three were never gates at all.**

### The gate — two dated events and one piece of design work

| # | Blocker | Clears when |
|---|---|---|
| **⑤** | **[#360](https://github.com/dustinkeeton/wafflestack/issues/360) must land first.** `/audit` is unrunnable as written ([§5](#5-why-prose-orchestration-rots)) — it calls `TeamCreate`/`TeamDelete`, which no longer exist. Converting a broken skill is building on sand. | **#360 merges.** |
| **⑥** | **[#364](https://github.com/dustinkeeton/wafflestack/issues/364) — optional target scoping for syrup — must land.** Syrup renders **once regardless of `targets:`**, so a Claude-only workflow shipped as syrup lands in a codex-only repo as dead weight. Point 3 below calls this a **hard prerequisite**, and it is: it is the thing that makes "ship it as opt-in syrup" actually work. | **#364 merges.** It is a *ship* prerequisite, not a *decide* one — by its own body it is **independently correct and should land even if the workflow decision slips** — but adoption cannot ship without it. |
| **①** | **`/audit`'s human sign-off gate must be redesigned.** The docs are explicit: *"No mid-run user input… For sign-off between stages, run each stage as its own workflow."* `/audit` has a **hard gate after security pass 1** — *"Do not auto-proceed if there are Critical or High findings."* A gate as such *is* expressible (a hard abort); **sign-off with a human override is not**, and silently dropping it would convert a safety stop into an auto-proceed. | **A design decision, not a wait** — either `/audit` splits into staged workflows (gate *between* runs, per the docs' own remedy), or the gate leaves the chain. Nothing external blocks it. But it is **unsettled**, and it is a *safety* gate, so it is on the list. |

> [!WARNING]
> **This is a three-item gate, and an earlier draft of this section said "two".** It omitted **⑥**
> — the one item §8 itself calls **hard**. That is the same failure the five-item table was
> criticised for, in a smaller coat: a "list you can actually check" is worth nothing if it quietly
> drops an item. **#364 is a schema change** — additive and backward-compatible, but real: by its own
> body it touches `installer/lib/toolkit.mjs`, `installer/lib/render.mjs`, `installer/lib/validate.mjs`
> and `schema/FORMAT.md`. Point 1 below is corrected accordingly: **no fourth item kind, one additive
> manifest field** — *not* "no schema change".

### Already cleared

| # | Blocker | Status |
|---|---|---|
| **②** | ~~**The in-script API has no public specification.**~~ | **CLEARED — and it was never true.** The `Workflow` tool entry specifies the full in-script surface, `parallel()` and `phase()` included ([§2 ②](#2-what-a-claude-workflow-actually-is)). What remains is *weaker and different*: the spec lives in a **tool description, not a versioned reference** — no changelog, no deprecation policy. That argues for **pinning and testing** against the surface, not for staying away from it. |

### Not gates — one permanent constraint, one already resolved

| # | Blocker | What it actually is |
|---|---|---|
| **③** | **It breaks [#94](../DECISIONS.md).** Claude-only ⇒ a half-covered harness. Codex and agents-dir have *no* equivalent to degrade to ([§7](#7-per-target-degradation-there-is-no-portable-workflow-primitive)). | **Resolved in this document, below.** Ship as **opt-in syrup**, not a fourth item kind: #94 governs the two *harness-neutral* kinds (agents and skills), and syrup is path-specific by definition. Raised and answered in the same section — so it is not a thing to wait for. (It is resolved *in principle*; **⑥/#364 is what makes it work in practice**.) |
| **④** | **Paid-plans-only, version-gated (v2.1.154+), with an org-wide kill switch.** A rendered workflow can be **silently inert** in a consumer's repo. Today's skills run on any plan. | **A permanent design constraint — "never fully" is the honest answer, and it is not a gate.** It bounds the *shape* of adoption, not its *timing*: it is precisely **why the prose orchestrator must remain the portable fallback forever.** It belongs in the design rationale, and that is where it now does its work. |

### The honest position, restated

**The verdict is unchanged — "not yet" — but the arithmetic behind it is not, and the change is
worth stating plainly rather than burying.** ② is cleared (and was wrong). ③ this document resolves
itself in principle. ④ never opens and was never a gate. What survives is **three items**:

- **⑤ — [#360](https://github.com/dustinkeeton/wafflestack/issues/360) has not merged**, and
  `/audit` — the skill the issue proposed converting — remains unrunnable as written. That alone
  settles the timing.
- **⑥ — [#364](https://github.com/dustinkeeton/wafflestack/issues/364) has not merged.** Without
  optional target scoping, "ship it as opt-in syrup" puts Claude-only files in a codex-only repo.
  This document calls it a **hard prerequisite** and it is one. It can land **independently of the
  workflow decision** — and should.
- **① — the sign-off gate design is unsettled**, and it is a *safety* gate. Adopting first and
  designing the sign-off path afterwards is the wrong order.

And two things that shape adoption without gating it: **④ is permanent**, so adoption is
opt-in-shaped forever with the prose orchestrator retained as the fallback that runs everywhere; and
**the vendor still says not to hand-author these** ([§2 ③](#2-what-a-claude-workflow-actually-is))
against a surface that is specified but **unversioned** — a toolkit that *renders* scripts is betting
on a contract nobody has promised to keep.

**Revisit when #360 and #364 have merged and ①'s gate is designed.** Not "when all five clear" —
that day would never have come. Three items, each of which can actually be checked off.

### The shape it takes when it *is* adopted — and it needs no new machinery

The vendor, helpfully, describes wafflestack's exact situation and names the migration path:

> **If you already have an orchestrator built another way, such as a folder of subagent prompts
> or *a skill that fans work out*, you can point Claude at it and ask for a workflow that does the
> same thing.**

That dissolves blocker ③'s philosophical half. The authoring path is **generate, then commit the
generated script** — which is compatible with author-once-render-many, because the committed
artifact is just a file. Concretely:

1. **Ship it as opt-in syrup** — `files/.claude/workflows/audit.js`. Syrup is *already* the
   toolkit's kind for "a file rendered verbatim to a real load-bearing path," and **opt-in syrup**
   is *already* the gate for target-specific payloads. **No fourth item kind and no #94 violation** —
   because #94 governs *agents and skills*, the two harness-neutral kinds, and syrup is path-specific
   by definition. **It does, however, need one additive manifest field** — see point 3, and do not
   let this bullet imply otherwise: *"no fourth item kind"* is not *"no schema change."*
2. **Each workflow phase invokes a skill.** The skills stay the single source of truth for *what a
   phase does*; the script encodes *only the sequencing*. The prose orchestrator remains the
   portable fallback that runs everywhere. Sequencing is then expressed twice (JS + prose) but the
   **content never is** — a far better trade than today, where the *content* is what's duplicated.
3. **Fix one known wart first — and it is a schema change.** Syrup renders **once regardless of
   `targets:`** (`schema/FORMAT.md`: *"Files are harness-independent: they render once regardless of
   `targets:`"*). A Claude-only workflow shipped as syrup would land in a codex-only repo as dead
   weight. **Optional target scoping for syrup is a hard prerequisite**, filed as
   [#364](https://github.com/dustinkeeton/wafflestack/issues/364) — and it is **trigger ⑥** of the
   gate above, not a footnote. It adds an optional `targets:` filter to a `files:` manifest entry:
   **additive and backward-compatible** (absent ⇒ today's behaviour exactly), but a change to
   `installer/lib/toolkit.mjs`, `installer/lib/render.mjs`, `installer/lib/validate.mjs` and
   `schema/FORMAT.md` all the same. It is **independently correct** and should land even if the
   workflow decision slips.

---

## 9. Illustrative sketch: `/audit` as a workflow

> [!CAUTION]
> **This is an illustration, not an artifact.** It is a fenced code block inside a Markdown file.
> It is **not** a real `.claude/workflows/` file, it is not rendered, not installed, and not in
> any manifest. It exists to make [§8](#8-position-on-adoption-not-yet-and-here-is-the-trigger-list)
> concrete. It uses `agent()` and `phase()` from the surface specified in
> [§2 ②](#2-what-a-claude-workflow-actually-is), and it is **unverified against a real runtime.**

> [!IMPORTANT]
> **This block will NOT pass `node --check`, and that is expected — do not "fix" it.**
> `node --check` reports `SyntaxError: Illegal return statement` on the two top-level `return`s
> below (the safety abort, and the final result). That is **the checker applying the wrong grammar**,
> not a bug in the sketch: a workflow body is *"module header + async function body"*, not a
> standalone ES module ([§2, "Execution model"](#the-mechanics)). Top-level `return` is legal in the
> real runtime, and **the vendor's own documented scripts use it** — theirs open with
> `export const meta` and end with `return { confirmed }`, exactly as this one does.
>
> Spelled out because **[#363](https://github.com/dustinkeeton/wafflestack/issues/363) starts from
> this sketch**, and the obvious "correction" — restructuring the `return`s away to satisfy a checker
> that was never the right one — would make the artifact *less* faithful to the primitive, not more.
> The honest gap is that this is **unverified against a real runtime**; the parse is not the gap.

Note what it demonstrates and what it cannot:

- ✅ **Phases invoke skills** — the script holds sequencing; each prompt defers to a `SKILL.md`
  for its content. No duplicated prose.
- ✅ **The `/docs` collision is gone** — one `docsPipeline()` helper, called once, threading the
  change report through exactly as `/docs` does today.
- ⚠️ **The security gate degrades to a hard abort.** A gate as such *is* expressible — the script
  below stops the run cold on Critical/High. What is **not** expressible is **sign-off with a human
  override**: the script can *stop*, but it cannot *ask*. Today's skill can. That is blocker ①, made
  visible — and it is a narrower claim than "the gate cannot be added," which the code immediately
  below would contradict.

```javascript
export const meta = {
  name: 'audit',
  description: 'Full codebase audit chain — architecture, security, compliance, docs, security again.',
}

// `args` is the optional focus area — today's `$ARGUMENTS` / `argument-hint: [optional focus area]`.
const focus = args ? `Pay special attention to: ${args}. Still perform your full audit.` : ''

// `severity` MUST be required. If it is merely declared, a schema-conformant agent may omit it,
// `security1.severity` is `undefined`, `includes(undefined)` is false — and the safety gate below
// silently never fires, sailing straight past Critical findings. A gate keyed on an optional field
// is decorative. (The earlier draft of this sketch made exactly that mistake.)
const FINDINGS = {
  type: 'object',
  required: ['findings', 'fixesApplied', 'severity'],
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    severity: { enum: ['none', 'low', 'medium', 'high', 'critical'] },
  },
}

// Every phase delegates its CONTENT to a skill. The script owns only the SEQUENCE.
phase('Architecture')
const architecture = await agent(
  `Audit and improve codebase structure. Follow the codebase-architecture skill. ${focus}`,
  { schema: FINDINGS, label: 'architecture' },
)

phase('Security 1')
const security1 = await agent(
  `Full security audit. Follow the security-audit skill for grep patterns and the severity rubric. ${focus}`,
  { schema: FINDINGS, label: 'security-1' },
)

// ⚠️ BLOCKER ①: today's skill stops HERE for human SIGN-OFF on Critical/High findings — a human
//    may review and choose to proceed. A workflow cannot ask: "No mid-run user input." A gate is
//    expressible; an OVERRIDE is not. So it degrades to a hard abort — safe, but strictly less
//    capable than the skill. The docs' own remedy is to make each stage its own workflow run.
if (['high', 'critical'].includes(security1.severity)) {
  return { stoppedAt: 'security-1', reason: 'Critical/High findings — sign-off required', security1 }
}

phase('Compliance')
const compliance = await agent(
  `Compliance pass. Follow the compliance skill. ${focus}`,
  { schema: FINDINGS, label: 'compliance' },
)

// The /docs collision, fixed by composition: ONE pipeline, and the change report is
// threaded into both doc passes — which is more than today's /audit does.
async function docsPipeline(changeReport) {
  const machine = await agent(
    `Here is the architecture change report:\n\n${changeReport}\n\n` +
      `Update the machine docs. Follow the docs-agent skill; it defines the file set.`,
    { label: 'docs-agent' },
  )
  return agent(
    `The machine docs were just updated:\n\n${machine}\n\n` +
      `Update the human docs to match. Follow the docs-human skill and its guardrails ` +
      `(owner-voiced docs are flagged, never rewritten).`,
    { label: 'docs-human' },
  )
}

phase('Docs')
const docs = await docsPipeline(architecture.findings.join('\n'))

phase('Security 2')
const security2 = await agent(
  `Re-audit everything, including all changes made by the earlier agents. ` +
    `Focus on new files, anything written to the project root, and that prior fixes are intact.`,
  { schema: FINDINGS, label: 'security-2' },
)

return { architecture, security1, compliance, docs, security2 }
```

**What the sketch teaches, in one line:** the parts of `/audit` that are *sequencing* fall out
cleanly into script — and the one part that is *judgment requiring a human* falls straight out of
the primitive's reach. That is the whole recommendation, in twelve lines of JavaScript.

---

## Summary

1. **"Workflow" means the Claude primitive.** GitHub's sense is always qualified. The generic
   sense is banned — say **phases** or **steps** of a skill.
2. **We coin no new noun.** The generic category is decomposed, not renamed.
3. **`github-workflow` and `git-workflow` keep their names** (#59 precedent: rename vocabulary,
   never load-bearing surfaces).
4. **A skill is the unit of work; orchestration is only sequencing.** A skill invokes another
   skill — it never duplicates one.
5. **Fix `/audit` ⊃ `/docs` by composition, now.** It is a composition bug, not a workflow bug,
   and the two copies have already drifted.
6. **Do not adopt the workflow primitive yet — but the case against it is weaker than it first
   looked.** Of the five blockers this spike started with, one was **false** (the in-script API *is*
   specified — `parallel()` and `phase()` are real), one this document **resolves itself**, and one
   **never opens** and was never a gate. What survives is a **three-item gate**: **[#360](https://github.com/dustinkeeton/wafflestack/issues/360)
   must land** (`/audit` is unrunnable as written), **[#364](https://github.com/dustinkeeton/wafflestack/issues/364)
   must land** (optional target scoping for syrup — a *hard* prerequisite, and an additive schema
   change), and **`/audit`'s human sign-off gate must be redesigned** (a gate is expressible inside a
   workflow; an **override** is not). When it *is* adopted, it ships as **opt-in syrup** whose phases
   invoke skills — **no fourth item kind, but one additive manifest field** — with prose orchestrators
   kept as the portable fallback, permanently, because workflows are paid-plan and version-gated.
