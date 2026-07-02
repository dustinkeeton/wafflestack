---
name: delegate
description: Fetch open GitHub issues, assign each to the best specialist agent, and orchestrate execution with parallel worktree isolation and serial dependency chains
user-invocable: true
argument-hint: "[issue number, label filter, or keyword — omit to delegate the whole current milestone]"
---

# Issue Delegation

Fetch open GitHub issues, assign each to the right specialist agent, and orchestrate execution. Handles parallel worktree isolation when safe and serial chaining when necessary.

## Phase 1: Fetch Issues

**Argument handling** — the fetch path depends on whether `$ARGUMENTS` is provided:

- **No `$ARGUMENTS` (default)** → delegate **every open issue in the current milestone, and only that milestone**. Resolve the current milestone first (see below), then fetch its issues. This is the bulk-delegation path and must **never** silently widen to all open issues.
- `#N` or a bare number → fetch that single issue: `gh issue view N --json number,title,labels,body,milestone`
- A known label (`bug`, `enhancement`, `documentation`, `question`) → filter: `gh issue list --state open --label "$ARGUMENTS" --json number,title,labels,body,milestone`
- Any other text → fetch all open issues and filter client-side by keyword match against title and body: `gh issue list --state open --json number,title,labels,body,milestone --limit 50`

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

After classification, determine the affected `src/` subdirectory for each issue (used for parallelization).

## Phase 3: Plan & Confirm

Build an assignment plan table and determine parallel grouping.

**Parallelization rules** — two issues can run in parallel when ALL of these hold:
- Assigned to **different** agents
- Affect **different** `src/` subdirectories (no module overlap)
- Neither touches root files ({{roster.rootFiles}}) or {{roster.sharedModule}}
- No dependency language in the issue body ("depends on #N", "blocked by #N", "after #N")

**Serialization rules** (override parallel):
- {{roster.sharedModule}} is a bottleneck — any two issues touching it must serialize
- {{roster.moduleDependencies}}
- Security issues serialize **last**
- Documentation issues serialize **last** (need final code state)

Present the plan to the user. On the no-args path, **lead with the milestone scope** (title, number, open-issue count) so the user confirms which milestone is being delegated:

```
## Delegation Plan

**Milestone:** v1.1.0 — Post Release (#5) — 12 open issues

| # | Issue | Agent | Module(s) | Group |
|---|-------|-------|-----------|-------|
| 3 | Fix UI hang when... | plugin-architect | summarize | A |
| 5 | Fix folder picker... | architect | shared | B (serial) |

**Parallel:** Group A runs simultaneously with worktree isolation
**Serial:** Group B runs after A completes (touches shared/)

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

2. Discover `PROJECT_ID` via the `user.projectsV2` GraphQL query:
   ```bash
   gh api graphql -f query='
     query($owner: String!) {
       user(login: $owner) {
         projectsV2(first: 20) {
           nodes { id number title }
         }
       }
     }
   ' -f owner="$OWNER"
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
   Look for the "Status" field and extract option IDs for "In Progress" and "In Review".

4. If any of the above fail → set `BOARD_SYNC_ENABLED=false`, log a warning, and skip all board updates in subsequent phases.

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

**Parallel groups** — spawn all agents in the group simultaneously using `isolation: "worktree"`. When a team exists (multi-issue), include `team_name` and `name` for coordination:

```
Agent(
  subagent_type: "plugin-architect",
  isolation: "worktree",
  team_name: "delegate-{timestamp}",
  name: "issue-3-plugin-architect",
  prompt: <agent prompt>,
  description: "Issue #3: Fix UI hang"
)
```

The `isolation: "worktree"` parameter automatically creates and cleans up a git worktree for the agent. No manual worktree management needed.

**Single-issue fast path** — skip team creation entirely. Spawn a single agent without `team_name` or `name`:

```
Agent(
  subagent_type: "plugin-architect",
  isolation: "worktree",
  prompt: <agent prompt>,
  description: "Issue #3: Fix UI hang"
)
```

**Serial groups** — spawn agents one at a time in the main working directory. Wait for each to complete before spawning the next.

### Agent prompt template

Each spawned agent receives this prompt:

```
You are assigned to GitHub issue #{number}: {title}

## Issue body

{full issue body from GitHub}

## Instructions

1. Read the relevant source files identified in the issue
2. Implement the fix/feature following the project's conventions
3. Follow the git-workflow skill for all git operations:
   - Branch from main: git checkout main && git pull && git -c user.email={{git.botEmail}} -c user.name={{git.botName}} checkout -b {branch-name}
   - Commit with bot identity and Co-Authored-By footer
   - Push: git -c user.email={{git.botEmail}} -c user.name={{git.botName}} push -u origin {branch-name}
4. Run the pre-flight checklist before pushing:
   - npx tsc --noEmit --skipLibCheck
   - npm test
   - {{project.buildCmd}}
5. Create a PR: gh pr create --title "{type}: {short description}" --body "..." targeting main
6. Mark your task as completed: TaskUpdate(id: <task_id>, status: "completed")
7. Report back to the team lead: SendMessage(to: "team-lead", content: <summary with PR URL>)

Branch name: {branch-name}
```

### Post-agent verification

After each agent completes, verify the build still passes in the main working directory:

```bash
npx tsc --noEmit --skipLibCheck && npm test
```

If verification fails after a parallel agent's worktree merge, stop and report the conflict.

## Phase 5: Report

After all agents complete, present a summary:

```
## Delegation Report

| # | Issue | Agent | Status | PR |
|---|-------|-------|--------|----|
| 3 | Fix UI hang... | plugin-architect | done | #6 |
| 5 | Fix folder picker... | architect | done | #7 |

Build: passing
```

### Update to In Review

For each issue where the agent **succeeded AND created a PR**, update the board status:

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
' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$STATUS_FIELD_ID" -f optionId="$IN_REVIEW_OPTION_ID"
```

**Skip if:** agent failed, no PR was created, or board setup was disabled (warning in Board Setup phase).

**Failed agents** leave the issue as "In Progress" — this is intentional, as stalled "In Progress" items are visible on the board as work that needs attention.

Include any failures or skipped issues with reasons.

### Team Cleanup (multi-issue only)

After reporting, shut down the team:

```
# For each agent:
SendMessage(type: "shutdown_request", to: "issue-{N}-{agent-type}")

TeamDelete(team_name: "delegate-{timestamp}")
```

## Error Handling

- **Build failure** — stop the chain, report to the user, do not create a PR for the failing agent's work
- **Agent cannot complete** — add a comment to the GitHub issue via `gh issue comment {N} --body "..."` explaining what was attempted and what blocked completion, then move on to the next issue
- **Worktree conflict** — fall back to serial execution in the main working directory, report the conflict
- **All agents failed** — present a summary of all failures and suggest manual intervention
- **Board sync failure** — log warning and continue; board updates are informational, never blocking
