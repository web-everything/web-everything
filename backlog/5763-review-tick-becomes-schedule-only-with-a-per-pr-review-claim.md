---
bornAs: xis51n3
kind: story
size: 3
parent: "5767"
status: open
blockedBy: ["5754", "5757", "5762"]
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/conveyor/review-pr-task.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Review tick becomes schedule-only, with a per-PR review claim

Slice S4 of the async-daemons epic. Today we:skills-src/conveyor/review-daemon.mjs:945-1000 runs `runReviewTick` per repo (:269) with an inline rebase (:452) and no per-PR claim (:29); the cold first tick takes 9-12.5 min after each restart. The review claim uses the W1 lifecycle; a review claim blocks only review dispatch, and a fix claim blocks review (O13); the scope-bloat rebase becomes a `mutates-tree` task; L1 applies to the review lease.

## Acceptance

- [A1] **Test (a)** — the W1 tests (a)-(g) pass for the review kind.
- [A2] **Test (b)** — a live fix claim stops review dispatch.
- [A3] **Test (c)** — a SIGSTOPped review holder test, the same as L1 (a).
- [A4] **Live** — tick under 15 s; first decision after a restart under 2 min (vs 9-12.5 min); no double review over 24 h.

## Non-goals

- [N1] Changing review policy or juror selection.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: PR text reaches only the reviewer brief, as today.
2. **Truncated reads** — A stale snapshot schedules nothing; unreadable claims count as held.
3. **Shared state files** — Review claim CAS on `runId + handle` (W1).
4. **Fail closed** — Unconfirmable review worker -> quarantined claim plus health episode (O15).
5. **Identity scoping** — Claims keyed by repo and PR; a review claim does not block fix dispatch (O13).
6. **State over time** — Restart reattaches running review tasks instead of re-dispatching.
7. **Who wrote it** — Only the review role resumes its own workers (R14).
