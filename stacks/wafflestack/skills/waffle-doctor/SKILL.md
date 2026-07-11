---
name: waffle-doctor
description: Check whether this repo's rendered wafflestack files still match the lock (drift detection). Use to diagnose a CI doctor failure or before committing; explains each modified/missing finding.
user-invocable: true
argument-hint: "(no refs — add --allow-missing to tolerate absent managed files; only modified files then fail)"
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

## Explain the findings — don't just relay them

- **`modified: <path>`** — that generated file was edited by hand. The fix is almost always
  **`/waffle-render`**, which restores it verbatim. If the user *wanted* to change it, the
  supported paths are a `.waffle/extensions/` file (to append guidance) or **`/waffle-eject`**
  (to take the file over as project-owned) — never a raw edit, which just re-drifts.
- **`missing: <path>`** — a locked file isn't on disk. Either it was deleted (re-render to
  restore) or the repo intentionally gitignores that render (then `--allow-missing` is the
  right posture, matching the CI workflow's `doctor.flags`).
- **`every managed file (N/N) is absent`** — the repo never rendered, so the check had nothing
  to verify and fails even under `--allow-missing`. Do **not** reach for another flag; there
  isn't one. Either run **`/waffle-render`** (the usual answer — the render is simply missing),
  or, if the repo deliberately commits only the lock and gitignores its whole render, stop
  gating on doctor: gate on `render` + `git diff --exit-code .waffle/waffle.lock.json`, which
  is the check that actually catches drift in that posture.
- **`all managed files match the lock manifest`** — clean; nothing to do.
- **version-skew note** — doctor mentions when the lock was written by a different toolkit
  version. That is informational; pin `{{waffle.toolkitRef}}` (and the repo's version) to a
  release tag to silence it, or run **`/waffle-upgrade`** to move forward deliberately.

Report the exit status plainly: a clean doctor is the green light to commit; drift must be
resolved (usually by re-rendering) first.
