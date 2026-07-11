# Committing vs. gitignoring the rendered output

wafflestack renders your chosen agents and skills into harness-native files — `.claude/`,
`.codex/`, `.agents/` — and records a hash of every one of them in `.waffle/waffle.lock.json`.
Those files are generated. **Should they go in git?**

Usually yes. But it is a real trade-off, and the case for ignoring them is not a bad one.
This guide argues both sides so you can pick deliberately.

> [!IMPORTANT]
> **The render and the lock are two separate decisions.** Most of the value — knowing your
> team is on the same source, and a CI check that means anything — comes from committing the
> **lock**, not the render. You can ignore part or even all of the render and still get real
> guarantees. What you cannot do is ignore the **lock**: a missing lock fails `doctor`
> unconditionally, and no flag changes that.
>
> The catch, if you ignore *every* render: your CI gate must be built differently, or it will
> pass while checking nothing. See [Posture 2b](#posture-2b-commit-the-lock-only).

---

## The short version

| If you… | Commit the render? | Commit the lock? |
| --- | --- | --- |
| Work on a team, or run agents in CI | **Yes** | **Yes** |
| Want a clean code search and accept the cost | Partly — ignore a subset | **Yes** |
| Want **zero** generated files in git, but still want a real gate | No | **Yes** — and CI must render |
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
gitignored, the checkout does not contain it — there is *nothing for CI to read*. No amount
of configuration works around this. Either the skills are in git or your CI agents have no
skills.

**Stack changes become reviewable.** When someone edits `stacks/**`, the re-rendered output
lands in the same pull request. A reviewer sees what actually changed in the agent's
instructions, not just a config key they have to mentally compile.

**The drift gate gets teeth** — though this one comes from the lock, not the render. See
below.

## What committing the render costs you

**A second copy of every skill, in your tree, forever.** Grep for a phrase and you get two
hits: the source and the render. Every code search, every "find in files", every diff view
carries the duplication. On a large stack selection this is genuinely irritating.

**Every `stacks/**` edit now obliges a re-render and a commit.** Forget it and the `doctor`
check goes red on your pull request. It is a small tax, paid often, by everyone.

**Long-lived branches conflict on generated files.** The lock is a single JSON file of
hashes that *every* render touches, so two branches that both re-render will collide on it.
Generated files conflict in the least interesting way possible — you never want to resolve
a merge conflict in output you did not write.

**A committed generated file invites hand-edits.** Someone will eventually "just fix" a typo
directly in `.claude/skills/<name>/SKILL.md`, and the next `render` will silently overwrite
it.

Ignoring the render inverts all four: clean search, no re-render tax, no generated-file
conflicts, nothing to hand-edit. And it costs you every benefit in the section above.

---

## The reversal: this repo made the call both ways

The strongest argument against committing — *a committed copy invites edits to generated
files* — turns out to be **conditional**. wafflestack's own repository decided this twice,
in opposite directions, three days apart. The second decision explains why.

### First: ignore the render (2026-07-01)

[`DECISIONS.md:1381`](../DECISIONS.md) — *Gitignore the rendered output in the toolkit repo*.
It ignored all rendered output **and the lock file**. The rationale:

> A committed second copy of every skill would pollute code search and invite edits to
> generated files — the one thing the toolkit forbids.

A clean, defensible argument. It lasted two days.

### Then: commit the render and the lock (2026-07-03)

[`DECISIONS.md:933`](../DECISIONS.md) — *Commit the self-render and arm the hygiene/doctor
automation loop* — partially reversed it. The forcing function was concrete: activating the
CI-dispatched hygiene harness required it to read the **committed** `.claude/skills/`, and
with the render gitignored there was nothing in the checkout for CI to read.

But the reasoning is the part worth internalizing:

> The 2026-07-01 rationale ("a committed copy invites edits to generated files") **inverts
> once the lock is committed**: the doctor gate *enforces* that generated files match the
> render, which gitignoring never could. Search pollution from the committed copies is the
> accepted cost of a live automation loop.

**Read that twice.** "Committing invites hand-edits" is only true when you commit the render
*without* the lock. Commit both, and `doctor` compares every managed file against its
recorded hash and fails the build on any local edit. The thing you were afraid of becomes
the thing you are now protected from. Gitignoring the render never gave you that protection
— it just moved the files somewhere nobody could check them.

The cost was real and was paid knowingly: contributors must commit the re-rendered output
and lock with any stack change, or the required check fails their PR.

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
| **Every** managed file absent | fail — all of them missing | ⚠️ **pass** — nothing left to check ([Posture 2b](#posture-2b-commit-the-lock-only)) |

> [!WARNING]
> **`--allow-missing` tolerates absent *rendered files*. It never tolerates an absent
> *lock*.** In `installer/lib/doctor.mjs:41-43` a missing lock returns `ok: false` and
> returns immediately — before the flag is read at all. A repo that gitignores its lock can
> never pass the CI doctor gate, with or without the flag.

The decisive line is `doctor.mjs:109`:

```js
const driftOk = allowMissing ? modified.length === 0 : modified.length === 0 && missing.length === 0;
```

Modified files fail either way. That is the whole point: the flag relaxes *presence*, never
*integrity*.

Set the flag through the `github-workflow` stack's `doctor.flags` config key, which the
shipped workflow interpolates into its run line:

```yaml
# .waffle/waffle.yaml
doctor:
  flags: --allow-missing
```

---

## The three postures

### Posture 1: commit the render + lock — the default

Commit `.waffle/waffle.yaml`, the rendered output, and `.waffle/waffle.lock.json`. Leave
`doctor.flags` empty.

**Fits**: teams; any repo running agents in CI; anywhere you want the drift gate at full
strength. **Costs**: the duplicated-copy tax and the re-render obligation, paid by everyone.

### Posture 2: commit the lock, ignore a subset of renders

Commit the lock, gitignore the parts of the render you do not want in the tree, and set
`doctor.flags: --allow-missing` so the deliberately-absent files do not red the build.

**This is what the wafflestack repo itself runs.** Its `.gitignore` commits the `.claude/`
render and the lock, but deliberately excludes `.codex/`, `.agents/`, `.claude/worktrees/`,
the label-hook workflow, and the generated `.waffle/` overview docs (`CHEATSHEET.md`,
`TEAM.md`, the branded HTML, `AVATARS.md`, `avatars/`).

**Fits**: repos targeting one harness but rendering several; repos with generated docs they
would rather not track. **Keeps**: the full drift gate on everything you *did* commit —
hand-edits still fail. **Costs**: you must remember that absent files are now invisible to
CI, so a render that silently stops being produced will not be caught.

### Posture 2b: commit the lock only

Push Posture 2 to its limit — the ignored subset becomes *everything*. Gitignore the entire
render; commit `.waffle/waffle.yaml`, `.waffle/extensions/`, and `.waffle/waffle.lock.json`.
**Zero generated files in git, and you still know whether your team is on the same source.**

That is not a consolation prize, it's the real thing. **Render is deterministic**: the same
toolkit version, `waffle.yaml`, and extensions produce byte-identical output, so the lock's
hashes are a genuine shared contract. It pins the toolkit version, targets, stacks, includes,
and the sha256 of every managed file. A teammate who renders locally and runs `doctor` gets a
true answer — hand-edit a rendered skill and it fails with `modified: .claude/skills/…` and
exit 1; a toolkit version skew surfaces as a note.

**This is arguably the best trade for a repo that hates the duplicate-copy tax but still
wants real CI agents and a real integrity gate.** It has exactly one sharp edge, and you must
design your CI around it.

> [!CAUTION]
> **The naive CI gate passes while checking nothing.** In a fresh CI checkout there are no
> rendered files. `doctor --allow-missing` therefore finds zero files present, zero modified,
> and **exits 0** — reporting `all present managed files match the lock manifest (58 absent,
> tolerated)`. The build goes green having verified the empty set.
>
> **A green that checked nothing is worse than a red**, because it looks like protection.
> Drop the flag and you get the opposite failure: unconditional red, every file missing.
> Neither is a gate. The shipped `waffle-doctor.yml` only runs `doctor` — it does not render —
> so a lock-only repo that installs it as-is gets exactly this vacuous green.

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

If your agents are load-bearing enough that a reviewer should see what they were told to do,
commit the render (Posture 1 or 2) and pay the duplication tax.

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

**If you landed here because you hate the duplicate copies in git — you want
[Posture 2b](#posture-2b-commit-the-lock-only), not this one.** Committing the lock alone
costs you nothing in code-search noise and buys back the shared contract. Posture 3 is for
when the *repo itself* must stay unaware of wafflestack, not merely uncluttered by it.

---

## Consequences at a glance

| | Posture 1<br>render + lock | Posture 2<br>lock + subset | Posture 2b<br>lock only | Posture 3<br>neither |
| --- | --- | --- | --- | --- |
| **CI `doctor` gate** | Full strength | Full on committed files | ⚠️ **Vacuous — passes on an empty set.** Use a lock diff instead | **Cannot run** |
| **What actually gates CI** | `doctor` | `doctor` | `render` + `git diff --exit-code` on the lock | *nothing* |
| **`doctor.flags`** | *(empty)* | `--allow-missing` | n/a — don't gate on doctor | n/a — no lock to check |
| **Hand-edits caught?** | Yes | Yes, on committed files | Yes, locally — CI has nothing to edit | No |
| **Who runs `render`** | Whoever edits a stack | Whoever edits a stack | Every person, and CI | Every person, always |
| **CI agents can read skills** | Yes | Yes, if committed | Yes — CI renders them | **No** |
| **Fresh clone works** | Yes | Yes | No — render first | No — install + render first |
| **Agent behavior reviewable in a PR** | Yes | Partly | **No — only a hash changes** | No |
| **Code-search duplication** | Yes | Partial | **None** | None |

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
