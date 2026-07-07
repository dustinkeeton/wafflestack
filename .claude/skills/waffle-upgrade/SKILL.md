---
name: waffle-upgrade
description: Move this repo's wafflestack pin to the toolkit's current version — runs migrations, re-renders, and doctors. Use to adopt a new toolkit release; review the diff before committing.
user-invocable: true
argument-hint: "(no arguments)"
---

# Upgrade the toolkit pin

Wraps `wafflestack upgrade` — it moves this repo's version pin to the toolkit version being
run, applies any ordered **migrations** between the two versions, re-renders the current
selection, and runs **doctor**. It takes no refs. Your job is to run it and then **review what
changed** before anything is committed.

## Run it

```bash
npx --yes github:dustinkeeton/wafflestack upgrade
```

Because the version moved comes from the npx ref, prefer the **current** toolkit here — if
`github:dustinkeeton/wafflestack` is pinned to an old tag, an upgrade to that same tag is a no-op.
Mention this if the run reports it is already up to date.

## Review the diff (the point of this skill)

`upgrade` narrates the version move, the changelog between versions, migrations applied, and
the render. After it completes:

1. **Read the changelog span** it printed — call out anything a **consuming** repo must act on
   (behavior changes, renamed keys, new required config, removed items).
2. **Diff the rendered output** so the user sees exactly what moved in their tree:
   ```bash
   git diff -- .waffle/ .claude/
   ```
   Summarize the substantive changes; distinguish pure re-renders from behavior changes.
3. **Handle doctor's verdict.** If `upgrade` ends with drift or warnings, surface them and
   recommend the fix (usually **`/waffle-render`** to restore, or resolving a migration note),
   rather than reporting success.
4. **Do not commit automatically.** Present the diff and let the user (or the git-workflow
   skill) commit the render + lock + version bump together.
