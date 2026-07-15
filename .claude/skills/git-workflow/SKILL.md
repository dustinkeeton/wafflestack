---
name: git-workflow
description: Git branching strategy, commit standards, and PR workflow for the wafflestack project. Use when performing any git operations (commits, branches, pushes, PRs).
user-invocable: false
---

# Git Workflow Standards

## Identity

This project commits agent work under the managed bot identity — the `commit` examples
below inject it via `-c` flags (`git.cmd`), so the machine's ambient `user.name` /
`user.email` is never what lands on an agent commit. Identity-free commands (`push`,
`checkout`, `diff`, `log`) stay a bare `git`. Human commits made outside these examples
keep the developer's own config and sign normally. **Signing:** `git.cmd` pins
`commit.gpgsign=false` (and `tag.gpgSign=false`), so agent commits here are deliberately unsigned and carry no
GitHub verification badge — intentional, not accidental. That posture is the recipe's,
not the machine's: never add or remove signing flags per-invocation. Every agent-made
commit must still end with:

```
Co-authored-by: Dustin Keeton <dustin.keeton49@gmail.com>
```

### Bot identity (config)

Reference data resolved from config — the Identity section above governs whether a bot identity
is actually in effect.

- Name (`git.botName`): `Wafflebot`
- Email (`git.botEmail`): `bot@wafflenet.io`
- Signing key (`git.signingKey`): "" — empty means no dedicated bot signing key.
  It **selects** a key; it **enables** nothing. Signing is enabled only by a `git.cmd` that pins
  `commit.gpgsign=true` and references this key.
- Per-agent identities (`git.agentIdentities`) — **overrides only.** When a bot identity is in
  effect, an agent spawned by the `delegate` skill commits under a *derived* identity by default
  (its `identity.displayName`, and the bot email plus-addressed as `bot+<agent-slug>@…`); an entry
  here replaces that per field. The derivation rule lives in the `delegate` skill's "Per-agent
  commit identity" section — that is its canonical definition. `{}` (below) means no overrides:

```yaml
{}
```

These ship placeholder defaults. A project that opts into a bot identity overrides the name in the
committed `.waffle/waffle.yaml` and the email / signing key in the gitignored
`.waffle/waffle.local.yaml` — nested `{{...}}` substitution lets committed values such as `git.cmd`
reference the overlay's keys. Never put private key material in `git.signingKey`: it is a key ID or
a public-key path, and it renders into committed files.

Setting those values alone changes nothing. The opt-in is pointing `git.cmd` at them, so the
identity is injected via `-c` flags into the command examples that actually write it — `commit`,
and an annotated `tag` if you add one. `checkout`, `push`, `diff` and `log` record no committer, so
they stay a bare `git`. In this project `git.cmd` resolves to:

```bash
git -c commit.gpgsign=false -c tag.gpgSign=false -c user.name="Wafflebot" -c user.email=bot@wafflenet.io
```

If that is a bare `git`, no bot identity is in effect and agent commits use the machine's own git
config. To opt in, set `git.cmd` to
`git -c commit.gpgsign=false -c tag.gpgSign=false -c user.name="…" -c user.email=…` referencing the two identity keys
with nested `{{...}}` substitution — quoting `user.name` (it may contain spaces) and setting
**both** keys explicitly in project config rather than relying on their stack defaults. See the
stack's setup note for the exact recipes and the layering rules.

### Attribution trailer (config)

Reference data resolved from config — every agent-made commit ends with the attribution trailer
(`git.coAuthorTrailer`), which by default credits this repo's **owner** so agent work that reaches
the default branch counts toward their GitHub contribution graph:

- Owner name (`git.ownerName`): `Dustin Keeton`
- Owner email (`git.ownerEmail`): `dustin.keeton49@gmail.com`

The owner email must be a **verified email on that GitHub account** for the credit to register
(the `ID+user@users.noreply.github.com` form works and stays private); credit accrues only on
default-branch commits. A project that would rather have the trailer name the bot points
`git.coAuthorTrailer` at `Wafflebot <bot@wafflenet.io>` instead. See the stack's setup note.

### Signing model

Signing has three tiers. When `git.cmd` above is **not** a bare `git`, the resolved command **is**
this project's signing posture — explicit, committed, reviewable. A bare `git` pins no posture: the
machine's own config governs, exactly as it does for humans.

1. **Human** — machine git config. The toolkit configures no signing for humans; your own key and
   account produce GitHub's "Verified" badge exactly as they always did.
2. **Bot and agents** — whatever `git.cmd` pins. The canonical recipe pins
   `commit.gpgsign=false`: bot commits are *deliberately unsigned* and carry **no badge** (which is
   cleaner than the yellow "Unverified" a key GitHub cannot check would earn). A project that wants
   a signing bot pins `commit.gpgsign=true` with `user.signingkey` (and `gpg.format=ssh` for an SSH
   key) — and must use a **non-prompting** signer, or every non-interactive agent commit hangs.
3. **Per-agent keys** — `git.agentIdentities[<agent>].signingKey` appends `-c user.signingkey=`
   after the base flags, so it *selects* the key when the base recipe signs and is inert when it
   does not. A per-agent leaf never flips a project-wide "do not sign".

Never deviate from the resolved `git.cmd` per-invocation — in **either** direction. Do not add
`-c commit.gpgsign=false` because a signing prompt hung (that is a machine/config problem: stop and
surface it), and do not sign when the recipe says not to. Changing the posture means changing
`git.cmd` in config, with the human's say-so.

The asymmetry matters: where `git.cmd` is a bare `git` it pins nothing, so ambient signing is simply
the human's own config doing its job — nothing to deviate from. Where the project **has** opted in,
ambient signing is the bug this model exists to eliminate.

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
git checkout main
git pull
git checkout -b feat/my-feature
```

## Commits

### Message format

```
<type>: <concise summary>

<optional body — why, not what>

Co-authored-by: Dustin Keeton <dustin.keeton49@gmail.com>
```

**Types:** `feat`, `fix`, `refactor`, `chore`, `test`, `docs`

### Rules

- End every commit message with the attribution trailer shown above — agent-made commits must be traceable.
- Pass commit messages via HEREDOC for proper formatting.
- Stage specific files by name; avoid `git add -A` / `git add .` (risks committing secrets, generated files, or large artifacts).
- Never skip hooks (`--no-verify`) or bypass signing unless explicitly asked. The resolved
  `git.cmd` **is** the project's explicit signing posture — never deviate from it per-invocation,
  in either direction, without the human's per-run say-so.
- Prefer new commits over amending — amending overwrites history.
- **Comments are not spec.** In deterministic files (JS, YAML, shell), keep comments short,
  rare, and non-normative — the rule lives in the code and its tests; the why lives in
  `DECISIONS.md`. When you touch a file, shrink its comment mass rather than growing it, and
  never grow a comment to answer a review finding. Skill and agent markdown is the exception:
  that prose is the program.

### Example

```bash
git -c commit.gpgsign=false -c tag.gpgSign=false -c user.name="Wafflebot" -c user.email=bot@wafflenet.io commit -m "$(cat <<'EOF'
feat: add data-export command

Three-phase flow: collect eligible records, confirm with the user,
then write the export with cancellation support.

Co-authored-by: Dustin Keeton <dustin.keeton49@gmail.com>
EOF
)"
```

## Push & Pull Requests

### Pushing

```bash
git push -u origin feat/my-feature
```

### Creating PRs (no human in the loop)

After pushing, create the PR immediately using `gh`:

```bash
gh pr create --title "feat: short title" --body "$(cat <<'EOF'
## Summary
- Bullet points describing changes

## Test plan
- [ ] Lint passes (`npm run validate`)
- [ ] Types pass (`npm run typecheck`)
- [ ] Tests pass (`npm test`)
- [ ] Build passes (`npm run build`)

Co-authored-by: Dustin Keeton <dustin.keeton49@gmail.com>
EOF
)"
```

- PR title should be under 70 characters.
- Always target `main` as the base branch.
- Push and PR without waiting for human approval — the user reviews in GitHub.
- Closing keywords apply **per issue reference**: `Closes #1, #2` only closes #1. Write `Closes #1, closes #2` (one keyword per issue) — and after merge, verify the issues actually closed (see [After a PR merges](#after-a-pr-merges)).

## After a PR merges

Merging isn't the end of the task. Three things go stale the moment a PR lands, and the
**merging agent** owns all three — a CI job can't reach your machine, so local cleanup and
board reconciliation are a **local-agent step by design** (the optional post-merge CI hook
stays scoped to remote-only branch hygiene; see the stack setup note):

1. **Verify the close.** Closing keywords fire only on merge, and only per issue reference
   (see the rule above), so confirm each linked issue actually closed — don't assume it did:

   ```bash
   gh issue view <n> --json state -q .state   # expect CLOSED
   ```

   Re-close by hand any a missing or mis-written keyword left open: `gh issue close <n>`.

2. **Reconcile the board.** If the project has a Projects v2 board, make sure each linked
   issue's **Status** reflects reality — a merged-and-closed issue should read **Done**, not
   linger in *In Progress* or *In Review*. Fix drift in place with the
   `github-project-management` skill, or hand the sweep to the `project-manager` agent. This
   stays a **local-agent step, not CI**: it needs no API budget, and the agent that just
   merged already has the context to fix drift — so board verification is deliberately *not*
   wired into the post-merge CI hook (which does remote branch hygiene only).

3. **Clean up the debris.** Run the `clean-up` skill in its non-interactive post-merge mode to
   delete the merged local branch and its worktree and prune stale remote-tracking refs:

   ```
   clean-up git --yes
   ```

   `--yes` exists for exactly this — an agent calling it right after it merges a PR (it skips
   the confirmation prompt; see the `clean-up` skill). The **remote** head branch is removed by
   GitHub's auto-delete setting or the optional `waffle-post-merge-hook` workflow, but the
   **local** branch and worktree are always the merging agent's job — nothing remote can delete
   them.

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
- **Manual fallback** (hook not installed): after the merge, run
  `git tag vX.Y.Z <merge-commit-sha>`, then `git push origin vX.Y.Z` — two separate commands.

Do **not** push a tag before the PR merges, and never as a substitute for the PR.

## Parallel Work (Worktrees + Named Agents)

When multiple agents work in parallel on files that might conflict:

1. **Use git worktrees** to isolate work:

   ```bash
   git worktree add .claude/worktrees/feat-x feat/feature-x
   ```

   Keeping worktrees under `.claude/worktrees/` keeps them out of the repo's sibling directories and out of version control.

2. **Lock files** — if two agents suspect they'll edit the same file, one should finish first. Use `TaskList` (it takes no arguments) to see what every other agent has in flight — subject, status, and owner.

3. **Conflict alerting** — if you detect a potential conflict with another agent's work, notify them immediately: `SendMessage(to: "<agent-name>", message: "Conflict: I'm editing <file>", summary: "conflict warning")`.

4. **Clean up** worktrees after merging:

   ```bash
   git worktree remove .claude/worktrees/feat-x
   ```

Coordination and isolation are orthogonal — **named agents** provide coordination (task tracking via `TaskCreate`/`TaskUpdate`, messaging via `SendMessage(to: "<name>")`), **worktrees** provide isolation (separate working directories). Use both together for parallel agent work. There is no team to set up: the session has a single implicit team, and the `Agent` tool's `team_name` parameter is deprecated and ignored — a bare `name:` is all an agent needs to be addressable.

## Pre-flight Checklist

Before pushing any branch, run all of these in order. Do not push if any fail:

1. `npm run validate` — lint/format checks pass
2. `npm run typecheck` — types pass
3. `npm test` — all tests pass
4. `npm run build` — build succeeds
5. `git diff main...HEAD` — review all changes since branching
