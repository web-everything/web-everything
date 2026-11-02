---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# #32 D-R379 check PARKED as design (side branch lane/d-r379-check-r381 ff088991a1, 566 tests)

HIGH priority hint. - (HIGH, 11-02 11:54 ET) #32 D-R379 check PARKED as design (side branch lane/d-r379-check-r381 ff088991a1, 566 tests): reading label HISTORY for condition 2 keeps opening new holes (future-dated commit, hold across push, SHA push-away-and-restore) and now fails the normal review:pending→accepted flow. Redesign: condition 2 reads only HEAD-BOUND records — verdict ledger (accepted for this exact head sha), red-team gate record for this head, canonical audit for this head — never labels or label timelines. Condition 4: deleting or renaming any test file (any path) → FAIL. #6247 stays draft; judge keeps manual D-R379 checks.

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
