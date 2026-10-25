---
bornAs: x8fnj8r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pid-alive.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/lib/__tests__/pid-alive.test.mjs", "we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — File a card to compare the session row's startedAt against the process lstart for session-bound c… (from web-everything/web-everything#5880 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pid-alive.mjs:62` — File a card to compare the session row's `startedAt` against the process `lstart` for session-bound claims. Add a soak variant that recycles the pid into a spare while the claim is unstamped.
2. `we:scripts/lib/fix-slot-borrow.mjs:293` — Add a standards check or a test asserting that all runner-liveness predicates in we:dispatch-throttle.mjs accept an `identity` seam. Alternatively, collapse `isBorrowedRunnerDead` into `isClaimRunnerDead`.
3. `we:scripts/conveyor/fix-dispatch-claim.mjs:356` — A table-driven test for any new release branch that crosses each guard condition (awaiting, terminal, no pid) at least once. A mutation-testing gate on guard conditions in we:scripts/conveyor/fix-dispatch-claim.mjs would catch this class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5880@096b0c9f7c86d3e4ae77ca3066ae349db91577fa

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
