---
name: delegate
description: Fetch open GitHub issues, assign each to the best specialist agent, and orchestrate execution with parallel worktree isolation and serial dependency chains
user-invocable: true
argument-hint: "[#N, label, keyword, or `milestone:<name>` — omit for the project's default scope]"
---

# Issue Delegation

Fetch open GitHub issues, assign each to the right specialist agent, and orchestrate execution. Handles parallel worktree isolation when safe and serial chaining when necessary.

## Run checkpoints

The phases below (Fetch → Classify → Plan → Execute → Report) hand state forward. Rather than trust that state to prose in the orchestrating context alone, each phase writes a **typed, schema-validated checkpoint** and validates its predecessor's before proceeding. The checkpoint is the **single source of truth** for load-bearing fields — issue numbers, branch names, worktree paths — a resume point after interruption, and the audit trail the Report phase reads.

- **One JSON document per run**, at `.claude/worktrees/.delegate/<runId>.json`. `<runId>` is the team name for multi-issue runs (`delegate-<timestamp>`) or `delegate-single-<N>-<timestamp>` for the single-issue fast path. Create the directory first: `mkdir -p .claude/worktrees/.delegate`. It is gitignored throwaway run state.
- **Schema:** `.claude/skills/delegate/checkpoint.schema.json` — one section per phase (`scope`, `issues`, `classification`, `plan`, `execution`, `report`), each documented inline. Start the file with `{ "version": 1, "runId": "<runId>" }`, then append each phase's section as you complete it.
- **Validator:** `.claude/skills/delegate/checkpoint.mjs` — dependency-free (Node built-ins only, runs in any consumer repo). At **every phase boundary**, after writing the current phase's section, run:

  ```bash
  node .claude/skills/delegate/checkpoint.mjs --file .claude/worktrees/.delegate/<runId>.json --phase <fetch|classify|plan|execute|report>
  ```

  It checks the document shape **and** cross-references (every classified/assigned/executed issue traces back to a fetched issue; a parallel assignment has a worktree and a serial one does not; an executed branch matches the branch the plan assigned — this is what catches a hallucinated branch). Exit 0 = proceed. **Exit 1 = STOP the run and report the error verbatim — never improvise past a failed checkpoint.** This deterministic gate is the point of the mechanism; do not replace it with an eyeball "looks right".

The per-phase instructions below each end with a **Checkpoint** step naming the section to write and the phase to validate.

## Run memory

The checkpoint above is **per-run** throwaway state. Run memory is the opposite: **one small, curated, durable doc per repo** that carries lessons *between* runs — repo quirks, setup steps that flake, which issues are entangled, which agent a fuzzy area really belongs to. Without it, everything learned in run N evaporates before run N+1; the two tempting fixes — an append-only log, or stuffing prior notes into prompts — both bloat unbounded until they poison context instead of helping it. So this doc is **curated and hard-capped**, never append-only.

- **One doc per repo**, at `.claude/worktrees/.delegate/memory.md`. It sits alongside the checkpoints and inherits the same gitignore. Same trade-off as the checkpoint dir: it persists locally but is **per-clone** (not committed), so memory does not follow the repo to another machine — that is acceptable, just don't treat it as authoritative shared state.
- **Hard cap:** `4096` bytes. The cap is the point — it forces the doc to stay a compact working set. When curation would push it over, prune the stalest entries; **never raise the cap to dodge pruning.**
- **Format** — an H1 title, a one-line preamble, then entries. Each entry is an H2 whose heading *is* the fact, plus three required fields so pruning is judged, not FIFO:

  ```markdown
  # Delegate run memory — <repo>

  > Curated, capped (see delegate.memoryMaxBytes). Prune stale entries; never blind-append.

  ## Setup step `npm run seed` flakes on a cold checkout
  - **Why:** Agents burn a cycle when it fails; re-running once clears it — tell them up front.
  - **Since:** #42 — the summarize agent hit it twice before we noticed.
  - **Area:** summarize

  ## Issues touching `shared/` must serialize behind the config refactor
  - **Why:** Parallel edits there collide on the same export map.
  - **Since:** #55, PR #61 — learned when two worktrees conflicted.
  - **Area:** shared
  ```

  - **Why** — why the fact is forward-useful (what it saves a future run).
  - **Since** — the issue/PR that taught it (must contain a `#N`). This is the **staleness anchor**: when that area is later reworked, re-judge or drop the entry rather than trusting it forever.
  - **Area** — the module/area tag, so the Execute phase can hand each agent only the entries relevant to *its* issue.

- **Validator / cap gate:** `.claude/skills/delegate/memory.mjs` — dependency-free (Node built-ins only). It enforces the byte cap **and** the entry format:

  ```bash
  node .claude/skills/delegate/memory.mjs --file .claude/worktrees/.delegate/memory.md --max-bytes 4096
  ```

  A **missing file is valid** (a repo with no delegate history yet). Exit 0 = within cap and every entry well-formed. **Exit 1 = over cap or a malformed entry — STOP and curate; do not improvise past it, and do not finish the run with the doc over cap.** This is the deterministic gate, same as the checkpoint's — don't replace it with an eyeball "looks small enough".

The **read** policy lives in Phases 2–4 (Classify and Plan load the doc; each spawned agent gets only its area's entries), and the **write** policy in Phase 5 (Report curates — prune + rewrite — then runs the gate above).

## Batch mode

`/delegate` pauses for human confirmation whenever the plan is non-trivial (the Phase 3 gate: >2 agents, an ambiguous assignment, or parallel execution). That gate is correct for interactive use, but it blocks delegate from running as a building block for the autonomous backlog runner (the `autopilot` skill), which must work through a supplied issue list without a human accepting each plan. **Batch mode** removes that interactive pause by treating **explicit scope** as the confirmation.

- **Opt-in, per run.** Batch mode is ON when `delegate.batchMode` is `true`; for this run it is **false**. Default `false` — the interactive confirmation gate behaves exactly as it always has.
- **Activation requires explicit scope.** Batch mode applies only when the invoker (a human or the autopilot orchestrator) supplied the issue set explicitly — an issue list / `#N`, `milestone:<name>`, a known label, a keyword, or the `all-open` / `todo-column` default scopes (a config-chosen default set is an explicit opt-in; a `todo-column` fallback resolves to `all-open`, itself an explicit-scope signal). That explicit scope is what stands in for the human accepting the plan. If `delegate.batchMode` is `true` but the resolved scope carries no such signal, **fall back to interactive confirmation** — never auto-proceed on an unscoped run.
- **It changes decision points, not machinery.** Classification, the parallel-only-when-areas-disjoint rules, worktree isolation for parallel groups, serial dependency chains, per-issue PR creation, and board updates are all unchanged. Batch mode changes exactly two decisions:
  1. **The Phase 3 confirmation gate is skipped** — instead of pausing, **log** the plan that would have been shown for approval (the same table) so the run stays auditable after the fact, then proceed. The `plan` checkpoint still records `confirmed: true`, tagged `confirmedVia: "batch-scope"` to mark that confirmation came from explicit scope under batch mode, not from a human.
  2. **Ambiguous classification falls back to the safest choice** — serial execution in the main checkout (a serial group, worktree `null`) — instead of pausing to ask.
- **It composes with the other opt-ins and never weakens them.**
  - With `delegate.autoMerge` (the autopilot orchestrator, #100, sets both), delegate plans and spawns with no pause and each PR arms itself on green — the fully unattended path.
  - **`delegate.approveBeforePush` still wins.** Batch mode removes only the Phase-3 *planning* confirmation; it does **not** disable the pre-push *push* approval gate. A batch run with `delegate.approveBeforePush: true` still stops each agent at its pre-push gate exactly as in interactive mode. The two gates are independent: batch mode silences the plan pause, `approveBeforePush` still holds each push.
- **Process the supplied list one group at a time**, in the same reasonably-chunked units delegate already produces — batch mode neither widens scope nor merges groups.

## Phase 1: Fetch Issues

**Argument handling** — the fetch path depends on whether `$ARGUMENTS` is provided:

- **No `$ARGUMENTS` (default)** → delegate the project's configured default scope, which for this project is **all-open**:
  - `current-milestone` → delegate **every open issue in the current milestone, and only that milestone**. Resolve the current milestone first (see below), then fetch its issues. This path must **never** silently widen to all open issues.
  - `all-open` → fetch **every open issue** in the repo: `gh issue list --state open --json number,title,labels,body,milestone --limit 50`. This is the bulk path for repos that don't plan with milestones; in interactive mode the Phase 3 confirmation gate guards it — always present the full plan before spawning anything. (In batch mode, `all-open` is an explicit-scope signal: the plan is **logged**, not paused on — see **Batch mode**.)
  - `todo-column` → delegate **exactly the open issues in the project board's "Todo" Status column**. Resolve the board and its Status = "Todo" option first (see **Resolving the Todo column** below), then fetch those issues. **No project board, or no "Todo" option on the Status field → fall back to `all-open`** — that fallback is the documented contract of choosing `delegate.defaultScope: todo-column`, but it must be **explicit, never silent**: lead the Phase 3 plan with `Board or Todo column not found → falling back to all-open (N issues)`; in interactive mode the confirmation gate still guards the widened set, and in batch mode that line is **logged**, not paused on. A Todo column that exists but is empty is **NOT a fallback** — that is "nothing to delegate": report that the Todo column is clear and **stop** (the zero-matching-issues rule below). Never widen past the Todo set for any other reason. (Contrast with `current-milestone`, which **stops** rather than widens — there the user never consented to more than the milestone; here the fallback is what the configured scope value itself opted into.)
- `#N` or a bare number → fetch that single issue: `gh issue view N --json number,title,labels,body,milestone`
- `milestone:<title-or-number>` → delegate that milestone explicitly: resolve a number directly, or match the title against `gh api "repos/$OWNER/$REPO/milestones?state=open"`, then fetch its open issues exactly as in the current-milestone path.
- A known label (`bug`, `enhancement`, `documentation`, `question`) → filter: `gh issue list --state open --label "$ARGUMENTS" --json number,title,labels,body,milestone`
- Any other text → fetch all open issues and filter client-side by keyword match against title and body: `gh issue list --state open --json number,title,labels,body,milestone --limit 50`

**Zero matching issues** (any path) → report that there is nothing to delegate and stop.

### Determining the current milestone (no-args path)

The **current milestone** is the open milestone with the **earliest due date among those that have a due date**. Milestones with no due date are backlogs (e.g. an "Icebox") and are explicitly **not** the current milestone.

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)

# Current milestone = earliest-due OPEN milestone that actually has a due date.
# CAUTION: GitHub's `sort=due_on&direction=asc` sorts NULL due dates FIRST, so a
# naive `.[0]` would wrongly pick an undated backlog. Filter out nulls in jq.
CURRENT=$(gh api "repos/$OWNER/$REPO/milestones?state=open" \
  --jq '[.[] | select(.due_on != null)] | sort_by(.due_on) | .[0]')

MILESTONE_NUMBER=$(echo "$CURRENT" | jq -r '.number // empty')
MILESTONE_TITLE=$(echo "$CURRENT"  | jq -r '.title  // empty')
```

Then fetch **only** that milestone's open issues — filter by milestone **number** (titles may contain em-dashes that are fragile to quote):

```bash
gh issue list --state open --milestone "$MILESTONE_NUMBER" \
  --json number,title,labels,body,milestone --limit 50
```

**Guardrails — never widen scope beyond the current milestone:**
- **No open milestone has a due date** (or there are zero open milestones) → `MILESTONE_NUMBER` is empty. **Stop.** Report that no current milestone could be determined, and do **not** fall back to all open issues. Suggest the user pass an explicit issue number, label, or keyword.
- **Current milestone has zero open issues** → report that it is already clear and stop.
- Always state the selected milestone (title + number) in the Phase 3 plan so the user can confirm the scope before any agent is spawned.

### Resolving the Todo column (todo-column path)

Delegate exactly the board's Status = "Todo" open issues. Three lookups, in order — an empty result at step 1 or 2 triggers the **explicit `all-open` fallback** described above; an empty result at step 3 is a clear column, which **stops** the run instead.

1. Discover `PROJECT_ID` — the same title-match query Board Setup uses (an account may own several projects, so never assume the first result):

   ```bash
   OWNER=$(gh repo view --json owner -q .owner.login)

   PROJECT_ID=$(gh api graphql -f query='
     query($owner: String!) {
       user(login: $owner) {
         projectsV2(first: 20) {
           nodes { id number title }
         }
       }
     }
   ' -f owner="$OWNER" --jq 'first(.data.user.projectsV2.nodes[] | select(.title | test("wafflestack"; "i")) | .id) // empty')
   ```

   `PROJECT_ID` empty → **no board**: fall back to `all-open`, stated explicitly per above.

2. Find the Status field and its "Todo" option — the Board Setup fields query, extracting both IDs (a `todo-column` run reuses these in Board Setup rather than re-querying):

   ```bash
   STATUS_FIELD=$(gh api graphql -f query='
     query($projectId: ID!) {
       node(id: $projectId) {
         ... on ProjectV2 {
           fields(first: 50) {
             nodes {
               ... on ProjectV2SingleSelectField {
                 id name
                 options { id name }
               }
             }
           }
         }
       }
     }
   ' -f projectId="$PROJECT_ID" --jq 'first(.data.node.fields.nodes[] | select(.name == "Status")) // empty')

   STATUS_FIELD_ID=$(echo "$STATUS_FIELD" | jq -r '.id // empty')
   TODO_OPTION_ID=$(echo "$STATUS_FIELD" | jq -r 'first(.options[]? | select(.name == "Todo") | .id) // empty')
   ```

   `TODO_OPTION_ID` empty → **no "Todo" option on the Status field** (or no Status field at all): fall back to `all-open`, stated explicitly per above.

3. List the issue numbers currently in the Todo column — the `github-project-management` skill's items-with-status catalog query, filtered client-side to items whose content is an **open Issue** and whose Status `fieldValues` value is "Todo":

   ```bash
   TODO_NUMBERS=$(gh api graphql -f query='
     query($projectId: ID!) {
       node(id: $projectId) {
         ... on ProjectV2 {
           items(first: 100) {
             nodes {
               content { ... on Issue { number state } }
               fieldValues(first: 20) {
                 nodes {
                   ... on ProjectV2ItemFieldSingleSelectValue {
                     field { ... on ProjectV2SingleSelectField { name } }
                     name
                   }
                 }
               }
             }
           }
         }
       }
     }
   ' -f projectId="$PROJECT_ID" --jq '[.data.node.items.nodes[] | select(.content.state == "OPEN") | select(any(.fieldValues.nodes[]?; .field.name == "Status" and .name == "Todo")) | .content.number | tostring] | join(" ")')
   ```

   Note the `items(first: 100)` bound — a board with more than 100 items needs pagination before the Todo set can be trusted.

   `TODO_NUMBERS` empty → the Todo column exists but is **empty**. This is NOT a fallback — report that the Todo column is clear and stop (the zero-matching-issues rule).

Then fetch full issue JSON in bulk and intersect client-side — keep only the issues whose `number` appears in `TODO_NUMBERS` (same pattern as the keyword path):

```bash
gh issue list --state open --json number,title,labels,body,milestone --limit 50
```

That intersection is the delegated set.

**Checkpoint** — write `scope` (the resolved `mode`, a human `description`, and `milestone` for milestone modes) and `issues` (one entry per fetched issue: `number`, `title`, `labels`, optionally `body`/`milestone`), then validate. `mode` is `todo-column` only when the Todo set was actually delegated; a run that **fell back records `mode: "all-open"`** with the provenance in `description` (e.g. `defaultScope todo-column: no Todo column on board — fell back to all-open (12 issues)`) — the checkpoint records what actually ran, the description carries why. Validate:

```bash
node .claude/skills/delegate/checkpoint.mjs --file .claude/worktrees/.delegate/<runId>.json --phase fetch
```

## Phase 2: Classify

**Load run memory first.** Read `.claude/worktrees/.delegate/memory.md` (skip silently if it does not exist yet) — it is small by design, so load the whole doc as compact context. Let its entries inform classification: a prior run may have recorded that a fuzzy area really belongs to a particular agent, or that two issues are entangled. Do not let memory override a clear content match; use it to break ties and flag known quirks.

For each issue, determine the best specialist agent using content-based matching. Scan the issue title and body for keywords and source paths, then apply the first matching row:

| Signal (keywords / paths) | Agent |
|---------------------------|-------|
| installer, CLI, render, doctor, eject, template, `installer/**` | general-purpose |
| stack, skill, agent definition, config key, `stacks/**`, `schema/**` | general-purpose |
| docs, AGENTS.md, architecture/status docs | docs-agent (machine) / docs-human (human) |

**Label fallback** — if no keyword match:

| Label | Agent |
|-------|-------|
| bug | general-purpose |
| enhancement | general-purpose |
| documentation | docs-agent |
| question | general-purpose |

After classification, determine the **area** each issue touches — which module or subdirectory, and whether it includes root files (toolkit.yaml, package.json, installer/cli.mjs, schema/FORMAT.md, README.md) or installer/lib/ (render pipeline — every CLI command and test imports it). This drives parallelization.

**Ambiguous classification in batch mode** — when `delegate.batchMode` is on and an issue's agent or area cannot be pinned down confidently, do **not** defer it to a human. Resolve it to the **safest** option: settle on your best-guess agent, and flag the issue `touchesShared: true` so Phase 3 places it in a **serial group in the main checkout** (worktree `null`) rather than parallelizing on an uncertain area. Note the fallback in the plan you log in Phase 3. In interactive mode an ambiguous classification instead surfaces at the Phase 3 confirmation gate as usual.

**Checkpoint** — write `classification` (one entry per issue: `number`, `agent`, `area`, and `touchesRoot`/`touchesShared` where known), then validate. The validator enforces that **every fetched issue is classified exactly once** and none references an unknown issue:

```bash
node .claude/skills/delegate/checkpoint.mjs --file .claude/worktrees/.delegate/<runId>.json --phase classify
```

## Phase 3: Plan & Confirm

Build an assignment plan table and determine parallel grouping. **Consult the run memory loaded in Phase 2** while grouping: an entry recording an *entanglement* ("issues touching `shared/` must serialize behind the config refactor") or a *recurring conflict* is grounds to serialize where the static rules alone would allow parallel. Memory augments the rules below; it never relaxes a serialization the rules require.

**Parallelization rules** — two issues can run in parallel when ALL of these hold:
- They touch **different areas** (no module/subdirectory overlap)
- Neither touches root files (toolkit.yaml, package.json, installer/cli.mjs, schema/FORMAT.md, README.md) or installer/lib/ (render pipeline — every CLI command and test imports it)
- No dependency language in the issue body ("depends on #N", "blocked by #N", "after #N")

Worktree isolation makes it safe for two agents of the **same type** to run at once — issues sharing an agent type **may** still parallelize as long as their areas are disjoint (each spawn is a separate instance with its own worktree and a unique `name`).

**Serialization rules** (override parallel):
- installer/lib/ (render pipeline — every CLI command and test imports it) is a bottleneck — any two issues touching it must serialize
- stack content depends on installer template semantics — `installer/lib` changes merge before dependent `stacks/**` changes.
- Security issues serialize **last**
- Documentation issues serialize **last** (need final code state)

Present the plan to the user. On the no-args path, **lead with the resolved scope** — the milestone (title, number, open-issue count), `all open issues (N)`, `board Todo column (N issues)`, or the todo-column fallback line (`Board or Todo column not found → falling back to all-open (N issues)`) — so the user confirms exactly what is being delegated:

```
## Delegation Plan

**Milestone:** v1.1.0 — Post Release (#5) — 12 open issues

| # | Issue | Agent | Module(s) | Group |
|---|-------|-------|-----------|-------|
| 3 | Fix UI hang when... | plugin-architect | summarize | A |
| 5 | Fix folder picker... | lead-engineer | shared | B (serial) |

**Parallel:** Group A runs simultaneously with worktree isolation
**Serial:** Group B runs after A completes (touches the shared module)

Proceed?
```

**Confirmation gate:**
- **Batch mode (`delegate.batchMode` is `true`) with explicit scope → do not pause.** Explicit scope stands in for the human accepting the plan, so skip the interactive gate: **log** the plan table above (the same assignment/grouping decisions you would have shown for approval) so the run is auditable after the fact, then proceed straight to execution. Any assignment that would be *ambiguous* was already resolved to the safest choice — serial execution in the main checkout — back in Phase 2, so it never reaches a pause here. This does **not** touch `delegate.approveBeforePush`: if that pre-push gate is on, each agent still stops before `git push` (see **Batch mode**).
- **Always confirm** when: >2 agents would spawn, any assignment is ambiguous, or parallel execution is planned
- **Skip confirmation** for a single obvious assignment (e.g., `/delegate #5` with a clear match)

Wait for the user to approve, modify, or cancel before proceeding. **In batch mode there is no wait** — the logged plan is the audit record and execution proceeds immediately.

**Checkpoint** — once the plan is settled (approved, the batch-mode logged plan, or the single-obvious-assignment fast path), write `plan`: `confirmed` (true), `confirmedVia` (how confirmation was obtained — `interactive` when a human approved the gate, `batch-scope` when batch mode + explicit scope stood in for it, or `single-obvious` for the fast path), and `groups`, each group carrying `id`, `mode` (`parallel`/`serial`), and `assignments`. Each assignment records `number`, `agent`, `branch` (the exact git-workflow branch name), and `worktree` — the **absolute** path `<repo>/.claude/worktrees/issue-<N>` for parallel groups, or `null` for serial groups and the single-issue fast path. This plan is the source of truth Phase 4 reads branch and worktree from. Validate:

```bash
node .claude/skills/delegate/checkpoint.mjs --file .claude/worktrees/.delegate/<runId>.json --phase plan
```

The validator enforces that every issue is assigned exactly once, branch names are well-formed, worktree presence matches group mode (parallel ⇒ has a path, serial ⇒ null), and — when set — `confirmedVia` requires `confirmed: true` (a recorded confirmation source can't sit atop an unconfirmed plan).

## Board Setup

Before execution begins, discover the project board metadata for kanban sync. This is best-effort — if the project or status options are not found, log a warning and skip all board updates. A `todo-column` run already discovered `PROJECT_ID` and `STATUS_FIELD_ID` while resolving the Todo column in Phase 1 — reuse those values instead of re-running steps 2–3's queries.

1. Get repo owner/name:
   ```bash
   OWNER=$(gh repo view --json owner -q .owner.login)
   REPO=$(gh repo view --json name -q .name)
   ```

2. Discover `PROJECT_ID` — select the board by **title match** against the project name (an account may own several projects, so never assume the first result):
   ```bash
   PROJECT_ID=$(gh api graphql -f query='
     query($owner: String!) {
       user(login: $owner) {
         projectsV2(first: 20) {
           nodes { id number title }
         }
       }
     }
   ' -f owner="$OWNER" --jq 'first(.data.user.projectsV2.nodes[] | select(.title | test("wafflestack"; "i")) | .id) // empty')
   ```

3. Get `STATUS_FIELD_ID` and status option IDs (`IN_PROGRESS_OPTION_ID`, `IN_REVIEW_OPTION_ID`) from the project fields:
   ```bash
   gh api graphql -f query='
     query($projectId: ID!) {
       node(id: $projectId) {
         ... on ProjectV2 {
           fields(first: 50) {
             nodes {
               ... on ProjectV2SingleSelectField {
                 id name
                 options { id name }
               }
             }
           }
         }
       }
     }
   ' -f projectId="$PROJECT_ID"
   ```
   Look for the "Status" field and extract `IN_PROGRESS_OPTION_ID`. If the board also has an "In Review" option, capture `IN_REVIEW_OPTION_ID`; otherwise leave it unset (many boards are just Todo / In Progress / Done).

4. If `PROJECT_ID` is empty or any of the above fail → set `BOARD_SYNC_ENABLED=false`, log a warning, and skip all board updates in subsequent phases. When the board is missing entirely (or lacks the standard Status options), note that the `github-project-board` skill can provision or standardize it — but don't run it inline; board provisioning is a deliberate, user-approved step, not something to trigger mid-delegation.

See the `github-project-management` skill for the full GraphQL query catalog, and the `github-project-board` skill to create or standardize the board itself.

**Checkpoint (optional)** — record the resolved board metadata in the checkpoint's `board` section (`enabled`, plus `projectId`, `statusFieldId`, `inProgressOptionId`, `inReviewOptionId` when found) so the Report phase and any resume know whether board sync is live. This section is optional and has no dedicated validation phase; write it if the board was discovered.

## Phase 4: Execute

### Team Setup (multi-issue only)

When delegating **2 or more issues**, create a team for coordination. Skip this for single-issue delegation.

```
TeamCreate(team_name: "delegate-{timestamp}")
```

Create a task per issue so agents can report progress:

```
# For each issue:
task_N = TaskCreate(
  description: "Issue #{number}: {title}",
  team_name: "delegate-{timestamp}"
)
```

For serial dependencies (e.g., shared/ bottleneck), chain tasks:

```
task_B = TaskCreate(
  description: "Issue #{number}: {title}",
  team_name: "delegate-{timestamp}",
  addBlockedBy: [task_A.id]
)
```

### Branch naming

Each agent gets a branch named per git-workflow conventions:

- Bug fix: `fix/issue-{N}-{short-desc}`
- Enhancement: `feat/issue-{N}-{short-desc}`
- Refactor: `refactor/issue-{N}-{short-desc}`
- Chore/docs: `chore/issue-{N}-{short-desc}`

### Worktree provisioning (parallel groups only)

**KNOWN BUG:** the Agent tool's `isolation: "worktree"` parameter is silently ignored when `team_name` is also passed (see [anthropics/claude-code#33045](https://github.com/anthropics/claude-code/issues/33045)). Team-spawned agents end up sharing the main checkout and stomp on each other's branches. Always use the manual-worktree pattern below for parallel groups.

For each issue in a parallel group, before spawning its agent:

```bash
# Run from the main checkout
WORKTREE_PATH=".claude/worktrees/issue-{N}"
git fetch origin main
git worktree add "$WORKTREE_PATH" -b feat/issue-{N}-{short-desc} origin/main
```

Notes:

- Pick the branch prefix (`feat/`, `fix/`, etc.) per the Branch naming table.
- If the branch already exists from a prior aborted run, use `git worktree add "$WORKTREE_PATH" feat/issue-{N}-{short-desc}` (no `-b`).
- Use `origin/main` as the base, not local `main`, so all worktrees start from the same fetched tip.
- Keep `.claude/worktrees/` gitignored.

Retain the absolute path of each worktree (resolve with `realpath "$WORKTREE_PATH"`) to inject into the agent's prompt. This path — and the branch — must match what the `plan` checkpoint recorded for this issue; **read them from the checkpoint** rather than re-deriving them, so a single source of truth drives both provisioning and the agent prompt.

For **serial groups** (including the single-issue fast path), no worktree is needed — the agent runs in the main checkout and switches branches there.

### Set In Progress

Before spawning each agent, update the issue's status on the project board:

1. Get the issue node ID:
   ```bash
   ISSUE_NODE_ID=$(gh api graphql -f query='
     query($owner: String!, $repo: String!, $number: Int!) {
       repository(owner: $owner, name: $repo) {
         issue(number: $number) { id }
       }
     }
   ' -f owner="$OWNER" -f repo="$REPO" -F number=$ISSUE_NUMBER --jq '.data.repository.issue.id')
   ```

2. Add the issue to the project board (idempotent — returns existing item if already present):
   ```bash
   ITEM_ID=$(gh api graphql -f query='
     mutation($projectId: ID!, $contentId: ID!) {
       addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
         item { id }
       }
     }
   ' -f projectId="$PROJECT_ID" -f contentId="$ISSUE_NODE_ID" --jq '.data.addProjectV2ItemById.item.id')
   ```

3. Set status to "In Progress":
   ```bash
   gh api graphql -f query='
     mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
       updateProjectV2ItemFieldValue(input: {
         projectId: $projectId
         itemId: $itemId
         fieldId: $fieldId
         value: {singleSelectOptionId: $optionId}
       }) {
         projectV2Item { id }
       }
     }
   ' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$STATUS_FIELD_ID" -f optionId="$IN_PROGRESS_OPTION_ID"
   ```

4. Retain `ITEM_ID` for each issue (needed for status update in the Report phase).

Errors in any step → log a warning and continue. Board updates must never block agent execution.

### Spawning agents

**Parallel groups** — each agent gets a pre-provisioned worktree. **Do NOT pass `isolation: "worktree"`** — it is silently ignored when `team_name` is set (see the known bug above). Inject the worktree path into the prompt; the agent will `cd` into it as its first action.

```
Agent(
  subagent_type: "{agent-type}",
  team_name: "delegate-{timestamp}",
  name: "issue-3-{agent-type}",
  run_in_background: true,
  prompt: <agent prompt with WORKTREE_PATH baked in>,
  description: "Issue #3: Fix UI hang"
)
```

Spawn all agents of the group in the same response (multiple `Agent` tool calls in one message) so they run truly concurrently.

**Single-issue fast path** — skip team creation entirely. Run in the main checkout, no worktree needed:

```
Agent(
  subagent_type: "{agent-type}",
  prompt: <agent prompt>,
  description: "Issue #3: Fix UI hang"
)
```

**Serial groups** — spawn agents one at a time in the main checkout. Wait for each to complete before spawning the next.

**Silent specialists** — a specialist agent only has the tools its definition grants. Agents without `SendMessage`/`TaskUpdate` finish silently: never wait on a report-back from them. After each agent completes, verify its work directly (branch pushed? PR opened? `gh pr list --head {branch-name}`) and do the task/board bookkeeping yourself.

### Agent prompt template

Each spawned agent receives this prompt. Its load-bearing fields — `{number}`, `{branch-name}`, and `{worktree_path}` — come from this issue's entry in the `plan` checkpoint (the single source of truth), not from re-derivation. For **parallel groups**, fill in `{worktree_path}` with the checkpoint's `worktree` value (the absolute path provisioned for this issue). For **serial groups / single-issue fast path**, omit the "Working directory" section — the agent works in the main checkout and creates its branch there per the git-workflow skill.

**Inject only this issue's relevant memory.** From the run-memory doc loaded in Phase 2, select the entries whose **Area** matches this issue's classified area (plus any that name this issue number in their **Since**), and paste just those into the "Repo notes from prior runs" section below. Do **not** dump the whole doc into every agent — an agent gets only what pertains to its issue. If no entry matches, omit the section entirely.

```
You are assigned to GitHub issue #{number}: {title}

## Working directory

YOUR WORKTREE: {worktree_path}

FIRST COMMAND — run before anything else:

    cd {worktree_path} && git status

Every subsequent shell command in your session MUST run from this directory. Bash sessions persist `cwd`, so a single `cd` at the start is enough — but never run `cd` to a different directory afterward, and never operate on the parent checkout.

The worktree is already on branch `{branch-name}` based on `origin/main`. Do NOT run `git checkout main` or `git pull` — that would corrupt sibling agents' worktrees. Just start committing.

## Issue body

{full issue body from GitHub}

## Repo notes from prior runs

{only the memory entries whose Area matches this issue — omit this whole section if none}

## Instructions

1. Read the relevant source files identified in the issue.
2. Implement the fix/feature following the project's conventions.
3. Run the pre-flight checklist:
   - npm run lint --if-present
   - npm run validate
   - npm test
   - npm pack --dry-run
   - `npm run validate` passes after any stack/manifest edit
- If `stacks/**` changed: re-run `node installer/cli.mjs render` and commit the updated render + lock (the doctor CI gate fails on drift) — never hand-edit rendered `.claude/` output
4. Commit your work following the git-workflow skill — end every commit message with `Co-Authored-By: Claude <noreply@anthropic.com>`. Commit everything **locally**; do not push yet.
5. Push and open the PR — but first check the approval gate. The gate is ON when `delegate.approveBeforePush` is `true`; for this run it is **`false`**.
   - **Gate off (`false`, the default):** push and open the PR yourself, exactly as usual —
     - Push: git push -u origin {branch-name}
     - Create a PR: gh pr create --title "{type}: {short description}" --body "..." targeting main.
   - **Gate on (`true`):** do NOT run `git push` or `gh pr create`. Stop at the local commit and hand an approval summary to the orchestrator — branch `{branch-name}`, target issue #{number}, diffstat (`git diff --stat origin/main...HEAD`), and commit list (`git log --oneline origin/main..HEAD`):
     - If you have SendMessage, send that summary to `team-lead` and WAIT for an explicit approval reply. On approval, push and open the PR as above. On rejection, leave the worktree exactly as-is (committed, unpushed) and report the rejection — never push.
     - If you lack messaging tools, STOP after committing without pushing, and make the approval summary your final message. The orchestrator inspects your worktree, collects approval, and completes or withholds the push itself.
6. Arm auto-merge — opt-in, and only when a PR was actually opened. Auto-merge is ON when `delegate.autoMerge` is `true`; for this run it is **`false`**.
   - **Off (`false`, the default):** do nothing — leave the PR for a human to merge. Skip this step; nothing else changes.
   - **On (`true`):** immediately after `gh pr create` succeeds, arm the PR to merge itself once the base branch's required checks pass:
     - gh pr merge --auto --merge <pr-number>
     - Merge commits, not squash — squash is disabled on this repo. `--auto` only arms when the repo has **"Allow auto-merge"** enabled *and* a required status check is configured for the base branch (otherwise there is nothing for it to wait on). If it cannot arm, report the PR as **open but auto-merge could not be enabled** — do **NOT** fall back to an immediate merge or `--admin` merge, and never bypass branch protection.
     - On a **successful** arm, label the PR as a durable paper trail that automation (not a human) queued the merge: `gh pr edit <pr-number> --add-label "waffle-auto-merged"` — only when `--auto` actually armed (the label means "armed," not "attempted"); the label must already exist in the repo.
   - If the approval gate (step 5) was on and your push was **rejected**, there is no PR — skip this step.
   - State in your report whether auto-merge armed on the PR.
7. If you have the tools, mark your task as completed — TaskUpdate(taskId: "<task_id>", status: "completed") — and report back: SendMessage(to: "team-lead", content: <summary with PR URL and whether auto-merge armed, or the approval summary when the gate is on>). If you lack these tools, just ensure the PR exists (gate off) or the local commit is in place (gate on); the orchestrator verifies your work directly.

Branch name: {branch-name}
```

### Approval gate (opt-in — only when `delegate.approveBeforePush` is enabled)

This step runs **only when `delegate.approveBeforePush` is `true`**. When it is `false` (the default), agents push and open their own PRs autonomously — skip this section entirely; nothing about the run changes.

When the gate is on, each agent commits locally and STOPS before `git push` (see the agent prompt template). No branch may leave the machine until the human has approved it. For each agent that has reached its pre-push stop:

1. **Assemble the summary.** Take it from the agent's report if it sent one, or reconstruct it straight from the branch/worktree — either is authoritative:

   ```bash
   # <dir> = the agent's worktree (parallel groups) or the main checkout (serial / single-issue).
   git -C <dir> log  --oneline origin/main..<branch>   # commit list
   git -C <dir> diff --stat    origin/main...<branch>  # diffstat
   ```

2. **Collect the decision.** Present each summary — branch, target issue, diffstat, commit list — to the human with `AskUserQuestion`, offering **Approve**, **Approve all remaining**, and **Reject**. Ask one question per agent, or a single multi-select over all pending agents. Never assume approval on a timeout or a silent agent.

3. **On approval** → the branch is pushed and the PR opened: reply to a waiting (messaging-capable) agent with the approval so it pushes (it then arms auto-merge itself per step 6 of its prompt), or, for a silent agent, push and open the PR yourself from its worktree/branch — and when you open it yourself, arm auto-merge too if `delegate.autoMerge` is on, following the same guardrails (arm with `gh pr merge --auto --merge`; on a successful arm, label it as a paper trail with `gh pr edit <pr#> --add-label "waffle-auto-merged"`; on failure leave it open-but-not-armed, never `--admin`). Record `approval: "approved"` and `approvedBy` (who approved) in this issue's `execution` entry.

4. **On rejection** → do NOT push. Leave the worktree and its local branch intact for inspection (never `git worktree remove` a rejected branch). In this issue's `execution` entry record `status: "skipped"`, `pr: null`, `approval: "rejected"`, and `approvedBy` (who rejected), and surface it in the Report.

### Post-agent verification

After each agent completes, verify the build still passes in the main working directory:

```bash
npm run validate && npm test
```

If verification fails after a parallel agent's worktree merge, stop and report the conflict.

**Checkpoint** — after all agents finish, write `execution`: one entry per planned issue with `number`, `agent`, `branch` (verified from `gh pr list --head <branch>` / the pushed branch — **not** re-typed from memory), `status` (`done`/`failed`/`skipped`), `pr` (URL or `#number`, or `null`), and optional `boardMoved`. When the approval gate was on (`delegate.approveBeforePush`), also record `approval` (`approved`/`rejected`) and `approvedBy` per entry — a **rejected** push is `status: "skipped"` with `pr: null` (the validator enforces this, so a rejection can never masquerade as a merged PR). When auto-merge was enabled for the run (`delegate.autoMerge`), also record `autoMergeArmed` (`true`/`false`) per entry — whether `gh pr merge --auto` actually armed on that PR. **Verify it, don't assume it:** `gh pr view <pr> --json autoMergeRequest -q '.autoMergeRequest != null'` returns `true` only when the PR is really armed; a PR left open-but-not-armed (no required check, or auto-merge disabled on the repo) records `false`. The validator enforces that only a PR-bearing entry can be `autoMergeArmed: true`. Validate:

```bash
node .claude/skills/delegate/checkpoint.mjs --file .claude/worktrees/.delegate/<runId>.json --phase execute
```

The validator cross-checks every execution branch against the branch the plan assigned — a mismatch (hallucinated or stale branch) stops the run here rather than surfacing as a broken Report.

## Phase 5: Report

After all agents complete, present a summary. Build the table **from the checkpoint's `execution` and `issues` sections** — that is the audit trail, so the report can never disagree with what actually ran:

```
## Delegation Report

| # | Issue | Agent | Status | PR |
|---|-------|-------|--------|----|
| 3 | Fix UI hang... | plugin-architect | done | #6 |
| 5 | Fix folder picker... | lead-engineer | done | #7 |

Build: passing
```

**Approval gate** — when it was active for the run (any `execution` entry carries an `approval` field), add an **Approved by** column so the report records who approved or rejected each push. A **rejected** issue shows `status: skipped` with no PR; call it out explicitly and note that its worktree/branch was left local and intact for inspection (it is not cleaned up).

**Auto-merge** — when it was enabled for the run (`delegate.autoMerge`; any `execution` entry carries an `autoMergeArmed` field), add an **Auto-merge** column reading `armed` or `not armed` per PR. Call out every PR that came back **not armed** explicitly — it is open but will **not** merge itself (auto-merge disabled on the repo, or no required check on the base branch), so a human still has to merge it. An armed PR merges itself once its required checks pass; the post-merge board-to-Done move for those is the orchestrator's job (see **Board status after work**), not a human's.

### Curate run memory

Now distil this run's **durable, forward-useful** lessons into the run-memory doc at `.claude/worktrees/.delegate/memory.md` — the source of truth the next run's Classify/Plan phases read (see **Run memory** above). This is a **curation**, not an append:

1. **Read the existing doc** (create it with the H1 + preamble header if this is the repo's first run) and take its current entries as the baseline. Draw candidate lessons from what this run actually surfaced — the checkpoint is the audit trail: setup steps that flaked, a misclassification that had to be corrected, issues that turned out entangled, a repo quirk an agent reported.
2. **Only record what will help a *future* run.** Skip one-off details and anything already obvious from the code. Every entry needs its three fields — **Why**, **Since** (cite the issue/PR from this run, with a `#N`), and **Area**.
3. **Prune as you go — judged, not FIFO.** Drop or rewrite entries whose **Since** anchor was superseded by this run (e.g. the quirk it noted was just fixed), and merge duplicates. The doc must stay curated: replacing a stale entry is preferred over adding a new one beside it.
4. **Enforce the cap.** After rewriting, run the deterministic gate — the run may **not** complete while it fails:

   ```bash
   node .claude/skills/delegate/memory.mjs --file .claude/worktrees/.delegate/memory.md --max-bytes 4096
   ```

   **Exit 1** (over cap, or a malformed entry) → **prune further** and re-validate. Do not raise `delegate.memoryMaxBytes` to escape curation, and do not finish the run with the doc over cap or an entry missing a field. **Exit 0** → memory is curated and within budget; proceed.

If nothing durable was learned this run, that is a valid outcome — leave the doc unchanged (or make only prunes) and still run the gate to confirm it is within cap.

**Checkpoint** — write `report` (`build`: `passing`/`failing`/`unknown`, plus optional `notes` for failures, skips, rejected pushes, worktree-cleanup caveats, or memory-curation notes), then validate the completed run:

```bash
node .claude/skills/delegate/checkpoint.mjs --file .claude/worktrees/.delegate/<runId>.json --phase report
```

### Board status after work

For each issue where the agent **succeeded AND created a PR**, update the board status:

- If the board has an "In Review" option (`IN_REVIEW_OPTION_ID` captured in Board Setup), set the item to it with the mutation below.
- Otherwise leave the item as "In Progress" — a human moves it to "Done" when merging the PR.

```bash
# Only if IN_REVIEW_OPTION_ID was captured in Board Setup:
gh api graphql -f query='
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: {singleSelectOptionId: $optionId}
    }) {
      projectV2Item { id }
    }
  }
' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$STATUS_FIELD_ID" -f optionId="$IN_REVIEW_OPTION_ID"
```

**Skip if:** agent failed, no PR was created, or board setup was disabled (warning in Board Setup phase).

**Failed agents** leave the issue as "In Progress" — this is intentional, as stalled "In Progress" items are visible on the board as work that needs attention.

**Auto-merge armed PRs (`delegate.autoMerge`)** merge themselves once their required checks pass — no human is at the merge to move the board. So for an armed PR the **post-merge move to Done is the orchestrator's housekeeping**, not a human's: after arming, once the PR has actually merged (poll `gh pr view <pr> --json state -q .state` for `MERGED`, or pick it up on the next post-merge sweep), set its board item to "Done" and close any straggler issue. Until it merges it stays "In Review" (or "In Progress"), same as any other open PR. Do **not** move it to Done at arming time — arming only queues the merge; it is not merged yet.

Include any failures or skipped issues with reasons.

After the PRs merge, verify the issues actually closed — GitHub's closing keywords apply per reference (`Closes #1, #2` only closes #1), and epics never auto-close from their sub-issues. Close stragglers explicitly.

### Worktree cleanup (parallel groups only)

Once each agent's PR is merged, remove its worktree:

```bash
git worktree remove .claude/worktrees/issue-{N}
```

Do **not** remove worktrees while their PRs are still open — the user may want to push follow-up commits from there. A branch **rejected at the approval gate** has no PR and was never pushed: leave its worktree in place too, so the user can inspect or salvage the local commits. If `git worktree remove` complains about a dirty tree, leave it for the user to inspect and report it in the delegation summary.

### Team Cleanup (multi-issue only)

After reporting, shut down the team:

```
# For each agent:
SendMessage(to: "issue-{N}-{agent-type}", type: "shutdown_request", content: "Delegation complete")

TeamDelete(team_name: "delegate-{timestamp}")
```

## Error Handling

- **Checkpoint validation failure** — `checkpoint.mjs` exited non-zero. **Stop at that phase boundary.** Report the validator's error verbatim; do not enter the next phase or improvise the missing/mismatched state. Fix the checkpoint (or re-run the phase that wrote it) and re-validate before continuing. The checkpoint also survives an interruption: on resume, re-validate the last-written phase to find where the run left off.
- **Build failure** — stop the chain, report to the user, do not create a PR for the failing agent's work
- **Agent cannot complete** — add a comment to the GitHub issue via `gh issue comment {N} --body "..."` explaining what was attempted and what blocked completion, then move on to the next issue
- **Worktree conflict** — fall back to serial execution in the main working directory, report the conflict
- **All agents failed** — present a summary of all failures and suggest manual intervention
- **Board sync failure** — log warning and continue; board updates are informational, never blocking
