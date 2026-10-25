---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add an invariant test over all review-referrals-pending refusal rows that none carries referralHo… (from web-everything/web-everything#5865 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1364` — Add an invariant test over all `review-referrals-pending` refusal rows that none carries `referralHoldAutoResolve.outcome === 'resume'`. Better, have `refuseReferralHold` normalize any non-cleared `resume` to `stay` with a generic reason. The test can be a write-gate in the planner test suite.
2. `we:scripts/conveyor/reconcile-core.mjs:1364` — In the 'cannot consume a resume' it.each cases, assert `referralHoldAutoResolve.outcome === 'stay'` (or deliberately pin the current behaviour). Longer term, a planner invariant test that a `review-referrals-pending` refusal never carries `outcome: 'resume'`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5865@247d05b63fcf6a6d2b74088e74447adfd6746e88

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
