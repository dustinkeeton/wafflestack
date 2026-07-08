# Authoring a third-party stack

wafflestack renders **canonical, harness-neutral** agents, skills, and syrup from stacks into a
consuming project. A stack does not have to live in the built-in toolkit: you can author one in
your own repository and have a project pull it in as an **external `source`** alongside the
built-ins, so **one render/lock/`doctor` pipeline handles built-in and external stacks alike**.
This document is the author's side of that contract — the repo layout your source must present,
how you version it and how consumers pin a `ref`, how a consumer is carried across your changes,
and a worked minimal example.

It assumes the vocabulary and rules of [`FORMAT.md`](FORMAT.md) — a *waffle* (an installable agent
or skill), a *stack* (a named group of waffles), *syrup* (the generic `files/` payload), the
`stack.yaml` manifest, and the render/lock/`doctor` frozen-image contract. **An external stack is
authored exactly like a built-in one**: everything in `FORMAT.md` about manifests, templating,
config, `requires:`, and `optIn:` applies unchanged. This doc covers only what is specific to
shipping a stack from *outside* the toolkit. Read `FORMAT.md` first; read the
*External stack sources* section there for the **consumer** side (the `stacks:` mapping that pulls
your stack in) — this is the mirror of it.

## Two source layouts

A consumer's `stacks:` entry names your source and a stack within it:

```yaml
stacks:
  - name: acme-process                             # the stack to select
    source: https://github.com/acme/waffle-stacks  # your repo (git URL or local path)
    ref: v1.2.0                                     # git sources: required pin
```

At render, that `source` is resolved to a directory on disk and the entry's `name` selects one
stack from it. Your repository may present that stack in **either** of two shapes:

**1. Toolkit-root (multi-stack).** The same shape the built-in toolkit uses — one or more stacks
under `stacks/<name>/`. The consumer's `name:` selects `stacks/<name>/`, so it **must match the
directory name**. Ship several stacks from one repo this way.

```
your-repo/
  toolkit.yaml                       # optional registry (see "Linting" below)
  stacks/
    acme-process/
      stack.yaml
      skills/<name>/SKILL.md
      agents/<name>.md
      files/<repo-rel-path>
      evals/<name>.eval.yaml         # optional Layer 2 cases (colocated; ship with the stack)
    acme-security/
      stack.yaml
      ...
```

**2. Single-stack.** A `stack.yaml` at the repository root, with `agents/`, `skills/`, and
`files/` beside it. The consumer's `name:` is the label the stack renders under; by convention
set it equal to the `name:` your `stack.yaml` declares.

```
your-repo/
  stack.yaml
  skills/<name>/SKILL.md
  agents/<name>.md
  files/<repo-rel-path>
  evals/<name>.eval.yaml
```

Resolution prefers the toolkit-root shape: it looks for `stacks/<name>/stack.yaml` first, then a
`stack.yaml` at the source root. If neither exists the render fails, naming both paths it looked
for. **A stack `name` must be unique across every one of the consumer's `stacks:` entries** —
built-in and external. A name your source defines that a built-in stack (or another source)
already defines is a **hard error naming both sources**, never a silent shadow; pick a
distinctive name.

## Required layout: `stack.yaml`, `agents/`, `skills/`, `files/`

Your stack's `stack.yaml` is the **same manifest** a built-in stack uses — see the *stack.yaml*
section of `FORMAT.md` for the full reference. Nothing about it changes because the stack is
external:

- **`name`** / **`description`** — required. `description` is surfaced in the consumer's generated
  overview docs.
- **`agents:`** / **`skills:`** / **`files:`** — the payloads, authored under `agents/<name>.md`,
  `skills/<name>/SKILL.md`, and `files/<repo-relative-path>` exactly as in `FORMAT.md`. Agents and
  skills render to the consumer's harness dirs (`.claude/`, `.codex/`, `.agents/`); syrup `files/`
  render verbatim to their repo-relative path.
- **`config:`** — the template keys your content may reference (`{{dotted.key}}`), each with
  `required` / `default` / `description` and an optional `pattern:` guard. Only declared keys are
  substituted; every declared key must be referenced by your content, and every `{{dotted.key}}`
  your content references must be declared (the lint below enforces both).
- **`requires:`** — cross-item dependency edges, resolved against the **whole merged toolkit**, so
  your stack may legitimately depend on a built-in item (e.g. `skills/git-workflow`). Qualify an
  ambiguous dependency as `<stack>/skills/<name>`.
- **`optIn:`** — sensitive syrup poured only on request. **Mark any `files/` payload that demands
  elevated permissions** (a workflow needing repo write, a scheduled job that spends money) as
  opt-in: enabling your stack then does *not* render it — the consumer installs it explicitly or
  keeps an existing install alive via the lock. This matters more for an external stack: your
  opt-in syrup crosses a trust boundary (see *The consumer install-time gate* below).
- **`env:`** / **`setup:`** — env-var prerequisites (warned when any item renders) and free-text
  install notes surfaced verbatim by `wafflestack setup`. `setup:` runs before any project config
  exists, so it must not use `{{placeholders}}` — refer to config keys by name.

The reserved **`harness.*`** namespace (authorship attribution, skills dir — resolved per output
target) is available to your content without being declared, exactly as for a built-in stack.

## Versioning and pinning (`ref`)

How a `source` is classified and pinned is fixed by the consumer contract; author to it:

- **A git source is pinned, always.** Anything with a URL scheme (`https://`, `git://`, `ssh://`),
  an scp-style `git@host:owner/repo` address, or a `.git` suffix classifies as **git**, and a git
  source **requires a `ref:`** — a tag, branch, or commit. Pinning is mandatory so an external
  install is reproducible. (A `source`/`ref` may not begin with `-`; it would be read as a git
  option. Real URLs and refs never do.)
- **A local path carries no `ref`.** Anything else is a **local filesystem path**, resolved
  relative to the consumer repo and read in place; a `ref:` on it is an error. Use a local path
  for development and monorepo-internal stacks; use a git source for distribution.

**Cutting a version.** Tag your repo. Semver tags are strongly recommended — an **immutable tag is
a reproducible pin**: a consumer on `ref: v1.2.0` re-renders to the same bytes forever, and
`upgrade` re-fetching that tag observes no move. A **branch ref is mutable**: `wafflestack upgrade`
re-fetches it and picks up whatever it now points at, which is rarely what a consumer wants for a
third-party dependency. So:

1. Get the stack rendering cleanly in a test consumer (see the gate below).
2. Update your changelog for the release.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.

**Adopting a version (consumer side).** A consumer moves to a new release by editing `ref:` in
`.waffle/waffle.yaml` and running `wafflestack render` (or `install` / `upgrade`) — a changed
`ref` fetches the new pin and re-renders. `wafflestack upgrade` additionally re-resolves every
pinned source, so a consumer tracking a **branch** sees it advance and gets a per-source move
report: `source acme-process (ref main) moved <old> → <new>`.

**Reserve breaking changes for a major tag.** Because a consumer chooses when to bump `ref`, prefer
additive, backward-compatible changes within a major version; save anything that forces a consumer
to edit their `waffle.yaml` (below) for a new major tag, and call it out in the changelog.

## Carrying consumers across versions (the migration story)

`FORMAT.md` and `installer/lib/migrations.mjs` describe the toolkit's migration mechanism: an
ordered list of version-keyed steps (`{ version, description, run(cwd) }`) that `wafflestack
upgrade` applies in ascending order to carry a consumer across a **breaking change to the
consumer's own `.waffle/` files** — a dotfile rename, a renamed config key. That mechanism is
**internal to the installer and keyed to the wafflestack toolkit version**, not to your stack's
`ref`, and it is **not extensible by a third-party stack** — there is no hook for a source to
register `run(cwd)` steps. **Do not plan to ship executable migration steps.**

What carries a consumer across *your* changes is the machinery you already have — **versioned refs
plus the frozen-image re-render** — backed by a human-readable changelog for the few changes a
consumer must act on:

- **Content edits, renamed items, and removed items need no migration.** When a consumer moves
  their pin and re-renders, the frozen-image contract re-renders your new content and **prunes
  every file your new version no longer produces**: rename a skill and its old
  `.claude/skills/<old>/` is deleted and the new directory written; drop an agent and its rendered
  file disappears. This is the same "pure content changes need no migration; `render` already
  regenerates them" rule the built-in mechanism relies on — it applies to your stack's rendered
  output because it flows through the identical pipeline and lock.
- **Changes that require a consumer to edit `waffle.yaml` are guided by your changelog — and the
  CLI makes them loud.** A newly-**required** `config:` key fails the consumer's render with the
  exact `config.<key>` to add. A renamed stack **`name`**, or a renamed item ref a consumer had
  pinned in their `include:`, surfaces as a resolution error naming the bad ref. Newly-added
  **opt-in syrup** stays un-poured until the consumer installs it. None of these can be applied for
  the consumer, so **document each one in your changelog** as an explicit upgrade step for the
  `ref` bump that introduces it.
- **`upgrade` reconciles and reports.** After re-fetching each pin, `upgrade` re-renders and runs
  `doctor`, so the consumer's tree is brought into line and any residual drift is reported —
  attributed to your source.

## The consumer install-time gate (validation) and the trust boundary

Because your stack is authored outside the consuming repo, two guards apply at the consumer's
render — plan for both:

- **Your stack is fully linted at the consumer's render, before a single file is written.** The
  render runs the **same lint** the toolkit's own `validate` runs (missing frontmatter
  `description`/`name`, an undeclared or unreferenced `{{key}}`, a dangling `requires:`/`optIn:`
  ref, a bad `pattern:`) over every external stack, and a problem **fails the render loudly with a
  message naming your source** — e.g. `external stack "acme-process" (…@v1.2.0): agent reviewer
  missing frontmatter description — malformed external stack; fix it at the source before
  rendering`. The consumer cannot fix it; **you must fix it at the source and cut a new tag.** So
  validate before you tag.
- **Opt-in syrup from your source crosses a trust boundary.** When a consumer pours external
  opt-in syrup, the render emits an extra, clearly-worded acknowledgement — the content was
  authored *outside* the consumer's repo and may demand elevated permissions. The CLI is
  deliberately **non-interactive** (it warns; it does not prompt), so this surfaces as a warning
  the setup/install flow must put to the user, distinct from the ordinary opt-in. Keep your syrup
  minimal, mark anything sensitive `optIn:`, and describe exactly what it needs in `setup:`.

**Authoring test loop.** The practical way to exercise all of this is a scratch consumer repo that
points at your working tree via a **local-path source** (no `ref`), then render:

```bash
mkdir -p /tmp/consumer/.waffle && cd /tmp/consumer
cat > .waffle/waffle.yaml <<'YAML'
targets: [claude]
stacks:
  - name: acme-process
    source: /abs/path/to/your-repo   # local path → read in place, no ref
config:
  project.name: Test Project
YAML
npx github:dustinkeeton/wafflestack render   # runs the external-stack lint first, fails loudly if malformed
npx github:dustinkeeton/wafflestack doctor   # confirms the rendered tree matches the lock
```

**Linting as a toolkit.** `wafflestack validate` lints the toolkit it is *packaged with*, not an
arbitrary repo, so it will not lint your stack directly. The local-path render above is the
authoring feedback loop. If you lay your repo out as a toolkit root and add a `toolkit.yaml`
registry listing your stacks, the stack is discoverable as a first-class toolkit — useful if you
also vendor or fork the installer to run `validate` in your own CI.

## What the lock records about your source (provenance)

When your stack renders into a consumer repo, `.waffle/waffle.lock.json` gains a **`sources`**
block attributing every file your stack produced to its origin — one entry per external source
that rendered at least one file:

```json
"sources": [
  {
    "name": "acme-process",
    "source": "https://github.com/acme/waffle-stacks",
    "sourceType": "git",
    "ref": "v1.2.0",
    "commit": "9f3c1e2a…",          // resolved HEAD of the fetched ref (null for a local path)
    "files": [".claude/agents/reviewer.md", ".claude/skills/code-review-checklist/SKILL.md"]
  }
]
```

Built-in files carry no source entry (they stay toolkit-owned), and a consumer with no external
sources gets no `sources` block at all — a backward-compatible shape. This provenance is what lets
`doctor` **attribute drift** to your source (a hand-edited external file reports `— from
acme-process @ 9f3c1e2a` for a git source, or `— from acme-process (<path>)` for a local one) and
lets `upgrade` **diff resolved commits** to report per-source moves. You author nothing for this;
it is recorded automatically. It is why a distinctive stack `name` matters — the name uniquely
identifies your source throughout the lock and every drift/upgrade report.

## Worked example: a minimal external stack

A single-stack repository shipping one skill, one agent, and one opt-in syrup workflow.

```
acme-waffle-stacks/
  stack.yaml
  skills/
    code-review-checklist/
      SKILL.md
  agents/
    reviewer.md
  files/
    .github/workflows/acme-lint.yml
  CHANGELOG.md            # for your consumers; not consumed by wafflestack
```

`stack.yaml`:

```yaml
name: acme-process
description: Acme's code-review checklist skill, a reviewer agent, and a lint workflow.
skills: [code-review-checklist]
agents: [reviewer]
files:
  - .github/workflows/acme-lint.yml
optIn:
  - files/.github/workflows/acme-lint.yml   # a CI workflow → needs repo permissions → opt-in syrup
requires:
  agents/reviewer:
    - skills/code-review-checklist          # installing the agent pulls its checklist skill
config:
  project.name:
    required: true
    description: Project name, woven into the checklist prose.
```

`skills/code-review-checklist/SKILL.md`:

```markdown
---
name: code-review-checklist
description: Acme's review checklist for {{project.name}} pull requests.
---

# {{project.name}} review checklist

- [ ] Tests cover the change and pass.
- [ ] Public API changes are documented.
- [ ] No secrets or credentials in the diff.
```

`agents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews a {{project.name}} pull request against Acme's checklist.
skills:
  - code-review-checklist
claude:
  allowed-tools: Read, Grep, Bash
---

You are a code reviewer for {{project.name}}. Apply the `code-review-checklist` skill to the
current diff and report each item as pass or fail with a one-line justification.
```

Cut the first release once it renders clean in a test consumer:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

A consumer pulls it in from git, pinned, alongside a built-in stack:

```yaml
# .waffle/waffle.yaml
targets: [claude]
stacks:
  - github-workflow                             # built-in
  - name: acme-process                          # your external stack
    source: https://github.com/acme/acme-waffle-stacks
    ref: v1.0.0                                  # required for a git source
config:
  project.name: Acme
```

Enabling the stack renders the `reviewer` agent and the `code-review-checklist` skill (the lint
workflow, being `optIn:`, stays un-poured until the consumer runs `wafflestack install
files/.github/workflows/acme-lint.yml`). During development a consumer can instead point at a
local checkout — a path source takes **no `ref`**:

```yaml
stacks:
  - name: acme-process
    source: ../acme-waffle-stacks               # local path → read in place, no ref
```

## Author's pre-tag checklist

- [ ] The stack renders clean from a **local-path source** in a scratch consumer (`render` then
      `doctor` both pass) — this runs the same lint the toolkit's `validate` runs, scoped to your
      stack.
- [ ] `stack.yaml` has a `name` and `description`; the `name` is distinctive (won't collide with a
      built-in or another source).
- [ ] Every declared `config:` key is referenced by your content, and every `{{dotted.key}}` your
      content uses is declared; sensitive `pattern:`-guarded keys have a valid regex.
- [ ] Any `files/` payload needing elevated permissions is listed under `optIn:`, and `setup:`
      explains what it needs.
- [ ] `requires:` refs resolve (in-stack, or a qualified `<stack>/…` for a built-in dependency).
- [ ] The changelog records any consumer-facing action for this release (new required config key,
      renamed item/stack, new opt-in syrup).
- [ ] The release is an **immutable tag** (`vX.Y.Z`), so consumers pinning it get a reproducible
      install.
