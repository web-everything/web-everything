---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/__tests__/takeover-budget.test.mjs", "we:scripts/conveyor/__tests__/takeover-review.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a we:scripts/conveyor/__tests__/takeover-budget.test.mjs case 'pauses before the latest ancho… (from web-everything/web-everything#4792 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/takeover-review.mjs:85` — Add a we:scripts/conveyor/__tests__/takeover-budget.test.mjs case 'pauses before the latest anchor do not spend the grant'. A more general guard is a review lens requiring a negative test for each time-window filter.
2. `we:scripts/conveyor/__tests__/takeover-budget.test.mjs:470` — Add a review-lens or check:standards rule: when a card's 'Untrusted text' line claims forgery resistance, the diff must include a test that injects the forged line before the real one.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4792@024d81483dccf5cc9862bb3ccb234bdcfe59a9ff

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
