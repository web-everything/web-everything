---
bornAs: xs2vum1
kind: story
size: 3
parent: "5452"
status: open
blockedBy: ["5454"]
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/lib/pr-events.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Review executor consumes review action-requested events from its own cursor and clone; review sweep cut over

Ruling E2: the review role becomes an executor. It reads only review action-requested events through its own log cursor, runs on its own clone (own edge version), re-checks the precondition on the head commit, and writes worker started/finished events. The old review sweep stops in the same change.

## Acceptance

- [A1] **Executable** — a test feeds the review executor a log with one review action-requested event and one fix action-requested event and asserts it starts exactly one review session and ignores the fix event.
- [A2] The executor reads only its own action kind, through its own named cursor, and runs on its own clone.
- [A3] Before starting a session it re-checks the precondition on the head commit; a stale request is recorded as skipped.
- [A4] It appends worker started before the session and worker finished after; on restart, a started request with a live worker is skipped and one with no worker and no result is checked against claims before retrying.
- [A5] The decider's review rules are flipped from shadow to live in the same change, and the old review sweep stops in the same change (no double dispatch).
- [A6] Measured: review first look p50 192 s to under 30 s; review GitHub calls per hour ~570 to under 100.

## Non-goals

- [N1] No change to how reviews are judged; only how the work is started.
- [N2] Fix and ci-heal stay on their current loops (5457, 5455).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR content stays data passed to the review session; nothing in it selects the action.
2. **Truncated reads** — a failed log read leaves the cursor in place and starts nothing.
3. **Shared state files** — claims still guard one reviewer per PR head; the request key guards against repeats.
4. **Fail closed** — if the head commit cannot be confirmed, the review is not started.
5. **Identity scoping** — requests are keyed to repo, PR, head commit and cause.
6. **State over time** — a request for a superseded head is skipped, not run.
7. **Who wrote it** — worker events name the executor role, clone and edge version.
