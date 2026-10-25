---
bornAs: x8jfnmu
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/delivery-metrics.mjs", "we:scripts/operations/__tests__/delivery-metrics.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a duplicate-start case to the wait-pairing test: two needs-you rows with the same key, then a… (from web-everything/web-everything#5507 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/delivery-metrics.mjs:122` — Add a duplicate-start case to the wait-pairing test: two needs-you rows with the same key, then a clear, asserting the wait runs from the first start. A mutation-testing pass on measure-computing functions would also catch this class of gap.
2. `we:scripts/operations/delivery-metrics.mjs:10` — Add boundary assertions: `backfillDates(d, 0)` and `backfillDates(d, 367)` throw, and `backfillDates(d, 366)` has length 366. Add a test that runs `main` with a counting `gh` and no budget override, and asserts the abort happens at call 501. More generally, a review lens could require a test for every numeric limit stated in a header comment.
3. `we:scripts/operations/delivery-metrics.mjs:6` — Gate the suite on explicit default-budget and upper-boundary tests, omitting the budget override in the default test.
4. `we:scripts/operations/__tests__/delivery-metrics.test.mjs` — Add a deterministic table-driven test gate using distinct standard, platform, feature, and environment values, asserting both effective values and provenance for each supported override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5507@084794a400e3d7e1075c3f03152e6475ad2e25df

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
