# Changelog

All notable changes to WaffleStack are recorded here. This file is also the source that
`wafflestack upgrade` reads to show a consumer what changed between the toolkit version
their repo last rendered from and the version they are upgrading to.

The format follows [Keep a Changelog](https://keepachangelog.com/); versions map to git
tags (`vX.Y.Z`). Each release carries a **Consumer impact** line so you know at a glance
whether an upgrade is a plain re-render or needs a migration.

## What a version bump means for a consumer

WaffleStack versions are semver, read from the perspective of a *consuming* repo:

- **patch** (`0.5.0 → 0.5.1`) — content-only fixes. `render` regenerates; nothing else to do.
- **minor** (`0.5.0 → 0.6.0`) — new stacks/items or additive config. `render` picks them
  up; existing config and extensions are untouched.
- **major / breaking** — a renamed or removed stack/item, a new *required* config key, or
  a changed file layout. These ship a **migration** and are called out under Consumer impact.

**Canonical upgrade command** — run the toolkit at the tag you want and let it walk you across:

```bash
npx github:dustinkeeton/wafflestack#<newtag> upgrade
```

`upgrade` compares your lock's `toolkitVersion` to the invoked toolkit, prints the entries
below that fall in between, runs any registered migrations in order, then re-renders and
runs `doctor`. A plain re-render (`… render`) still works for patch/minor moves; `upgrade`
is what you reach for across a breaking one.

## [Unreleased]

### Changed
- **Detox comment-prose test pins; shrink the pr-green / pr-response hook headers (#391).** Removes
  the Layer-1 tests that pinned comment sentences inside deterministic workflow YAML (the
  `states the identity-neutrality design` loop in `content.test.mjs`) and collapses the two
  ~62–63%-comment hook headers to ≤12 orientation lines that point at DECISIONS #338/#160 + the
  github-workflow setup note. The one genuinely-unrecorded fact (the pr-response hook is currently
  inert because `workflow_run` doesn't carry the PR head across the second hop) moves into the setup
  note; the behavior pins (comment-stripped identity, `{{git.*}}` leak, token-spend telemetry) are
  untouched. Adds a Layer-2 eval asserting the adversarial reviewer demands a comment shrink, not
  code conformance, when a docblock contradicts the code. Phase 3 of the #388 "comments are not
  spec" remediation. **Consumer impact:** none — no rendered output changes.
- **pr-response rubric v3: valid + cheap alone no longer clears the Implement bar (#385).**
  Implement moves ≥10 → **≥11** (Defer becomes 5–10; Decline ≤4, dimensions, and anchors are
  untouched). Evidence: `Validity 3 · Effort/Risk 3 · Alignment 3` composes to 9 on its own, so
  almost any valid, cheap nit auto-implemented — PR #382 implemented 15 of 16 findings across six
  rounds, #384 13 of 14 across five. v3 also lands #388's scoring rule where it bites: comment
  text in a deterministic file is Reach ≤ 1 and Severity ≤ 1, and the Implement-worthy fix for a
  wrong comment is a deletion or a one-line correction, never an expansion. **Consumer impact:**
  re-render picks it up; expect marginal findings to Defer with a filed follow-up instead of
  auto-implementing. Old replies stay scored against the rubric version named in their footer.
- **Comments are not spec (#388).** Deterministic files (JS, YAML, shell) carry rules in code and
  behavior tests; comments there are short, rare, human orientation, and a comment-vs-code
  disagreement is resolved by shrinking the comment — never by making the code match the comment.
  `adversarial-review` and `qa` now scope comment findings accordingly, and `git-workflow` carries
  the standing touch-it-shrink-it commit rule. Two deliberate exceptions stay fully reviewable:
  skill/agent markdown (the program agents execute) and user-visible output strings / generated
  docs (behavior). **Consumer impact:** re-render picks up the skill changes; no migration.
- **The orchestration skills call the tools the harness actually has (#360).** `audit`, `delegate`,
  `autopilot`, `clean-up`, `git-workflow` and the `project-manager` agent had drifted onto primitives
  that no longer exist, so an agent following them literally called a tool that was not in its tool
  list. Removed `TeamCreate`/`TeamDelete`/`TeamList` and the deprecated `Agent` `team_name` parameter
  (a session now has one implicit team; express lifecycle with **named** agents instead); corrected
  `TaskCreate` (takes `subject` + `description`; `addBlockedBy` is a **`TaskUpdate`** parameter, keyed
  `taskId`), `TaskStop` (keyed `task_id`), `TaskList` (takes no arguments) and `SendMessage` (the param
  is `message`, not `content`). Teardown is now **shutdown-then-stop** everywhere — `shutdown_request`
  is the polite first step, but only `TaskStop` reliably terminates an agent. `delegate` keeps
  provisioning its own worktrees rather than adopting `isolation: "worktree"`, and its justification is
  now the **three reasons that survive an empirical probe of the live harness** (path, branch and base
  are all the harness's to choose, not delegate's) — the two that did not survive are gone.
  **Consumer impact:** re-render picks it up; no migration. If you have *extended* any of these skills,
  re-check your additions for the same dead primitives — a regression sweep now guards every skill and
  agent **source** under `stacks/**` (plus the skills' JSON assets), not just the subset a given repo
  renders. The sweep reads each call's **real argument list**, so a paren inside a string argument no
  longer hides a dead primitive from it, and it asserts teardown as the **calls** an orchestrator
  executes rather than the words appearing somewhere in the file — both holes were found by reintroducing
  the bugs and watching the old guard pass green, and both are now pinned by regression fixtures.
- **CI hooks key delivery and idempotency on out-of-band signals, never on a marker pasted in prose
  (#338, closes #333).** Both review hooks decided "the bot did a thing" by string-matching a marker
  literal inside a **free-text body anyone can write**. #211, #332 and #333 are not three bugs but
  three faces of that one mechanism: a human comment on PR #207 read as "the bot already replied", and
  a QA review on PR #296 read as "this head is already reviewed" **and** "this IS the bot's review" —
  so the security review silently never ran while a paid, *committing* job dispatched on the QA review.
  Each previous fix only *narrowed* the match (bare word → full literal → marker-**led**), and a
  marker-led body is still prose: a human can type a marker on line 1 as easily as at offset 1103.
  The mechanism is now gone rather than narrowed. Every predicate keys on an artifact that takes
  **repo push access** to write, and **no hook reads a body**:
  - **pr-green** — its dedup gate and its delivery check both key on a `waffle/adversarial-review`
    **commit status** on the reviewed head SHA, which the harness writes once its review lands.
  - **pr-response** — its **trigger** moves from `pull_request_review` to `workflow_run` on
    `waffle-pr-green-hook`, so a review body cannot raise the event *at all*; its delivery check keys
    on a `waffle/pr-response` commit status; and its **loop bound** becomes a per-PR **label the
    workflow applies before the paid dispatch**.
  - **A commit status, not the check run the issue proposed.** Creating a check run is
    GitHub-App-only ("OAuth apps and authenticated users are not able to create a check suite") and
    the harness may authenticate with a PAT (`WAFFLE_HYGIENE_TOKEN`) — so a check run would be
    uncreatable in the *recommended* configuration. A status needs only push access and is otherwise
    identical: keyed to the SHA, structured, visible in the checks list, unforgeable without repo
    write. Always written `state=success`, so it never reddens the rollup.
  - **The loop bound got tighter, not looser.** It is a *label* rather than a status because a rebase
    or force-push would orphan a status and silently **re-arm** the paid loop. And the *workflow*
    claims it **before the money** — so a harness that crashes, times out, or is denied its tools is
    still bounded, where the old marked-comment bound simply went unset and the next review
    re-dispatched.
  - The markers **stay** in review/reply bodies — they are how a human recognizes a bot post and how
    the skills recognize their own — and the **do-not-paste rule stands**: no *workflow* reads them,
    but the *skills and `autopilot` still do*. The prose-to-prose coupling (a workflow's
    `jq startswith()` depending on a SKILL.md sentence to a model) is gone: both ends of the contract
    are now code in the workflow, and pinned by tests that feed the real #296 and #207 bodies through
    every predicate.
- **The same discipline now covers the local skill path, which is where it actually bites (#338).**
  CI was only half the system. `autopilot` decided *"have these findings been triaged?"* — and then
  **armed auto-merge** — by substring-matching a marker in a comment body, and `qa` proved its own
  review had posted the same way. So a comment that merely *quoted* a marker read as "already
  triaged", the responder was never spawned, and a PR could merge with findings nobody answered.
  That is a strictly worse failure than the CI one it mirrors, because it ships code.
  - `qa`, `adversarial-review` and `pr-response` each now write a **commit status**
    (`waffle/qa`, `waffle/adversarial-review`, `waffle/pr-response`) on the head SHA they acted on,
    **after** their post lands — on *every* path, local runs included, not just when CI's dispatch
    prompt asks for one.
  - `autopilot`'s triage gate and both convergence gates key on the `waffle/pr-response` status on
    the **review's own head SHA**, never on a comment body. Fail-closed: no status ⇒ untriaged ⇒
    spawn the responder.
  - Verdict **history** (what was decided, at what F-number) still reads the marked replies — that
    read is best-effort by design: getting it wrong costs a redundant round, while getting the
    *triage gate* wrong merges untriaged code. The failure directions differ, so the disciplines do.
- **The cutoff is persisted and recovered, never recomputed (#354, QA round 5).** The round-4 fix
  told a responder that had lost the cutoff to *"re-run the command above"*. Re-running it at the
  status-write step recomputes **"the newest review as of now"** — which includes any review that
  landed *while the responder was working*: never read, never scored, not in the verdict table.
  Stamping that certifies a finding nobody disposed of, and auto-merge is armed over it. **The format
  guard is powerless here by construction:** a recomputed timestamp is a perfectly well-formed
  ISO-8601 value and sails through the regex — it validates a *shape*, and this cutoff is well-formed
  and simply **untrue**. A model following the instruction *correctly* produced the bug, which makes
  it a spec defect rather than a model failure. **The cutoff is a fact about *when you read*, so it
  cannot be recovered by reading again**: `pr-response` now persists it to a per-PR scratch file with
  the `Write` tool and recovers it with `Read` (a pair that crosses the same `Bash`-call boundary
  that kills a shell variable), and the only sanctioned fallback is the newest `submitted_at` **among
  the reviews in its own verdict table** — never "whatever is newest now".
- **The triage gate validates the cutoff's format, and the cutoff is written as a literal (#354, QA
  round 4).** Two bugs in the round-3 plumbing, failing in **opposite** directions:
  - **The writer could never deliver the cutoff (fail-closed).** The skill captured `CUTOFF=$(…)`
    when it read the findings and spent `$CUTOFF` when it wrote the status — but those are **two
    different shells**. The agent harness persists the working directory between `Bash` calls and
    **not** shell state, and the status is written many tool calls later (after scoring, fixing, the
    pre-flight, the push and the reply). So every status was stamped `triaged-through=` with nothing
    after it, and the gate read *every* review as untriaged: the cutoff mechanism was **silently
    inert**, and an always-untriaged gate is indistinguishable from a working one. The cutoff is now
    a **literal** the responder substitutes from what it read (a compound `CUTOFF=$(…); gh api …` is
    not the escape hatch — CI's allowlist matches on the leading program and rejects compounds, so
    the literal is the only form that works on both paths). The same slip is called out in `qa` and
    `adversarial-review`, which hand `$REVIEW_ID` and the head SHA across the same boundary.
  - **The reader trusted the writer's format (fail-OPEN).** The gate checked only
    `startswith("triaged-through=")` and compared whatever followed as a **raw string** — but ISO
    dates begin with a digit, so any token sorting above ASCII digits (`now`, `null`, `unknown`)
    certified **every review on that head**, including one submitted in 2099. The skill promised
    *"no parseable cutoff ⇒ untriaged ⇒ fail closed"* and did not keep it. The gate now validates
    `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$` before comparing. **The reader must
    not trust the writer's format**: the status is unforgeable, but the string inside it is prose a
    model was told to emit — which is the one place this design was still trusting prose.
  - **The gate is now tested by being EXECUTED, not by being grepped.** The jq predicate is extracted
    from `autopilot/SKILL.md` and run against real status payloads (valid, empty, malformed, stale,
    wrong-context, wrong-state, null). No text assertion can tell a working gate from an inert one —
    which is precisely how both bugs above shipped past a green suite.
- **The triage gate certifies the responder's READ CUTOFF, not its finish time (#354, QA round 3).**
  Comparing the status's own `created_at` against a review's `submitted_at` closes the *early*-write
  hole but leaves the other end open, and that end is inherent to writing the status last.
  `pr-response` reads the findings at the **start** of a run and stamps the status at the **end** —
  score, fix, pre-flight, push, reply, some **15–20 minutes**. A review landing *inside* that window
  is never seen by the responder, yet its status is stamped later than that review, so a clock-based
  gate calls it **triaged by a run that never read it** — and autopilot arms auto-merge over it. The
  window is not exotic: the gate exists precisely to catch *another gate's* review and *a human's*,
  and a hook-armed `pr-green` posts adversarial reviews asynchronously on green — a designed-for
  concurrent producer landing straight into it. **A clock reading taken after a finding cannot certify
  that finding.** `pr-response` now captures `$CUTOFF` (the newest `submitted_at` it saw *when it
  read*) and stamps it into the status as `description=triaged-through=<ISO-8601>`; the gate triages a
  review **iff** a status on its `commit_id` carries a cutoff **at or after** its `submitted_at`. A
  review that lands mid-run reads as untriaged, earns its own round, and that round writes a new
  status whose later cutoff covers it — self-healing, and no new signal: a status description takes
  push access to write, exactly like the status. Fail-closed on a missing or unparseable cutoff.
  (Re-reading the reviews just before stamping was the other candidate; it only *narrows* the window
  to the gap between re-read and write rather than closing it.)
- **The triage gate compares timestamps, not mere existence — an existence test merged over live
  findings (#354, QA round 2).** The first cut keyed triage on *"is there a `waffle/pr-response`
  status on this review's head SHA?"*. But a status certifies a **SHA**, while findings belong to a
  **review**, and the two diverge on the most ordinary outcome there is — **the last responder
  deferred everything**: it implements 0, pushes nothing, the head does not move, and the status it
  leaves behind silently **pre-triages the next review to land on that head**. Step 5 converges,
  Step 6's `adversarial-review` posts real holes onto the same head, the gate reads them as already
  triaged, the responder never spawns, and autopilot **arms auto-merge over undisposed findings** —
  the exact failure the status was introduced to prevent, reintroduced by its own fix. A review is
  now triaged **iff** a `waffle/pr-response` success status on its `commit_id` was created **after**
  its `submitted_at`. Both are plain API fields, neither is a body, and forging either still takes
  push access — so nothing about #338's thesis is given up.
- **A delivery check may never read back its own status (#354, QA round 2).** `qa` and
  `adversarial-review` wrote their status and then "verified delivery" by reading *that same status*
  back — **self-attesting**: it proves a status was written (trivially true, one line later) and
  never observes the review at all, so an errored review POST still reported *clean and delivered*
  with nothing on the PR. The only thing binding the status to the review was a sentence in a
  SKILL.md telling a model to write it afterwards — **the prose-to-prose coupling #338 abolished in
  CI, reintroduced one layer down.** Each skill now reads back the **artifact itself** (the review,
  by the id its POST returned; for `pr-response`, the comment). The status remains the *consumers'*
  signal for triage and dedup — it is simply no longer evidence for the writer.
- **`pr-response` rubric bumped to v2 — a fifth dimension, `Reach` (#354).** A rubric change
  reinterprets every future verdict, so it is recorded here with its motivating evidence, per the
  skill's own recalibration rule.
  - **The gap.** v1's `Severity` anchor asked *"what does it cost to leave this unaddressed?"*, which
    silently mixed **impact if hit** with **whether it can be hit at all**. So v1 had no way to say
    *"this bug is real and serious, and it cannot execute."*
  - **How it surfaced.** On this PR, a confirmed defect left a CI hook unable to fire on any PR. By
    the Severity-3 anchor it was a blocker, and v1's blocker-override (`Severity 3 + Validity 3`)
    would have **forced** an immediate fix — but the hook is opt-in, inert, and in a deprioritized
    subsystem, so deferring was correct. The only way v1 could express that was to score Severity
    **2**: talking the bug down to move the verdict. That is laundering a judgment, and it leaves a
    false number in the very dataset the next recalibration reads.
  - **The fix.** `Severity` now means *how bad if hit* (a blocker stays 3 even in dead code) and
    **`Reach`** means *can it be hit, and by what* (0 = dormant · 3 = gates merges, ships code,
    spends money, touches secrets). Composite is 0–15; thresholds rescale proportionally
    (**≥10** Implement · **5–9** Defer · **≤4** Decline). The blocker-override gains a `Reach ≥ 2`
    clause, and a new floor says a **real defect in dead code is a Defer with an issue, never a
    Decline** — dormancy schedules the fix rather than forgetting the bug.
  - **Old replies stay scored against the rubric that produced them.** Every reply names its version;
    a v1 reply's four numbers are not comparable to a v2 reply's five.
- **Known defect, recorded rather than advertised away:** `waffle-pr-response-hook` does **not**
  currently dispatch on any PR. At the second `workflow_run` hop, `head_sha` is the default branch's
  tip rather than the PR head, so the gate resolves no PR and always skips. The signal design above
  is correct but, in the hook, **unexercised**. Tracked as a follow-up; the hook header carries the
  measurement and the fix sketch.
  - **Consumer impact:** re-render. New config key `prResponse.responseLabel` (default
    `waffle:pr-response`, additive — no migration). **If you installed the pr-response hook, create
    that label** (`gh label create 'waffle:pr-response'`): the loop bound is fail-closed, so without
    it the job reds rather than dispatching an unbounded run (`doctor` reports it as an unmet
    prerequisite). Its job now also takes `statuses: write` (still **no** `issues: write`), and
    pr-green takes `statuses: write`.

### Added
- **The lock records WHICH toolkit produced the render, not just its version number (#374, epic #377).**
  `.waffle/waffle.lock.json` gains a top-level `toolkit` block — `{ source, sourceType, ref, commit,
  status }` — keyed exactly like an external stack's `sources[]` entry, because a version string does
  not identify content: `main` and the tag 74 commits behind it both carry `"version": "0.12.0"`, so
  two renders six files apart used to produce identical provenance. `doctor` now reports which toolkit
  produced a render and flags a mismatch — **including the case the bare version string structurally
  cannot express: same version, different commit** (a re-cut or force-pushed tag). `upgrade` reports
  the toolkit's actual commit move, exactly as it already does for external sources — which is what
  finally lets it say something when the version did *not* change but the toolkit did.

  **`commit` is recorded if and only if `status` is `release`.** No field in the block is a function
  of a moving `HEAD`: recording one in a repo that commits its own lock would be self-referential
  (naming the commit *before* the one containing it), false whenever the working tree is dirty, and
  would churn the lock on **every commit** — reddening the documented `render` + `git diff --exit-code
  .waffle/waffle.lock.json` recipe forever, for a change that moved no rendered byte. A non-release
  render writes `{ ref: null, commit: null, status }`, and that block is byte-stable. An `unverified`
  render (a network blip, `--allow-unreleased`, a pnpm/yarn `dlx` install) **carries the previous block
  forward** when the version and the whole `files` map are unchanged, so a hiccup cannot rewrite a good
  `release` block to nulls.

  **`source` names a repo only when one was corroborated — otherwise it is `null`.** `source` + `ref`
  are a **pin** (the read-back is `` `${source}#${ref}` ``), so naming a repo asserts that repo holds
  that tag at that commit. An `npx` install has that in hand — npm's `resolved` URL is the spec the
  operator typed, and `ls-remote` found the tag on that commit in that remote — so a **fork pinned to
  its own release names itself**, on every machine. A **checkout** has not: `git describe` reads the
  clone's *local* tag refs and asks no remote, and `package.json` `repository` is a field a fork
  inherits verbatim — so a fork clean on its own `v1.0.0` would have pinned
  `github:dustinkeeton/wafflestack#v1.0.0`, a tag upstream never cut. A release rendered from a
  checkout therefore records `"source": null` and pins nothing, keeping its real, checkable local facts
  (`ref`, `commit`, `status`). Doctor still compares the **commits**, so a re-cut tag is still reported
  as a re-cut tag. `remote.origin.url` is **never** recorded under any status: it is a property of the
  clone, not of the toolkit, and two contributors on one commit must not write different locks.

  **Consumer impact — none, and deliberately so.** No lock-format version bump and no migration: the
  key is additive and every reader is key-by-key, exactly as when the `sources` block was added. Your
  lock gains the block on its next `render` (a one-time diff, like a `toolkitVersion` bump); a lock
  without it loads and doctors clean. **`doctor`'s new provenance check is a NOTE, never an error** —
  `doctor.toolkitRef` ships unpinned by default, so failing the gate on a mismatch would red every
  consumer's required check the moment anything merges to this repo's `main`; and `--verify-render`
  already gates on *content*, so an error could only ever fire when the rendered bytes are provably
  identical. `doctor --verify-render`'s comparison stays `files`-only. Read `ref: null` as *"no
  provenance was captured"*, never as *"this was not a release"* (see #383).

- **A `files:` entry can scope itself to harness targets (#364).** Syrup used to render **once,
  unconditionally** — right for a `.github/` payload (a GitHub Action has nothing to do with which
  harness you run), wrong for a harness-specific one: a `.claude/workflows/*.js` would land in a
  codex-only repo as dead weight. A `files:` entry may now declare an optional **`targets:`** scope
  via the map form (`- path: .claude/workflows/audit.js` + `targets: [claude]`), and renders only when
  the consumer has enabled at least one of the listed targets. Disable the last of a poured file's
  targets and the next `render` **prunes** it — the same frozen-image contract as dropping a stack,
  rather than leaving it orphaned. **Every** malformation of `targets:` is a hard **load** error —
  four of them: an unknown key on the map form (a `target:` singular typo would otherwise leave the
  payload silently unscoped), a non-list `targets:`, an **empty `targets: []`**, and an **unknown
  target name**. The reason is one reason, applied consistently: because the prune deletes files, a
  `targets:` the render cannot honour **deletes an already-poured copy out of a consumer's repo**,
  silently and with `ok: true`. `targets: []` is scoped to nothing and can never render — and
  `targets: [claud]` resolves to nothing too, so it *is* `targets: []` spelled differently, one
  keystroke away. Even a **partially**-valid `targets: [claude, codxe]` deletes the poured file out
  of a **codex** consumer's tree: a surviving valid name does not make the entry safe, it only
  narrows *which* consumers it destroys. So there is no inert typo, and the loader checks every name.
  A `validate`-only check would have been no gate at all here, since `validate` is toolkit-developer
  lint that consumers never run over built-in stacks (`render` imports only `validateExternalStacks`)
  and the toolkit is explicitly forkable. The consumer's own config has always hard-errored on an
  unknown target name; the manifest is the side that can *destroy* a file, so it is not the side that
  gets to be lenient. Scoping decides
  **whether** a file renders, never how many times — a file has no per-harness variant, so unlike an
  agent or a skill it **filters** rather than fanning out. This is the one additive manifest field the
  "no schema change" framing of the #184 spike (below) had to retire, and the hard prerequisite for #363.
  Because the prune deletes files, the gate is **loud everywhere silence would hide something**. The
  **discovery surfaces agree with the scope instead of contradicting it**: `setup`'s playbook and
  `list` both report a scoped-out file as **not installable here**, naming the targets that would
  enable it, and `list --interactive` never offers it as a checkbox — toggling one on would persist an
  `include:` that renders nothing and re-warns on every future render. `list` goes further on the one
  case that is *not* hypothetical: a file already poured under an older `targets:` is on disk and in
  the lock right now, so it is reported as **PENDING REMOVAL — the next `render` DELETES it**, not as
  "not installable". `list` is what a user runs after editing `targets:` and before re-rendering, and
  it must not describe an installed file as absent. That status is held to its own bar: it asks
  `render`'s *own* prune question (is this live lock path produced by no selected item?) rather than
  merely checking the file is on disk, because the lock is matched by **path** and is stack-blind —
  two stacks may legally declare the same output path, and a bare check would announce a deletion for
  a file an enabled stack still produces. A status that exists to prevent a false claim about a
  deletion must not make one. An explicit `include:` of a scoped-out file still
  **warns** rather than silently no-op'ing; a `requires:` edge landing on a scoped-out file **warns**
  too (the dependent would otherwise render declaring a dependency on a payload that will never exist
  there, and the renderer only walks that edge forward, so nothing else would notice) — and when that
  dependency is **opt-in** syrup the warning names *both* steps, because enabling a target is necessary
  but not sufficient there: the opt-in gate still holds the file back, so enabling only the target
  renders nothing *and* clears the condition that produced the warning, leaving the consumer with no
  file, no complaint, and every reason to think it worked; and a scoped-out
  **opt-in** file still states its #74 both/one/neither pairing — minus the pour command, which would
  render nothing — rather than falling silent, which would be #74 all over again.
  Two invariants hold throughout: an **unscoped** file can never be pruned, and an **ejected** file is
  never pruned (it is project-owned, and `eject` drops it from both locks).
  **Consumer impact: none — purely additive.** Omitting `targets:` is byte-for-byte today's
  behaviour, no shipped stack declares one, and no re-render is required beyond the usual.
- **A taxonomy that settles the word "workflow" — and the spike write-up behind it (#184, epic #347).**
  The toolkit used "workflow" for three unrelated things: a **GitHub Actions workflow**, Claude Code's
  **`Workflow` primitive**, and **any generic multi-phase process**. Two of those senses belong to somebody
  else — GitHub mandates its path, Anthropic owns its product vocabulary — so the generic one is the only
  lever there is, and it yields. **Bare "workflow" is now reserved for the Claude primitive**; GitHub's
  sense is always qualified (as payloads they are already **syrup**); the generic sense is **banned** in
  favour of the *phases*/*steps* of a skill. It gets **no replacement noun** — coining one would preserve
  the ambiguity the decision exists to kill — and decomposes instead into *skills* and *orchestrator
  skills* (all five of which turn out to live in the `orchestration` stack, so any future migration is
  contained to one stack). New rule: **a skill is the unit of work; orchestration is only sequencing — a
  skill invokes another skill, never duplicates one.** `github-workflow` and `git-workflow` **keep their
  names** (the #59 precedent: rename vocabulary, never load-bearing surfaces). New
  **`docs/skills-vs-workflows.md`** carries the analysis: all 37 skills classified, the `/audit` ⊃ `/docs`
  collision — with evidence the two copies have **already drifted** — why prose orchestration rots
  (nothing type-checks a `SKILL.md` against the harness's real tool list, so it fails at *runtime*; cf.
  #360), the per-target degradation table (**no portable workflow primitive exists** — Codex and
  agents-dir have none), and a **gated "not yet"** on adopting the primitive. That gate is **three items,
  not five**: **#360 must land** (`/audit` is unrunnable as written today), **#364 must land** (optional
  target scoping for syrup — a *hard* prerequisite, and an **additive, backward-compatible schema change**,
  so adoption is *"no fourth item kind"* but **not** *"no schema change"*), and **`/audit`'s human
  sign-off gate must be redesigned** — a workflow admits *"no mid-run user input,"* so a gate degrades to
  a hard abort and **sign-off with a human override is inexpressible**. The other three did not survive:
  one was **false** (the in-script API *is* specified — the `Workflow` tool entry documents `agent()`,
  `pipeline()`, `parallel()`, `phase()`, `log()`, `workflow()`, `args`, `budget` under `Script body
  hooks:`; an earlier draft had this right and a later one wrongly retracted it), one the write-up
  **resolves itself** (opt-in syrup is path-specific, so #94 does not bite), and one — paid-plans-only,
  version-gated, org-wide kill switch — **never clears** and is therefore a *permanent design constraint*,
  not a gate: it is why the prose orchestrator stays the portable fallback forever. When it *is* adopted it
  ships as **opt-in syrup**, not a fourth item kind. **Consumer impact: none** — docs-only; no `stacks/**`
  change, no re-render, no lock churn.
- **The CLI surface is complete: `help`, `uninstall`/`reinstall`, and a `bake` alias (epic #346, closes
  #187, #182, #176).** Three open issues, one `switch (command)` — so they were one change to one file,
  not three features, and the dispatch was edited once, coherently.
- **`help`, plus `--help` / `-h` (#187).** Asking for help was an *error*: every one of those tokens fell
  through to `default:`, which printed the usage banner via `fail()` and exited **1**. Now they print the
  banner, the usage line and a one-line description of every command and flag to **stdout**, and exit
  **0** — so `wafflestack help | less` works, and a script can tell "I asked" from "I fumbled". An unknown
  command still prints usage to **stderr** and exits non-zero, unchanged; so does bare `wafflestack` with
  no command at all, deliberately — that is a bad invocation and a script needs to see it fail.
  `--help` *after* a command explains that command instead of running it, checked before dispatch, so
  `wafflestack uninstall --help` cannot delete anything.
- **`bake` — a pure alias for `render` (#176).** A fall-through case sharing render's body, flags and
  no-refs guard (which now names whichever word you actually typed). The metaphor, all the way down.
- **`uninstall` / `reinstall` (#182).** wafflestack rendered files into `.claude/`, `.github/`, `.waffle/`
  and any syrup path, and shipped no way to take them back out: you hand-deleted across several
  directories, guessing which files were yours and which were ours. Now the lock does the guessing,
  because it already knew — **a rendered path is deleted only if `.waffle/waffle.lock.json` tracks it
  *and* its sha256 still equals what wafflestack rendered.** No globbing, no "looks generated"
  heuristic. A **hand-edited** file is kept and reported (`--force` deletes it too), an **unreadable**
  one is kept the same way (an unverifiable hash cannot prove the file is ours, and the read-only
  preview classifies it rather than crashing), an **absent** one is a no-op, an **ejected** one is
  project-owned and announced as left in place, and a lock key pointing outside the repo aborts the
  entire run. It then clears the `.waffle/` metadata — the one thing outside the lock's authority,
  since `extensions/` holds render *inputs you wrote*, so **`--keep-config`** takes the rendered output
  and spares your selection: `waffle.yaml`, your extensions **and the lock**, because the lock is the
  half of the selection that remembers which opt-in syrups you had poured, and a `render` from a
  config without it would quietly lay down a *different* install — prunes only the directories that genuinely emptied
  (a `.claude/` still holding your `settings.json` survives untouched), and strips wafflestack's own
  `.gitignore` lines by exact-line match — never a "marker to the next blank line" span, which would
  eat the lines you appended under it, and never rewriting the line endings of a CRLF file it does not
  own. **Anything left behind keeps the lock behind with it** — a skip, or a file it could not remove:
  the lock is the only record that those files were ever wafflestack's, so deleting it would strand
  them as exactly the orphans this command exists to prevent, and the `--force` re-run it advertises
  would die on `no lock`. Fix the cause, re-run, and the uninstall finishes. That is **one** decision,
  taken once, after the removals actually run — so the report can never tell you a file is "yours now,
  delete it by hand" while the lock that still tracks it sits on disk. What it prints afterwards is
  what it **actually** did, not what it planned to do. **It is a dry run until `--yes`**: the CLI is
  non-interactive by design, so the flag is the consent and the bare command is the preview of exactly
  what would go.
  `reinstall` refreshes in place — remove the rendered files, re-render the same selection — keeping your
  config, overlay, extensions **and lock**. Keeping the lock is load-bearing, not tidy: it is what keeps
  an already-poured opt-in syrup file selected, so dropping it would silently un-pour any syrup not also
  named in `include:`. It needs no `--yes`, because every file it removes the render writes straight back.
  `--clean --yes` is the reset: wipe everything including the config, then `init` a fresh scaffold.
- **Issue, PR, and review templates — a hand-filed issue now lands in the shape the automation
  already assumes (#337).** The `issue` skill drafts every issue into Problem / Proposed Solution /
  Sub-issues / Context, and `Needs Inference` is the entry point to the enrichment path — but
  `.github/` carried no templates, so anything filed by hand started from a blank box and looked
  nothing like a skill-drafted issue. The `github-workflow` stack now ships six templates as `files/`
  syrup: `.github/ISSUE_TEMPLATE/{config,bug,feature,rough-idea}.yml`,
  `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/REVIEW_TEMPLATE.md`.
  - **Default render, not opt-in.** Every workflow in this stack is opt-in because it holds write
    permissions and spends API money. A template holds neither — it is inert markdown/YAML GitHub
    reads only when a human opens the new-issue/new-PR form — so the templates pour with the stack.
  - **The forms mirror the skill's template.** Bug and feature ask for Problem / Proposed Solution /
    Context (feature adds Sub-issues) and apply the new `issue.bugLabel` / `issue.featureLabel`. One
    honest seam: GitHub issue-forms render a field label as an `###` heading where the skill's
    canonical template uses `##`; section names match, heading level does not, and the enrich pass
    re-drafts the body into the canonical shape anyway.
  - **The rough-idea form is the enrichment on-ramp** — a one-liner is a complete submission, and the
    form auto-applies `issue.inferenceLabel` (default `Needs Inference`), so filing it *is* the
    request to enrich it (`/issue` with no argument batch-enriches every issue carrying the label).
    That label is safe to auto-apply precisely because it is a **queue marker, not a trigger**: no
    workflow dispatches on it and it spends nothing. A template must **never** auto-apply
    `labelHook.{enrich,implement,release}Label` — a form-applied label is attributed to the human
    filer and therefore passes the label-hook's bot-sender gate, which would hand any drive-by issue
    author a button that bills the repo for a harness run. A test pins that invariant.
  - **The PR template** mirrors the `git-workflow` PR body (Summary, `Closes #N` with the per-issue
    closing-keyword rule, Test plan) and renders its four pre-flight rows from `project.lintCmd` /
    `project.typecheckCmd` / `project.testCmd` / `project.buildCmd` — change a pre-flight command,
    re-render, and the checklist follows. Agents pass `--body-file` and bypass it, as before.
  - **Review templates stay skill-rendered.** GitHub has no native review template, so a `.github/`
    file can only be a reference doc. The canonical finding shape (`adversarial-review`'s severity
    ladder) and verdict shape (`pr-response`'s four-dimension rubric and thresholds) are already
    load-bearing — the pr-green/pr-response hooks key their dedup and delivery guards on the markers
    those skills emit — so duplicating the rubric into `.github/` would create a copy that drifts out
    from under the guards. `REVIEW_TEMPLATE.md` is therefore a thin human-facing companion: the round
    skeleton (finding block, verdict table, append-only rule) plus the stable vocabulary, pointing at
    the skills for the scoring anchors. It also names — but deliberately never spells out — the
    automation markers, because a hand-pasted review marker convinces the pr-green hook the commit is
    already reviewed and can dispatch a paid response run.
  - **New config keys:** `issue.bugLabel` (`bug`), `issue.featureLabel` (`enhancement`),
    `issue.blankIssuesEnabled` (`true` — the forms are the paved path, not a wall), and
    `issue.contactLinks` (a comment block by default; a toolkit default cannot know your Discussions
    URL). `issue.inferenceLabel` gains a label-name allowlist `pattern:` now that it renders into a
    double-quoted YAML scalar as well as a shell word.
  - **Consumer impact:** additive. A re-render pours the six templates into `.github/`; a repo that
    already has its own file at one of those paths keeps it (`render` refuses to clobber an
    unmanaged file) and can `eject:` any template it does not want. Keep `issue.bugLabel` /
    `issue.featureLabel` in step with `issue.typeLabels` if your repo's taxonomy is not the default —
    GitHub silently drops a label that does not exist, so a mismatch fails quietly.

### Fixed
- **`--allow-unreleased` no longer forfeits a genuine release's provenance (#383).** The hatch used to
  short-circuit the release lookup, so a toolkit that really *was* a pinned `npx github:…#vX.Y.Z`
  install resolved as `unverified` with `ref: null` — the field #374 records into the lock and #372
  writes into `toolkitRef`. The two flags are now orthogonal: `--allow-unreleased` suppresses the
  *refusal* only (the lookup still runs, so a real release keeps its `ref`), and a new `--offline`
  (env `WAFFLESTACK_OFFLINE=1`) is the sole switch that skips the network — for an air-gapped run that
  would otherwise stall on a doomed `git ls-remote`. `resolveToolkitIdentity` drops its
  `allowUnreleased` parameter accordingly. `schema/FORMAT.md`, `AGENTS.md`, and the `toolkit-ref.mjs`
  docblock now describe the shipped behavior. **Consumer impact:** none — no rendered output changes; a
  consumer who set the hatch to unblock CI now records honest release provenance instead of a silent null.
- **Finish the #396 paid-hook disarm — eject the three workflows so the lock forgets them (#414).**
  PR #396 dropped `waffle-hygiene.yml`, `waffle-pr-green-hook.yml`, and `waffle-pr-response-hook.yml`
  from `include:` and from git tracking, but the committed `.waffle/waffle.lock.json` still tracked
  their rendered paths, so `trackedFiles` re-admission (`refs.mjs`) re-poured all three on every
  `render` — leaving them `??`-untracked and one `git add -A` away from re-arming pr-green's paid
  dispatch. They are now `eject:`-ed via the CLI (`node installer/cli.mjs eject files/.github/…`),
  which drops their lock entries so `render` no longer produces them, and the stale `.gitignore` /
  `waffle.yaml` comments now describe the real (eject-based) re-arm mechanism. This repo's own
  disarm only; the toolkit sources under `stacks/github-workflow/files/` are untouched.
  **Consumer impact:** none — a `.waffle/`-config-only change to the wafflestack repo itself.
- **qa step 7 no longer re-resolves `HEAD_SHA` after its first use (#412).** PR #410 added
  `$HEAD_SHA` to qa's staging path and status POST but left the block's late
  `HEAD_SHA=$(gh pr view …)` re-derivation *after* the first use — a fresh single-call
  execution expanded the staging filename empty, and the retained re-derivation stamped the
  `waffle/qa` status on the post-time head instead of the read-time head. The block now
  relies on step 1's `headRefOid`, mirroring adversarial-review. Also softens pr-response's
  "the head SHA makes each round's staging file its own" overclaim (two rounds on one
  unmoved head can still share a file; the read-back guard is the boundary) and splits the
  `waffle-cutoff` test alternation into two assertions — placeholder form and a standalone
  `waffle-cutoff-354-[0-9a-f]{40}\.txt` match — so a truncated concrete-example SHA fails.
  **Consumer impact:** patch — plain re-render; no config change.
- **Review-payload staging paths are namespaced by head SHA as well as PR number (#376).**
  Successive rounds on one PR no longer reuse a staging file, so autopilot's cold evidence pass
  (adversarial-review and qa cap hatches) never has to read a prior round's payload to overwrite
  it; the per-PR `$N` component and the read-back guards stay. pr-response's reply body and
  cutoff scratch file get the same shape. **Consumer impact:** re-render picks it up; no config
  change.
- **Split the git-family `&&` compounds into single allowlist-matchable commands (#340).** A
  `Bash(<prefix>:*)` entry matches by leading program, so `git checkout main && git pull`
  (git-workflow, release) and the tag/push compound matched no single-program grant the moment a
  repo tightens from blanket `Bash(git:*)` to per-subcommand entries; delegate's agent prompt
  chained `cd <worktree> && git status`. Pure compounds are now one command per line, the delegate
  first-command is `git -C {worktree_path} status` plus a standalone `cd`, W2b pins the split, and
  the #218 A4 source backstop grows a git-family arm (md runnable units, git/cd-leading only) so
  the class stays dead. **Consumer impact:** patch — plain re-render; no config change.
- **Back-port the exfil/destructive DANGER tier to the sibling guards (#331).** `waffle-label-hook`
  (both jobs), `waffle-pr-response-hook`, and `waffle-hygiene` now red a denied non-git/gh
  exfil/destructive call (`curl`/`wget`/`nc`/`ssh`/`rm`/`sudo`/…) even when the run produced
  delivery evidence — mirroring pr-green's #208 fix. The delivery downgrade still covers each
  job's real delivery path (git/gh, Edit/Write); sandbox escapes still outrank everything; the
  program list is one shared declaration per guard, derived, never re-typed, and the classifiers
  now fail closed (a jq error or an unclassifiable denial reds the run instead of silently
  zeroing every tier). **Consumer impact:** re-render; runs that previously went
  green-with-warning after a blocked exfil attempt now fail.
- **Pre-flight commands now mirror CI's required `test` job (#375).** `typecheckCmd` was
  `npm run validate` (the manifest validator, not tsc), `lintCmd` fell back to a
  `npm run lint --if-present` no-op (no `lint` script exists), and no pre-flight ran the
  `doctor --verify-render` step — so an agent could follow the rendered pre-flight exactly and
  still red a required check, which is precisely what happened on PR #370 (commit `46293cc`)
  during autopilot. Now `typecheckCmd: npm run typecheck`, `lintCmd: npm run validate` (this
  repo's lint-shaped static conformance check), and `buildCmd: npm run build` — a new
  `package.json` script wrapping `npm pack --dry-run` plus the doctor verify step. A new guard
  test (`installer/test/preflight-ci-parity.test.mjs`) fails whenever a command in tests.yml's
  required `test` job is missing from the rendered pre-flight, so the drift can't recur
  silently. **Consumer impact:** none — repo config (`.waffle/waffle.yaml`) and repo-local
  test only; no stack content changed.
- **`upgrade` now moves the pinned `toolkitRef` config keys — the write-side of the pin (#372).**
  `upgrade` moved the toolkit forward everywhere except the two places that decide *which toolkit
  actually runs*: `doctor.toolkitRef` (what CI's doctor job fetches) and `waffle.toolkitRef` (what
  every `/waffle-*` skill fetches). Both are plain config in `.waffle/waffle.yaml`, and `upgrade`
  never wrote that file — so a repo that followed the REQUIRED PRACTICE and **pinned** came out of an
  upgrade with a lock rendered by the *new* toolkit and a CI job re-rendering with the *old* one. The
  two disagree and the next unrelated PR goes red, whereupon `doctor` prints ``version skew — run
  `wafflestack upgrade` `` — the exact command that could not fix it.

  `upgrade` now rewrites a **release-pinned** `toolkitRef` to the toolkit that just rendered, between
  the migrations and the render — so the same run bakes the new ref into `waffle-doctor.yml` and every
  rendered `waffle-*` skill, and the pin CI fetches is *by construction* the pin the lock records
  (`toolkitPinFromIdentity(identity) === toolkitPinFromLock(lock)`, pinned by a test). It runs on every
  status including `current`, which is precisely the state an already-broken repo sits in — so it
  heals without a hand edit. It **only ever moves a pin the consumer already chose**: an absent key is
  never given one, an unpinned `github:owner/repo` keeps floating, a `#main`/`#<sha>` pin is left alone
  and noted, and a run that cannot prove it is a release (`--allow-unreleased`, a `dlx` install, an
  unanswerable lookup, or a release *checkout*) writes no pin at all and says why. **A release pin
  written as a git URL** (`git+https://github.com/o/r#v0.12.0`, `git@github.com:o/r.git#…`) is likewise
  left alone **and reported, with the remedy** (#386): npx resolves those specs and no `pattern:` rejects
  one, so a consumer can be holding one — and skipping it *silently*, as a plain "not a github ref",
  let the other key move while this one went on fetching the old toolkit, reintroducing the very
  lock/pin divergence this issue exists to kill. It is not rewritten (normalizing the form would change
  the consumer's fetch transport — an `ssh` URL on a private fork resolves where the https shorthand
  404s — and splicing its fragment would write a pin that is not `toolkitPinFromIdentity`), but it is
  never quiet. **The rewrite is
  byte-verbatim** (#386): `setScalarIn` splices only the pin scalar's own source bytes, so comments,
  quoting, flow collections and line widths elsewhere in the consumer's hand-authored config are not
  merely "preserved" but never touched — re-serializing the parsed document (`doc.toString()`) would
  reflow the whole file, turning a one-line pin bump into pages of diff. It is `doc.setIn` the helper
  avoids because `setIn` would CREATE an absent key — **not** because `setIn` drops comments, which it
  does not (`yaml` v2 keeps the old node on a scalar overwrite; the claim was wrong, and the test that
  pinned it could not fail). A run that changes nothing does not write the file at all. The gitignored
  `waffle.local.yaml` overlay is neither read nor written (#317). Bumps are surfaced in the CLI output
  and in `upgrade()`'s new `pinMoves`, beside `sourceMoves`.

  **The self-upgrade trap is answered by reporting, not by re-exec.** A `waffle.toolkitRef` pinned to
  an old tag means `/waffle-upgrade` runs the *old* CLI, which structurally cannot contain this fix and
  can only render itself — it reports "already on toolkit X" and moves nothing. But a pinned CLI still
  *learns the latest release* (`latestTag`), so it now names the exact command that escapes:
  `a newer toolkit release exists: v0.14.0 — … npx --yes github:owner/repo#v0.14.0 upgrade`, returned as
  `newerRelease: {tag, command}`. `/waffle-upgrade` runs it. Re-exec stays rejected (#373).

  Also fixed a real docs bug found on the way: the `.waffle/waffle.yaml` examples in `docs/gitignore.md`
  showed `doctor:` at the **top level**, but project values are only read under `config:` — a consumer
  following the REQUIRED-PRACTICE example verbatim got no pin and no flags at all.

  **Consumer impact — read this if you pinned either `toolkitRef` key.** Your next `upgrade` will
  rewrite them (to the toolkit that rendered) and re-render the files that carry them: expect
  `.waffle/waffle.yaml`, `.github/workflows/waffle-doctor.yml` and the `waffle-*` skills in the diff,
  and commit them together. Nothing changes for an unpinned or absent key. **If your pin predates this
  release**, the old CLI runs and will not move it — take the newer-release line it prints (or run
  `/waffle-upgrade`, whose escalation flow does it for you) and run the pinned command it names; that
  run moves everything. One-time friction, and only once.
- **An unpinned `npx github:` invocation renders the DEFAULT BRANCH, not the latest release — the
  write path now refuses instead (#373).** `npx github:dustinkeeton/wafflestack <cmd>` with no
  `#ref` fetches whatever is on `main`. `main` and the tag behind it report the same `version` in
  `package.json`, so a bare `upgrade` would announce `0.8.0 → 0.12.0` and then write `0.12.0` *plus
  every unreleased commit since*, stamping `toolkitVersion: 0.12.0` into the consumer's lock. A CI
  job re-rendering the same config through a **pinned** ref — the required practice for
  `doctor --verify-render` (#314) — then produced different bytes and went red on a lock that was
  perfectly correct. The gate designed to catch a stale render failed on a fresh one, opaquely
  (exit 1, empty output, 1.2s).

  The CLI now establishes **what it is** before it writes anything (`installer/lib/toolkit-ref.mjs`,
  `resolveToolkitIdentity()`): `release` (the commit it runs IS a `vX.Y.Z` tag), `unreleased`
  (provably is not), or `unverified` (could not find out). Commands that **write files from toolkit
  content** — `render`/`bake`, `install`, `upgrade`, `reinstall`, `doctor --verify-render`, and
  `list --interactive` once a selection is applied — **refuse when `unreleased`**, exit 1, and print
  the exact pinned command to run instead. `unverified` **warns and proceeds**: failing closed on
  ignorance would make every consumer's CI depend on the toolkit's reachability, which is a worse
  bug than the one being fixed.

  The check is on the **commit**, not on whether a `#ref` was typed — strictly stronger, since it
  also catches a re-cut or force-pushed tag. A checkout answers it with `git describe`, **offline**;
  an `npx` install reads the cloned SHA from npm's hidden lockfile (offline) and classifies it with
  one `git ls-remote --tags` (not the GitHub REST API — its 60/hr unauthenticated limit is a live
  hazard on shared CI IPs). When the lookup fails, a shipped `CHANGELOG.md` carrying a non-empty
  `## [Unreleased]` section still proves the build is past the tag.

  **Consumer impact — read this if you invoke wafflestack unpinned.** Pin the tag on anything that
  writes: `npx --yes github:dustinkeeton/wafflestack#vX.Y.Z render`. Set `doctor.toolkitRef` and
  `waffle.toolkitRef` in `.waffle/waffle.yaml` to the same pinned spec (unpinned is now a hard error
  for `--verify-render`, where it was previously a silent trap). **Plain `doctor` is deliberately
  NOT gated** — it only hashes your files against your lock, reads no toolkit content, and is
  correct from any toolkit — so the shipped, unpinned-by-default `waffle-doctor.yml` keeps working
  unchanged for every consumer. `init`, `eject`, `uninstall`, `validate` and `help` are untouched;
  `list` and `setup` report rather than write, so they warn and carry on. Developing the toolkit
  itself, where rendering a working tree is the point? Pass `--allow-unreleased`, or set
  `WAFFLESTACK_ALLOW_UNRELEASED=1` — it suppresses the *refusal*, not the *truth* (identity still
  resolves to `unreleased`), and short-circuits the network lookup, so local runs stay offline.

  Groundwork for the rest of the provenance epic (#377): `resolveToolkitIdentity()` returns
  `{status, version, commit, tag, ref, origin, repo, latestTag, lookupError}` with `ref` exactly
  `github:<owner>/<repo>#<tag>`, threaded through to `renderProject` / `upgrade` / `reinstall` and
  echoed on their results. #374 writes it into the lock; #372 writes it into the pinned config keys.
  This change adds **no** lock field, so no lock bytes move.
- **The human docs' skill count (#184).** `STATUS.md` and `ARCHITECTURE.md` both claimed **32 skills**;
  there are **37** on disk. `AGENTS.md` was already correct — the machine doc was right and the human docs
  had gone stale.
- **Project commands are never joined with `&&`, so the pre-flight can actually run (#218).** A
  `Bash(<prefix>:*)` allowlist entry matches a command by its **leading program**, and the hooks
  grant **one entry per project command** (`Bash(npm test:*)`, `Bash(npm run build:*)`, …). So a
  single Bash call whose text was `cmd1 && cmd2` matched **neither** entry and was **silently
  denied** — the paid CI run simply never checked the build, with no error to notice. The
  git-workflow PR-body test plan shipped exactly that — a "Build passes" row that ran
  `{{project.typecheckCmd}} && {{project.buildCmd}}` as one call — and `delegate`'s post-agent
  verification shipped it in a fenced
  `bash` block the orchestrator is told to **run**. The checklist is now four rows, one command
  each, in pre-flight order (lint → typecheck → test → build), matching the allowlist 1:1 and the
  pre-flight section that was already correct a hundred lines below it; delegate's fence runs its
  two commands on separate lines; and the `lead-engineer` / `devops-engineer` agents no longer
  hand the model a copy-pasteable 4-command compound to imitate.
  **But the templates were only one of the two doors.** The grant is
  `Bash({{project.lintCmd}}:*)` — the **consumer's config value, interpolated verbatim** — and
  `project.*Cmd` had no format validation, so an ordinary monorepo setting
  (`typecheckCmd: tsc --noEmit && eslint .`) rendered **ok** and emitted
  `Bash(tsc --noEmit && eslint .:*)`: a **dead grant that can match no command**, plus the verbatim
  pre-fix checklist row. So `project.{lint,typecheck,test,build}Cmd` now carry a **`pattern:`
  guard**, enforced where the value **enters**, so a value that cannot be granted fails the render
  and `doctor` — naming the key and carrying the remedy — rather than shipping a dead grant.
  **What the guard bans, and why: the DELIMITERS of the place the value lands, not "quotes".** The
  value is spliced verbatim into `--allowedTools 'Edit,…,Bash(<cmd>:*),…'`, and the CLI parses that
  word **textually** — split on `,`, each entry read as `Tool(spec)` — *before* any shell or quote
  processing. **So quoting cannot protect a delimiter**, and the delimiters are banned
  unconditionally, with no quote-awareness in the pattern:
  a **`,`** (it separates the allowlist entries), a **`(`/`)`** (they delimit the `Bash(…)` rule, and
  this also catches `<(…)`), a **`'`** (it terminates the single-quoted shell word, #254), a newline
  or CR (it breaks the `claude_args: >-` scalar), **leading/trailing whitespace** (`Bash(npm test :*)`
  matches no command), plus the compound class itself — `&&`, `||`, `;`, `|`, `&`, a `cd ` prefix, a
  `$(…)`/backtick substitution, a `${{ }}` expression. And a guarded key must be handed a **string**:
  a list or map would otherwise be flattened into text *before* the pattern could police it.
  **And it must not be EMPTY (#351).** The character class was `*` (zero-or-**more**), so `""` satisfied
  every lookahead, passed both gates, and rendered `Bash(:*)` — an allowlist entry whose **prefix is the
  empty string**, and *every* command has the empty string as a prefix. Whether the CLI reads that as a
  grant on **every** Bash command — unrestricted Bash in the three workflows this lands in, two of which
  hold `contents: write`, one of them the `implement` job that processes **untrusted issue content** — or
  as an inert entry (merely another silent dead grant) is a question about the CLI's parsing of a
  degenerate rule, and **a privilege boundary must never rest on which way it is answered**. Both answers
  are wrong, so the quantifier is now `+` and the value is rejected at the door. This is also the value a
  repo with **no such check** reaches for *first* (#219) — so rejecting it is only half a fix, and the
  message names a **destination**: the shell no-op **`true`**, which passes the guard, grants a narrow and
  harmless `Bash(true:*)`, and exits 0. (`true` is deliberately **not** a shipped `default:` — a default of
  `true` would give every unconfigured consumer a gate that passes **vacuously**, green and checking
  nothing, which is the silent false pass this entire effort exists to eliminate.)
  **A `"` is NOT banned.** It is not a delimiter at any landing site — it is literal inside the
  single-quoted shell word, in the folded scalar, in the markdown code spans these values also land
  in, and in the `Bash(…)` prefix, where it round-trips with the command the agent actually runs. So
  `go test -run "TestFoo" ./...` renders fine. A false reject is loud and worked around in one line;
  a false accept is a dead grant nobody ever sees — so the guard fails **closed** on the delimiters
  and stays out of the way everywhere else.
  **The guard runs in the gate you actually have.** A `pattern:` polices the config *value*, so it
  needs no re-render to evaluate — and it must not, because the shipped `waffle-doctor.yml` runs
  **bare `doctor`** (`doctor.flags` defaults to `""`) and `--verify-render` is opt-in (#314). Bare
  doctor only hashes the tree against the lock, so without this it would sail straight past a bad
  value: an existing repo's renders and lock were produced *before* the guard, they still agree, and
  the dead grant sits behind a green check. **`doctor` now evaluates config guards in every mode**,
  and a rejected value fails it — which is the only reason the Consumer-impact line below is true.
  (`&&` remains load-bearing — and untouched — in the prose that warns *against* compounds, the jq
  denial classifier that *detects* them, GHA `if:` expressions, and git-family compounds. And in
  `project.installCmd`, which lands in a `run:` shell GitHub executes directly — a compound there is
  legitimate, which is why its guard bans only newlines and `${{ }}`.)
  **What the tests guarantee**, precisely — the config guard at render (`A5`) *and in bare `doctor`,
  the shipped gate* (`A6`), including the **type door** (`A7`: a list/map value cannot dodge the
  pattern by being flattened into a string) and the **empty door** (`A8`: `""` — and the whitespace-only
  values around it — rejected at render *and* in bare `doctor`, on all four keys, with the message
  pointing at `true`, and **no rendered allowlist carrying an empty prefix**); and — the assertion that
  actually pins the property —
  **every accepted command is ACTUALLY GRANTED** by the shipped allowlist, parsed the way the CLI
  parses it (`A5`(d)). An accept column alone only proves the render did not *fail*; it cannot see a
  value that renders `ok` and still ships a grant no command matches, which is exactly how the comma
  and the whitespace holes survived a green suite. Also: no compound allowlist entry (`A1`); the
  PR-body checklist is exactly the four single commands, each covered by a grant (`A2`);
  delegate runs one command per fence (`A3`);
  and a `stacks/**` source backstop (`A4`) that fails a project command joined to more work inside a
  **code span** (including in a heredoc body), inside a **`bash` fence** carrying any second command,
  joined to **another project placeholder** by an operator, or `cd …`-prefixed / `$(…)`-wrapped —
  with a **positive control** so it cannot pass vacuously. **What they do not guarantee:** a project
  command joined to non-project work in **bare, un-backticked** template text. Nothing in `stacks/`
  occupies that gap today; closing it without false-firing on ordinary prose is tracked in **#350**.
  **Consumer impact:** re-render. PRs opened by the agent get a 4-item test plan instead of 3. **If
  any of your four `project.*Cmd` values carries a compound, a `,`, a `(`/`)`, a `'`, or whitespace at
  either end — or is a list/map rather than a string, or is **empty** — `render` and `doctor` — bare
  `doctor`, the one your CI already runs — will now fail**, name the key, and tell you to wrap it in an
  npm-script-style single entry point (`npm run ci`). **If the check genuinely does not exist in your
  repo, set the value to the shell no-op `true`** — not `""`, which was granting `Bash(:*)`, an empty
  allowlist prefix that every command matches. The **`,`** is the one most likely to bite an ordinary repo:
  `eslint --ext .js,.jsx,.ts,.tsx src` is one program with no shell operator, and it was shipping a
  shattered, unmatchable grant. (A `"` is fine and keeps rendering.) That failure is the point, and it
  is aimed squarely at the repos that are *already* broken: such a value was **already** producing a
  dead grant and a silently denied CI check, behind a doctor that reported no drift.
- **New: an optional `patternHint:` on a config key (#218).** A `pattern:` rejection printed the raw
  regex and nothing else. When a guard newly rejects a consumer's value there is **no migration** —
  no tool can safely split `tsc --noEmit && eslint .` for them — so that message *is* the entire
  upgrade path, and a PCRE lookahead is not an upgrade path. A key may now declare the remedy in
  prose; it is printed after the pattern when the guard fires. Absent on a key, its messages are
  byte-identical to before. **Consumer impact:** none unless you author stacks.
- **The hooks' dedup markers are matched on the full literal, not a loose substring (#211).** Both
  `waffle-pr-response-hook` and `waffle-pr-green-hook` looked for their marker with a **bare-word
  regex** — `test("waffle-pr-response")` / `test("waffle-adversarial-review")` — while the skills
  they wrap, and the workflows' own job-level `if:`, key on the full literal HTML comment
  (`<!-- waffle-pr-response -->`). So any PR whose conversation *merely named the marker word* — a
  human comment, a review discussing the hook — matched. Every call site now matches the full
  literal (`test()` takes a **regex**, which is the wrong tool for a marker containing `<!--` /
  `-->`), which closes the bare-word class outright.
  **The audit found SIX marker predicates across the two hooks, not the four originally analyzed —
  and FIVE survive**, under one sentence: **a predicate that ADMITS work requires a marker-LED body
  (`startswith()` / `startsWith()`); the one predicate that BOUNDS work over-matches (`index()`).**
  The four admitting sites — pr-green's idempotency gate, pr-green's `check_delivered`,
  pr-response's job-level trigger `if:`, and pr-response's `check_delivered` — each fail expensively
  on a **false positive**: a silently-skipped security review, a fail-open green over a blocked
  `git push`, a paid `contents: write` dispatch on a review that is not the bot's. The one exception
  is **pr-response's per-PR loop bound**, whose false *negative* re-arms an unbounded paid,
  committing loop; it keeps the **tolerant** substring match on purpose.
  The sixth predicate — a `!contains(<own marker>)` **self-trigger block** in pr-response's job `if:`
  — is **deleted**, because once the trigger beside it became marker-LED the block was dead *and*
  harmful. A self-trigger cannot reach that `if:` at all (the hook fires on `pull_request_review`;
  its own reply is an **issue comment**), and two markers cannot both sit at offset 0, so anything
  satisfying the trigger is an adversarial review by construction. Its only **reachable** effect was
  a false negative: silently dropping a genuine adversarial review that *quoted* the pr-response
  literal in prose — i.e. a review **of a hooks PR**, the population this hook most needs to answer.
  "The skill forbids quoting it" is not a guarantee: that is the exact assurance PR #296 disproved
  for the sibling marker, and #296 is the evidence base for this whole fix.
  **Scope, precisely:** matching the full literal closes bodies that *name* the marker; requiring the
  marker to **lead** the body closes bodies that *quote* it. Neither class is hypothetical. PR #207
  (the evidence PR for #211) carries a **human comment with the literal at offset 1084**, which under
  a substring match read as proof the bot had replied. PR **#296**'s QA review carries the
  adversarial-review literal at **offset 1103**, in prose *about* the hook — and that single body
  defeated **both halves** of the review loop: pr-green's gate read it as "this head is already
  reviewed" (so the real adversarial review never posted) while pr-response's job-level `if:` read it
  as the bot's review (so the paid, committing job fired on the QA review and spent the PR's one
  automated reply). Both are now closed at all five admitting sites.
  At the loop bound the quoting class remains **deliberately** open (a comment quoting the literal
  costs that PR its one automated reply — wrong, but safe), and that residual — **that site and no
  other** — is tracked in **#333**; narrowing by comment *author* was evaluated and **does not
  discriminate here**, because the hook posts under the same identity humans comment under.
  The three marker-posting skills now all carry the same rule: the marker **leads** the body, and a
  raw marker literal is **never** pasted mid-body — name it or break it. `qa` was the one skill that
  never got that rule, and it is the skill that demonstrably produced the offending body on #296.
  In `waffle-pr-response-hook` the fail-open was the live, high-severity one: a single-tier classifier
  holding `contents: write`, so a false `delivered=1` excused the whole hard class — a blocked
  `git push`, `curl`, `rm -rf` — *and its query has no `commit_id` narrowing at all*, so **any**
  comment on the PR satisfied it. In `waffle-pr-green-hook` the severity is smaller after #208 — only
  the `amb` tier is still downgradeable, and both of its sites also filter `commit_id == HEAD_SHA` —
  but the loose match was wrong there too. The `commit_id` narrowing is preserved: narrowing and
  literal-matching are independent, and both are wanted.
  *Note for anyone touching the one remaining `index()` (the loop bound):* it returns an **offset**,
  and the marker sits on the body's **first line** ⇒ offset **`0`**. In jq only `null`/`false` are
  falsy, so the bare `select((.body // "") | index("…"))` form correctly keeps a `0` hit. Do **not**
  "harden" it to `index(…) > 0` — that drops exactly the real reply. Guard and gate tests now pin
  mention-vs-quote-vs-literal for both hooks, pin the asymmetry in both directions, pin the
  job-level trigger as `startsWith()`, pin that the offset is never compared, and pin that pr-green's
  **dispatch prompt** demands the marker as the review's FIRST line — the prompt is the instruction
  the CI harness actually receives, and it had been left saying "on its own line", the weaker
  placement its own delivery check rejects.
  Back-porting #208's three-tier denial classifier to `waffle-pr-response-hook` (the *other* half of
  this fail-open) is tracked separately in **#331**.
- **pr-green: a blocked exfil/destructive call no longer goes green just because the review posted
  (#208).** #204 taught the `waffle-pr-green-hook` guard to downgrade a denied tool call to a warning
  when a marker-carrying adversarial review is on the head commit. The motivation was narrow — the
  program-name classifier cannot tell a read-only `git log` from a mutating `git push`, so a denied
  *read* was false-redding runs that had demonstrably posted their review. **The implementation was
  much wider than the motivation:** the downgrade excused the entire hard class, so a **denied**
  `curl … -d @…/gh/hosts.yml`, `rm -rf`, `git push`, or `gh secret list` warned and the job went
  **green** — in the one job whose whole purpose is chewing on untrusted PR content. Nothing ever
  escaped (the call *was* blocked; the allowlist is the control), but CI stopped telling us the
  attempt happened — a lost-signal bug. The hard class is now split into three tiers: a **sandbox
  escape** (unconditionally red, unchanged and still first), a new **exfil/destructive/mutating**
  tier — an exfil program, a mutating `git`/`gh` verb (`git push`, `git tag <name>`, `gh secret`,
  `gh pr merge`, …), or a blocked file edit — which is **never** downgraded, not even by a delivered
  review; and the genuinely **ambiguous** residue, which keeps #188's delivery-aware downgrade. The
  governing principle: *the downgrade exists only to excuse the classifier's imprecision* — a denial
  is downgradeable iff the classifier truly cannot tell read from mutate, never when the tool name or
  the verb says plainly what it is. `git`/`gh` are classified by verb, fail-closed (an unknown verb is
  treated as dangerous); a bare `permission_denials_count` (no array to classify) behaves exactly as
  before. **Consumer impact:** re-render to pick this up. This will newly **red** some runs that are
  green today — that is the point; inspect the `claude-execution-log-pr-green` artifact rather than
  widening `--allowedTools` to make it green.

  **Review hardening (#330).** The tier is only as good as the list it stands on, so three holes in
  that list were closed. (1) **The raw exfil channels were in neither list.** A denied
  `nc … < hosts.yml` — plus `netcat`, `socat`, `telnet`, `openssl s_client` — classified *SOFT* and
  the job went green **even with no review posted**; they are now in the destructive list and red.
  (2) **The two program lists are now ONE.** `hard` and `danger` kept hand-maintained copies with a
  load-bearing invariant (`danger == hard \ {gh,git}`) that no test pinned — and the natural way to
  fix a gap (add the program to `hard`) did not make it red, it made it **AMB**, which a delivered
  review *downgrades*: #208, silently re-opened. `danger` is now **derived** from a single
  declaration, so the drift is unrepresentable, and a test pins the derivation against the rendered
  YAML. (3) **The classifier now fails CLOSED.** `2>/dev/null || echo 0` read a jq error as *proof of
  safety* in the very guard that decides whether delivery evidence may apply — break its expression,
  or hand it a denial whose `tool_name` key is simply absent, and every denial silently became
  SOFT/AMB and the run went green. A classifier that cannot run now reds the job and prints what jq
  said. Also: `git tag` was the one verb clause that failed *open* (it inspected only the token after
  `tag`, so `git tag --cleanup=verbatim -m x v9.9.9` slipped to AMB) — it is now fail-closed like
  every other clause, and "bare `git tag` is a read" correctly means end-of-**command**, not
  end-of-string, so `git tag | head`, `git tag; git log` and a bare `git tag` on its own line of a
  multi-line call still downgrade rather than redding as *"exfil/destructive"* in a tier no delivered
  review can rescue. **Known blind spots, documented in the guard:** scripting interpreters
  (`python3 -c`, `node -e`, …) and boundary-anchor evasion (`FOO=1 curl`, `/usr/bin/curl`,
  `{ curl …; }`) still classify SOFT; program-name matching cannot close these, and the
  allowlist-derived redesign that can is tracked in #331.

## [0.12.0] - 2026-07-11

### Added
- **`doctor --verify-render` — catch a render that no longer matches its config (#314).** `doctor`
  compares the files on disk against `.waffle/waffle.lock.json`, and never asked whether *either*
  still reflects `.waffle/waffle.yaml`. So a config edited without a re-render left the files and
  the lock stale **together** — they agreed with each other, and the gate went green. That hole
  affected **every** posture, including the default one, and nothing but discipline closed it. The
  new flag renders the committed inputs (config + `.waffle/extensions/` + the pinned toolkit) into a
  **temp directory**, hashes what the render *would* produce, and compares that against the
  **committed, unmodified** lock — reporting `stale render:` / `stale lock entry:` / `unrendered:`
  per file and failing the gate. It never writes to the working tree, which is exactly what makes it
  non-circular: gating on an in-place `render` rewrites the very lock it would then be checked
  against, so it cannot fail (see the tautology warning in `docs/gitignore.md`). It composes with
  `--allow-missing` — the #311 all-absent guard is the safety net ("never pass having checked
  nothing") and this is the principled escape from it ("I have no renders *on purpose* — verify by
  rendering instead"), so **`--allow-missing --verify-render` turns the lock-only posture
  ([`docs/gitignore.md`](docs/gitignore.md) Posture 2b) from "hand-roll your own CI job" into one
  `doctor.flags` line on the shipped `waffle-doctor.yml`.** Opt-in via the **existing**
  `doctor.flags` config key (no new config surface — a flag composes, an enum would not); absent the
  flag, `doctor` behaves exactly as before. It does make render determinism load-bearing, so a test
  now renders identical inputs twice and asserts identical hashes, failing loudly if a future
  nondeterminism (a timestamp, a map ordering) creeps in.
  **Consumer impact:** additive; no behavior change unless you pass the flag. **Pin
  `doctor.toolkitRef` to a release tag before you adopt it** (see the docs entry under *Changed*):
  this is the one flag that makes the toolkit load-bearing. Then adopt with
  `doctor: { flags: --verify-render }` in `.waffle/waffle.yaml` (or `--allow-missing
  --verify-render` if you gitignore your whole render), then re-render to update the workflow.
- **Dedicated writing-craft skills for the two docs agents (#224).** The docs agents' writing
  standards previously lived entirely in the injected `docs.humanDocSpec` / `docs.machineDocSpec`
  config blobs, which say *which files* to write and how to structure them — but nothing about **how
  to write them**. Three new `docs-system` skills carry that craft as named, reusable standards:
  **`prose`** (plain language, one idea per sentence, conclusion first, headings + bold leads alone
  must carry the story), **`md-maximalist`** (markdown's full range — tables, callouts, task lists,
  collapsibles, fenced blocks — with form chosen from the content's shape and every choice held to
  one test: does it speed up a scanning reader; richness in service of scanning, never decoration),
  and **`accurate`** (machine-legible accuracy, docs as code — every claim traceable to a file
  actually read, omission over invention, no hedging as cover, a wrong doc is a bug). The grants are
  **orthogonal by audience** (settled in #299): `prose` + `md-maximalist` → **docs-human** (human
  digestibility), `accurate` → **docs-agent** (claims an agent can act on without judgment). Each is
  granted to its agent in **both** the frontmatter `skills:` list and the agent's **body prose** —
  the latter is load-bearing because the codex target drops frontmatter grants — and all three are
  `user-invocable: true`, so `/prose`, `/md-maximalist`, and `/accurate` also work as ad-hoc slash
  commands on any file (docs-human can still reach for `/accurate` on demand).
  **Consumer impact:** additive/minor. Pure stack authoring — no installer, schema, or config change,
  and no new config keys. A `render` picks up the three new skills and the two reworded agent bodies;
  nothing existing is renamed or removed and no migration is required.
- **Default co-author trailer credits the consuming repo's owner (#284).** Two new lockstep config
  keys — **`git.ownerName`** / **`git.ownerEmail`** — are declared in both the `github-workflow` and
  `orchestration` stacks (byte-identical guard patterns and defaults, pinned by a deep-equal lockstep
  test), and the **`git.coAuthorTrailer` default flips** from
  `Co-Authored-By: {{harness.assistantName}} <noreply@anthropic.com>` (an email mapped to no GitHub
  account) to `Co-authored-by: {{git.ownerName}} <{{git.ownerEmail}}>` (nested substitution). GitHub
  grants contribution-graph credit to a verified co-author email on default-branch commits, so
  agent-authored commits the owner initiates and merges now count toward **the owner's** heatmap while
  the agent keeps its displayed author identity. The setup note documents the mechanics: the owner
  email must be **verified on the owner's GitHub account** (the `ID+user@users.noreply.github.com`
  form earns credit while staying private), credit accrues only on **default-branch** commits, and —
  like `git.botEmail` — repos rendering in CI/worktrees should commit the values in
  `.waffle/waffle.yaml`, not the gitignored overlay.
  **Consumer impact:** additive/minor. Unset owner keys fall back to declared placeholder defaults
  (`Repository Owner <owner@users.noreply.github.com>` — passes the guards but credits nobody, so set
  the real values), and an explicit `git.coAuthorTrailer` override is honored unchanged. A repo that
  commits its render will see a re-render diff where the trailer text changed. No migration required —
  the default resolves at render; no consumer file is mutated.
- **Programmatic Gravatar pipeline for per-agent avatars (#285, builds on #157/#156).** The manual
  Gravatar registration `.waffle/AVATARS.md` used to document is now a mostly-automated owner-side
  command. New **`wafflestack avatars sync`** enumerates the installed agent roster with its derived
  commit emails (the *same* derivation the manifest prints, via a new shared
  `waffledocs.mjs#collectAgentAvatars`), rasterizes each deterministic avatar SVG→512px **G-rated**
  PNG, and for every email **already verified** on the Gravatar account uploads and assigns it over
  the Gravatar v3 REST API. **`wafflestack avatars status`** probes without writing and reports
  **roster drift** (an installed agent whose address is unregistered), exiting non-zero so CI can
  gate. Gravatar exposes **no API to add or verify a new email**, so an unverified address is
  reported as a manual "verify at gravatar.com, then re-run" remainder — the one tolerated manual
  step. The owner-only OAuth2 token is read from `WAFFLE_GRAVATAR_TOKEN` at runtime (never a flag,
  never rendered into a committed file); the HTTP client and SVG→PNG rasterizer are **injected**, so
  the unit suite mocks both and `npm test` makes no network or native calls. `.waffle/AVATARS.md`
  regenerates to describe the pipeline (owner runs sync; consumers on defaults inherit; overriders
  re-run against their own domain) instead of the manual procedure, keeping the smoke test and every
  subaddressability/override caveat branch.
  **Consumer impact:** the **default `git.botEmail` flips** from the `wafflebot@users.noreply.github.com`
  placeholder to the toolkit-owned, subaddressable **`bot@wafflenet.io`** — a project **on defaults**
  now gets distinct per-agent `bot+<slug>@…` author emails (and, once the toolkit owner runs
  `avatars sync`, per-agent avatars on GitHub) with zero setup. The trade-off: default commits carry
  a toolkit-domain author email unless overridden, and the old noreply default's "Verified badge for
  free" property is forfeited on defaults (avatars XOR a verified sub-agent). A repo that sets its own
  `git.botEmail` is unaffected; a repo that commits its render will see a re-render diff where it
  leaned on the old default. No migration required — `render` picks it up.
- **Per-PR token accounting + a global counter badge (#227).** The four Claude-dispatching
  workflows (label-hook enrich/implement, hygiene, pr-green, pr-response) each gain a final
  **`Record token spend`** step: it jq-extracts `usage`/`total_cost_usd` from the existing
  execution log and folds it into ONE marker-keyed comment (`<!-- waffle-token-count -->`) on
  the run's PR (implement/hygiene resolve it from the result's PR URL; enrich posts on the
  issue) — one row per `run_id.run_attempt`, totals always recomputed from the full run map,
  and the step can never red a run (`always()` + `continue-on-error` + an exit-0-only script
  that skips missing/malformed/zero-usage logs, the invalid-API-key shape included). On merge,
  `waffle-post-merge-hook` (new step, plus `pull-requests: read`) sums the comment's
  machine-readable data line into `.waffle/telemetry/tokens.json` on the orphan
  **`waffle-telemetry`** branch — the file doubles as a shields.io endpoint-badge JSON — via
  pure `gh api` (orphan bootstrap through the Git Data API, sha-conditional PUT with bounded
  retry, per-PR dedup map; no checkout, no local git, so the #160 identity-neutrality holds by
  construction). Setup notes document the counter, the consumer badge line, and per-hook
  token-spend subsections; the jq prerequisite now also lists the pr-response/post-merge
  workflows (drive-by fix); this repo's README gains the badge. Content tests pin the step's
  presence/harmlessness, the sibling-marker collision guard (a token comment must never
  contain another hook's marker substring), and the post-merge counter invariants. Local
  interactive-session spend is a documented v1 gap tracked as a follow-up spike issue.
- **Per-agent avatars on GitHub commit views (#157, builds on #156).** Each agent now has a distinct
  avatar wherever its identity shows up — including GitHub. `render` emits one **static**,
  deterministic waffle SVG per installed agent to `.waffle/avatars/<agent>.svg` (the same name-seeded
  character `team.html` already draws, minus the SMIL animation, sized 512px for upload), plus a
  generated `.waffle/AVATARS.md` manifest pairing every agent with **the exact commit email it
  authors under** — derived by new `waffledocs.mjs` helpers `extractBaseEmail`/`deriveAgentEmail`,
  kept in lockstep with the delegate skill's prose rules and pinned by tests to the documented
  examples. Both flow through `emit()`, so they are lock-tracked, doctor-drift-checked, and pruned
  when a selection drops every agent. The `identity:` block gains an optional **`avatar`** key (a
  repo-relative path or `https://` URL — the allowlist admits those two shapes and nothing else: no
  other scheme, no leading `/`, no `//` authority, no percent-encoding, no `..`; absent means the
  generated default), which renders through to `.claude/agents/*.md`
  and `.agents/agents/*.md`. **The mechanism, stated honestly:** GitHub picks a commit avatar from the
  author email — an account's avatar if the email is registered there, otherwise that email's
  **Gravatar**, otherwise the gray Octocat. Because the derived `bot+<agent>@…` aliases belong to no
  GitHub account, they land on the Gravatar path. **Registering one Gravatar per agent email is a
  manual, one-time step this toolkit does not and cannot perform**, so the manifest ships the exact
  addresses, one-line SVG→PNG conversion commands (no raster dependency is added to the installer),
  the registration procedure, and a smoke test — plus the caveat that GitHub caches the email→avatar
  association. It also states the anti-recommendation: never add these aliases as secondary emails on
  the bot's GitHub account, which would relink every agent to one profile and one avatar. A project
  with no bot identity (bare `git.cmd`), or one whose base email cannot subaddress, gets a manifest
  that says exactly that instead of inventing an address.
  **Consumer note:** the new avatar files and manifest appear on the next `render`; a repo that
  commits its render will see new lock entries. The manifest's contents depend on `git.cmd` /
  `git.agentIdentities`, so changing those (correctly) drifts the lock.
- **Per-agent virtualized git identities (#156, `orchestration` + `github-workflow`).** Every agent
  spawned by the `delegate` skill used to commit under the same identity with a byte-identical
  `Co-Authored-By` trailer — two different agents produced indistinguishable attribution. Agents now
  carry an optional `identity: { displayName }` frontmatter block (documented in `schema/FORMAT.md`,
  declared on all 14 shipped agents), and the delegate skill derives each spawned agent's git author
  at spawn time: the display name, plus the bot email **plus-addressed** with the agent's own slug
  (`bot@x.com` → `bot+lead-engineer@x.com`). `git.agentIdentities` overrides that derived default
  per field. **The opt-in is unchanged and singular:** a bare `git.cmd` means no bot identity is
  configured, so nothing is virtualized and the map is inert — the toolkit still never clobbers a
  human's git config. Two honest caveats, stated in the skill: attribution is per agent *type*, not
  per spawn (two parallel `lead-engineer`s share an author); a plus-addressed alias is a distinct
  email to GitHub, so such commits do not link to the bot account unless the alias is registered
  there; and a base email that **cannot** subaddress — a `*.noreply.github.com` domain, or a local
  part that already carries a `+` (GitHub's canonical `<id>+<user>@users.noreply.github.com`) — is
  used **verbatim** rather than mangled into an address that routes nowhere, so those agents differ
  by display name only. The `claude:` frontmatter passthrough may not shadow a reserved key
  (`name`/`description`/`skills`/`identity`); `validate` and the external-stack gate reject it, so
  an unvalidated `identity` cannot be hoisted over the validated one. Also new: `harness.agentsDir`
  (the Markdown agent-definitions path per target, sibling of `harness.skillsDir`), so the derivation
  rule reads agent frontmatter without hardcoding `.claude/`. Both path built-ins are now
  injection-guarded, and codex points at `.agents/agents` (its own render is TOML, which carries no
  `identity`) so codex and agents-dir keep the identical `harness.*` values that `renderSkill`'s
  shared-output dedupe relies on.
  **Consumer note:** a repo that commits its render must re-render to pick up the new agent
  frontmatter and the rewritten delegate skill.
- **`entryPatterns:` — render-time shape validation for map-valued config keys (#156).** The
  map-valued sibling of `pattern:`. A key declares the leaf shape of one entry
  (`botName`/`botEmail`/`signingKey` for `git.agentIdentities`) and every entry in the resolved value
  must satisfy it: each entry a map, each leaf key declared (an **unknown leaf fails the render**, so
  a typoed `botEmial:` cannot ride along unguarded), each leaf value a string fully matching its
  regex. An explicit `signingKey: ""` fails the render — the leaf is optional, so empty carries no
  information and would only render a `-c user.signingkey=` that git rejects only when the command
  signs (a non-signing recipe carries the empty flag silently).
  Enforced at both the top-level and nested substitution paths, and compiled **toolkit-wide**
  like `pattern:`, so the guard travels with the key rather than with whichever stack happens to be
  installed. This closes the hole #154 documented: `git.agentIdentities` leaves now land in an
  agent-executed shell command, and a value like `botEmail: "$(id)@x.com"` — which rendered cleanly
  before — now fails the render loudly. An agent's `identity.displayName` is guarded at the same
  trust boundary (`validate`, and `validateExternalStacks` at render for third-party stacks) against
  the same allowlist as `git.botName`, since it lands inside the quotes of `-c user.name="…"`.
- **The main bot identity is now wired through `git.cmd` (#155, `github-workflow`).** #154 declared
  the identity keys; nothing consumed them. A project now opts into a managed bot identity with one
  config line — `cmd: git -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}` — which
  injects the identity via `-c` flags into the rendered examples that actually record a committer
  (`commit`), leaving the machine's ambient `user.name` / `user.email` untouched. Identity-free
  commands (`push`, `checkout`, `diff`, `log`) stay a bare `git`: they write no committer, so the
  flags were noise. `{{git.cmd}}` now also threads through the `release`
  skill's commit and the `delegate` skill's spawned-agent commit instruction, and `git-workflow` renders
  the resolved `git.cmd` so an agent can see whether an identity is in effect. `git.coAuthorTrailer`
  is unchanged by design: with a bot identity the commit *author* is the bot, while the trailer
  credits the AI harness.
  **Deliberately not an engine conditional.** `git.cmd` keeps its bare `git` default and there is no
  "if a bot identity is configured" branch in the renderer. A conditional keyed on merged config
  would make renders irreproducible — the trigger input would include the gitignored
  `.waffle/waffle.local.yaml`, which is absent in CI and in fresh `git worktree` checkouts, so a
  rendered `git.cmd` would differ per machine and trip the doctor drift gate. The config recipe *is*
  the conditional.
  **Two rules the docs now state.** (1) Quote `user.name`: `git.botName` admits single interior
  spaces and `git.cmd` splices it into an unquoted shell word. (2) Set **both** `git.botName` and
  `git.botEmail` as real project-config values rather than leaning on their stack defaults — stacks
  that declare `git.cmd` but not the identity keys (e.g. `orchestration`) resolve nested keys from
  project *values* only, so a defaults-only recipe renders a literal `{{git.botEmail}}` into their
  skills, silently. Also new: a repo that commits its render and re-renders in CI should commit
  `git.botEmail` too (use a noreply-style address) rather than hiding it in the local overlay — the
  overlay split assumes local-only rendering. `git.signingKey` stays out of the recipe (#158).
  **Signing is not covered by `git.cmd`.** It overrides the identity and nothing else, so an ambient
  `commit.gpgsign = true` still signs a bot-authored commit with the developer's key (GitHub then
  attributes the vouching to the human), and a prompting signer blocks the non-interactive commit.
  Setup-note rule (4) now says so and gives the remedy — `-c commit.gpgsign=false` when the bot holds
  no `signingKey`, which this repo's own `git.cmd` now uses. A real signing model is #158.
  **Consumer impact: no default changed, but the `git.cmd` accepted-value contract narrowed**
  (claim corrected by #244 — this passage originally said "no behavior change"). No command default
  changed and no key became required; a *default* consumer re-renders byte-identically
  (`release/SKILL.md` is unchanged), except that `git-workflow/SKILL.md` gains the opt-in prose and
  a resolved-`git.cmd` block, so `render` rewrites that one file. A consumer who had **already set
  `git.cmd`**, however, now has the identity values composed into it validated against their
  declaring stack's `pattern:` guards, unioned toolkit-wide — so a pre-existing recipe whose
  `git.botName` / `git.botEmail` / `git.signingKey` values carry `${{ … }}`, quotes, or shell
  metacharacters newly **fails `render`** where it previously rendered silently. **Migration:**
  bring the value into the allowlisted shape the error names (it cites the failing pattern and its
  declaring stack), or stop composing that key into `git.cmd` — the failure is the guard working,
  not a regression. Adopting the bot identity is an explicit opt-in; the `wafflestack init`
  scaffold and `schema/SETUP.md` now show the recipe. Enforcement is prompt-level (agents follow
  the rendered examples) — #159/#160 harden it. This toolkit repo dogfoods the opt-in and now
  commits agent work as `Wafflebot <bot@wafflenet.io>`.
- **First-class GitHub identity config keys (#154, `github-workflow`).** `git.botName`,
  `git.botEmail`, `git.signingKey`, and `git.agentIdentities` are now declared in the stack's
  `config:` schema with placeholder defaults, and a rendered "Bot identity (config)" reference
  block in the `git-workflow` skill. This is the foundation the rest of the identity model (#153)
  builds on. Layering is unchanged: put the shared `git.botName` in the committed
  `.waffle/waffle.yaml` and the account-specific `git.botEmail` / `git.signingKey` in the
  gitignored `.waffle/waffle.local.yaml`; `git.agentIdentities` entries may straddle both (they
  deep-merge, local winning per key). `git.signingKey` takes a GPG key ID or SSH public-key path —
  never private key material, since config values render into committed files.
  **What the `pattern:`s guarantee.** `git.botName` / `git.botEmail` / `git.signingKey` are guarded
  by **allowlist** patterns: each value must be drawn from an explicit safe character set (letters,
  digits and a short punctuation set; `botEmail` additionally requires a TLD), and each carries the
  `^(?!.*\$\{\{)` guard the stack's other patterns use, so a `${{ … }}` cannot ride through the
  renderer verbatim. Shell metacharacters (`` ` ``, `$`, `;`, `|`, `&`, `\`), quotes, newlines and
  leading/trailing whitespace are all rejected — a violating value fails the render loudly rather
  than corrupting the shell word `git.cmd` splices it into. `git.agentIdentities` is a map, so a
  `pattern:` (string scalars only) could not guard it — #156 closes that with `entryPatterns:`.
  **Consumer note:** all four keys were previously *undeclared* dotted paths that only resolved
  through nested substitution. Now that they are declared, a value like
  `git.cmd: git -c user.email={{git.botEmail}}` that references them *without* defining them
  resolves to the placeholder default (`wafflebot@users.noreply.github.com`) instead of passing the
  `{{git.botEmail}}` text through verbatim. Watch `git.signingKey` in particular: its default is the
  **empty string**, so an undefined-but-referenced `{{git.signingKey}}` now renders
  `git -c user.signingkey= …` — a silent, run-time-only failure, where before it left the obviously
  broken literal `{{git.signingKey}}` in the output. Define them if you reference them.
- **`todo-column` board scope for `delegate.defaultScope` (#206, `orchestration`).** A third
  default-scope value alongside `current-milestone` and `all-open`: delegate **exactly the open
  issues in the project board's Status = "Todo" column**, resolved via the
  `github-project-management` GraphQL catalog (board by title — with the `organization(login:)`
  variant for org-owned repos → Status field's "Todo" option → items filtered client-side to this
  repo's open Todo issues, with `pageInfo` detection of the `items(first: 100)` bound: paginate or
  stop, never trust a truncated set; the intersection carries a raised `--limit 500` bound plus a
  count invariant). A missing board or missing Todo option falls back to `all-open` — the
  documented contract of choosing the value, but **explicit, never silent**: the Phase 3 plan
  leads with the fallback line, interactive runs still gate the widened set, batch runs log it,
  and the checkpoint records what actually ran (`mode: "all-open"` with the fallback provenance in
  `description`). A **failed** board lookup (API error, missing Projects v2 token scope) is not a
  missing board — it stops the run rather than falling back, so a transient error never widens an
  unattended batch run. An empty-but-present Todo column is **not** a fallback — it stops the run
  as "nothing to delegate". Batch mode counts the `todo-column` default as an explicit-scope
  signal, same as `all-open`. Phase 1 also captures the In Progress / In Review option IDs so
  Board Setup's reuse of the Phase 1 lookups keeps kanban sync intact. The checkpoint schema's
  `scope.mode` enum gains `todo-column` (additive — old checkpoints stay valid, no version bump).
  - **Consumer impact:** additive, prompt-only. **No new config keys** — the existing
    `delegate.defaultScope` key accepts the new value; its default stays `current-milestone`. A
    plain re-render picks it up; behavior is unchanged unless a repo sets
    `delegate.defaultScope: todo-column`.
- **Per-run round caps for autopilot's gate loops — `+qa:N` / `+review:N` (#230,
  `orchestration`).** The QA-gate and review-loop consent flags may now carry an optional round
  count using the same colon syntax as `milestone:<name>`: `+review:3` consents to the review
  loop AND caps it at 3 rounds for this run; `+qa:1` does the same for the QA gate. Bare `+qa` /
  `+review` keep the rendered defaults (`autopilot.maxQaRounds` / `autopilot.maxReviewRounds`,
  both default 2), and when consent is captured interactively via `AskUserQuestion` the round
  count is captured in the same exchange. The effective caps follow the same per-run,
  never-sticky rule as the consents (this invocation only — the rendered defaults govern every
  future run), are restated in the recorded mandate and the end-of-run report, and bound the
  loops everywhere the rendered caps applied before (loop bound, cap-reached handling, guardrails,
  failure handling); cap-reached behavior is unchanged (proceed + `autopilot.holdLabel`
  follow-up). The audit gate's error-retry bound stays hardcoded ("retry once") — it is failure
  handling, not a quality loop, so there is no `+audit:N`.
  - **Consumer impact:** additive, prompt-only. **No new config keys** — the existing
    `autopilot.maxQaRounds` / `autopilot.maxReviewRounds` keys are reframed as render-time
    defaults, overridable per run. A plain re-render picks it up; behavior is unchanged unless an
    invocation passes `+qa:N` / `+review:N`.
- **`/qa` skill + opt-in autopilot QA gate (#228, `code-quality` + `orchestration`).** The
  functional sibling of `adversarial-review`: `/qa <PR#>` checks a **green PR against its linked
  issue's intent** — it reads the diff plus the issue's acceptance criteria, best-effort runs
  `project.testCmd` and exercises the changed behavior, assesses whether the diff carries real
  test coverage, and posts **one** PR review (inline comments + summary verdict) under its own
  dedup marker `<!-- waffle-qa -->` — deliberately distinct from adversarial-review's, so the
  pr-green dedup guard and the pr-response hook never mistake one gate's post for the other's.
  "No QA concerns" is a valid outcome; the skill reports only (`pr-response` is the applying
  half). Autopilot composes it as a **fifth instantiation-contract entry (fourth consent)** (`+qa` /
  `autopilot.qaLoop`, per-run, never sticky, default OFF): a new Step 5 between PR verification
  and the review loop that loops `qa <pr>` → `pr-response <pr> --yes` up to
  `autopilot.maxQaRounds` rounds (0 findings implemented = converged; cap reached = safety cap,
  not a merge blocker — file an `autopilot.holdLabel` follow-up and proceed). Auto-merge arming
  defers to the **last enabled gate**: QA gate (Step 5) → review loop (Step 6) → audit gate
  (Step 7).
  - **Consumer impact:** additive. `code-quality` gains the `qa` skill (renders
    `.claude/skills/qa/SKILL.md`; reuses `project.testCmd`, **no new required keys**);
    `orchestration` gains two optional keys — `autopilot.qaLoop` (default `false`) and
    `autopilot.maxQaRounds` (default `2`) — and a `skills/autopilot → skills/qa` requires edge,
    so installing `skills/autopilot` by ref now pulls the qa skill into the render. A plain
    re-render picks everything up; behavior is unchanged unless a run opts in with `+qa`.
- **`/pr-response` skill — rubric-scored PR review triage (#194, `github-workflow`).** The consuming
  side of `adversarial-review`: resolve a PR, read every review + review comment, score each finding
  0–3 on four dimensions (Severity · Validity · Effort/Risk · Alignment), and record an
  **Implement (≥8) / Defer (4–7) / Decline (≤3)** verdict with its score and a one-line reason.
  Accepted fixes are applied per `git-workflow`; one reply carrying a `<!-- waffle-pr-response -->`
  dedup marker summarizes the verdict table and is updated in place on re-runs. Two rules override
  the arithmetic: a **confirmed blocker is always Implement**, a **false positive is always
  Decline**. Because the recorded scores are the calibration dataset, the skill documents *how to
  recalibrate* its own thresholds. Agent callers pass `--yes` to skip the confirmation gate (the
  `clean-up` convention).
  - **Consumer impact:** additive. Enabling `github-workflow` renders one new file,
    `.claude/skills/pr-response/SKILL.md`; `render` picks it up. **No new config keys.**
- **`waffle-pr-response-hook` workflow — auto-answer an adversarial review (#195,
  `github-workflow`, opt-in syrup).** On `pull_request_review: [submitted]`, gated to reviews
  carrying the `<!-- waffle-adversarial-review -->` marker, it dispatches the harness to run
  `/pr-response` against the PR: score the findings, apply the accepted fixes, push them to the PR
  branch, and post one marked reply. It closes the loop `waffle-pr-green-hook` opens. Unlike
  pr-green it **commits** — the job holds `contents: write` + `pull-requests: write` — so two guards
  carry the design:
  - **Fork-head guard.** `pull_request_review` runs in *base-repo* context (this repo's secrets, a
    write token) even for a fork's PR, so the job-level `if:` requires
    `github.event.pull_request.head.repo.full_name == github.repository`. Fork PRs get no automated
    response; answer them by running `/pr-response` locally.
  - **Loop bound, per PR — not per head SHA.** pr-green dedups per head commit, so it re-reviews
    every new SHA, and every fix this hook pushes mints one; a per-SHA bound here would cycle
    forever. The gate skips when **any** `<!-- waffle-pr-response -->` comment already exists on the
    PR, and is fail-closed (an unverifiable bound never authorizes a paid, committing run). One
    automated response per pull request, ever.

  Delivery is verified against the API (a marked reply on the PR), not guessed from the harness's
  free-form output; a sandbox-escape attempt is always red. The execution log uploads as
  `claude-execution-log-pr-response`.
  - **Consumer impact:** additive and inert by default — the workflow is **opt-in syrup**, so
    enabling `github-workflow` does not render it. Pour it with
    `wafflestack install files/.github/workflows/waffle-pr-response-hook.yml` (its `requires:` edge
    pulls the `pr-response` skill). **One new config key**, `prResponse.claudeArgs` (optional,
    defaults to `""`, same injection-guarded shape as `prGreen.claudeArgs`). Arming it needs the
    `ANTHROPIC_API_KEY` secret and a `contents` + `pull-requests` write token — prefer a PAT in
    `WAFFLE_HYGIENE_TOKEN` so the pushed fixes re-run the PR's required checks.

### Changed
- **Docs — pin `doctor.toolkitRef` *before* arming `--verify-render` (#322).** `--verify-render` is
  the only part of the doctor gate that makes the **toolkit load-bearing**: it re-renders your
  committed config using whatever toolkit `npx --yes <doctor.toolkitRef>` fetched at that moment.
  The plain drift check never reads the toolkit (it hashes files against the lock), which is why a
  floating ref had been harmless. On the **unpinned default** (`github:dustinkeeton/wafflestack`,
  no `#tag`) an upstream content release now re-renders a consumer's config with a newer toolkit
  than their lock was built from — turning **their next, unrelated pull request red for a change
  nobody on their side made**. We recommended arming the flag and never said to pin first. Now the
  `doctor.flags` and `doctor.toolkitRef` setup notes both say *pin first, arm second*, and
  [`docs/gitignore.md`](docs/gitignore.md) Posture 2b leads with the pinned ref (its CI-gate recipe
  is honestly "two config lines", not one). Prose only — no engine change; the flag itself is
  unchanged and still correctly catches a consumer's own forgotten re-render.
  **Consumer impact:** if you already run `--verify-render` against an unpinned `doctor.toolkitRef`,
  pin it to a release tag (`github:dustinkeeton/wafflestack#v0.11.0`) and re-render; take new
  toolkit content deliberately via `wafflestack upgrade` instead of on our release cadence.
- **⚠️ Behavior change — `doctor --allow-missing` now fails when *every* managed file is absent
  (#311).** The flag exists so a repo that deliberately gitignores **a subset** of its renders can
  still run the CI drift gate: absent files are informational, only modified ones fail. But with
  *no* rendered file present, zero files were present, therefore zero were modified, therefore the
  check **exited 0 having verified the empty set** — and a green build that inspected nothing is
  worse than a red one, because it looks like protection. `doctor` already refused to let the flag
  mask a **missing lock**, on the stated grounds that it means "the repo never rendered"; a checkout
  where every managed file is absent *is* a repo that never rendered, so it now fails on exactly the
  same reasoning. The old guard caught the case where the **evidence** of a render was gone; this
  one catches the case where the **render itself** is gone. The failure names the count and both
  ways out — *"every managed file (58/58) is absent — this check verified nothing; run `wafflestack
  render`, or add `--verify-render` to verify by re-rendering the committed config against the lock
  (`render` + `git diff --exit-code .waffle/waffle.lock.json` is the manual equivalent) if the repo
  deliberately commits only the lock"*. A lock tracking **zero** files is not caught (nothing to
  render, so nothing failed to render).
  **Consumer impact:** a repo that gitignores its **entire** render and gates CI on
  `doctor --allow-missing` goes from green to **red**. That green was vacuous — and you do not have
  to hand-roll its replacement, because the gate that posture actually needs ships in this same
  release: add **`--verify-render`** (above), so `doctor: { flags: --allow-missing --verify-render }`
  re-renders the committed config in a temp dir and checks that against the lock. That is a real
  gate on a checkout with no rendered files at all, and — now that the lock records the **canonical**
  render (#317, below) — it stays green in CI even when a private `.waffle/waffle.local.yaml` feeds
  your local render. On a toolkit too old for the flag, the manual equivalent is CI running `render`
  and then `git diff --exit-code .waffle/waffle.lock.json`. This is the "Posture 2b" recipe
  documented in [`docs/gitignore.md`](docs/gitignore.md#posture-2b-commit-the-lock-only); the change
  turns that written warning into an enforced one. **Repos ignoring only a subset of their renders
  are unaffected** — that posture is supported, and the toolkit's own CI runs it.
- **`/issue` plans read-only first and confirms before it mutates (#288).** The skill used to write
  to GitHub immediately — `gh issue create` in create mode, an in-place title/body/label rewrite in
  enrich mode — before the user had seen a word of the drafted content, so a bad inference (wrong
  classification, off-base proposed solution, overwritten nuance) had to be repaired *after* it had
  already landed on the tracker. All three modes now run as **plan phase → confirmation gate → act
  phase**: context-gathering, classification, drafting, priority inference, and board placement all
  happen read-only, then the gate presents the proposed title, body, labels, and placement and waits
  for an explicit yes before the first mutation. **Declining leaves GitHub state untouched.** Batch
  mode drafts the *whole* `{{issue.inferenceLabel}}` queue before touching any of it and presents
  **one combined review** — approve the batch or a subset; unapproved issues keep their lifecycle
  label for a later pass. The gate covers **mutating, not reading**, so the plan phase is always safe
  to run — and it must be read *enough*: the board and milestone **queries** the placement is inferred
  from are plan-phase reads, so the gate never shows a placement it did not actually look up, and the
  act phase applies the milestone the user confirmed instead of silently re-deciding it. Two callers
  skip the gate: **`--yes`** (same convention as `pr-response` / `clean-up`) and a **non-interactive**
  agent or CI invocation — for those, the agent invocation *is* the explicit signal that stands in for
  the confirmation, the same precedent as `delegate` batch mode's `confirmedVia: "batch-scope"`. That
  auto-skip is load-bearing, not a convenience: label-hook dispatches enrich mode from a headless
  Actions job that can never answer a prompt, so a model honoring the gate there would hang the run
  until it timed out (label-hook's own `enrich` section now says so too). Such callers **log** the
  drafted plan before applying it, so an unattended run stays auditable after the fact instead of being
  unreviewable in the moment. The skip is scoped to *non-interactive* deliberately: **being an agent is
  not the test — having nobody to ask is.** The three agents that file issues with a live user present
  (`product-manager`, `task-planner`, `project-manager`) still gate. Since a subagent cannot prompt the
  user itself, it **hands the gate up**: it plans, stops before the first mutation, and returns the
  drafted plan as its final message for the caller to confirm and re-invoke with `--yes`. The flag is
  **stripped from `$ARGUMENTS` before mode detection**, so bare `/issue --yes` is a straight-through
  *batch enrich* rather than a junk issue titled `--yes`, and the flag never bleeds into a drafted title
  or body.
  *Consumer impact:* re-render. Interactive `/issue` now pauses where it previously acted — pass
  `--yes` for the old straight-through behavior. Hook, autopilot, and other non-interactive agent
  invocations are unchanged. An agent that files issues **on a live user's turn** no longer creates them
  outright: it now returns a plan for confirmation, so a caller that wants the old straight-through
  behavior must pass `--yes`.
- **Autopilot's gate subloops reuse persistent named agents across rounds (#295).** Steps 5 (QA)
  and 6 (review) no longer re-invoke their gate skills fresh every round: round 1 spawns each half
  as a **named agent** (`qa-pr<N>` / `respond-qa-pr<N>`, `review-pr<N>` / `respond-rev-pr<N>`) and
  later rounds **resume the same agent** with `SendMessage` ("the PR head moved to `<sha>` — re-run
  your pass on the new diff"). The agent keeps the diff, the issue's acceptance criteria, and its
  own verdict history, so a later round neither re-derives the PR from scratch nor re-litigates a
  finding an earlier round already declined. The **structured return contract is unchanged** —
  per-severity counts from `qa`/`adversarial-review`, per-verdict + implemented counts from
  `pr-response` — so convergence (0 implemented), the caps, the review markers, and the posted-review
  format are all untouched. Three guardrails bound the optimization: a **vanished agent degrades to a
  fresh spawn** (correctness never depends on persistence), each cap hatch's **evidence pass is still
  spawned fresh** (an agent that lived through every fix round is the wrong context to certify the
  result — #234's clean-fresh-pass semantics), and **no gate agent outlives its loop** (teardown is
  unconditional, including the red-round and errored-round stop paths; an errored round retries on a
  fresh spawn rather than re-entering a wedged context). The `qa`, `adversarial-review`, and
  `pr-response` skills now document being resumed with a new PR head: re-read the diff fresh from the
  new head, keep the finding/verdict history, and — for `pr-response` — never flip a settled verdict
  without new evidence, keeping F-numbering stable across rounds.
  **Consumer impact:** prose-only change to four SKILL.md files; no config or schema change;
  consuming repos pick it up on re-render.
- **Autopilot codifies implement-ahead for an independent next issue (#277).** The per-issue
  loop's Step 3 now documents that when issue N+1 is independent of the in-flight one under
  delegate's parallelization rules, the orchestrator MAY start N+1's implementer (Steps 2–3)
  in its own delegate-provisioned worktree while PR N is still in its gate loops (Steps 5–7)
  or merge-wait (Step 8) — so N+1's PR is open the moment N merges. Gates stay serial: N+1's
  gate loops do not start until PR N reads `MERGED` and Step 9 housekeeping has run, and N+1's
  branch rebases onto the freshly merged main before its gates begin (the reconciliation point
  for the accepted, bounded pre-merge base staleness). Serial-dependent chains and the Step 8
  merge-wait are unchanged, and Failure handling now covers an implement-ahead branch
  invalidated by PR N's gate fixes (re-plan/re-implement counts as the one retry).
  **Consumer impact:** prose-only change to the autopilot SKILL.md; no config or schema change;
  consuming repos pick it up on re-render.
- **Autopilot codifies the plan-ahead overlap for the next issue's planning context (#276).**
  The per-issue loop's Step 1 now documents that while PR N is in its gate loops (Steps 5–7)
  or merge-wait (Step 8), the orchestrator MAY spawn issue N+1's Step 1 planning context
  early — the planner is read-only and writes only its own gitignored throwaway plan file
  under `autopilot.planDir`, so it is conflict-free by construction against the in-flight PR.
  Serial semantics are unchanged: N+1's plan is still handed to a fresh implementer only
  after Step 8 confirms `MERGED` for a dependent chain, and the plan stays a brief (Step 2's
  authority language already covers staleness). **Consumer impact:** prose-only change to the
  autopilot SKILL.md; no config or schema change; consuming repos pick it up on re-render.
- **The subloop cap escape hatch now briefs from a fresh post-cap review pass (#235).** When
  autopilot's QA gate (Step 5) or review loop (Step 6) exhausts its round cap with the final round
  still implementing fixes, the escape hatch previously filed its hold-labeled `/issue` follow-up
  from the **last round's** findings — which that same round's `pr-response --yes` had already
  fixed, handing a human a stale brief (#234 was a live occurrence). Autopilot now runs one extra
  `qa` / `adversarial-review` pass (outside the cap, no `pr-response` after it — cap+1 passes,
  each with a one-retry error bound, still strictly bounded) purely as the brief's source:
  findings → the follow-up is filed from **those** findings; a clean pass → the filing is
  **skipped** entirely, since a clean pass over the fixed code is the convergence evidence the cap
  denied the loop. Filing, like arming, belongs to the last enabled fix loop: when the review loop
  follows the QA gate in the same run, the QA hatch's filing defers to Step 6 — its `pr-response`
  rounds triage the fresh-pass findings, so no follow-up is filed that the same run then fixes.
  The fresh pass runs **before** arming so an armed PR can't merge mid-pass; if the pass errors
  twice, the hatch falls back to the last round's findings with a staleness note, and the run
  report gains buckets for the handed-off and fallback outcomes. The audit gate's escape hatch (Step 7)
  is a hard block and is unchanged. **Consumer impact:** prose + placeholder-description change
  only (autopilot SKILL.md and the `autopilot.maxQaRounds` / `autopilot.maxReviewRounds` /
  `autopilot.holdLabel` descriptions); no config or schema change; consuming repos pick it up on
  re-render.
- **entryPattern validation now reports every malformed entry/leaf in one pass (#246, deferred
  F5 from #245's review).** `entryPatternProblems` (né `entryPatternProblem`) walks the whole
  map-valued config value instead of short-circuiting on the first bad entry, so a
  `git.agentIdentities` map with three independent mistakes surfaces all three errors in one
  render/validate run instead of one per fix-and-retry cycle. Each individual message is
  byte-identical to before; only the multiplicity changed. Also renames the internal
  `compilePatterns` to `compileGuards` — it returns the `{ patterns, entryPatterns }` guards
  object, not a patterns Map. **Consumer impact:** error-output only; no config, schema, or
  rendered-file change, no re-render needed.
- **CI workflow identity aligned with the identity model (#160).** CI attribution was decided
  entirely by whichever token created the event, and the relationship was documented nowhere.
  The fix is deliberately *not* a `git config user.*` step in the workflows: `git.botName` /
  `git.botEmail` carry placeholder defaults, so pinning an identity in a workflow would impose a
  fake bot on every consumer who never opted in. **The no-clobber rule extends to CI.**
  The model, now written down in the github-workflow setup note as **"CI identity — token vs. git
  config"**: the *event* identity (PR/comment/tag author) is decided by the **token**
  (`WAFFLE_HYGIENE_TOKEN` / `WAFFLE_RELEASE_TOKEN`, else `github.token` → `github-actions[bot]`,
  which triggers no further workflows); the *commit* identity is decided by the resolved
  **`git.cmd`** in the committed, rendered git-workflow skill — which wins because `git -c`
  outranks the **repo-local** config the pinned dispatcher writes on every run (`git config
  user.name "claude[bot]"`, its `bot_name`/`bot_id` defaults). So an opted-in repo's CI commits
  have carried the bot identity since #155, with nothing further to configure; a repo on a bare
  `git.cmd` commits as **`claude[bot]`**, not as the runner. The note also splits the two
  precedences the toolkit must avoid: a `git config user.*` step *loses* to `git -c` (but
  clobbers a bare repo), while a `GIT_COMMITTER_*` env var *beats* it. Making the *PR* show the
  bot requires the PAT to belong to the bot account; the toolkit cannot configure that.
  One behavioral change: **`waffle-label-hook`'s implement job now dispatches with
  `github_token: ${{ secrets.WAFFLE_HYGIENE_TOKEN || github.token }}`**, matching hygiene and
  pr-response — so implement PRs are authored by the same account as hygiene PRs and trigger the
  repo's required CI. **Consumer impact:** no-op for repos without the secret. Repos that *have*
  it should read the blast-radius note, now spelled out in the setup note — with the secret set the
  job's `permissions:` block no longer bounds the run (it scopes `github.token` only), the
  attacker-authored issue body reaches the harness prompt, and the dispatcher writes the token into
  `.git/config`. Use a GitHub App installation token or a **repo-scoped fine-grained PAT**; a
  classic PAT turns applying a label into an account-wide escalation. The harness-driven workflows carry
  identity-neutrality design comments, and the release hook's lightweight tag (which stores no
  tagger identity at all) is pinned by test against an `-a`/`-m` upgrade.
- **A defined signing model for bot and agent authors (#158, closes the #153 epic's last gap).**
  The toolkit configured no signing, so `git.cmd` — which overrides the identity and *nothing else* —
  left `commit.gpgsign` ambient. On a signing machine that meant a bot-authored commit signed with
  the **human's** key (GitHub says "Verified", vouched by the human), and a *prompting* signer
  (1Password's SSH agent, a passphrase-guarded GPG key) hung the non-interactive agent commit
  outright. Both are strictly worse than an unsigned commit. Resolved as **prose, not a new engine
  key**: `git.cmd` already *is* the composed-flags surface, so the model is a resolution rule plus
  three named recipes.
  **The rule: the recipe owns the signing posture; keys own key selection.** `git.cmd` decides
  whether and how commits are signed, for the bot and every agent derived from it; a per-agent
  `git.agentIdentities[<agent>].signingKey` appends `-c user.signingkey=` *after* the base flags, so
  git's last-wins `-c` semantics make it the effective key **only when the base recipe signs**. Under
  the canonical recipe it is **deliberately inert** — one map leaf never overturns a project-wide
  "do not sign".
  **The canonical opt-in recipe now pins the posture** (recipe A, deliberately unsigned):
  `git -c commit.gpgsign=false -c user.name="{{git.botName}}" -c user.email={{git.botEmail}}` — a
  no-op where nothing signs, and prevention of both failure modes where something does. Recipes
  **B** (SSH: `commit.gpgsign=true` + pinned `gpg.format=ssh` + `user.signingkey`) and **C** (GPG)
  are documented upgrades that *reference* `git.signingKey`, which is why that key stays out of the
  default recipe (its empty default would render `git -c user.signingkey=`, which git rejects only
  when the command signs — loudly under B/C, silently tolerated under a non-signing recipe). Both
  require a **non-prompting signer**; the surrounding plumbing (`gpg.ssh.program`,
  allowed-signers, pinentry) is named as a machine concern, not prescribed.
  **Verified status is now intentional and documented.** An unsigned commit shows **no badge**
  (neutral); a signed-but-unverifiable one shows the yellow **"Unverified"** — so recipe A yields
  cleaner history than signing with a key GitHub cannot check. A verification matrix in the
  github-workflow setup note covers all three tiers, including the honest trade-off with #157:
  making sub-agent commits Verified means registering each `bot+<slug>@…` alias on the bot account,
  which relinks every agent to one profile and one avatar — **per-agent avatars XOR verified
  sub-agent commits** — and a repo with **required signatures** branch protection cannot use
  plus-addressed sub-agent authors at all.
  **The non-interactive stall is closed at the guardrail, not by bypassing signing.** The rendered
  `git.cmd` *is* the project's explicit, committed, reviewable posture: the git-workflow skill now
  forbids deviating from it per-invocation **in either direction**, and the delegate skill instructs
  a spawned agent whose commit hangs on a signing prompt to **stop and surface it** rather than add
  `-c commit.gpgsign=false` itself.
  **Consumer impact: none — no config keys added or removed, no engine change, `git.cmd`'s bare
  default untouched.** Re-render picks up the reworded git-workflow / delegate skills. Projects
  already on a bot identity should add `-c commit.gpgsign=false` to their `git.cmd` (or adopt recipe
  B/C); the old recipe still renders, it just leaves the posture ambient.
- **Shipped agents no longer pre-pin a model (#287).** The `model:` frontmatter key is removed from
  all seven agents that carried one — `lead-engineer` (was `opus`), `data-engineer`, `devops-engineer`,
  `qa-engineer`, `ux-designer`, `product-manager` (each `sonnet`), and `task-planner` (was `haiku`).
  The toolkit should not choose a model tier on the consumer's behalf: the pin decides both **cost**
  and **capability**, the model lineup churns faster than the toolkit releases, and a stale pin
  silently overrides the model the consumer picked for their own session. Agents now **inherit the
  session model**, which is the harness default. `claude.model` remains a fully supported passthrough
  key — a consumer who *wants* a pin can still set one; the toolkit simply stops making the choice for
  them. #287 tracks dynamic model routing as the real answer. A content test
  (`installer/test/content.test.mjs`) now pins the invariant by sweeping every `stacks/*/agents/*.md`
  off disk, so a new agent cannot quietly reintroduce a pin.
  **Consumer impact:** behavioral/minor — no migration, but **read this before you re-render**, because
  the effect is not uniform and it is invisible in the diff. Each affected agent moves from its pinned
  tier to whatever model your session runs, so the change cuts **both ways**:
  - **Cost** — `task-planner` was pinned to `haiku`, the cheapest tier. On an Opus session it now runs
    on Opus. If you invoke the planner frequently, expect its per-call cost to rise.
  - **Capability** — `lead-engineer` was pinned to `opus`, and it is the agent that sets technical
    direction, gatekeeps dependencies, and reviews non-trivial changes. On a Haiku or Sonnet session it
    now runs on that weaker model.

  If either tier mattered to you, the way to get it back is `wafflestack eject agents/<name>`: the
  rendered file stays in place and becomes project-owned, so you can set `model:` on it yourself (in
  exchange, it stops receiving toolkit updates). A `.waffle/extensions/` file will **not** do it —
  extensions are appended to a rendered item's *body*, so they cannot override frontmatter. A repo that
  commits its render will see a diff where the `model:` line disappears from each affected agent.

### Fixed
- **PR-gate skills staged their payloads in shared `/tmp` paths — one PR's review could post onto
  another (#324).** `qa`, `adversarial-review` and `pr-response` each wrote their review/reply payload
  to a **fixed, un-namespaced** path (`/tmp/qa-review.json`, `/tmp/qa-summary.md`,
  `/tmp/adversarial-review.json`, `/tmp/adversarial-review-summary.md`, `/tmp/pr-response-body.md`) and
  handed that path straight to `gh` as `--input`/`--body-file` — so whatever sat on disk at that instant
  is what got **POSTed to GitHub**. Nothing in the path identified the PR, the run, or the session, so
  every invocation across every PR reused *the same five files*. The benign failure is a stale leftover:
  during the autopilot run on #316/PR #321, the `qa` gate found `/tmp/qa-review.json` already holding a
  review payload from an earlier run on **PR #285**, one step from being posted to #321 under the
  `<!-- waffle-qa -->` marker — indistinguishable from a legitimate gate review, and picked up as such by
  `pr-response`'s triage. Only the agent's own read-before-post habit caught it. The sharper failure is a
  **live race**: `autopilot` runs these gates *per PR, concurrently across a parallel group*, so two gates
  interleaving a write and a `gh --input` on one path can post **PR A's findings onto PR B** — and the
  loser never knows. Those findings then drive `pr-response`'s implement/defer/decline verdicts, so the
  wrong review silently steers the wrong PR's code. All five paths are now namespaced by PR number
  (`${TMPDIR:-/tmp}/waffle-<skill>-<artifact>-$N.<ext>`; `$N` was already in scope at every call site), so
  two concurrent gates can never touch the same file. Each skill now also carries the **read-back rule**
  the near-miss depended on as a lucky habit: `Read` the exact file you are about to post, confirm it is
  this PR's payload (marker + findings matching this diff), and **stop rather than post** if it is not.
  Each also warns that the `Write` tool does **not** expand `$N`/`${TMPDIR:-/tmp}` — pass it a literal,
  already-substituted path. Every documented `gh` command stays single-line and allowlist-matchable.
  *Consumer impact: re-render; the three skills' staging paths and post procedure changed.*
- **Every `delegate` specialist was mute — told to report back with tools it was never granted.**
  `delegate`'s routing table names exactly three specialists — **`harness-architect`**, **`docs-agent`**
  and **`docs-human`** — and its agent-prompt template closes by telling each of them to report with
  `SendMessage(to: "team-lead", …)` and to mark its work done with `TaskUpdate(taskId, status:
  "completed")`. **None of the three was granted either tool.** So a delegated specialist finished
  **silently**: it could not hand back its PR URL, could not close its task, and could not answer the
  orchestrator's `shutdown_request` at teardown. The skill had grown a whole *"Silent specialists"*
  section instructing the orchestrator to go verify the branch by hand — a documented workaround for a
  capability the agent should simply have had. This is the same defect #303 fixed for the `issue`
  skill's callers, one layer down: **naming an agent in-scope for a protocol it provably cannot
  execute is the bug.** It is not cosmetic — a delegated run stalled with its work complete but
  uncommitted and no way to say so, and the orchestrator only noticed by polling the worktree. All
  three now grant `SendMessage` + `TaskUpdate`; a content test pins delegate's roster against its
  toolset so the two cannot drift apart again. Deliberately *not* granted: `TaskCreate` (a worker does
  not open work — that is `task-planner`'s job) and `TaskList`/`TaskGet` (the orchestrator injects the
  task id; a worker has no business browsing the board).
  **Consumer impact:** re-render to pick it up. Delegated specialists now report their PR and close
  their task instead of finishing silently — an orchestrator no longer has to poll the branch to learn
  whether they succeeded.
- **The lock hashed the render your overlay produced, so private values propagated (#317,
  superseding the #308 way-station).** `.waffle/waffle.local.yaml` is a developer's private tooling:
  gitignored, per-machine, absent in CI. It leaked anyway. `render` wrote
  `.waffle/waffle.lock.json` as a hash manifest of the **effective** render — overlay substitutions
  already baked in — so any overlay value that fed a template was fingerprinted into a **committed**
  file. Two teammates with different personal `git.botEmail` overrides produced **different**
  committed lock hashes for the same source, and each one's commit reverted the other's; the loser's
  `doctor` went red. Gitignoring the render did not help — the renders stayed private and the locks
  still diverged. Committing the render was worse: the personal address landed literally in git, and
  a teammate who pulled without re-rendering had their agents commit under the *renderer's* identity.
  **The lock now records the CANONICAL render** — what the committed `.waffle/waffle.yaml` +
  `.waffle/extensions/` produce **on their own**, with the overlay excluded. `render` computes both:
  the *effective* render (config + overlay) is what lands on your disk, so your working copy still
  carries your values; the *canonical* render is what is hashed into the lock. Canonical means
  *everything committed*, so **extensions still propagate** — that contrast with the overlay is the
  whole design. Every consequence follows: every developer's committed lock is **byte-identical**;
  `doctor --verify-render` reproduces it in CI and goes **green** (it renders the same committed
  inputs the lock records) instead of refusing to answer; and **nobody is red-gated into committing a
  personal value**. Where the two renders diverge, the effective hashes go to a new **gitignored**
  `.waffle/waffle.local.lock.json`, which `doctor`/`list`/`render`'s prune-and-clobber bookkeeping
  read in preference to the committed lock — so a hand-edit to a rendered file is still caught
  locally (integrity is not relaxed, it is measured against the render you actually have), while the
  committed lock stays canonical. It is created only when the overlay changes an output byte and
  removed when that stops. One value may no longer hide in the overlay: a **`required:` key with no
  `default:`**, since the canonical render must be buildable from committed inputs — `render` now
  fails loudly and names the key rather than silently substituting a default. (`git.botEmail` is
  `required: false` with a default, so the canonical render simply uses it — the correct answer.)
  This supersedes #308's `lock.renderedWithLocalOverlay` flag and doctor's `cannot verify the render:`
  refusal, both removed: with a canonical lock there is nothing ambiguous left to refuse.
  **Consumer impact:** **what the lock records has changed.** If a render-affecting value lives in
  your `.waffle/waffle.local.yaml`, your next `render` rewrites `.waffle/waffle.lock.json` with the
  canonical hashes — commit that diff once, and every teammate's lock agrees from then on. Add
  `.waffle/waffle.local.lock.json` to `.gitignore` (`render --gitignore` does it; `render` warns if
  you haven't). A repo with **no** overlay, or one whose overlay holds only values the render never
  reads, is **entirely unaffected**: same lock, same render, no new file. The #308 guidance to commit
  the values your render reads so CI would stop complaining is **withdrawn** — you no longer need to,
  and you never should have had to. Two things remain true and are now stated plainly: a
  render-affecting overlay means you should **gitignore the rendered output** (a committed file with
  your personal address inside it *is* propagation — that is
  [Posture 2b](docs/gitignore.md#posture-2b-commit-the-lock-only)), and a `required:` defaultless key
  must be committed with *some* value (your overlay still overrides it locally, for you alone).
  See [`docs/gitignore.md`](docs/gitignore.md#your-private-overlay-stays-private--and-the-gate-still-works).
- **`doctor --verify-render` reported a missing gitignored input as drift, and told you to commit
  the damage (#308 review, follow-up to #314).** *(Superseded by #317, above — the
  `renderedWithLocalOverlay` flag and the `cannot verify the render:` refusal it describes were
  removed once the lock became canonical. Kept for the record of what the bug was.)*
  `--verify-render` reproduces the render from the
  **committed** inputs — and `.waffle/waffle.local.yaml` is not one of them: it is gitignored by
  design, so it does not exist in a CI checkout. But the lock was rendered on a machine where it
  *did*. Reproducing the render without it silently substituted the stack `default:` for every
  overlay-held value (`git.botEmail` is `required: false` with a default, so nothing errored), and
  every file the overlay touched came back **`stale`** — for a repo that had changed nothing. Worse
  than a false red: the remediation it printed, *"re-render and commit the result"*, would have baked
  `bot@wafflenet.io` over the repo's real bot identity. And it broke the exact posture #314 exists to
  enable — a lock-only repo following the prescribed layering (`schema/SETUP.md`: account-specific
  `git.botEmail` / `git.signingKey` in the overlay) got false drift from the one gate available to
  it. The lock now records **`renderedWithLocalOverlay`** when the overlay actually *fed* the render,
  and `doctor` refuses the question rather than answering it wrong: a specific `cannot verify the
  render:` error naming the missing input, and **no drift at all**. A missing input is not drift.
  The flag turns on the overlay's *contribution*, not its presence — an overlay holding only values
  the render never reads (a board id, a local path) leaves the lock **byte-identical** to a machine
  with no overlay, so the presence of a gitignored file never leaks into committed content. It counts
  a key reached only through **nested substitution** (`git.cmd: … {{git.botEmail}}`) — which is how
  the hazard actually arises, and which a scan of the template bodies alone cannot see.
  **Consumer impact:** none — this shipped in the same release as #317, which supersedes it. The
  "commit the values your render reads" trade it asked for is **withdrawn**; see #317 above for what
  actually landed, and [`docs/gitignore.md`](docs/gitignore.md#your-private-overlay-stays-private--and-the-gate-still-works).
- **`pr-response` overwrote its own verdict history (owner report, found while running the skill on
  #308).** The skill's "Idempotency" section told
  the responder to find its last marked `<!-- waffle-pr-response -->` comment and **`PATCH`** it, so
  that "a second run leaves one comment carrying the current, complete verdict table." Following that
  instruction **destroys the paper trail**: round 2 silently replaces round 1, and the record of what
  was found, what it scored, and why it was disposed of *at the time, on the evidence then available*
  is gone. That record is the entire product of the skill — the rubric exists to make judgment legible
  and **recalibratable**, and you cannot recalibrate against verdicts you have deleted. It also made
  the skill's own cold-start rule incoherent: it says to read the prior reply as *history*, while step
  6 said to overwrite it. Each round now **appends** a new comment, labelled with its round and the
  head SHA it answers; the marker stays (it is how a cold start recovers verdict history and continues
  the F-numbering across rounds) but marked comments are now **read-only history** — read them all,
  oldest first, and write only new ones. A verdict that genuinely changes is stated in the new comment
  with the new evidence named, never retconned into the old one.
  **Consumer impact:** re-render to pick it up. `pr-response` now leaves one comment per round instead
  of one per PR — expect the comment count on a multi-round PR to grow, which is the point.
- **The cold-start seeding rule collided with the cap hatch's deliberately-cold pass (#301,
  follow-up to #297).** The gate reviewers (`qa`, `adversarial-review`) triggered their history
  seeding on an **inference from absence** — "no in-context history ⇒ you are a vanished-agent
  re-spawn ⇒ seed from the PR" — and that inference is **false** on a path `autopilot` itself
  specifies: the cap escape hatch spawns its fresh evidence pass **unnamed and deliberately cold**,
  with the same bare skill invocation, precisely so it is *not* anchored by what earlier rounds
  declined. Neither spawn can see its own `name:`, so a hatch pass obeying the rule seeded the
  verdict table and suppressed every declined finding — the exact anchoring the cold spawn exists
  to escape. The signal is now **invocation-carried, never inferred**: the reviewers seed *only*
  when told they are replacing a vanished loop agent, an empty context explicitly is **not** the
  signal, and `autopilot`'s prompts now carry both directions — its re-spawn prompt says *"you are
  replacing a vanished loop agent — seed your history from the PR before reviewing"* (for reviewer
  **and** responder), and both cap hatches say *"this pass is deliberately cold — do not seed"*.
  `pr-response`'s own cold-start rule is deliberately **unchanged** — no responder ever follows a
  hatch pass, so a fresh responder always wants its history. Also fixes the bullets' scope, which
  sat under a "when resumed:" list yet govern a *first* invocation.
- **Six teardown glosses keyed responder existence on the wrong condition (#301).** `autopilot`'s
  spawn trigger says the responder exists when there are *untriaged findings on the PR*, "never
  merely *this round's reviewer surfaced some*" — but six glosses still explained teardown as "a
  zero-finding round 1 never [spawned] it" / "once a finding round spawned it". On a **hook-armed
  repo** a clean round 1 over an undisposed hook review **does** spawn a responder, whose
  `shutdown_request` a gloss-following agent would skip — re-creating the agent leak #297 fixed
  elsewhere. All six (plus the hook-armed note) now use the trigger's own vocabulary: "a round 1
  with **nothing to triage**" / "a round with **findings to triage**".
- **The responder's spawn trigger and both convergence tests were marker-scoped (#301).** They
  enumerated *marked* reviews only, so an unmarked **human** review with findings on an otherwise
  clean head converged the loop and **armed auto-merge over those findings untriaged**. The four
  clauses now key on **any untriaged review with findings** — its own, another gate's marked
  review, *or a human's* — matching the general-principle sentence they illustrate. Scoped to
  reviews that *carry findings* (a bare approval is not a trigger), and disposal is still read from
  the marked reply's **verdict table**, never from the reply's existence — `pr-response` already
  triages human findings and records them in that same table when it runs, so the widened spawn
  trigger needs no downstream change.
  **Consumer impact:** patch/prose-only. No installer, schema, or config change and no new config
  keys — a `render` picks up the three reworded skills (`autopilot`, `qa`, `adversarial-review`).
- **Four post-cap review findings from the `/issue` plan gate (#303, follow-up to #288/PR #302).**
  The gate is a safety feature, and the two substantive findings each let it be **silently skipped
  or silently diverged from** — the exact failure step 7e forbids. (1) `product-manager` was named
  one of three in-scope *interactive* callers that must run the plan phase and hand the gate up to
  the human, but shipped without `Bash` and without a `skills:` grant — so every plan-phase read the
  protocol demands of it (`gh label list`, the milestone list, the board resolve-queries) was a call
  it could not make, leaving it no legal way to fill the board-placement field the gate presents and
  no recovery but to re-invoke with `--yes` and apply a placement the human never saw. It now
  carries `Bash` and a `skills: [issue]` grant, matching its two peers on that list (`task-planner`,
  `project-manager`) — which also fixes a latent bug independent of the gate: its body already
  instructed it to file issues via the `issue` skill's `gh` mechanics that its toolset forbade.
  (2) The plan-phase read list cited the board resolve-queries as "Workflow steps 7a–7c" in both
  places it appears; 7a is a shell env-resolve and **7b reads the node ID of an issue that does not
  exist yet** in create mode. Both cites now name 7c, with 7a's env resolve as its prerequisite.
  (3) The `--yes` strip rule read as strip-*anywhere*, so `/issue the --yes flag in pr-response is
  ignored` — an ordinary filing in a toolkit where three skills carry that flag — would have its
  token eaten, its title mangled, and its gate skipped on a run where nobody asked to skip it.
  `--yes` is now stripped only as a **flag token** (unquoted, first or last position); a `--yes`
  mid-prose or in backticks is description text, reaches the title and body, and **still gates**.
  (4) Two `content.test.mjs` section guards asserted `section.length > 0` after a `slice(indexOf(…))`
  — unreachable, since `slice(-1)` returns the file's last character on a missing header; both now
  guard the index, so a deleted section fails with the right cause. New pins cover findings 1–3.
  **Consumer impact: re-render.** `product-manager`'s rendered toolset gains `Bash` and its
  dependency closure now pulls `skills/issue` (the same closure `task-planner`/`project-manager`
  already create); the `issue` skill's prose is corrected. No schema or engine change.
- **Five fresh-pass findings from the PR #250 signing model (#252, follow-up to #158).** Recipes
  A/B/C now pin the tag posture — `tag.gpgSign=false` (A) / `tag.gpgSign=true` (B/C) — everywhere
  they are quoted: the setup note, both stacks' `git.cmd` descriptions, the git-workflow skill's
  opt-in fence, the `wafflestack init` scaffold, `schema/SETUP.md`, and this repo's own config
  (`git.cmd`'s description scopes in an annotated tag; the recipe now owns that posture too
  instead of leaving it ambient). The "git rejects an empty signingkey" claim is corrected to its
  true conditional form in all three places it shipped — git rejects it only when the command
  signs, loudly under B/C, silently tolerated under a non-signing recipe. The per-agent
  `signingKey` ↔ pinned `gpg.format` constraint is now documented at the key (both stacks'
  `git.agentIdentities` descriptions) and in the delegate skill's signing-resolution rule — a key
  whose shape contradicts the base's pinned format fails that one agent's every commit at its
  first signature; the identity gate WARNs on the mismatch. The `[Unreleased]` section order is
  fixed to Added → Changed → Fixed, and the verification matrix's noreply row now answers
  "Verified attainable?" per tier instead of silently assuming B/C.
  **Consumer impact: guidance/recipe text only** — no engine change, no schema change; old
  recipes still render (the #254 pattern admits both old and new forms). Projects on a bot
  identity should add `-c tag.gpgSign=false` (A) or `-c tag.gpgSign=true` (B/C) to their
  `git.cmd`; a re-render picks up the reworded git-workflow/delegate skills.
- **`git.cmd` now carries its own allowlist `pattern:` in both declaring stacks (#254, deferred
  F5 from #253's review).** The value is spliced verbatim into shell command literals in rendered
  skill text — the git-workflow/release commit instructions and the delegate identity preflight's
  single-quoted `--git-cmd '{{git.cmd}}'` — but the existing quote guards protected only the
  identity keys composed *inside* it, so a plain `.waffle/waffle.yaml` value like
  `git -c user.name=Bot' ; touch /tmp/PWNED ; '` rendered every file with no error. Both
  `stacks/github-workflow/stack.yaml` and `stacks/orchestration/stack.yaml` now declare a
  byte-identical (lockstep-pinned) pattern: letters, digits, spaces,
  `=` `.` `_` `/` `~` `+` `:` `@` `%` `[` `]` `-`, balanced `"…"` runs (`"` is structural, not a
  free character — an unbalanced quote would pair across the splice and silently corrupt the
  rendered command example), and whole `{{key}}` placeholder tokens — the guard tests the
  *expanded* value per render site (pinned through an unguarded nested key), and an
  orchestration-side nested miss
  survives as a literal `{{git.botName}}`, which must pass. `'`, backtick, `$` (everywhere,
  including `${{ … }}`), `;`, `&`, `|`, `<`, `>`, `\`, newlines, unbalanced quotes and the
  empty string are
  rejected; the delegate tokenizer's no-single-quote assumption is now enforced at render time,
  and the SKILL.md preflight note plus the identity.mjs comment say so instead of disclaiming it.
  **Consumer impact: a narrowed `git.cmd` contract.** The stock recipes A/B/C, the bare default,
  and every value the setup note documents all pass; a repo whose `git.cmd` uses characters
  outside the allowlist (env-var prefixes, `$HOME`, parentheses, subshells) now **fails the
  render** with an error naming the pattern and both declaring stacks — intended tightening, as
  such values already broke or subverted the rendered shell literals they land in.
- **Four identity/avatar guard findings from the PR #248 fresh pass (#249, follow-up to
  #157/#248).** All four sit on the #156/#157 identity surface; two are trust-boundary
  hardenings of the same guard-and-consumer-drift class #247 tracks. **F1:** `withIdentity`
  interpolated the display name and email into `String.replace` **replacement strings**, where
  `$&`/`$1`/`` $` `` re-expand — a `$&`-bearing email duplicated the `-c user.email` flag, so
  the smoke test committed under a different address than the manifest advertises. Both swaps
  now use replacement *functions*, immune regardless of value (latent, not reachable through
  validated config today: the `botEmail` guard excludes `$` — but the swap must be safe on its
  own). **F2:** with **every** agent's email overridden via `git.agentIdentities`, the AVATARS.md
  registration section still claimed the "derived addresses above land in" the base inbox — over
  an empty derived set, with a sign-in step naming an inbox no agent commits under; exactly the
  state the shared-address caveat's own remedy produces. The copy now distinguishes three states
  (no overrides renders byte-identically to before; the mixed state scopes its sign-in
  parenthetical to "every derived address" — per the PR #262 review, a separately-owned `‡`
  inbox is not covered by the base account; all-overridden gets honest copy: every address is
  verbatim, each verified at the inbox that receives its mail). **F3:** a
  literal raw NUL byte in `waffledocs.mjs` made ripgrep classify the file as binary and silently
  skip it — every `rg` over `installer/lib/` missed the file. Now the two-character `\0` escape
  (identical runtime string), plus a control-byte lint in `validateToolkit` that scans
  `installer/` and `stacks/` text sources (`.mjs/.md/.yaml/.yml/.json/.sh` — `.sh` added per the
  PR #262 review; the scanned roots ship one shell script) for control bytes other
  than tab/LF/CR, so the regression class fails `npm run validate`. **F4:** `IDENTITY_AVATAR_RE`'s
  URL alternative admitted `@`, so a userinfo authority (`https://good.tld@evil.tld/x.png` —
  displayed host ≠ fetch host) passed the guard its own comment enumerates as strict. The class
  now excludes `@` entirely (deliberate tightening: also blocks `@` in URL paths; nothing in the
  avatar contract needs it), a `(?!.*%40)` lookahead closes the percent-encoded form the class's
  own `%` would otherwise smuggle through (#262 review), and the rejection message names the new
  rule. **Consumer impact:** no config or schema change. Rendered-file change only for a project
  in the mixed-overrides state (one reworded AVATARS.md line — re-render at leisure); every other
  state, including this repo's, renders byte-identically (verified: the lock is byte-stable
  across a re-render). A pre-existing `identity.avatar` URL carrying `@` or `%40` would newly
  fail validate — which is the point.
- **The agent slug is now guarded at the identity trust boundary, and the duplicated
  `entryPatterns` are pinned in lockstep (#247, follow-up to #156/#245).** The delegate skill
  splices TWO values into the same agent-executed `git -c user.name="…" -c user.email=…` command:
  `identity.displayName` was policed by `validateStack` (and by `validateExternalStacks` at render
  for third-party stacks), but the agent slug beside it — the agent's filename — was checked
  nowhere, despite reaching the command always (as the `bot+<slug>@…` plus-address) and, when
  `displayName` is absent, as the title-cased `user.name` fallback that the displayName allowlist
  never sees. `validateStack` now rejects any agent whose name falls outside `[A-Za-z0-9._-]+`
  (with at least one letter or digit — a separator-only slug like `---` title-cases to an empty
  `user.name`), unconditionally (not gated on an `identity:` block), closing the asymmetry for
  both the toolkit's own `validate` and the external-stack render gate. Per the PR #260 review,
  `loadStack` also rejects `agents:`/`skills:` manifest entries carrying path separators or dot
  segments *before* the first `path.join` — previously a traversal entry like `../../secret` was
  dereferenced as a path at load, reading outside the toolkit root before any guard ran (`files:`
  entries always had this load-time check; agent/skill names now do too). Separately, the
  byte-identical `git.agentIdentities.entryPatterns` declarations in `github-workflow` and
  `orchestration` are now pinned deep-equal by a test, so a one-sided edit fails the test suite
  instead of silently weakening the guard in single-stack installs (note the pin binds where the
  suite runs — locally and in any consumer's checks; the toolkit's own merge path currently gates
  on `doctor` only), and the orchestration lockstep comment now names the loosening hazard, not
  just the tightening one. **Consumer impact:** validate/load-time errors only — every shipped
  slug already conforms; no config, schema, or rendered-file change, no re-render needed.
- **Pattern-guard rejections now name the declaring stack and the failing pattern (#244, engine).**
  `pattern:` / `entryPatterns:` guards are unioned toolkit-wide (deliberately — the guard travels
  with the KEY; see the #155-review entry below), which meant a stack the project never installs
  could veto a config value with an error naming neither the stack nor the regex. Rejections now
  append `` `<pattern>` (declared by stack "<name>") `` for every guard the value fails — failing
  guards only, never ones it satisfies, on both the scalar and `entryPatterns` paths (one shared
  filter serves both) — and the reserved `harness.*` guards identify themselves. The pattern is
  backtick-delimited (shipped regexes end in spaces and groups that would otherwise abut the
  attribution), and identical patterns declared by several stacks are grouped, printed once with
  their sources joined. The multi-stack AND ("a key guarded by more than one stack must satisfy
  all of its patterns") was previously untested since no shipped key is dual-declared with
  differing regexes; a two-stack fixture test now pins it on both paths (the byte-identical
  `entryPatterns` dual-declaration is live: `git.agentIdentities` in `github-workflow` and
  `orchestration`). The #155 entry's "no behavior
  change" consumer-impact claim is corrected in place to the narrowed-contract statement it should
  have made. **Consumer impact:** error messages only — no config or schema change, no re-render
  needed.
- **Config `pattern:` guards are compiled toolkit-wide, not per stack (#155 review, security).**
  `render` compiled each stack's `pattern:` guards while rendering *that stack's* items, so a guard
  only applied where its declaring stack happened to be installed. Only `github-workflow` declares
  `git.botName` / `git.botEmail`, so an **orchestration-only** install — the configuration
  `orchestration`'s own `git.cmd` description steers users into — spliced *unvalidated* project
  config into an agent-executed shell command: `botEmail: "$(id)@x.com"` and a quote-breaking
  `botName` both rendered `ok=true` into `delegate/SKILL.md`, while the identical values were
  rejected the moment `github-workflow` was co-installed. Guards now compile once across every
  stack, so a guard travels with the **key**; a key guarded by more than one stack must satisfy all
  of its patterns. **Consumer impact:** a render that was silently accepting a value violating a
  guard declared in a stack you do not install will now fail loudly — which is the point. No
  conforming config changes behavior.
- **`waffle-post-merge-hook` — broaden the undeletable-branch warning.** The `else`-branch
  `::warning` (and its matching comments) now name a transient API error (5xx / rate-limit / network)
  alongside "protected" and "missing `contents: write`", since that branch also fires when the ref
  still exists after a flaky delete. Message-only; no behavior change (#189 review nit).
- **PR-green hook could never post its review (#188, `github-workflow` + `code-quality`).** The
  `waffle-pr-green-hook` dispatch prompt asks the harness for single-program commands so the CI
  allowlist can match them, while `adversarial-review` instructed a `gh api … --input - <<'EOF'`
  **heredoc**. A multi-line command never matches a `Bash(gh api:*)` prefix, so on the hook's first
  live run every delivery call was denied and the completed review was thrown away. Three changes:
  `adversarial-review` now stages its payload with `Write` and posts single-line
  (`gh api … --input <file>` / `gh pr review … --body-file <file>`) and emits the
  `<!-- waffle-adversarial-review -->` marker itself rather than relying on the workflow prompt to
  inject it; the hook's allowlist gains `Write` (mandatory — a multi-line review body needs a file,
  and nothing else could create one) plus read-only `git log`/`diff`/`show`/`status`; and the
  `Check harness result` guard now **verifies delivery against the API** — it asks GitHub whether a
  marker-carrying review exists on the head commit — instead of guessing from the harness's
  free-form final text. A denied read-only call no longer reds a run that demonstrably posted, and
  a run that did *not* post still fails. Sandbox escapes remain unconditionally red, never
  downgraded. Fail-closed: an API error is never read as proof of delivery.
  - **Consumer impact:** re-render. Nothing to configure; `Bash(git:*)` is deliberately still
    excluded, as the job holds `contents: read` only.

- **Coherence holes in the persistent-gate-agent playbook (#297, follow-up to #295).** #295 made each
  gate loop's responder spawn **lazily** (only once a review surfaces findings), but three statements
  in autopilot's Steps 5/6 still assumed it always exists — so a zero-finding round 1 was told to
  `shutdown_request` an agent that was never spawned and to read convergence from a `pr-response`
  return that never happened. Teardown is now scoped to **each agent the loop actually spawned**, and
  the reviewer's own clean summary ("no QA concerns" / "no holes found") is named as the stop signal
  when no responder ran. The `qa` and `adversarial-review` skills gain the **cold-start recovery rule**
  #295 gave `pr-response`: a reviewer re-spawned cold by autopilot's vanished-agent fallback now seeds
  its finding/verdict history from the PR's own marked reviews and the `<!-- waffle-pr-response -->`
  verdict table instead of re-raising every settled finding. Both cap hatches' fresh evidence pass is
  now specified as **unnamed** (it runs once and is never resumed, and the standing agent still holds
  the gate name until its deferred teardown). The lazy spawn's trigger is scoped to **untriaged
  findings on the head**, with disposal read from the marked `<!-- waffle-pr-response -->` reply's
  **verdict table** rather than from the reply's mere existence (one reply is PATCHed in place across
  rounds, so it exists as soon as any responder has run) and *when in doubt, spawn the responder* as
  the tie-break — so a clean round over a head still carrying another gate's untriaged findings, such
  as the QA cap hatch's un-triaged evidence pass, cannot converge and arm a merge over them. Both
  teardown lists (item 3 and Failure handling) now name the **spawned set** rather than a fixed pair:
  a never-green PR stops before round 1 and spawned neither agent.
  - **Consumer impact:** re-render. Prose-only; no config, no behavior change to the gates' contracts.

- **Restored the orthogonal docs-craft split — docs-human no longer carries `accurate` (#299).** A
  fix round in #224 granted `accurate` to **docs-human** as well as docs-agent, to counterweight
  `prose` §5's "quantify claims" (which pushes a writer toward paths, counts, and numbers — the most
  fabricable claims there are). The concern was real but the remedy conflated a **writing value**
  (don't invent specifics — one clause, every writer needs it) with a **verification protocol**
  (`accurate`'s per-claim machine-doc craft). The grant is removed from both load-bearing sites —
  frontmatter `skills:` and body prose — and the counterweight now lives **natively in `prose` §5**
  ("Concrete over abstract — *from a source*": sourced numbers only; a specific you didn't read
  somewhere is fabrication wearing concreteness's clothes; omit it rather than guess). docs-human is
  not thereby licensed to be inaccurate — its accuracy is **provenance, not protocol**: as "a
  derivative of docs-agent", its specifics come from the already-verified machine docs or a file it
  actually read, stated as a new body clause. `accurate`'s description and opening are sharpened to
  name **machine-legible accuracy** ("can an agent act on this without judgment?") as docs-agent's
  craft standard, the way `md-maximalist` is docs-human's; it stays `user-invocable`, so `/accurate`
  remains available ad hoc on any doc, docs-human's included. The `AGENTS.md` docs-system row records
  the rationale so the grant is not re-flipped.
  **Consumer impact:** additive/minor. Pure stack authoring — no installer, schema, or config change.
  A `render` picks up the reworded skills and the docs-human agent; a repo that commits its render
  sees a diff where docs-human's `skills:` list loses `accurate`. No migration required.
- **`skills/prose` now declares its `requires:` edge on `skills/md-maximalist` (#299).** `prose` §4
  delegates form choice to `md-maximalist` **by name**, but no dependency edge existed — so a
  standalone `waffle-install docs-system/skills/prose` rendered a live pointer to a skill the project
  did not have. The `docs-system` stack now declares `requires: skills/prose → skills/md-maximalist`
  (mirroring `orchestration`'s `skills/docs` precedent).
  **Consumer impact:** none for whole-stack installs — `docs-system` already lists both skills, so
  nothing new appears in an existing render. A **single-item** `skills/prose` install now also pulls
  `md-maximalist` (one extra skill file), which is the point.

## [0.11.0] - 2026-07-08

### Consumer impact
- **New capability, additive — third-party stacks: pull a stack from a pinned git source or a
  local path (#88, #124–#127).** A `stacks:` entry in `.waffle/waffle.yaml` may now be **either** a
  bare built-in name (unchanged) **or** a `{ name, source, ref }` mapping pointing at an external
  toolkit — a git URL (pinned to a **required** `ref`) or a local filesystem path. External sources
  are resolved and merged into one registry, so a **single render / lock / `doctor` / `upgrade`
  pipeline handles built-in and external stacks alike**. Provenance is recorded in the lock (a
  `sources` block), `doctor` attributes any drift to its source, and `upgrade` re-resolves each pin
  and reports commit moves. External stacks are lint-validated **before any byte is written**, and
  pouring their opt-in syrup asks for an extra trust-boundary acknowledgement. **Purely additive** —
  a repo using only built-in names renders byte-identically (the `sources` lock block is omitted when
  empty), and `list`/`setup` still operate on the built-in surface only. Authoring guide:
  `schema/AUTHORING-EXTERNAL-STACKS.md`.
- **Additive; no re-render diff, but `doctor` now checks prerequisites, `setup` surfaces them, and
  the CI dispatcher is now repointable (#129/#130/#131).** The typed `prerequisites:` block does not
  render into any file, so a re-render produces no output/lock change. A repo that runs
  `waffle-doctor.yml` (or `wafflestack doctor`) will, on its next run, start verifying the selected
  stacks' declared prerequisites — an unmet `require` fails the check. The seeded `require`s are only
  `command -v node/git/gh` (present on any CI runner and dev machine); everything
  environment-specific is `recommend` (reports, never fails), so a correctly-set-up repo stays green.
  An existing `env:` map is unchanged. `setup` now lists each stack's prerequisites by kind and flags
  unmet `require`s as blockers in update mode (#130). Three reserved `harness.*` keys
  (`harness.actionRef` / `harness.actionVersion` / `harness.apiKeySecret`, #131) let a consumer pin a
  different action version or rename the billing secret **without ejecting** the rendered CI
  workflows; the built-in defaults reproduce today's pinned action byte-for-byte, so an unconfigured
  repo's render/lock is unchanged.
- **New CLI command, additive — `list` (#119).** `wafflestack list` prints an aligned, agent/CI-safe
  plain-text table classifying every stack and item **installed & current** / **out of date** / **not
  installed** (`--no-color`/`NO_COLOR` honored); `--interactive` (real TTY) drives a keypress
  multi-select — out-of-date items pre-checked — that installs/updates the chosen refs and re-renders.
  Read-only by default; no render/config change and no new dependency. CLI command count 8 → 9.
- **Re-render to pick up — full codex/agents-dir target coverage closes the render asymmetry (#94).**
  Previously `codex` got agents but no skills and the cross-tool `.agents/` dir got skills but no
  agents; now **every target renders both**. A consumer rendering the `codex` target gains its stack's
  skills (in the `.agents/skills/` dir Codex already scans), and one rendering `agents-dir` gains
  agents as neutral Markdown at `.agents/agents/<name>.md`. Re-render adds those files; no config
  change, no migration. Repos rendering only the `claude` target are unaffected.
- **Opt-in — enable/upgrade `code-quality` and re-render for two new skills, now project-agnostic
  (#112/#116/#117).** `adversarial-review` (`/adversarial-review <PR#>`, defaults to the current
  branch's PR) reviews a finished, CI-green PR from a hostile reviewer's seat — correctness edge
  cases, error handling, test depth, API/naming, simplification — and posts an honest-severity review
  (blocker / should-fix / nit), where "no holes found" is a valid outcome; distinct from the built-in
  `/code-review`, which reviews the author's *uncommitted* diff. `dry` (`/dry <path>`) removes genuine
  duplication under rule-of-three and semantic-sameness guardrails. Neither adds config keys. The
  stack also shed its Obsidian/Synapse-specific assumptions, so it now drops cleanly into any project
  (#117). **The PR-green auto-trigger now ships** as opt-in syrup in `github-workflow`
  (`waffle-pr-green-hook.yml`): it dispatches `adversarial-review` the moment a PR's required checks go
  green (once per green transition, deduped by a review marker), and can render just the one skill via
  the qualified `code-quality/skills/adversarial-review` ref alongside the workflow. This repo now
  dogfoods both. A repo that doesn't enable `code-quality` (or install the workflow) is unaffected.
- **Additive, opt-in, default-off — the autopilot backlog runner and its two delegate opt-ins
  (#98/#99/#100/#101).** The new `autopilot` orchestration skill composes `delegate` + `clean-up` +
  `git-workflow` into an unattended per-issue **plan → implement → PR** loop; every run captures an
  explicit issue scope and a fresh, never-sticky auto-merge consent, and its guardrails never push to
  `main`, never `--admin`-merge, and always leave a PR. It rides on two new default-off delegate keys:
  `delegate.autoMerge` (#98 — arm `gh pr merge --auto --merge` after `gh pr create`, only where the
  repo allows auto-merge and a required check exists) and `delegate.batchMode` (#99 — skip delegate's
  Phase-3 plan-approval pause when explicit scope is given, without weakening `approveBeforePush`). Two
  optional keys `autopilot.autoMerge` / `autopilot.planDir` are added. Re-render to pick them up; a
  repo that never invokes these is unchanged.
- **Re-render for the skills, opt-in for the hook — post-merge close-out and a faster clean-up
  (#67/#114).** The `git-workflow` and `clean-up` skills gain a post-merge convention (verify each
  linked issue closed, board Status → Done, then `clean-up git --yes`), and a new opt-in syrup
  workflow `waffle-post-merge-hook.yml` deterministically deletes a merged same-repo head branch on
  the remote (no Claude dispatch, no API spend; fork heads and the default branch skipped). Separately,
  `clean-up --execute` now fast-forwards the local default branch to the freshly-fetched remote tip —
  **only** when you are on it with a clean tree, and only as a fast-forward (never a merge, switch, or
  rebase), previewed in the dry-run plan (#114). Re-render for the skill changes; the hook is opt-in.
- **Additive, re-render + create one label — armed PRs are tagged `waffle-auto-merged` (#134).**
  Wherever the toolkit arms `gh pr merge --auto` (the hygiene and delegate skills), it now applies a
  configurable label on a successful arm as a durable paper trail that automation queued the merge
  (`is:pr label:waffle-auto-merged`). New optional key `autoMerge.label` (default `waffle-auto-merged`,
  declared in both the `github-workflow` and `orchestration` stacks). Re-render to pick it up, and
  create the label — `gh pr edit --add-label` will not.
- **Re-render (repos running the syrup hooks) — hygiene/CI fixes (#85/#97).** The dispatched-harness
  guard in `waffle-hygiene.yml` and both `waffle-label-hook.yml` jobs is now **delivery-aware**: when a
  run reports a PR URL (proof it landed its work) its hard denials are downgraded to a warning instead
  of red — a `dangerouslyDisableSandbox` escape is the sole always-red exception — ending the
  green-mission/red-check that trained alert fatigue (#85). And the `hygiene` skill now arms auto-merge
  with a **merge commit** (`gh pr merge --auto --merge`) rather than `--squash`, which errors on a
  squash-disabled repo, while `clean-up`'s branch detection is documented as merge-method-agnostic
  (#97). Re-render; repos that never installed these syrup hooks are unaffected.
- **Additive, one optional secret — release-hook `WAFFLE_RELEASE_TOKEN` fallback (#76).**
  `waffle-release-hook.yml`'s checkout now reads `${{ secrets.WAFFLE_RELEASE_TOKEN || github.token }}`,
  so a tag it pushes can trigger a consumer's downstream `on: push: tags` CI (a tag pushed by the
  ambient `GITHUB_TOKEN` cannot, by GitHub's anti-recursion rule). Zero-config behavior is unchanged;
  supply the PAT/App-token secret only if you need downstream workflows to fire. Re-render (repos
  running the release hook).
- **Re-render regenerates them — per-agent waffle avatars in the `.waffle/` overview docs
  (#128/#161).** `team.html` and `cheatsheet.html` now show a branded per-agent "wafflebot" avatar,
  every trait a pure function of the agent name (so renders stay byte-identical and doctor-clean) with
  the installed-skill count encoded in the waffle pockets, plus deep-link anchors and a hover ID card.
  These are generated output — commit them, don't hand-edit — and refresh on the next render; a repo
  with no agents gets no `team.html`.
- **Docs only — no re-render needed (#80).** `schema/FORMAT.md` now documents the
  "how do I know a file is wafflestack-managed?" story: the lock manifest
  (`.waffle/waffle.lock.json`) is the authoritative marker, backed by `render`'s
  refuse-to-clobber behavior and `doctor` drift detection. Records the decision to **not**
  adopt a `.wfl.md` filename convention — a suffix breaks skill (`SKILL.md`) and syrup
  (load-bearing path) discovery and would apply to agents only, so the lock manifest already
  answers the question authoritatively for every render kind. No config, render, or lock
  changes.
- **Dev / CI tooling — no consumer render or config change.** The Layer 2 eval harness and its cases
  (#109/#110) are authoring/CI surface inert to `render`/`validate`/`doctor`; their only
  consumer-facing surface is an **off-by-default opt-in syrup** workflow `waffle-evals.yml` (#111), so
  nothing arms until you install it. The #47 entry is a **design-only ADR** (no code shipped). This
  repo also installs the toolkit's own `wafflestack` self-stack (#120) and repositions itself in the
  README (#86) — neither touches a consuming repo — and `wafflestack setup`'s render-blocker report is
  now scoped accurately to the selected items' keys (#77).
- **No migration ships in this release** — it is a **minor, additive** move (contrast 0.10.0, which
  carried one). A plain re-render picks up every rendered change above; the opt-in items (external
  stacks, the `code-quality` skills, `autopilot`, and the syrup workflows) arm only when you install
  them.

### Added
- **External third-party stacks — pinned git / local source, resolved through one pipeline** (#88,
  #124–#127). `loadProjectConfig` classifies each `stacks:` entry as a built-in name or a validated
  `{ name, source, ref }` external source (source required; a git source must be pinned with `ref`, a
  local path must not carry one; names unique across all sources). A new `installer/lib/sources.mjs`
  resolves a git source (clone + checkout at the pinned ref into a content-addressed cache) or a local
  path (read in place); `loadToolkitWithSources` merges built-in + external roots into one registry and
  makes a stack name defined by two sources a **hard error naming both** (never a silent shadow).
  `render` lint-validates every external stack before writing (`validateExternalStacks`), writes a
  per-source `sources` provenance block to the lock (source, ref, resolved commit, files), and adds an
  extra trust-boundary acknowledgement when external opt-in syrup is poured; `doctor` attributes drift
  to its source and `upgrade` re-resolves each pin and reports `sourceMoves`. Authoring guide
  `schema/AUTHORING-EXTERNAL-STACKS.md` documents the source side. (#88, #124, #125, #126, #127)
- **Declarative `prerequisites:` schema + `doctor` gate (#129, first increment of #47).** A stack
  may now declare the **external** things it leans on — a `tool`, `secret`, `scope`, `label`,
  `setting`, `service`, or `env` — as a typed `prerequisites:` list in `stack.yaml`, distinct from
  the internal-only `requires:` keyword. Each entry carries a `kind`, `name`, `description`, a
  deterministic `check` (a shell command; exit 0 = satisfied), a `level` (`require` | `recommend`),
  and an optional `items:` list scoping it to specific waffles like `requires:`. `wafflestack
  doctor` runs each **selected** entry's check and **exits 1** on an unmet `require` (a `recommend`
  only reports), so a repo running the shipped `waffle-doctor.yml` gate verifies prerequisites on
  the same CI run; `render` additionally warns for each unmet cheaply-probed (`tool`/`env`)
  prerequisite. `validate` checks the block's shape. The legacy `env:` map is subsumed as the `env`
  kind **read-compatibly** (it keeps working, still warned at render — no stack must migrate). The
  `github-workflow` + `orchestration` stacks are seeded from the #47 inventory: only `command -v`
  tool probes (node/git/gh) are `require`; every secret/scope/label/setting/service is `recommend`.
  Documented in `schema/FORMAT.md`. New module `installer/lib/prerequisites.mjs`.
- **Prerequisites surfaced in `setup` + the SETUP.md playbook** (#130). The setup inventory lists each
  stack's whole `prerequisites:` block grouped by kind (with level, item scope, and check); update mode
  runs the applicable checks the way `doctor` does and flags unmet `require`s as blockers; and
  `schema/SETUP.md` step 4 becomes a required, structured walk of the block — shared-state kinds
  (secret/label/setting/service) still gated on the user's explicit go-ahead (warn-don't-provision). No
  new interactive CLI surface.
- **Repointable CI dispatcher — reserved `harness.*` keys** (#131). `harness.actionRef` /
  `harness.actionVersion` / `harness.apiKeySecret` render into the `uses:`/`with:` lines of both
  dispatch workflow templates, so a consumer can pin a different action version, repoint the ref, or
  rename the billing secret via config without ejecting. Injection-guarded (rejects `${{`, quotes,
  newlines; `apiKeySecret` restricted to a secret identifier) and enforced at render + `validate`;
  built-in defaults reproduce today's pinned action byte-for-byte.
- **`list` CLI command** (#119). New `installer/lib/list.mjs` composes `loadToolkit` +
  `loadProjectConfig` + `computeSelection` + the lock and doctor-style sha256 drift + version skew to
  classify every stack/waffle/syrup file **current** / **out of date** / **not installed**. Default
  output is a plain, non-TTY-safe aligned table (status the fixed-width leading column); `--interactive`
  drives a hand-rolled `node:readline` + ANSI multi-select that applies via the existing
  `installRefs()` + `renderProject()` path — **no new dependency**. The item→output-path matcher is
  extracted into `refs.mjs` (`itemOutputMatcher`), shared with `eject`. README Commands table updated.
- **`adversarial-review` skill + PR-green auto-trigger** (#112, `code-quality` + `github-workflow`).
  The config-free `/adversarial-review <PR#>` skill (defaults to the current branch's PR) reviews a
  finished, CI-green PR from a hostile reviewer's seat and posts an honest-severity review; the opt-in
  syrup `waffle-pr-green-hook.yml` dispatches it when a PR's required checks go green, once per green
  transition (deduped by a head-commit review marker; draft/bot/fork/idempotency gates,
  least-privilege perms). Adds optional `prGreen.watchWorkflows` / `prGreen.claudeArgs` (both
  injection-guarded). Dogfooded/armed in this repo.
- **`dry` skill** (#116, `code-quality`). A project-agnostic `/dry <path>` skill that removes genuine
  duplication under rule-of-three and semantic-sameness guardrails, then proves behavior unchanged via
  `{{project.testCmd}}` (reuses the existing key; no new config). Both user-invocable and agent-granted.
- **`autopilot` skill + the delegate opt-ins it composes** (#100/#101, orchestration; #98/#99,
  orchestration). `autopilot` is a prose playbook that composes `delegate` (batch mode + auto-merge),
  `clean-up`, and `git-workflow` into an unattended plan → implement → PR loop with a required issue
  scope and per-run, non-sticky auto-merge consent; two optional keys `autopilot.autoMerge` /
  `autopilot.planDir`, `requires:` delegate + clean-up + git-workflow + github-project-management. It
  rides `delegate.autoMerge` (#98 — arm `gh pr merge --auto --merge` after create; `autoMergeArmed`
  checkpoint field) and `delegate.batchMode` (#99 — skip the Phase-3 plan-approval pause under explicit
  scope; `confirmedVia` checkpoint field), both default-off.
- **Post-merge automation** (#67, `github-workflow`). New "After a PR merges" section in `git-workflow`
  and "Post-merge convention" in `clean-up` (verify issue closed → board Done → `clean-up git --yes`),
  plus opt-in syrup `waffle-post-merge-hook.yml` — a deterministic `pull_request: closed` + `merged`
  job (`contents: write`, no Claude dispatch) that deletes the merged same-repo head branch on the
  remote and emits a prune signal, skipping fork heads and the default branch.
- **`autoMerge.label` — a `waffle-auto-merged` paper trail on armed PRs** (#134). New optional key
  (default `waffle-auto-merged`), applied on a successful `gh pr merge --auto` arm at both live arming
  sites (the hygiene skill and both delegate arming paths); declared in the `github-workflow` and
  `orchestration` stacks. Setup notes instruct creating the label.
- **`WAFFLE_RELEASE_TOKEN` fallback in the release hook** (#76, `github-workflow`).
  `waffle-release-hook.yml`'s `actions/checkout` reads `${{ secrets.WAFFLE_RELEASE_TOKEN ||
  github.token }}`, mirroring the `WAFFLE_HYGIENE_TOKEN` pattern, so a tag it pushes runs under a
  PAT/App token when supplied and triggers downstream CI. Setup note + `release` skill caveat document
  the GitHub anti-recursion limitation.
- **Layer 2 eval harness + per-stack case format (#109).** A metered, LLM-driven eval tier
  (Layer 2 of #89, on top of the Layer 1 content assertions in #108). Behavioral cases live
  next to their stack at `stacks/<stack>/evals/<name>.eval.yaml`: a declarative case is a
  render target (skill/agent, resolved within the stack) + a scenario prompt + one or more
  transcript-level assertions (`includes`/`excludes`/`regex` deterministic; `judge` LLM-graded).
  The runner (`installer/lib/evals.mjs`, driven by `npm run evals`) renders the target through
  the real pipeline, drives a model against the scenario, and evaluates the assertions,
  returning structured pass/fail with the transcript. Because it costs real API money it is a
  **separate entry point, never part of `npm test`**, and every run is bounded by an explicit,
  enforced `--max-calls` budget (the runner refuses to start a call once the cap is reached).
  A `--dry-run` mock mode (and the `installer/test/evals.test.mjs` unit test) exercises the
  whole harness with no API key and no cost. Format documented in `schema/FORMAT.md`; ships a
  seed case under `stacks/github-workflow/evals/`.
- **Layer 2 eval cases + a scheduled runner** (#110, #111). Initial behavioral cases pin the costliest
  guardrails of the four highest-risk skills — `label-hook` (constant dispatch token, no fan-out),
  `issue` (template sections + sensible labels), `release` (never tags/pushes `main`; stamps the
  CHANGELOG), and `delegate` (>2-agent confirmation gate; a failed checkpoint halts) — each with a
  deterministic assertion plus a judge rubric (#110). The opt-in syrup `waffle-evals.yml` runs the
  metered tier nightly + on dispatch as a plain Node job (no Claude dispatch, `contents: read`, needs
  only `ANTHROPIC_API_KEY`), bounded by `evals.maxCalls` and reporting an `eval-results` artifact; adds
  `evals.cron` / `evals.maxCalls` / `evals.model` config (#111).
- **Per-agent waffle avatars in the overview docs** (#128, #161). The docs generator draws a branded
  per-agent avatar as inline SVG in `team.html` (with `id="agent-<name>"` deep-link anchors) and mini
  avatars badging each skill in `cheatsheet.html` (with a CSS-only ID-card popover). Every trait is a
  pure function of the agent name and the installed-skill count encodes into the waffle pockets, so
  renders stay byte-identical and doctor-drift-clean. #161 redesigns them to the "wafflebot" reference
  (waffle-iron + antenna, 10 expressive lid presets, six syrup flavors, gentle deterministic SMIL
  animation).

### Changed
- **Full codex / agents-dir render coverage** (#94). `renderAgent` gains an agents-dir branch
  (neutral Markdown at `.agents/agents/<name>.md` — `name`/`description`/`skills` frontmatter + body,
  no Claude `claude:` passthrough) and `renderSkill` gains a codex branch that shares the `.agents/skills`
  render with `agents-dir` (deduped by output dir, first target wins). `eject` learned the new
  `.agents/agents/<name>.md` path. README / ARCHITECTURE / FORMAT / AGENTS.md now describe full
  coverage.
- **`code-quality` made project-agnostic** (#117). `codebase-architecture` generalizes the Obsidian
  `onload()/onunload()` lifecycle to a neutral register/teardown contract and drops the hardcoded file
  tree for generic structure guidance; `tdd` gains an explicit "how and when to use" section; and the
  stack's config descriptions are scrubbed of Obsidian/Synapse example strings. No config keys added
  or removed.
- **`clean-up` fast-forwards the local default branch** (#114). After `git fetch --prune`,
  `clean_up.sh --execute` fast-forwards the local default branch to the remote tip when you are on it
  with a clean tree — ff-only, previewed in the dry-run plan — and the "never touched" guarantee and
  report format are reworded to match.
- **Docs & dogfooding.** README gains a "Where this fits" market-positioning section (#86); this repo
  installs the toolkit's own `wafflestack` self-stack (#120); and the machine/human doc registries
  (`AGENTS.md`, `STATUS.md`, `DECISIONS.md`) are refreshed for the autopilot loop and the 2026-07-08
  feature work (#101 doc pass; internal doc-registry sync).

### Fixed
- **`setup` over-reported render blockers** (#77). Setup iterated a stack's entire `config` schema
  whenever any of its items was selected and tested the raw value (ignoring defaults), so a partial
  selection saw phantom blockers and a defaulted required key read "unset". It now derives `usedKeys`
  from the **selected** items (`collectUsedKeys`, newly exported from `render.mjs`) and resolves through
  the default-aware `makeResolver` — exactly as `render` computes them — for both the blocker list and
  the "Config values" ⚠ markers.
- **The CI guard false-redded delivered hygiene/label-hook runs** (#85). The #82 guard classified a
  delivered run's denials as HARD and failed the job even though it had opened a PR seconds earlier. The
  guard is now delivery-aware across the hygiene template and both label-hook jobs: hard delivery
  denials are downgraded to a warning when the run's final text reports a PR URL (a
  `dangerouslyDisableSandbox` escape stays always-red), the dispatch prompts steer to single-program
  (no-`cd`) commands so allowlisted `git`/`gh` calls actually match, and `Bash(gh repo view:*)` is
  allowlisted for read-only inspection.
- **Auto-merge assumed squash-merge** (#97). The `hygiene` skill's `gh pr merge --auto --squash` errors
  on a squash-disabled repo; it now uses `--merge` (a merge commit), and `clean-up`'s merged-branch
  detection is reworded as merge-method-agnostic (it always read PR state via `gh`, never the merge
  method).
- **Argument-injection guard on external git sources** (#124). A `source`/`ref` from `waffle.yaml` that
  begins with `-` (e.g. `--upload-pack=…` on a `.git` source, or an ssh `-oProxyCommand=…`) would be
  parsed by git as an option; `resolveSourceRoot` now rejects a leading-dash git source or ref before
  any git call, with a `--` end-of-options marker on the clone as defense in depth.

## [0.10.0] - 2026-07-07

### Consumer impact
- **Breaking, migration ships — rebrand: bundles are now stacks, files are syrup (#59).** The
  vocabulary changes to match the name: an installable item (agent or skill) is a **waffle**, a
  named group of waffles is a **stack** (formerly "bundle"), and the generic `files/` payload is
  **syrup**. **The one breaking consumer change is the `.waffle/waffle.yaml` key `bundles:` →
  `stacks:`.** A 0.10.0 migration renames it in place (comment-preserving, across the config and
  its `.local` overlay); `wafflestack upgrade` runs it for you. A plain `render` also keeps
  working off a legacy `bundles:` key via a read-fallback, emitting a deprecation warning that
  points at `upgrade`. **Toolkit authors:** the source dir is `stacks/`, the manifest is
  `stack.yaml`, the `toolkit.yaml` key is `stacks:`, and the opt-in gate key `syrup:` is renamed
  to `optIn:` (a stale `syrup:` now fails `validate`/`loadStack` loudly rather than silently
  un-gating). The lock's `bundles` field becomes `stacks` — write-only, so it self-heals on the
  next render with no migration. **Explicitly unchanged** (no action needed): item refs
  (`skills/x`, `agents/y`, `files/z`), your `include:` / `eject:` entries, lock file paths, the
  `files:` manifest key, and the `wafflestack` package/CLI name. **Re-render after upgrading.**
- **Bug fix, content-only — the scheduled `waffle-hygiene` hook can finally succeed
  (`github-workflow`).** As shipped it dispatched the CI harness with an empty `claude_args`, so
  the headless run began with no `--allowedTools`; in CI there is no human to answer permission
  prompts, so every gated `Write`/`Edit`/`Bash` call was auto-denied and the daily cron billed
  ~$4–5 for a guaranteed no-op (no docs, no commit, no PR). The workflow now bakes a default
  `--allowedTools` covering the full hygiene → docs → git-workflow chain, with
  `hygiene.claudeArgs` folded on the end for your extras. **Re-render to pick it up** — no config
  key changes and no migration; a repo that never installed the syrup hook is unaffected. (#71)
- **Bug fix, content-only — the opt-in `waffle-label-hook` jobs can finally do their work
  (`github-workflow`).** Same defect as #71 in the label hook: both the `enrich` and `implement`
  jobs dispatched the CI harness with an empty `claude_args`, so the headless run began with no
  `--allowedTools` and CI auto-denied every gated `Write`/`Edit`/`Bash` call — enrich could not run
  its `gh issue`/board mutations and implement could not branch, commit, push, or open a PR, so
  every human-applied trigger label billed for a no-op. Each job now bakes a per-job default
  `--allowedTools` (enrich: `gh issue` + `gh api` board calls only, no file edits or git;
  implement: the full `Edit`/`Write` + git + `gh pr` + `gh issue` chain plus the git-workflow
  pre-flight), with `labelHook.claudeArgs` folded on the end for your extras. **Re-render to pick
  it up** — no config key changes and no migration; a repo that never installed the syrup hook is
  unaffected. (#72)
- **Enhancement, content-only — dispatched-harness failures are now visible in CI, not silent
  (`github-workflow`).** The `waffle-hygiene` and `waffle-label-hook` workflows dispatched the paid
  harness with its output hidden and with denials that did not fail the job, so a run blocked from
  every write (the #71/#72 defect) showed a green check with nothing landed — the very failure this
  would have caught on day one. Each dispatch job now (a) uploads its execution log as a
  `claude-execution-log*` workflow artifact (`if: always()`, 7-day retention) and (b) gains a
  `Check harness result` guard that **fails the job on `permission_denials`** (all jobs) and, for
  hygiene, warns on a no-op that reports neither a PR URL nor `no drift`/`skipped`. The action's
  `show_full_output` stays OFF (it streams tool output — possibly secrets — into the
  public-repo-readable run log); the repo-scoped, self-expiring artifact is the safer default.
  **Re-render to pick it up** — no config keys change and no migration; a repo that never installed
  either syrup hook is unaffected. (#73)
- **Bug fix, mostly content-only — the guarded `waffle-hygiene` / `waffle-label-hook` harness can
  finally complete a real run (`github-workflow`).** The first guarded live hygiene run still could
  not finish: the baked allowlist (#71/#72) covered the write chain but not three command classes a
  real CI session needs, and the #73 guard — which failed on *any* denial — then reddened the run
  over all 16. Three fixes close the gap: (1) a deterministic **`Install project dependencies`** step
  (`project.installCmd`, default `npm install`) runs BEFORE the paid dispatch in the hygiene job and
  the label-hook `implement` job, so a fresh checkout has its `node_modules` and the pre-flight
  actually runs — the harness never needs (and never gets) install permission; (2) the `Check harness
  result` guard now **classifies** denials — a blocked file edit, a `git`/`gh` push·PR, or a
  `dangerouslyDisableSandbox` escape still fails the job, but ad-hoc **read-only** shell
  (`grep|sed|sort`, `find`, `for`-loops) is downgraded to a warning, so a legitimately-behaving run
  is no longer reddened just for exploring; (3) a repo whose own skills call a project CLI directly
  extends the allowlist through `hygiene.claudeArgs`/`labelHook.claudeArgs` (this repo adds
  `Bash(node installer/cli.mjs:*)`). **Re-render to pick it up** — `project.installCmd` is a new
  *optional* key (default `npm install`), so this is additive with no migration; a repo that never
  installed either syrup hook is unaffected. (#82)
- **Enhancement, content-only — installs no longer silently half-arm a paired flow (#74).** When a
  render/install selection includes a waffle whose opt-in syrup companion is gated out — e.g. the
  `release` skill without its `waffle-release-hook.yml` tag-on-merge hook — `render`/`install` now
  prints a `warning:` naming the skipped syrup and the exact `wafflestack install files/<path>`
  command to pour it, and `setup` update-mode flags the same pairing. `schema/SETUP.md` promotes its
  opt-in-syrup guidance from advisory to a **required** both/one/neither question the installing
  agent must ask. The CLI stays deliberately non-interactive (no TTY prompt). **Re-render costs
  nothing** — warnings only, no config/lock/render-output change and no migration; a repo whose
  paired syrup is already installed or tracked stays quiet.
- **Enhancement, content-only — the generated overview one-pagers are now branded HTML, not SVG
  (#75).** `render` used to emit `.waffle/cheatsheet.svg` + `.waffle/team.svg`; it now emits
  `.waffle/cheatsheet.html` + `.waffle/team.html` — self-contained pages with selectable,
  searchable, reflowing text and the full brand type stack (Baloo 2 / Outfit / JetBrains Mono via
  Google Fonts, with a brand-styled system-font fallback so they render correctly offline). The
  Markdown cheat sheet/team docs are unchanged. **Re-render to pick it up** — the old `.svg` files
  are pruned automatically by render's frozen-image sweep (they were previously-managed paths this
  render no longer produces); no config key changes and no migration. If your `.gitignore` listed
  the old `.svg` overview paths, swap them for the `.html` names.

### Added
- **CI observability for the dispatched harness — surface output + fail on denials** (#73,
  `github-workflow`). Both harness-dispatching workflows (`waffle-hygiene.yml`,
  `waffle-label-hook.yml`) gain, per dispatch job: an `id: harness` on the dispatch step; an
  `actions/upload-artifact` step (SHA-pinned `# v4.6.2`, `if: always()`, 7-day retention) that
  preserves the execution log — previously written to `$RUNNER_TEMP/claude-execution-output.json`
  and then discarded — as the `claude-execution-log*` artifact; and a `Check harness result` guard
  (`if: always()`) that parses the log **as data via `jq`** (never eval'd) and `exit 1`s when the
  final result message carries any denials (read as `permission_denials_count`, falling back to the
  raw `permission_denials` array length). The hygiene job additionally emits a `::warning::` when its
  run reports neither a PR URL nor an explicit `no drift`/`skipped` (the hygiene skill's Report
  contract) — a conservative heuristic over free-form text, so it warns rather than fails; a missing
  or unparsable log warns without crash-looping. The surfacing choice (execution-log artifact over
  `show_full_output: true`) and the debug flow are documented in the bundle setup notes for both
  hooks. Grounded in `anthropics/claude-code-action` v1.0.162: the `execution_file` output, the
  `show_full_output` input's secret-exposure warning, and the log's raw-message-array shape. (#73)
- **Layer 1 eval tier: deterministic content assertions on rendered stack prompts** (Part of #89).
  New `installer/test/content.test.mjs` (picked up by the existing `npm test` glob) asserts the
  load-bearing *behavior* baked into the highest-risk rendered prompts — not just that they render
  byte-correctly. Covers: label-hook's constant action-token rule and untrusted-input/no-fan-out
  refusals; delegate's >2-agent confirmation gate, pre-flight checklist, hard checkpoint gate, and
  opt-in-and-off-by-default approval gate; the issue and release template sections and tag-safety
  guardrails; frontmatter presence across every rendered skill/agent; and no leftover config
  placeholders. The label-hook workflow (gitignored, not committed) is rendered fresh into a temp
  project via the real render pipeline and asserted on there — the bot-sender gate on both dispatch
  jobs and the exact-match label gate. Dev-only; no consumer-facing change. The LLM eval tier is
  tracked as sub-issues of #89.

### Changed
- **Overview one-pagers: branded self-contained HTML replaces the SVGs** (#75). `waffledocs.mjs`
  swaps its `cheatsheetSvg`/`teamSvg` generators for `cheatsheetHtml`/`teamHtml`, emitting
  `.waffle/cheatsheet.html` + `.waffle/team.html` through the same `generateWaffleDocs` → `emit()`
  path (so they stay lock-tracked, doctor-checked, and pruned). Each page is a valid standalone
  HTML5 document: semantic `<ul>` rows of the same skill/agent frontmatter, the waffle glyph inline
  as SVG, the wafflestack palette (dark by default, warm-paper light via `prefers-color-scheme`),
  and a hybrid font strategy — Google Fonts `<link>` tags for the brand type as progressive
  enhancement, backed by a brand-styled system-font stack, with those font links the only external
  reference. The retired `.svg` paths are pruned on the next render via render's frozen-image sweep.
  Docs (`schema/FORMAT.md`, `AGENTS.md`, `.gitignore`) and the installer tests are updated to match.

### Fixed
- **`waffle-hygiene.yml` denied every write, so the daily hook was a paid no-op** (#71,
  `github-workflow`). The template rendered `claude_args: "{{hygiene.claudeArgs}}"` and the
  config default is `""`, leaving the headless harness with no allowlist — which in CI
  auto-denies all gated tool calls (the first scheduled run logged 28 permission denials and
  produced nothing while still exiting "success"). `claude_args` is now a `>-` block scalar
  carrying a baked default
  `--allowedTools 'Edit,Write,Bash(git:*),Bash(gh pr:*),Bash(<pre-flight>:*)'` with
  `{{hygiene.claudeArgs}}` folded onto the end (the Claude CLI unions repeated `--allowedTools`,
  so consumer extras extend the default rather than replace it). The pre-flight patterns render
  from `project.lintCmd` / `project.typecheckCmd` / `project.testCmd` / `project.buildCmd` — the
  same keys the `git-workflow` pre-flight executes — so the allowlist tracks whatever the project
  configured. The `hygiene.claudeArgs` description and the hygiene setup note now document the
  default allowlist and how to extend it. The identical latent bug in `waffle-label-hook.yml` is
  tracked separately in #72. (#71)
- **`waffle-label-hook.yml` denied every write in both jobs, so each dispatch was a paid no-op**
  (#72, `github-workflow`). The template rendered `claude_args: "{{labelHook.claudeArgs}}"` in the
  `enrich` and `implement` jobs and the config default is `""`, leaving the headless harness with
  no allowlist — which in CI auto-denies all gated tool calls (the sibling hygiene run logged 28
  permission denials and produced nothing). Both jobs now render `claude_args` as a `>-` block
  scalar carrying a per-job baked default `--allowedTools`, with `{{labelHook.claudeArgs}}` folded
  onto the end (the Claude CLI unions repeated `--allowedTools`, so consumer extras extend the
  default rather than replace it). The two jobs get distinct defaults matched to their least
  privilege: `enrich` (holds `issues: write`) gets the narrow read-mostly set
  `Bash(gh issue:*),Bash(gh api:*)` — no `Edit`/`Write`, no git; `implement` mirrors the hygiene
  chain plus `Bash(gh issue:*)` for the PR-link comment, its pre-flight patterns rendering from
  `project.lintCmd` / `project.typecheckCmd` / `project.testCmd` / `project.buildCmd` — the same
  keys the `git-workflow` pre-flight executes. The `labelHook.claudeArgs` description and the
  label-hook setup note now document the per-job defaults and how to extend them. Live hook
  verification (labeling a test issue) is deferred to a follow-up, per the issue. (#72)
- **The guarded `waffle-hygiene` live run was denied 16 setup/read calls and reddened** (#82,
  `github-workflow`). Run 28681795718 proved the #73 guard's red path — but the run legitimately
  needed three command classes the #71/#72 allowlist did not cover: a dependency bootstrap
  (`npm install`, tried three ways), direct toolkit-CLI calls (`node installer/cli.mjs
  validate`/`doctor --allow-missing`), and generic read-only shell (`grep|sed|sort`, `find`,
  `for`-loops over `bundles/`); the guard then failed the job on all 16 (3 of them
  `dangerouslyDisableSandbox` retries). Resolved per class:
  (a) **bootstrap OUTSIDE the harness** — a new `Install project dependencies` step runs
  `project.installCmd` (default `npm install`; override for a non-npm toolchain, or `true` to skip)
  after checkout and before the dispatch, in the hygiene job and the label-hook `implement` job (the
  read-only `enrich` job needs no deps); the install stays a plain workflow step so the harness
  allowlist grows no install/network permission, and the pre-flight (`npm test` / `npm run validate`)
  finally has a populated `node_modules` to run against.
  (b) **toolkit-CLI** via the documented consumer-extras hook — this repo sets
  `hygiene.claudeArgs: --allowedTools 'Bash(node installer/cli.mjs:*)'`, unioned onto the baked
  default (the direct CLI calls come from this repo's own `docs.auditChecklist` / `audit` / `delegate`
  config, so the fix is repo-side, not a template default every consumer inherits).
  (c) **read-only shell vs. guard nuance** — the `Check harness result` guard no longer fails on every
  denial; it classifies each (still jq-only, read strictly as data, no eval, `EXECUTION_FILE` via
  env) and fails ONLY on delivery denials (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`, or a `git`/`gh`
  and other mutating/exfil command matched at a command boundary) and sandbox escapes
  (`dangerouslyDisableSandbox` — *never* downgraded), while WARNING on read-only exploration that
  never blocked delivery. A denied call never ran, so the downgrade changes only the red-vs-yellow
  signal, not what the harness could execute — the allowlist stays the real control. Adds an optional
  `project.installCmd` config key (injection-guarded pattern: no `${{ }}`, no newline); updates both
  workflow templates and the hygiene + label-hook setup notes; installer tests cover the install
  step's presence (hygiene + implement) and absence (enrich), the key's override and hostile-value
  rejection, and EXECUTE the rendered guard scripts against the real 16-denial shape (3 sandbox → red),
  read-only-only (→ warn, green), a blocked Edit/git push (→ red), and a clean run (→ green). Live
  re-verification (guard green, a hygiene PR lands) is deferred to after merge and a credit top-up,
  per the issue. (#82)
- **Enhancement, content-only — typed checkpoints between `delegate` phases (`orchestration`, #91).**
  The `/delegate` skill now writes one schema-validated JSON checkpoint per run and validates it at
  every phase boundary (Fetch → Classify → Plan → Execute → Report). Each phase appends its section
  (`scope`, `issues`, `classification`, `plan`, `execution`, `report`) and load-bearing fields — issue
  number, branch, worktree path — are read from the checkpoint as the single source of truth rather
  than re-derived from prose. Two files ship beside `SKILL.md`: `checkpoint.schema.json` (the documented
  contract) and `checkpoint.mjs` (a dependency-free validator that also cross-checks references — every
  classified/assigned/executed issue traces back to a fetched one, worktree presence matches group mode,
  and an executed branch must equal the branch the plan assigned, catching a hallucinated branch). A
  corrupt or drifted checkpoint exits non-zero and stops the run instead of drifting silently. Adds one
  optional config key `delegate.checkpointDir` (default `{{git.worktreesDir}}/.delegate`, gitignored
  run state). **Re-render to pick it up** — additive, no migration; a repo that never runs `/delegate`
  is unaffected.
- **Enhancement, content-only — opt-in approval gate before push in `delegate` runs (`orchestration`,
  #92).** A new optional config key `delegate.approveBeforePush` (default `false`) adds a human gate
  immediately before a delegated agent's branch leaves the machine. When on, each agent runs its
  pre-flight, commits **locally**, and STOPS before `git push` / `gh pr create`; the orchestrator
  assembles a compact per-agent summary (branch, target issue, diffstat, commit list), collects the
  human's decision via `AskUserQuestion` (Approve / Approve all / Reject), and only an explicit
  approval releases the push and opens the PR. A rejection leaves the worktree and local branch intact
  for inspection (never cleaned up) and is recorded in the run. The decision is part of the run's typed
  state: `checkpoint.schema.json` gains `approval` (`approved`/`rejected`) and `approvedBy` on each
  `execution` entry, and `checkpoint.mjs` enforces that a rejected push is `status: skipped` with a
  null PR — so a rejection can never masquerade as a merged PR — with tests covering both. The Report
  phase adds an "Approved by" column when the gate was active. **Re-render to pick it up** — additive,
  no migration, and **default-off leaves existing `/delegate` behavior unchanged**; a repo that never
  runs `/delegate` (or never enables the flag) is unaffected.
- **Enhancement, content-only — curated, capped run-memory doc for `delegate` runs (`orchestration`,
  #93).** The `/delegate` skill now keeps ONE small, durable memory doc per repo of forward-useful
  lessons (repo quirks, recurring failures, issue entanglements) that carry between runs. It is
  **curated and hard-capped**, never an append-only log: the Report phase distils this run's lessons in —
  pruning stale entries, never blind-appending — and the Classify/Plan phases read it back (each spawned
  agent gets only the entries whose **Area** matches its issue). Every entry carries a **Why**, a
  **Since** (the issue/PR that taught it — its staleness anchor), and an **Area**, so pruning is judged
  rather than FIFO. A dependency-free validator ships beside `SKILL.md` — `memory.mjs` — that enforces
  the byte cap **and** the entry format at the Report boundary: over cap or a malformed entry exits
  non-zero and blocks the run until curation brings it back within budget (a missing doc is valid — a
  fresh repo simply has none yet). Adds two optional config keys: `delegate.memoryFile` (default
  `{{delegate.checkpointDir}}/memory.md`, gitignored, per-clone like the checkpoints) and
  `delegate.memoryMaxBytes` (default `4096`). **Re-render to pick it up** — additive, no migration; a
  repo that never runs `/delegate` is unaffected.

## [0.9.0] - 2026-07-03

### Consumer impact
- **Additive, opt-in — a new scheduled repo-hygiene workflow (`github-workflow`).** A new
  syrup item `.github/workflows/waffle-hygiene.yml` (+ a `hygiene` skill) runs the `docs`
  skill on a daily cron and opens an auto-merge PR with the result. Like the label hook it is
  **opt-in** — enabling the bundle does NOT render it; install it explicitly
  (`wafflestack install files/.github/workflows/waffle-hygiene.yml`). New optional config keys
  `hygiene.cron` (default `0 13 * * *` UTC ≈ 5am Pacific) and `hygiene.claudeArgs` are both
  defaulted, so an existing render is unaffected until you adopt the workflow. **A scheduled
  trigger spends Anthropic API money daily** — read the bundle setup note (API key secret,
  committed render, "Allow auto-merge", and a PAT/App token in `WAFFLE_HYGIENE_TOKEN` so
  auto-merge can actually fire) before pouring it. No migration required. (#46)
- **New, additive — a `github-project-board` skill can provision and standardize your
  Projects v2 board.** No migration: `render`/`upgrade` picks up the new skill (the
  `github-workflow` bundle gains it, and the orchestration `project-manager` agent is granted
  it), and existing config/extensions are untouched. Until now every board-touching skill only
  *consumed* a board and degraded with a warning when none existed; this skill is the create
  side — run `/github-project-board` (or let the project-manager use it) to create a board to
  the canonical Kanban spec, or reconcile a partial one up to it. It **asks before it creates
  or mutates** and never runs inline during delegation/issue creation, so enabling the bundle
  changes no existing behavior. Board mutations need the `project` token scope
  (`gh auth refresh -s project`). (#54)
- **New bundle, fully additive — no migration.** The `harness-architect` bundle ships a
  single domain agent for designing and building agent harnesses. Enable it by adding
  `harness-architect` under `bundles:` (or `wafflestack install agents/harness-architect`);
  its one config key `project.longName` is optional (defaults to a generic phrase), so no
  new required config. Existing installs are unaffected until they opt in. (#60)
- **New, automatic — every `render` now writes four overview docs into `.waffle/`.** After a
  render/upgrade your repo gains `.waffle/CHEATSHEET.md` + `.waffle/cheatsheet.svg` (a cheat
  sheet of the installed user-invocable skills) and `.waffle/TEAM.md` + `.waffle/team.svg` (an
  introduction to the installed agents), assembled from the exact items you have installed.
  They are lock-tracked, drift-checked by `doctor`, refreshed on every render, and pruned if a
  later selection stops producing them (a repo with no agents gets no `TEAM.*`, etc.) — so they
  are generated output: **commit them, don't hand-edit them** (edit the item frontmatter, or
  gitignore them as this repo does). Nothing else changes; no config or new keys required. (#58)
- **Behavior change, mostly automatic — the `github-workflow` label-hook workflow is now
  opt-in (“syrup”).** `.github/workflows/waffle-label-hook.yml` — whose jobs need repo
  `issues`/`contents`/`pull-requests` write permissions — no longer renders just because the
  `github-workflow` bundle is enabled. A repo that **already tracks the file** in
  `.waffle/waffle.lock.json` keeps rendering and updating it (no action needed). A repo that
  enables the bundle but never committed the workflow will simply stop rendering it on the
  next `render`/`upgrade` (the frozen-image prune removes the now-unselected file if it was
  lock-tracked, or leaves an untracked copy alone). To keep it, install it explicitly:
  `wafflestack install files/.github/workflows/waffle-label-hook.yml` (persists the ref to
  `include:`). The read-only `waffle-doctor.yml` workflow is unaffected — it still renders by
  default. (#51)
- **Additive — release automation in `github-workflow`.** New `release` skill and a
  `waffle-release-hook.yml` workflow, plus config keys `labelHook.releaseLabel` (default
  `waffle:release`), `release.tagFormat` (default `v{version}`), and `release.versionFiles`
  (default empty). All optional with back-compatible defaults, and the workflow is **syrup**
  (opt-in) — so an existing repo sees only a plain content re-render and nothing new arms until
  you install the hook and create the label. To adopt: `wafflestack install
  files/.github/workflows/waffle-release-hook.yml`, `gh label create "waffle:release"`, and
  confirm Actions may write `contents`. Point `release.versionFiles` at your own version files.
  (#39)
- **Additive — a new `/standup` skill renders for repos with the `orchestration` bundle.**
  `render`/`upgrade` picks up `.claude/skills/standup/` (and the `.agents/` mirror) on the next
  run; no new config keys and no migration. Invoke `/standup` for a one-look, per-agent status
  pulse of the codebase. (#56)

### Added
- **Scheduled repo-hygiene workflow — `waffle-hygiene.yml` + a `hygiene` skill** (#46): the
  `github-workflow` bundle gains a daily (cron + `workflow_dispatch`) CI workflow that
  dispatches the Claude Code action to work a **hygiene task list** — first entry runs the
  `docs` skill, then lands the result as a PR per the `git-workflow` skill with
  `gh pr merge --auto --squash`. Reuses the label hook's SHA-pinned dispatch and injection-safe
  config-render hardening: `hygiene.cron` is validated against a cron allowlist (blocks quotes/
  `${{`/newlines and rejects empty — fail-closed loud), and `hygiene.claudeArgs` mirrors
  `labelHook.claudeArgs`. It is **syrup** (its job holds `contents`/`pull-requests` write and it
  bills daily) — wired to its skill via a `files/`-keyed `requires:` edge, the skill to
  `git-workflow`. Auto-merge needs a required check to wait on, but PRs opened with the default
  `GITHUB_TOKEN` do not trigger the repo's own CI — so the workflow reads an optional
  `WAFFLE_HYGIENE_TOKEN` (PAT/App token) secret and falls back to `GITHUB_TOKEN`; the token +
  repo-settings recipe (incl. `allow_auto_merge`) is documented in the bundle `setup:` block
  alongside the daily-cost warning. (#46)
- **`github-project-board` skill** (github-workflow bundle, #54): the toolkit's first
  *create-side* board skill. Encodes the standard board spec — **Status** (Backlog / Todo /
  In Progress / In Review / Done), **Priority** (Critical / High / Medium / Low), **Size**
  (S / M / L), and **Start** / **Target** date fields, with Table / Kanban / Roadmap views —
  and a GraphQL mutation catalog to realize it: `createProjectV2` + `linkProjectV2ToRepository`
  for the no-board path, `createProjectV2Field` for missing fields/options, and
  `updateProjectV2Field` for reconciling an existing single-select (documented as a full
  replace, with the option-ID/assignment-loss and built-in-Status caveats called out). Honest
  about API limits: Projects v2 **views are not creatable via the public API**, so it offers
  `copyProjectV2` from a template board (clones fields *and* views) or prints guided manual
  view steps; board discovery matches `project.name` case-insensitively (normalized, exact).
  Wired like the delegate→github-project-management pattern: listed in the github-workflow
  bundle `skills:`, granted in the `project-manager` agent frontmatter, and pulled into a
  standalone `install skills/delegate` via a new orchestration `requires:` edge. The
  github-workflow `setup:` note and the `delegate` / `issue` "no board" warnings now point at
  it. (#54)
- **`harness-architect` bundle — an expert in building agent harnesses** (#60): a single
  domain agent (`bundles/harness-architect/`) versed in agent/skill/tool decomposition,
  subagent teams and orchestration, hooks, MCP servers, slash-command ergonomics, and
  multi-harness portability (Claude Code / Codex / cross-tool `.agents`). Registered in
  `toolkit.yaml`; one optional config key (`project.longName`). WaffleStack dogfoods it via a
  project extension (`.waffle/extensions/agents/harness-architect.md`, appended at render by
  `render.mjs`'s extension markers) that grounds the agent in the stack's own paradigms — the
  `AGENTS.md` module/pipeline registry, the `schema/FORMAT.md` authoring contract, the
  governing `DECISIONS.md` ADRs (one-canonical-source, the frozen-image render contract,
  lenient agent→skill vs. strict `requires:` deps), and the `validate` / `test` / `render` +
  `doctor` gates. This split dogfoods the extension mechanism: the generalized agent ships to
  any consumer, while this repo's install carries the deep wafflestack knowledge. (#60)
- **Generated `.waffle/` overview docs — cheat sheet + team intro** (#58): a new
  `installer/lib/waffledocs.mjs` assembles two default documents from the computed render
  selection and emits them through render's `emit()` choke point (so they are lock-tracked,
  `doctor`-drift-checked, pruned when stale, and refreshed every render). `CHEATSHEET.md`
  lists every installed user-invocable skill as `/name` + argument-hint + a one-line
  when-to-use; `TEAM.md` introduces each installed agent with its role, when-to-use, and
  granted skills (hand-offs). Each ships a branded, fully self-contained SVG one-pager
  (`cheatsheet.svg`, `team.svg`) sized to the item count — GitHub-renderable, Golden/Syrup/
  Cocoa palette per `assets/README.md`, waffle chrome in the header only, plain scannable body.
  The installer now parses skill frontmatter (`user-invocable`, `argument-hint`, `description`)
  — a skill is a slash command unless it sets `user-invocable: false` (so a `disable-model-
  invocation`-only skill like `audit` still lists). Descriptions are substituted with the same
  resolver render uses, so `{{project.name}}` reads identically to the rendered item.
  Documented in `schema/FORMAT.md` and `AGENTS.md`. (#58)
- **Syrup — an opt-in tier for sensitive bundle items** (#51): a new `syrup:` list in
  `bundle.yaml` names `files/` items (by ref) that must be poured only on request. Enabling a
  bundle no longer renders its syrup items; each renders only when installed explicitly
  (`install files/<path>`, persisted to `include:`) or when the consuming repo already tracks
  its path in the lock (existing installs keep updating). `loadBundle()` parses the flag,
  `validate` rejects a `syrup:` entry that doesn't resolve to a real item in the bundle,
  `computeSelection()`/`renderProject()` gate the selection on include/prior-lock tracking,
  and `wafflestack setup` lists syrup items under a separate default-do-not-install
  acknowledgement. Documented in `schema/FORMAT.md` and the `schema/SETUP.md` playbook. The
  `github-workflow` bundle marks `waffle-label-hook.yml` as syrup; its inert-by-default
  rendered form (fail-closed empty-label gates, no secret) is unchanged. (#51)
- **Automated releases: `release` skill + tag-on-merge hook** (#39, `github-workflow` bundle).
  The `release` skill (user- and agent-invocable) does the bump-PR half: pick the semver level
  from changes since the last tag (or take an explicit version), `npm version
  --no-git-tag-version`, sync the files in `release.versionFiles`, stamp `CHANGELOG.md`
  (`[Unreleased]` → `[X.Y.Z]`), re-render if generated output tracks the version, run the
  pre-flight, open a `chore/bump-X.Y.Z` PR carrying the consumer-impact notes, and apply the
  release label. It never pushes the tag. The new syrup `waffle-release-hook.yml` does that:
  when a PR carrying `labelHook.releaseLabel` is **merged**, a deterministic `contents: write`
  job (NO Claude dispatch, NO API spend) pushes a lightweight tag from `release.tagFormat` on
  the merge commit, reading the version from the merged `package.json` and refusing any
  non-semver value. Config keys `labelHook.releaseLabel`, `release.tagFormat`, and
  `release.versionFiles` are added with injection-safe patterns on the first two (fail-closed
  empty label; `{version}`-token tag format). The release-flow spec is documented in the
  `git-workflow` skill, and the `label-hook` skill's guardrails now forbid an implement run
  from applying the release label. Dogfooded here: this repo installs the hook, commits the
  rendered workflow (a `.gitignore` carve-out), and creates the `waffle:release` label. (#39)
- **`wafflestack setup` is now config-aware on a re-run** (#50): when `.waffle/waffle.yaml`
  already exists, the guide injects a **"Current configuration — update mode"** section
  between the playbook and the inventory — the repo's live targets, enabled bundles,
  individual includes, ejects, per-key current-vs-default config values, any unset required
  keys (the render blockers), and syrup items (installed vs. opt-in) — read with the same
  `loadProjectConfig`/`computeSelection`/`makeResolver` the renderer uses, so the agent
  curates the update from real state instead of re-reading the file by hand. An unconfigured
  repo is unchanged (byte-for-byte the first-install output); a malformed config surfaces its
  load error rather than crashing the guide. `setupGuide()` now takes `cwd`, and
  `schema/SETUP.md` step 0 points at the injected section. (#50)
- No migration required, additive: the lead-engineer's ADR (architecture decision record)
  location is now the optional `lead.adrDir` config key (engineering-team bundle), default
  `docs/adr/`. The default preserves current output, so this is a content-only re-render for
  existing repos. Consumers with a different convention set e.g. `lead.adrDir: docs/decisions/`
  in `.waffle/waffle.yaml` and re-render instead of hand-editing the rendered agent (which
  would trip the `doctor` drift gate). (#48)
- **User-invocable `/standup` skill** (orchestration bundle, #56): rounds up a one-look status
  pulse from the *installed* team. It enumerates the roster dynamically by globbing the harness
  agents dir (`.claude/agents/*.md`) and parsing frontmatter `name`/`description` — not a
  hard-coded list — then fans out a single read-only parallel wave asking each agent for an
  ≤3-line report strictly from its own role's seat. Replies are collected via subagent
  **return values** (no reliance on `SendMessage`/`TaskUpdate`, sidestepping the
  silent-specialist caveat), then printed as one compact digest in roster order with
  truncation. Zero side effects — no team, no tasks, no board writes. Wired into
  `bundles/orchestration/bundle.yaml`'s `skills:` list; no new config keys. (#56)
- `lead.adrDir` config key (engineering-team bundle, `required: false`, default `docs/adr/`):
  the directory where the lead-engineer agent files architecture decision records. Replaces the
  two hardcoded `docs/adr/` literals in `agents/lead-engineer.md` with `{{lead.adrDir}}`,
  following the `planner.productDocsDir` precedent. (#48)

### Fixed
- The `product-manager` agent template (orchestration bundle) no longer hardcodes the
  hand-off name "lead-engineer"; it renders `{{roster.architectAgent}}` instead, so
  orchestration-only consumers see their configured architect (this repo's
  `general-purpose`) rather than an agent that doesn't exist in their roster.
  `roster.architectAgent` still defaults to `lead-engineer`, so engineering-team consumers
  render identically. Content-only — `render` regenerates it. (#49)

## [0.8.0] - 2026-07-02

### Consumer impact
- **Breaking, but automatic — the consumer config trio moves inside `.waffle/`:**
  `.waffle.yaml` → `.waffle/waffle.yaml`, `.waffle.local.yaml` → `.waffle/waffle.local.yaml`,
  `.waffle.lock.json` → `.waffle/waffle.lock.json` (extensions already lived at
  `.waffle/extensions/`), leaving a single wafflestack entry at the repo root. The **0.8.0**
  migration moves the files in place on the next `render`/`upgrade` — chaining from the
  pre-0.6.0 `.wafflestack.*` names too — and the old locations keep working (with a
  deprecation note) until then. Afterwards: commit the moved config (and lock, if you track
  it) and update your `.gitignore` entries (`.waffle.local.yaml` →
  `.waffle/waffle.local.yaml`, `.waffle.lock.json` → `.waffle/waffle.lock.json`) — the CLI
  never edits `.gitignore` unasked; `wafflestack install --gitignore` re-adds the new paths
  for you, and `render` warns while stale root entries remain. (#43)

### Added
- Migration step (**0.8.0**): moves the root `.waffle.*` config trio into `.waffle/`
  (`waffle.yaml`, `waffle.local.yaml`, `waffle.lock.json`) via the same idempotent
  `migrateLegacyDotfiles` chain that `render` runs at startup, ordered after the 0.6.0
  rename so a pre-0.6.0 repo carries all the way forward in one pass. `resolveDotPath`
  generalizes to an ordered multi-generation fallback (`.waffle/waffle.yaml` →
  `.waffle.yaml` → `.wafflestack.yaml`, same for the local overlay and lock), and
  `staleGitignoreEntries` now also flags now-stale root `.waffle.local.yaml` /
  `.waffle.lock.json` lines. (#43)

### Changed
- Canonical consumer paths are now `.waffle/waffle.yaml`, `.waffle/waffle.local.yaml`, and
  `.waffle/waffle.lock.json` (were repo-root `.waffle.*`); `init` writes the new layout
  directly (creating `.waffle/`), and the recommended `.gitignore` entry becomes
  `.waffle/waffle.local.yaml`. `.waffle/extensions/` is unchanged. (#43)

## [0.7.0] - 2026-07-02

### Consumer impact
- **Breaking if your config references reorganized items — the bundle roster was
  reorganized (#38).** The `design` bundle is dissolved (`ux-designer` lives in
  `engineering-team`), the general-architect agent `lead-developer` is renamed
  **`lead-engineer`**, and the two colliding `security-audit` skills are renamed
  `electron-security-audit` (relocated into `obsidian-dev`) and `webapp-security-audit`
  (engineering-team). Lock-managed repos pick the renames up on the next
  `render`/`upgrade` via the frozen-image prune; update your `.waffle.yaml` where it
  names old items (`bundles: [design]`, per-item `include:` refs, or an
  `audit.complianceAgentType` override) — `validate`/`render` fails loudly on stale
  refs. Final layout: 7 bundles, 13 agents, 17 skills.
- **Breaking, but automatic for lock-managed repos — the shipped doctor CI workflow is
  renamed `.github/workflows/wafflestack-doctor.yml` → `.github/workflows/waffle-doctor.yml`.**
  On the next `render`/`upgrade` the frozen-image contract deletes the old locked path and
  writes the new one, so a repo that commits its render **and** `.waffle.lock.json` gets the
  rename for free. Two edge cases need a one-line manual cleanup, because there the old file
  is not lock-managed: if you **ejected** the workflow, or **rendered before the lock
  existed** (or gitignore your lock), the stale `wafflestack-doctor.yml` is left in place —
  delete it yourself with `git rm .github/workflows/wafflestack-doctor.yml`. If you pin the
  workflow as a branch-protection required check or reference its filename / `name:`
  anywhere, retarget those to `waffle-doctor`, and update your `.gitignore` if it listed the
  old path.
- No migration required, additive: the github-workflow bundle now ships a second workflow,
  `.github/workflows/waffle-label-hook.yml`, plus a `label-hook` skill. It renders on your
  next `render`/`upgrade` but is **inert until you opt in**: it dispatches the Claude harness
  only when one of the configured trigger labels (`labelHook.enrichLabel`, default
  `waffle:enrich`; `labelHook.implementLabel`, default `waffle:implement`) is applied to an
  issue by a human, and it needs an `ANTHROPIC_API_KEY` repo secret — **each dispatch spends
  real API budget**. Repos without the labels/secret only accrue skipped runs on labeled
  events. Opt out entirely with `eject: [files/.github/workflows/waffle-label-hook.yml]`.
  Pushing the new file needs the `workflow` credential scope (same as the doctor workflow). (#27)
- No migration required, and the default is safer: `render` now **refuses to overwrite a
  pre-existing file it does not manage** instead of silently clobbering it. If a render
  stops on a `refusing to overwrite …` error, the named path already exists in your repo
  and is not tracked by `.waffle.lock.json` — move the file aside (or fold it into a
  `.waffle/extensions/` file) and re-render, or pass `--force` to let the toolkit's version
  win. A byte-identical file is adopted silently.
- No migration required: a new optional `doctor.flags` config key (github-workflow bundle,
  empty default) lets the shipped doctor CI workflow run extra flags. Set
  `doctor.flags: --allow-missing` to keep the workflow managed on a repo that gitignores a
  subset of its renders, instead of ejecting it. Default renders are behaviorally unchanged.
- No migration required, additive: `init`, `render`, and `install` gain an opt-in
  `--gitignore` flag that appends the entries wafflestack recommends — `.waffle.local.yaml`
  always, plus the configured `git.worktreesDir` when an enabled bundle declares one.
  Appending is idempotent (lines already present are skipped) and preserves existing content,
  under a `# wafflestack` marker. Without the flag nothing changes — the CLI still never edits
  your `.gitignore` unasked; the guided `setup` playbook now also offers these entries for
  your approval. (#29)

### Added
- Label-event hook primitive (github-workflow bundle): a prefab
  `.github/workflows/waffle-label-hook.yml` that dispatches the Claude Code GitHub Action
  when an allowlisted trigger label is applied to an issue, paired with a `label-hook` skill
  defining the label→action map — `waffle:enrich` runs the issue skill's enrich-in-place
  mode, `waffle:implement` implements the issue and opens a PR per git-workflow. Security
  posture built in: exact-match label gates (the label string is never interpolated into
  shell or prompt), human-sender check, per-job least-privilege permissions, SHA-pinned
  actions, an audit comment per dispatch, and prompt-injection guardrails in the skill. New
  optional config: `labelHook.enrichLabel`, `labelHook.implementLabel`, `labelHook.claudeArgs`.
  First `requires:` entry keyed by a `files/` payload, so a per-item install of the workflow
  pulls the skill closure. Adds a general, opt-in **render-time `pattern:` validation** for
  config keys (a regex the resolved value must match, enforced at every substitution site):
  the three `labelHook.*` keys use it so a hostile or malformed value — a quote, newline, or
  `${{ }}` that would corrupt or subvert the workflow's `if:` gate or `claude_args` scalar —
  fails the render loudly instead of silently. (#27)
- Opt-in `.gitignore` offer (#29): a `--gitignore` flag on `init`/`render`/`install` appends
  the recommended ignore entries through a new idempotent `ensureGitignoreEntries(cwd, entries)`
  helper — `.waffle.local.yaml` always, plus the resolved `git.worktreesDir` when an enabled
  bundle declares it (`recommendedGitignoreEntries`). `schema/SETUP.md` step 6 now instructs
  the setup agent to propose the entries and apply them on approval, and the "CLI never edits
  `.gitignore`" doc stance is refined to "never edits it *unasked*." No behavior change without
  the flag.
- `doctor.flags` config key (github-workflow bundle): appends flags to the doctor CI
  workflow's `npx --yes <ref> doctor` command. A repo that deliberately gitignores a subset
  of its renders can set `doctor.flags: --allow-missing` and keep
  `.github/workflows/waffle-doctor.yml` managed — lock-tracked and doctor-clean — instead of
  ejecting the file and losing managed updates. Empty by default, so existing renders are
  behaviorally unchanged. (#30)
- Unmanaged-collision guard on `render`/`install`: a rendered path that already exists on
  disk but is absent from `.waffle.lock.json` fails the render loudly — naming every
  offending path and writing nothing, so the tree is left untouched — instead of
  overwriting a hand-written consumer file. A content-identical file is adopted silently;
  `--force` overwrites a differing file and takes it under lock management. (#25)

### Changed
- Bundle reorganization (#38): bundles regrouped semantically; `design` dissolved
  (`ux-designer` restored into `engineering-team`), `electron-security-audit` relocated
  into `obsidian-dev`, the `code-quality` skills (`tdd`, `codebase-architecture`)
  de-Obsidianified with the Obsidian-specific material moved into `obsidian-dev`'s
  `obsidian-plugin-dev`, `security-engineer` phrasing generalized, and
  `audit.complianceAgentType` now defaults to `lead-engineer` (the general architect;
  override to a domain architect — e.g. `plugin-architect`, `mobile-architect` — where
  one exists). New optional config key `project.testCmd` on `code-quality` (default
  `npm test`).
- Renamed the github-workflow bundle's shipped doctor CI workflow
  `.github/workflows/wafflestack-doctor.yml` → `.github/workflows/waffle-doctor.yml`,
  completing the v0.6.0 `.wafflestack.*` → `.waffle.*` consumer-facing naming alignment
  (this reverses the 0.6.0 decision to keep the old filename). Its internal `name:` and
  `concurrency.group` move from `wafflestack-doctor` to `waffle-doctor` to match; the
  `wafflestack` CLI/package name and the `wafflestack doctor` command the workflow runs are
  unchanged. No migration step ships — lock-managed repos get the rename via the
  frozen-image prune, while ejected or pre-lock copies are unmanaged files the toolkit must
  not delete (per the #25 no-clobber contract), so their cleanup is documented under
  Consumer impact instead. (#28)

## [0.6.0] - 2026-07-02

### Consumer impact
- **Breaking, but automatic — consumer dotfiles renamed `.wafflestack.*` → `.waffle.*`.**
  The 0.6.0 migration renames your config, local overlay, lock, and extensions dir in place
  on the next `render`/`upgrade`; the legacy `.wafflestack.*` names keep working (with a
  deprecation note) until then. Update your `.gitignore` entries afterwards
  (`.wafflestack.local.yaml` → `.waffle.local.yaml`) — the CLI does not edit `.gitignore`.
  Everything else in this release (upgrade command, per-item install, `files/` payloads,
  doctor CI workflow) is additive.

### Added
- `wafflestack upgrade`: compares the lock's `toolkitVersion` to the invoked toolkit,
  prints the changelog delta, runs registered migrations in `(lockVersion, toolkitVersion]`
  order, then re-renders and runs `doctor`.
- Migration registry + runner (`installer/lib/migrations.mjs`): ordered, idempotent,
  version-keyed steps (`{ version, description, run(cwd) }`).
- First migration step (**0.6.0**): renames the legacy `.wafflestack.*` consumer dotfiles
  to `.waffle.*` (config, local overlay, lock, extensions dir). Shares one idempotent
  `migrateLegacyDotfiles` helper with `render`, so `upgrade` and a plain re-render converge.
- Legacy-name read fallback: `render`, `doctor`, `eject`, and `install` read a legacy
  `.wafflestack.*` file with a deprecation note when the `.waffle.*` name is absent.
- `CHANGELOG.md` (this file), wired into `upgrade` and the `files` allow-list so it ships
  in the package.
- Per-item install: `wafflestack install <ref…>` adds a single skill/agent (or a whole
  bundle) by ref — `skills/<name>`, `agents/<name>`, or bundle-qualified
  `<bundle>/skills/<name>` — with dependencies resolved transitively (agent `skills:`
  frontmatter plus bundle `requires:`) and the selection persisted in config so later
  renders stay deterministic.
- `files/` bundle payload: bundles can ship arbitrary repo-relative files (CI workflows,
  scripts, config) authored under `bundles/<bundle>/files/…`, rendered verbatim with the
  same `{{key}}` substitution, lock tracking, doctor drift detection, and eject support as
  agents and skills. GitHub Actions `${{ … }}` expressions pass through untouched.
- `doctor --allow-missing`: absent managed files are reported informationally instead of
  failing, so CI checkouts that deliberately gitignore some renders can still gate on
  drift. Modified files still fail, as does a missing lock.
- Installable `wafflestack-doctor` CI workflow (github-workflow bundle):
  `.github/workflows/wafflestack-doctor.yml` renders into a consuming repo and runs
  `wafflestack doctor` on push/PR; `doctor.toolkitRef` config pins the toolkit release it
  runs.
- Apache 2.0 license.

### Changed
- Consumer dot-paths are now `.waffle.yaml`, `.waffle.local.yaml`, `.waffle.lock.json`, and
  `.waffle/extensions/` (were `.wafflestack.*`). A plain `render` migrates a legacy repo and
  warns when `.gitignore` still lists the old names. The `wafflestack` package/CLI name, npx
  specs, and the `wafflestack-doctor.yml` workflow filename are unchanged.
- `doctor` now reports the rendered `toolkitVersion` unconditionally (not only on skew),
  and points at `wafflestack upgrade` when the lock and CLI versions differ.

## [0.5.0] - 2026-07-01

### Consumer impact
- No migration required. Re-render (`… render`) to pick up the setup wizard and the
  self-hosted `github-workflow` bundle.

### Added
- Agent-driven `setup` command: prints an install playbook plus an inventory generated
  from the installed toolkit (bundles, config keys, env prerequisites, setup notes).
- Self-hosted `github-workflow` bundle (git / issue / Projects v2 / clean-up).

_Releases before 0.5.0 (`v0.1.0`–`v0.4.0`) predate this changelog; see the git tags for
their history._
