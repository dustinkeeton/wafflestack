---
name: git-workflow
description: Git branching strategy, commit standards, and PR workflow for the {{project.name}} project. Use when performing any git operations (commits, branches, pushes, PRs).
user-invocable: false
---

# Git Workflow Standards

## Identity

{{git.identitySection}}

## Branch Strategy

### Main is protected

- **NEVER push directly to `main`.**
- All work happens on feature branches.
- Changes reach `main` only through pull requests.

### Branch naming

- `feat/<short-description>` — new features
- `fix/<short-description>` — bug fixes
- `refactor/<short-description>` — restructuring without behavior change
- `chore/<short-description>` — tooling, config, docs, CI

### Creating a branch

```bash
git checkout main && git pull
{{git.cmd}} checkout -b feat/my-feature
```

## Commits

### Message format

```
<type>: <concise summary>

<optional body — why, not what>

{{git.coAuthorTrailer}}
```

**Types:** `feat`, `fix`, `refactor`, `chore`, `test`, `docs`

### Rules

- End every commit message with the attribution trailer shown above — agent-made commits must be traceable.
- Pass commit messages via HEREDOC for proper formatting.
- Stage specific files by name; avoid `git add -A` / `git add .` (risks committing secrets, generated files, or large artifacts).
- Never skip hooks (`--no-verify`) or bypass signing unless explicitly asked.
- Prefer new commits over amending — amending overwrites history.

### Example

```bash
{{git.cmd}} commit -m "$(cat <<'EOF'
feat: add data-export command

Three-phase flow: collect eligible records, confirm with the user,
then write the export with cancellation support.

{{git.coAuthorTrailer}}
EOF
)"
```

## Push & Pull Requests

### Pushing

```bash
{{git.cmd}} push -u origin feat/my-feature
```

### Creating PRs (no human in the loop)

After pushing, create the PR immediately using `gh`:

```bash
gh pr create --title "feat: short title" --body "$(cat <<'EOF'
## Summary
- Bullet points describing changes

## Test plan
- [ ] Lint passes (`{{project.lintCmd}}`)
- [ ] Tests pass (`{{project.testCmd}}`)
- [ ] Build passes (`{{project.typecheckCmd}} && {{project.buildCmd}}`)

{{git.coAuthorTrailer}}
EOF
)"
```

- PR title should be under 70 characters.
- Always target `main` as the base branch.
- Push and PR without waiting for human approval — the user reviews in GitHub.
- Closing keywords apply **per issue reference**: `Closes #1, #2` only closes #1. Write `Closes #1, closes #2` (one keyword per issue) — and after merge, verify the issues actually closed.

## Releases

A release is a **lightweight tag `vX.Y.Z` on the bump commit** — nothing more. The flow is
PR-first, so it never violates *Main is protected*:

1. **Bump via a PR.** On a `chore/bump-X.Y.Z` branch: `npm version X.Y.Z --no-git-tag-version`
   (updates `package.json` + lockfile, no tag), sync any other documented version locations,
   stamp `CHANGELOG.md` (`[Unreleased]` → `[X.Y.Z] - <date>`, leave a fresh empty
   `[Unreleased]`), re-render if generated output tracks the version, run the pre-flight, then
   open the PR — its body carries the consumer-impact notes.
2. **Tag on merge.** The tag is pushed **after** the bump PR merges, as a lightweight tag on
   the merge commit — so `vX.Y.Z` always points at the commit that actually carries that
   version on `main`. Never tag the feature branch pre-merge, and never `git push origin main`
   directly for a release.

Two ways the tag gets pushed:

- **Automated (preferred):** label the bump PR with the release label; the `waffle-release-hook`
  workflow pushes `vX.Y.Z` on merge. The `release` skill does the whole bump-PR half (level
  selection, bump, CHANGELOG stamp, pre-flight, PR, label) — use it rather than doing these
  steps by hand.
- **Manual fallback** (hook not installed): after the merge,
  `git tag vX.Y.Z <merge-commit-sha> && git push origin vX.Y.Z`.

Do **not** push a tag before the PR merges, and never as a substitute for the PR.

## Parallel Work (Worktrees + Teams)

When multiple agents work in parallel on files that might conflict:

1. **Use git worktrees** to isolate work:

   ```bash
   git worktree add {{git.worktreesDir}}/feat-x feat/feature-x
   ```

   Keeping worktrees under `{{git.worktreesDir}}/` keeps them out of the repo's sibling directories and out of version control.

2. **Lock files** — if two agents suspect they'll edit the same file, one should finish first. Use `TaskList(team_name: ...)` to check which files other agents are modifying.

3. **Conflict alerting** — if you detect a potential conflict with another agent's work, notify them immediately: `SendMessage(to: "<agent-name>", content: "Conflict: I'm editing <file>")`.

4. **Clean up** worktrees after merging:

   ```bash
   git worktree remove {{git.worktreesDir}}/feat-x
   ```

Teams and worktrees are orthogonal — teams provide coordination (task tracking, messaging), worktrees provide isolation (separate working directories). Use both together for parallel agent work.

## Pre-flight Checklist

Before pushing any branch, run all of these in order. Do not push if any fail:

1. `{{project.lintCmd}}` — lint/format checks pass
2. `{{project.typecheckCmd}}` — types pass
3. `{{project.testCmd}}` — all tests pass
4. `{{project.buildCmd}}` — build succeeds
5. `git diff main...HEAD` — review all changes since branching
