---
bornAs: x5obpr2
kind: story
size: 5
status: open
scope: ["we:scripts/operations/record-referral-ruling.mjs", "we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/lib/ruling-ledger.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/conveyor/ruling-needed-sweep.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Operator can supersede a carried block ruling: record-referral-ruling --supersedes, dispute and ruling-needed clear (held item 132)

Held item 132, hit on #4271 and #4361. A block ruling carried to a new head cannot be re-ruled: we:scripts/operations/record-referral-ruling.mjs says no open findings, while we:scripts/lib/ruling-ledger.mjs keeps reporting a ruling-dispute and advisory:ruling-needed stays stale. Fix: an explicit supersedes id, operator authority only; the dispute reads the latest ruling per finding; ruling-needed clears when nothing is pending or disputed and is dropped on accept.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
