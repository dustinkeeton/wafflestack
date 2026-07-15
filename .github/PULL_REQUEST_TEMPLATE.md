<!--
  This template mirrors the PR body the `git-workflow` skill writes, so a hand-opened PR and an
  agent-opened one read the same. Agents pass `--body-file`, which bypasses this template entirely —
  they render the same sections from the skill instead.

  Delete any section that genuinely does not apply. Do not delete the Test plan.
-->

## Summary

<!-- What changed and why, in bullets. Lead with the behavior change, not the file list. -->

-

## Linked issue

<!--
  One closing keyword PER issue: `Closes #1, #2` closes only #1. Write `Closes #1, closes #2`.
  After the merge, verify the issues actually closed.
-->

Closes #

## Test plan

<!-- The git-workflow pre-flight. Check what you ran; note anything you could not run, and why. -->

- [ ] Lint passes (`npm run validate`)
- [ ] Types pass (`npm run typecheck`)
- [ ] Tests pass (`npm test`)
- [ ] Build passes (`npm run build`)
- [ ] Reviewed the full diff against the base branch (`git diff main...HEAD`)

## Review notes

<!--
  Optional: what you want a reviewer to look at hardest, and anything you already know is a
  trade-off. Review rounds on this PR follow the canonical finding → verdict form — see
  .github/REVIEW_TEMPLATE.md.
-->
