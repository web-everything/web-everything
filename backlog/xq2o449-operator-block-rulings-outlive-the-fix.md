---
kind: story
size: 2
status: open
scope: ["we:lane-pool-recover.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Operator block rulings outlive the fix

MED priority hint. ## (held 2026-10-25 15:16 ET) Operator block rulings outlive the fix #5859: two findings (we:lane-pool-recover.mjs:207/:251) carry standing operator `block` rulings. The current head fixed them (tests at lines 271/311), but the review re-raises the same keys, and the judge can't record not-real over a block without operator --supersedes. Fix: a block ruling should bind to the head it was made on. On a later head, re-check the finding; if it is gone, the block lapses automatically and the record says so. Scope: record-referral-ruling + the review reduce step.

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
