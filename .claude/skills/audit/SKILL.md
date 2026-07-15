---
name: audit
description: Run a full codebase audit chain — architecture, security, toolkit integrity, machine docs, human docs, then security again. Spawns six named agents consecutively, chained on task dependencies, and reports results.
disable-model-invocation: true
argument-hint: [optional focus area]
---

# Codebase Audit Chain

Run the full audit pipeline in consecutive order. Each agent audits the codebase and (where its role grants edit tools) implements fixes before the next one starts; report-only agents deliver findings for the user or a later agent to fix.

## Chain Order

1. **harness-architect** — Audit and improve codebase structure (module patterns, file organization, naming, dependency rules, import paths)
2. **general-purpose** (pass 1) — Full security audit per the security-audit skill checklist
3. **general-purpose** (Toolkit integrity) — Validates manifests, placeholders, tests, and render/lock integrity (validate + test + render + doctor).
4. **docs-agent** — Create/update the machine docs (a single root `AGENTS.md` registry) optimized for LLM consumption
5. **docs-human** — Create/update the human docs (`DECISIONS.md`, `STATUS.md`, and `ARCHITECTURE.md` at the repo root) for human stakeholders
6. **general-purpose** (pass 2) — Re-audit the entire codebase including all changes made by earlier agents. Ensure no new issues were introduced.

## Execution Steps

The chain is **six named agents**, spawned one at a time and chained on task dependencies. There is no team to create or delete: the session has a **single implicit team**, and the `Agent` tool's `team_name` parameter is deprecated and ignored. An agent's `name:` is its address — `SendMessage(to: "<name>")` reaches it and `TaskStop(task_id: "<name>")` stops it.

> **If a spawn is rejected because the roster is flat** (an agent cannot name its own spawns — only the main conversation loop can), omit `name:` and address the agent by the `agentId` the spawn returns. `SendMessage` and `TaskStop` both accept it in place of a name.

### 1. Create the Tasks, Then Chain Them

`TaskCreate` takes `subject` **and** `description` (both required); it has no `team_name` and no `addBlockedBy`. Dependencies are wired **afterwards**, with `TaskUpdate`:

```
task1 = TaskCreate(subject: "Architecture audit", description: "Audit and improve codebase structure")
task2 = TaskCreate(subject: "Security pass 1",    description: "Full security audit per the security-audit checklist")
task3 = TaskCreate(subject: "Toolkit integrity check", description: "Validates manifests, placeholders, tests, and render/lock integrity (validate + test + render + doctor).")
task4 = TaskCreate(subject: "Machine docs",       description: "Create/update the machine docs")
task5 = TaskCreate(subject: "Human docs",         description: "Create/update the human docs")
task6 = TaskCreate(subject: "Security pass 2",    description: "Re-audit including all changes made by earlier agents")

# addBlockedBy is a TaskUpdate parameter, not a TaskCreate one — and the key is taskId, not id
TaskUpdate(taskId: task2.id, addBlockedBy: [task1.id])
TaskUpdate(taskId: task3.id, addBlockedBy: [task2.id])
TaskUpdate(taskId: task4.id, addBlockedBy: [task3.id])
TaskUpdate(taskId: task5.id, addBlockedBy: [task4.id])
TaskUpdate(taskId: task6.id, addBlockedBy: [task5.id])
```

### 2. Spawn Agents Sequentially

For each step, spawn the named agent, wait for completion, then proceed:

```
Agent(
  subagent_type: "harness-architect",
  name: "architecture-pass",
  prompt: <architecture prompt>
)
# After completion:
TaskUpdate(taskId: task1.id, status: "completed")
```

```
Agent(
  subagent_type: "general-purpose",
  name: "security-pass1",
  prompt: <security pass 1 prompt>
)
TaskUpdate(taskId: task2.id, status: "completed")
```

**Gate after pass 1:** present the security findings to the user. Do **not** auto-proceed if there are Critical or High findings — wait for the fixes (by the user or the architecture agent) or an explicit override before continuing the chain.

```
Agent(
  subagent_type: "general-purpose",
  name: "toolkit-integrity",
  prompt: <Toolkit integrity check prompt>
)
TaskUpdate(taskId: task3.id, status: "completed")
```

```
Agent(
  subagent_type: "docs-agent",
  name: "docs-agent",
  prompt: <docs-agent prompt>
)
TaskUpdate(taskId: task4.id, status: "completed")
```

```
Agent(
  subagent_type: "docs-human",
  name: "docs-human",
  prompt: <docs-human prompt>
)
TaskUpdate(taskId: task5.id, status: "completed")
```

```
Agent(
  subagent_type: "general-purpose",
  name: "security-final",
  prompt: <security pass 2 prompt>
)
TaskUpdate(taskId: task6.id, status: "completed")
```

### 3. Summary and Teardown

After all 6 complete, present the user a consolidated summary table of findings and fixes per agent, then tear the agents down:

```
# Politely ask each agent to wind down…
SendMessage(to: "architecture-pass", message: {type: "shutdown_request", reason: "Audit chain complete"})
SendMessage(to: "security-pass1",    message: {type: "shutdown_request", reason: "Audit chain complete"})
SendMessage(to: "toolkit-integrity", message: {type: "shutdown_request", reason: "Audit chain complete"})
SendMessage(to: "docs-agent",        message: {type: "shutdown_request", reason: "Audit chain complete"})
SendMessage(to: "docs-human",        message: {type: "shutdown_request", reason: "Audit chain complete"})
SendMessage(to: "security-final",    message: {type: "shutdown_request", reason: "Audit chain complete"})

# …then confirm the kill.
TaskStop(task_id: "architecture-pass")
TaskStop(task_id: "security-pass1")
TaskStop(task_id: "toolkit-integrity")
TaskStop(task_id: "docs-agent")
TaskStop(task_id: "docs-human")
TaskStop(task_id: "security-final")
```

**Teardown is shutdown-then-stop.** `shutdown_request` is the polite first step, and an agent that honours it terminates cleanly. It is **not** reliable on its own — a requested agent can go idle but stay alive, still emitting idle notifications. `TaskStop(task_id: "<agent-name>")` is what actually terminates it, and it is safe to call on an agent that has already exited. Never treat a sent `shutdown_request` as proof the agent is gone; always follow through. There is nothing else to tear down — with a single implicit team per session, no team object is created and none is deleted.

## Agent Prompts

Each agent should:

- Read its corresponding skill in `.claude/skills/` for standards and checklists
- Read the full project source and root
- Implement fixes directly if its role grants edit tools; report-only agents deliver a severity-ranked findings report instead
- Verify the build passes after changes (`npm run typecheck`)
- Send a findings summary to the team lead: `SendMessage(to: "team-lead", message: <summary>, summary: "<5–10 word preview>")`
- Mark its task as completed: `TaskUpdate(taskId: <task_id>, status: "completed")`

If an agent's toolset lacks `SendMessage`/`TaskUpdate`, it finishes silently — verify its output directly and do the task bookkeeping yourself.

### Architecture (Task 1)

Audit for: module pattern adherence, file structure conventions, naming (kebab-case files, PascalCase classes/components, camelCase functions), dependency rules (no circular deps), import paths (through index.ts), type exports in a types module, entry point kept lifecycle-only, index.ts as public API. Fix all issues.

### Security Pass 1 (Task 2)

Full audit per the general-purpose agent's own checklist — and `.claude/skills/security-audit/SKILL.md` where the project has that skill, as the source of truth for grep patterns and the severity rubric. Apply fixes if your role permits edits; otherwise deliver a severity-ranked findings report and do not modify code.

### Toolkit integrity (Task 3)

Run the toolkit's own checks in order and report violations:

1. `npm run validate` — manifests parse, frontmatter is complete, every placeholder is declared
2. `npm test` — installer suite passes
3. `node installer/cli.mjs render --allow-unreleased && node installer/cli.mjs doctor` — rendered output matches the lock (no hand-edits to generated `.claude/` files). The flag is required (#373): `render` refuses from a toolkit that is not at a release tag, and a branch checkout never is; plain `doctor` is not gated and needs nothing.
4. Spot-check changed stacks: every placeholder used in content is declared in that `stack.yaml`; `setup:` notes contain no placeholders

Fix what your role permits (source side only, then re-render); otherwise report each failure with the command output quoted.

### Docs-Agent (Task 4)

Create/update the machine docs — a single root `AGENTS.md` registry. Machine-readable format and required sections per `.claude/skills/docs-agent/SKILL.md` (the skill defines the file set).

### Docs-Human (Task 5)

Create/update the human docs — `DECISIONS.md`, `STATUS.md`, and `ARCHITECTURE.md` at the repo root — per `.claude/skills/docs-human/SKILL.md` (the skill defines the file set, sections, and guardrails). Derive from codebase and machine docs.

### Security Pass 2 (Task 6)

Repeat the full security audit checklist. Focus especially on: new files created by earlier agents, any content written to project root, ensuring no sensitive information was documented, all previous fixes still intact. Same fix-or-report behavior as pass 1.

## Focus Area

If `$ARGUMENTS` is provided, instruct all agents to pay special attention to that area while still performing their full audit. For example: `/audit data pipeline` focuses extra attention on the data-layer modules.

## Summary Format

After all agents complete, present:

```
## Audit Complete

| # | Agent | Findings | Fixes Applied |
|---|-------|----------|---------------|
| 1 | harness-architect | N issues | brief list |
| 2 | general-purpose (pass 1) | N issues | brief list |
| 3 | general-purpose (Toolkit integrity) | N issues | brief list or "clean" |
| 4 | docs-agent | N files created/updated | file list |
| 5 | docs-human | N files created/updated | file list |
| 6 | general-purpose (pass 2) | N issues | brief list or "clean" |

Build status: passing/failing
```
