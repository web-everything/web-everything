---
bornAs: x3mfxzv
kind: story
size: 5
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Refill review and fix slots on job completion (event-driven), not only at the next daemon pass

Problem: the review daemon (we:skills-src/conveyor/review-daemon.mjs, runReviewTick caps each tick dispatch by acquirable lanes) and fix daemon (we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs, 120s DEFAULT_INTERVAL_MS) are rolling windows (keep N live) but refill only at pass boundaries. Review passes took 6-9 min on 2026-10-20 (pass timings total 399-526s), so a finished review slot idles up to a pass length. The drain already wakes on PR events (we:scripts/lib/enqueue-on-event.mjs, wake-only, debounced 15s) and the heavy queue admits waiters immediately. Proposal: when a review/fix job completes (job-store completion record or observed process exit), wake a lightweight refill step that dispatches the next owed item(s) up to the cap, reusing the pass eligibility/priority/caps code (no separate logic); debounced (about 15s) and single-flight (lock) so it cannot race the full pass; fail closed (any doubt waits for the pass). Settings review.refillOnCompletion and fix.refillOnCompletion via cascade/runtime settings (standard off), sources logged. Delivery mode: prototype, shadow first: log would refill #N now vs when the pass actually dispatched it; measure idle-slot minutes saved. Acceptance: a day of shadow numbers; no double dispatch (test concurrent pass plus refill); throughput gain at same cap. Operator approved 2026-10-20 (Ok): prototype after the runtime-settings work lands. Links: runtime settings build (in progress), card xwfgsk7 (admission by resource profile), PR #5768.

## Acceptance

- [A1] **Executable** — prototype ships with shadow mode: a day of logged "would refill #N now" vs actual pass dispatch times, with idle-slot minutes saved reported; a test running a concurrent pass and refill shows no double dispatch; throughput at the same cap improves.

## Non-goals

- [N1] No change to eligibility, priority or cap logic (the refill reuses the pass code); no change to the drain's enqueue-on-event.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: refill reads job completion records only, no free text is acted on.
2. **Truncated reads** — fail closed: an unreadable or partial completion record waits for the pass.
3. **Shared state files** — single-flight lock so refill and the full pass never dispatch together.
4. **Fail closed** — any doubt means no refill; the next pass dispatches as today.
5. **Identity scoping** — n/a: per-repo owed lists are the same ones the pass already uses.
6. **State over time** — debounce about 15 s; stale completion events are dropped once the pass has dispatched the item.
7. **Who wrote it** — n/a: the refill acts on the daemon's own jobs only.
