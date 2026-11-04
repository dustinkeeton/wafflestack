# Worktrees: provisioning skills and agents before a session starts

A git worktree holds tracked files only. If your repo gitignores its wafflestack render
([Posture 2b](gitignore.md#posture-2b-commit-the-lock-only), or any posture that ignores part of
it), a fresh worktree has no `.claude/skills/`, no `.claude/agents/`, no `.agents/skills/` — and a
Claude or Codex session started there sees whatever the harness happens to fall back to. The same
is true of a fresh clone.

`wafflestack prepare-worktree` is the one deterministic answer. Run it after the checkout exists
and before any agent session starts in it, on every host, for every harness.

```bash
git worktree add ../myrepo-feature -b feature origin/main
npx --yes github:dustinkeeton/wafflestack#v0.20.0 prepare-worktree --cwd "$(realpath ../myrepo-feature)"
cd ../myrepo-feature && claude        # or codex
```

## What it does

`prepare-worktree --cwd <checkout>`:

1. **Validates the checkout through git.** It accepts the main checkout, a nested linked worktree
   (`.claude/worktrees/x`), an external one (`../repo-x`), and a path with spaces; `.git` may be a
   file. Anything outside a git work tree fails.
2. **Reads that checkout's own inputs**: `.waffle/waffle.yaml`, `.waffle/extensions/`, the committed
   lock, and (by [overlay policy](#overlay-policy)) a `.waffle/waffle.local.yaml`. Never another
   branch's config, never the main checkout's current render.
3. **Resolves the pin.** The running CLI renders only when its version, and for a release its tag
   and commit, are the lock's. Otherwise the lock's own pinned release does: it is served from the
   source cache (`~/.cache/wafflestack/sources/`), or cloned into it once at the pinned tag, with the
   tag's commit and the toolkit's version checked against the lock before it renders anything. The
   pin must name the running CLI's own repository and carry a full commit: a lock is data, and it
   may not choose which toolkit's content becomes the agent's skills, so a pin to another repository
   is refused with the command to run that repository's own CLI. `--untrusted-config` never fetches.
   With `--offline` a cache miss fails. Every refusal prints the command the lock pins
   (`npx --yes github:owner/repo#vX.Y.Z prepare-worktree --cwd …`), or, when the lock records no
   release pin, the upgrade to run in the main checkout. The CLI that happens to be on `PATH` never
   renders a worktree pinned elsewhere; the report's `pin.from` says which toolkit did (`running`,
   `cache`, `fetch`).
4. **Stages a render** in a temp dir with the real render engine, then checks the canonical result
   against the committed lock. A stale lock (config edited, never re-rendered) fails: re-render in the
   main checkout, commit the lock, bring the branch up to date.
5. **Copies only the harness artifacts**: paths under `.claude/` (claude target), `.codex/` and
   `.agents/` (codex), `.agents/` (agents-dir), including skill helper files and `files/` payloads
   such as `.claude/workflows/*.js`, plus the lock-managed `.claude/settings.json` entries.
   `.github/` payloads, the generated `.waffle/` docs, the committed lock and project-owned
   (ejected or untracked) files are never written.
6. **Treats completeness per file.** A present, matching file is left alone; a missing one is
   written; a file still at a hash this lock, this checkout's local lock, or an earlier
   `prepare-worktree` run recorded is refreshed. A lock-managed settings entry follows the same rule:
   a value the lock or an earlier run recorded is refreshed, any other value is a local edit. Any
   other difference is a **conflict**: a hand-edited managed file, an unmanaged file at a rendered
   path, a symlink that leaves the checkout, an edited or foreign settings entry. One conflict fails
   the whole run **before a byte is written**, naming every path. There is no `--force`. A write that
   fails part-way (a file where a directory must go, a full disk) restores every path the run touched
   and reports `failed`; a run killed outright leaves no readiness claim, and the next run completes
   or refuses on what it finds. A file this command wrote for an earlier lock that the current lock
   no longer renders (a dropped target, an ejected or removed skill) is pruned, with its emptied
   directories, when it still holds what was written; edited since, it is a conflict. Nothing the
   command did not write is ever removed.
7. **Reports ignore coverage.** A path it wrote that git would show as untracked is listed, with the
   two remedies: the committed `.gitignore` (from the main checkout, `wafflestack render
   --gitignore` offers the entries), or `git rev-parse --git-path info/exclude`, which every linked
   worktree of the repository shares. Nothing is added for you.
8. **Validates before claiming success**: every expected artifact is re-hashed after writing. Then it
   prints `ready` (something was written), `no-op` (already complete), or `failed`, and exits 1 on
   `failed`. `--json` prints the same as a document (`status`, `checkout`, `targets`, `pin`,
   `overlay`, `generated`, `refreshed`, `present`, `settings`, `conflicts`, `ignore`, `errors`,
   `warnings`, `notes`).

It holds a per-worktree lock in the worktree's git dir while it runs, so two preparations of one
worktree never race; a second one fails and names the first's pid. It writes its own record of what
it wrote (`wafflestack-prepared.json`, also in the git dir, never in the tree) so a reused worktree
whose lock moved on gets refreshed, not refused. A repeated run on a complete worktree changes no
content and no index entry.

`prepare-worktree` is gated like `render`: it writes toolkit content, so it refuses from a toolkit
that is provably not a release (`--allow-unreleased` or `WAFFLESTACK_ALLOW_UNRELEASED=1` for the
toolkit's own checkout). `--untrusted-config` carries `render`'s restrictions for a checkout you did
not author (no `source:` stacks, no prerequisite probe, no write through a symlink that leaves the
root); an external stack's acknowledged checks are read from the destination's own config, so
ordinary local setup upgrades no trust.

## Overlay policy

The committed lock is canonical: it hashes the committed inputs alone (#317). Your
`.waffle/waffle.local.yaml` is private, so a worktree's render can legitimately differ from the
main checkout's effective one. `prepare-worktree` handles that deliberately:

| `--overlay` | Renders with |
| --- | --- |
| `local` (default) | the committed inputs plus the destination's own `.waffle/waffle.local.yaml`, if one is there (a fresh worktree has none, so this is the canonical render) |
| `main` | …plus, for a linked worktree with no overlay of its own, the **main checkout's** `.waffle/waffle.local.yaml`, found through `git rev-parse --git-common-dir` |
| `none` | the committed inputs only, even if the destination has an overlay |

Persist the opt-in on the machine whose private values would be imported: in the main checkout's
`.waffle/waffle.local.yaml`, at the top level, next to `config:`:

```yaml
worktrees:
  overlay: main
```

`.waffle/waffle.yaml` may carry the key with `local` or `none` only: a config that travels with the
branch cannot opt a teammate's private overlay in, so `main` there is an error. The flag wins over
the main overlay, which wins over the destination's config. When the main checkout has an
overlay and the chosen policy leaves it out, the run says so by name, never by value. The result's
`overlay.effective` reads `canonical` or `overlay`, so a host script can tell which it got.

An overlay-fed render writes the destination's gitignored `.waffle/waffle.local.lock.json`, exactly
as `render` would, so `doctor` in that worktree stays truthful. Private content never reaches
tracked output: a tracked rendered path the overlay would change is a conflict (gitignore the
render, or prepare with `--overlay none`), so is a tracked `.claude/settings.json` whose
lock-managed entry the overlay would change, and so is a tracked local lock. `--untrusted-config`
refuses policy `main` outright. No overlay value
appears in the committed lock, in the output, or in a `--json` document.

**Unmanaged custom files are not recoverable from a lock.** A skill you keep in
`.claude/skills/mine/` uncommitted and unrendered exists in your main checkout only. Commit it
(worktrees then carry it, and `prepare-worktree` leaves it alone), keep it as a personal skill
(`~/.claude/skills/`, `~/.agents/skills/` — a separate, additive source every harness reads), or copy
it with your own narrowly scoped setup step. The renderer does not discover arbitrary private files.

## Host recipes

Every host needs the same two things: the command runs **after** the checkout exists and **before**
the agent's first turn, and it runs the toolkit the lock pins. This script does both; commit it as
`scripts/prepare-worktree.sh` (or keep it wherever your host expects) and point each host at it.

```bash
#!/usr/bin/env bash
# Provision this checkout's wafflestack skills/agents from its lock. Run after `git worktree add`
# (or a fresh clone) and before any Claude/Codex session starts here. Exit 1 = not ready.
set -euo pipefail
wt="$(realpath "${1:-$PWD}")"
lock="$wt/.waffle/waffle.lock.json"
[ -f "$lock" ] || { echo "prepare-worktree: $lock is missing — render in the main checkout and commit the lock" >&2; exit 1; }
read -r version pin < <(node -e '
  const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const t = l.toolkit || {};
  console.log(l.toolkitVersion || "-", t.status === "release" && t.source && t.ref ? `${t.source}#${t.ref}` : "-");
' "$lock")
floor=0.20.0   # first release that ships prepare-worktree
if [ "$(printf '%s\n%s\n' "$floor" "$version" | sort -V | head -1)" != "$floor" ]; then
  echo "prepare-worktree: the lock was rendered by wafflestack $version, which predates the command (v$floor); from the main checkout run: npx --yes github:dustinkeeton/wafflestack#v$floor upgrade — then commit the lock" >&2
  exit 1
fi
[ "$pin" != - ] || { echo "prepare-worktree: the lock records no release pin — run wafflestack upgrade from a release in the main checkout and commit the lock" >&2; exit 1; }
exec npx --yes "$pin" prepare-worktree --cwd "$wt" "${@:2}"
```

It refuses an old pin instead of asking an old CLI to run a command it does not implement, and
after the upgrade every later run honors whatever the lock then pins — a fork's included, since
the pin comes from the lock's `toolkit` block. Any installed CLI at v0.20.0 or later can replace
the `npx` line: it resolves the lock's pin itself, so the host script can simply be
`wafflestack prepare-worktree --cwd "$wt"` once such a CLI is on `PATH`. For the toolkit's own repo (never at a release tag),
replace the last line with `exec env WAFFLESTACK_ALLOW_UNRELEASED=1 node "$wt/installer/cli.mjs"
prepare-worktree --cwd "$wt" "${@:2}"`.

### Plain `git worktree add`

```bash
git fetch origin main
git worktree add "$WT" -b feat/x origin/main
scripts/prepare-worktree.sh "$WT"      # exit 1 → do not start a session there yet
```

This is what the `delegate` and `autopilot` skills do for every worktree they cut (parallel issue
worktrees, retry branches, the integration stage 2 responder and stage 3 audit worktrees), and they
stop that launch on a non-zero exit. The same recipe prepares a fresh clone: run it in the clone
before the first session.

### T3 Code

T3 Code's worktree settings (location, "start from remote", branch naming) decide *where* and
*from what* a worktree is cut; none of them provisions skills. Its lifecycle is "create a local
worktree using its selected strategy, then run the project's setup script", and a thread's first run
is held while that setup is unresolved — which is the hook this command needs. "Start from remote"
matters for one reason: the worktree's branch, and so its lock, can be newer than your main
checkout's, which is why the script below pins the toolkit from the worktree's lock and never the
main checkout's CLI. Worktrees land under `~/.t3/worktrees/<project>/<id>` by default (an external
linked worktree; supported).

T3 Code runs project **scripts** (Settings → Projects, or a checked-in `t3.json`, which each user
imports once). Add one that runs `scripts/prepare-worktree.sh` with `runOnWorktreeCreate: true` and
`async: false`. This repository's own `t3.json` does exactly that with its checkout's installer
(`npm ci --ignore-scripts && env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs prepare-worktree --cwd "$PWD"`):

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "scripts": [
    {
      "name": "Prepare Wafflestack",
      "command": "scripts/prepare-worktree.sh \"$PWD\"",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    }
  ]
}
```

`async: false` makes the script a startup prerequisite: the thread's first run is held while the
worktree's setup is unresolved. Without it T3 launches the first agent turn as soon as the command is
written to the terminal, so the session can start before the render exists. T3 runs the script with
the worktree as its working directory and records the exit code; the script also checks its `$PWD`
is a git checkout, so a host that runs it elsewhere fails loudly rather than preparing the wrong
tree. Field names and lifecycle checked on 2026-11-03 against the t3code repository's own
`t3.json` (`name`, `command`, `icon`, `runOnWorktreeCreate`) and
`apps/server/src/project/ProjectSetupScriptRunner.ts` (`async: script.async !== false`, `cwd =
input.worktreePath`), and the Beta app bundle; not a desktop UI end-to-end run.

### Codex desktop app

The Codex app's **local environment** setup script "runs automatically when Codex creates a new
worktree at the start of a new chat"; the app writes the configuration under `.codex/environments/`,
which you can commit. Put `scripts/prepare-worktree.sh` in the setup script (per-platform overrides
exist for macOS, Windows and Linux). Codex loads repository skills from `.agents/skills` at the
working directory, its parent, and the repository root, and user skills from `~/.agents/skills`; it
does **not** read a worktree's main checkout, so without this step a worktree has only its committed
skills. A custom agent is `.codex/agents/<name>.toml` and is prepared the same way. Observed with
Codex app 0.154.0-alpha.6.2 (bundled CLI) and 0.156.1 (T3-installed) on 2026-11-03: `skills/list`
with `forceReload: true` shows the prepared skills.

### Claude Code

`claude --worktree <name>` creates the worktree and starts the session in one step. Its
`WorktreeCreate` hook **replaces** git worktree creation outright (it is the adapter for non-git
VCSs), so do not install one just to run a setup step; there is no post-create hook. Two honest
options:

- **Create the worktree yourself** (`git worktree add` + the script above), then start `claude` in
  it. That is the contract delegate and autopilot follow.
- **Rely on the read-through.** Claude Code (v2.1.277+ for skills) loads the main checkout's
  `.claude/skills`, `.claude/agents` and `.claude/commands` in a worktree session *only while that
  directory is absent in the worktree*; a directory that exists, even holding one committed
  project-owned file, switches the read-through off for that directory, by-name invocation included
  (`Unknown skill: <name>`). What you get is the main checkout's *effective* render — overlay
  included, pin unchecked — not the worktree's lock. A `.worktreeinclude` file can copy the ignored
  render from the main checkout into worktrees Claude creates, with the same caveat. Both are
  observed Claude Code behavior at a stated version, not a provisioning contract.

A `SessionStart` hook that runs the script fires after Claude Code has already discovered skills;
nothing here verified that the catalog refreshes afterwards, so treat a post-startup preparation as
needing a session restart, and prefer preparing before launch.

## Lifecycle rules

- **Reused worktrees are rechecked.** Run the command again after a `git merge`, a branch switch, or
  a pin change in that worktree; it refreshes what the new lock renders differently and refuses
  what it cannot vouch for.
- **A failed preparation blocks the session.** Exit 1 means the worktree is not ready; the output
  names the repair. Do not render by hand in its place.
- **Never symlink the whole harness directory to the main checkout.** It breaks write isolation
  (an agent editing a skill in a worktree edits every checkout) and version independence (one tree
  per pin becomes impossible).
- **`doctor --allow-missing` is not a readiness check**: it tolerates absence by design. Readiness
  is `prepare-worktree`'s exit code.

## Runtime acceptance matrix

Rendered skills are discovered by each harness at startup. `installer/smoke/worktree-discovery.mjs`
is the repeatable check: it builds the test fixtures, prepares a worktree in each of the five
directory states (absent, empty, custom-only, partial, complete), asks Claude Code for its startup
roster (`system/init`, stopped before any model turn) and Codex for `skills/list` over its
app-server protocol with `forceReload`, and prints one JSON report, exit 1 on any miss:

```sh
WAFFLE_CLAUDE_BIN=claude WAFFLE_CODEX_BIN=codex node installer/smoke/worktree-discovery.mjs
```

CI runs the same script against stub harnesses (`installer/test/worktree-smoke.test.mjs`) so its
fixtures and protocol handling stay exercised without a model call; the deterministic half of the
contract is `installer/test/prepare-worktree.test.mjs`. Before a release that touches this path, run
the script with the installed harnesses and commit the report next to the previous one
(`docs/worktree-smoke-<date>.json`).

| Harness | Check | Last recorded ([report](worktree-smoke-2026-11-04.json)) |
| --- | --- | --- |
| Claude Code | startup roster (`system/init`) lists every lock-rendered skill and agent next to the custom one, in all five states | **2.1.317, 2026-11-04**: pass in all five states; `custom` kept in the custom-only state. Before preparation, measured on 2026-11-03: a custom-only `.claude/skills` listed `custom` alone, the generated `greet` absent, while `helper` was still read through from the main checkout because `.claude/agents` was absent |
| Codex | app-server `skills/list` with `forceReload: true` lists the prepared skills from the worktree's own path, in all five states | **0.156.1 and 0.154.0-alpha.6.2, 2026-11-04**: pass in all five states. Discovery only: #821's live check found that Codex 0.156.1 could not select a `.codex/agents/*.toml` custom agent through `spawn_agent`, so custom-agent invocation on Codex stays unverified |
