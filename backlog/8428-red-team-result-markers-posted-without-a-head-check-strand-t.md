---
bornAs: x2yokpz
kind: story
size: 5
status: active
scaffoldedBy: "fix-6535"
dateScaffolded: "2026-11-08"
dateOpened: "2026-11-08"
tags: []
related: ["6535"]
---

# Red-team result markers posted without a head check strand the head under check-run gating

Writers that post a red-team result marker on a head without publishing (or before confirming) the red-team check: review-job verdict carry across rebase (review-job ~1127-1133 copies the advisory result to the new head, no check); job settlement posts the comment before recordRedTeamStatus finished; card-only carry machine (red-team-carry-io recordIntent publishes before the comment and ignores published:false); round writer in review-extra-seats posts the comment before the finished publish. Recovery (review-red-team-on-skip resultOnHead) skips any head with a result comment, and drain requestRedTeam is not wired in production, so nothing republishes; stale publication holds are never cleared by policy-clear. Fix: recovery republishes when a head has a result comment but no passing check for the PR, through the status claim and publication-hold path.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Duplicate admission

PR 6535 requires a red-team check on the head; these writers post a result comment with no check or before it
