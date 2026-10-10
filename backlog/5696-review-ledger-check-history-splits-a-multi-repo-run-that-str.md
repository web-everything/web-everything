---
bornAs: xx228pr
kind: story
size: 2
status: active
scaffoldedBy: "fix-4688"
dateScaffolded: "2026-10-09"
blockedBy: ["3930"]
dateOpened: "2026-10-09"
tags: []
---

# review-ledger-check history splits a multi-repo run that straddles ET midnight across two days so the streak can never complete

Each repo run record is stamped with its own time as runAllRepos finishes it. A sequential run that crosses America/New_York midnight lands some repos on one day and the rest on the next, so both days are incomplete and the 7-day streak cannot be reached. Stamp one run-start time for the whole multi-repo sweep, or assign a sweep id and group by it. Found in PR 4688 self-review.

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
