---
name: adversarial-review
description: Adversarially review a green PR from a hostile reviewer's seat — read the full diff and poke holes in correctness edge cases, API/naming choices, missing tests, error handling, and simplification opportunities, posting findings as actionable PR review comments. Severity stays honest — no manufactured blockers; "no holes found" is a valid outcome for a genuinely solid PR. Invokable by users and agents.
user-invocable: true
argument-hint: "<PR#, number, or PR URL> (omit for the current branch's PR)"
---

# Adversarial Review

When this skill is invoked, you review a **finished, CI-green pull request** from the seat of
a **deliberately hostile reviewer**. Green checks prove the code *runs*; they do not prove it
is the *best version of itself*. Your job is the pressure step between "checks passed" and
"merge": read the full diff and find concrete reasons this PR is **not good enough yet**.

Your stance is adversarial, but your severity must stay **honest**. You are not here to
manufacture blockers or invent nits to look thorough — a genuinely solid PR earns a clean
bill of health. "No holes found" is a valid, and sometimes correct, outcome. The value is in
finding the *real* holes, not in the count.

This is distinct from the built-in `/code-review`, which reviews the author's uncommitted
working diff **before** commit. This skill reviews a **committed, green PR** from a reviewer's
seat and posts its findings back onto the PR as review comments addressed to the author
(human or agent).

## 1. Resolve the target PR

Inspect `$ARGUMENTS`:

| `$ARGUMENTS` | What to do |
|--------------|------------|
| `#N`, a bare number, or a PR URL | Review that PR. Reduce it to the PR number `N`. |
| empty / omitted | Review the **current branch's** open PR: `gh pr view --json number,url` (fails if the branch has no PR — report that and stop). |

Resolve the repo coordinates and the head commit up front — you need them to post inline
comments and to confirm the PR is really green:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
gh pr view "$N" --json number,title,state,isDraft,headRefName,headRefOid,mergeable,statusCheckRollup,url,author
```

- If the PR is **closed or merged**, there is nothing to gate — report and stop.
- If it is a **draft** or its **required checks are not yet green**, say so: this skill is the
  *post-green* gate. You may still review on request, but note that checks haven't passed.

## 2. Read the full diff and its surroundings

```bash
gh pr diff "$N"                      # the complete unified diff
gh pr view "$N" --json files,body    # changed-file list + PR description / intent
```

Do not review the diff in isolation. For each non-trivial change, **read the surrounding
code** the diff touches (open the files, trace the callers and callees) so your findings are
grounded in how the change actually behaves — not just how the hunk looks. A hole you can't
tie to a concrete failure or a concrete call site is a guess; don't post guesses.

## 3. Poke holes — the adversarial lens

Work through every category below. For each, ask "what did the author *not* handle, and how
would I break it?" Be specific: name the input, the line, the call path.

- **Correctness & edge cases** — boundary values (empty, zero, one, max, negative), `null`/
  `undefined`/missing keys, off-by-one, concurrency and re-entrancy, ordering assumptions,
  unicode/encoding, time zones, integer overflow, and the unhappy path the tests skip. What
  input makes this code do the wrong thing?
- **Error handling & failure modes** — swallowed exceptions, unchecked return values, partial
  writes with no rollback, resource leaks (unclosed handles/connections), retries without
  backoff or idempotency, and failures that surface as a confusing message three layers away.
  What happens when the thing this code depends on fails?
- **Missing or shallow tests** — untested new branches, tests that assert the happy path only,
  no coverage for the edge cases above, over-mocked tests that would pass even if the code
  were broken, and assertions weak enough to be vacuous. Which added line has no test that
  would fail if you deleted it?
- **API, naming & design choices** — leaky or too-wide public surface, names that mislead
  about behavior, inconsistent parameter order or return-shape versus siblings, booleans that
  should be enums, mutable state that should be immutable, and abstractions introduced with a
  single caller (or duplicated instead of abstracted). Would a caller be surprised by how this
  behaves?
- **Simplification & missed reuse** — dead or unreachable code, a hand-rolled loop that a
  standard library call replaces, a special case the general case already covers, an existing
  helper in this repo that was re-implemented, and needless indirection. What could be deleted
  with no loss?

Keep it proportional. A three-line typo fix does not need a five-category audit; a new module
does. Match the depth of the review to the surface area of the change.

## 4. Rank findings by honest severity

Assign each finding a severity and let that drive whether it blocks:

- **blocker** — a correctness bug, data-loss path, security hole, or missing test for
  load-bearing new logic. The PR should not merge as-is. Reserve this for holes you can
  demonstrate; if you are not sure it's real, it is not a blocker.
- **should-fix** — a real weakness (thin test, awkward API, unhandled-but-unlikely failure)
  that is worth addressing but wouldn't by itself stop a merge.
- **nit** — style, naming, or a minor simplification. Label it as optional.

Do **not** pad the list. If the only honest finding is one nit, post one nit. If there are
none, say so (step 6).

## 5. Post findings as PR review comments

Frame each finding as an **actionable demand to the author**, not a vague observation: state
the hole, the concrete failure it causes, and what would resolve it. Prefer **inline comments
anchored to the offending line** so the author sees them in context, plus one **summary
review comment** that gives the verdict and lists the findings by severity.

Post everything as a **single review** so the author gets one coherent notification. Build a
JSON payload and submit it in one call — `line` must be a line that appears in the PR's diff,
`side: RIGHT` for added/context lines and `LEFT` for removed lines:

```bash
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --method POST --input - <<'EOF'
{
  "event": "COMMENT",
  "body": "**Adversarial review** — 1 blocker, 2 should-fix, 1 nit.\n\n- **[blocker]** `parseRange` returns the wrong bound for an empty input (see inline).\n- **[should-fix]** No test covers the `null` config path added in `load.ts`.\n- **[should-fix]** `flush()` swallows the write error instead of surfacing it.\n- **[nit]** `tmp2` could reuse the existing `withTempDir` helper.",
  "comments": [
    { "path": "src/range.ts", "line": 42, "side": "RIGHT",
      "body": "**[blocker]** With `input === \"\"` this returns `[0, -1]`, so every downstream slice is empty. Add an explicit empty-input guard and a test that pins the returned bound." },
    { "path": "src/load.ts", "line": 88, "side": "RIGHT",
      "body": "**[should-fix]** This new `null`-config branch has no test — deleting the branch wouldn't fail the suite. Add a case that exercises it." }
  ]
}
EOF
```

Notes on mechanics:

- Use **`event: "COMMENT"`** — an honest, non-approving review. Escalate to
  `event: "REQUEST_CHANGES"` **only** when you found a genuine **blocker**; never as a default
  posture. GitHub forbids `REQUEST_CHANGES`/`APPROVE` on your **own** PR, so if the review
  identity authored the PR (common for agent-authored PRs), fall back to `event: "COMMENT"`
  and let the severity labels in the body carry the weight.
- A `line` that isn't part of the diff is rejected by the API. If a finding is about code the
  diff only *touches indirectly*, describe it in the **summary body** with a `file:line`
  reference instead of forcing an inline anchor.
- For a large batch, `--input` with a heredoc (above) avoids the shell-escaping traps of
  many `-f`/`-F` flags. Write the JSON to a file first if it's easier to assemble.

## 6. "No holes found" is a valid outcome

If the PR genuinely holds up — edge cases handled, tests real and sufficient, API clean, no
obvious simplification — **say so plainly** and do not invent findings to justify the run.
Post a short approving-in-spirit summary (still `event: "COMMENT"` unless you're authorized to
approve and aren't the author):

```bash
gh pr review "$N" --comment --body "Adversarial review: no holes found. Checked correctness edge cases, error handling, test depth, API/naming, and simplification against the full diff — nothing blocks or should-fix. Solid PR."
```

## 7. Report back

Return a concise summary to the caller: the PR URL, the count of findings by severity
(blocker / should-fix / nit, or "none"), the review event used (`COMMENT` /
`REQUEST_CHANGES`), and one line on the most important finding if there is one.

## When called by agents

An agent may invoke this skill (via its frontmatter `skills:` grant) to gate a PR before it
merges — for example after a delegate run opens a PR, or as the qualitative step an
auto-merge flow lacks. The same workflow applies: the agent passes the PR number (or lets it
default to the current branch's PR), the review posts to the PR, and the structured summary
(step 7) is the agent's return value. Honesty still governs severity — an agent must not
manufacture blockers to look diligent, and "no holes found" is a legitimate result to hand
back.

> **Auto-invocation on PR-green (opt-in).** The `github-workflow` stack ships a companion
> opt-in workflow, `waffle-pr-green-hook.yml`, that dispatches the CI harness to run this skill
> automatically the moment a PR's required checks go green — firing once per green transition
> (per head commit), not on every check re-run, with a duplicate-review guard keyed on this
> skill's review marker. It is **opt-in syrup** (it spends API money on every green PR), so it
> renders only when installed, and it needs this skill rendered alongside it
> (`.claude/skills/adversarial-review/SKILL.md`) — see that stack's setup note for the opt-ins.
> This skill remains independently useful invoked manually (`/adversarial-review <PR#>`) or by an
> agent, with or without the trigger.
