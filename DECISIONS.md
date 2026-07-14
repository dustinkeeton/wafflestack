# Decisions

Why wafflestack is built the way it is — the choices that shaped the toolkit,
newest first. Each entry records the situation, what was decided, what else was
weighed, and what it affects.

For *what exists today* see [STATUS.md](STATUS.md); for *how it fits together*
see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 2026-07-13: `upgrade` rewrites only the pins a consumer already chose, and never re-execs (#372)

**Context**: The two `toolkitRef` config keys decide which toolkit actually runs — `doctor.toolkitRef`
is what CI's doctor job fetches, `waffle.toolkitRef` is what every `/waffle-*` skill fetches. They live
in `.waffle/waffle.yaml`, which `upgrade` never wrote. So a repo that did exactly what the docs
required — pin, *then* arm `--verify-render` — came out of an upgrade with a lock rendered by the new
toolkit and a CI job re-rendering with the old one. The next unrelated PR went red, and `doctor`'s
remedy (``run `wafflestack upgrade` ``) was the very command that could not fix it. This repo pins
neither key, so the whole defect was invisible to our own dogfooding: it bit only the consumers who
followed the instructions.

**Decision**: `upgrade` rewrites a `toolkitRef` key **if and only if the consumer already pinned it
release-shaped**, and writes **the pin the lock is about to record** — nothing else, nowhere else.

Three properties carry it:

- **The value is derived, not edited.** `toolkitPinFromIdentity(identity)` is literally
  `toolkitPinFromLock({toolkit: toolkitLockEntry(identity)})` — the composition of #374's own
  machinery, so what lands in `waffle.yaml` is by construction what lands in the lock. It inherits
  every honesty rule for free: a non-release run, a `dlx`/hatch run (#383) and a release **checkout**
  (#384 F13) all yield a null pin, and a null pin writes nothing. String surgery on the old value was
  rejected: a release tag is always `v`-prefixed, so "preserving the authored style" would write
  `#0.13.0`, a tag that does not exist; and preserving an authored `owner/repo` that differs from the
  toolkit which rendered would leave CI fetching a repo that did not produce the lock.
- **A pin is never introduced.** Absent and unpinned are hard, byte-identical no-ops. Unpinned is a
  *choice* — it floats deliberately — and silently pinning it would change what a consumer's CI
  fetches without them asking.
- **The write lands between the migrations and the render.** `renderProject` re-reads `waffle.yaml`
  from disk, so one `upgrade` moves the config, the rendered output and the lock together. This is why
  it is not a migration: migrations get only `cwd` (so they cannot know `toVersion`), run only on
  `status: 'upgrade'`, and are for breaking changes — while the pins also need reconciling on
  `current`, which is exactly the state the already-broken repo is sitting in.

**Alternatives weighed**: **Re-exec** — have the pinned old CLI fetch and exec the newer one. Rejected,
re-affirming #373: a toolkit that silently runs a *different* toolkit is the unpinned-render class of
bug this epic exists to kill. Instead the pinned CLI **reports and names**: it already knows
`latestTag`, so it prints `a newer toolkit release exists: vX.Y.Z` with the exact pinned command, and
`/waffle-upgrade` runs it. It cannot run the fix; it can name it. **Bumping the pin to `latestTag`**
was likewise rejected — a pin records what *rendered*, never what was merely heard about.

**Affects**: `installer/lib/upgrade.mjs` (`reconcileToolkitRefPins`, `pinMoves`, `newerRelease`),
`installer/lib/toolkit-ref.mjs` (`toolkitPinFromIdentity`, `classifyToolkitRefValue`),
`installer/lib/project.mjs` (`setScalarIn` — in-place `Scalar.value` mutation, because `doc.setIn`
drops the comments attached to the node it replaces, and `waffle.yaml` is hand-authored). The
gitignored `waffle.local.yaml` overlay is neither read nor written (#317).

---

## 2026-07-13: The lock records a commit SHA only when it identifies immutable content (#374)

**Context**: `.waffle/waffle.lock.json` is documented as *the* authoritative marker of what
wafflestack produced. For the built-in toolkit it recorded one field — `toolkitVersion: "0.12.0"` —
and a version string does not identify content: `main` and the `v0.12.0` tag sat 74 commits apart
while both reporting `"version": "0.12.0"`, so two renders that differed by six files carried
identical provenance. External stacks had solved this for themselves years earlier, recording
`{source, ref, commit}` in a `sources` block. The toolkit every consumer depends on got a string.

**Decision**: Record the toolkit's resolved identity in a top-level `toolkit` block, keyed exactly
like a `sources[]` entry plus a `status` field — and **record the commit SHA if and only if
`status` is `release`**. Every other case writes `{ ref: null, commit: null, status }`, where the
status says *why*. No field in the block may be a function of a moving `HEAD`.

The obvious alternative — "record HEAD's SHA, it's better than nothing" — is not merely imperfect,
it is incoherent, and it is the decision most likely to be re-litigated by someone who has not
thought it through. Four reasons, of which the first two are each independently fatal:

1. **It is self-referential and has no fixed point.** This repo commits its own lock. A lock
   recording `HEAD` names the commit *before* the one that contains it. It is never right on the
   commit that ships it, and it cannot be made right.
2. **It is a false claim even when fresh.** A toolkit developer's tree is dirty by definition —
   rendering uncommitted `stacks/**` edits is the *point* of a local render — so `HEAD` does not
   identify the content that rendered. A provenance field naming content it did not produce, inside
   the artifact documented as the authoritative provenance marker, is a worse defect than the bare
   version string this issue exists to fix.
3. **It would churn the lock on every single commit** — a lock diff on every PR, a conflict on every
   long-lived branch (this repo already has a documented lock-conflict problem with the hygiene
   cron), and a permanent red on the shipped `render` + `git diff --exit-code` CI recipe.
4. **Null is not a degradation — it is the correct answer.** `status` is what makes a null block
   *say* something instead of merely *lack* something, which is precisely the courtesy the `sources`
   block already extends to a local-path source.

**Also decided, and for the same family of reasons: `doctor`'s new provenance check is a WARNING.**
`doctor.toolkitRef` ships **unpinned by default** and `waffle-doctor.yml` runs on every consumer PR,
so "mismatch is an error" would turn every consumer's required check red the moment we merge anything
to `main`. It would also add no coverage: `--verify-render` already re-renders and compares *bytes*,
so the only mismatch a provenance error could catch beyond it is one where the rendered content is
**identical** — a difference that provably did not matter. Erroring on a no-op is a pure false
positive. For the same reason `--verify-render`'s comparison stays `files`-only, with a comment at
the site saying so: extending it to provenance is the most natural-looking future change that would
red-gate the entire install base.

**Consequences**: This repo's own lock carries `{ ref: null, commit: null, status: "unreleased" }`
forever, and that block does not move when `main` moves — pinned by a test asserting that two renders
from unreleased toolkits differing *only* in commit produce a byte-identical lock. `doctor` gains the
capability the version string could never have: flagging **same version, different commit**, a re-cut
or force-pushed tag. `upgrade` reports the commit move even when the version did not change. And
`ref: null` means *"no provenance was captured"* — never *"this was not a release"* (the
`--allow-unreleased` hatch and pnpm/yarn `dlx` both forfeit a release that genuinely existed; #383).

## 2026-07-13: "Workflow" means the Claude primitive; our orchestrators are skills (#184, epic #347)

**Context**: The toolkit said **"workflow"** to mean three unrelated things: a **GitHub Actions
workflow** (`.github/workflows/*.yml`, plus the `github-workflow` stack and `git-workflow` skill), the
**Claude Code `Workflow` primitive** (a JS script in `.claude/workflows/` that orchestrates subagents —
real, documented, and unused by wafflestack), and **any deterministic multi-phase process** (prose only,
scattered across `SKILL.md` bodies and the root docs). Two of those three senses belong to somebody else:
GitHub mandates its path, and Anthropic owns its product vocabulary. Separately — and this turned out to
be the real bug — the `/audit` skill duplicates `/docs`: both spawn the same three agents over the same
doc sets, `stacks/orchestration/stack.yaml:484` already documents the shared roster as serving *"the audit
chain and the docs pipeline"*, and yet `/audit` never once references `/docs`.

**Decision**: **The bare word "workflow" is reserved for the Claude primitive.** GitHub's sense is
**always qualified** on first use ("GitHub Actions workflow"); as installable payloads those already have
a name — **syrup**. The generic sense is **banned**: say the **phases** or **steps** of a skill.

**The generic category gets no replacement noun — it is decomposed, not renamed.** Every "deterministic
multi-phase process" in the toolkit is already one of exactly two things: a **skill** (prose one agent
context interprets) or an **orchestrator skill** (a skill that spawns and sequences other agents — `audit`,
`docs`, `standup`, `delegate`, `autopilot`; all five live in the `orchestration` stack, and all 32 other
skills are outside it). Coining a third noun would preserve the very ambiguity this decision kills.

Two rules fall out of it:

- **A skill is the unit of work; orchestration is only ever sequencing.** A skill **never duplicates
  another skill's content — it invokes it.** An orchestrator holds only sequencing, gates, fan-out and
  loops. This, not any new primitive, is what fixes `/audit` ⊃ `/docs`.
- **Adopting the Claude `Workflow` primitive: not yet** — on a **three-item** gate, not the five-item one
  this spike started with (see Rationale): **#360** must land, **#364** must land, and **`/audit`'s human
  sign-off gate must be redesigned**. When it *is* adopted it ships as **opt-in syrup**
  (`files/.claude/workflows/*.js`) whose phases each invoke a skill — **no fourth item kind, but one
  additive, backward-compatible manifest field** (`targets:` on a `files:` entry, **#364**; *not* "no
  schema change") — with the prose orchestrator retained as the portable fallback, permanently.

Following the **#59** precedent (*rename the user-facing vocabulary; leave the load-bearing surfaces
alone*), the **`github-workflow` stack and `git-workflow` skill keep their names**: they are consumer
surfaces (lock keys, `.waffle/waffle.yaml` `stacks:` entries, `include:`/`eject:` refs), and "git workflow"
is idiomatic English for a branching strategy — there is no ambiguity to gain and a migration to pay.

**Alternatives considered**: (a) *Coin a food word — "recipe", "playbook", "pipeline" — for the generic
sense.* Genuinely on-brand (waffles / stacks / syrup / `bake`), and #183 is already extending the metaphor
(extension → topping). Rejected **here** and deferred **there**: minting a noun re-legitimises the third
category, which is the thing this spike exists to abolish. If the owner wants a food word for "orchestrator
skill", it belongs in the #347/#183 rename pass, not in a spike about disambiguation. (b) *Qualify every
use* ("GitHub Actions workflow" / "Claude workflow" / "generic workflow") — rejected: it keeps three
meanings alive and depends on every author remembering the adjective forever; discipline that requires
perpetual vigilance is not discipline. (c) *Rename the GitHub sense* — rejected: the path is GitHub's, and
the repo already has the right word for those payloads (syrup). (d) *Adopt workflows now as a fourth
portable item kind* — rejected: it reintroduces exactly the half-covered harness that **#94** was fought to
eliminate, and neither Codex nor agents-dir has any orchestration primitive to degrade to.

**Rationale**: The three-way collision is decided by ownership, not taste — two of the senses are
un-renameable, so the generic one is the only lever there is. The collision *between skills* is a
different problem than the collision *of the word*, and conflating them is what made this look like a
workflow question: **adopting the primitive would not have fixed `/audit` ⊃ `/docs`** — it would have moved
the duplication from prose into JavaScript. Composition fixes it, today, for free.

**On adoption, the honest gate is three items, not five** — and getting there cost this spike two
corrections, one of them embarrassing. Of the five it started with, three do not survive scrutiny as
*gates*, and a sixth had to be **added**: **②** claimed the
in-script API had *"no public specification"* — **that was false.** The `Workflow` tool's own entry carries
a section headed `Script body hooks:` specifying `agent()`, `pipeline()`, `parallel()`, `phase()`, `log()`,
`workflow()`, `args` and `budget`, with signatures; an earlier draft had this right and a later one
*retracted the true claim* on the strength of the narrative docs page alone. **A source that omits
something is not a source that denies it** — the residual risk is only that the spec lives in a tool
description rather than a *versioned* reference. **③** (a Claude-only kind breaks #94) the write-up
**resolves itself**: ship as opt-in syrup, which is path-specific by definition, so #94 — which governs the
two harness-neutral kinds — does not bite. **④** (paid-plans-only, version-gated v2.1.154+, org-wide kill
switch, so a rendered workflow can be *silently inert* in a consumer repo) *"never fully"* clears: it is not
a gate at all but a **permanent design constraint**, and it is exactly *why* the prose orchestrator must
remain the portable fallback forever.

What actually remains is **three items**: **⑤ #360 must land** — `/audit` is *unrunnable as written today*
(`TeamCreate`/`TeamDelete` no longer exist in the harness), and converting a broken skill is building on
sand; **⑥ #364 must land** — optional target scoping for syrup, without which "ship it as opt-in syrup"
drops Claude-only files into a codex-only repo (the write-up calls it a **hard prerequisite**, and it is an
*additive* schema change — it can and should land independently of the workflow decision); and **① a design
decision we owe ourselves** — `/audit`'s hard human gate after security pass 1 cannot be expressed inside a
workflow (*"No mid-run user input… For sign-off between stages, run each stage as its own workflow"*). A
*gate* is expressible as a hard abort; **sign-off with a human override is not**. So: **revisit when #360
and #364 have merged and ①'s gate is designed.** Point ⑤ is also the strongest argument *for* the
primitive: **prose orchestration has no compiler**, so it rots silently and fails at runtime, whereas a
workflow script is parsed before a single agent spawns and simply never runs.

**Impact**: Docs-only. Adds `docs/skills-vs-workflows.md` — the full spike write-up: the three-sense table,
what the Claude primitive actually is (verified against the live docs, including the constraints that
decide the answer), an inventory classifying all 37 skills, the `/audit` ⊃ `/docs` collision with evidence
that the two copies have **already drifted** (`/docs`'s architecture pass is read-only and threads its
change report into the doc passes; `/audit`'s "fixes all issues" and threads nothing), the per-target
degradation table, and an illustrative — **non-rendered** — JS sketch. No `stacks/**` change, so no
re-render and no lock churn. The vocabulary sweep across `stacks/**`, the `/audit`-invokes-`/docs` fix, the
workflow prototype, syrup target-scoping, and the owner-voiced-docs adoption all ship as follow-ups off
#184 and epic #347.

## 2026-07-13: The lock decides what `uninstall` may delete (#182, epic #346)

**Context**: `uninstall` / `reinstall` are the toolkit's **first destructive commands**. Everything
before them only ever *wrote* files. wafflestack renders into `.claude/`, `.github/`, `.waffle/` and
any syrup path, and shipped no way to take it back out — you hand-deleted across several
directories, guessing which files were yours and which were the toolkit's. Any command that deletes
needs an answer to one question: **which files are ours to delete?** Guess too wide and it eats the
consumer's work; guess too narrow and it leaves the orphans it exists to prevent.

**Decision**: **The lock is the only authority.** A path is deleted only if
`.waffle/waffle.lock.json` tracks it **and** its sha256 still equals exactly what wafflestack
rendered — the same comparison `doctor` makes. No globbing of known directories, no "looks
generated" heuristic.

Every other case follows from that one rule:

| Case | What happens | Why |
|------|--------------|-----|
| **Hash still matches** | Deleted | The lock says we wrote it and the bytes prove nobody changed it since |
| **Hand-edited** (*drifted*) | **Skipped** and reported; `--force` deletes it | The diff between the lock hash and the disk is the consumer's own work |
| **Unreadable** | Skipped, same as drifted | A hash we cannot verify cannot prove the file is ours |
| **Consumer-authored** | Never touched | It was never in the lock, so the rule never reaches it |
| **Ejected** | Announced, left in place | `eject` drops the item from the lock by construction — it is already project-owned |
| **Already gone** | No-op | Nothing to do |
| **Resolves outside the repo** | **The whole run refuses**, deleting nothing | See the escape gate below |

Three further choices fall out of it:

- **It is a dry run until `--yes`.** The CLI is non-interactive by design — agents and CI drive it —
  so the flag *is* the consent. There is no prompt to answer. Run it bare to see exactly what would
  go.
- **A lock key that escapes the repo refuses the entire run** — both a lexical `../…` and a key
  whose parent directory is an **in-tree symlink pointing out of the tree**.
- **`reinstall` snapshots before it deletes.** It removes the rendered files and re-renders the same
  selection, holding the deleted bytes in memory; if either leg fails, it puts them back. It needs
  no `--yes`, because every file it removes the render writes straight back.

**Alternatives considered**:

- **Delete by directory glob** (wipe `.claude/`, `.github/waffle-*.yml`, …) — rejected. Those
  directories hold consumer files too. A `.claude/settings.json` the consumer wrote is not ours to
  remove, and no glob can tell the difference.
- **Delete anything that "looks generated"** — rejected. That is a guess, and this command's whole
  problem is that guessing is what the consumer was already stuck doing by hand.
- **Delete drifted files anyway** — rejected as the default. Rendered output is commonly gitignored,
  so a hand-edited managed file may be the **only copy** of that work in existence. Skipping is
  recoverable; deleting is not. `--force` is there for people who mean it.
- **Prompt for confirmation** instead of `--yes` — rejected. A prompt is unanswerable in the CI and
  agent contexts this CLI is built for; it would either hang or be auto-confirmed, which is worse
  than a flag.

**Rationale**: The lock already knew the answer. It records every byte the toolkit wrote, and
`doctor` has always used it to detect hand-edits — so the safe deletion rule is the drift check the
toolkit was already making, with a delete on the end. That is what makes it *conservative by
construction*: a file the toolkit cannot prove it wrote, and prove is unchanged, is a file it does
not touch. The consumer's work is safe not because we remembered to check for it, but because it
can never satisfy the rule.

The escape gate is the one place that reasoning needed reinforcing, and **this audit's security pass
found the hole**: the lock is a **consumer-editable file**, so it is untrusted input. A hostile repo
could ship a symlinked directory plus a matching lock entry and have the toolkit delete files
*outside* the tree — and since `--force` drops the hash gate, the escape would not even need the
content to match. `path.resolve` collapses `../` textually but does not follow links, so the lexical
check alone was not enough. `resolveInside` now also canonicalises the deepest *existing* ancestor
of each path, and the delete loop re-checks it.

**Impact**: New module `installer/lib/uninstall.mjs` (19 lib modules, up from 18) and three new CLI
commands — `uninstall`, `reinstall`, and `help`. Nothing existing changes behavior. Consumers get a
supported way to remove the toolkit; before this, there was none.

**Known gaps — tracked in #359, not fixed here.** Four rough edges ship with this:

- An **interrupted uninstall** (one that skipped a hand-edited file) keeps the lock, but still
  deletes the config and strips the `.gitignore` block — so the leftovers are recoverable, but the
  selection around them is not.
- **`reinstall` hard-fails** on a repo that has a config but no lock (configured, never rendered).
- An **incomplete `uninstall --yes` still exits 0** — a skip is not currently an error.
- **`--no-color` is missing** from the `help` flag list.

---

## 2026-07-13: Asking for help is a success; a bad invocation is still an error (#187, #176)

**Context**: Asking wafflestack for help was an **error**. `help`, `--help` and `-h` all fell through
to the dispatch switch's `default:` case, which printed the usage banner to **stderr** and exited
**1**. `wafflestack help | less` showed nothing, and a script could not tell "the user asked for
help" from "the user typed a command that doesn't exist."

**Decision**: Split the two cases apart.

- **`help` / `--help` / `-h`** print the banner, usage, and one line per command and per flag to
  **stdout**, exit **0**.
- **An unknown command** still prints usage to **stderr** and exits **1**.
- **Bare `wafflestack`** (no command) also stays on the **error** path — deliberately.
- **`--help` after a command** is caught *before* dispatch, so `wafflestack uninstall --help`
  explains instead of deleting.
- **`bake`** joins as a pure alias for `render` — a fall-through case sharing its body, flags and
  guards. The metaphor, all the way down.

**Alternatives considered**: Make bare `wafflestack` print help and exit 0, the way many CLIs do —
rejected. A script that builds an argument list and ends up passing **nothing** has a bug, and a
zero exit hides it. Typing the bare word at a prompt costs you a usage banner either way; the
difference only shows up where it matters, in automation.

**Rationale**: Exit codes are the API for the agents and CI jobs that drive this CLI. "I asked a
question" and "I fumbled the command" are different outcomes and must not share an exit code.

**Impact**: `installer/cli.mjs` only. The one command whose `--help` mattered most —
`uninstall` — cannot now be triggered by someone trying to read about it.

---

## 2026-07-11: Pin `doctor.toolkitRef` to a release tag *before* arming `--verify-render` (#322)

**Context**: `--verify-render` (below) is the one doctor feature that makes the **toolkit itself
load-bearing**: it re-renders a consumer's committed config using whatever toolkit
`npx --yes <doctor.toolkitRef>` fetched at that moment. The default ref is **unpinned** — it
resolves to the toolkit's default branch at CI time. For the plain drift check that was merely
untidy (it never reads the toolkit, only hashes files against the lock), but with the flag armed an
upstream content release re-renders the consumer's config with a **newer toolkit than their lock was
built from** — turning their next, unrelated PR red with no change on their side. We recommended
arming the flag and never said to pin first.

**Decision**: A documented policy — **pin first, arm second**. The `doctor.flags` and
`doctor.toolkitRef` setup notes in `stacks/github-workflow/stack.yaml` both now say to set
`doctor.toolkitRef` to a release tag (e.g. `github:dustinkeeton/wafflestack#v0.11.0`) *before*
adding `--verify-render`, and the gitignore guide's lock-only recipe leads with the pinned ref —
honestly "two config lines", not one.

**Alternatives considered**: Changing the flag itself — rejected. The flag is behaving correctly
(it still catches a consumer's own forgotten re-render); the failure mode is the floating ref, and
pinning already solves it. Prose only, no engine change.

**Rationale**: A consumer should take new toolkit content deliberately, via `wafflestack upgrade` —
not on the toolkit's release cadence, through a red check on an unrelated PR.

**Impact**: `stack.yaml` config descriptions and `docs/gitignore.md` only. A consumer already
running `--verify-render` against an unpinned ref should pin to a release tag and re-render.

---

## 2026-07-11: PR-gate scratch paths are namespaced per PR, with a read-back-before-post rule (#324)

**Context**: The three PR-gate skills — `qa`, `adversarial-review`, and `pr-response` — each staged
their review/reply payload at a **fixed, shared** `/tmp` path (e.g. `/tmp/qa-review.json`) and
handed that path straight to `gh` as `--input`/`--body-file`. Nothing in the path identified the PR,
so every invocation across every PR reused the same files. A near-miss made it concrete: during the
autopilot run on PR #321, the `qa` gate found `/tmp/qa-review.json` still holding a payload from an
earlier run on **PR #285** — one step from posting it to #321 as a legitimate-looking gate review.
Only the agent's own read-before-post habit caught it. Worse, autopilot runs these gates *per PR,
concurrently*, so two runs interleaving a write and a post can put PR A's findings onto PR B — and
those findings then steer `pr-response`'s implement/defer/decline verdicts on the wrong PR.

**Decision**: Two changes in each of the three skills:

- **Namespace every staging path by PR number** — `${TMPDIR:-/tmp}/waffle-<skill>-<artifact>-$N.<ext>`
  (`$N` was already in scope at every call site), so two concurrent gates can never touch the same
  file. The skills now call an un-namespaced path a correctness bug, not a style nit.
- **Make the read-back rule explicit** — immediately before posting, `Read` the exact file about to
  be handed to `gh`, confirm it is *this* PR's payload, and **stop rather than post** if it is not.
  The habit that caught the near-miss by luck is now an instruction.

Each skill also warns that the `Write` tool does not expand `$N`/`${TMPDIR:-/tmp}` — pass it a
literal, already-substituted path.

**Alternatives considered**: Keeping the fixed paths and relying on the read-back habit alone —
rejected. The near-miss showed the habit is a lucky last line, and it cannot stop the concurrent
interleaving case at all; only distinct paths do.

**Rationale**: A review payload is one `gh` call away from being public and steering code changes.
The path must make cross-PR contamination impossible; the read-back makes staleness on the *right*
path visible too.

**Impact**: `qa`, `adversarial-review`, and `pr-response` SKILL.md staging paths and post
procedure. Consumers re-render to pick it up; every documented `gh` command stays single-line.

---

## 2026-07-11: This repo gates its own committed render with `doctor --verify-render` (#314, #316)

**Context**: The plain `waffle-doctor` drift gate asks one question — do the committed files still
hash to the committed lock? — and never asks whether *either* still reflects the inputs. So a
`stacks/**` or `.waffle/waffle.yaml` edit that is never re-rendered leaves the files and the lock
stale **together**: they agree with each other and the gate goes green. In this repo that is a live
hazard, not a hypothetical — 113 of the 223 commits before the fix touched `stacks/`.

**Decision**: Two pieces:

- **A new doctor flag, `--verify-render` (#314)** — re-renders the **committed** inputs (config +
  extensions + toolkit, no local overlay) into a **temp directory** and diffs the result against the
  committed, canonical lock. The working tree is never touched, which is what makes it non-circular:
  gating on an in-place `render` would rewrite the very lock it then checks. It composes with
  `--allow-missing`, making `--allow-missing --verify-render` the real gate for the lock-only
  posture (commit nothing but the lock, verify by re-rendering).
- **A dogfood gate in `tests.yml` (#316)** — this repo's project-owned `.github/workflows/tests.yml`
  now ends with `node installer/cli.mjs doctor --allow-missing --verify-render`, run with the
  **checkout's own CLI**, so the render under test is the PR's own `stacks/**`.

**Alternatives considered**: Arming the flag via `doctor.flags` on the shipped `waffle-doctor`
workflow, like a consumer would — rejected for this repo. That workflow fetches its toolkit via
`npx github:dustinkeeton/wafflestack`, i.e. from main — the wrong toolkit for the toolkit's own PRs
in **both directions**: a PR that edits `stacks/**` and correctly re-renders false-REDs (its lock is
ahead of main), and one that forgets to re-render false-GREENs (main's unchanged stacks still
reproduce the stale lock exactly).

**Rationale**: `tests.yml` is the workflow that already runs `npm ci` and is already a required
check — and only the checkout's own CLI renders the PR's own inputs.

**Impact**: `installer/lib/doctor.mjs` (+ render's temp-dir mode) and `.github/workflows/tests.yml`.
For consumers the flag is opt-in via the existing `doctor.flags` key — but see the pin-before-arm
policy (#322, above) first.

---

## 2026-07-11: Delegate's specialists get the report-back tools they were told to use (#320)

**Context**: `delegate`'s routing table names exactly three specialists — `harness-architect`,
`docs-agent`, and `docs-human` — and its agent-prompt template closes by telling each to report with
`SendMessage(to: "team-lead", …)` and close its task with `TaskUpdate(…, status: "completed")`.
**None of the three was granted either tool.** A delegated specialist finished silently: it could
not hand back its PR URL, could not close its task, and could not answer the orchestrator's
`shutdown_request`. The skill had even grown a "Silent specialists" section telling the orchestrator
to go verify the branch by hand — a documented workaround for a missing capability.

**Decision**: Grant `SendMessage` + `TaskUpdate` in all three agents' frontmatter, and pin
delegate's roster against its toolset with a content test so the two cannot drift apart again.

**Alternatives considered**:

- **Keep the "Silent specialists" workaround.** Rejected — naming an agent in-scope for a protocol
  it provably cannot execute is the bug (the same defect #303 fixed for the `issue` skill's callers,
  one layer down).
- **Grant the full task-tool set.** Deliberately not done: no `TaskCreate` (a worker doesn't open
  work — that's `task-planner`'s job) and no `TaskList`/`TaskGet` (the orchestrator injects the task
  id; a worker has no business browsing the board).

**Rationale**: A delegated run was stalling with its work complete but unreported, and the
orchestrator only noticed by polling the worktree. The fix is the capability, not more workaround
prose.

**Impact**: The three agents' frontmatter `tools:` lists and the delegate skill (workaround section
removed). Consumers re-render; delegated specialists now report their PR and close their task.

---

## 2026-07-11: The committed lock records the canonical render; a local lock records yours (#317)

**Context**: `.waffle/waffle.local.yaml` is a developer's private, gitignored, per-machine overlay —
and it leaked anyway. `render` hashed the **effective** render (overlay values baked in) into the
**committed** `.waffle/waffle.lock.json`, so any overlay value that fed a template was fingerprinted
into git. Two teammates with different personal `git.botEmail` overrides produced *different*
committed lock hashes from the same source; each one's commit reverted the other's, and the loser's
`doctor` went red. Gitignoring the render didn't help (the locks still diverged); committing it was
worse (the personal address landed literally in git).

**Decision**: **Split the lock in two.**

- **`.waffle/waffle.lock.json` (committed) is now canonical** — it hashes what the committed inputs
  alone (`.waffle/waffle.yaml` + `.waffle/extensions/`) produce, overlay excluded. That makes it
  **byte-identical on every machine**, and `doctor --verify-render` can reproduce it in CI.
  Extensions still propagate — committed, therefore canonical, is the whole contrast with the
  overlay.
- **`.waffle/waffle.local.lock.json` (gitignored) records the render this machine actually wrote**,
  overlay included. It exists only while the overlay changes an output byte. Every working-tree
  check — `doctor` drift, `list` status, `render`'s prune/clobber bookkeeping — reads it in
  preference via `readTreeLock()`, so a hand-edit is still caught locally. `--verify-render`
  deliberately does *not*: it stays on the canonical pair.
- **One value may no longer hide in the overlay**: a `required:` key with no `default:`, since the
  canonical render must be buildable from committed inputs. `render` fails loudly and names the key.

**Alternatives considered**:

- **#308's way-station** — a `lock.renderedWithLocalOverlay` flag plus a doctor "cannot verify the
  render" refusal. Superseded and removed: with a canonical lock there is nothing ambiguous left to
  refuse.
- **"Commit the values your render reads."** The #308-era guidance is withdrawn — nobody should be
  red-gated into committing a personal value.
- **Gitignore or commit the render.** Both were shown not to help: private renders still diverged
  the locks; a committed render carried the personal value literally.

**Rationale**: Integrity isn't relaxed, it's measured against the right thing twice: the committed
lock against what the *repo* says, the local lock against what *your machine* wrote.

**Impact**: `render` (computes both renders), `doctor`/`list` (read the tree lock), new
`readTreeLock`/`readLocalLock` in the installer API, and `.gitignore` (`render --gitignore` adds the
new entry; `render` warns if missing). A repo whose overlay affects the render sees a one-time
committed-lock diff; a repo with no render-affecting overlay is entirely unaffected.

---

## 2026-07-12: CI hooks key on out-of-band signals, never on a marker pasted in prose (#338)

**Context**: Both review hooks decided "the bot did a thing" by string-matching a marker literal
inside a **free-text body anyone can write** — a review, a PR comment. Every failure in #211, #332
and #333 is one variant of that single mechanism, not three bugs: a human comment on PR #207 (literal
at offset 1084) read as "the bot already replied"; a QA review on PR #296 (offset 1103) read as "this
head is already reviewed" **and** "this IS the bot's review", so the security review silently never
ran while a paid, committing job dispatched on the QA review. Each fix narrowed the match — bare word
→ full literal → marker-**led** — and each only shrank the target, because a marker-led body is still
prose and a human can type a marker on line 1 as easily as at offset 1103. Worse, it created a
**prose-to-prose coupling no test could pin**: a workflow's `jq startswith()` depending on a sentence
in a SKILL.md instructing a model where to put a marker.

**Decision**: Delivery and idempotency are decided by artifacts that take **repo push access** to
write, and no hook predicate reads a body:
- **pr-green** — dedup and delivery both key on a `waffle/adversarial-review` **commit status** on the
  reviewed head SHA, which the harness writes after its review lands.
- **pr-response** — its *trigger* becomes `workflow_run` on waffle-pr-green-hook (a body cannot raise
  that event, so the whole quote class dies at the event layer); delivery keys on a `waffle/pr-response`
  commit status; and the **loop bound** becomes a per-PR **label** that the *workflow* applies **before**
  the paid dispatch.
The markers **stay** in the bodies — they are how a human recognizes a bot post and how the skills
dedup their own — but nothing in CI reads them, so quoting one is now harmless.

**Alternatives considered**: A **check run** (#338's own proposal) — rejected on a hard blocker:
creating one is GitHub-App-only ("OAuth apps and authenticated users are not able to create a check
suite"), and the harness may authenticate with a PAT (`WAFFLE_HYGIENE_TOKEN`), so it would be
uncreatable in the *recommended* configuration. A commit status needs only push access and is
otherwise identical — keyed to the SHA, structured, visible in the checks list, unforgeable without
repo write. A **commit status for the loop bound** — rejected: a rebase or force-push orphans it and
silently **re-arms** the paid loop, which is weaker than what it replaced. The bound must survive
history rewrites, so it is per-PR state (a label). Inferring delivery from a **review-ID delta** —
rejected: a human review landing in the same window would fake delivery, and that fails *open*.

**Rationale**: The asymmetry the old hooks documented ("do NOT unify them, the asymmetry **is** the
design") was right *for the marker mechanism* only. It survives, but re-expressed structurally — not
as loose-vs-strict string matching but as **who writes the signal, and when**: signals that ADMIT work
(idempotency, delivery) are written by the harness *after* the work, so their absence errs toward
doing it; the signal that BOUNDS work is written by the workflow *before the money*, so a crashed,
timed-out, or tool-denied run is still bounded. The bound is therefore **strictly tighter** than the
marked-comment bound it replaces, which a crashed harness simply failed to set.

**Impact**: Both hook workflows, `adversarial-review` / `pr-response` SKILL.md (the coupling prose is
gone), `REVIEW_TEMPLATE.md` (pasting a marker is now hygiene, not a safety hazard). New config key
`prResponse.responseLabel` (default `waffle:pr-response`) and a matching `prerequisites:` entry — the
label **must pre-exist**; the bound is fail-closed, so without it the job reds rather than dispatching
an unbounded run. pr-response's job also takes `statuses: write` (still **no** `issues: write`).
Consumers who installed the pr-response hook must create the label. Closes #333.

---

## 2026-07-11: `pr-response` appends a comment per round — it never PATCHes its prior reply (#318)

**Context**: The skill's idempotency section told the responder to find its last
`<!-- waffle-pr-response -->`-marked comment and **`PATCH`** it, so one comment would carry "the
current, complete verdict table." Following that destroys the paper trail: round 2 silently replaces
round 1, and the record of what was found, how it scored, and why it was disposed of *on the
evidence available at the time* is gone. That record is the skill's entire product — the rubric
exists to make judgment legible and recalibratable, and you cannot recalibrate against verdicts you
deleted. The rule also contradicted the skill's own cold-start step, which reads the prior reply as
history.

**Decision**: **Append-only.** Each round posts a **new** marked comment, labelled with its round
and the head SHA it answers. Marked comments are read-only history — read them all, oldest first,
write only new ones. A verdict that genuinely changes is stated in the new comment with the new
evidence named, never retconned into the old one.

**Alternatives considered**: Keeping the single always-current comment — rejected. Tidiness was the
whole argument for PATCH, and it costs the verdict history that reviews are recalibrated against.

**Rationale**: The trail of per-round verdicts *is* the product. A multi-round PR growing one
comment per round is the point, not clutter.

**Impact**: `pr-response` SKILL.md (PATCH section removed). Consumers re-render; expect one
`waffle-pr-response` comment per round on multi-round PRs.

---

## 2026-07-10: The default co-author trailer credits the consuming repo's owner (#284, refined by #291)

**Context**: Agent-authored commits carried a `Co-authored-by:` trailer whose default named the
**harness** at `noreply@anthropic.com`. That credited nobody useful: the address isn't verified to
anyone's GitHub account, so it earned no contribution-graph credit, and it tied the commit to the
harness vendor rather than to the person who actually initiated and merged the work. What a consumer
usually wants is for **their own** contribution graph to reflect the agent work they drive.

**Decision**: Flip the default trailer to credit the **consuming repo's owner**, via two new config
keys.

- **Two new keys — `git.ownerName` / `git.ownerEmail`** — declared in **both** the `github-workflow`
  and `orchestration` stacks (orchestration's `delegate` nests them in its own default), byte-identical
  across the two so they stay in lockstep.
- **The `git.coAuthorTrailer` default flips** from the harness-noreply form to
  `Co-authored-by: {{git.ownerName}} <{{git.ownerEmail}}>` (nested substitution). The agent keeps its
  **displayed author identity**; only the co-author line changes.
- **Credit only lands when it's set up right.** The owner email must be **verified on the owner's
  GitHub account** — GitHub grants contribution-graph credit to a co-author email only when it's
  verified there. The private `ID+user@users.noreply.github.com` address works. Credit accrues **only
  for commits that reach the default branch**. CI/worktree repos should commit the values in
  `.waffle/waffle.yaml`, not the gitignored overlay (an overlay-held value renders the placeholder in
  CI and reds the doctor gate).
- **This repo dogfoods it** — `.waffle/waffle.yaml` now sets Dustin's `git.ownerName` /
  `git.ownerEmail`, replacing the earlier hardcoded `coAuthorTrailer` override.

**Refinements from #291** (owner-review follow-ups, same day):

- **A name-appropriate allowlist for `git.ownerName`.** It had reused `git.botName`'s ASCII-only
  guard, which hard-failed the render on legitimate names — `O'Brien`, `José`, `Müller`, `Nguyễn`.
  But `ownerName` only lands in **inert splice sites** (a Markdown code span and single-quoted
  heredoc bodies), never an unquoted shell word the way `botName` does via `git.cmd` — so `botName`'s
  shell-safety rationale doesn't apply. The looser allowlist admits an apostrophe and common
  accented Latin letters while still rejecting backticks, `$`, backslashes, newlines, and a surviving
  `${{ }}` expression. Scripts outside that range (e.g. CJK) are still rejected — fall back to a Latin
  transliteration for the display name; the **email** is what drives the actual credit.
- **A "set both or neither" callout.** The two keys carry independent placeholder defaults, so a repo
  that set only `git.ownerName` rendered a trailer that *looked* configured (a real name) but still
  credited nobody, because the email — the field GitHub keys credit on — stayed the placeholder. The
  render succeeds silently; nothing warns. The setup note now spells this out, pinned by a test.

**Alternatives considered**:

- **Keep the harness-noreply default.** Rejected — it credits nobody's contribution graph and ties
  the commit to the harness vendor rather than the person driving the work.
- **Reuse `git.botName`'s strict ASCII allowlist for `ownerName`.** Rejected in #291 — it's a real
  person's display name in inert splice sites, so the shell-hardening that justifies `botName`'s
  strictness doesn't apply, and rejecting `O'Brien`/`José` at a hard render failure is a footgun.
- **Warn on a half-set pair.** Not taken — the render stays warning-free here; instead the setup note
  and a test make the "set both or neither" rule explicit and exercised.

**Rationale**: The person who initiates and merges agent work should get the contribution credit for
it, and the honest way to do that is a verified co-author email on default-branch commits. The keys
are declared, guarded, and substituted like every other config value, so there's no magic — just a
better default.

**Impact**: `stacks/github-workflow/stack.yaml` and `stacks/orchestration/stack.yaml` (the two new
keys + the flipped default, kept byte-identical), `installer/lib/template.mjs`, the git-workflow and
delegate skill prose, and this repo's `.waffle/waffle.yaml`. **Additive with no migration** — the
default resolves at render, mutating no consumer file; an explicit `git.coAuthorTrailer` override is
honored unchanged. Unset owner keys fall back to a well-formed but inert placeholder trailer
(`Repository Owner <owner@users.noreply.github.com>`), so a consumer must set the real, verified
values to actually earn credit. A repo that would rather credit the bot points `coAuthorTrailer` at
`{{git.botName}} <{{git.botEmail}}>`.

---

## 2026-07-10: A programmatic Gravatar pipeline for per-agent avatars, and a default bot-email flip (#285)

**Context**: Each spawned agent commits under a deterministic per-agent email
(`bot+<slug>@…`, plus-addressed off the bot's base) and has a deterministic avatar SVG
(a pure function of its name + granted-skill count). GitHub shows a commit's avatar from
its author email's Gravatar — so per-agent avatars are *possible*, but only if someone
registers each avatar on Gravatar for each address. That was a **manual, error-prone web
chore** documented in `.waffle/AVATARS.md`: upload a PNG, set its rating, assign it to the
address, repeat for every agent, and keep it in sync as the roster changes. Nothing checked
whether it had drifted.

**Decision**: Ship an **owner-side CLI pipeline** that automates the registration, and flip
the default bot email so a consumer on defaults inherits the result for free.

- **`wafflestack avatars sync`** — enumerates the installed agent roster with its derived
  commit emails (the *same* derivation the `AVATARS.md` manifest prints, now via a shared
  `waffledocs.mjs#collectAgentAvatars`, so pipeline and manifest never drift), rasterizes each
  avatar SVG → 512px **G-rated** PNG, and for every email **already verified** on the Gravatar
  account uploads and assigns it over the Gravatar v3 REST API. Idempotent — a re-run recovers.
- **`wafflestack avatars status`** — probes without writing and reports **roster drift** (an
  installed agent whose address is unregistered), **exiting non-zero** so CI/scripts can gate.
- **Address add/verify stays manual** — Gravatar exposes **no API to add or verify a new
  email**, so an unverified address is reported as a "verify at gravatar.com, then re-run"
  remainder. This is the one tolerated manual step; the toolkit is feasibility-honest about it
  rather than pretending to automate what the API can't.
- **Token is env-only** — the owner-only OAuth2 token is read from `WAFFLE_GRAVATAR_TOKEN` at
  runtime; it is **never a flag and never rendered into a committed file**.
- **Default `git.botEmail` flips** from the `wafflebot@users.noreply.github.com` placeholder to
  the toolkit-owned, subaddressable **`bot@wafflenet.io`**. A project on defaults now gets
  distinct per-agent `bot+<slug>@…` author emails and — once the toolkit owner has run `avatars
  sync` — per-agent avatars on GitHub, with **zero consumer setup**. A consumer that overrides
  `git.botEmail` re-runs the same command against its own domain and Gravatar account.

**Alternatives considered**:

- **Keep the manual `AVATARS.md` procedure.** Rejected — it doesn't scale with the roster and
  silently drifts; nothing verified it was current.
- **A native SVG-rasterizer dependency.** Rejected — heavy for one owner-side command. The
  rasterizer shells out to whichever converter the machine has (`rsvg-convert`, ImageMagick
  `magick`/`convert`, or a zero-install `npx svgexport`) behind an injected function, and fails
  clearly when none is found. Both the HTTP client and the rasterizer are **injected**, so
  `npm test` mocks them and makes no network or native calls.
- **Auto-add/verify emails via the API.** Not possible — Gravatar has no such endpoint; hence
  the honest manual remainder.
- **Keep the old noreply default.** Rejected — it can't subaddress, so agents can't get
  distinct addresses (or avatars); they'd differ by name only.

**Trade-off (recorded honestly)**: default commits now carry a **toolkit-domain author email**
(`bot@wafflenet.io`) unless a project overrides it, and the old noreply default's "Verified
badge for free" property is forfeited on defaults — a subaddressable base gets **avatars XOR a
verified sub-agent commit**, and the default deliberately prefers avatars + no badge. A repo
that sets its own `git.botEmail` is unaffected. **No migration** — `render` picks up the new
default; a repo that commits its render and leaned on the old default will see a re-render diff.

**Impact**: New CLI command `avatars` (command count **9 → 10**) and new module
`installer/lib/avatars-sync.mjs` (**17 → 18** pipeline modules); `waffledocs.mjs` gains the
shared `collectAgentAvatars` enumeration. `.waffle/AVATARS.md` regenerates to describe the
pipeline instead of the manual procedure. Additive apart from the default-email flip, which is
a consumer-facing default change with no migration step.

---

## 2026-07-09: docs-system's default machine-doc shape becomes layout-adaptive, not `src/`-feature-assuming (#217)

**Context**: The `docs-system` stack's `docs.machineDocSpec` / `docs.machineDocSet` defaults — the
file set and format rules a consumer's docs-agent writes against when it doesn't override them —
assumed a per-feature application layout: a root `AGENTS.md` **plus** a per-feature
`src/<feature>/AGENTS.md`. For a consumer with a **flat `src/`** (a handful of files, no per-feature
subdirectories), that default instructed the doc writer to produce per-feature docs for directories
that don't exist — **inventing phantom `src/<feature>/AGENTS.md` files on the very first docs run**,
the exact docs-vs-reality drift the toolkit exists to prevent. The two stacks that name the same
file set (docs-system, and orchestration, which cites it in its docs/audit orchestrator prompts) had
also drifted slightly in wording.

**Decision**: Make the default **layout-adaptive** rather than layout-assuming, without dropping
per-feature docs where they're warranted:

- The default **always** produces the root `AGENTS.md`, and adds per-feature `src/<feature>/AGENTS.md`
  files **only when the code is actually split into feature/module directories** — with an explicit
  instruction **not to create docs for directories that don't exist** (fold that detail into the
  root registry instead).
- The root registry line generalizes from a "module registry" to a **module/component registry**
  over the codebase's real units — feature directories where they exist, otherwise the files or
  layers of a flat `src/`.
- Sync the one-line `docs.machineDocSet` default **byte-identically** across docs-system and
  orchestration, so the two stacks that refer to "the machine docs" stay in lockstep.
- Sharpen the `docs.machineDocSpec` description: the default now adapts to layout, so a flat `src/`
  needs **no override**; override only for a fundamentally different machine-doc shape (e.g. a single
  root registry with a module/layer table — which is exactly what this repo does).
- Add a docs-system **`setup:` block** steering a flat-`src/` consumer before its first docs run:
  check `src/`, keep the default when it has feature subdirectories, and reach for an override only
  to force a specific shape.

**Alternatives considered**:

- **Keep the `src/`-feature default and make flat-`src/` consumers override it.** Rejected — it left
  the common flat-repo case a footgun that surfaced only as phantom directories on the first docs
  run, well after the choice was made.
- **Go fully layout-agnostic — drop the per-feature default and always emit a single root
  registry.** Rejected — the per-feature shape is genuinely the right default for a real
  `src/<feature>` application. Adapting to the layout keeps that win while also covering flat repos,
  where a root-only default would under-document a large feature-split codebase.

**Rationale**: The default should describe the repo it's pointed at, not assume one. Layout-adaptive
gets both common cases right with no override, and the explicit "don't invent directories"
instruction turns a silent footgun into a guardrail. The `setup:` block and sharpened description
hand a flat-`src/` consumer the override path up front for the cases where they do want a specific
shape.

**Impact**: `stacks/docs-system/stack.yaml` (the two defaults, the description, and a new `setup:`
block) and `stacks/orchestration/stack.yaml` (the synced `machineDocSet` default) only. A
**consumer-facing default change with no migration** — a consumer taking the default now gets
layout-adaptive machine docs; a consumer that already overrides both keys is unaffected. This repo
is one of the latter (it pins a single-root `AGENTS.md` registry in `.waffle/waffle.yaml`), so **its
own render is unchanged** — no re-render or lock diff here. Child of epic #191, sibling to the #216
init-starter decision below.

---

## 2026-07-09: Seed `project.name` in the init starter config; defer a consumer-config preflight (#216)

**Context**: `wafflestack init` scaffolds `.waffle/waffle.yaml` from a starter template whose
`config:` block was empty (`{}`) and never mentioned `project.name`. But the `github-workflow`
stack declares `project.name` as **required with no default**, so a consumer who enabled that
stack hit a **render failure** only after discovering and adding the key by hand. `wafflestack
validate` gave false assurance here — it lints the *toolkit's* own definitions, never the
*consumer's* project config — so the missing key surfaced at render time, not before.

**Decision**: Make the required key **discoverable at init** rather than build a new check for
it. `init`'s starter now seeds a commented `project.name` example (placed before the existing
`git.botEmail` comment, with an inline note on why it's required). The block is switched to a
block-style `config:` (empty, parsing to null → normalized to `{}` by the loader) so that
uncommenting the two example lines yields valid YAML instead of an "all mapping items must start
at the same column" error. The existing render error stays the enforcement point: it already
fails non-destructively (exit 1, no files written) and names the exact missing key, the offending
stack, and where to add it.

**Alternatives considered**: A **consumer-config preflight** — deliberately **deferred**.
Extending `validate` to check consumer config was rejected: it would conflate the
toolkit-developer lint audience with the consumer audience and risk drifting from the real render
check. A `render --check` dry-run is a cleaner, separable follow-up (its own issue under epic
#191) rather than something forced into this change.

**Rationale**: The render failure already names `config.project.name` actionably and
non-destructively, so a discoverable starter comment closes the "didn't know the key existed" gap
at near-zero cost, where a dedicated preflight adds CLI surface for marginal value. Keep the
single source of truth — render — as the check.

**Impact**: `installer/lib/eject.mjs` (starter template) + tests only — **no `stacks/**` change,
so no re-render or lock commit**. `init`'s output is behavior-identical (the example stays
commented, so `config:` still parses as an empty map). A consumer-config preflight remains an
open, deferred follow-up under epic #191.

---

## 2026-07-08: Hook arming/dogfood state lives in DECISIONS, not waffle.yaml comments (#189)

**Context**: Installing `waffle-post-merge-hook` (#189) ran `wafflestack install`, which
re-serialized `.waffle/waffle.yaml` and silently stripped ~16 lines of `include:` comments — the
only record of which secrets/tokens arm which dogfooded hook, and when. The armed pr-green
adversarial review (#112) flagged it as a should-fix: `doctor` can't catch the loss because
`waffle.yaml` is source config, not a lock-hashed render, and the knowledge isn't recoverable
anywhere else in the tree.

**Decision**: Treat `waffle.yaml` comments as non-durable and record hook arming/dogfood state here
instead. State as of this entry:

- **waffle-hygiene.yml (#46)** — ARMED 2026-07-03: `ANTHROPIC_API_KEY` + `WAFFLE_HYGIENE_TOKEN`
  secrets set, auto-merge enabled, rendered `.claude/skills` committed, and the `doctor` check
  required on `main` so the daily hygiene PR can auto-merge.
- **waffle-release-hook.yml (#39)** — dogfooded so a labeled bump PR gets auto-tagged on merge; its
  rendered workflow is committed. The Claude-dispatched `waffle-label-hook` stays gitignored /
  uninstalled.
- **waffle-pr-green-hook.yml (#112)** — ARMED: on every green PR it dispatches the `adversarial-review`
  skill to post a hostile pre-merge review (once per green transition, deduped by the
  `waffle/adversarial-review` **commit status** on the reviewed head — #338, never by a marker in a
  body). Needs `ANTHROPIC_API_KEY` + a PR review-write token.
- **waffle-post-merge-hook.yml (#67/#114)** — installed here (#189): deterministic remote merged-head
  branch delete, `contents: write`, no Claude dispatch / no API spend.

**Alternatives considered**: Restore the comments in `waffle.yaml` — rejected: the CLI is a lossy
YAML round-trip for comments, so the next `install`/`upgrade` strips them again. A `STATUS.md` note —
rejected: STATUS is a capped (<100-line) rolling snapshot, not an append-only durable record.

**Rationale**: `DECISIONS.md` is append-only and not lock-managed, so it survives re-render and keeps
history. This mirrors the 2026-07-02 label-hook entry (#27), which likewise folded a workflow's
operational rationale — and an adversarial finding about it — into the decision log rather than a YAML
comment.

**Impact**: `.waffle/waffle.yaml` stays comment-free by design; hook arming/dogfood state is tracked
here going forward. Future arming changes append a new entry rather than editing YAML comments.

---

## 2026-07-08: External third-party stacks — pull a stack from a pinned git source (#88, #124–#127)

**Context**: Every stack had to live inside this toolkit. A team that wanted to ship its own
agents and skills through the same render / lock / `doctor` pipeline had no way in — it would
have to fork wafflestack or hand-roll its own copier.

**Decision**: A `stacks:` entry can now be **either** a bare built-in name **or** a
`{ name, source, ref }` mapping that points at a third-party source — a git URL (pinned to a
**required** `ref`) or a local filesystem path. At render, external sources are resolved (a git
source is fetched at the pinned ref into a content-addressed cache; a local path is read in place)
and merged into one registry alongside the built-ins, so a **single render / lock / `doctor`
pipeline handles built-in and external stacks alike**. A new module (`installer/lib/sources.mjs`)
does the resolution; a new author's guide (`schema/AUTHORING-EXTERNAL-STACKS.md`) documents the
source side.

Safeguards that come with the trust boundary:

- **Provenance in the lock** — external files are recorded under a `sources` block (source, ref,
  resolved commit, files). `doctor` attributes any drift to its source, and `upgrade` re-resolves
  each pin and reports commit moves.
- **Validation before any write** — `render` lint-validates every external stack before writing a
  byte (#126), and pouring external opt-in syrup emits an extra acknowledgement warning.
- **Security hardening** — a git `source` or `ref` beginning with `-` is rejected (an
  argument-injection guard), belt-and-braces with a `--` end-of-options marker at the git call.
- **Name collisions** across sources are a hard error naming both.

**Alternatives considered**: A plugin / npm-dependency model — rejected: the whole point is the
shadcn-style copy-in, and a package dependency would reintroduce exactly the `postinstall`
machinery wafflestack avoids. Trusting external content unchecked — rejected: external stacks get
the same `validate` lint as built-ins plus a syrup-tier confirmation, because their content lands
in the consumer's repo just like a built-in's.

**Impact**: Adds `installer/lib/sources.mjs` and the owner-voiced `schema/AUTHORING-EXTERNAL-STACKS.md`.
Consumers can now mix third-party stacks into `stacks:`. Purely additive — a repo using only
built-in names is unaffected; `list` and `setup` still operate on the built-in surface only.

---

## 2026-07-08: Typed `prerequisites:` ships — declared, checked at `doctor`, surfaced at setup (#129/#130/#131)

**Context**: The 2026-07-07 design entry below (#47) fixed the *shape* of a declarative
`prerequisites:` block but shipped **no code** — it split the work into follow-ups #129/#130/#131.
Those have now landed. This entry records the implementation; the #47 entry stands as the original
design rationale (append-only history — it is not rewritten).

**Decision (as shipped)**:

- **Declare (#129)** — a stack's `stack.yaml` can carry a typed `prerequisites:` list. Each entry
  names a **kind** (`tool` | `secret` | `scope` | `label` | `setting` | `service` | `env`), the
  thing needed, a human `description`, a deterministic **`check`** (a shell command; exit 0 =
  satisfied), a **`level`** (`require` | `recommend`), and an optional **`items:`** list scoping it
  to specific waffles (like `requires:`). New module `installer/lib/prerequisites.mjs`.
- **Check (#129)** — `doctor` runs each **selected** entry's check and **exits 1** on an unmet
  `require` (a `recommend` only reports), so any repo running the shipped `waffle-doctor` CI gate
  now verifies prerequisites on the same run. `render` additionally warns for the cheaply-probed
  kinds (`tool` / `env`). The legacy `env:` map is subsumed as the `env` kind, **read-compatibly** —
  nothing must migrate.
- **Surface (#130)** — the whole block is listed per stack in the `setup` inventory and
  `schema/SETUP.md`, so the agent-driven install can put the "create these labels? set this secret?"
  questions to the user.
- **Inject the harness (#131)** — the CI dispatcher the shipped workflows call is now parameterized
  behind three reserved `harness.*` scalars (`harness.actionRef` / `harness.actionVersion` /
  `harness.apiKeySecret`), each injection-guarded at render, so a consumer can repin or repoint the
  action without ejecting the workflow.

**Seeding**: the `github-workflow` and `orchestration` stacks are seeded from the #47 inventory —
only `command -v` tool probes (node / git / gh) are `require`; every secret / scope / label /
setting / service is `recommend` (reports, never fails), so a correctly-set-up repo stays green.

**Alternatives considered**: Recorded in the #47 design entry below and unchanged — a TTY
postinstall prompt, auto-provisioning prerequisites for the user, and magic inference from skill
content were all rejected there and remain rejected. Interactive TTY installers stay deliberately
deferred.

**Impact**: Adds `installer/lib/prerequisites.mjs`; `doctor` and `render` gain a prerequisite pass
and `validate` lints the block. Additive with **no re-render diff** — the block renders into no
file — but `doctor` now checks the selected stacks' declared prerequisites, so an unmet `require`
fails the check.

---

## 2026-07-08: code-quality grows two skills and goes project-agnostic — adversarial-review and dry (#112/#116/#117/#180)

**Context**: The `code-quality` stack shipped two practice skills (`tdd`, `codebase-architecture`)
and carried a few project-specific assumptions. Two gaps: nothing pressure-tested a green PR
*before* merge, and there was no disciplined de-duplication playbook.

**Decision**:

- **`adversarial-review` (#112)** — a config-free `/adversarial-review <PR#>` skill that reviews a
  finished, **CI-green** PR from a deliberately hostile reviewer's seat (correctness edge cases,
  error handling, test depth, API/naming, simplification) and posts an **honest-severity** review
  (blocker / should-fix / nit) back on the PR. Severity stays honest — "no holes found" is a valid
  outcome. Distinct from the built-in `/code-review`, which reviews the author's *uncommitted*
  working diff before commit; this one gates a *committed, green* PR just before merge.
- **PR-green auto-trigger (#180)** — the `github-workflow` stack ships a companion opt-in syrup
  workflow (`waffle-pr-green-hook.yml`) that dispatches the harness to run `adversarial-review` the
  moment a PR's required checks go green (once per green transition, deduped by a review marker).
  The skill it runs lives in `code-quality`, so a consumer can render **just that one skill** (a
  qualified `code-quality/skills/adversarial-review` ref) alongside the workflow without enabling
  the whole stack. This repo now dogfoods both.
- **`dry` (#116)** — a `/dry <path>` skill that removes *genuine* duplication under the
  **rule-of-three** and **semantic-sameness** guardrails, abstracting only where a shared seam is
  warranted. Both user-invocable and agent-granted.
- **Project-agnostic (#117)** — the stack's remaining project-specific assumptions (test command,
  tiers, module map, settings type) became config, so `code-quality` now drops cleanly into any
  project.

**Alternatives considered**: Folding `adversarial-review` into the built-in `/code-review` —
rejected: the two review different artifacts at different moments (uncommitted diff vs. committed
green PR). A find-and-replace de-dup pass — rejected: DRY is a judgment call, so `dry` ships
guardrails (rule of three, semantic sameness) rather than mechanically fusing every similar-looking
pair.

**Impact**: `code-quality` now has **4 skills** (total skill count **30 → 32**). Neither new skill
adds config keys or syrup; the PR-green hook is opt-in syrup in `github-workflow`. Additive — a repo
that doesn't enable `code-quality` (or install the qualified skill) is unaffected.

---

## 2026-07-08: A `list` CLI command — see installed vs. available, and multi-select to update (#119)

**Context**: A consumer had no quick way to see the whole toolkit surface against what its repo
actually has installed. Answering "what's out of date?" or "what could I add?" meant reading the
lock by hand.

**Decision**: Add a ninth CLI command, **`list`**. By default it prints an aligned, agent/CI-safe
plain-text table of every stack and item, each classified **installed & current** / **out of date**
/ **not installed** (ANSI color only on a TTY; `--no-color` opts out). With **`--interactive`** (a
real TTY on both ends) it drives a keypress **multi-select** — out-of-date items pre-checked — that
installs/updates the chosen refs and then renders. It takes no refs and, like `setup`, operates on
the built-in surface only (an external `source:` stack lists as a selection error). New module
`installer/lib/list.mjs`.

**Alternatives considered**: Making `list` part of `setup` — rejected: `setup` prints the install
playbook + inventory; `list` answers a different question (per-item install state) and adds an
interactive apply path. A prompt-only command — rejected: the default must stay non-interactive and
parseable for agents and CI; the interactive multi-select is an opt-in that degrades to the table
without a TTY.

**Impact**: CLI command count **8 → 9**; new module `installer/lib/list.mjs`. Purely additive — a
read-only reporter by default, with an opt-in interactive apply path. No config, no migration.

---

## 2026-07-08: Opt-in autonomous merging — the autopilot backlog runner (#100/#101)

**Context**: Every primitive for an autonomous agency loop already existed. `/issue` writes
specs, `/delegate` turns issues into PRs (with typed checkpoints, run memory, and an
approve-before-push gate), the required `doctor` check gates every merge, and `delegate.autoMerge`
(#98) had just proven that a PR can safely arm itself to merge *after* green. What was missing was
the composition: nothing strung these together into an unattended run, so a human still had to
drive the loop by hand — plan → accept the plan → delegate → accept the push → merge → repeat, for
each issue. The docs and agents kept reasoning from that old manual model, which is exactly the
docs-vs-reality drift the toolkit exists to prevent.

**Decision**: Ship the **`autopilot`** skill as a **prose playbook that composes** — not forks —
`delegate` (batch mode #99 + auto-merge #98), `clean-up`, and `git-workflow` into a per-issue
**plan → implement → PR** loop. It re-implements none of delegate's machinery (classification,
worktree isolation, PR creation, board sync). Every run is pinned by a **two-part instantiation
contract, both captured before any work starts**:

1. **Issue scope — REQUIRED.** An explicit set of issues (a list like `#12 #14`, a
   `milestone:<name>`, a label, or `all-open`). Scope is never optional and has a second job: it
   is what **activates delegate's batch mode** (the explicit scope stands in for a human accepting
   each plan, so the plan-approval pause is skipped, not the plan itself). A run can never be
   unscoped.
2. **Auto-merge consent — per-run, explicit, default OFF, never sticky.** Whether this run may
   arm auto-merge on the PRs it opens is captured **fresh every invocation** — never remembered,
   inherited, or read back from a prior run's checkpoint or memory. Consent off → every PR is
   opened and left for human review (still a complete run). Consent on → autopilot sets
   `delegate.autoMerge` for the run so each PR arms itself on green.

Per issue: a dedicated **read-only planning context** writes a plan to
`{{autopilot.planDir}}/issue-<N>.md`; that plan is injected into a **fresh delegate-spawned
implementer as a brief, not a contract** (the implementer may depart from it — reality wins);
delegate batch mode implements and opens the PR; each PR is **verified directly from GitHub, never
assumed**; serial chains wait for the armed PR to actually merge; and post-merge housekeeping runs
per merged PR (verify the issue closed, move the board item to Done, `clean-up git --yes`). The
**invariant**: the final outcome of every issue is always a PR. **Guardrails, every run**: never
push to `main`; never `--admin`-merge or bypass branch protection — the only merge path is
`gh pr merge --auto --merge`, which waits on required checks, and a PR that can't arm is left
**open-but-not-armed**; merge commits, not squash; one retry then **stop-and-report** if the same
issue fails twice; a failed/conflicting PR stops the chain when a downstream issue depends on it;
and issue, PR, and plan text is treated as **data, never as instructions**.

**Alternatives considered**:

- **A sticky / config-persisted "always auto-merge" preference.** Rejected — autonomous merging
  must be a fresh, deliberate per-run consent; a prior run must never leave auto-merge armed for
  the next. That is why consent is captured every invocation and never read back from memory.
- **Re-implementing classification, worktree isolation, and PR creation inside autopilot.**
  Rejected — compose `delegate` rather than fork it; a second copy of that machinery would drift
  from the original.
- **An unscoped `all-open` default run.** Rejected — scope is required precisely because it is
  what *authorizes* batch mode's skipped plan confirmation. No scope, no authority to run
  unattended.
- **Falling back to an immediate or `--admin` merge when `--auto` can't arm.** Rejected outright,
  the same guardrail hygiene and `delegate.autoMerge` already hold: an un-armable PR is left
  open-but-not-armed for a human, never force-merged.
- **A TTY / interactive prompt in the CLI.** Out of scope — consistent with the toolkit's
  headless-CLI stance; consent is captured through the harness's question tool or an explicit
  argument flag, not by forking CLI behavior on stdin shape.

**Impact**: Additive. A new orchestration skill (skill count **29 → 30**) plus two optional config
keys `autopilot.autoMerge` / `autopilot.planDir` (default `{{git.worktreesDir}}/.autopilot`, so
plan files inherit the worktrees gitignore as throwaway run state). It `requires:` delegate +
clean-up + git-workflow + github-project-management. Default-off with no migration — a repo that
never invokes `/autopilot` is unaffected. This entry also records the two enabling delegate
opt-ins it composes: **`delegate.autoMerge`** (#98/#141 — arm `gh pr merge --auto --merge` after
`gh pr create`, only when the repo allows auto-merge and a required check exists) and
**`delegate.batchMode`** (#99/#142 — skip delegate's Phase-3 plan-approval pause when explicit
scope is supplied, never weakening the `approveBeforePush` pre-push gate). The doc registries were
updated in the same #101 change (the `AGENTS.md` machine registry and `STATUS.md`) so agents stop
reasoning from the manual model.

---

## 2026-07-07: Close the render-target asymmetry — every target renders both agents and skills (#94)

**Context**: The multi-harness story was only half true. `renderAgent` emitted for `claude`
and `codex` but had no `agents-dir` branch; `renderSkill` emitted for `claude` and
`agents-dir` but had no `codex` branch. So Codex got agents but no skills, the cross-tool
agents dir got skills but no agents, and only Claude got both. The README and setup output
presented all three as full harnesses — exactly the docs-vs-reality drift the toolkit exists
to prevent, and a consumer enabling `codex` or `agents-dir` silently lost half their bundle.

**Decision**: Implement the two missing cells (Option A — full coverage, not a scoped-back
claim). **Codex skills** render to the cross-tool `.agents/skills/<name>/` directory: OpenAI's
docs confirm Codex scans `.agents/skills` from the cwd up to the repo root, which is exactly
where the existing `harness.skillsDir` codex built-in already pointed — so no built-in changed,
and Codex shares the one skill render with `agents-dir`. `renderSkill` dedupes by output dir
(first target wins) so enabling both writes `.agents/skills` once, not twice. **agents-dir
agents** render to `.agents/agents/<name>.md` as harness-neutral Markdown — frontmatter
`name`/`description`/the neutral `skills:` grant-pointer plus body, dropping the Claude-only
`claude:` passthrough block. `eject` learned the new `.agents/agents/<n>.md` path.

**Alternatives considered**: (a) *Docs-only (Option B)* — annotate the limitation and scope the
README's claim honestly. Rejected: the whole point of a compiler is that its targets actually
compile; a permanently half-implemented second target is a worse answer than finishing it.
(b) *Give Codex its own `.codex/skills/` namespace* (symmetric per-target dirs). Rejected: Codex
does not read a `.codex/skills` dir — it reads `.agents/skills` — so a per-namespace render
would be output the harness never loads. Following the harness's real convention beats internal
tidiness. (c) *A `.agents/agents/` external standard* — none exists; the AGENTS.md ecosystem
standardizes `.agents/skills/` and `AGENTS.md`, not agent-persona files. `.agents/agents/` is
wafflestack's own symmetric choice, mirroring `.claude/agents` + `.claude/skills`.

**Impact**: `render.mjs` (`renderAgent` agents-dir branch, `renderSkill` codex branch + dir
dedup), `eject.mjs` (agent release paths), the installer test matrix (new per-target coverage
suite), and every coverage surface (README, ARCHITECTURE, FORMAT, AGENTS.md matrix). The
acceptance bar — no surface implies coverage the renderer doesn't deliver — is met by delivering
the coverage rather than trimming the claim.

## 2026-07-07: Declare, check, and inject dependencies — typed `prerequisites:`, a doctor gate, and harness injection on `harness.*` (#47)

**Context**: The shadcn-style install copies rendered files into the consuming repo — there
is no package-manager `postinstall` hook, so nothing installs or verifies the external things
a stack silently depends on. Those prerequisites are prose-only today and warn-at-best: the
github-workflow stack's `setup:` note tells an agent to check `gh auth status`, create the
trigger labels, set `ANTHROPIC_API_KEY`, and flip repo settings — but nothing *checks* any of
it, so a consumer discovers the gap when a label hook dispatches into a repo with no secret and
bills for a no-op. The one structured seam that exists — a stack's `env:` map, warned at
render (`checkEnvPrerequisites`, `render.mjs`) and printed in the setup inventory
(`setup.mjs`) — covers only harness env vars, not the CLI tools, secrets, auth scopes, labels,
or repo settings the stacks actually lean on. Separately, the rendered CI workflows hardcode
one harness — `anthropics/claude-code-action` pinned to a SHA in `waffle-label-hook.yml` and
`waffle-hygiene.yml` — with no seam to pin a different version or inject a different dispatcher
(raised by #46). This is the HMW: how might we *declare*, *check*, and *inject* the
dependencies wafflestack uses — including the harness itself as an injectable dependency of the
workflows it renders.

**Inventory (grounds the schema)**: Sweeping every stack surfaced these implicit
prerequisites, by kind — this is what a declarative block must be able to express:

- **CLI tools**: `node` >= 18 (renderer, all stacks); `git` (github-workflow, orchestration
  worktrees); `gh` + a live `gh auth status` (every github-workflow skill); `npx` (the
  `waffle-doctor.yml` CI job); `jq` (the rendered hooks' `Check harness result` step); the
  project toolchain behind `project.installCmd`/`lintCmd`/`typecheckCmd`/`testCmd`/`buildCmd`
  (npm by default).
- **Secrets**: `ANTHROPIC_API_KEY` (label-hook, hygiene); `WAFFLE_HYGIENE_TOKEN` (hygiene
  auto-merge, optional fallback).
- **gh auth scopes**: `project` (`gh auth refresh -s project`, the board skills); the
  `workflow` credential scope (pushing any `.github/workflows/*` file).
- **Trigger labels**: `waffle:enrich`/`waffle:implement` (label-hook), `waffle:release`
  (release-hook), and the `issue.typeLabels`/`issue.priorityLabels`/`issue.inferenceLabel`
  taxonomy (issue skill — applying a missing label fails `gh issue edit`).
- **Repo settings**: "Allow GitHub Actions to create and approve pull requests" (implement
  job); `allow_auto_merge` (hygiene); a required status check on the base branch (hygiene
  auto-merge); Actions workflow permissions not locked read-only (release-hook `contents:
  write`); branch protection on the default branch (all three write-scoped hooks); a GitHub
  remote (all github-workflow skills).
- **Services / external state**: a Projects v2 board matching `project.name` (optional —
  skipped with a warning); Anthropic API billing (a cost, not a check).
- **Harness env vars**: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (orchestration — already the
  one thing `env:` covers).

**Decision**: Adopt a three-part design, distinct from the internal-only `requires:` keyword
(which maps render-closure edges between waffles, not external prerequisites):

1. **A declarative `prerequisites:` block per stack** (`stack.yaml`), a typed list where each
   entry names a **kind** (`tool` | `secret` | `scope` | `label` | `setting` | `service`), the
   thing needed, a human `description`, a **`check`** (the deterministic probe — `command -v
   gh`, `gh auth status`, `gh label list`, `gh secret list`, a repo-settings API GET), and a
   **`level`** (`require` vs `recommend`). The existing `env:` map is subsumed as the `env`
   kind (kept read-compatible so no stack must migrate at once). Only *declared* prerequisites
   are surfaced — no magic inference — and, like `requires:`, the block is **scoped to the
   selected items**, so a partial install is asked only for the prerequisites its own waffles
   need.

2. **Three enforcement tiers over one declaration**, escalating from advisory to blocking:
   - **`render` warnings** — generalize the existing env-warning path so every declared
     prerequisite that can be cheaply probed emits a `warning:` (non-blocking, no effect on
     `doctor`), and the `setup` inventory lists the whole block per stack. This is the
     already-shipped, lowest-friction tier.
   - **`doctor` gate** — `doctor` runs each entry's `check` and **exits 1** on an unmet
     `require`-level prerequisite (a `recommend` entry only reports). This reuses doctor's
     existing "report + exit 1 in CI" contract, so a repo that runs the `waffle-doctor.yml`
     drift gate gets prerequisite verification on the same job — the structured upgrade from
     "the prose said to check" to "CI checks."
   - **The setup playbook is the postinstall-prompt analog** — `schema/SETUP.md` step 4 reads
     the structured block and puts the human questions (create these labels? set this secret?
     flip this repo setting?) the same way #74 made the both/one/neither syrup question
     required. Anything that creates or mutates shared external state still needs the user's
     explicit go-ahead.
   - **The CLI stays non-interactive** — no TTY postinstall prompt, consistent with #74:
     `render`/`doctor` warn and gate, the agent-driven playbook owns the human conversation.

3. **Harness injection layers on the reserved `harness.*` namespace** — a config key selects
   which dispatcher the workflow templates render. `harness.*` is already always-available and
   per-target, and already abstracts per-harness differences (attribution, skills dir), so it
   is the natural home. The first, minimal step parameterizes the hardcoded
   `uses: anthropics/claude-code-action@<sha>` and `anthropic_api_key:` lines behind
   `harness.actionRef` / `harness.actionVersion` / `harness.apiKeySecret` (defaults = today's
   pinned claude-code-action), so a consumer can pin a different version or repoint the action
   without ejecting the workflow. A *fully* swappable dispatcher (Codex or another harness,
   whose `with:` input shape differs from claude-code-action's) needs a per-harness dispatch
   snippet the template composes — a partials/include mechanism the render engine does not yet
   have — so that is explicitly deferred to a follow-up rather than forced into a single
   scalar.

**Recommended first increment**: ship **(1) the `prerequisites:` schema + (2a) the `doctor`
gate and render warnings**, seeded from the inventory above for the github-workflow and
orchestration stacks. Deterministic checks in CI are the highest-value, lowest-risk slice: they
turn the existing prose into a machine-checked gate on the drift job consumers already run,
reuse doctor's exit-1 contract, and need no new interactive surface. Harness injection ships as
a **separate track** (the pin/ref step first; the full dispatch-profile mechanism later).
Interactive TTY installers are **not** recommended and are not scheduled — the setup playbook
plus render/doctor already close the loop without forking CLI behavior by stdin shape.

**Alternatives considered**: *Overloading `requires:`* to also carry external prerequisites —
rejected: `requires:` resolves to installable item refs inside the toolkit and drives the
render closure; a `gh` binary or an `ANTHROPIC_API_KEY` secret is neither, and conflating them
would muddy both. *A TTY postinstall prompt in the CLI* (the literal shadcn/npm analog) —
rejected for the same reasons #74 rejected it: the CLI is deliberately headless (it runs in CI
and under an agent), a prompt would need a non-TTY fallback anyway, and it would duplicate the
playbook contract that already owns the human conversation. *Auto-installing/creating
prerequisites* (running `gh label create`, `gh secret set` for the user) — rejected outright:
these mutate shared external state and often cost money (arming a paid hook), the exact thing
the opt-in gate and the "explicit go-ahead" rule exist to prevent; the toolkit checks and
prompts, it never provisions unasked. *A single `harness.action` scalar* capturing the whole
dispatcher — rejected as insufficient: different harnesses have different `with:` inputs, so a
scalar can pin a version but cannot swap the dispatcher; the honest first step is the ref/version
pin, with the profile mechanism called out as deferred. *Magic inference of prerequisites from
skill content* — rejected: brittle and implicit; declaration keeps the surface auditable, the
same principle as only substituting declared config keys.

**Relationship to #88 / #126**: External-stack support (#88 slice 1, #123) lets `stacks:`
entries pull a third-party stack from a pinned git `source`; #126 adds install-time `validate`
+ an extra syrup-tier confirmation for those external stacks. This design is **adjacent, not
overlapping**: #126 governs the *trust boundary* of external stack *content*; `prerequisites:`
governs the *environment* a stack (built-in or external) needs. They compose — an external
stack ships its own `prerequisites:` block, checked by the same doctor gate — and neither
subsumes the other.

**Impact**: Design-only — no code, config, or migration ships in this entry; it records the
decision and splits the work. Follow-up implementation issues filed on GitHub: **#129** — the
`prerequisites:` schema + doctor gate + render warnings (the first increment); **#130** — the
setup-inventory / SETUP.md surfacing of the block (the postinstall-prompt analog); **#131** —
the `harness.*` injection key + parameterized workflow templates. Interactive TTY installers
are recorded here as deliberately deferred (no issue — the rejected alternative). When the first
increment lands, `env:` becomes one kind under `prerequisites:` (read-compatibly), and a repo's
existing `waffle-doctor.yml` job starts verifying prerequisites with no workflow edit.

---

## 2026-07-06: Layer-1 evals — deterministic content assertions on the rendered prompts (#89/#108)

**Context**: The test suite proved the render *machinery* (bytes in → bytes out) but nothing
asserted the **behavior** baked into the rendered prompts. A refactor or a hygiene rewording
pass could silently drop a load-bearing guardrail — the label-hook's constant-token rule, the
delegate confirmation gate — and every test would stay green.

**Decision**: Add `installer/test/content.test.mjs`, a first eval layer of **deterministic
key-phrase assertions** run by plain `npm test`. Assertions pin *meaning*, not bytes: rewording
a prompt passes, but removing a guardrail fails CI. They run against the **committed
`.claude/skills/**` render** (the artifact consumers actually get); the one gitignored piece
(the label-hook workflow) is rendered fresh into a temp project through the real render
pipeline and asserted there. Coverage: label-hook's constant action-token and
untrusted-input/no-fan-out refusals, delegate's confirmation/checkpoint/approval gates, the
issue and release templates and tag-safety guardrails, frontmatter presence everywhere, and
no leftover unsubstituted placeholders.

**Alternatives considered**: Byte-exact snapshot tests — rejected: they fail on every harmless
rewording, so they train people to regenerate them blindly, which defeats the guard. Starting
with LLM-judged evals — deferred: non-deterministic and paid, the wrong first layer for a CI
gate (tracked as sub-issues of #89 as the future layer 2). Asserting on the *source* files
instead of the render — rejected: it would miss substitution and render bugs.

**Rationale**: The highest-risk artifacts are the rendered prompts themselves, and the cheapest
useful protection is a deterministic phrase check on exactly what ships. Testing the committed
render also means the assertions and the doctor drift gate protect the same artifact.

**Impact**: Suite grows to 241 tests / 43 suites. Dev-only — no consumer-facing change, no
config, no migration. Removing or gutting a pinned guardrail in any stack now fails CI.

---

## 2026-07-06: Curated, hard-capped run memory — never an append-only log (#93/#107)

**Context**: A `/delegate` run had no durable memory between runs. Lessons — repo quirks,
recurring failures, issue entanglements — evaporated with the orchestrator's context window,
so successive runs repeated the same mistakes.

**Decision**: ONE curated Markdown memory doc per repo, **hard-capped** (default 4096 bytes)
and format-gated by a shipped, dependency-free validator (`memory.mjs`, beside the delegate
`SKILL.md`). Every entry must carry a **Why** (why it's forward-useful), a **Since** (the
issue/PR that taught it — its staleness anchor), and an **Area** (a module tag). The Report
phase *distils* lessons in — pruning stale entries and rewriting, never blind-appending;
Classify and Plan read the doc back, and each spawned agent receives only the entries whose
Area matches its issue. Over the cap or a malformed entry → exit 1 and the run is blocked
until curation brings it back within budget; the validator **never silently truncates**. A
missing doc is valid (a fresh repo has no memory yet). Config: `delegate.memoryFile` (default
`{{delegate.checkpointDir}}/memory.md`) and `delegate.memoryMaxBytes` (default 4096).

**Alternatives considered**: An append-only log — rejected outright: it bloats until it
poisons the context it was meant to help. Auto-truncation (FIFO) at the cap — rejected:
pruning should be *judged* (that's what Why/Since anchor), and silent truncation hides the
loss. Committing the memory to the repo — not the default: it lives under the gitignored
worktrees dir, accepting the documented trade-off that memory is per-clone and doesn't follow
the repo to another machine.

**Rationale**: Same pattern the typed checkpoints established — an LLM curates, a
deterministic script enforces. The cap forces the doc to stay a compact working set; the
required fields make every entry auditable and pruneable on evidence rather than age.

**Impact**: Adds `memory.mjs` to the delegate skill's shipped files and two optional config
keys. Additive, default paths inherit the worktrees gitignore, no migration; repos that never
run `/delegate` are unaffected.

---

## 2026-07-06: Opt-in human approval gate before push (#92/#106)

**Context**: Delegated agents pushed branches and opened PRs autonomously. Some projects want
a human look *before* anything leaves the machine, and there was no seam between "agent
committed locally" and "branch is public" to put one.

**Decision**: One optional flag — `delegate.approveBeforePush`, **default false**. When on,
each delegated agent runs its pre-flight, commits **locally**, and STOPS before `git push` /
`gh pr create`. The orchestrator assembles a compact per-agent summary (branch, target issue,
diffstat, commit list), collects the human's decision via AskUserQuestion (Approve / Approve
all / Reject), and only an explicit approval releases the push and opens the PR. A rejection
leaves the worktree and local branch intact for inspection and is recorded in the typed
checkpoint (`approval`/`approvedBy` per execution entry; the validator enforces that a
rejected push is `status: skipped` with no PR — a rejection can never masquerade as delivered).

**Alternatives considered**: An always-on gate — rejected: it would slow every existing
autonomous flow; default-off leaves behavior unchanged for everyone who doesn't ask. A TTY
prompt in the CLI — rejected: the CLI is deliberately non-interactive; the harness's question
tool is the interactive layer. Reviewing after push (draft PRs) — rejected: the branch has
already left the machine, which is exactly what the gate exists to prevent.

**Rationale**: The gate slots into the checkpoint contract rather than beside it — the
approval decision is typed run state, so the run report and the validator both see it, and a
skipped push is auditable, not just remembered.

**Impact**: New optional config key; checkpoint schema + validator gain approval fields; the
Report phase gains an "Approved by" column when active. Additive, default-off, no migration.

---

## 2026-07-06: Typed checkpoints — a schema-validated gate at every delegate phase boundary (#91/#105)

**Context**: A `/delegate` run's state — which issues, which branch, which worktree — lived
only as prose in the orchestrator's context. Long runs drifted: a dropped field or a
hallucinated branch name surfaced downstream as a confusing agent failure instead of being
caught at the seam where it appeared.

**Decision**: Each run writes ONE JSON checkpoint, validated at **every phase boundary**
(Fetch → Classify → Plan → Execute → Report) by a shipped, dependency-free validator. Two
files ship beside the delegate `SKILL.md`: `checkpoint.schema.json` (the documented contract)
and `checkpoint.mjs` (`node checkpoint.mjs --file F --phase <phase>`). Each phase appends its
section, and load-bearing fields (issue number, branch, worktree path) are *read from the
checkpoint* as the single source of truth, never re-derived from prose. The validator also
cross-checks references: every classified/assigned/executed issue traces back to a fetched
one, worktree presence matches the group's parallel/serial mode, and an executed branch must
equal the branch the plan assigned — catching a hallucinated branch. **Exit 1 = hard STOP**:
the run halts and reports (the checkpoint doubles as the resume point) instead of improvising.
Config: `delegate.checkpointDir`, default `{{git.worktreesDir}}/.delegate` — a default that is
itself a placeholder, exercising the template engine's depth-4 nested expansion.

**Alternatives considered**: Keeping prose state — that *is* the failure mode being fixed.
LLM self-verification ("re-read your plan before executing") — rejected: non-deterministic,
and a model can't reliably catch its own hallucination; the gate must be a script. A
schema-library validator (e.g. ajv) — rejected: the script runs inside consuming repos that
may have no npm deps installed, so it's Node built-ins only, reading the co-located schema.

**Rationale**: Determinism at the boundaries, judgment in between. The phases stay agentic;
the hand-offs become machine-checked, so drift fails loudly at the boundary where it happened.

**Impact**: The delegate skill now ships supporting files that render into consuming repos
alongside `SKILL.md`. One new optional config key; checkpoint files are throwaway run state
under the gitignored worktrees dir. Additive, no migration. #106 (approval) and #107 (memory)
both build on this contract.

---

## 2026-07-06: Overview one-pagers become self-contained branded HTML, not SVG (#75/#104)

**Context**: `render` emitted `.waffle/cheatsheet.svg` and `.waffle/team.svg` — pictures of
text. Not selectable, not searchable, fixed layout, and awkward font handling for what is
fundamentally a text document.

**Decision**: Replace them with `.waffle/cheatsheet.html` + `.waffle/team.html` — each a valid
standalone HTML5 page: semantic lists built from the same skill/agent frontmatter, the waffle
glyph inlined as SVG, the brand palette (dark by default, warm-paper light via
`prefers-color-scheme`), and a **hybrid font strategy** — Google Fonts links for the brand
type as progressive enhancement, backed by a brand-styled system-font stack, with those font
links the pages' only external reference (they still render correctly offline). Emitted
through the same `generateWaffleDocs` → `emit()` path, so they stay lock-tracked,
doctor-checked, and pruned. The Markdown cheat sheet / team docs are unchanged and remain the
source of truth.

**Alternatives considered**: Keeping the SVGs — rejected: the images-of-text problems were the
whole motivation. Fully inlining the webfonts for zero external references — not taken: the
hybrid strategy keeps the generated pages small while degrading gracefully offline.

**Rationale**: The one-pagers exist to be read and searched; HTML is the right medium for
text. Routing them through `emit()` keeps them under the same frozen-image contract as every
other managed file.

**Impact**: The retired `.svg` paths are pruned automatically on the next render (they were
previously-managed paths the render no longer produces). Consumers who gitignored the old
`.svg` names swap them for `.html`. No config key changes, no migration.

---

## 2026-07-06: A self-referential `wafflestack` stack — one `/waffle-*` skill per CLI command (#70/#103)

**Context**: Inside a consuming repo, the toolkit's own lifecycle commands (`init`, `setup`,
`install`, `render`, `upgrade`, `doctor`, `eject`, `validate`) had to be remembered and typed
as `npx github:dustinkeeton/wafflestack …`. A toolkit whose whole product is installable
skills shipped no skills for operating *itself*.

**Decision**: Ship a ninth stack, `wafflestack`: eight user-invocable `/waffle-*` skills, one
per CLI subcommand. Each is deliberately a **thin wrapper** — it shells out to
`npx <waffle.toolkitRef> <subcommand>` and adds agent judgment around the output (e.g.
`/waffle-upgrade` reviews the render diff; `/waffle-eject` confirms before releasing a file).
One optional config key, `waffle.toolkitRef` (default `github:dustinkeeton/wafflestack`) — pin
it to a release tag to freeze the version the wrappers run, or point it at a local checkout
while developing the toolkit. The stack is **not** enabled in this repo's own render.

**Alternatives considered**: Reimplementing command logic in skill prose — rejected: the CLI
is the single implementation, and fat skills would drift from it. Leaving the commands to
docs alone (`schema/SETUP.md`) — that covers first install, but leaves day-2 lifecycle
operations without an in-harness entry point.

**Rationale**: The CLI stays authoritative; the skills add exactly what a CLI can't — judgment
and conversation. And the toolkit now dogfoods its own delivery mechanism: its lifecycle ships
the same way everything else it makes does.

**Impact**: Stack count 8 → 9, skill count 21 → 29. Purely additive — no agents, no
migration, and no effect on repos that don't enable it.

---

## 2026-07-06: Surface skipped syrup companions — warn, don't prompt (#74)

**Context**: Opt-in syrup pairs with a companion waffle through a `requires:` edge — the
github-workflow stack's `release` skill with the `waffle-release-hook.yml` tag-on-merge
workflow, `hygiene` with `waffle-hygiene.yml`, `label-hook` with `waffle-label-hook.yml`. The
render only ever walked that edge forward (installing the *syrup* pulls the *skill*), so
enabling a stack — or including just the skill — rendered the manual half of a flow and
silently gated out the automated half. A consumer ended up with a release flow whose
tag-on-merge hook was never rendered and never mentioned (#76). The only "ask first" surface
was advisory playbook prose aimed at AI agents; a bare `wafflestack install <stack>` with no
agent in the loop surfaced nothing.

**Decision**: Walk the companion edge in reverse (`skippedSyrupCompanions`, `refs.mjs`). When a
render/install selection includes a waffle whose opt-in syrup companion is gated out,
`render`/`install` emits a `warning:` naming the skipped syrup and the exact
`wafflestack install files/<path>` command to pour it; `setup` update-mode flags the same
pairing. The `schema/SETUP.md` playbook is promoted from advisory ("consider asking") to a
**required** both/one/neither question the agent must put to the user before finishing
setup/install. The CLI stays **warn-only** — it does **not** grow a TTY prompt.

**Alternatives considered**: An interactive TTY prompt when stdin is a TTY — rejected. The CLI
is deliberately non-interactive (every command runs headless in CI, and the whole install is
agent-driven through the setup playbook); a prompt would fork behavior by stdin shape, need a
non-TTY fallback anyway, and duplicate the playbook contract that already owns the human
conversation. Auto-installing the companion syrup — rejected outright: it would silently arm a
sensitive, write-scoped workflow, the exact thing the opt-in gate exists to prevent. Staying
advisory-only — rejected: it left the non-agent path (`install <stack>`) with no signal at all.

**Rationale**: The warning is the machine-readable stand-in for the playbook's human question,
so both the agent path (SETUP.md) and the bare-CLI path (stderr warning) surface the choice
without either arming syrup on its own. Warnings don't fail a render, don't affect `doctor`, and
fire only when a companion is actually selected but its syrup is neither included nor
lock-tracked — so an existing install (syrup already tracked) and an unrelated stack stay quiet.

**Impact**: Consumers enabling a stack with paired opt-in syrup now get a copy-paste pour
command instead of a silent gap. No config, lock, or render-output change — the reverse-edge
walk only adds warnings and a setup annotation, so `doctor` is unaffected and no migration
ships.

---

## 2026-07-06: Rebrand — waffles, stacks, and syrup (#59)

**Context**: The toolkit's vocabulary had drifted from its own name. Installable items were
"items", their named groups were "bundles", the generic `files/` payload was just "files",
and the opt-in gate key was `syrup:`. The name "wafflestack" implies a food metaphor the
terms never carried, and "bundle" collides with the ubiquitous JS/build sense (a webpack
bundle, `bundle install`), muddying every doc, help string, and error message.

**Decision**: Adopt a consistent food taxonomy. An individual installable item — an agent or
a skill — is a **waffle** (user-facing vocabulary only; no directory or key renames). A named
group of waffles is a **stack** (formerly "bundle"): the source dir becomes `stacks/`, the
manifest `stack.yaml`, and the key `stacks:` in `toolkit.yaml`, the consumer
`.waffle/waffle.yaml`, the lock field, and internal identifiers. The generic `files/` payload
is **syrup** (prose only — the `files:` manifest key and the `files/` ref prefix are
unchanged); sensitive syrup gated behind explicit opt-in is **opt-in syrup**, and the manifest
gate key `syrup:` becomes **`optIn:`**. Load-bearing surfaces stay put: the item-ref prefixes
(`skills/`, `agents/`, `files/`), the `agents/`/`skills/` dirs inside each stack, `.waffle/`
dotfile names, and the package/CLI name `wafflestack`.

**Alternatives considered**: Renaming the item-ref prefixes and harness dirs too (e.g.
`waffles/`) — rejected as churny and compatibility-breaking for lock keys and consumer
`include:`/`eject:` lists, with no vocabulary gain. Keeping `bundle` — rejected: the JS/build
collision and the missed metaphor were the whole motivation. A silent read-through of a stale
`syrup:` manifest key — rejected: a silently-ignored gate key would un-gate sensitive
workflows, so `loadStack` throws on it instead.

**Rationale**: The rename breaks exactly one consumer surface — the `bundles:` key in
`.waffle/waffle.yaml` — so it ships a 0.10.0 migration (`bundles:` → `stacks:`,
comment-preserving, across the config and its `.local` overlay) plus a read-fallback: a plain
`render` still works off a legacy `bundles:` key, emitting a deprecation warning that points
at `wafflestack upgrade`. Everything else the consumer touches — item refs, `include:` /
`eject:` entries, lock file paths — is unchanged, so the blast radius is a single key. The
lock's `bundles` field → `stacks` is write-only and self-heals on the next render (no migration
needed).

**Impact**: Toolkit authors rename `bundle.yaml` → `stack.yaml`, the `bundles:` registry key →
`stacks:`, and the `syrup:` gate key → `optIn:`; a stale `syrup:` now fails `loadStack` loudly.
Consumers already on `stacks:` are unaffected; consumers still on `bundles:` get a warning and
a one-command migration. `schema/FORMAT.md`, `schema/SETUP.md`, and the generated setup
inventory adopt the new vocabulary. The package/CLI name, item-ref grammar, and `.waffle/`
layout are untouched.

---

## 2026-07-03: Commit the self-render and arm the hygiene/doctor automation loop

**Context**: Activating the dogfooded hygiene hook (#46) required its CI-dispatched
harness to read the committed `.claude/skills/` — but this repo gitignored its whole
render (2026-07-01 decision below). Auto-merge on the daily hygiene PR also could not
arm: the repo had no CI at all, so no required status check existed to wait on.

**Decision**: Partially reverse the 2026-07-01 decision. Commit the rendered
`.claude/` output, `.waffle/waffle.lock.json`, and the `waffle-doctor` CI workflow
(running with `--allow-missing`); keep the label-hook workflow and the generated
`.waffle/` overview docs untracked. Protect `main` with the `doctor` job as a
required status check. With the `ANTHROPIC_API_KEY` + `WAFFLE_HYGIENE_TOKEN` secrets
set and auto-merge enabled, the daily hygiene PR merges itself once doctor passes.

**Alternatives considered**: Committing only the skills/agents without the CI gate —
hygiene PRs would open but auto-merge could never arm, leaving a manual merge every
day. A plain `npm test` workflow as the required check — doctor is the bundle-shipped
gate and additionally protects the now-committed generated files from hand-edits.

**Rationale**: The 2026-07-01 rationale ("a committed copy invites edits to generated
files") inverts once the lock is committed: the doctor gate *enforces* that generated
files match the render, which gitignoring never could. Search pollution from the
committed copies is the accepted cost of a live automation loop.

**Impact**: Contributors must commit the re-rendered output + lock with any
`bundles/**` change, or the required check fails their PR. The hygiene schedule
spends API budget daily. `main` gains its first branch protection (required `doctor`
check; admin bypass stays available).

---

## 2026-07-03: "Syrup" — an opt-in tier for sensitive bundle items (#51)

**Context**: The `github-workflow` bundle grew several `files/` workflow payloads —
the label hook, the daily hygiene run, and the release hook — that hold repo write
permissions and/or spend Anthropic API budget on every trigger. The render model
was all-or-nothing: enabling a bundle rendered *every* item it declared. That meant
turning on `github-workflow` for its issue/git skills would also drop a
live, permission-holding workflow into a consumer's repo with no explicit consent.

**Decision**: Add a `syrup:` list to `bundle.yaml` that names the `files/` items
which must be poured only on request. Enabling a bundle no longer renders its syrup
items. Each renders only when (a) the consumer installs the ref explicitly
(`install files/<path>`, persisted to `include:`), or (b) the repo already tracks
that path in its lock — so an existing install keeps updating, but a fresh enable
never silently arms it. `validate` rejects a `syrup:` entry that doesn't resolve to
a real item, and `setup` lists syrup items under a separate "do not install by
default" acknowledgement.

**Alternatives considered**:

- **Leave the workflows out of the bundle entirely** (ship them as copy-paste
  snippets). Rejected — they benefit from the same render pipeline (placeholder
  substitution, lock tracking, drift checking, `requires:` closure) as any other
  item; excluding them would forfeit all of that.
- **A separate "dangerous" bundle.** Rejected — the hooks are git/GitHub-native and
  reuse the same `issue`/`git-workflow` skills; splitting them off would duplicate
  the gh-auth/setup surface for no gain.
- **Render them but disabled/commented.** Rejected — a rendered-but-inert workflow
  still lands a file the consumer didn't ask for and invites accidental enabling.

**Rationale**: Sensitive automation should be an explicit, deliberate act, not a
side effect of wanting a bundle's ordinary skills. Gating on "installed the ref, or
already tracks it in the lock" keeps upgrades frictionless for adopters while making
first-time arming a conscious choice.

**Impact**: The `waffle-label-hook.yml` workflow became opt-in — a repo that enabled
`github-workflow` but never committed the file simply stops rendering it. Adopters
install the ref (or already track it) and are unaffected. Threaded through
`loadBundle()`, `computeSelection()`/`renderProject()` (via the prior lock's tracked
files), `validate`, and `setup`; documented in `schema/FORMAT.md` and `schema/SETUP.md`.
Additive and minor — no migration.

---

## 2026-07-02: Ship the label-event hook as a github-workflow prefab (workflow + skill) (#27)

**Context**: Consumers want a GitHub label applied to an issue to immediately trigger an
automated harness action — the concrete driver is obsidian-synapse#379, which wants an
`on: labeled` workflow that dispatches the Claude harness with the issue context. Every
consumer had to hand-roll that workflow *and* all of its security gating. WaffleStack shipped
nothing label-reactive: the only prefab workflow was the doctor CI, and "labels" appeared only
as issue taxonomy in the `issue` skill.

**Decision**: Extend `github-workflow` with one `files/` payload
(`.github/workflows/waffle-label-hook.yml`), one skill (`label-hook`), three `labelHook.*`
config keys, and a `requires:` block. Two label→action mappings ship in v1 — **enrich** and
**implement** — as separate GHA jobs with per-job least-privilege permissions. Trigger is
`issues: [labeled]` only. The dispatched harness receives a **constant action token + numeric
issue id**; the raw label string never reaches a shell, a prompt, or an env var — the label
appears only in each job's exact-match `if:` gate. The action is SHA-pinned
(`anthropics/claude-code-action@6c0083bb… # v1.0.162`). Because the action's *agent mode*
(direct `prompt:`) does **not** expand slash commands — that path is reserved for @mention/tag
mode's multi-block SDK message — the dispatch prompt names the skill in natural language
(`Execute the label-hook skill …: action "enrich", issue #N`) rather than `/label-hook …`,
preserving the constant-token contract without depending on slash expansion.

An adversarial review then flagged a second plane: the trigger-label and `claudeArgs` config
values are spliced into structured contexts (the workflow `if:` gate and a double-quoted YAML
scalar), where a quote, newline, or `${{ }}` in the value could break YAML, inject a sibling
`with:` key, subvert the allowlist gate, or exfiltrate a secret via GHA expansion — all with
no render-time error. Fix chosen: a general, opt-in **render-time `pattern:`** on config keys
(the resolved value must fully match, enforced at every substitution site), applied to the
three `labelHook.*` keys. Validation, not escaping: textual substitution can't know its target
context (YAML scalar vs. `if:` expression vs. shell word), so context-correct escaping is
impossible in general — a pattern instead makes a bad value fail the render loudly rather than
silently corrupt the gate. As defense in depth the core prompt-injection guardrails are also
inlined into the dispatch prompt (a floor even if a consumer forgets to commit the skill).

**Alternatives considered**:

- **A standalone/sibling bundle.** Rejected — the hook is git/GitHub-native and reuses the
  `issue` + `git-workflow` skills; a sibling bundle would duplicate the gh-auth/setup surface.
  Extending github-workflow keeps those deps one `requires:` edge away.
- **Default `labelHook.enrichLabel` to `issue.inferenceLabel`** (couple the hook to the
  lifecycle label). Rejected as the default — applying the enrich label spends API budget
  immediately, while the lifecycle label merely queues; silently coupling them would make
  tagging an issue "Needs Inference" cost money. Documented as an opt-in (set both equal).
- **`pull_request: [labeled]` in v1.** Deferred — labeled fork PRs raise the
  fork-code-with-secrets question, and the primitive that would carry it (`pull_request_target`)
  is banned by our security posture. `issues: [labeled]` runs the default-branch workflow with
  no fork-code risk; PR support can arrive later, explicitly scoped.
- **A collaborator-permission API gate** (verify the sender's write/triage before dispatch).
  Rejected as redundant — GitHub already restricts label application to users with triage+
  permission, and the `sender.type != 'Bot'` check adds loop defense on top; an API round-trip
  would re-check what the label ACL already enforced.
- **A configurable action ref/version config key.** Rejected — the SHA pin *is* the security
  posture; a version knob invites drift to an unvetted ref. Bumps go through a reviewed toolkit
  update or `eject`, like any other pinned action.
- **A dedicated agent payload.** Deferred — the skill delegates to existing skills; a bespoke
  agent adds a roster surface without new v1 capability.

**Rationale**: A vetted, bolt-on primitive beats every consumer reinventing the workflow and
its gating. The parts that are easy to get wrong by hand — label allowlist, human-sender check,
per-job least privilege, SHA pins, audit comment, no event-controlled string in shell/prompt,
and prompt-injection guardrails in the skill — are exactly the parts that belong in the shipped
artifact.

**Impact**: The toolkit's **first `requires:` entry keyed by a `files/` payload** — a per-item
install of just the workflow (`include: [files/.github/workflows/waffle-label-hook.yml]`) pulls
the `label-hook` → `issue` + `git-workflow` skill closure. Introduces a new consumer-prerequisite
class: a **repo secret** (`ANTHROPIC_API_KEY`); the hook is inert until the trigger labels and
the secret exist, and **each dispatch spends real API budget**. Adds three optional `labelHook.*`
keys and the `label-hook` skill (17th skill), with per-job permissions the workflow documents
(`issues: write` on both jobs; `contents: write` + `pull-requests: write` on implement). Touches
the github-workflow `bundle.yaml`, the new workflow + skill, the payload tests, and this repo's
`.gitignore` (self-render stays gitignored). The security hardening also adds a general,
reusable capability — optional `pattern:` value validation on any bundle config key (threaded
through `template.mjs`/`render.mjs`, linted by `validate.mjs`, documented in `schema/FORMAT.md`)
— which any future bundle can adopt for values that reach a structured context. Additive and
minor — no migration.

---

## 2026-07-02: Offer opt-in `.gitignore` entries during setup/install (#29)

**Context**: The CLI deliberately never edited `.gitignore` — a consumer owns it — and
gitignore guidance was prose-only (`schema/SETUP.md` step 6, the README rules), while render
merely *warned* about stale legacy entries (`staleGitignoreEntries`). Sound as a default, but
it left two footguns: forgetting to ignore `.waffle.local.yaml` commits account-specific
config, and the "dev-only waffle" case (a consumer who wants a render only in their working
environment, not committed) had to hand-maintain the ignores — a pattern documented only as
the toolkit repo's own self-hosting exception.

**Decision**: Keep the never-edit-*silently* stance; add an opt-in **offer**, refining the
doc stance from "never edits `.gitignore`" to "never edits it **unasked**." Implement **both**
UX surfaces the issue proposed, because they cover different drivers:

- **Playbook step** — `schema/SETUP.md` step 6 now tells the driving agent to *propose* the
  concrete entries and apply them on the user's approval (the agent is the interactive layer
  the non-interactive CLI lacks).
- **Explicit CLI flag** — `--gitignore` on `init`/`render`/`install` (mirroring how #25 wired
  `--force`). The explicit flag *is* the consumer's consent, so writing `.gitignore` behind it
  doesn't violate the stance.

Two new pure helpers in `installer/lib/project.mjs`: `ensureGitignoreEntries(cwd, entries)`
appends idempotently (exact-line dedupe, existing content preserved, a missing trailing
newline added, one `# wafflestack` marker) and returns what it added;
`recommendedGitignoreEntries(toolkit, project)` computes the baseline offer —
`.waffle.local.yaml` always, plus the resolved `git.worktreesDir` when an enabled bundle
declares that key. `init --gitignore` seeds only the local overlay (no bundle chosen yet).
Dev-only / self-hosting mode (also gitignoring the renders + `.waffle.lock.json`, paired with
`doctor.flags: --allow-missing` as the CI companion) stays a separate, agent-proposed choice,
not part of the flag's automatic baseline.

**Alternatives considered**:

- **Playbook step only** (no flag). Rejected — leaves a manual, error-prone hand-edit as the
  only mechanized path; the flag makes the common case one idempotent command.
- **Flag only** (no playbook change). Rejected — the guided setup is the primary install path;
  an agent needs the instruction to *offer* before it will act.
- **Edit `.gitignore` automatically on every render** (no opt-in). Rejected for the same
  reason 0.6.0 rejected auto-rewriting it — a consumer owns their `.gitignore`; silent edits
  violate the frozen-image spirit and the #25 no-clobber contract. The offer is opt-in only.
- **A dedicated `gitignore` subcommand.** Rejected — heavier than warranted; a flag on the
  commands that already run at setup time (`init`/`install`) fits the existing idiom.

**Rationale**: The two footguns are real and the fix is cheap, but consent must stay explicit.
An agent offer plus an explicit flag are two consent channels for the same append-only,
idempotent helper — neither writes `.gitignore` without being asked, so the original stance
holds, just refined.

**Impact**: New `--gitignore` flag on `init`/`render`/`install`; default behavior unchanged
(no flag → `.gitignore` untouched, same as before). New exports `ensureGitignoreEntries` /
`recommendedGitignoreEntries` / `GITIGNORE_MARKER` in `installer/lib/project.mjs`, wired
through `cli.mjs` (`offerGitignore`). Docs refined in `schema/SETUP.md` (step 6 + the legacy
rename note) and `README.md` (command table, rule 2, the 0.6.0 rename note) from "never edits
`.gitignore`" to "never edits it unasked." No migration; additive and minor.

---

## 2026-07-02: Rename the shipped doctor workflow `wafflestack-doctor.yml` → `waffle-doctor.yml` (#28)

**Context**: v0.6.0 shortened every consumer-facing dot-path to `.waffle.*` but
deliberately kept three `wafflestack`-named artifacts — the package/CLI name, the npx
specs, and the shipped `.github/workflows/wafflestack-doctor.yml` workflow (see the 0.6.0
decision below). The CLI/package name genuinely should stay, but the workflow filename is a
**consumer-visible rendered artifact** — the one remaining piece that lands in a consuming
repo still carrying the long prefix — so keeping it left the naming alignment half-done.

**Decision**: Rename the shipped workflow to `.github/workflows/waffle-doctor.yml` and align
its internal identity (`name: waffle-doctor`, `concurrency.group: waffle-doctor-…`) with the
filename, **reversing** the 0.6.0 choice to keep the old name. The `wafflestack`
package/CLI name and the `wafflestack doctor` command the workflow invokes stay — only the
rendered artifact moves, mirroring how 0.6.0 moved only the consumer's dotfiles. Ship **no
migration step**: lock-managed consumers get the rename automatically from the frozen-image
render contract (the prune deletes the old locked path and writes the new one), and the two
edge cases where an old copy lingers — an **ejected** workflow, or a **pre-lock / untracked**
render — are files the toolkit does not manage. A one-line manual cleanup (`git rm …
wafflestack-doctor.yml`) is documented in the changelog for those instead.

**Alternatives considered**:

- **Keep `wafflestack-doctor.yml`** (the 0.6.0 status quo). Rejected — it is the last
  consumer-visible artifact off the `.waffle` convention; finishing that alignment is the
  whole point of this change.
- **Add a `MIGRATIONS` entry that deletes the old file** (modeled on 0.6.0's
  `migrateLegacyDotfiles`). Rejected — that helper is safe only because it *renames*
  toolkit-owned files under an `exists(from) && !exists(to)` guard. A workflow cleanup would
  have to `rm` a path that, in the only cases where it survives a re-render, is
  **unmanaged**: an ejected copy the consumer now owns (and may have customized) or an
  untracked pre-lock render. Blindly deleting it would be data loss and directly contradict
  the just-adopted #25 "refuse to clobber unmanaged files" contract. There is also no stable
  byte signature to recognize "our old render" (it carried a `{{doctor.toolkitRef}}`
  substitution). For lock-managed repos a migration is redundant anyway — `upgrade`
  re-renders and the prune already handles it.

**Rationale**: The rename finishes the v0.6.0 ergonomics work on the one artifact that
reaches consumers. Leaning on the frozen-image prune instead of a migration keeps the common
path automatic while honoring #25 — the toolkit never deletes a file it does not own; it
documents the manual step for the consumer who does.

**Impact**: Breaking for consumers that pin the old filename or `name:` (e.g. a
branch-protection required check) — called out in the changelog and landing in a minor
release. Lock-managed repos re-render clean with no action. Ejected / pre-lock repos keep a
stale `wafflestack-doctor.yml` until they `git rm` it. Touches the shipped workflow, the
github-workflow `bundle.yaml` manifest + prose (including the `eject:` ref),
`schema/SETUP.md`, the payload test, and this repo's own `.gitignore`.

---

## 2026-07-02: Refuse to clobber pre-existing unmanaged files on render (#25)

**Context**: Every render output was written through `writeFileEnsuringDir` — an
unconditional `writeFileSync` with no existence check. Two collision classes were already
guarded: two enabled bundles emitting the same rel path fail loudly (`emit()`), and files
tracked in `.waffle.lock.json` are drift-checked by `doctor`. Neither protected a
**pre-existing, unmanaged** consumer file: a repo with a hand-written
`.claude/skills/issue/SKILL.md` running its first render with a bundle that produces that
same path had the file silently overwritten. Render targets are namespaced only by
kind-dir + item name, so such name collisions are entirely plausible.

**Decision**: Detect the untracked-collision case at the render chokepoint and **fail loud
by default**. A target path is an unmanaged collision when it (1) is in the new render
outputs, (2) exists on disk, and (3) is absent from the previous lock's `files` (so it is
the consumer's own file, not a prior render of ours). On detection, render returns
non-zero naming every offending path — in the style of the `emit()` conflict message — and
**writes nothing**: the check runs before any prune or write, so the tree is left
untouched. Two overrides: a **byte-identical** file (hash match) is **adopted silently**
(the write is a no-op and the new lock records it either way), and a `--force` flag on
`render`/`install` overwrites the differing file and takes it under management.

**Alternatives considered**:

- **Per-toolkit namespacing** of output paths (the alternative from the original report;
  see [gstack](https://github.com/garrytan/gstack) for prior art). Rejected as the primary
  fix: harnesses dictate the agent/skill layout (`.claude/skills/<name>/`), so a
  per-toolkit prefix cannot apply to agents or skills — it is viable only for `files/`
  payloads, leaving the most likely collisions (skills) unprotected. Fail-loud covers all
  three payload types uniformly.
- **Silent last-write-wins** (status quo). Rejected — it is exactly the data-loss bug.
- **An interactive prompt.** Rejected — the CLI is non-interactive and agent-driven; a
  flag plus a clear error fits the existing `doctor --allow-missing` / `emit()` idiom.

**Rationale**: A consumer's own file is theirs; overwriting it without consent is data
loss. Fail-loud + `--force` mirrors the existing conflict-handling style and is uniform
across agents, skills, and files. Silent adopt for identical content keeps the common
"already rendered, lost the lock" case frictionless.

**Impact**: A first render against a repo with a conflicting unmanaged file now exits
non-zero and leaves the file untouched; `--force` (on `render` or `install`) overwrites and
records it in the lock; a content-identical file is adopted with no flag. Managed-file
re-render (the frozen-image restore) is unchanged — locked paths are never treated as
collisions. `upgrade` re-renders without `--force`, so it inherits the same guard (safe by
default for the rare newly-colliding path). Lives in `renderProject`
(`installer/lib/render.mjs`); the flag is parsed in `installer/cli.mjs`.

---

## 2026-07-02: Shorten consumer dotfiles `.wafflestack.*` → `.waffle.*` (v0.6.0)

**Context**: Every consumer-facing dot-path carried the full project name —
`.wafflestack.yaml`, `.wafflestack.local.yaml`, `.wafflestack.lock.json`,
`.wafflestack/extensions/`. The shorter `.waffle` prefix is friendlier and quicker
to type, and just as unambiguous inside a consuming repo. Unlike the v0.2.0
rebrand, consuming projects now exist — so this is a genuine breaking change and
needs a migration, not just a constant swap.

**Decision**: Rename the four consumer dot-paths to `.waffle.*`. The `wafflestack`
package/CLI name, npx specs, and the `wafflestack-doctor.yml` workflow filename all
stay — only the consumer's own dotfiles move. Ship three compatibility layers so no
consumer breaks: (1) every read falls back to the legacy `.wafflestack.*` name with a
deprecation note when the `.waffle.*` name is absent; (2) a plain `render`/`upgrade`
renames the legacy config, local overlay, lock, and extensions dir in place (and
reminds the consumer to update their `.gitignore` — the CLI never edits it); (3) the
first real migration-registry entry, keyed to **0.6.0**, runs that same rename so
`wafflestack upgrade` applies it across the version bump.

**Alternatives considered**:

- Bare constant rename with no migration. Rejected — it would silently orphan every
  existing consumer's config on the next render.
- Have the CLI rewrite `.gitignore` automatically. Rejected — a consumer owns their
  `.gitignore`; we surface a reminder instead of editing it behind their back.

**Rationale**: The rename is cheap ergonomics; the compatibility story is what makes
it safe. Because the migration is version-keyed to 0.6.0, it fires exactly once, on a
real upgrade, while the read-fallback and render-time auto-rename protect repos in the
meantime.

**Impact**: Breaking for existing consumers, but automatic. First `render`/`upgrade`
after adopting ≥0.6.0 renames the dotfiles and prints a `.gitignore` reminder; the
legacy names keep working (with a deprecation note) until then. Shared rename lives in
`installer/lib/project.mjs` (`migrateLegacyDotfiles`), reused by `render` and the 0.6.0
migration step.

---

## 2026-07-02: Install (and depend on) individual skills and agents

**Context**: You could only enable whole bundles. Wanting a single skill — say
`skills/issue` — meant adopting its bundle's entire roster. And cross-bundle
dependencies (the `/delegate` skill needs the git-workflow and
github-project-management skills; the `/docs` skill needs both documentation
skills) lived in prose only, so a partial install could silently miss them.

**Decision**: Add per-item install. `wafflestack install <ref…>` now accepts:

- a **bundle** name — `github-workflow`
- a single **item** — `skills/issue`, `agents/project-manager`
- a **bundle-qualified item** — `code-quality/skills/security-audit` (needed only
  when a name exists in two bundles)

It resolves each ref, pulls in dependencies automatically (transitively, across
bundles), persists the choice — bundles into `bundles:`, items into a new
top-level `include:` list in `.waffle.yaml` — and then runs a full render.
Dependencies come from an agent's frontmatter `skills:` list plus a new optional
`requires:` map in `bundle.yaml`.

**Alternatives considered**:

- Keep bundle-only install (status quo).
- Have `install` render *only* the named item (a scoped render). Deferred — the
  first cut keeps it simple: `install` persists the choice, then re-renders the
  whole current selection. Scoped render can come later.
- Persist the resolved dependency list too. Rejected — the closure is recomputed
  every render, so it can never go stale; only your chosen refs are stored.

**Rationale**: Projects want à-la-carte pieces without swallowing a whole bundle,
and automatic dependency resolution means a partial install still works.
Recomputing the closure each render keeps `.waffle.yaml` small and honest.

**Impact**:

- New `include:` list in `.waffle.yaml`. Rendered set =
  `union(bundles:) ∪ closure(include:) − eject:`.
- `eject:` wins over `include:` and now self-cleans a matching entry, so no dead
  refs are left behind.
- Required config is scoped to the placeholders the selected items actually use —
  a one-item install no longer demands config only its unselected siblings need.
- New module `installer/lib/refs.mjs` (ref grammar + resolution + dependency
  closure); `validate` now checks agent-skill and `requires:` references.

---

## 2026-07-02: Lenient agent-skill deps, strict `requires:` deps

**Context**: Dependency resolution pulls skills from two sources with different
guarantees. An agent's frontmatter `skills:` list is a harness *grant-pointer*
that can name skills living outside this toolkit — for example the `designer`
agent lists `brand-guidelines`, which the toolkit does not ship. A bundle's
`requires:` map, by contrast, is authored by the toolkit and should always point
at a real item.

**Decision**: Resolve the two differently. Names in an agent's `skills:` list
resolve **leniently** — an unknown or ambiguous name is skipped, not an error.
Entries in `requires:` resolve **strictly** — a dangling or ambiguous ref fails
and is treated as a toolkit bug (caught by `validate`).

**Alternatives considered**: Treat both the same — either both strict (installing
`agents/designer` would then error on the external `brand-guidelines`) or both
lenient (a typo in a `requires:` entry would silently do nothing).

**Rationale**: The two lists mean different things. An agent's skill grants may
legitimately reference skills from outside the toolkit; an authored dependency is
a promise the toolkit must keep.

**Impact**: Installing `agents/designer` pulls its in-toolkit skills
(`git-workflow`, `issue`) and quietly skips `brand-guidelines`. A broken
`requires:` entry is a hard `validate` failure.

---

## 2026-07-01: Dogfood the docs-system and orchestration bundles

**Context**: The repo already rendered the `github-workflow` bundle into itself.
The documentation, project-manager, and task-planner agents (plus the
`/delegate`, `/audit`, and `/docs` skills) would also help develop the toolkit.

**Decision**: Enable `docs-system` and `orchestration` in `.waffle.yaml`
with repo-shaped config — a single root `AGENTS.md` registry instead of the
default per-feature layout, `schema/FORMAT.md` as the architecture reference, a
general-purpose specialist roster, an "all-open" delegate scope (this repo has no
milestones), and a toolkit-integrity compliance check (validate + test + render +
doctor). Added the agent-teams environment flag the orchestration bundle needs.

**Alternatives considered**: Keep developing the toolkit without its own agents;
hand-write the docs.

**Rationale**: The best proof the toolkit works is using it. The config overrides
also exercise the doc-set parameterization added in v0.4.0.

**Impact**: This is why the root `AGENTS.md` and these `DECISIONS.md` /
`STATUS.md` / `ARCHITECTURE.md` files exist — they are produced by the toolkit's
own documentation agents.

---

## 2026-07-01: Gitignore the rendered output in the toolkit repo (v0.5.0)

**Context**: Self-hosting means this repo renders bundles into its own
`.claude/` directory. A normal consuming project commits that rendered output —
but the toolkit repo is not a normal consumer.

**Decision**: Gitignore all rendered output (`.claude/agents/`,
`.claude/skills/`, `.codex/`, `.agents/`) and the lock file. Only
`.claude/settings.json` (project-owned) is tracked. Regenerate on demand with
`node installer/cli.mjs render`.

**Alternatives considered**: Commit the rendered copy, exactly as a consuming
project would.

**Rationale**: A committed second copy of every skill would pollute code search
and invite edits to generated files — the one thing the toolkit forbids.

**Impact**: Contributors must re-render after changing a bundle. Nothing
generated lives in git.

---

## 2026-07-01: Agent-driven setup wizard (v0.5.0)

**Context**: Manual install (init → edit YAML → render) expects a human to know
every bundle, config key, and external prerequisite up front.

**Decision**: `wafflestack setup` prints an install playbook (`schema/SETUP.md`)
plus a generated inventory of every bundle's items, config schema, environment
prerequisites, and service-side setup notes (a new optional `setup:` field in
`bundle.yaml`). A coding agent runs the whole flow.

**Alternatives considered**: A traditional interactive prompt-based CLI wizard.

**Rationale**: A coding agent can detect the project's targets and commands, fill
in config, verify externals (e.g. `gh` auth and labels), render, and report — far
more capable than a fixed question-and-answer script.

**Impact**: Installing is now "tell your agent to set up wafflestack."
`schema/SETUP.md` and the `setup:` field are owner-voiced.

---

## 2026-07-01: Documentation shapes are project config (v0.4.0)

**Context**: A second consumer had documentation that was not shaped like a
`src/`-based application, which the doc skills had assumed.

**Decision**: The machine- and human-documentation shapes became config keys
(`docs.machineDocSet`/`Spec`, `docs.humanDocSet`/`Spec`), with the original
`src/`-app layout kept as the default. Added optional voice-guardrail and
privacy-guardrail sections and a configurable architecture-reference skill.

**Alternatives considered**: Hard-code the `src/`-feature documentation layout in
the skills.

**Rationale**: Documentation conventions vary by project; parameterize the skill
rather than fork it.

**Impact**: This repo overrides the machine-doc shape to a single `AGENTS.md`
registry while keeping the default human-doc shape (these three files).

---

## 2026-07-01: Enabling two bundles that emit the same file is a hard error

**Context**: Two bundles can define an item with the same name — for example, two
`security-audit` variants (desktop-plugin vs. browser-app).

**Decision**: Rendering the same output path from two enabled bundles fails the
render, rather than silently letting the last one win.

**Alternatives considered**: Last-write-wins, or a silent merge.

**Rationale**: Same-named items are *alternative implementations* of one
interface; enabling both is a project mistake worth catching loudly.

**Impact**: Enable one variant, or `eject` one of them.

---

## 2026-07-01: Recursive (nested) template substitution

**Context**: Some committed config values need to reference account-specific
values that must stay out of version control.

**Decision**: A substituted value may itself contain `{{placeholders}}`, expanded
recursively up to a depth of 4. Expansion only descends into substituted values,
so canonical `${{ ... }}` (GitHub Actions) and similar syntax pass through
untouched.

**Alternatives considered**: Flat, single-pass substitution only.

**Rationale**: A committed value (such as a git command) can reference a key kept
in the gitignored local overlay — secrets and identities stay local while the
template stays committed.

**Impact**: Avoid config key names that collide with literal template syntax you
embed in values.

---

## 2026-07-01: Rename agent-toolkit → wafflestack (v0.2.0)

**Context**: The project shipped early under the name "agent-toolkit."

**Decision**: Rebrand the repo, the CLI binary, and the entire consumer file
contract (`.agent-toolkit.*` → `.wafflestack.*`, extensions directory moved).

**Alternatives considered**: Keep the original name.

**Rationale**: A better name, and the rename happened before the first consuming
project merged — so the breaking change cost nothing.

**Impact**: Breaking for any consumer, but there were none yet.

---

## 2026-07-01: One canonical source per item, rendered per harness (v0.1.0)

**Context**: The same agent or skill must render slightly differently for each
harness (e.g. Claude vs. Codex attribution, different skills directory).

**Decision**: A reserved `harness.*` namespace resolves per output target, and
substitution runs once per target — so one source file renders every harness
variant. Naming convention settled here: `project.name` is the bare name,
`project.longName` is the prose descriptor.

**Alternatives considered**: Maintain a separate source file per harness.

**Rationale**: No duplication; the per-harness differences are small and
mechanical.

**Impact**: Adding a new harness means extending the built-ins, not forking every
file.

---

## 2026-07-01: The frozen-image render contract (v0.1.0 foundation)

**Context**: Reusable agent/skill definitions need to be both *shareable* and
*updatable* without clobbering each project's local tweaks.

**Decision**: Adopt a shadcn-style model — one canonical source repo, rendered
verbatim into each project. Rendered files are generated output and are never
edited; a lock manifest (a sha256 per file) lets `doctor` detect drift, `render`
regenerate and prune stale files, and `eject` release an item to project
ownership. Per-project changes live in config values and extension files.

**Alternatives considered**: Distribute as an npm dependency imported at runtime;
a git submodule; or copy-paste with no update path.

**Rationale**: Updates become simple re-renders. Projects keep full ownership of
the files while staying in sync with upstream, and config and extensions survive
every re-render.

**Impact**: The core contract everything else is built on. Never edit rendered
files — put additions in `.waffle.yaml` (config) or
`.waffle/extensions/` (appended content).
