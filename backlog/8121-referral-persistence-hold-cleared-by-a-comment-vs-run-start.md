---
bornAs: xvi4hxg
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# referral-persistence hold cleared by a comment-vs-run-start comparison across clocks

Flow-sim gap R4-G3, class K16 (mixed clock domains). Failing input: latest review run for head H has persistenceFailed; a mandatory referral hold stands; review-set-label accepted/clear-human is attempted. local clock behind GitHub by more than the gap between an OLDER record's posting and this run's start. Cited: we:scripts/review-set-label.mjs:2778-2790, we:scripts/conveyor/review-referral-hold.mjs:73-77. Soak-break sketch: wrong-clear. An earlier record of the same head passes as 'written by the failed review', so the hold is lifted although this review's referrals were lost. (Opposite skew: legitimate record rejected -> acceptance refused, stuck until a new review.)

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
