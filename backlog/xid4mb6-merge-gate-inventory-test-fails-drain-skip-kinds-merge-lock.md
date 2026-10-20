---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/__tests__/merge-gate-inventory.test.mjs", "we:scripts/lib/drain-skip-reasons.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# merge-gate-inventory test fails: drain skip kinds merge-lock-held, numbering, red-team-pending are unclassified

we:scripts/lib/__tests__/merge-gate-inventory.test.mjs > 'exactly classifies every drain skip kind' fails on the drain overlay stack top (lane/hot-catchup-stale-pending-v2 lineage, seen 2026-10-20) with or without the xym8nt4 change: the received kind list has merge-lock-held, numbering and red-team-pending that the expected inventory lacks. The overlay stack added these skip kinds without updating the gate inventory. Fix: classify the three kinds in the inventory (and card-grouped from xym8nt4 if the inventory enumerates strategy kinds), so the test is green on the stack and on main once the stack graduates.

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
