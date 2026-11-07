---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/pr-sweep-core.mjs", "we:scripts/conveyor/pr-stall-classify.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Stall classifier knows 4 drain-skip kinds of the 22 the drain emits; every other stalled ready-to-merge skip …

Flow-sim gap R5b-G3, class K13 (precondition mismatch fails closed to the operator). Failing input: PR with ready-to-merge/review:accepted, no review:changes. The drain ledger records skip.kind in {checks-pending, behind, cap, head-moved, review-hold, conflicting, unknown-mergeability, couple-held, blocked-by, rebuilt-pending-ci, merge-failed, parked, ...} (we:drain-skip-reasons.mjs:13-19). Stalled past prSweep.stalledAfterMi… Cited: we:scripts/conveyor/pr-sweep-core.mjs:337-341, we:scripts/conveyor/pr-stall-classify.mjs:97-112, we:scripts/conveyor/pr-stall-classify.mjs:201. Soak-break sketch: Fixture: for each k of SKIP_KINDS build a stalled row {waitingOn:`drain-skip:${k}`, actor:'drain', liveJob:null}; call classifyStall. Assert every kind is either classed to an automatic lane or an operator state named for that kind, never the 'unknown waiting…

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
