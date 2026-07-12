---
name: pr-response
description: Triage the review findings on a pull request — read every review and review comment (from the adversarial-review bot or a human), score each finding on a four-dimension rubric (severity, validity, effort/risk, alignment), decide Implement / Defer / Decline with a recorded score and one-line reason, apply the accepted fixes, and post one reply per round summarizing the verdicts. Use when a PR has review feedback to answer, when the user says "respond to the review", "address the findings", or "triage the PR comments". Invokable by users and agents.
user-invocable: true
argument-hint: "<PR#, number, or PR URL> (omit for the current branch's PR)  [--yes]"
---

# PR Response

When this skill is invoked, you **answer the review findings on a pull request**. Something
reviewed this PR — the `adversarial-review` skill, a human, a bot — and left findings. Your job
is the step after review and before merge: decide, **per finding**, whether to implement it,
defer it, or decline it; do the accepted work; and post one reply, each round, that shows your
reasoning. Those replies accumulate: the verdict trail is the product, so a later round **appends**
to it and never rewrites it.

The decision is the product here, not the diff. A finding is not a command, and "the reviewer
said so" is not a reason to change code. But neither is silence an answer: every finding gets a
**recorded verdict with a score and a reason**, so a reader can see *why* something was skipped
rather than guessing whether it was even read.

Score honestly. The rubric exists to make your judgment legible and **recalibratable** — not to
launder a decision you already made. If a finding is a true blocker, a low score means the rubric
is wrong, not the finding; say so (see [Recalibrating the rubric](#recalibrating-the-rubric-v1)).

This is the consuming side of `adversarial-review`: that skill *produces* findings on a green PR,
this one *disposes* of them.

## 1. Resolve the target PR

Inspect `$ARGUMENTS`:

| `$ARGUMENTS` | What to do |
|--------------|------------|
| `#N`, a bare number, or a PR URL | Respond to that PR. Reduce it to the PR number `N`. |
| empty / omitted | Respond to the **current branch's** open PR: `gh pr view --json number,url` (fails if the branch has no PR — report that and stop). |
| `--yes` (with or without a PR ref) | Skip the confirmation gate before applying fixes — see [The `--yes` convention](#the---yes-convention). |

Resolve the repo coordinates and the PR's state up front:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
gh pr view "$N" --json number,title,state,isDraft,headRefName,headRefOid,url,author
```

- If the PR is **merged**, there is nothing to apply — you may still post a verdict table for the
  record, but say plainly that the fixes did not land here and file follow-ups instead.
- If the PR is **closed**, report and stop.
- If the PR's head branch is not checked out locally, check it out before applying anything
  (`gh pr checkout "$N"`). Never apply fixes to the wrong branch.

## 2. Read every finding

Reviews and inline review comments are **two different endpoints**. Read both — a review body
carries the summary verdict, and the inline comments carry the specific, anchored findings:

```bash
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --jq '.[] | {id, user: .user.login, state, body}'
gh api "repos/$OWNER/$REPO/pulls/$N/comments" --jq '.[] | {id, user: .user.login, path, line, body}'
```

Issue-style comments on the PR conversation can also carry findings:

```bash
gh api "repos/$OWNER/$REPO/issues/$N/comments" --jq '.[] | {id, user: .user.login, body}'
```

Then **enumerate the findings** as discrete, individually-decidable items. One review body listing
four bullets is **four findings**, not one. Give each a stable number (`F1`, `F2`, …) and carry
that number through scoring, the commits, and the reply.

Skip non-findings: "LGTM", approval boilerplate, a previous `<!-- waffle-pr-response -->` reply of
your own (not a finding — though on a cold start you first *read* it as verdict history; see
[Being resumed across rounds](#when-called-by-agents)), and CI status chatter. If there are **no
findings at all**, say so and stop — do not invent work to look busy.

Before you score, **read the code each finding names**. A finding is a claim about the code; you
cannot judge its Validity from the comment text alone. Open the file, trace the call path, and
check whether the claimed failure is real.

## 3. Score each finding — rubric v1

Score every finding **0–3 on four dimensions**. The anchors are the contract; use them literally.

| Dimension | Question | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|
| **Severity** | What does it cost to leave this unaddressed? | Nothing — pure taste | nit — cosmetic, no behavior change | should-fix — real weakness, not merge-blocking | blocker — correctness bug, data loss, security hole, or untested load-bearing logic |
| **Validity** | Is the finding actually correct? | False positive — the code already handles it | Speculative — no concrete failure or call site named | Plausible — likely right, not fully confirmed | Confirmed — you traced it and reproduced the reasoning |
| **Effort/Risk** | What does the fix cost, and what could it break? *(inverted — low cost scores high)* | Large + risky — redesign, or touches load-bearing code with thin tests | Substantial — a day's work, or a wide blast radius | Moderate — contained change, tests exist | Trivial — a few lines, obviously safe, covered by tests |
| **Alignment** | Does the fix match repo intent, conventions, and owner wishes? | Contradicts a documented decision or the PR's stated scope | Tangential — unrelated to this PR's purpose | Consistent with repo conventions | Directly advances the PR's stated intent or a documented convention |

**Composite** = the four scores summed, 0–12:

| Composite | Verdict | Meaning |
|---|---|---|
| **≥ 8** | **Implement** | Fix it in this PR, now. |
| **4–7** | **Defer** | Real enough to keep, not worth blocking this PR. File a follow-up issue. |
| **≤ 3** | **Decline** | Do not do it. Say why, once, and move on. |

Two rules that override the arithmetic — apply them **explicitly**, never silently:

- **A confirmed blocker is always Implement.** If `Severity = 3` and `Validity = 3`, implement it
  even when Effort/Risk drags the composite under 8. Note the override in the reason.
- **A false positive is always Decline.** If `Validity = 0`, decline regardless of Severity — the
  cost of a bug that does not exist is zero. Note the override in the reason.

Record every score, even for declines. The scores are the dataset that makes the thresholds
tunable; a verdict without its four numbers is exactly the invisible judgment this skill exists to
replace.

## 4. Confirm the plan

Present the verdict table (the [reply format](#5-post-one-reply)) **before** touching code, and
gate on a yes — unless `--yes` was passed.

### The `--yes` convention

`--yes` skips the confirmation gate. It exists for an **agent calling this skill** — a delegate
answering the review on the PR it just opened, or the CI harness responding to an
`adversarial-review` post. Same convention as the `clean-up` skill's `git --yes`. In interactive
use, do not pass it unless the user says "no need to confirm".

The gate covers **applying fixes**, not reading or scoring. Steps 1–3 are read-only and always
safe to run.

## 5. Apply the accepted fixes

For each **Implement** finding, in order, following the `git-workflow` skill:

1. Work on the PR's head branch (checked out in step 1) — never on `main`.
2. Make the smallest change that resolves the finding. Do not smuggle unrelated refactors in
   under a review-response commit.
3. **Add or extend a test** whenever the finding was a correctness bug or a missing-test finding.
   A blocker fixed without a regression test is not fixed.
4. Commit each finding (or each tight cluster) separately, naming the finding number so the reply
   and the history line up:

   ```
   fix: guard empty input in parseRange (F1)
   ```

   Use the commit format and attribution trailer from `git-workflow` — pass the message with
   `{{git.cmd}} commit -F <message-file>` when it needs a body.

5. Run the pre-flight before pushing: `{{project.lintCmd}}`, `{{project.typecheckCmd}}`,
   `{{project.testCmd}}`, `{{project.buildCmd}}`.
6. Push to the PR's branch. The PR updates in place — do not open a second PR.

For each **Defer** finding, file a follow-up issue (the `issue` skill does this well) and put the
issue number in the reply. A defer with nowhere to land is a decline wearing a nicer word.

For each **Decline** finding, do nothing but write the reason.

## 6. Post one reply per round

Post **exactly one** comment per round, summarizing every verdict from *that* round. One comment,
not one per finding — the author already read the findings; what they need is your disposition of
all of them at a glance.

The reply **must** carry the dedup marker `<!-- waffle-pr-response -->` as its first line. The
marker is how this skill (and any automation wrapping it) recognizes its own replies — the ones it
**reads** to recover verdict history on a cold start (see [Being resumed across
rounds](#when-called-by-agents)).

> [!IMPORTANT]
> **The first-line placement is LOAD-BEARING — it is not a formatting convention you may relax.**
> `waffle-pr-response-hook`'s delivery check matches the marker with jq **`startswith()`**, so it
> asks whether the reply *begins* with the marker, not whether it merely contains one. A marker
> moved off line 1 — behind a heading, a blank line, a BOM — makes every denial-bearing run red as
> "the response did NOT post", even though the reply is sitting right there on the PR. Nothing but
> this paragraph enforces the coupling: it is prose-to-prose, and no test can pin a skill's output
> shape against a workflow's predicate. (The sibling `adversarial-review` skill carries the same
> rule for the same reason.)
>
> **Never paste the raw marker literal into the middle of a body, either.** This skill writes
> verdict tables *about* findings, so on a PR that touches the hooks it will be tempted to quote the
> marker in prose — and the hook's loop bound still matches a quoted literal as a substring, so a
> mid-body copy can make a *later* PR look like it was already answered and silently cost it its one
> automated reply. Name the marker, or break the literal, rather than pasting it. Your own reply's
> leading marker is fine — that is the match the guard is looking for.

**Append. Never edit a previous reply.** A second round posts a **new** comment; it does not
rewrite the last one:

```bash
gh pr comment "$N" --body-file "${TMPDIR:-/tmp}/waffle-pr-response-body-$N.md"
```

That holds even when the new round revisits an earlier finding. The rounds are a **paper trail**,
and overwriting one destroys exactly the record this skill exists to produce: what was found, what
it scored, and why it was disposed of that way — at the time, on the evidence then available. A
reader must be able to see that F3 was declined in round 1 and implemented in round 3 *because the
head changed*, and no single mutating comment can show that. If a verdict genuinely changes, say so
in the new comment and name the new evidence; do not quietly retcon the old one.

So the marked comments accumulate, oldest first, and **that is correct** — not a bug to dedup away.
Read them as history; write only new ones.

> [!WARNING]
> Earlier versions of this skill told you to find the last marked comment and `PATCH` it, "so a
> second run leaves one comment carrying the current, complete verdict table." That was wrong, and
> it is the one instruction in this file that actively destroyed user data. If you have a memory,
> a habit, or a wrapper that still does it: stop.

### How to post — write a file, then one single-line command

> **Do not use a heredoc, and do not chain commands.** Multi-line shell (`<<'EOF'`, `cmd1 && cmd2`)
> does not match the `Bash(gh pr comment:*)` permission prefix, so in a non-interactive harness the
> post is **denied** and the reply never lands — silently, after all the work is done. Write the
> body to a file with the `Write` tool, then post it with one single-line command.

That is the whole post path: one `Write`, one line of shell (the `gh pr comment` above). Keep the
body file out of the commit — write it to a temp path, not into the repo.

**The staging path MUST be namespaced by PR number** (`$N`, in scope since step 1):

```
${TMPDIR:-/tmp}/waffle-pr-response-body-$N.md
```

A fixed, un-namespaced path (`/tmp/pr-response-body.md`) is a **correctness bug, not a style nit**.
This skill runs *per PR, concurrently* — an autopilot parallel group responds to several PRs at
once. On one shared path, two runs interleaving a `Write` and a `gh --body-file` post **PR A's
verdict table onto PR B**, and the loser never knows; a stale body left by an earlier run gets
posted as if it were this round's. The PR number in the path is what keeps two concurrent runs from
ever touching the same file.

> **The `Write` tool does not expand shell syntax.** `$N` and `${TMPDIR:-/tmp}` are for the `bash`
> command line only. When you call `Write`, pass a **literal, already-substituted** path —
> `/tmp/waffle-pr-response-body-321.md` for PR 321 — or you will create a file named literally
> `${TMPDIR:-/tmp}` and post nothing. Use the same resolved path in both steps.

**Read back the body before you post it.** Immediately before handing the path to `gh`, use the
`Read` tool on the *exact* file you are about to post and confirm it is the reply you just wrote
**for this PR and this round**: `<!-- waffle-pr-response -->` on line 1, the round label, and the
F-numbers you just dispositioned. If it holds anything else — another PR's verdict table, a prior
round's body, an empty or truncated file — **stop and do not post**: rewrite it, re-read, then post.
The marker makes a wrong-PR reply indistinguishable from a real one, and these replies are the
paper trail this skill exists to produce.

### Label each round

A round's comment should say which round it is and what it is answering, so the trail reads in
order — e.g. `**PR response — round 2** (adversarial review on `<head-sha>`). 5 findings, F3–F7.`
Link back to the previous round's comment rather than restating its verdicts; the F-numbering is
what stitches them together (see step 3 and the resumption rules).

### Reply format

```markdown
<!-- waffle-pr-response -->
**PR response** — 4 findings: 2 implemented, 1 deferred, 1 declined.

| # | Finding | Sev | Val | E/R | Align | Score | Verdict |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| F1 | `parseRange` returns the wrong bound on empty input | 3 | 3 | 3 | 3 | 12 | **Implement** |
| F2 | No test for the `null`-config branch in `load.ts` | 2 | 3 | 3 | 3 | 11 | **Implement** |
| F3 | `flush()` swallows the write error | 2 | 2 | 1 | 2 | 7 | **Defer** |
| F4 | Rename `tmp2` to something meaningful | 1 | 1 | 3 | 1 | 6 | **Defer** |
| F5 | `withTempDir` is already reimplemented here | 1 | 0 | 2 | 1 | 4 | **Decline** |

- **F1 — Implement (12).** Confirmed: `input === ""` yields `[0, -1]`. Fixed in `a1b2c3d` with a
  regression test pinning the bound.
- **F2 — Implement (11).** Confirmed the branch had no coverage. Test added in `d4e5f6a`.
- **F3 — Defer (7).** Real, but surfacing the error changes the caller contract — out of scope for
  this PR. Tracked in #201.
- **F4 — Defer (6).** Fair nit; batched into the naming pass in #202.
- **F5 — Decline (4).** False positive (Validity 0 → auto-decline): this is a different helper
  with a different cleanup contract; `withTempDir` does not unlink on error.

Scored with pr-response rubric **v1** (Severity · Validity · Effort/Risk · Alignment, 0–3 each;
≥8 Implement · 4–7 Defer · ≤3 Decline).

— posted by the pr-response bot
```

Always name the **rubric version** in the reply. When the thresholds move, old replies must remain
interpretable against the rubric that produced them.

## 7. Report back

Return a concise summary to the caller: the PR URL, the finding count by verdict
(implemented / deferred / declined), the commits pushed, the follow-up issues filed, and the URL
of the posted reply. Call out any rule-override you applied (blocker-implement, false-positive
decline) and any finding you could not score confidently.

## Recalibrating the rubric (v1)

**This section is the point of the skill.** The rubric is a guess: four dimensions, equal weight,
two thresholds. Review quality drifts (a bot gets better or noisier) and the repo's own bar drifts
(a prototype hardens into a dependency). A fixed rubric therefore goes wrong slowly and quietly.
The scores in every posted reply are the record that lets you notice, and this file is the one
place to change it.

**Read the drift from the outcomes, not from a feeling:**

| Symptom | What it means | Adjustment |
|---|---|---|
| Deferred/declined findings keep coming back as real bugs | Thresholds too high, or Severity anchors too generous | Lower the Implement threshold, or raise Severity anchors |
| Implemented findings are churn — nits, no behavior change | Threshold too low; Effort/Risk 3 is over-rewarding trivial changes | Raise the Implement threshold, or down-weight Effort/Risk |
| Everything scores 6–8 and lands on Defer | Dimensions are not discriminating; the anchors collapse | Sharpen the 1-vs-2 anchors; consider weighting Validity |
| Declines are argued down by the author every time | Alignment is being scored by the responder's taste, not repo intent | Re-anchor Alignment on *documented* decisions only |
| A whole class of finding has no dimension | The rubric is missing a dimension | Add one — and bump the version |

**How to change it:** edit this file (`skills/pr-response/SKILL.md`) — it is the single source of
truth; the rendered copies are generated output. Bump the version (`v1` → `v2`) in the rubric
heading, the reply footer, and here. Note the change and its motivating evidence in the repo's
`CHANGELOG.md`, because a rubric change silently reinterprets every future verdict.

**Do not** tune per-PR. A rubric adjusted to make one uncomfortable finding go away is not a rubric.
Change it on a pattern across runs, never on a single verdict you dislike.

## When called by agents

An agent may invoke this skill (via its frontmatter `skills:` grant) to close the loop on a PR it
authored — most usefully right after `adversarial-review` posts its findings. The agent passes the
PR number (or lets it default to the current branch's PR) and `--yes` to skip the confirmation
gate, the fixes land on the PR's branch, the marked reply posts once, and the structured summary
(step 7) is the agent's return value.

The honesty constraints bind agents harder, not softer. An agent responding to a review of its own
work has an obvious incentive to score inconvenient findings low. Score the finding, not the
author — a **Decline must name the reason the finding is wrong**, never merely that fixing it would
be work. "Effort/Risk 0, declining" is not a verdict; it is a confession.

**Being resumed across rounds.** An orchestrating loop (autopilot's Steps 5–6) may keep the
invoking agent alive and **resume** it — "new review(s) posted on head `<sha>` — triage them" —
instead of invoking this skill fresh each round. When resumed:

- **Re-read the PR state fresh from the new head.** The branch moved (you pushed it): never trust
  cached file contents or a cached head SHA when scoring the new findings.
- **Verdict continuity is the point.** You remember *why* you declined or deferred each earlier
  finding, so **do not flip a settled verdict without new evidence in the new head** — and equally,
  do not silently re-implement something you already declined. Keep the F-numbering **stable across
  rounds**: continue the sequence, never restart at F1.
- **Cold starts recover the history from the PR itself.** If you have no in-context history — you
  are a fresh spawn after a vanished agent, or a later gate's responder whose sibling loop already
  ran on this PR — but marked `<!-- waffle-pr-response -->` replies already exist, **read them all,
  oldest first, and seed your verdict history and F-numbering from them.** They are history, and
  they are the *only* record of it: nothing else on the PR says why F5 was declined two rounds ago.
  Append new findings after the highest F across all of them — **never renumber** — and never
  reverse a recorded verdict without new evidence in the new head. This is what keeps the continuity
  rules above satisfiable on every path, not only for an agent that lived through the earlier rounds.
  **Read them; do not touch them.**
- **The reply and the return are unchanged.** Step 6 posts a **new** comment for this round (never
  editing an earlier one), and the per-verdict + implemented counts (step 7) are your reply
  each round — the implemented count is the loop's convergence signal, so report it honestly: 0
  means nothing was left to fix, not that you are tired of the round.
