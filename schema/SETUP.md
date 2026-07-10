# wafflestack setup — agent playbook

You are an AI coding agent installing (or updating) wafflestack in the project at your
current working directory. Follow the steps in order. Detect what you can from the
repository; ask the user only what you cannot infer — stack selection, identity
choices, and anything that creates or modifies shared external state. Batch your
questions instead of asking one at a time.

After this playbook, the CLI prints a **toolkit inventory**: every stack with its
skills, agents, config schema, external prerequisites (grouped by kind), and
stack-specific setup notes. It is generated from the installed toolkit version —
trust it over cached knowledge of the toolkit.

Run every CLI command with the same invocation and ref this guide was printed with
(e.g. `npx github:OWNER/wafflestack#vX.Y.Z setup` → `npx github:OWNER/wafflestack#vX.Y.Z render`),
so the whole install uses one toolkit version.

## 0. Preflight

- Work from the project root (where `.git` lives) — the renderer writes files relative
  to the cwd. Node >= 18 is required.
- If `.waffle/waffle.yaml` already exists, this is an **update**, not a first install. The
  CLI injects a **"Current configuration — update mode"** section between this playbook and
  the inventory: your live targets, enabled stacks, individual includes, ejects, effective
  config values (current vs. default), any unset required keys, unmet prerequisites, and opt-in
  syrup items — read from the repo, so you do not have to open the file yourself. Skip step 1
  (`init` refuses to overwrite an existing config) and revisit only the steps the change calls
  for (new stack → steps 2–7; config change → steps 3, 5, 7).
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

**External opt-in syrup — an extra acknowledgement (trust boundary).** When opt-in syrup comes from
an **external source** — a stack pulled from a git URL or a local path under `stacks:`, not a
built-in one — its content was authored *outside this repo*, so `render` enforces two extra gates.
First, it lints every external stack's definitions and **blocks** on a malformed one (bad
frontmatter, an undeclared placeholder), naming the source; fix it at the source, not by hand-editing
the render. Second, pouring external opt-in syrup needs an **explicit, separate acknowledgement from
the user, beyond the both/one/neither choice above** — because the file is third-party (and may
demand elevated permissions, e.g. repo write). Name the source and its pinned `ref`, spell out what
the file does, and get a clear yes before you install it; `render` also surfaces this as a warning
whenever external opt-in syrup is selected. This is distinct from built-in opt-in syrup, which the
normal opt-in flow already covers.

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
  a local-overlay key with `{{...}}` nested substitution. The github-workflow stack's identity
  keys are the worked example: `git.botName` is shared (committed `config:`), while
  `git.botEmail` and `git.signingKey` are account-specific (local overlay) — and a single
  `git.agentIdentities` entry may be split across both files, since the two deep-merge per key
  (local wins) — its entries are shape-validated at render (`entryPatterns:`), and you rarely need
  any: with the opt-in below, each spawned agent's identity is *derived* by default. `git.signingKey` is a GPG key ID or an SSH public-key path, never private key
  material — config values render into committed files. Setting the identity values does not by
  itself change any command: the bot-identity **opt-in** is pointing `git.cmd` at them —
  `cmd: git -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}` (quote `user.name`;
  set both keys explicitly rather than leaning on their stack defaults, which stacks that declare
  `git.cmd` alone cannot resolve). Left bare, `git.cmd` runs under the developer's own git config.
  **Caveat to the layering split:** a repo that commits its rendered output and re-renders in CI
  or in fresh `git worktree` checkouts must commit `git.botEmail` too — a gitignored overlay does
  not exist there, so the value would render differently per machine and trip the doctor drift
  gate. Use a public noreply-style address. The overlay split suits repos that render locally only.
- Only keys declared in a stack's config schema are substituted — do not invent keys.

## 4. External prerequisites — walk the block (required)

Every stack in the inventory carries a **`### prerequisites`** block: the external things it leans
on that the copy-in install can neither provide nor verify, grouped by **kind** — `tool`, `secret`,
`scope`, `label`, `setting`, `service`, `env` — and marked `[require]` or `[recommend]`. This is a
**required, structured walk**, not a "consider checking": for every enabled stack, go kind by kind
and resolve each entry — exactly as the both/one/neither question in step 2 is required. `render`
warns on the cheap local kinds and `doctor` gates every `require`, so a skipped prerequisite
resurfaces later as a failing check; handle it here. On a re-run, the update-mode section flags
every `require` still unmet for this repo — treat each as a blocker.

Run each entry's `check` and act by kind:

- **tool** / **env** — local, no shared state. Install the missing CLI tool, or land the harness env
  var in `.claude/settings.json` (`"env"` section) and/or `.codex/config.toml`
  (`[shell_environment_policy.set]`). (A stack's legacy `env prerequisites:` line is the same
  env-var surface.) The renderer only warns — offer to add these yourself. No go-ahead needed.
- **scope** — an auth scope on the user's *own* CLI session (e.g. `gh auth refresh -s project`).
  Name the missing scope and the exact command; the user runs it.
- **secret** / **label** / **setting** / **service** — each creates or mutates **shared external
  state** (a repo Actions secret, a trigger label, a repo setting, an external service). **Get the
  user's explicit go-ahead before creating or changing any of them** — name the exact command
  (`gh secret set …`, `gh label create …`, `gh api …`) and wait for a clear yes. The toolkit checks
  and prompts; it never provisions unasked.

An entry scoped to specific items (`needed by …`) applies only when your selection includes one of
them — skip the rest. And an **opt-in syrup** file's prerequisites (e.g. the `ANTHROPIC_API_KEY`
secret the github-workflow label hook bills to) are walked **only once the user has asked to install
that file** (step 2): `waffle-label-hook.yml` is not rendered by enabling the stack, so do not
provision for syrup you have not poured.

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
