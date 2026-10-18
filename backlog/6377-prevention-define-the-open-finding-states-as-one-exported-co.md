---
bornAs: x9sazq4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-referral-ruling.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/record-referral-ruling.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Prevention — Define the open-finding states as one exported constant, or a predicate such as isAwaitingReviewe… (from web-everything/web-everything#5448 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-referral-ruling.mjs:245` — Define the open-finding states as one exported constant, or a predicate such as `isAwaitingReviewer(o)`, and use it in `planRulingFollowUp`. Add a table test that runs every state value through `planRulingFollowUp`.
2. `we:scripts/operations/review-pr-io.mjs:1184` — Add a deterministic regression test covering interruption after referral persistence followed by resumption with recheckCarriedReferrals disabled.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5448@47aa32c7baf7a137a8ddd8d5b4a14e4e63ab1ed9

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
