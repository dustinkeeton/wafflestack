# wafflestack setup — agent playbook

You are an AI coding agent installing (or updating) wafflestack in the project at your
current working directory. Follow the steps in order. Detect what you can from the
repository; ask the user only what you cannot infer — bundle selection, identity
choices, and anything that creates or modifies shared external state. Batch your
questions instead of asking one at a time.

After this playbook, the CLI prints a **toolkit inventory**: every bundle with its
skills, agents, config schema, environment prerequisites, and bundle-specific setup
notes. It is generated from the installed toolkit version — trust it over cached
knowledge of the toolkit.

Run every CLI command with the same invocation and ref this guide was printed with
(e.g. `npx github:OWNER/wafflestack#vX.Y.Z setup` → `npx github:OWNER/wafflestack#vX.Y.Z render`),
so the whole install uses one toolkit version.

## 0. Preflight

- Work from the project root (where `.git` lives) — the renderer writes files relative
  to the cwd. Node >= 18 is required.
- If `.wafflestack.yaml` already exists, this is an **update**, not a first install:
  read it, skip step 1, and revisit only the steps the change calls for (new bundle →
  steps 2–7; config change → steps 3, 5, 7).
- Detect which harnesses the project uses and propose the `targets` list:
  - `claude` — a `.claude/` directory or `CLAUDE.md` exists, or you are Claude Code.
  - `codex` — a `.codex/` directory exists, or you are Codex.
  - `agents-dir` — a `.agents/` directory exists, or the user wants the cross-tool
    skills convention.
  Confirm the list with the user; fewer targets means less rendered noise.

## 1. Init

Run `wafflestack init` (via the pinned invocation). It writes a starter
`.wafflestack.yaml` and refuses to overwrite an existing one.

## 2. Choose bundles

Recommend bundles from the inventory based on repository signals — a GitHub remote
suggests the GitHub-workflow bundle, an Expo app the Expo bundle, and so on. Present
the recommendation with one line per bundle on what it adds, and let the user pick.
Two bundles that define a same-named item cannot both be enabled (the renderer refuses);
the inventory shows each bundle's item names.

## 3. Fill config values

Walk the config schema of every enabled bundle (from the inventory):

- **Required keys** must get a value or the render fails.
- **Defaulted keys**: check each default against reality before accepting it. Command
  defaults (`npm run build`, `npm test`, …) are wrong for many stacks — derive the real
  commands from `package.json` scripts, `Makefile`, `pyproject.toml`, or CI workflows,
  and confirm with the user when ambiguous. Multi-line defaults (label tables, prose
  sections) encode conventions — override them when the project's own taxonomy differs.
- **Layering**: shared values go in the committed `.wafflestack.yaml` under `config:`;
  account-specific values (bot emails, board IDs, tokens' owners) go in
  `.wafflestack.local.yaml`, which must be gitignored. A committed value may reference
  a local-overlay key with `{{...}}` nested substitution.
- Only keys declared in a bundle's config schema are substituted — do not invent keys.

## 4. External prerequisites

- **Env vars**: a bundle's `env` entries must land in `.claude/settings.json` (`"env"`
  section) and/or `.codex/config.toml` (`[shell_environment_policy.set]`). The renderer
  only warns — offer to add them yourself.
- **Services**: the inventory's per-bundle *setup notes* describe service-side
  prerequisites (CLI auth, labels, boards, webhooks). Verify each one. Anything that
  creates or modifies shared external state — labels on a shared repo, a project board —
  needs the user's explicit go-ahead first.

## 5. Render

Run `wafflestack render`. On error it lists the missing config values — fill them and
re-run until it exits cleanly, then read the warnings it printed (env prerequisites,
skipped items).

## 6. Version control

- **Commit**: `.wafflestack.yaml`, the rendered output (`.claude/`, `.codex/`,
  `.agents/`), and `.wafflestack.lock.json`. Teammates then get working agent files
  without running the installer, and `wafflestack doctor` can catch drift in CI.
- **Gitignore**: `.wafflestack.local.yaml`, always. Also the configured worktrees
  directory if a bundle declares one.
- **Exception — the toolkit repo itself**: when the project *is* the wafflestack source
  repo (self-hosting), gitignore the rendered output and the lock instead; committed
  copies would duplicate every skill in the tree.
- Tell the user the standing rule: never hand-edit rendered files — `render` overwrites
  them. Project-specific additions go in `.wafflestack/extensions/{agents,skills}/<name>.md`
  (committed) and take effect on the next render.

## 7. Verify and report

- Run `wafflestack doctor` — it must report that all managed files match the lock.
- Harnesses load skills and agents at session start: the user may need to restart
  their agent session before new slash commands appear.
- Report back: targets and bundles enabled; every config value chosen and where it
  lives (committed vs. local overlay); external resources created, verified, or
  skipped (with reasons); files rendered; and any follow-ups the user still owes
  (env vars they declined, boards that don't exist yet).
