<h1 align="center">WaffleStack</h1>
<p align="center">
  <img src="assets/wafflestack-social-animated.svg" width="100%" alt="WaffleStack — a stack of golden waffles with an animated syrup pour">
</p>
<h3 align="center">Reusable AI agent and skill definitions, distributed shadcn-style but <strong>update-safe</strong>.</h3>
<p align="center">
  <a href="https://github.com/sponsors/dustinkeeton"><img src="https://img.shields.io/badge/Sponsor-GitHub-F08A1D?logo=githubsponsors&logoColor=F5C752&labelColor=241204" alt="Sponsor on GitHub"></a>
  <a href="https://buymeacoffee.com/dustinkeeton"><img src="https://img.shields.io/badge/Support-Buy%20Me%20a%20Coffee-F08A1D?logo=buymeacoffee&logoColor=F5C752&labelColor=241204" alt="Support on Buy Me a Coffee"></a>
</p>

---

One canonical source repo, rendered into harness-native files inside each consuming project —
the same batter, baked fresh wherever you need it. Every supported harness gets both agents
and skills: **Claude Code**, **OpenAI Codex**, and the cross-tool `.agents/` directory.

**Where it fits:** wafflestack is the **update-safe distribution layer** for agent process and
skills content — consumer-owned files under a lock manifest, drift detection via `doctor`, and
explicit, diffable upgrades with versioned migrations. It carries content across repos and
harnesses and keeps it current; it doesn't produce that content (that's a process pack like
[gstack](https://github.com/garrytan/gstack)) or run it (that's an always-on agent runtime).

## Vocabulary

- **waffle** — an individual installable item: an agent or a skill.
- **stack** — a named group of waffles.
- **syrup** — the generic `files/` payload a stack can also carry (CI workflows, scripts, config),
  rendered verbatim to any repo-relative path with the same `{{key}}` substitution, lock tracking,
  and drift detection.

## Quick start

### Guided (recommended)

Let your coding agent drive the whole setup. Kick it off either way:

**Agent prompt** — paste to your coding agent:

```text
Set up wafflestack in this repo: run `npx github:dustinkeeton/wafflestack setup` and
follow the playbook it prints. Ask me which stacks to enable before you render.
```

**Inline shell (Claude Code / Codex)** — type in the prompt (the `!` prefix runs the command
in-session and feeds its output back to the model; `--yes` keeps `npx` non-interactive):

```text
! npx --yes github:dustinkeeton/wafflestack#v0.13.0 setup
```

`setup` prints an agent playbook plus a generated inventory of every stack, config key, and
prerequisite. The agent then detects targets, asks which stacks to enable, fills
`.waffle/waffle.yaml`, renders, runs `doctor`, and reports what it did.

### Manual

```bash
cd your-project
npx github:dustinkeeton/wafflestack init              # writes a starter .waffle/waffle.yaml
# edit .waffle/waffle.yaml: pick stacks, fill in config values
npx github:dustinkeeton/wafflestack#v0.13.0 render    # renders all harness files + lock manifest
```

> **Pin the tag on anything that writes files.** An unpinned `npx github:` spec resolves the
> **default branch**, not the latest release — so `render`, `install`, `upgrade`, `reinstall`, and
> `doctor --verify-render` refuse it and name the pinned command to run. See
> [release resolution](docs/upgrades.md#release-resolution).

## Commands

| Command | What it does |
|---|---|
| `init` | Write a starter `.waffle/waffle.yaml` (`--gitignore` also appends overlay/local-lock ignores). |
| `setup` | Print the agent-driven install playbook + generated toolkit inventory. |
| `list` | Show every waffle and syrup file per stack with its status; `--interactive` for a TTY multi-select. |
| `render` (alias `bake`) | Regenerate every managed file from source + config, prune stale ones, write the lock. |
| `install [ref…]` | Add stacks/items to `.waffle/waffle.yaml`, pull dependencies, then render. Bare = `render`. |
| `upgrade` | Move an install across toolkit versions: print CHANGELOG, run migrations, re-render, `doctor`. |
| `doctor` | Diff managed files against the lock; report edits, missing files, env gaps. Exit 1 on drift. |
| `eject <item>` | Stop managing an item — its files stay and become project-owned; drops it from `include:`. |
| `uninstall` | Remove the whole install (reports until you pass `--yes`; keeps hand-edited files). |
| `reinstall` | Re-render the same selection from clean; `--clean --yes` for a full reset. |
| `avatars <sync\|status>` | Keep Gravatar in sync with the installed agent roster. |
| `validate` | Toolkit-developer lint: manifests, frontmatter, placeholders, and agent refs. |
| `help` | Print usage and a one-line description of every command and flag. |

Run `npx github:dustinkeeton/wafflestack help` for the full flag detail on any command.

## Perchance
1. **Never edit rendered files** — `render` overwrites them. Put additions in
   `.waffle/extensions/{agents,skills}/<name>.md` and parameters in `.waffle/waffle.yaml`.
2. **Account-specific values** (bot identities, board IDs) go in `.waffle/waffle.local.yaml` —
   gitignored, merged over the committed config, and **never propagated**: the lock hashes the
   *canonical* render, so every teammate's lock is byte-identical.
3. **Updates are re-renders — until they aren't.** Patch/minor tags are a plain `render`; a
   breaking tag needs `upgrade`. See [Updating](#updating).
4. **`doctor` is the CI drift gate** — run it on PRs to fail the build on any hand-edited managed
   file. Add `--allow-missing` when some renders are gitignored, `--verify-render` to also catch
   config changes that were never re-rendered.

**Deciding what to commit?** [Committing vs. gitignoring the rendered output](docs/gitignore.md)
walks the trade-off.

## Updating

WaffleStack ships as git tags (`vX.Y.Z`), versioned **from a consumer's point of view**:

| Bump | Example | Means for you | How to take it |
|---|---|---|---|
| patch | `0.5.0 → 0.5.1` | content-only fixes | `… render` |
| minor | `0.5.0 → 0.6.0` | new stacks/items, additive config | `… render` |
| major | renamed/removed item, new **required** key, changed layout | needs a migration | `… upgrade` |

The `…` is always a **pinned** spec (`npx github:dustinkeeton/wafflestack#vX.Y.Z`) — unpinned
commands refuse. Full detail — the upgrade command, migrations, pin-moving, and release
resolution — lives in **[Upgrades and release resolution](docs/upgrades.md)**.

## Learn more

- **[Upgrades & release resolution](docs/upgrades.md)** — versioning contract, migrations, pins.
- **[Committing vs. gitignoring the render](docs/gitignore.md)** — the trade-off, and the lock.
- **[Format reference](schema/FORMAT.md)** — stack, agent, skill, and syrup definitions.
- **[Brand assets](assets/)** — logos and guidelines.

## License

© 2026 Dustin Keeton. Licensed under the [Apache License, Version 2.0](LICENSE).

---
<p align="center">
    <a href="https://github.com/dustinkeeton/wafflestack/blob/waffle-telemetry/.waffle/telemetry/tokens.json"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdustinkeeton%2Fwafflestack%2Fwaffle-telemetry%2F.waffle%2Ftelemetry%2Ftokens.json" alt="Claude token spend (automated runs)"></a>
</p>
<p align="center">
  <img src="assets/wafflestack-flat.svg" width="24" alt=""><br>
  A <strong>WaffleWorks</strong> project
</p>
