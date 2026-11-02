---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Review dispatch on events, not only at the tick

MED priority hint. ## (held 2026-10-27 21:04 ET) Review dispatch on events, not only at the tick Measured 10-27: one review run is about 4-8 min (read about 30s; 5 juror seats in parallel, 2.5-4 min wall; referrals 0-6 min; red-team a separate 2.5-8 min). Owed-to-verdict is often 30-60+ min, mostly waiting for the next review-daemon tick (15-40 min apart) and the 12-slot cap. The daemon already wakes on pr-events but holds dispatch to the tick. Fix: dispatch a review as soon as a slot frees or a PR becomes owed (event-driven), and start red-team straight after accept. Ties into async epic #5767/#5763. Prove it: median owed-to-dispatch under 2 min. - Overlap check (21:05 ET): this overlaps backlog #5763 (review tick schedule-only, epic #5767), held card 187 (coroner-4: draft-first adds two daemon hops before the first review; pr-events already wakes on check_suite.completed) and the 10-24 card on red-team starving behind reviews. File it as ONE item under #5767 that merges all three, not a new card.

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
