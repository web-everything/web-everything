---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/__tests__/takeover-review.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a planner test for the grant-ok-but-gated case (red CI, referral hold) that asserts the round… (from web-everything/web-everything#4759 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:1717` — Add a planner test for the grant-ok-but-gated case (red CI, referral hold) that asserts the round-cap-exhausted note is still emitted. Better: have the grant branch fall through to the note when its gates refuse.
2. `we:scripts/conveyor/reconcile-core.mjs:1704` — Route every review emission through one function that owns the gates (referral hold, scope-bloat, draft, reviewed-head, CI). Add a test table that sets each gate's flag on a takeover-head PR and expects no review dispatch. A lint or check for a bare `kind: 'review'` dispatch push outside that function would catch the class.
3. `we:scripts/conveyor/takeover-review.mjs:65` — Post a trusted dispatch marker when a takeover review is dispatched and count those, as the takeover bound already does. Add a test where a grant has been dispatched with no verdict yet and the next tick does not dispatch a second review.
4. `we:scripts/conveyor/__tests__/takeover-review.test.mjs:96` — Add a test in we:scripts/conveyor/__tests__/takeover-review.test.mjs: a takeover head with `referralHold` set yields a `review-referrals-pending` refusal and no review dispatch. Generalise it into the gate table from the previous finding.
5. `we:scripts/conveyor/takeover-review.mjs:64` — Add a deterministic regression test that records one dispatch without a verdict, reconciles again after worker exit, and asserts no second dispatch; enforce the allowance using durable dispatch accounting.
6. `we:scripts/conveyor/takeover-review.mjs:63` — Extend the named pre-takeover-head test with a SHA-less prior verdict and an unchanged head, asserting refusal; distinguish automatic launch markers from completion signals when establishing eligibility.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4759@6b11cff4469201d780b114121a760f3a65e9e648

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
