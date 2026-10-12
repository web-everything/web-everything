---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/record-referral-ruling.mjs", "we:scripts/lib/policy-cascade.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Every per-PR limit gets a recorded operator override (generic grant/raise/waive)

Held finding 249 (operator 2026-10-11 ~18:25 ET: eventually all should have manual overrides). One generic recorded command (actor/channel/reason, like rulings) to grant/raise/waive any per-PR limit: review rounds, fix rounds, advisory-fix rounds, ci-heal attempts, takeover budget, freshness re-test, stacked-accept hold. Overrides layer on the cascade (standard -> platform -> repo -> env -> per-PR operator override) and the winning layer is logged. First instance: the review-cap grant (review-cap-mechanical); generalize from it. Live need then: #4715 at review cap 9/8 -> emergency WE_REVIEW_ROUND_CAP=10 on the review-daemon plist (revert after). Not queued: needs prepare (operator said eventually).

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
