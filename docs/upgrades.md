# Upgrades and release resolution

How wafflestack versions its releases, how you take an upgrade, and how the CLI knows *which*
toolkit it's running before it writes anything. The [Updating](../README.md#updating) section of
the README is the summary; this is the full picture.

> The commit-move report, pin rewriting, and the Release-resolution gate below are newer than the
> latest tag. As of v0.12.0 they live in the CHANGELOG's `[Unreleased]` section and ship with the
> next release.

## Versioning

Releases are git tags (`vX.Y.Z`), versioned **from the consumer's point of view**:

| Bump | Example | What it means for you | How to take it |
|---|---|---|---|
| patch | `0.5.0 → 0.5.1` | content-only fixes | `… render` |
| minor | `0.5.0 → 0.6.0` | new stacks/items, additive config | `… render` |
| major | renamed/removed item, new **required** key, changed layout | needs a migration | `… upgrade` |

The `…` is always a **pinned** spec — `npx github:dustinkeeton/wafflestack#vX.Y.Z`. Unpinned
commands name the default branch and refuse to run (see [Release resolution](#release-resolution)).

## Taking an upgrade

Three ways to run it.

**Ask your agent:**

```text
Upgrade wafflestack in this repo to <newtag>: run
`npx github:dustinkeeton/wafflestack#<newtag> upgrade`, review the CHANGELOG entries it
prints, let it run migrations and re-render, then run `doctor` and tell me what changed
and anything I still owe (e.g. `.gitignore` updates).
```

**Inline shell (Claude Code / Codex):**

```text
! npx --yes github:dustinkeeton/wafflestack#<newtag> upgrade
```

**Yourself:**

```bash
npx github:dustinkeeton/wafflestack#<newtag> upgrade
```

### What it does

`upgrade` walks your install from the version in its lock to the one you invoked:

1. Compares `toolkitVersion` in `.waffle/waffle.lock.json` against the toolkit you ran.
2. Prints the `CHANGELOG.md` entries in between — each carries a **Consumer impact** line.
3. Runs any registered migrations, in order.
4. Re-renders, then runs `doctor`.

Migrations are ordered, idempotent, and keyed to the version that introduced them, so running
`upgrade` on an already-current repo is a safe no-op. A missing or pre-stamping lock falls back to
a plain render + `doctor`.

### It reports the actual commit move

`upgrade` also prints where the toolkit moved, by commit:

```
toolkit moved 0.11.0 (v0.11.0 @ aaaaaaaa) → 0.12.0 (v0.12.0 @ bbbbbbbb)
```

This catches the one case a version number can't describe: the version didn't change but the
toolkit did — a re-cut or force-pushed tag. The lock records the ref *and* the commit SHA that
produced your render, so the move stays visible even when the number holds still.

### It moves your pins

If you pinned `doctor.toolkitRef` (the CI doctor job's fetch) or `waffle.toolkitRef` (what every
`/waffle-*` skill runs) to a release tag, `upgrade` rewrites them to the toolkit that just rendered
your lock — *before* the render, so the new ref is baked into `waffle-doctor.yml` and every rendered
skill in the same run. The pin your CI fetches always matches the pin your lock records.

It only ever moves a pin you already chose:

- **Unpinned** ref → keeps floating.
- **Absent** key → never gets one.
- **`#main` or `#<sha>`** → left alone, and noted.
- **Can't prove it's a release** (`--allow-unreleased`, a `dlx` install, an unanswerable lookup) →
  no pin written.

> **Pinned to an old tag and puzzled why `upgrade` says "already on toolkit X"?** That pin fetched
> the *old* CLI, which can only render itself. It prints the way out —
> `a newer toolkit release exists: v0.14.0 —` and the exact command to run. Run that (or let
> `/waffle-upgrade` do it) and everything moves together.

## Migration history

Two migrations exist so far, both relocating consumer dotfiles:

- **0.6.0** — shortened the names: `.wafflestack.yaml` → `.waffle.yaml`, along with the local
  overlay, the lock, and `.wafflestack/extensions/` → `.waffle/extensions/`.
- **0.8.0** — consolidated everything into one `.waffle/` directory: `.waffle/waffle.yaml`,
  `.waffle/waffle.local.yaml`, and `.waffle/waffle.lock.json`.

You never rename by hand. Any `render` or `upgrade` moves the legacy files in place — chaining a
pre-0.6.0 repo all the way forward in a single pass — and reminds you to update the matching
`.gitignore` entries. It won't edit `.gitignore` itself: swap the entries yourself, or run
`wafflestack install --gitignore`. The old names keep working, with a deprecation note, until you
re-render.

## Release resolution

**Which toolkit am I actually running?**

An `npx github:dustinkeeton/wafflestack` with no `#ref` fetches the **default branch**. The branch
and its latest tag report the same `version`, so for a long time nothing told them apart: a bare
`upgrade` would announce `0.8.0 → 0.12.0`, then write `0.12.0` *plus every unreleased commit since*
into your lock. If CI then ran `doctor --verify-render` through a pinned ref — the required
practice — it re-rendered from the tag, got different bytes, and went red on a lock that was
perfectly correct.

So the CLI now works out **what it is** before writing anything:

| It resolves as | When | What happens |
|---|---|---|
| `release` | the commit it runs IS a `vX.Y.Z` tag | everything works, as always |
| `unreleased` | the commit provably is **not** a release (default-branch fetch, branch pin, working tree) | write commands **refuse**, naming the pinned command to run |
| `unverified` | it couldn't find out (offline, GitHub unreachable) | it **warns and proceeds** — your CI never depends on our reachability |

The check is on the **commit**, not on whether you typed `#ref` — which is strictly stronger: a
re-cut or force-pushed tag stops matching and gets caught. It costs at most one `git ls-remote` on
the npx path, and nothing at all for a local checkout, where `git describe` answers offline.

Read-only commands are untouched — plain `doctor`, `init`, `eject`, `uninstall`, `validate`. `list`
and `setup` report rather than write, so they warn and carry on.

**Developing the toolkit itself?** Rendering from a working tree is the whole point — pass
`--allow-unreleased` (or set `WAFFLESTACK_ALLOW_UNRELEASED=1`). It drops the *refusal*, not the
*truth*: the render still records itself as unreleased.

### What the lock records

Your lock carries a `toolkit` block naming the ref and commit that produced the render:

```json
"toolkit": { "source": "github:dustinkeeton/wafflestack", "sourceType": "git",
             "ref": "v0.12.0", "commit": "e3f1c0d9…", "status": "release" }
```

A commit SHA lands **only when it names immutable content** — a release. An untagged checkout
writes `{ ref: null, commit: null, status: "unreleased" }`, because a `HEAD` SHA would name content
a dirty working tree didn't produce and would churn the lock on every commit. `doctor`'s provenance
check is a **note, never a failure** — your required `waffle-doctor` check stays green.
