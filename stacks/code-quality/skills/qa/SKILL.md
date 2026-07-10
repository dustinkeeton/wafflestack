---
name: qa
description: Functional QA of a green PR against the linked issue's intent — read the full diff plus the issue's acceptance criteria, best-effort run the project's tests and exercise the changed behavior, and assess whether the diff carries real test coverage, posting findings as one PR review. Severity stays honest — "no QA concerns" is a valid outcome for a change that does what its issue asked and proves it with tests. Invokable by users and agents.
user-invocable: true
argument-hint: "<PR#, number, or PR URL> (omit for the current branch's PR)"
---

# QA

When this skill is invoked, you QA a **finished, CI-green pull request** against **what its
linked issue asked for**. Green checks prove the code *runs*; they do not prove the change
*does what the issue intended*, or that the changed behavior carries tests that would catch it
regressing. Your job is the functional gate between "checks passed" and "merge": read the diff
**and** the issue, enumerate the intended behaviors, test what the repo lets you test, and
report where the change falls short of its own spec.

This is distinct from `adversarial-review`, which reviews the same green PR from a hostile
reviewer's seat — correctness edge cases, API/naming choices, error handling, design. QA asks
the complementary questions: **does the change do what the issue said**, and **is the changed
behavior actually covered by tests**? A PR can survive a hostile design review and still ship
with an acceptance criterion quietly missing — that gap is exactly what this skill exists to
catch. Like its sibling, this skill **reports**; it never commits fixes or tests itself — the
`pr-response` skill is the applying half that disposes of the findings.

Your severity must stay **honest**. You are not here to manufacture findings to look
thorough — a change that does what its issue asked, with real coverage, earns a clean bill of
health. "No QA concerns" is a valid, and sometimes correct, outcome. The value is in finding
the *real* gaps between intent and implementation, not in the count.

## 1. Resolve the target PR

Inspect `$ARGUMENTS`:

| `$ARGUMENTS` | What to do |
|--------------|------------|
| `#N`, a bare number, or a PR URL | QA that PR. Reduce it to the PR number `N`. |
| empty / omitted | QA the **current branch's** open PR: `gh pr view --json number,url` (fails if the branch has no PR — report that and stop). |

Resolve the repo coordinates and the head commit up front — you need them to post inline
comments and to confirm the PR is really green:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
gh pr view "$N" --json number,title,state,isDraft,headRefName,headRefOid,mergeable,statusCheckRollup,url,author
```

- If the PR is **closed or merged**, there is nothing to gate — report and stop.
- If it is a **draft** or its **required checks are not yet green**, say so: this skill is the
  *post-green* gate. You may still QA on request, but note that checks haven't passed.

## 2. Read the diff AND the issue's intent

```bash
gh pr diff "$N"
gh pr view "$N" --json files,body,closingIssuesReferences
```

The issue is the spec. For **each linked issue** in `closingIssuesReferences`, read its full
body:

```bash
gh issue view <issue#> --json title,body
```

If `closingIssuesReferences` is empty, fall back to parsing closing keywords (`Closes #N`,
`Fixes #N`, `Resolves #N`) out of the PR body and read those issues. If the PR links **no
issue at all**, QA against the PR body's own stated intent — and say plainly in the review
that no issue was linked, so the spec you verified against is the PR's self-description.

Then **distill an acceptance checklist**: the concrete behaviors, criteria, and constraints
the issue (or PR body) says this change must deliver. Explicit `- [ ]` acceptance criteria are
checklist items verbatim; prose intent becomes the behaviors it implies. This checklist is
what the rest of the run verifies — every item ends the run as **met**, **not met**, or
**not verifiable here** (with the reason).

Do not QA the diff in isolation. For each checklist item, find where the diff claims to
deliver it — open the files, trace the changed call paths — so your verdicts are grounded in
what the change actually does, not what its description says it does.

## 3. Test what the repo offers (best-effort)

Prefer **running** the change over reading it. Check out the PR's head branch if it isn't the
current branch (same precedent as `pr-response`):

```bash
gh pr checkout "$N"
```

Then, in priority order, as far as the repo allows:

1. **Run the project's test suite** and read the result — a green suite is the floor, not the
   verdict:

   ```bash
   {{project.testCmd}}
   ```

2. **Exercise the changed behavior directly where feasible** — run the CLI path the diff
   touched, hit the changed function with the acceptance checklist's inputs, reproduce the
   bug the issue reported and confirm it no longer reproduces. The issue's acceptance
   criteria are your test cases; walk them one by one.
3. **Assess the diff's test coverage.** For each load-bearing added or changed line, ask:
   *which test would fail if this line were deleted or broken?* If the answer is "none", that
   is a coverage finding. Think failing-test-first: for each suspected gap, name the test that
   *should* exist (file, case, the assertion that would pin the behavior) — you report that
   missing test as a finding; you do not write or commit it here. Over-mocked tests that would
   pass even with the change broken count as gaps, not coverage.

**Degrade honestly when execution isn't feasible** — a dirty working tree you must not
disturb, no runnable test command, an environment the change can't be exercised in. Fall back
to the static coverage assessment (item 3) and the diff-vs-checklist walk, and **say so in
the review**: state what you ran, what you could not run, and why. Never imply you executed
something you didn't.

## 4. Rank findings by honest severity

Assign each finding a severity and let that drive whether it blocks:

- **blocker** — an acceptance criterion of the linked issue that the change does not meet, a
  changed behavior you demonstrated doing the wrong thing, or load-bearing new logic with no
  test that would fail if it broke. A missing acceptance criterion that ships is a blocker.
  Reserve this for gaps you can demonstrate; if you are not sure it's real, it is not a
  blocker.
- **should-fix** — thin coverage of the changed behavior (the happy path is tested, the
  criterion's edge is not), a secondary criterion met only partially, or a test that passes
  without actually exercising the change.
- **nit** — a minor test-hygiene or verification improvement. Label it as optional.

Do **not** pad the list. If the only honest finding is one nit, post one nit. If there are
none, say so (step 6).

## 5. Post findings as one PR review

Frame each finding as an **actionable demand to the author**: name the acceptance criterion
or behavior, the gap between it and the change, and what would resolve it (the missing test,
the unmet criterion's fix). Prefer **inline comments anchored to the offending line**, plus
one **summary review comment** that gives the verdict and walks the acceptance checklist.

Post everything as a **single review** so the author gets one coherent notification.

**Assemble the payload in a file, then post it with one single-line command.** Use the `Write`
tool to create `/tmp/qa-review.json` (outside the repo, so the working tree stays clean), then
submit it. Never build the review with a heredoc or a multi-line `--body "…"`: a heredoc is a
*multi-line command*, and an automated caller's tool allowlist matches on the command's
leading program (`Bash(gh api:*)`), which a multi-line compound never matches — the call is
denied and the review silently never posts.

Write this JSON to `/tmp/qa-review.json` — `line` must be a line that appears in the PR's
diff, `side: RIGHT` for added/context lines and `LEFT` for removed lines. The `body` MUST
carry the literal marker `<!-- waffle-qa -->` as its FIRST line (see below):

```json
{
  "event": "COMMENT",
  "body": "<!-- waffle-qa -->\n**QA** — 1 blocker, 1 should-fix. Acceptance criteria: 2 of 3 met.\n\n- **[blocker]** Issue #12 criterion \"empty input returns an empty list\" is not met — `parseRange(\"\")` still throws (see inline).\n- **[should-fix]** The new `--force` flag has no test that would fail if the flag were ignored.\n\nRan `npm test` (green, 214 passing); exercised the CLI export path by hand — criteria walk below.\n\n— posted by the qa bot",
  "comments": [
    { "path": "src/range.ts", "line": 42, "side": "RIGHT",
      "body": "**[blocker]** Issue #12's first acceptance criterion says empty input returns an empty list; this line still throws on `\"\"`. Exercised directly: `parseRange(\"\")` → TypeError. Fix the guard and add a test pinning the empty-input contract." },
    { "path": "src/cli.ts", "line": 88, "side": "RIGHT",
      "body": "**[should-fix]** No test exercises `--force` — deleting this branch leaves the suite green. Add a case that runs the command with and without the flag and asserts the differing outcome." }
  ]
}
```

Then post it — one program, one line, no compounds:

```bash
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --method POST --input /tmp/qa-review.json
```

Notes on mechanics:

- **The marker is load-bearing — and it is this skill's own.** Every review this skill posts —
  findings *or* no-concerns — must contain the exact literal `<!-- waffle-qa -->` on its own
  line at the top of the summary body. It is how this skill and any automation wrapping it
  recognize a QA review. It is deliberately **distinct from the adversarial-review skill's
  marker**: the `waffle-pr-green-hook` workflow keys its duplicate-review guard on that
  skill's marker, and the opt-in pr-response hook dispatches on reviews carrying it — a QA
  review that carried that other marker would falsely satisfy the pr-green dedup (skipping the
  real adversarial review) and fire a paid dispatch. Never put the adversarial-review skill's
  marker in a QA review.
- Use **`event: "COMMENT"`** — an honest, non-approving review. Escalate to
  `event: "REQUEST_CHANGES"` **only** for a genuine **blocker**; never as a default posture.
  GitHub forbids `REQUEST_CHANGES`/`APPROVE` on your **own** PR, so if the review identity
  authored the PR (common for agent-authored PRs), fall back to `event: "COMMENT"` and let
  the severity labels in the body carry the weight.
- A `line` that isn't part of the diff is rejected by the API. If a finding is about behavior
  the diff only *touches indirectly* (e.g. an unmet criterion with no single offending line),
  describe it in the **summary body** with a `file:line` reference instead of forcing an
  inline anchor.
- The file is the standard path, not a fallback: `--input <file>` sidesteps both the
  shell-escaping traps of many `-f`/`-F` flags and the multi-line-command trap above.

## 6. "No QA concerns" is a valid outcome

If the change genuinely delivers what its issue asked — every acceptance criterion met, the
changed behavior exercised or credibly covered, the suite green — **say so plainly** and do
not invent findings to justify the run. Same rule as step 5: the body goes in a **file**,
never inline after `--body`. `Write` the summary to `/tmp/qa-summary.md`, marker on its own
line, including the criteria walked and what you ran:

```markdown
<!-- waffle-qa -->
QA: no concerns. All 3 acceptance criteria of #12 verified met; ran the test suite (green)
and exercised the changed export path directly. The new branch logic is pinned by the two
tests added in this PR.

— posted by the qa bot
```

Then post it with a single-line command:

```bash
gh pr review "$N" --comment --body-file /tmp/qa-summary.md
```

## 7. Verify delivery, then report back

**Prove the review actually posted** before claiming success — an allowlist denial or an API
error leaves all the work done and nothing delivered. Check that at least one review **on the
current head commit** carries this skill's marker. The head-scoping is load-bearing: a
review's `commit_id` is the PR head at submit time, and an *unscoped* check would be
satisfied by an **earlier round's** review — in a multi-round loop (autopilot runs
`qa` → `pr-response` repeatedly) a silently denied POST from round 2 on would still "verify"
against round 1's review and this round's findings would be lost. `--paginate` matters in the
other direction: the reviews endpoint pages at 30, so on a busy PR an unpaginated check can
miss the marked review and fail falsely:

```bash
HEAD_SHA=$(gh pr view "$N" --json headRefOid -q .headRefOid)
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --paginate --jq '.[] | select(.commit_id == "'"$HEAD_SHA"'") | select(.body | contains("<!-- waffle-qa -->")) | .id'
```

Expect **at least one review id**. **Fail closed:** if the POST in step 5/6 errored, or this
check errors or prints nothing, report the error verbatim and do **not** claim the review
posted — a QA pass whose findings never landed is a failed pass, not a clean one.

Then return a concise summary to the caller: the PR URL, the count of findings by severity
(blocker / should-fix / nit, or "none") — the per-severity count is what an orchestrating
loop reads — the acceptance-criteria tally (met / not met / not verifiable), what was
executed (test command result, behaviors exercised) versus statically assessed, and one line
on the most important finding if there is one.

## When called by agents

An agent may invoke this skill (via its frontmatter `skills:` grant) to functionally gate a
PR before it merges — most notably the `autopilot` skill's opt-in QA gate, which runs
`qa <PR#>` → `pr-response <PR#> --yes` rounds on each green PR before its review loop. The
same workflow applies: the agent passes the PR number (or lets it default to the current
branch's PR), the review posts to the PR where `pr-response` reads it, and the structured
summary (step 7) is the agent's return value. Honesty still governs severity — an agent must
not manufacture blockers to look diligent, and "no QA concerns" is a legitimate result to
hand back.
