# Committing vs. gitignoring the rendered output

wafflestack renders your chosen agents and skills into harness-native files — `.claude/`,
`.codex/`, `.agents/` — and records a hash of every one of them in `.waffle/waffle.lock.json`.
Those files are generated. **Should they go in git?**

Usually yes. But it is a real trade-off, and the case for ignoring them is not a bad one.
This guide argues both sides so you can pick deliberately.

> [!NOTE]
> **This guide is for repos that *consume* wafflestack** — you install the toolkit over `npx`
> and it renders agent files into your project. The toolkit's own repository appears here only
> as a labelled case study; it self-hosts (it holds both the stack sources *and* its own
> render), which gives it problems you do not have. Where that matters, this guide says so.

> [!IMPORTANT]
> **The render and the lock are two separate decisions.** Most of the value — knowing your
> team is on the same source, and a CI check that means anything — comes from committing the
> **lock**, not the render. You can ignore part or even all of the render and still get real
> guarantees. What you cannot do is ignore the **lock**: a missing lock fails `doctor`
> unconditionally, and no flag changes that.
>
> The catch, if you ignore *every* render: `doctor` will not be your gate — it **fails on
> purpose** when no rendered file is present, rather than passing on an empty set. You must
> build the CI gate differently. See [Posture 2b](#posture-2b-commit-the-lock-only).

---

## The short version

| If you… | Commit the render? | Commit the lock? |
| --- | --- | --- |
| Work on a team, or run agents in CI — **most readers** | **Yes** | **Yes** |
| Would rather not track *some* generated files (the `.waffle/` overview docs, a harness you don't use) | Partly — ignore a subset | **Yes** |
| Want **zero** generated files in review, and will build the CI gate yourself | No | **Yes** — and CI must render |
| Just want agent tooling in your own working copy | No | No |

The last row forfeits everything wafflestack's CI story offers. That is sometimes exactly the
right call — see [Posture 3](#posture-3-ignore-both--a-purely-local-waffle).

---

## What committing the render buys you

**A fresh clone just works.** Your teammate clones the repo and their agent files are
already there. No toolkit, no `npx`, no Node, no `render` step, no onboarding paragraph
explaining any of it. For most teams this alone settles the question.

**CI agents can read the skills at all.** This is the one that surprises people. A
CI-dispatched agent harness reads `.claude/skills/` out of the checkout. If the render is
gitignored, the checkout does not contain it — there is *nothing for CI to read*. Either the
skills are in git, or CI renders them itself, or your CI agents have no skills.

**Your agents' actual behavior becomes reviewable.** Change a config value, add an extension,
or upgrade the toolkit, and the re-rendered output lands in the same pull request. A reviewer
sees what changed in the agent's *instructions* — not just a config key they have to mentally
compile into behavior. This is the benefit that no other posture can hand back to you.

**The drift gate gets teeth** — though this one comes from the lock, not the render. See
below.

## What committing the render costs you

**Diff noise.** Every config change, extension edit, or toolkit upgrade drags rendered output
through the pull request. A one-line config change can touch a dozen generated files. The
signal-to-noise ratio of your diffs goes down, and reviewers learn to skim past the `.claude/`
churn — which is a habit you did not want to teach them.

**Merge conflicts on generated files.** The lock is a single JSON file of hashes that *every*
render touches, so two long-lived branches that both re-render will collide on it. Generated
files conflict in the least interesting way possible — nobody wants to hand-resolve a merge
in output they did not write.

**A re-render-and-commit discipline, on everyone.** Change config or an extension, and you
must re-render and commit the result or the `doctor` check reds your PR. It is a small tax,
paid often, by every contributor.

**A committed generated file invites hand-edits.** Someone will eventually "just fix" a typo
directly in `.claude/skills/<name>/SKILL.md`, and the next `render` will silently overwrite
it. **This is the one the lock inverts** — see the case study below.

> [!NOTE]
> **A cost you will read about elsewhere and do not actually pay: duplicate copies.** In the
> wafflestack repo, committing the render means a *second* copy of every skill in the tree —
> the stack source and its render — so code search returns everything twice. **Your repo does
> not contain `stacks/**`.** The source lives in the toolkit, fetched over `npx`. In your tree
> the rendered `.claude/` is the *only* copy of anything. No double grep hits, no search
> pollution. That argument is a self-hosting artifact; ignore it.

---

## Case study: the toolkit's own repo made the call both ways

> [!NOTE]
> **This is the wafflestack repo, not a consumer repo** — it self-hosts, so it holds the stack
> sources *and* its own render. Read it for the one insight that transfers to you. Half of its
> reasoning does not, and this section is explicit about which half.

The strongest argument against committing — *a committed copy invites edits to generated
files* — turns out to be **conditional**. The toolkit's own repository decided this twice, in
opposite directions, three days apart. The second decision explains why.

### First: ignore the render (2026-07-01)

[`DECISIONS.md:1381`](../DECISIONS.md) — *Gitignore the rendered output in the toolkit repo*.
It ignored all rendered output **and the lock file**. The rationale:

> A committed second copy of every skill would pollute code search and invite edits to
> generated files — the one thing the toolkit forbids.

Two arguments there. **Only the second one is yours** — the "second copy" problem needs a repo
that holds both source and render, which is the toolkit's situation and not yours.

### Then: commit the render and the lock (2026-07-03)

[`DECISIONS.md:933`](../DECISIONS.md) — *Commit the self-render and arm the hygiene/doctor
automation loop* — partially reversed it. The forcing function was concrete: activating a
CI-dispatched agent harness required it to read the **committed** `.claude/skills/`, and with
the render gitignored there was nothing in the checkout for CI to read.

The rationale, and the reason this case study is here:

> The 2026-07-01 rationale ("a committed copy invites edits to generated files") **inverts
> once the lock is committed**: the doctor gate *enforces* that generated files match the
> render, which gitignoring never could. Search pollution from the committed copies is the
> accepted cost of a live automation loop.

**The first sentence is the universal insight. Take it.** "Committing invites hand-edits" is
only true when you commit the render *without* the lock. Commit both, and `doctor` compares
every managed file against its recorded hash and fails the build on any local edit. The thing
you were afraid of becomes the thing you are protected from. Gitignoring the render never gave
you that protection — it just moved the files somewhere nobody could check them.

**The second sentence is not yours to take.** "Search pollution from the committed copies" is
the toolkit paying a self-hosting tax, and it is *accepting* that cost, not recommending it.
You have no committed copies to pollute anything. Do not let it talk you out of committing
your render.

What *does* transfer, as a genuine cost: contributors must commit the re-rendered output and
lock alongside the change that caused it, or the required check fails their PR.

---

## How `doctor` actually behaves

Everything above depends on the drift gate, so be precise about what it does.
`doctor` reads the lock, hashes every file the lock tracks, and exits `1` on drift
(`installer/cli.mjs:69`).

| Situation | Without `--allow-missing` | With `--allow-missing` |
| --- | --- | --- |
| Lock file absent | **fail** | **fail** — the flag is never even consulted |
| Managed file absent | fail (`missing: <f>`) | pass (`missing (tolerated): <f>`) |
| Managed file edited by hand | **fail** (`modified: <f>`) | **fail** (`modified: <f>`) |
| **Every** managed file absent | fail — all of them missing | **fail** — a repo with no render is a repo that never rendered ([Posture 2b](#posture-2b-commit-the-lock-only)) |

> [!WARNING]
> **`--allow-missing` tolerates absent *rendered files*. It never tolerates an absent
> *lock*.** In `installer/lib/doctor.mjs` a missing lock returns `ok: false` and returns
> immediately — before the flag is read at all. A repo that gitignores its lock can never pass
> the CI doctor gate, with or without the flag.

The decisive line is the `driftOk` computation in `doctor.mjs`:

```js
const driftOk = allowMissing
  ? modified.length === 0 && !nothingPresent
  : modified.length === 0 && missing.length === 0;
```

Modified files fail either way. That is the whole point: the flag relaxes *presence*, never
*integrity*.

And it relaxes presence only up to a limit. `nothingPresent` — every lock-tracked file absent —
fails the gate even with the flag, on the same reasoning that a missing lock does: a checkout
with no render **is** a repo that never rendered, and the flag exists to tolerate a *subset* of
absent files, not the whole set. A check that inspected nothing does not get to report success.
You get a named failure that tells you what to do instead:

```
every managed file (58/58) is absent — this check verified nothing; run `wafflestack render`,
or gate on `render` + `git diff --exit-code .waffle/waffle.lock.json` if the repo deliberately
commits only the lock
```

Set the flag through the `github-workflow` stack's `doctor.flags` config key, which the
shipped workflow interpolates into its run line:

```yaml
# .waffle/waffle.yaml
doctor:
  flags: --allow-missing
```

---

## The postures

### Posture 1: commit the render + lock — the default, and probably your answer

Commit `.waffle/waffle.yaml`, the rendered output, and `.waffle/waffle.lock.json`. Leave
`doctor.flags` empty.

**Fits**: teams; any repo running agents in CI; anywhere you want the drift gate at full
strength; anyone who wants their agents' behavior visible in code review. **Costs**: diff
noise, generated-file merge conflicts, and the re-render-and-commit discipline on every
contributor.

This is the default for a reason, and it is a stronger default for you than it is for the
toolkit's own repo — the loudest objection to committing a render (a duplicate copy of every
skill polluting search) simply does not apply to a consumer. Start here. Move off it only if
one of the costs above is actively hurting you.

### Posture 2: commit the lock, ignore a subset of renders

Commit the lock, gitignore the parts of the render you do not want in the tree, and set
`doctor.flags: --allow-missing` so the deliberately-absent files do not red the build.

The usual consumer version of this: commit `.claude/`, but gitignore the generated `.waffle/`
overview docs — `CHEATSHEET.md`, `TEAM.md`, their branded HTML, `AVATARS.md`, and `avatars/`.
They are generated reading material, not agent behavior; nothing breaks if they are absent,
and they add diff noise on every render. The other common case is rendering to a harness some
of your team uses locally but the repo does not need in git.

**Fits**: repos that want the render committed but not *all* of it. **Keeps**: the full drift
gate on everything you *did* commit — hand-edits still fail. **Costs**: absent files are now
invisible to CI, so a render that silently stops being produced will not be caught.

<sub>(The toolkit's own repo runs this posture too, for self-hosting reasons of its own — it
also ignores `.codex/`, `.agents/`, and a label-hook workflow it does not want armed.)</sub>

### Posture 2b: commit the lock only

Push Posture 2 to its limit — the ignored subset becomes *everything*. Gitignore the entire
render; commit `.waffle/waffle.yaml`, `.waffle/extensions/`, and `.waffle/waffle.lock.json`.
**Zero generated files in git — and the committed lock still proves your team is on the same
source.**

That second half is real, and it is what makes this a posture rather than a mistake.
**Render is deterministic**: the same toolkit version, `waffle.yaml`, and extensions produce
byte-identical output, so the lock's hashes are a genuine shared contract. It pins the toolkit
version, targets, stacks, includes, and the sha256 of every managed file. A teammate who
renders locally and runs `doctor` gets a true answer — hand-edit a rendered skill and it fails
with `modified: .claude/skills/…` and exit 1; a toolkit version skew surfaces as a note.

**What you actually buy: clean reviews.** No generated output in any diff, no merge conflicts
on rendered files, no re-render-and-commit tax on contributors. If your team's objection to
Posture 1 is *"I don't want generated files in my pull requests"* — this is the posture that
answers it, and it answers it without giving up the shared-source guarantee.

**Be clear-eyed that the pitch is narrower than it looks.** It is not "avoid the duplicate-copy
tax" — you never pay that tax (see the note above). It is *only* about keeping generated output
out of git and out of review. That is a genuine preference, held by real teams, and it is
enough to justify the posture. It is not enough to make this the default. Posture 1 is the
default; this is for a team that specifically does not want generated output in review and will
build its CI gate to suit.

And it has one sharp edge you must design your CI around.

> [!CAUTION]
> **`doctor` cannot be your gate in this posture, and it will tell you so.** In a fresh CI
> checkout there are no rendered files, so there is nothing for `doctor` to check — with or
> without `--allow-missing`. It **fails**, deliberately:
>
> ```
> every managed file (58/58) is absent — this check verified nothing; run `wafflestack render`,
> or gate on `render` + `git diff --exit-code .waffle/waffle.lock.json` if the repo deliberately
> commits only the lock
> ```
>
> The flag tolerates a *subset* of absent renders. It does not tolerate all of them, because a
> checkout with no render is indistinguishable from a repo that never rendered — and **a green
> build that inspected nothing is worse than a red one, because it looks like protection.**
>
> The shipped `waffle-doctor.yml` only runs `doctor` — it does not render — so a lock-only repo
> that installs it as-is gets a red build until it builds the gate below. That red is the
> correct answer to a check that has nothing to look at; it is not a bug to flag-away.

#### The CI recipe that actually works

Have CI **render its own files**, then diff the resulting lock against the committed one:

```yaml
- run: npx github:dustinkeeton/wafflestack#v0.11.0 render
- run: git diff --exit-code .waffle/waffle.lock.json
```

Rendering in CI also recovers the CI-agent story: a real `.claude/skills/` now exists in the
runner for a CI-dispatched agent to read. You get that back without putting it in git.

> [!WARNING]
> **Do not run `doctor` after `render` and call it a gate — it is a tautology.** `render`
> rewrites the lock, so `doctor` then compares the files against a lock derived from those
> very files. It cannot fail. Change an extension, never re-render, never commit the lock —
> render in CI, run doctor, and it reports `all managed files match the lock manifest`, exit
> 0. The unreviewed change sails straight through.
>
> The check that catches it is the **lock diff** against the committed lock, which flags the
> changed file immediately. That, not `doctor`, is your gate in this posture.

**Pin the toolkit ref to a tag** (`#v0.11.0`, not a floating branch). If it floats, an
upstream toolkit change can alter your agents' behavior with no commit in your repo at all.
The lock diff *will* catch that as a red build — but only if whoever fixes the red actually
reads the diff, rather than committing the new lock to make it go away. That temptation is
the posture's second-order risk, and it is a human one.

#### What it still does not buy back: reviewability

This is the durable cost, and rendering in CI does not fix it. **The compiled behavior of
your agents is never visible in the repo.** A change to an agent's actual instructions shows
up only as a changed hash in a JSON file. You can review the config that *implies* your
agents' behavior; you can never review the behavior itself in a pull request.

Note the irony: the very thing this posture buys you — no generated output in review — is the
thing it costs you. Clean diffs and reviewable agent behavior are the same trade seen from two
sides. If your agents are load-bearing enough that a reviewer should see what they were told
to do, commit the render (Posture 1 or 2) and accept the noise.

### Posture 3: ignore both — a purely local waffle

Gitignore the render *and* the lock. Nothing wafflestack generates enters git.

**Fits** one real case: you want agent tooling in **your own working copy** of a repo whose
team has not adopted wafflestack. You get your agents; your colleagues see an unchanged
repository. That is a legitimate and common thing to want.

> [!CAUTION]
> **Be honest about what this forfeits — it is everything.** No CI agents (nothing in the
> checkout for them to read). No teammate benefit. No drift gate: the CI `doctor` job
> **cannot run at all**, because the lock it needs is not in git. Do not set
> `--allow-missing` and imagine it rescues this — it does not. In this posture you are not
> running a relaxed gate, you are running no gate.

Everyone who wants the waffle must install the toolkit and run `render` themselves, and
nothing verifies that any two people are running the same thing.

**If you landed here because you just don't want generated files in git — you want
[Posture 2b](#posture-2b-commit-the-lock-only), not this one.** It keeps generated output out
of the tree *and* buys back the shared-source guarantee, for the price of committing one JSON
file. Posture 3 is for when the *repo itself* must stay unaware of wafflestack — not merely
uncluttered by it.

---

## Consequences at a glance

| | Posture 1<br>render + lock | Posture 2<br>lock + subset | Posture 2b<br>lock only | Posture 3<br>neither |
| --- | --- | --- | --- | --- |
| **CI `doctor` gate** | Full strength | Full on committed files | ⚠️ **Fails by design — nothing present to check.** Use a lock diff instead | **Cannot run** |
| **What actually gates CI** | `doctor` | `doctor` | `render` + `git diff --exit-code` on the lock | *nothing* |
| **`doctor.flags`** | *(empty)* | `--allow-missing` | n/a — don't gate on doctor | n/a — no lock to check |
| **Hand-edits caught?** | Yes | Yes, on committed files | Yes, locally — CI has nothing to edit | No |
| **Who runs `render`** | Whoever edits a stack | Whoever edits a stack | Every person, and CI | Every person, always |
| **CI agents can read skills** | Yes | Yes, if committed | Yes — CI renders them | **No** |
| **Fresh clone works** | Yes | Yes | No — render first | No — install + render first |
| **Agent behavior reviewable in a PR** | **Yes** | Partly | No — only a hash changes | No |
| **Generated files in your diffs** | Yes | Some | **None** | None |
| **Re-render-and-commit tax** | On every contributor | On every contributor | **None** | None |

---

## Always gitignore these, whichever posture you pick

Two entries are never a judgement call. `wafflestack install --gitignore` (or
`render --gitignore`) appends exactly these for you, idempotently, under a `# wafflestack`
marker — it preserves whatever is already in the file, and it never touches `.gitignore`
unasked.

- **`.waffle/waffle.local.yaml`** — the local overlay. Account-specific values (bot
  identities, board IDs) that must never be committed. Always emitted.
- **The configured `git.worktreesDir`** (default `.claude/worktrees/`) — throwaway working
  state. Emitted when an enabled stack declares the key.

`init --gitignore` seeds only the local overlay, since no stack is chosen yet; run
`install --gitignore` once a stack is enabled to pick up the worktrees directory.

---

## The one rule no posture changes

> **Never hand-edit a rendered file.** `render` overwrites it.

Whether the file is committed or ignored, tracked or untracked, gated or ungated — it is
output. Project-specific additions go in `.waffle/extensions/agents/<name>.md` or
`.waffle/extensions/skills/<name>.md`, which are appended to the rendered item and survive
every render. Project parameters go in `.waffle/waffle.yaml`.

Under Postures 1 and 2, `doctor` enforces this for you. Under Posture 2b, the lock diff does.
Under Posture 3, nothing does.

Which is, in the end, the whole document in one line: **the lock is what buys you a
guarantee, and the render is what buys you a review.** Decide how much of each you need.
