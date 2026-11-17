# Commit policy inspection

Wafflestack distributes portable Git workflow policy, not signing credentials or execution
permission. `wafflestack commit-policy` is a read-only inspection of a **proposed** commit:
it resolves identities/signing from Git, checks the existing recipe and exact trailers against
an opt-in named profile, and reports conflicts. It does not apply a profile, construct a commit
command, read keys, unlock a signer, sign a probe, commit, or change Git/harness configuration.

## Ownership and scope

- `github-workflow` owns profile declarations, the inspection contract and commit guidance.
  Orchestration forwards the selection and inspects each worker's actual environment.
- Existing `git.cmd`, `git.coAuthorTrailer`, bot/owner bindings and `git.agentIdentities` remain
  the inputs. There is no second identity store or general global configuration merge.
- Git, the user's signer and the harness own keys, cryptographic approval and hard execution
  authorization. An unrestricted shell can bypass a skill or inspector; this is not a sandbox.
- PR attribution, platform participants, remote merge signing and tag signing are separate.
  A remote hosting service cannot be made to use a local agent key by this inspector.

## Profiles

| Selection | Author / committer | Required signing | Exact co-author list |
| --- | --- | --- | --- |
| `legacy` (factory default) | Existing recipe/environment | Existing recipe/environment | Existing configured trailer |
| `personal` | Configured human / human | Personal global Git key | Empty |
| `personal-credit-agent` | Configured human / human | Personal global Git key | Configured bot |
| `agent-credit-human` | Configured bot / bot | Explicitly selected automation key | Configured human |
| `prepare-only` | Inspected, not used to commit | Human executes later | Proposed only |

The human binding reuses **explicit** `git.ownerName` / `git.ownerEmail`; it is not inferred from
a remote owner or GitHub login. Configure these to the actual consenting human (locally if needed).
The automation binding uses explicit `git.botName` / `git.botEmail`, optionally overridden by
`git.agentIdentities[slug].{botName,botEmail,signingKey}`. Strict profiles never manufacture
plus-addressed emails or derive signing identities from agent display names. Without an explicit
per-agent override, the configured base bot is used.

Author and committer are inspected independently, including Git's identity environment overrides.
The named presets intentionally require the same person in those two fields; arbitrary mixed-role
profiles are not part of this minimal version. Signing identity is separate. `Signed-off-by` is a
separate attestation, **not** a signature or co-author credit; `git.signOffTrailer` defaults empty.
Its inclusion needs independent approval. Selecting a crediting profile permits exactly its
configured credit when a commit is separately authorized, not extra vendor/model credits.

## Selection and requirements

Profile precedence, highest first:

1. Invocation `--profile`.
2. Gitignored local overlay `config.git.commitProfile`.
3. Committed `.waffle/waffle.yaml` `config.git.commitProfile`.
4. Personal global Git preference `wafflestack.commitProfile`.
5. Factory `legacy` fallback.

For example, a user may explicitly choose `agent-credit-human` as their personal global preference
outside this tool. Merely inspecting policy never writes that preference. Global preference is
read only at runtime, not rendered into shared skills or canonical locks; repository selections
win. It is a default **for authorized commits**, never permission to make one.

An optional user-managed global Git preference would be:

```gitconfig
[wafflestack]
    commitProfile = agent-credit-human
```

This preference contains no key material and supplies no missing identity/key/credit bindings.
This feature does not write it or change factory defaults for other consumers.

The recipe/trailer defaults still follow Wafflestack's normal overlay → committed → stack-default
resolution. `--git-cmd`, `--co-author-trailer` and `--sign-off-trailer` inspect whole proposed
replacements, not partial profile merges. Empty trailer strings clear lists; extra/duplicate credit
fails a strict profile. A profile alone does not rewrite the unsigned canonical bot recipe:
that conflict is reported, never silently resolved. Personal workflows must explicitly clear or
replace legacy owner credit. Agent signing requires explicit key/format/signing pins in the recipe.

`config.git.requireSignedCommits: true` in **either** committed config or the local overlay is
monotonic: local false, `--profile legacy` and an unsigned invocation cannot weaken it.
`prepare-only` is a handoff, not an unsigned exception. Other repository/harness requirements,
such as permitted signer fingerprints and protected branch rules, still apply externally;
this small validator does not discover or enforce every hosting-service policy.
Use a YAML boolean for this requirement; unlike generic rendered mode text, the inspector
requires `true`/`false`, not quoted strings.

## Inspect before execution

Run the installed, pinned CLI in the actual checkout/environment. For a personal commit with
no credit, assuming the recipe/environment already selects the human identity/key:

```sh
wafflestack commit-policy --profile personal --co-author-trailer '' --json
```

For an explicitly configured signed bot recipe:

```sh
wafflestack commit-policy --profile agent-credit-human --json
```

Use `--agent <slug>` for an explicit override and `--git-cmd '<actual proposed recipe>'` when
the invocation differs from config. Prefer absolute key/program paths so inspection and execution
do not depend on shell tilde expansion. It accepts the existing safe recipe syntax and only
identity/signing `-c` settings, never shell evaluation or arbitrary Git subcommands. The inspection
does not apply these arguments to subsequent commands: the caller must use precisely the inspected
identities, recipe and final message trailers, without extra `--author`, signing or sign-off flags.
Reinspect immediately before commit if the worktree, environment, message or command changes.
History rewrites retaining other authors need a human handoff rather than overwriting authors.

Text/JSON reports profile and input sources, effective author and committer, signer format/key
reference/program, exact co-authors, sign-offs, repository signing requirement and conflicts.
Exit 0 means **configuration valid**, not ready/authorized; exit 1 means blocked or invalid input.
`authorization.granted` is always false: the inspector neither records nor grants consent, even
when a user separately requested a commit. `signer.verified` is false and `fingerprint` is null.
No keys are opened to fill those fields. Output contains identity emails and machine-local paths;
review/redact it before sharing. Private overlay values may render into ignored local resources
as usual; don't add runtime personal values to shared config or commit private render output.

Before executing, the user/harness must separately establish human email verification/credit
consent and key custody/availability. An authorized commit must actually sign successfully;
stop if signing fails. Agent signing means a distinct
**user-controlled automation** key, not a model/OpenAI key or a personal key relabeled as agent
signing. Identical personal-global/agent key references are rejected, but different filenames or
GPG IDs are not proof of distinct public fingerprints. Verify that externally without exposing
private material; local cryptographic verification and hosting-account verification are distinct.
Never fall back unsigned, borrow the personal signer, or invent missing identities/credit.

Prepare-only stops before commits, signing, pushes or PR creation. A successful inspection cannot
authorize any of those actions. Worktree preparation provisions harness artifacts, not signer
credentials; no keys or private signer configuration are copied by this feature.
