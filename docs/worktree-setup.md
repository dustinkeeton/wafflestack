# Prepare a checkout before starting an agent

`wafflestack prepare-worktree --cwd /absolute/checkout --json` prepares the selected
Claude, Codex and agents-dir resources from that checkout's committed config and lock.
Run it outside the new session, after checkout creation and before launching the agent.
It also works on a fresh clone. A successful exit is `ready` or `no-op`; a failed exit
must stop the launch. Repeat after changing branches, pins, extensions or configuration.

## Install the command first

This command ships after v0.19.0. Do not append `prepare-worktree` to a v0.19.0-or-older
pinned CLI. Choose an explicitly released version containing this command, install it,
and use that executable in your host setup script. For example, with `FEATURE_TAG` set
to that release tag:

```sh
npm install --global "github:dustinkeeton/wafflestack#$FEATURE_TAG"
wafflestack help
```

Confirm help lists `prepare-worktree`. On an old consumer, run that selected release's
`upgrade --cwd /absolute/checkout`, review the config/output changes, and commit the
canonical config and lock before enabling startup preparation. Until this feature is
released, test from an explicit checkout of this PR, using its absolute
`installer/cli.mjs` path; do not describe an unreleased tag as available.

Delegate and autopilot invoke `autopilot.waffleCmd` from inside the destination checkout,
with `prepare-worktree --cwd "$PWD" --json`. This makes a relative development runner
use the destination's installer. In this repository the prefix is
`env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer/cli.mjs`; install dependencies in that
checkout first. A consumer's configured prefix must name a release containing this command;
an old pin needs the explicit upgrade above before orchestration starts.

The launcher may be newer than the destination pin. Preparation resolves the destination
lock's repository, release and immutable commit; it never substitutes main's toolkit or
latest. A matching installed toolkit or verified source-cache checkout supplies the
source bytes. The lock repository must match the running CLI's repository. An exact
repository/commit/version match accepts an npm installation even offline with an empty cache.
Other pins require a clean source-cache checkout (including no untracked files) whose release
ref identifies the locked commit. Trusted online setup can fetch a missing locked commit;
`--offline` and `--untrusted-config` never fetch a toolkit selected by the lock. The current renderer must reproduce
**every canonical file and settings entry** in the lock before applying anything. An
incompatible older pin fails with a pinned render/upgrade remedy instead of migrating
silently. A lock without release provenance needs an explicit upgrade. Toolkit developers
alone can use `--allow-unreleased` with the CLI and destination in the same toolkit
checkout; exact canonical lock reproduction still applies.

## Plain Git and Claude

```sh
git worktree add -b feat/example "/absolute/worktree" origin/main
wafflestack prepare-worktree --cwd "/absolute/worktree" --json &&
  (cd "/absolute/worktree" && claude)
```

The `&&` is the launch gate. For a reused checkout, run preparation again before the
launch. Do not use `/waffle-render` inside an already-started session as the bootstrap.
If preparation happened late, restart the session and verify its skill and agent roster.

This wrapper deliberately leaves Git in charge of creation. Claude's
[`WorktreeCreate`](https://code.claude.com/docs/en/hooks#worktreecreate) hook **replaces**
the default creation mechanism; it is not an additive post-create setup hook. Wafflestack
does not install one. If using Claude's automatic isolation, configure a deliberately
owned creation adapter that gates launch, or create and prepare the worktree externally
as above. A `SessionStart` render alone is not this pre-start contract.

## T3 Code adapter

T3 selects one `runOnWorktreeCreate` setup script. In project `t3.json`, add this entry
to `scripts`, or append the preparation command with `&&` to the existing setup script (use the absolute installed executable
if the host shell does not find `wafflestack`):

```json
{
  "scripts": [
    {
      "name": "Prepare Wafflestack",
      "command": "wafflestack prepare-worktree --cwd \"$PWD\" --json",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    }
  ]
}
```

`async: false` makes setup a startup prerequisite. T3 runs the setup script with the worktree as its working directory and records its exit
code. Treat a failed setup as a blocked launch; repair it and retry setup before submitting
the worker. Do not skip a failed setup. Reused worktrees need the same command again
before launching with changed inputs. This adapter does not copy main's directories.
The repository's own `t3.json` installs dependencies and invokes its local development
CLI, with the explicit unreleased exception, before a new worktree session.

Syntax and lifecycle were checked against the official T3
[`t3.json`](https://github.com/pingdotgg/t3code/blob/main/t3.json),
[`ProjectSetupScriptRunner`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/project/ProjectSetupScriptRunner.ts)
and [`WorktreeSetupTracker`](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/project/WorktreeSetupTracker.ts)
on 2026-11-03. This is source verification, not a desktop UI end-to-end test.

## Codex desktop local environment

In the desktop app's local-environment settings, set the worktree setup script to:

```sh
wafflestack prepare-worktree --cwd "$PWD" --json
```

Save the generated `.codex` environment configuration to share it. Setup runs when the
app creates a new worktree at the start of a chat. Stop on a nonzero preparation exit;
do not send work into a failed setup. Re-run before using an existing worktree whose
inputs changed. The current
[local-environment documentation](https://learn.chatgpt.com/docs/environments/local-environment)
was checked on 2026-11-03; let the app generate its environment schema rather than
hand-authoring a version-specific TOML layout. Do not copy the entire harness directory
with `.worktreeinclude`: content must follow the destination pin.

## Private overlay policy

The default is destination config/extensions plus an ignored local overlay already in
that checkout. To opt into associated main-checkout overlay inheritance persistently:

```sh
git config --local wafflestack.worktreeOverlay main
```

For one invocation, `--overlay local` uses only the destination overlay, `--overlay main`
allows the associated main overlay when the destination has none, and `--overlay none`
uses canonical inputs without reading either overlay. These flags override the Git setting
without changing it. Untrusted preparation still refuses `main`. The flags do not bypass
conflict or privacy checks: switching an already prepared private checkout to `none` may
require explicit reconciliation of its existing resources/local lock before retrying.

Reset with `git config --local wafflestack.worktreeOverlay destination`. This repository-local
Git setting is shared by its linked worktrees. A destination overlay wins when present;
otherwise `main` imports only the associated main checkout's overlay. Git verifies the
association. All relative source paths, including those declared by an inherited overlay,
resolve against the **destination checkout**; extensions always come from the destination.
No arbitrary files or extensions from main are imported. Default omission of an existing
main overlay produces a notice, without values. JSON identifies `canonical`,
`destination-overlay` or `main-overlay` mode.

Overlays and their differing outputs must be untracked and ignored. Preparation refuses
private-derived changes to tracked output, even when the renderer normally owns it.
Change the tracking/ignore posture explicitly, or change the overlay policy. Public locks
remain canonical and unchanged. Private local-lock hashes never enter public diagnostics.
`--untrusted-config` refuses main overlay inheritance and external `source:` stacks;
preparation never acknowledges external prerequisite checks or runs them.

## Readiness, conflicts and recovery

Preparation computes outputs in memory with the normal renderer, then applies only
`.claude/`, `.agents/` and `.codex/` artifacts and, when necessary, the ignored local lock.
It does not render workflows outside those directories, overview docs, public locks or
project configuration. Helpers, agent definitions and individual managed settings entries
count toward readiness. Directory presence does not. Unrelated settings and custom files
survive. The Git index and main checkout are unchanged.

`--json` returns `status`, `targets`, `pin`, `generatedPaths`, `prunedPaths`, `conflicts`, `overlayMode`,
`notices`, `missingIgnore` and `errors`. Exit 1 means no launch. No-op leaves artifact bytes
and mtimes unchanged. Untracked public outputs without ignore coverage are reported;
preparation never edits `.gitignore`. If you choose Git local excludes, remember the common
`.git/info/exclude` is **shared among linked worktrees**.

Edited or colliding output fails before any artifact is written. Preserve your edits and
resolve the named paths with an intentional render/eject or input change; no force flag
exists. Files no longer selected are pruned only when they still match the previous receipt,
are untracked, and are not ejected. Edited, tracked, and symlinked stale files remain conflicts;
ejected skills and their helpers stay project-owned. Settings are merged only when absent, identical, or still matching a known managed value.
All destination symlinks are refused, including links back to main, to preserve isolation.

A per-checkout Git-administrative mutex prevents concurrent preparation. Writes use atomic
replacement, and the private journal records original and intended bytes, including deletions
and the receipt. On retry, a verifiably dead local owner triggers serialized journal recovery:
each file must match its original or intended bytes before restoration begins. Recovery is
itself restartable. A live owner, unknown owner, changed artifact, unsafe path, or invalid
journal blocks readiness. PID liveness alone never authorizes discarding a transaction.

If automatic recovery stops, inspect
`$(git rev-parse --absolute-git-dir)/wafflestack-prepare/journal.json` locally (it may contain
private backup content; do not post it). Preserve conflicting edits and reconcile the journal
before retrying. Remove a legacy ownerless transaction only after verifying its backups.
Render failures report safe categories (missing required configuration, YAML syntax,
external source/trust, or other render inputs), without printing private values or raw YAML.
Inspect the destination inputs locally with the pinned toolkit, repair and commit canonical
config/lock changes, then retry. No blanket restore/delete of the worktree is required.

Unmanaged, uncommitted custom skills cannot be reconstructed from a lock. Keep them as
personal skills, commit them as project-owned resources, or configure a narrowly scoped,
explicit copy step. Personal skills remain a separate additive source. Committed custom
skills plus ignored generated resources is supported; untracking every custom skill is
not a universal fix. Runtime-specific fallback is observed behavior, never the provisioning
contract. Whole-directory symlinks to main break write isolation and version independence.

## Verification record and repeatable smoke test

[2026-11-03 runtime results](worktree-smoke-2026-11-03.json) record Claude 2.1.317
startup skill/agent rosters and Codex 0.156.1 app-server `skills/list` with
`forceReload: true`. All five directory states passed after preparation. Tests used
external and nested disposable repositories, including paths with spaces. These results
prove discovery. The separately approved live invocation passed with Claude’s `--agent worker`.
Codex 0.156.1’s normal session reported no `agent_type` selector; its generic child did not
receive the fixture’s custom instructions. An initial ephemeral session also failed to spawn
with `no thread with id`. Codex custom-agent usability therefore remains unverified in this
runtime/tool configuration. No desktop session-creation claim is made.

[2026-11-04 runtime results](worktree-smoke-2026-11-04.json) repeat all five discovery states
on Codex 0.166.0 and Claude 2.1.318. Claude invocation passes; Codex again reports no custom
agent selector. Disabling `multi_agent_v2` does not expose one. A GPT-5.4 compatibility probe
was rejected as unsupported by the account. The owner requires successful custom invocation;
B5 and #820's invocation acceptance remain open. This evidence does not narrow that criterion.

Run the optional, non-CI harness smoke test with installed runtimes:

```sh
WAFFLE_CODEX_BIN=/absolute/path/to/codex node installer/smoke/worktree-discovery.mjs
```

`WAFFLE_CLAUDE_BIN` can select Claude. The script stops Claude after `system/init`, uses
project-only settings and no MCP servers, and never submits a Codex model turn in discovery
mode. `--invoke` additionally exercises Claude's `--agent worker` and Codex's custom
`worker` spawn against synthetic fixtures, using authenticated model calls. Invocation uses
a normal Codex session because the tested ephemeral mode could not spawn a child. A missing
custom-type selector or generic-agent fallback fails the smoke test; it must not be counted
as a successful custom-agent invocation. Resolve and recheck the recorded Codex limitation
before claiming full custom-agent runtime acceptance. CI’s deterministic worktree tests
never call models. A Codex skill-list result is not evidence of agent usability.

The [official custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
describes project `.codex/agents/*.toml` definitions. Provisioning those files does not prove
that a particular runtime/model tool interface can select them.
