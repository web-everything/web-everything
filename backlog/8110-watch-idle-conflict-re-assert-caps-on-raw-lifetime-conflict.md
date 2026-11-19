---
bornAs: xtzgbyi
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Watch idle conflict re-assert caps on RAW lifetime conflict-fix count; reconcile caps on per-target stale cou…

Flow-sim gap R9a-G1, class K9 (divergent predicates for one state). Failing input: Open PR, labels review:pending + merge-status:conflicting, no review:changes, mergeable CONFLICTING. Thread has 3 trusted CONFLICT_FIX_COMMENT_MARKER rounds, each with trailer `main@<older sha>` (every one succeeded against a main that has since moved). 'Next parked-pr-conflict-watch sweep (idleConflictBounce, or the review:hum… Cited: we:scripts/conveyor/parked-pr-conflict-watch.mjs:1463-1465, we:scripts/conveyor/parked-pr-conflict-watch.mjs:1475-1476, we:scripts/conveyor/parked-pr-conflict-watch.mjs:1485-1493, we:scripts/conveyor/reconcile-core.mjs:2294-2297. Soak-break sketch: Fixture: PR labels [review:pending, merge-status:conflicting], mergeable CONFLICTING, comments = 3 trusted conflict-fix markers with trailers main@aaaaaaa, main@bbbbbbb, main@ccccccc (all != current main sha ddddddd). Action: watchParkedPrConflicts with a rec…

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
