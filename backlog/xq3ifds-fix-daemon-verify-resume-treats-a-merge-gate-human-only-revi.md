---
kind: story
size: 2
status: active
scaffoldedBy: "fix-7142"
dateScaffolded: "2026-11-21"
dateOpened: "2026-11-21"
tags: []
---

# Fix daemon: verify-resume treats a merge-gate human-only review-acceptance HOLD as a repairable CI failure and withholds the push

On PR 7142 (review:human, touches a workflow file) the fix harness withheld a green-path push of a main-merge conflict resolution because the previous head's merge-gate check failed. That failure was a policy HOLD (review-acceptance: human-only, workflow file touched), which no commit can clear. So a conflict fix on any review:human PR touching a workflow file can never be pushed, and each re-mark burns attempts toward a false gate-red stand-down. The previous-head CI failure filter should exclude merge-gate HOLDs (review-acceptance / candidacy holds) and only treat real test/build failures as repairable.

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
