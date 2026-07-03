---
name: delegate
description: Fetch open GitHub issues, assign each to the best specialist agent, and orchestrate execution with parallel worktree isolation and serial dependency chains
user-invocable: true
argument-hint: "[#N, label, keyword, or `milestone:<name>` — omit for the project's default scope]"
---

# Issue Delegation

Fetch open GitHub issues, assign each to the right specialist agent, and orchestrate execution. Handles parallel worktree isolation when safe and serial chaining when necessary.

## Phase 1: Fetch Issues

**Argument handling** — the fetch path depends on whether `$ARGUMENTS` is provided:

- **No `$ARGUMENTS` (default)** → delegate the project's configured default scope, which for this project is **{{delegate.defaultScope}}**:
  - `current-milestone` → delegate **every open issue in the current milestone, and only that milestone**. Resolve the current milestone first (see below), then fetch its issues. This path must **never** silently widen to all open issues.
  - `all-open` → fetch **every open issue** in the repo: `gh issue list --state open --json number,title,labels,body,milestone --limit 50`. This is the bulk path for repos that don't plan with milestones; the Phase 3 confirmation gate guards it — always present the full plan before spawning anything.
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

## Phase 2: Classify

For each issue, determine the best specialist agent using content-based matching. Scan the issue title and body for keywords and source paths, then apply the first matching row:

{{roster.classificationTable}}

**Label fallback** — if no keyword match:

{{roster.labelFallback}}

After classification, determine the **area** each issue touches — which module or subdirectory, and whether it includes root files ({{roster.rootFiles}}) or {{roster.sharedModule}}. This drives parallelization.

## Phase 3: Plan & Confirm

Build an assignment plan table and determine parallel grouping.

**Parallelization rules** — two issues can run in parallel when ALL of these hold:
- They touch **different areas** (no module/subdirectory overlap)
- Neither touches root files ({{roster.rootFiles}}) or {{roster.sharedModule}}
- No dependency language in the issue body ("depends on #N", "blocked by #N", "after #N")

Worktree isolation makes it safe for two agents of the **same type** to run at once — issues sharing an agent type **may** still parallelize as long as their areas are disjoint (each spawn is a separate instance with its own worktree and a unique `name`).

**Serialization rules** (override parallel):
- {{roster.sharedModule}} is a bottleneck — any two issues touching it must serialize
- {{roster.moduleDependencies}}
- Security issues serialize **last**
- Documentation issues serialize **last** (need final code state)

Present the plan to the user. On the no-args path, **lead with the resolved scope** — the milestone (title, number, open-issue count) or `all open issues (N)` — so the user confirms exactly what is being delegated:

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
- **Always confirm** when: >2 agents would spawn, any assignment is ambiguous, or parallel execution is planned
- **Skip confirmation** for a single obvious assignment (e.g., `/delegate #5` with a clear match)

Wait for the user to approve, modify, or cancel before proceeding.

## Board Setup

Before execution begins, discover the project board metadata for kanban sync. This is best-effort — if the project or status options are not found, log a warning and skip all board updates.

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
   ' -f owner="$OWNER" --jq 'first(.data.user.projectsV2.nodes[] | select(.title | test("{{project.name}}"; "i")) | .id) // empty')
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

4. If `PROJECT_ID` is empty or any of the above fail → set `BOARD_SYNC_ENABLED=false`, log a warning, and skip all board updates in subsequent phases.

See the `github-project-management` skill for the full GraphQL query catalog.

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
WORKTREE_PATH="{{git.worktreesDir}}/issue-{N}"
git fetch origin main
git worktree add "$WORKTREE_PATH" -b feat/issue-{N}-{short-desc} origin/main
```

Notes:

- Pick the branch prefix (`feat/`, `fix/`, etc.) per the Branch naming table.
- If the branch already exists from a prior aborted run, use `git worktree add "$WORKTREE_PATH" feat/issue-{N}-{short-desc}` (no `-b`).
- Use `origin/main` as the base, not local `main`, so all worktrees start from the same fetched tip.
- Keep `{{git.worktreesDir}}/` gitignored.

Retain the absolute path of each worktree (resolve with `realpath "$WORKTREE_PATH"`) to inject into the agent's prompt.

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

Each spawned agent receives this prompt. For **parallel groups**, fill in `{worktree_path}` with the absolute path of the worktree provisioned for this issue. For **serial groups / single-issue fast path**, omit the "Working directory" section — the agent works in the main checkout and creates its branch there per the git-workflow skill.

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

## Instructions

1. Read the relevant source files identified in the issue.
2. Implement the fix/feature following the project's conventions.
3. Follow the git-workflow skill for commits and push:
   - End every commit message with `{{git.coAuthorTrailer}}`
   - Push: {{git.cmd}} push -u origin {branch-name}
4. Run the pre-flight checklist before pushing:
   - {{project.lintCmd}}
   - {{project.typecheckCmd}}
   - {{project.testCmd}}
   - {{project.buildCmd}}
   {{delegate.extraPreflight}}
5. Create a PR: gh pr create --title "{type}: {short description}" --body "..." targeting main.
6. If you have the tools, mark your task as completed — TaskUpdate(taskId: "<task_id>", status: "completed") — and report back: SendMessage(to: "team-lead", content: <summary with PR URL>). If you lack these tools, just ensure the PR exists; the orchestrator verifies your work directly.

Branch name: {branch-name}
```

### Post-agent verification

After each agent completes, verify the build still passes in the main working directory:

```bash
{{project.typecheckCmd}} && {{project.testCmd}}
```

If verification fails after a parallel agent's worktree merge, stop and report the conflict.

## Phase 5: Report

After all agents complete, present a summary:

```
## Delegation Report

| # | Issue | Agent | Status | PR |
|---|-------|-------|--------|----|
| 3 | Fix UI hang... | plugin-architect | done | #6 |
| 5 | Fix folder picker... | lead-engineer | done | #7 |

Build: passing
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

Include any failures or skipped issues with reasons.

After the PRs merge, verify the issues actually closed — GitHub's closing keywords apply per reference (`Closes #1, #2` only closes #1), and epics never auto-close from their sub-issues. Close stragglers explicitly.

### Worktree cleanup (parallel groups only)

Once each agent's PR is merged, remove its worktree:

```bash
git worktree remove {{git.worktreesDir}}/issue-{N}
```

Do **not** remove worktrees while their PRs are still open — the user may want to push follow-up commits from there. If `git worktree remove` complains about a dirty tree, leave it for the user to inspect and report it in the delegation summary.

### Team Cleanup (multi-issue only)

After reporting, shut down the team:

```
# For each agent:
SendMessage(to: "issue-{N}-{agent-type}", type: "shutdown_request", content: "Delegation complete")

TeamDelete(team_name: "delegate-{timestamp}")
```

## Error Handling

- **Build failure** — stop the chain, report to the user, do not create a PR for the failing agent's work
- **Agent cannot complete** — add a comment to the GitHub issue via `gh issue comment {N} --body "..."` explaining what was attempted and what blocked completion, then move on to the next issue
- **Worktree conflict** — fall back to serial execution in the main working directory, report the conflict
- **All agents failed** — present a summary of all failures and suggest manual intervention
- **Board sync failure** — log warning and continue; board updates are informational, never blocking
