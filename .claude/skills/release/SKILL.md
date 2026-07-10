---
name: release
description: Cut a wafflestack release — pick the semver bump from the changes since the last tag (or take an explicit version), open a `chore/bump-X.Y.Z` PR, and label it so the tag is pushed on merge. Invokable by users and agents.
user-invocable: true
argument-hint: "<explicit X.Y.Z> | <major|minor|patch> | (omit to infer the level from changes since the last tag)"
---

# Cut a Release

Releases are **lightweight tags `vX.Y.Z` on the bump commit** (see the `git-workflow`
skill's *Releases* section for the spec). This skill automates the **bump-PR half**: it
prepares the version bump and opens a labeled PR. It deliberately does **not** push the tag —
the `waffle-release-hook` workflow does that on merge, so the tag always lands on the actual
bump commit on `main`. Never `git tag` / `git push --tags` from this skill.

## 1. Determine the new version

Resolve `$ARGUMENTS`:

| `$ARGUMENTS` | What to do |
|--------------|------------|
| an explicit `X.Y.Z` (e.g. `0.9.0`) | Use it verbatim as the new version. |
| `major` / `minor` / `patch` | Bump the current `package.json` version by that level. |
| empty / omitted | **Infer the level** from the changes since the last tag (below), then bump. |

Read the current version and the last release tag:

```bash
CURRENT=$(node -p "require('./package.json').version")
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
```

To infer the level, review what changed since `$LAST_TAG` and classify by semver — read from
the perspective of a **consuming** project:

```bash
git log --oneline "${LAST_TAG:+$LAST_TAG..}HEAD"
git diff --stat "${LAST_TAG:+$LAST_TAG..}HEAD"
```

- **patch** — content-only fixes; a consumer just re-renders.
- **minor** — new stacks/items or additive (optional) config; existing config/extensions untouched.
- **major** — a renamed/removed item, a new **required** config key, or a changed file layout (ships a migration).

Prefer the project's `CHANGELOG.md` `[Unreleased]` section as the source of truth for what
landed; if it lists a breaking change, that forces the level. State the level and the
resulting `X.Y.Z` before proceeding.

## 2. Branch

Never work on `main`. Create the bump branch (per `git-workflow`):

```bash
git checkout main && git pull
git checkout -b chore/bump-X.Y.Z
```

## 3. Apply the bump

1. **package.json + lockfile** — the one command that touches both, no tag:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

2. **Other documented version locations** — update the version string in each file listed in
   `release.versionFiles` (find the old `CURRENT` version, replace with the new one). For this
   project that list is: STATUS.md. If the list is empty, there are no extra
   files to touch beyond package.json/lockfile — skip this step.

3. **CHANGELOG.md** — stamp the release. Rename the `## [Unreleased]` heading to
   `## [X.Y.Z] - YYYY-MM-DD` (today's date), then add a fresh empty `## [Unreleased]` section
   above it. Keep every entry — `wafflestack upgrade` reads these dated sections to tell a
   consumer what changed between versions, so an unstamped release is invisible to it. Confirm
   the entry carries a **Consumer impact** line.

4. **Re-render if generated output tracks the version** — if this project generates files from
   versioned sources (e.g. a toolkit that renders stacks), regenerate them now so the bump and
   its render land in the same commit. Never hand-edit generated output.

## 4. Pre-flight

Run the full checklist from `git-workflow`; do not open the PR if any fail:

1. `npm run lint --if-present`
2. `npm run validate`
3. `npm test`
4. `npm pack --dry-run`

## 5. Commit, push, open the labeled PR

```bash
git -c commit.gpgsign=false -c tag.gpgSign=false -c user.name="Wafflebot" -c user.email=bot@wafflenet.io commit -m "$(cat <<'EOF'
chore: bump to X.Y.Z

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)" <explicit paths — package.json, package-lock.json, CHANGELOG.md, and each versionFiles path>
git push -u origin chore/bump-X.Y.Z
```

Open the PR against `main`. The body must carry the **consumer-impact notes** for this
version — lift them from the `[X.Y.Z]` CHANGELOG entry you just stamped, so a reviewer sees at
a glance whether the upgrade is a plain re-render or needs a migration:

```bash
gh pr create --base main --title "chore: bump to X.Y.Z" --body "$(cat <<'EOF'
## Summary
- Bump to X.Y.Z (<level>).

## Consumer impact
<the Consumer impact line(s) from the CHANGELOG [X.Y.Z] entry>

## Release
Labeled `waffle:release` — merging this PR triggers `waffle-release-hook`, which
pushes the lightweight tag on the merge commit. No tag is pushed from this PR.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## 6. Apply the release label (arms the tag-on-merge hook)

The `waffle-release-hook` workflow fires only when a **merged** PR carries the label in
`labelHook.releaseLabel` (default `waffle:release`). Apply it to the bump PR:

```bash
gh pr edit <PR#> --add-label "waffle:release"
```

The label must already exist in the repo — `gh pr edit --add-label` fails otherwise. Check
with `gh label list`; if it's missing, ask the user before creating it, e.g.:

```bash
gh label create "waffle:release" --color 0E8A16 --description "Merging pushes the release tag (waffle-release-hook)"
```

If the repo has **not** installed `waffle-release-hook.yml` (it is opt-in syrup), applying
the label does nothing on merge — say so, and the maintainer must push the tag manually:
`git tag vX.Y.Z <merge-commit-sha> && git push origin vX.Y.Z` (lightweight).

**Caveat — tag-triggered downstream pipelines.** If the repo has `on: push: tags` workflows
(a build, provenance, or GitHub-Release-asset pipeline the tag is meant to start), the identity
that pushes the tag decides whether they fire. The installed hook pushes with the default
`GITHUB_TOKEN` unless a `WAFFLE_RELEASE_TOKEN` PAT/GitHub App token secret is set — and a tag
pushed by `GITHUB_TOKEN` does **not** trigger other workflows (GitHub's anti-recursion rule).
The tag lands and looks done, but nothing downstream ships. Tell the maintainer to set
`WAFFLE_RELEASE_TOKEN` (or have the tag workflow expose a `workflow_call` entry point invoked by
a content-gated tagging workflow); see the github-workflow stack's release-hook setup note. A
**manual** `git push origin vX.Y.Z` runs under the maintainer's own credentials, so it does
trigger those workflows — the limitation is specific to the hook's `GITHUB_TOKEN` push.

## 7. Report

Output: the new version and inferred level, the PR URL, that the release label was applied
(or created / skipped, with reason), and the reminder that **the tag is pushed by
`waffle-release-hook` when the PR merges — do not push it by hand.**

## Guardrails

- Never push to `main`; the bump lands via the PR the maintainer merges.
- Never `git tag` or `git push --tags` from this skill — tagging is the on-merge hook's job so
  the tag lands on the real bump commit.
- Stage explicit paths only; never `git add -A`.
