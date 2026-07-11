# Committing vs. gitignoring the rendered output

wafflestack renders your chosen agents and skills into harness-native files — `.claude/`,
`.codex/`, `.agents/` — and records a hash of every one of them in `.waffle/waffle.lock.json`.
Those files are generated. **Should they go in git?**

Usually yes. But it is a real trade-off, and the case for ignoring them is not a bad one.
This guide argues both sides so you can pick deliberately.

> [!IMPORTANT]
> **The render and the lock are two separate decisions.** Most of the value — the drift
> gate, a CI check that means anything — comes from committing the **lock**, not the render.
> You can ignore some or all of the render and still keep the gate. You cannot ignore the
> lock and keep anything: a missing lock fails `doctor` unconditionally, and no flag changes
> that.

---

## The short version

| If you… | Commit the render? | Commit the lock? |
| --- | --- | --- |
| Work on a team, or run agents in CI | **Yes** | **Yes** |
| Want a clean code search and accept the cost | Partly — ignore a subset | **Yes** |
| Just want agent tooling in your own working copy | No | No |

The third row forfeits everything wafflestack's CI story offers. That is sometimes exactly
the right call — see [Posture 3](#posture-3-ignore-both--a-purely-local-waffle).

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

---

## Consequences at a glance

| | Posture 1<br>render + lock | Posture 2<br>lock + subset | Posture 3<br>neither |
| --- | --- | --- | --- |
| **CI `doctor` gate** | Full strength | Full on committed files | **Cannot run** |
| **`doctor.flags`** | *(empty)* | `--allow-missing` | n/a — no lock to check |
| **Hand-edits caught?** | Yes | Yes, on committed files | No |
| **Who runs `render`** | Whoever edits a stack | Whoever edits a stack | Every person, always |
| **CI agents can read skills** | Yes | Yes, if committed | **No** |
| **Fresh clone works** | Yes | Yes | No — install + render first |
| **Code-search duplication** | Yes | Partial | None |

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

Under Posture 1 or 2, `doctor` enforces this for you. Under Posture 3, nothing does — which
is, in the end, the whole argument in one sentence.
