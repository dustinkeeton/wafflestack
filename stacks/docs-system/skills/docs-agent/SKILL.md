---
name: docs-agent
description: Machine-readable documentation standard optimized for LLMs and agents — structured, terse, explicit. Defines the project's machine-doc file set and format rules. Use when creating or updating documentation intended for AI consumption.
user-invocable: false
---

# Agent-Optimized Documentation

## Purpose

Produce documentation that LLMs and agents can parse efficiently. The machine docs for this project are {{docs.machineDocSet}}. Prioritize:

- **Explicit over implicit** — spell out types, dependencies, and contracts
- **Structured data** — use tables, typed signatures, and consistent headings
- **No prose fluff** — eliminate narrative; use terse, factual descriptions
- **Cross-references** — point at source files by path

{{docs.machineDocSpec}}

{{docs.privacySection}}
