---
name: pr-docs
description: Refresh the docs on an open pull request, scoped to that PR's own diff — merge the latest base into the branch, compute the changed paths, run the `docs` skill with those paths as its focus, then commit and push the doc updates onto the PR branch. Exits as a no-op, without spawning any docs agent, when the diff touches nothing the docs describe. Use on any open PR before it is marked ready or armed for merge; delegate and autopilot call it when `delegate.docsRefresh` is on.
user-invocable: true
argument-hint: "<PR number>"
---

# PR Docs Refresh

Bring the docs up to date **inside the PR that changed the code**, so a reviewer sees the code and its docs together. This skill does not write docs. It decides **whether** a refresh is needed, works out **what** the refresh should cover, and then runs the `docs` skill with that focus. The `docs` skill owns the pipeline: a read-only architecture change report, then `docs-agent`, then `docs-human`. Never spawn those agents directly from here.

## Who calls it, and the `delegate.docsRefresh` key

- **By hand:** `/pr-docs <PR#>` on any open PR. Running it by hand is consent on its own. The key below is **not** consulted.
- **From delegate / autopilot:** they read `delegate.docsRefresh` (this project: `{{delegate.docsRefresh}}`, default `true`) and call this skill once per PR when it is `true`. When it is `false`, they skip the call. That is the consumer's opt-out from running three agents per PR. The key gates the **caller**. This skill never reads it to refuse an explicit invocation.
- **Never twice per PR.** When autopilot's `/audit` gate runs on a PR, its chain already invokes `docs` scoped to the same diff. Don't run this skill on that PR as well. Autopilot turns `delegate.docsRefresh` off for its delegate run whenever the audit step is on.
- **Where delegate calls it:** Phase 4, after post-agent verification. The orchestrator runs it, not the spawned specialist, and arms auto-merge itself afterwards.

## Preconditions

1. **An open PR.** Resolve its branch and base:

   ```bash
   gh pr view <pr> --json state,headRefName,baseRefName,isCrossRepository -q '[.state, .headRefName, .baseRefName, .isCrossRepository] | @tsv'
   ```

   Stop if the state is not `OPEN`. Stop if the PR comes from a fork (`isCrossRepository` is `true`), because you can't push to a fork's branch.
2. **On the PR's head branch with a clean tree.** Work in the checkout that already holds the branch, which for delegate is the issue's worktree. If no checkout holds it, run `gh pr checkout <pr>`. Never switch the main checkout off its branch to do this. If `git status --porcelain` is not empty, stop: uncommitted work is not this skill's to commit.

## Step 1 — Merge the latest base (late, merge-never-rebase)

Run this step **as late as possible**, right before the PR is marked ready or armed for auto-merge. The doc files are shared by every PR, so a refresh against a stale base is the usual way sibling PRs end up conflicting on the same root docs. Bring the base in first:

```bash
git fetch origin <base>
git merge --no-edit origin/<base>
```

- **Merge, never rebase. Never force-push.** The repo keeps merge commits, and a rebase rewrites a branch a reviewer or a chained PR may already be built on.
- **On a conflict:** if the only conflicts are in docs files, resolve them by keeping the base's version (`git checkout --theirs <file>`). This pass rewrites those files anyway. Then commit the merge. If code conflicts, run `git merge --abort` and stop. Report the conflicting paths. Resolving code is the PR author's job, not this skill's.

## Step 2 — Compute the diff and decide

Take the changed paths from the merge base, so commits that came in from the base don't count:

```bash
git diff --name-only origin/<base>...HEAD
```

`gh pr view <pr> --json files -q '.files[].path'` gives the same list from the API, and it is the same input autopilot's `/audit` gate uses. Prefer the local `git diff` here because it includes the merge you just made.

**No-op exit.** If **every** changed path falls in one of these groups, the docs have nothing to describe. Stop here. Spawn nothing and commit nothing (if Step 1 made a merge commit, push it with `git push`). Report **`pr-docs: no-op — <reason>`**, naming the groups the paths fell into:

- **Tests and fixtures:** `test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`, eval cases.
- **Changelog:** `CHANGELOG.md`.
- **The docs themselves:** the machine docs ({{docs.machineDocSet}}) and the human docs ({{docs.humanDocSet}}).
- **Generated or lock output:** dependency lockfiles, and any rendered output or lock manifest regenerated from a source path that is not itself in the diff.

If even one path falls outside those groups, run the refresh. When you aren't sure, run it. A refresh that changes nothing costs three agents. A skipped refresh leaves the docs stale until something else notices.

## Step 3 — Run `docs`, focused on the diff

Invoke the `docs` skill and pass the changed paths from Step 2 as its **focus**. List the paths that triggered the refresh, not the no-op groups. This is the same diff-scoping that autopilot's `/audit` gate uses: the architecture step reports only on what these paths changed, and `docs-agent` / `docs-human` update only the doc entries that describe them. Never re-document the whole repo for one PR. Let `docs` run to completion. Its three steps run one after another.

## Step 4 — Commit and push onto the PR branch

```bash
git status --porcelain
```

- **No changes:** the docs already matched the diff. Report **`pr-docs: up to date — <N> paths checked, no doc changes`**. If Step 1 made a merge commit, push it anyway so the branch carries the base it was checked against.
- **Changes:** stage only the doc files the pipeline touched (`git add <path>…`, never `git add -A`). Commit them:

  ```bash
  {{git.cmd}} commit -m "docs: refresh docs for the changes in #<pr>" -m "{{git.coAuthorTrailer}}"
  ```

  Then push with `git push`. A plain push is all you need: Step 1 merged, so the push is a fast-forward. Report **`pr-docs: refreshed — <files changed>`**.

If the project renders committed output from doc-adjacent sources, re-run that render and commit it **in the same commit**, so a required drift check stays green.

## Report

End with exactly one status line, so a caller can branch on it without parsing prose:

| Line | Meaning |
|---|---|
| `pr-docs: no-op — <reason>` | The diff touches nothing the docs describe. No agents spawned, no commit made (a base merge may still have been pushed). |
| `pr-docs: up to date — …` | `docs` ran and changed nothing. |
| `pr-docs: refreshed — …` | Doc changes committed and pushed onto the PR branch. |
| `pr-docs: stopped — <reason>` | A precondition failed, the merge hit a code conflict, or the push failed. Nothing was pushed by this step. |

## Guardrails

- Never push to the base branch, never rebase, never force-push. Never mark the PR ready and never arm auto-merge: those are the caller's moves, and they come **after** this skill finishes.
- Commit only the doc files the pipeline changed, plus any render they require.
- Follow the `git-workflow` skill for the commit and push conventions.
