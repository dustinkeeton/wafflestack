# wafflestack setup — agent playbook

You are an AI coding agent installing (or updating) wafflestack in the project at your
current working directory. Follow the steps in order. Detect what you can from the
repository; ask the user only what you cannot infer — stack selection, identity
choices, and anything that creates or modifies shared external state. Batch your
questions instead of asking one at a time.

After this playbook, the CLI prints a **toolkit inventory**: every stack with its
skills, agents, config schema, environment prerequisites, and stack-specific setup
notes. It is generated from the installed toolkit version — trust it over cached
knowledge of the toolkit.

Run every CLI command with the same invocation and ref this guide was printed with
(e.g. `npx github:OWNER/wafflestack#vX.Y.Z setup` → `npx github:OWNER/wafflestack#vX.Y.Z render`),
so the whole install uses one toolkit version.

## 0. Preflight

- Work from the project root (where `.git` lives) — the renderer writes files relative
  to the cwd. Node >= 18 is required.
- If `.waffle/waffle.yaml` already exists, this is an **update**, not a first install. The
  CLI injects a **"Current configuration — update mode"** section between this playbook and
  the inventory: your live targets, enabled stacks, individual includes, ejects, effective
  config values (current vs. default), any unset required keys, and opt-in syrup items — read from
  the repo, so you do not have to open the file yourself. Skip step 1 (`init` refuses to
  overwrite an existing config) and revisit only the steps the change calls for (new stack →
  steps 2–7; config change → steps 3, 5, 7).
- If instead a legacy root `.waffle.yaml` (pre-0.8.0) or `.wafflestack.yaml` (pre-0.6.0)
  exists, it is still read with a deprecation note; the next `render`/`upgrade` moves it
  and the other dotfiles into `.waffle/` in place. Afterwards, update the repo's
  `.gitignore` entries (`.waffle.local.yaml` → `.waffle/waffle.local.yaml`,
  `.waffle.lock.json` → `.waffle/waffle.lock.json`) — the auto-move never touches
  `.gitignore`; swap them yourself, or run `wafflestack install --gitignore` to re-add the
  `.waffle/` paths.
- Detect which harnesses the project uses and propose the `targets` list:
  - `claude` — a `.claude/` directory or `CLAUDE.md` exists, or you are Claude Code.
  - `codex` — a `.codex/` directory exists, or you are Codex.
  - `agents-dir` — a `.agents/` directory exists, or the user wants the cross-tool
    skills convention.
  Confirm the list with the user; fewer targets means less rendered noise.

## 1. Init

Run `wafflestack init` (via the pinned invocation). It writes a starter
`.waffle/waffle.yaml` and refuses to overwrite an existing one.

## 2. Choose stacks (or individual items)

Recommend stacks from the inventory based on repository signals — a GitHub remote
suggests the GitHub-workflow stack, an Expo app the Expo stack, and so on. Present
the recommendation with one line per stack on what it adds, and let the user pick.
Two stacks that define a same-named item cannot both be enabled (the renderer refuses);
the inventory shows each stack's item names.

You do not have to adopt a whole stack. When a project wants just one skill or agent,
select it individually — the inventory lists items in installable ref form
(`skills/<name>`, `agents/<name>`). Two ways to record the choice:

- Run `wafflestack install <ref…>` — it resolves each ref, appends stack refs to
  `stacks:` and item refs to a top-level `include:` list, then renders. It reports the
  dependency closure it pulled in.
- Or edit `.waffle/waffle.yaml` directly: stack names under `stacks:`, item refs under
  `include:`, then run `render`.

Refs: a stack name, `skills/<name>`, `agents/<name>`, or `<stack>/skills/<name>` when a
name appears in more than one stack (an unqualified ambiguous ref fails with the
candidates listed). Installing an item automatically pulls its dependency closure — an
agent's frontmatter `skills:` and any declared `requires:` — transitively and across
stacks, and required config is scoped to what the selected items actually use.

**Opt-in syrup items are opt-in — never pour them silently.** A stack's generic `files/`
payloads are called **syrup**; the inventory flags some as **opt-in syrup**: sensitive files
(e.g. a workflow that needs write permissions on the repo) that enabling their stack does
**not** render. The default is to leave them out — install one only on request, by its ref
(`wafflestack install files/<path>`), which renders it and persists it to `include:`. A repo
that already tracks an opt-in syrup path keeps it on re-render, so an existing install is never
dropped.

**Required — the both/one/neither question.** Some opt-in syrup *pairs with* a companion waffle
through a `requires:` edge, so selecting the companion leaves half a flow gated out and silent:
the github-workflow stack's `release` skill pairs with `waffle-release-hook.yml` (the tag-on-merge
half), `hygiene` with `waffle-hygiene.yml`, and `label-hook` with `waffle-label-hook.yml`. When
your selection pulls in the companion waffle (you enabled the stack, or included the skill) but
its opt-in syrup stays gated out, `render` prints a `warning:` naming the skipped syrup and the
exact `wafflestack install files/<path>` command — and the update-mode section above flags the
same pairing. Do **not** just accept that gap. Before you finish setup/install, put an explicit
**both / one / neither** choice to the user for each such pair:

- **both** — install the companion waffle *and* pour the syrup (`wafflestack install files/<path>`),
  then walk that file's prerequisites in step 4.
- **one** — keep only the companion waffle (the skill/agent) and leave the syrup out: the flow's
  manual half works, its automated half does not.
- **neither** — the user wants none of it; drop the companion too (`eject`/remove it from the
  selection).

Never silently leave a paired flow half-installed — that hole (a release skill with no tag hook)
is exactly what this question exists to close.

## 3. Fill config values

Walk the config schema of every enabled stack (from the inventory):

- **Required keys** must get a value or the render fails.
- **Defaulted keys**: check each default against reality before accepting it. Command
  defaults (`npm run build`, `npm test`, …) are wrong for many stacks — derive the real
  commands from `package.json` scripts, `Makefile`, `pyproject.toml`, or CI workflows,
  and confirm with the user when ambiguous. Multi-line defaults (label tables, prose
  sections) encode conventions — override them when the project's own taxonomy differs.
- **Layering**: shared values go in the committed `.waffle/waffle.yaml` under `config:`;
  account-specific values (bot emails, board IDs, tokens' owners) go in
  `.waffle/waffle.local.yaml`, which must be gitignored. A committed value may reference
  a local-overlay key with `{{...}}` nested substitution.
- Only keys declared in a stack's config schema are substituted — do not invent keys.

## 4. External prerequisites

- **Env vars**: a stack's `env` entries must land in `.claude/settings.json` (`"env"`
  section) and/or `.codex/config.toml` (`[shell_environment_policy.set]`). The renderer
  only warns — offer to add them yourself.
- **Services**: the inventory's per-stack *setup notes* describe service-side
  prerequisites (CLI auth, labels, boards, webhooks). Verify each one. Anything that
  creates or modifies shared external state — labels on a shared repo, a project board —
  needs the user's explicit go-ahead first. This includes repository **secrets** some
  workflows need (e.g. `ANTHROPIC_API_KEY` for the github-workflow label hook) — set them
  only with the user's explicit go-ahead (`gh secret set …`). That label hook
  (`waffle-label-hook.yml`) is an **opt-in syrup** file: it is not rendered by enabling the stack,
  so only walk its prerequisites once the user has asked to install it (step 2).

## 5. Render

Run `wafflestack render`. On error it lists the missing config values — fill them and
re-run until it exits cleanly, then read the warnings it printed (env prerequisites,
skipped items).

If the render **refuses to overwrite** a pre-existing file, that path already exists in the
repo and was not written by wafflestack (a hand-written file whose path a stack also
produces). Nothing is written on a refusal. Inspect each named file: if you want to keep
it, move it aside — or, for an agent/skill target, fold its additions into a
`.waffle/extensions/{agents,skills}/<name>.md` file — then re-render; if the toolkit's
version should win, re-run with `--force` (`wafflestack render --force`). A file whose
content is already byte-identical to the render is adopted silently, no flag needed.

## 6. Version control

- **Commit**: `.waffle/waffle.yaml`, the rendered output (`.claude/`, `.codex/`,
  `.agents/`), and `.waffle/waffle.lock.json`. Teammates then get working agent files
  without running the installer, and `wafflestack doctor` can catch drift in CI — the
  `github-workflow` stack ships an installable `.github/workflows/waffle-doctor.yml`
  that runs it on every push and pull request, so committing the render + lock is what makes
  that gate meaningful (set `doctor.flags: --allow-missing` if the repo gitignores some
  renders — only modified files fail).
- **Gitignore** — wafflestack never edits `.gitignore` *unasked*, so **offer** the entries
  and apply them on the user's approval. Propose the concrete lines, then either run
  `wafflestack install --gitignore` (it idempotently appends only the missing ones under a
  `# wafflestack` marker, preserving existing content) or hand-edit the file. Baseline:
  - `.waffle/waffle.local.yaml` — **always** (account-specific config must never be committed).
  - the configured `git.worktreesDir` when an enabled stack declares one (throwaway
    working state). `init --gitignore` seeds only the local overlay, since no stack is
    chosen yet; `install --gitignore` adds the worktrees dir once one is enabled.
- **Dev-only or self-hosting waffle**: when the render should *not* be committed — a
  consumer who wants the waffle only in their own working environment, or the wafflestack
  source repo itself (where committed copies would duplicate every skill in the tree) —
  also gitignore the rendered output (`.claude/`, `.codex/`, `.agents/`) and
  `.waffle/waffle.lock.json`, and set `doctor.flags: --allow-missing` (github-workflow
  stack) so the CI drift gate tolerates the deliberately-absent renders: only modified
  files fail, a missing lock still fails.
- Tell the user the standing rule: never hand-edit rendered files — `render` overwrites
  them. Project-specific additions go in `.waffle/extensions/{agents,skills}/<name>.md`
  (committed) and take effect on the next render.

## 7. Verify and report

- Run `wafflestack doctor` — it must report that all managed files match the lock.
- Harnesses load skills and agents at session start: the user may need to restart
  their agent session before new slash commands appear.
- Report back: targets and stacks enabled; every config value chosen and where it
  lives (committed vs. local overlay); external resources created, verified, or
  skipped (with reasons); the both/one/neither call for each opt-in syrup pairing
  (step 2) and which way the user went; files rendered; and any follow-ups the user
  still owes (env vars they declined, boards that don't exist yet).
