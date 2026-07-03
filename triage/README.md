# triage/ — round-1 parking lot for #38

This folder is the maintainer's triage surface for the bundle reorganization
(#38). It holds the resources that could not be regrouped mechanically —
name collisions and near-duplicate roles — moved here verbatim (`git mv`,
content untouched) with their origin paths preserved
(`triage/<origin-bundle>/<kind>/<name>`).

Nothing under `triage/` is read by the render/validate pipeline: `loadToolkit`
only walks `bundles/<name>/` for names listed in `toolkit.yaml`, and `npm pack`
does not ship this folder. Parked items therefore no longer render into
consuming projects until a triage decision restores them.

## How triage works

1. For each item below, record a decision: **keep** (restore to a bundle),
   **merge** (fold its unique content into its counterpart — becomes a content
   PR, out of round-1 scope), **rename** (restore under a new item name to
   break a collision), or **drop** (delete).
2. Decisions are applied in follow-up rounds **on the same PR** until this
   folder is empty; the pipeline must stay green at every round.
3. Finalize: remove `triage/`, reconcile `toolkit.yaml` / `.waffle.yaml` /
   `requires:` edges, update the bundle tables in `AGENTS.md`, `STATUS.md`,
   `ARCHITECTURE.md`, and file the content-fix follow-up issues.

**Restore mechanics** (per item): `git mv` the file/dir back under
`bundles/<bundle>/`, re-add its entry to that bundle's `agents:`/`skills:`
list, paste its config keys from `triage/<origin>/bundle-fragment.yaml`
(shared keys that other items also use are still declared — the fragment says
which), then `npm run validate && npm test && node installer/cli.mjs render &&
node installer/cli.mjs doctor`. Restoring `designer` additionally means
recreating `bundles/design/` from `triage/design/bundle-fragment.yaml` (the
complete former manifest) and re-adding `design` to `toolkit.yaml`, or picking
a different destination bundle.

## Decision summary

| # | Parked item | Origin | Conflicts with | Decision needed |
|---|-------------|--------|----------------|-----------------|
| 1 | `skills/security-audit` (desktop-plugin variant) | code-quality | #2 (same rendered path) | keep one / rename one / merge |
| 2 | `skills/security-audit` (browser-app variant) | engineering-team | #1 (same rendered path) | keep one / rename one / merge |
| 3 | `agents/security` | code-quality | #4 (role overlap) | keep / merge / drop |
| 4 | `agents/security-engineer` | engineering-team | #3 (role overlap) | keep / merge / drop |
| 5 | `agents/designer` | design (dissolved) | #6 (role overlap) | keep (+ destination bundle) / merge / drop |
| 6 | `agents/ux-designer` | engineering-team | #5 (role overlap) | keep / merge / drop |
| 7 | `agents/product-manager` | engineering-team | `orchestration/agents/project-manager` (dogfooded, not parked) | keep / merge / drop |
| 8 | `agents/architect` | code-quality | #9–#11 (architect class) | keep / merge / drop |
| 9 | `agents/mobile-architect` | expo-dev | #8–#11 (architect class) | keep / merge / drop |
| 10 | `agents/plugin-architect` | obsidian-dev | #8–#11 (architect class) | keep / merge / drop |
| 11 | `agents/lead-developer` | engineering-team | #8–#10 (architect class) | keep / merge / drop |

---

## Cluster A — `security-audit` skill collision (items 1–2)

The only **hard render error** in the toolkit: both skills render to
`.claude/skills/security-audit/`, so enabling both origin bundles failed
(`STATUS.md` known issue). Parking both resolves the collision in-tree;
at most one may come back under this name.

### 1. `triage/code-quality/skills/security-audit/`

- **Origin:** `code-quality` (imported from an Obsidian-plugin repo).
- **Variant:** desktop-plugin threat model — secret detection, command
  injection into shelled-out tools (`security.externalTools`,
  `security.mediaFetchTool`), `.gitignore` enforcement, Obsidian `saveData()`
  settings storage (leaky reference).
- **Config keys (in fragment):** `project.name`, `security.skillGitignore`,
  `security.dataDir`, `security.externalTools`, `security.mediaFetchTool`.
- **Decision needed:** keep vs. #2 (rename one — e.g. `security-audit-plugin`
  — if both survive), and whether it follows its companion `agents/security`
  (#3). If kept, it needs de-Obsidianifying (follow-up issue at finalize).

### 2. `triage/engineering-team/skills/security-audit/`

- **Origin:** `engineering-team` (imported from a browser-app repo).
- **Variant:** browser-delivered app threat model — XSS, untrusted external
  data (`sec.dataSource`), dependency audit (`sec.auditCmd`), no-secrets-in-
  build-output scan (`project.buildCmd`, `project.lockfile`).
- **Config keys (in fragment):** `sec.threatModelIntro`, `sec.dataSource`,
  `sec.auditCmd`, `project.lockfile` (+ shared `project.name`,
  `project.buildCmd` still declared in the live bundle).
- **Decision needed:** keep vs. #1 (or rename to e.g. `security-audit-webapp`
  if both survive), and whether it follows `security-engineer` (#4), whose
  audit checklist it implements.

## Cluster B — security agents (items 3–4)

Near-duplicate roles with misaligned intentions: one fixes, one only reports.

### 3. `triage/code-quality/agents/security.md`

- **Origin:** `code-quality`.
- **Counterpart:** #4 `security-engineer`.
- **Role:** read-**write** security auditor (tools include Write/Edit/Bash) —
  reviews AND "implements security guardrails". Frontmatter `skills:` pulls
  `security-audit` (#1), `git-workflow`, `issue`.
- **Config keys (in fragment):** `security.agentGitignore`,
  `security.threatModel` (+ shared `project.longName`).
- **Decision needed:** keep one security role or both? If one: which posture
  wins (remediating vs. read-only), and does the survivor pair with the
  surviving `security-audit` variant from cluster A?

### 4. `triage/engineering-team/agents/security-engineer.md`

- **Origin:** `engineering-team`.
- **Counterpart:** #3 `security`.
- **Role:** read-**only** by design ("you never modify code — the author owns
  the fix"); tools are Read/Grep/Glob/Bash/WebSearch. No frontmatter skills.
- **Config keys (in fragment):** `sec.scope`, `sec.dataSource`, `sec.auditCmd`.
- **Decision needed:** same as #3 — pick a posture, or merge the guardrail
  content of #3 into this skeleton.

## Cluster C — design agents (items 5–6)

### 5. `triage/design/agents/designer.md`

- **Origin:** `design` — the bundle's **only** item, so the bundle was
  dissolved in round 1 (full former manifest preserved at
  `triage/design/bundle-fragment.yaml`; maintainer can veto by restoring it).
- **Counterpart:** #6 `ux-designer`.
- **Role:** brand-asset producer — hand-written SVG logos/icons/banners with a
  local render-verification loop. Extra leaks: frontmatter references a
  `brand-guidelines` skill that exists nowhere in the toolkit, and prose
  mentions a nonexistent `brand-manager` agent.
- **Config keys (in fragment):** `brand.assetsDir`, `brand.background`,
  `project.name`, `project.longName`.
- **Decision needed:** distinct enough from #6 (brand assets vs. product UI)
  to keep both? If kept: destination bundle (revive `design`, or fold into
  another bundle). If merged/dropped: confirm `design` stays dissolved.

### 6. `triage/engineering-team/agents/ux-designer.md`

- **Origin:** `engineering-team`.
- **Counterpart:** #5 `designer`.
- **Role:** product-UI/component designer — screens, UI primitives, chart
  layouts, a11y checks ("concrete, implementable designs, not mood boards").
- **Config keys (in fragment):** `ux.guidelines`.
- **Decision needed:** keep alongside #5 (different jobs) or collapse to one
  design role; if kept, does it stay in `engineering-team`'s roster?

## Cluster D — product/project management (item 7)

### 7. `triage/engineering-team/agents/product-manager.md`

- **Origin:** `engineering-team`.
- **Counterpart:** `orchestration/agents/project-manager` — **not parked**:
  it is dogfooded by this repo's `.waffle.yaml` (orchestration is rendered
  into wafflestack itself), so parking it would break the self-hosted render.
  Flagged in the round-1 audit instead.
- **Role:** product strategy/discovery — user stories, acceptance criteria,
  backlog priority (`pm.brief` / `pm.principles` / `pm.handoffs` config).
  The counterpart is a delivery coordinator (assigns issues to specialists,
  runs boards). Overlapping names, adjacent-but-different jobs.
- **Config keys (in fragment):** `pm.brief`, `pm.principles`, `pm.handoffs`
  (+ shared `planner.productDocsDir`, `project.name`).
- **Decision needed:** keep both roles (clarify the split: product vs.
  project), restore this one to `engineering-team`, or drop/merge into
  `project-manager`.

## Cluster E — architect-class agents (items 8–11)

Four agents that all claim architecture/tech-lead authority. Enabling several
bundles used to stack them with no seniority rule. Likely outcome: one
generic architecture lead + per-stack specialists, or per-stack only.

### 8. `triage/code-quality/agents/architect.md`

- **Origin:** `code-quality`.
- **Role:** codebase-architecture auditor (file structure, module patterns,
  naming, dependency rules). **Hard cross-bundle dep:** frontmatter `skills:`
  pulls `obsidian-plugin-dev` (obsidian-dev bundle) — an Obsidian leak in a
  nominally generic bundle — plus `codebase-architecture`, `tdd`,
  `git-workflow`, `issue`.
- **Config keys:** none of its own (shared `project.longName` still declared).
- **Note:** `orchestration`'s `roster.architectAgent` config **default** is
  `architect` (and `roster.securityAgent` default is `security`, #3) — any
  consumer relying on those defaults now needs an explicit roster value until
  triage settles. Both defaults are flagged for the finalize round.
- **Decision needed:** survive as the generic architecture agent (after
  de-Obsidianifying), or yield to #11 / the per-stack architects.

### 9. `triage/expo-dev/agents/mobile-architect.md`

- **Origin:** `expo-dev`.
- **Role:** Expo/React-Native architecture specialist (navigation, native
  config, build/release). Frontmatter `skills:` pulls `expo-ui`,
  `expo-app-dev` (its own former bundle) + `tdd` (code-quality),
  `git-workflow`, `issue`.
- **Config keys (in fragment):** `project.longName`.
- **Decision needed:** keep as the domain architect of `expo-dev` (restore),
  or fold the architect role into a single generic agent parameterized per
  stack.

### 10. `triage/obsidian-dev/agents/plugin-architect.md`

- **Origin:** `obsidian-dev`.
- **Role:** Obsidian plugin architecture specialist. Frontmatter `skills:`
  pulls `obsidian-plugin-dev` + `tdd` (code-quality), `git-workflow`, `issue`.
- **Config keys:** none (all `plugin.*` keys belong to the
  `obsidian-plugin-dev` skill and stay live).
- **Note:** `orchestration`'s `audit.complianceAgentType` config **default**
  is `plugin-architect` (this repo's `.waffle.yaml` overrides it to
  `general-purpose`, so the dogfooded render is unaffected). Follow-up issue
  at finalize.
- **Decision needed:** same as #9 — restore as `obsidian-dev`'s domain
  architect or consolidate.

### 11. `triage/engineering-team/agents/lead-developer.md`

- **Origin:** `engineering-team`.
- **Role:** tech lead / gatekeeper (opus): sets direction, gatekeeps
  dependencies, reviews non-trivial changes, delegates to the specialist
  roster (`lead.delegation`). Broader than the architects but overlaps all
  of them on architecture authority.
- **Config keys (in fragment):** `lead.stack`, `lead.structure`,
  `lead.delegation`.
- **Decision needed:** is the lead role distinct from the architect role
  (keep both #8 and #11 with a seniority rule), or is one the other's
  replacement?
