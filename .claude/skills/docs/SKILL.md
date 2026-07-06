---
name: docs
description: Orchestrates documentation updates by spawning the general-purpose, docs-agent, and docs-human agents in sequence. The first pass audits the codebase and reports changes, docs-agent writes machine-readable docs, docs-human writes human-readable docs.
user-invocable: true
---

# Documentation Orchestration

When this skill is invoked, run the following pipeline:

## Step 1: Architecture Audit

Spawn the `general-purpose` agent with this prompt:

> Audit the current codebase for any changes since the docs were last updated. Read the existing machine docs (a single root `AGENTS.md` registry) and compare against the actual project. Produce a concise **change report** covering:
>
> - New or removed stacks, skills, agents, config keys, or CLI commands
- Changed installer exports or template semantics (`installer/lib/*.mjs`)
- `stack.yaml` config declarations out of sync with placeholder usage
- Rendered-output drift: `node installer/cli.mjs doctor --allow-missing` clean
  (committed render + lock in sync — re-render and commit after stack edits);
  `.gitignore` still covers the deliberately-untracked renders (label-hook
  workflow, worktrees, `.waffle/` overview docs)
>
> Output ONLY the change report as structured text. Do NOT modify any files.

## Step 2: Agent Documentation

Take the change report and spawn the `docs-agent` agent with this prompt:

> Here is the architecture change report for the wafflestack codebase:
>
> {step-1 output}
>
> Update the machine docs — a single root `AGENTS.md` registry — to reflect the current state of the project. Read the actual source files to verify details — do not rely solely on the change report. Follow the docs-agent skill guidelines for format and structure.

## Step 3: Human Documentation

After docs-agent completes, spawn the `docs-human` agent with this prompt:

> The machine docs have just been updated. Update the human-facing documentation — `DECISIONS.md`, `STATUS.md`, and `ARCHITECTURE.md` at the repo root — to match.
>
> Read the updated machine docs and the actual source to ensure accuracy. Follow the docs-human skill guidelines for format, structure, and its guardrails (owner-voiced docs are flagged, never rewritten).

## Important

- Each step must complete before the next begins — the output of each informs the next.
- Step 1 is **read-only** — the audit agent only reports.
- docs-agent and docs-human SHOULD modify their respective documentation files.
