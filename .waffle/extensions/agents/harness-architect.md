## WaffleStack grounding (this repo)

You are working inside **WaffleStack itself** — the toolkit that *renders* harness artifacts into consuming repos, and which self-hosts its own stacks. Here your generalized harness expertise is grounded in this stack's concrete mechanisms. When asked a "how do I…" question about the toolkit, answer with the real files below, not from generic intuition.

### Mental model

The source of truth is `stacks/**` — canonical, harness-neutral agent/skill/file definitions. The `wafflestack` CLI (`installer/cli.mjs`, exports mapped in `AGENTS.md`) renders them into harness-native output (`.claude/`, `.codex/`, `.agents/`). Rendered files are generated output — **never hand-edit them**; change the source, project config, or a project extension instead. In *this* repo the rendered `.claude/` output and `.waffle/waffle.lock.json` are gitignored (see `.waffle/waffle.yaml`), so after any `stacks/**` or `toolkit.yaml` edit you must re-render from the working tree: `node installer/cli.mjs render`.

### The registries and where the truth lives

- **`AGENTS.md`** (root) — the machine-readable registry: the stack table, the installer-module registry with full export signatures, the import graph, the CLI command table, item-ref grammar, template semantics, and the consuming-project contract. This is your map of the stack; read it first.
- **`schema/FORMAT.md`** — the owner-voiced authoring contract (do not rewrite it). It defines `stack.yaml`, the three payload types, template values, the `harness.*` namespace, and project extensions.
- **`schema/SETUP.md`** — the agent-facing install playbook surfaced by `wafflestack setup`.
- **`DECISIONS.md`** — the human decision log (ADRs) behind the contract; cite it for *why*.
- **`installer/lib/*.mjs`** — the render pipeline (see the import graph in `AGENTS.md`): `render.mjs` (selection → verbatim regeneration → stale prune → lock), `refs.mjs` (ref grammar + dependency closure, a pure leaf), `template.mjs` (`{{placeholder}}` substitution), `toolkit.mjs` (`loadStack` / manifest parsing), `project.mjs` (consumer config, targets, `harness.*` built-ins), `validate.mjs`, `doctor.mjs`, `setup.mjs`, `eject.mjs`, `upgrade.mjs`, `migrations.mjs`, `util.mjs`.

### The authoring contract (`schema/FORMAT.md`)

- A **stack** is `stacks/<name>/stack.yaml` (manifest: `name`, `description`, `agents`, `skills`, `files`, optional `requires`/`optIn`/`config`/`env`/`setup`) plus `agents/<name>.md`, `skills/<name>/SKILL.md`, and `files/<repo-relative-path>`.
- **Three payload types** share one render machinery: **agents** → `.claude/agents/<n>.md` (+ `.codex/agents/<n>.toml`); **skills** → `.claude/skills/<n>/` (+ `.agents/skills/<n>/`); **files** → verbatim to a repo-relative path, once, regardless of `targets:`.
- **Templating**: only keys **declared** in a stack's `config:` are substituted (plus the always-available `harness.*` namespace); every other `{{…}}`-looking run (bash, GitHub Actions `${{ }}`, mustache) passes through untouched. `validate` enforces the two-way sync: every declared key must be referenced, and every dotted-lowercase placeholder used must be declared. An agent body may reference `{{dotted.key}}` config and `{{harness.*}}`; the frontmatter `description` is the one frontmatter field that is also substituted.
- **Project extensions** (the mechanism that produced *this very section*): `.waffle/extensions/agents/<name>.md` and `.waffle/extensions/skills/<name>.md` are appended verbatim to the rendered item inside `<!-- BEGIN/END project extension -->` markers by `appendExtension` in `render.mjs`. Extension content is **not** template-substituted — it is appended after substitution runs — so never put `{{placeholders}}` in an extension file.

### The ADRs that govern the contract (`DECISIONS.md`)

- **One canonical source per item, rendered per harness** ("One canonical source per item…", v0.1.0). A reserved `harness.*` namespace resolves per output target and substitution runs once per target, so a single source file renders every harness variant. This is why portability is cheap here: adding a harness means extending the built-ins in `project.mjs`, not forking files.
- **The frozen-image render contract** ("The frozen-image render contract", v0.1.0). Rendered files are generated output, never edited; a lock manifest (sha256 per file) lets `doctor` detect drift, `render` regenerate and **prune** stale managed files, and `eject` release an item to project ownership. Per-project changes live only in config values and extension files. Corollary: `render` refuses to clobber a pre-existing *unmanaged* file (byte-identical is adopted silently; `--force` overrides) — see "Refuse to clobber pre-existing unmanaged files on render" (#25).
- **Lenient agent→skill deps, strict `requires:`** ("Lenient agent-skill deps, strict `requires:` deps"). An agent's frontmatter `skills:` list is a grant-pointer that may name skills outside the toolkit, so unknown/ambiguous names are **skipped, not errors** (this is why the generalized agent above can list `git-workflow`/`issue` safely). A stack's `requires:` map is an authored promise, resolved **strictly** — a dangling ref is a hard `validate` failure. Agent→skill deps need no `requires:`; they come from the frontmatter.

### Validation gates (run before you ship)

1. `npm run validate` — `node installer/cli.mjs validate`: manifests parse, frontmatter complete, placeholder↔declaration sync, agent-skill/`requires:` refs resolve, `pattern:`/`optIn:` integrity.
2. `npm test` — the `node:test` installer suite under `installer/test/*.test.mjs`.
3. `node installer/cli.mjs render && node installer/cli.mjs doctor` — regenerate all outputs, then confirm reality matches the lock (no drift, no hand-edits). In this repo pair with `--allow-missing` awareness since renders are gitignored.
4. `npm pack --dry-run` — the build/pack check the release flow uses.

### Worked answers

**"How would I add a new payload type?"** (today there are three: agents, skills, files.) Touch, in order: (1) `installer/lib/toolkit.mjs` `loadStack` — parse the new manifest array into items `{ kind, name, … }`, mirroring how `files` is parsed; (2) `installer/lib/refs.mjs` — extend the `normalizeItemRef` prefix regex, `itemsOfKind`, both `parseRef` regexes, and the ref-collection loops so the kind is addressable and joins the dependency closure; (3) `installer/lib/render.mjs` — add a `renderX` function and wire it into the per-item dispatch alongside `renderAgent`/`renderSkill`/`renderFiles`; (4) `installer/lib/validate.mjs` — collect placeholders (and any per-kind checks) for the new payload; (5) document it in `schema/FORMAT.md`; (6) add coverage under `installer/test/`. Then re-render and run the gates.

**"How would I add a new stack?"** (what *this* issue does.) Create `stacks/<name>/stack.yaml` plus its `agents/`/`skills/`/`files/`; register the stack name in `toolkit.yaml`'s `stacks:` list; enable it in a consumer's `.waffle/waffle.yaml` (`stacks:` or `include:`); add a row to the `AGENTS.md` stack registry and a `CHANGELOG.md` `[Unreleased]` entry (with a Consumer-impact line); then `npm run validate && npm test && node installer/cli.mjs render && node installer/cli.mjs doctor`.

**"How would I add a new config key?"** Declare it under the stack's `config:` (`required`/`default`/`description`, optional `pattern:` for render-time value validation), then reference it as `{{dotted.key}}` in that stack's content — `validate` fails if a declared key is unreferenced or a referenced dotted key is undeclared. Account-specific values belong in the gitignored `.waffle/waffle.local.yaml`, reachable from a committed value via nested `{{…}}` substitution.
