---
name: docs-agent
description: Machine-readable documentation standard optimized for LLMs and agents — structured, terse, explicit. Defines the project's machine-doc file set and format rules. Use when creating or updating documentation intended for AI consumption.
user-invocable: false
---

# Agent-Optimized Documentation

## Purpose

Produce documentation that LLMs and agents can parse efficiently. The machine docs for this project are a single root `AGENTS.md` registry. Prioritize:

- **Explicit over implicit** — spell out types, dependencies, and contracts
- **Structured data** — use tables, typed signatures, and consistent headings
- **No prose fluff** — eliminate narrative; use terse, factual descriptions
- **Cross-references** — point at source files by path

## Documentation Files

### `AGENTS.md` (root)

Single machine-doc registry for the toolkit. Contains:

- Project purpose (1-2 sentences)
- Stack registry: table of stacks with path, description, skills, agents
- Installer module registry: table of `installer/lib/*.mjs` files, one row per
  module with its purpose and export names (signatures live in source only)
- CLI command registry: table of `wafflestack <cmd>` commands with behavior
- Template semantics summary: placeholder syntax, `harness.*` namespace,
  nested substitution, extension points
- Consuming-project contract: config / local overlay / lock / extensions files
- Build/test commands

## Format Rules

1. Use language-tagged fenced code blocks (e.g. ```yaml) for examples
2. Use tables for registries and enumerations
3. Use `file.mjs:42` format for source references (line number after the colon)
4. No markdown emphasis (bold/italic) in structured sections
5. Frontmatter with `last-updated` timestamp (YYYY-MM-DD)
6. Keep the file's prose under 300 lines — the stack registry summarizes, and
   per-stack detail stays in each `stack.yaml`

## Protected docs — flag drift, don't rewrite

Docs passes don't rewrite these paths (globs allowed). If one has drifted
from reality, flag the drift in your report instead:

- `CHANGELOG.md`
- `.waffle/**`

This list does not cover the agent-managed docs — a single root `AGENTS.md` registry;
and `DECISIONS.md`, `STATUS.md`, and `ARCHITECTURE.md` at the repo root — which the doc writers update as usual.


