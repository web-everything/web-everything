---
bornAs: xlsepow
kind: story
size: 2
priority: high
parent: "5467"
status: resolved
blockedBy: ["5469", "5470"]
relatedTo: ["5468"]
scope: ["we:scripts/lib/review-loop-policy.mjs", "we:scripts/lib/review-settings.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-09"
tags: [review]
---

# Round budget K=3: accept with cards after round K

Fixer/review proposal, operator 2026-10-08, P5. After round K, findings that are not `broken` become cards automatically and the PR is accepted; the operator gets one line per card. Confirmed `broken` findings still block at any round; the round cap of 5 still escalates. K=3, and K is a setting. Ruled: set once B1 (scoped re-review, 5469, with the binding prior round 5470) is live, so the budget is not doing B1's job. In the 2026-10-08 window, 6 of 12 round-3+ rounds had no broken finding. The rule is a pure function in the protocol card 5468's shape.

## Acceptance

- [A1] **Executable** — replay fixtures: (a) round K+1 with only non-broken findings yields accept + one card per finding (built as ONE filed card with one numbered line per finding: each filed card lands through its own lane and PR, so N cards would cost N PRs — the same choice as the prevention card); (b) a confirmed `broken` finding at round K+1 blocks; (c) round ≤ K behaves as today; (d) the cap of 5 still escalates.
- [A2] K is a declared setting; off (no budget) = today's behaviour. The shipped value is K=3, turned on only after 5469 and 5470 are live.
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

## Done when

- `npm run test:unit -- we:scripts/lib/__tests__/review-loop-policy.test.mjs` passes the `5471 [A1] round budget replay fixtures` block: (a) accept + every held finding carded, (b) a confirmed-broken (or broken / unstated-impact) finding blocks, (c) rounds 1..K as today, (d) round ≥ the cap of 5 does not act.
- `npm run test:unit -- we:scripts/lib/__tests__/review-settings.test.mjs` passes: `roundBudget` is a cascade setting (built-in `off`, file `we:scripts/review-settings.json` ships `3`, env `WE_REVIEW_ROUND_BUDGET` wins, anything invalid keeps the lower layer).
- `npm run test:unit -- we:scripts/operations/__tests__/review-loop-cli.test.mjs` passes the `cards 5471/5470` block: round 4 > K files one card through `file-item` and the same run records `accept` with the reason; round 3 and a broken finding still bounce; a failed filing stays parked.
- `node we:scripts/operations/review-round-replay.mjs --round-budget=3 --day=<ET day>` replays recorded rounds through the rule ([A4] replay); `node we:scripts/operations/review-round-replay.mjs --round-cards` reports the card count and fix rate ([A3]).

## Resolution (2026-10-09)

Built in `we:scripts/lib/review-loop-policy.mjs` (`roundBudgetDecision`, `roundCardsDecision`, `buildRoundCardsFilingInput`, `roundCardsReport`), the `roundBudget` setting in `we:scripts/lib/review-settings.mjs`, the ledger round in `we:scripts/operations/review-pr-io.mjs#readReviewRound`, and the file-then-accept branch in `we:scripts/operations/review-loop-cli.mjs`. Replay of the recorded rounds on 2026-10-08 and 2026-10-09: 6 `changes` rounds past K=3, 0 accepted with cards. Every one was held by a block-ruled CONFIRMED-broken referral, which the ruling keeps blocking. This matches the P3 revision's finding: late rounds are driven by confirmed-broken findings, not degraded ones.
