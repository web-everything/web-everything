---
kind: story
size: 2
status: open
scope: ["we:land-prevention-card.mjs", "we:lane-card-salvage.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #6158 parked on findings that already carry conflicting standing rulings (not-real AND block on the same findi

MED priority hint. - (2026-11-01 12:57 ET) #6158 parked on findings that already carry conflicting standing rulings (not-real AND block on the same finding, live head) and that the code already addresses (isLeaseCurrent at we:land-prevention-card.mjs:505/764/766; tests at we:lane-card-salvage.test.mjs:375/391; lease assert at release test ~232). Fix: the review gate resolves conflicting same-head rulings by a defined precedence (latest wins, or operator-only) and stops re-parking a finding already ruled on that head.

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
