---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/takeover-budget.mjs", "we:scripts/conveyor/__tests__/takeover-review.test.mjs", "we:scripts/conveyor/__tests__/takeover-budget.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Review lens: for each 'only after X' or 'per Y' guarantee in the edge-case section, require a tes… (from web-everything/web-everything#4792 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/takeover-review.mjs:85` — Review lens: for each 'only after X' or 'per Y' guarantee in the edge-case section, require a test with a counter-example on the excluded side. A mutation-probe step in the review lane would also catch it.
2. `we:scripts/conveyor/takeover-budget.mjs:330` — Drop the redundant guard, or add a test where a round has events but none of them concluded. Mutation-probe each added guard.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4792@658d5eb1ec9c45ff8964f40066c4982498d361b3

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
