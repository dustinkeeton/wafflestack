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
| `configured` (factory default) | Existing recipe/environment | Existing recipe/environment | Existing configured trailer |
| `personal` | Configured human / human | Personal global Git key | Empty |
| `personal-credit-agent` | Configured human / human | Personal global Git key | Configured bot |
| `agent-credit-human` | Configured bot / bot | Explicitly selected automation key | Configured human |
| `prepare-only` | Inspected, not used to commit | Human executes later | Proposed only |

The human binding reuses **explicit** `git.ownerName` / `git.ownerEmail`; it is not inferred from
a remote owner or GitHub login. Configure these to the actual consenting human (locally if needed).
The automation binding uses explicit `git.botName` / `git.botEmail`. Without `--agent`, that
base bot is used. With `--agent <slug>`, the existing delegate/avatar pattern is preserved:
`identity.displayName` from the installed agent definition (otherwise a title-cased slug), and
the configured recipe's base email plus `+<slug>`. Noreply domains and already-plus-addressed
local parts remain verbatim. `git.agentIdentities[slug].{botName,botEmail,signingKey}` overrides
each field exactly; an explicit email is never subaddressed again. Avatar generation and policy
inspection share this resolver. A bare base recipe opts out of virtualization and its overrides
remain inert; a half-configured base identity is an error. When using an agent identity, strict
profiles additionally require either a matching explicit base bot binding or a complete explicit
per-agent name/email override, not placeholder defaults. A personal profile with no agent credit
does not require a bot binding.

`configured` means **use the existing configured workflow**, not obsolete behavior or a migration
mode. The stricter profiles add checks to those same identity inputs; they do not replace the
per-agent avatar pattern. Identity derivation never enables/disables signing or proves email
ownership, signer availability or hosting-account verification. Signed agent profiles fail closed
when their signing prerequisites cannot be met; they never substitute an unsigned or base-bot
commit to preserve a hosting-service badge.

Author and committer are inspected independently, including Git's identity environment overrides.
The named presets intentionally require the same person in those two fields; arbitrary mixed-role
profiles are not part of this minimal version. Signing identity is separate. `Signed-off-by` is a
separate attestation, **not** a signature or co-author credit; `git.signOffTrailer` defaults empty.
Its inclusion needs independent approval. Selecting a crediting profile permits exactly its
configured credit when a commit is separately authorized, not extra vendor/model credits.

### Private GitHub email addresses

Copy the **exact account-provided noreply address** from GitHub Settings → Emails into
`git.ownerEmail` for the consenting human, and use the bot account's own address for
`git.botEmail` or an explicit per-agent override. GitHub documents both ID-based
`ID+USERNAME@users.noreply.github.com` and older `USERNAME@users.noreply.github.com` forms,
depending on account history/settings. Do not manufacture either form, assume both identify
the same account, or append a synthetic `+<agent-slug>` to a noreply address. See GitHub's
[email addresses reference](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference).
The inspector compares emails case-insensitively but preserves their spelling and requires
exact names; it does not equate different noreply forms or verify account ownership.

Commit metadata and `Co-authored-by` trailers expose their addresses to anyone who can read
the history, including the public for a public repository. Ask each co-author which address
they consent to publish; GitHub recommends their provided noreply address for private email.
See [creating co-authored commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/creating-a-commit-with-multiple-authors).
GitHub's documented [email-privacy push check](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/blocking-command-line-pushes-that-expose-your-personal-email-address)
concerns the most recent commit's **author** email. Do not assume that setting protects
co-author trailers or every address in history. The inspector adds nonblocking privacy notices
for emitted non-noreply identities other than a separately configured bot; unused human bindings
do not trigger them. Each distinct email gets one notice listing its roles, with case-only variants
grouped together. Real addresses remain legitimate for other hosts or intentional public use.

A noreply address alone does **not** guarantee a Verified signature badge or prove control of
a signing key. GitHub's [signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
is a separate check; keep account attribution, signer registration and successful cryptographic
verification distinct. No email, key or privacy setting is changed by inspection.

## Selection and requirements

Profile precedence, highest first:

1. Invocation `--profile`.
2. Gitignored local overlay `config.git.commitProfile`.
3. Committed `.waffle/waffle.yaml` `config.git.commitProfile`.
4. Personal global Git preference `wafflestack.commitProfile`.
5. Factory `configured` fallback.

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
replace configured owner credit. Agent signing requires explicit key/format/signing pins in the recipe.

`config.git.requireSignedCommits: true` in **either** committed config or the local overlay is
monotonic: local false, `--profile configured` and an unsigned invocation cannot weaken it.
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

Use `--agent <slug>` for the existing per-agent derivation and exact overrides. Without
`--git-cmd`, inspection models that derivation on the configured recipe for `configured` and
`agent-credit-human`; personal profiles retain their human recipe. Use
`--git-cmd '<actual proposed recipe>'` for the **final** invocation when it differs from config.
That explicit command is inspected verbatim, never rewritten to hide identity/signing conflicts.
Prefer absolute key/program paths so inspection and execution
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

## Relationship to persona epic #705

This change preserves the commit identity/avatar inputs used by the planned persona work;
it does not implement GitHub posting credentials or close that epic's subissues.

- **#706–#709 and #712:** review/reply App identities and orchestrator account routing remain
  separate from Git authors, cryptographic signers and commit trailers. Reuse the roster and
  avatar assets, not Git signing keys as GitHub API credentials.
- **#708 (`@author`):** the existing plus-slug author pattern still works. Its future resolver
  must distinguish configured agent aliases from ID-based noreply addresses and honor exact
  overrides/shared-email cases. Author email alone is not authenticated agent provenance;
  retain the concrete-slug selection and plain-post fallback where mapping is ambiguous.
- **#714 (human credit):** `agent-credit-human` already requires an explicit human binding and
  exact credit at inspection, but setup/render/doctor migration gates remain unimplemented.
  Reconcile the older stack-wide mandatory-credit proposal with personal/no-credit and
  prepare-only profiles instead of making every installed workflow credit someone.
- **#715 (main-bot signing):** automatic recipe selection and per-email signing changes remain
  unimplemented. Its proposed unsigned sub-agent path cannot satisfy `agent-credit-human` or
  a repository signing requirement; missing keys must fail closed there. Any future
  main-bot-only policy needs explicit configuration and must preserve per-agent identities,
  not silently disable signatures or collapse agents to the base bot. Key-path distribution,
  noninteractive signer choice and provisioning remain separate setup decisions, not a reason
  for this inspector to write configuration or require plaintext/passphrase-free keys.
