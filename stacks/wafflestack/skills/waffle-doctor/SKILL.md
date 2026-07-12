---
name: waffle-doctor
description: Check whether this repo's rendered wafflestack files still match the lock (drift detection). Use to diagnose a CI doctor failure or before committing; explains each modified/missing/stale-render finding.
user-invocable: true
argument-hint: "(no refs — --allow-missing tolerates absent managed files; --verify-render also checks the lock against a fresh render of the config)"
---

# Doctor — drift check

Wraps `wafflestack doctor` — it diffs the files on disk against `.waffle/waffle.lock.json` and
reports **`modified:`** (a managed file was hand-edited) and **`missing:`** (a locked file is
absent) entries, exiting non-zero when any real drift is found. It is the same check the
`waffle-doctor` CI workflow runs as a required gate, so this skill is how you diagnose a red
build locally.

## Run it

```bash
npx --yes {{waffle.toolkitRef}} doctor
```

Pass `--allow-missing` through when `$ARGUMENTS` asks (or when diagnosing a repo that
deliberately gitignores some renders): absent managed files become informational and only
**modified** files fail. A missing **lock** still fails either way — that means the repo was
never rendered. So does a checkout where **every** managed file is absent: the flag tolerates a
*subset* of absent renders, never the whole set, because a check with nothing present verified
nothing.

## `--verify-render` — the check that catches a forgotten re-render

Plain doctor compares the tree to the lock. It never asks whether **either still matches
`.waffle/waffle.yaml`** — so a config edited without a re-render leaves the files and the lock
stale *together*, agreeing with each other, and the check goes green.

`--verify-render` closes that: it renders the committed config and extensions into a **temp
dir**, hashes the result, and compares it against the committed lock. The working tree is never
touched. Reach for it when you suspect a change was made to `.waffle/waffle.yaml`,
`.waffle/extensions/`, or `stacks/**` and never applied:

```bash
npx --yes {{waffle.toolkitRef}} doctor --verify-render
```

It also composes with `--allow-missing` to give a repo that commits **only** the lock a real
gate — nothing is on disk to compare, so the render is reproduced and checked instead.

> Do **not** substitute `render` + `doctor` for this. An in-place `render` rewrites the very
> lock doctor would then check, so it cannot fail. Verifying against the *unmodified* committed
> lock is the whole point.

## Explain the findings — don't just relay them

- **`modified: <path>`** — that generated file was edited by hand. The fix is almost always
  **`/waffle-render`**, which restores it verbatim. If the user *wanted* to change it, the
  supported paths are a `.waffle/extensions/` file (to append guidance) or **`/waffle-eject`**
  (to take the file over as project-owned) — never a raw edit, which just re-drifts.
- **`missing: <path>`** — a locked file isn't on disk. Either it was deleted (re-render to
  restore) or the repo intentionally gitignores that render (then `--allow-missing` is the
  right posture, matching the CI workflow's `doctor.flags`).
- **`every managed file (N/N) is absent`** — nothing was present to check, so the run verified
  nothing and fails even under `--allow-missing`. Usually the render is simply missing: run
  **`/waffle-render`**. If instead the repo *deliberately* commits only the lock and gitignores
  its whole render, the answer is **`--allow-missing --verify-render`** — it verifies the render
  by reproducing it rather than by reading files that were never committed. That is the one flag
  that turns this red into a real green; do not reach for any other.
- **`stale render: <path>`** (`--verify-render` only) — the lock does not match what the config
  *would* render: a change to `.waffle/waffle.yaml`, `.waffle/extensions/`, or `stacks/**` was
  never applied. The fix is **`/waffle-render`**, then commit the render **and** the lock.
  Companion findings: **`stale lock entry:`** (the lock tracks a file the config no longer
  renders) and **`unrendered:`** (the config would produce a file the lock does not track) —
  same cause, same fix.
- **`all managed files match the lock manifest`** — clean; nothing to do. Note this alone does
  *not* mean the render is current — only that the tree matches the lock. Add `--verify-render`
  to also confirm both still match the config.
- **version-skew note** — doctor mentions when the lock was written by a different toolkit
  version. That is informational; pin `{{waffle.toolkitRef}}` (and the repo's version) to a
  release tag to silence it, or run **`/waffle-upgrade`** to move forward deliberately.

Report the exit status plainly: a clean doctor is the green light to commit; drift must be
resolved (usually by re-rendering) first.
