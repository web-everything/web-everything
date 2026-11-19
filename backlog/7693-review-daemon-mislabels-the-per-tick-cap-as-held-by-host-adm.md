---
bornAs: x6n8xcx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Review daemon mislabels the per-tick cap as "held by host admission"

MED priority hint. ## (held 2026-10-27 13:41 ET) Review daemon mislabels the per-tick cap as "held by host admission" At 17:05Z the tick dispatched 6 (maxReviewDispatchPerTick=6). The rest (#6014, #6010, #6009, #6006) were logged "held by host admission" with load 0.95 per core and 4.7 GB free, both under their limits, and the needs-you board then marks them stalled. Fix: name the real reason ("per-tick dispatch cap reached, next tick"), and when the cap is hit with spare capacity, run the next tick sooner.

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
