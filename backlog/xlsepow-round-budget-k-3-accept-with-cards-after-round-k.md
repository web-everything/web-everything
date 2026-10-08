---
kind: story
size: 2
parent: "x8mmzuz"
status: open
blockedBy: ["xm1mi56", "xtzqoyq"]
relatedTo: ["xdsdeeu"]
scope: ["we:scripts/lib/review-loop-policy.mjs", "we:scripts/lib/review-settings.mjs"]
dateOpened: "2026-10-08"
tags: [review]
---

# Round budget K=3: accept with cards after round K

Fixer/review proposal, operator 2026-10-08, P5. After round K, findings that are not `broken` become cards automatically and the PR is accepted; the operator gets one line per card. Confirmed `broken` findings still block at any round; the round cap of 5 still escalates. K=3, and K is a setting. Ruled: set once B1 (scoped re-review, xm1mi56, with the binding prior round xtzqoyq) is live, so the budget is not doing B1's job. In the 2026-10-08 window, 6 of 12 round-3+ rounds had no broken finding. The rule is a pure function in the protocol card xdsdeeu's shape.

## Acceptance

- [A1] **Executable** — replay fixtures: (a) round K+1 with only non-broken findings yields accept + one card per finding; (b) a confirmed `broken` finding at round K+1 blocks; (c) round ≤ K behaves as today; (d) the cap of 5 still escalates.
- [A2] K is a declared setting; off (no budget) = today's behaviour. The shipped value is K=3, turned on only after xm1mi56 and xtzqoyq are live.
- [A3] Each auto-carded finding is counted, and the count and the cards' later fix rate are reported, so card debt is visible.
- [A4] **Proof** — on a live PR reaching round K+1, before/after: accept with cards instead of another fix round.

## Non-goals

- [N1] No change to the round cap of 5 or its escalation.
- [N2] No self-accept by a fixer; the budget acts on review verdicts only.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — finding text is copied into the card as data, never parsed for severity.
2. **Truncated reads** — an unknown round number or severity counts as "block": no auto-accept.
3. **Shared state files** — cards are filed through `file-item`; the count goes through the existing ledger writer.
4. **Fail closed** — an unreadable K setting means off (today's behaviour).
5. **Identity scoping** — round count is per PR, from the ledger.
6. **State over time** — n/a: rounds, not time.
7. **Who wrote it** — severity and `CONFIRMED` come only from the review role's ledger row.
