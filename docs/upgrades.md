# Upgrades and release resolution

How wafflestack versions its releases, how you take an upgrade, and how the CLI works out
*which* toolkit it's running before it writes anything. For the day-to-day summary, see the
[Updating](../README.md#updating) section of the README — this is the full contract.

## Versioning

WaffleStack ships as git tags (`vX.Y.Z`), and the version is semver **read from a
consumer's point of view**:

| Bump | Example | What it means for you | How to take it |
|---|---|---|---|
| patch | `0.5.0 → 0.5.1` | content-only fixes | `… render` |
| minor | `0.5.0 → 0.6.0` | new stacks/items, additive config | `… render` |
| major / breaking | renamed or removed item, new **required** config key, changed file layout | needs a migration | `… upgrade` |

In every row the `…` is a **pinned** spec — `npx github:dustinkeeton/wafflestack#vX.Y.Z`. An
unpinned one names the default branch, and these commands refuse it; see
[Release resolution](#release-resolution).

## The upgrade command

Three copyable forms.

**Agent prompt** — paste to your coding agent:

```text
Upgrade wafflestack in this repo to <newtag>: run
`npx github:dustinkeeton/wafflestack#<newtag> upgrade`, review the CHANGELOG entries it
prints, let it run migrations and re-render, then run `doctor` and tell me what changed
and anything I still owe (e.g. `.gitignore` updates).
```

**Inline shell (Claude Code / Codex)** — type in the prompt:

```text
! npx --yes github:dustinkeeton/wafflestack#<newtag> upgrade
```

**Run it yourself:**

```bash
npx github:dustinkeeton/wafflestack#<newtag> upgrade
```

## What `upgrade` does

`upgrade` compares the `toolkitVersion` recorded in your `.waffle/waffle.lock.json` to the
toolkit you invoked, prints the [`CHANGELOG.md`](../CHANGELOG.md) entries in between (each
release carries a **Consumer impact** line), runs any registered migrations in
`(lockVersion, toolkitVersion]` order, then re-renders and runs `doctor`. Migrations are
ordered, idempotent, and keyed to the version that introduced the change, so running
`upgrade` on an already-current repo is a safe no-op. If the lock is missing or predates
version stamping, `upgrade` says so and falls back to a plain render + `doctor`.

> **Note:** the commit-move report and pin rewriting below, and the whole
> [Release resolution](#release-resolution) gate, are newer than the latest tag — as of
> v0.12.0 they live in the CHANGELOG's `[Unreleased]` section and ship with the next release.

It also reports the toolkit's **actual commit move**, the way it already does for external
stack sources — `toolkit moved 0.11.0 (v0.11.0 @ aaaaaaaaaaaa) → 0.12.0 (v0.12.0 @ bbbbbbbbbbbb)`.
That matters most in the case a version number cannot describe: when the version did **not**
change but the toolkit did (a re-cut or force-pushed tag), `upgrade` used to report *"already on
toolkit 0.12.0"* and fall silent. Now it says the commit moved. The lock is what makes this
possible — it records the ref and commit SHA that produced your render, not just a version
string (see [Release resolution](#release-resolution)).

**And it moves your pins.** If you pinned `doctor.toolkitRef` (the toolkit CI's doctor job fetches)
or `waffle.toolkitRef` (the toolkit every `/waffle-*` skill runs) to a release tag, `upgrade`
rewrites them to the toolkit that just rendered your lock — *before* the render, so the new ref is
baked into `.github/workflows/waffle-doctor.yml` and every rendered skill in the same run. The pin
your CI fetches is by construction the pin your lock records. It only ever moves a pin you already
chose: an **unpinned** ref keeps floating, an **absent** key is never given one, and a `#main` or
`#<sha>` pin is left alone and noted. A run that cannot prove it is a release (`--allow-unreleased`,
a `dlx` install, an unanswerable lookup) writes no pin at all.

Pinned to an old tag and wondering why `upgrade` says *"already on toolkit X"*? That pin means npx
fetched the **old** CLI, and it can only render itself. It knows the way out, though, and prints it:
`a newer toolkit release exists: v0.14.0 —` followed by the exact pinned command to run. Run that
one (or let `/waffle-upgrade` do it), and everything moves together.

## Migration history

Two migrations exist so far: **0.6.0** shortened the consumer dotfiles
(`.wafflestack.yaml` → `.waffle.yaml`, plus the local overlay, lock, and
`.wafflestack/extensions/` → `.waffle/extensions/`), and **0.8.0** consolidates everything
into a single `.waffle/` directory (`.waffle.yaml` → `.waffle/waffle.yaml`,
`.waffle.local.yaml` → `.waffle/waffle.local.yaml`, `.waffle.lock.json` →
`.waffle/waffle.lock.json`). You don't have to rename anything by hand: any `render` or
`upgrade` moves the legacy files in place — chaining a pre-0.6.0 repo all the way forward
in one pass — and reminds you to update the matching `.gitignore` entries (the auto-move
never edits `.gitignore` — swap them yourself, or run `wafflestack install --gitignore` to
re-add the `.waffle/` paths). Until you re-render, the old names keep working with a
deprecation note.

## Release resolution

**What toolkit am I running?**

`npx github:dustinkeeton/wafflestack <cmd>` — with no `#ref` — fetches the **default branch**.
Both the branch and the tag behind it report the same `version` in `package.json`, so for a long
time nothing distinguished them: a bare `upgrade` would announce `0.8.0 → 0.12.0` and then write
`0.12.0` *plus every unreleased commit since*, stamping `toolkitVersion: 0.12.0` into your lock.
If your CI then ran `doctor --verify-render` through a **pinned** ref (the required practice), it
re-rendered the same config from the tag, got different bytes, and went red on a lock that was
perfectly correct from your side.

The CLI now works out **what it is** before it writes anything:

| It resolves as | When | What happens |
|---|---|---|
| `release` | the commit it is running IS a `vX.Y.Z` tag | everything works, as always |
| `unreleased` | the commit provably is **not** a release (a default-branch fetch, a branch pin, a working tree) | write commands **refuse**, naming the pinned command to run |
| `unverified` | it could not find out (offline, GitHub unreachable) | it **warns and proceeds** — your CI never depends on our reachability |

The check is on the **commit**, not on whether you typed a `#ref` — which is strictly stronger: a
re-cut or force-pushed tag stops matching, and is caught. It costs at most one `git ls-remote` on
the `npx` path, and **nothing at all** when the toolkit is a git checkout (`git describe` answers
it offline).

Commands that read no toolkit content are untouched: plain `doctor` (it only hashes your files
against your lock), `init`, `eject`, `uninstall`, `validate`. `list` and `setup` report rather than
write, so they warn and carry on.

**Developing the toolkit itself?** Rendering from a working tree is the whole point there — pass
`--allow-unreleased` (or set `WAFFLESTACK_ALLOW_UNRELEASED=1`). It suppresses the *refusal*, not
the *truth*: the toolkit still reports itself as unreleased.

**And it is recorded.** Your lock carries a `toolkit` block naming the ref and commit SHA that
produced the render — so `doctor` can tell you *which* toolkit made it, and flag the one thing a
version string can never express: **same version, different commit**.

```json
"toolkit": { "source": "github:dustinkeeton/wafflestack", "sourceType": "git",
             "ref": "v0.12.0", "commit": "e3f1c0d9…", "status": "release" }
```

A commit SHA is recorded **only when it identifies immutable content** — i.e. a release. A render
from an untagged checkout writes `{ ref: null, commit: null, status: "unreleased" }`, because a
`HEAD` SHA would name content that a dirty working tree did not produce, and it would churn your
lock on every commit. `doctor`'s provenance check is a **note, never a failure**: your required
`waffle-doctor` check stays green.
