---
name: audit
description: Run a full codebase audit chain — architecture, security, toolkit integrity, machine docs, human docs, then security again. Creates a team, spawns agents consecutively, and reports results.
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

### 1. Create Team

```
TeamCreate(team_name: "audit-{timestamp}")
```

### 2. Create Tasks with Dependencies

```
task1 = TaskCreate(description: "architecture audit", team_name: "audit-{timestamp}")
task2 = TaskCreate(description: "security pass 1", team_name: "audit-{timestamp}", addBlockedBy: [task1.id])
task3 = TaskCreate(description: "Toolkit integrity check", team_name: "audit-{timestamp}", addBlockedBy: [task2.id])
task4 = TaskCreate(description: "docs-agent", team_name: "audit-{timestamp}", addBlockedBy: [task3.id])
task5 = TaskCreate(description: "docs-human", team_name: "audit-{timestamp}", addBlockedBy: [task4.id])
task6 = TaskCreate(description: "security pass 2", team_name: "audit-{timestamp}", addBlockedBy: [task5.id])
```

### 3. Spawn Agents Sequentially

For each step, spawn the agent into the team, wait for completion, then proceed:

```
Agent(
  subagent_type: "harness-architect",
  team_name: "audit-{timestamp}",
  name: "architecture-pass",
  prompt: <architecture prompt>
)
# After completion:
TaskUpdate(id: task1.id, status: "completed")
```

```
Agent(
  subagent_type: "general-purpose",
  team_name: "audit-{timestamp}",
  name: "security-pass1",
  prompt: <security pass 1 prompt>
)
TaskUpdate(id: task2.id, status: "completed")
```

**Gate after pass 1:** present the security findings to the user. Do **not** auto-proceed if there are Critical or High findings — wait for the fixes (by the user or the architecture agent) or an explicit override before continuing the chain.

```
Agent(
  subagent_type: "general-purpose",
  team_name: "audit-{timestamp}",
  name: "toolkit-integrity",
  prompt: <Toolkit integrity check prompt>
)
TaskUpdate(id: task3.id, status: "completed")
```

```
Agent(
  subagent_type: "docs-agent",
  team_name: "audit-{timestamp}",
  name: "docs-agent",
  prompt: <docs-agent prompt>
)
TaskUpdate(id: task4.id, status: "completed")
```

```
Agent(
  subagent_type: "docs-human",
  team_name: "audit-{timestamp}",
  name: "docs-human",
  prompt: <docs-human prompt>
)
TaskUpdate(id: task5.id, status: "completed")
```

```
Agent(
  subagent_type: "general-purpose",
  team_name: "audit-{timestamp}",
  name: "security-final",
  prompt: <security pass 2 prompt>
)
TaskUpdate(id: task6.id, status: "completed")
```

### 4. Summary and Cleanup

After all 6 complete, present the user a consolidated summary table of findings and fixes per agent, then clean up:

```
SendMessage(type: "shutdown_request", to: "architecture-pass")
SendMessage(type: "shutdown_request", to: "security-pass1")
SendMessage(type: "shutdown_request", to: "toolkit-integrity")
SendMessage(type: "shutdown_request", to: "docs-agent")
SendMessage(type: "shutdown_request", to: "docs-human")
SendMessage(type: "shutdown_request", to: "security-final")
TeamDelete(team_name: "audit-{timestamp}")
```

## Agent Prompts

Each agent should:

- Read its corresponding skill in `.claude/skills/` for standards and checklists
- Read the full project source and root
- Implement fixes directly if its role grants edit tools; report-only agents deliver a severity-ranked findings report instead
- Verify the build passes after changes (`npm run validate`)
- Send a findings summary to the team lead: `SendMessage(to: "team-lead", content: <summary>)`
- Mark its task as completed: `TaskUpdate(id: <task_id>, status: "completed")`

If an agent's toolset lacks `SendMessage`/`TaskUpdate`, it finishes silently — verify its output directly and do the task bookkeeping yourself.

### Architecture (Task 1)

Audit for: module pattern adherence, file structure conventions, naming (kebab-case files, PascalCase classes/components, camelCase functions), dependency rules (no circular deps), import paths (through index.ts), type exports in a types module, entry point kept lifecycle-only, index.ts as public API. Fix all issues.

### Security Pass 1 (Task 2)

Full audit per the general-purpose agent's own checklist — and `.claude/skills/security-audit/SKILL.md` where the project has that skill, as the source of truth for grep patterns and the severity rubric. Apply fixes if your role permits edits; otherwise deliver a severity-ranked findings report and do not modify code.

### Toolkit integrity (Task 3)

Run the toolkit's own checks in order and report violations:

1. `npm run validate` — manifests parse, frontmatter is complete, every placeholder is declared
2. `npm test` — installer suite passes
3. `node installer/cli.mjs render && node installer/cli.mjs doctor` — rendered output matches the lock (no hand-edits to generated `.claude/` files)
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
