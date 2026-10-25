---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Round cap refuses a fixed head after an operator-approved takeover

[held entry 292] (coroner 2026-10-13, held) Round cap refuses a fixed head after an operator-approved takeover. #5025 head 8d3f2044f refused "cap-exhausted 6/5" 15:42-16:20Z (then 7/5 after numbering) until the label was cleared by hand; ~30 min. Fix idea: an operator-approved takeover or operator answer grants exactly one review round on the next head automatically (recorded, like grant-rounds in #5169 / card 249, but no human step). Evidence: fix-dispatch + review-daemon logs 2026-10-13 15:42-16:28Z. Scope: we:scripts/lib/review-loop-policy.mjs, mechanical-round-cap. Size 2.

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
