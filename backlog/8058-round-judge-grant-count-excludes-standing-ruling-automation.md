---
bornAs: x52rloy
kind: story
size: 5
status: open
scope: ["we:scripts/lib/round-judge.mjs", "we:scripts/conveyor/round-extension-mark.mjs", "we:scripts/conveyor/pr-stall-classify.mjs", "we:scripts/conveyor/pr-stall-sweep.mjs", "we:scripts/operations/extend-rounds.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Round-judge grant count excludes standing-ruling (automation) grants, extend-rounds counts them

Flow-sim gap C-G11, class K9 (divergent predicates for one state). Failing input: PR has operator grants plus automation-authored standing-ruling grants (we:round-extension-mark.mjs:83 automation path, counted by countStandingRulingGrantRecords).' 'E15/E16 round cap reached, judge runs Cited: we:scripts/lib/round-judge.mjs:243, we:scripts/conveyor/round-extension-mark.mjs:83, we:scripts/conveyor/pr-stall-classify.mjs:287, we:scripts/conveyor/pr-stall-sweep.mjs:262, we:scripts/operations/extend-rounds.mjs:32. Soak-break sketch: review-live-round-cap-accounting (different: review job capacity; fixPresent true, we:skills-src/conveyor/review-daemon.mjs contains remainingReviewCapacity and jobAncestorOf)

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
