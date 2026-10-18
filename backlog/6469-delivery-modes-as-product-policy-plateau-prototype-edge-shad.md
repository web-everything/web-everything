---
bornAs: xc4ft34
kind: epic
parent: "2465"
status: parked
blockedBy: ["3007"]
childlessReason: blocked
dateOpened: "2026-10-18"
tags: []
---

# Delivery modes as product policy (plateau): prototype, edge, shadow, A/B, graduation

Operator 2026-10-18: delivery mode will be product-driven. Define each mode once, with entry and exit criteria: guard audit, live-proof thresholds, soak duration, and rollback. The operator picks the mode per change or per subsystem in plateau, stored as cascade settings with their sources. Existing pieces become slices:
- prototype: lane/proto-* plus the guard-audit card x2bm019 plus x9diisp (proto refs mergeable with main);
- edge: load a fix after review accept, before merge (operator rule 2026-10-17);
- shadow: ledger shadow, plus x9qibqz (gradual authority shadow→both→ledger);
- A/B: none yet (two variants side by side, with compared metrics);
- graduation: consolidated merge-back PRs with live evidence.
Prepare after the ledger is authoritative and the operator-override settings layer (xouq5b0) exists.

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
