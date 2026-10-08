---
kind: story
size: 3
parent: "xf7ax93"
status: open
blockedBy: ["xu8wvf7"]
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Fix executor consumes fix action-requested events; admission re-runs on worker-finished so a freed slot fills at once

Ruling E2: the fix role becomes an executor on its own cursor and clone. A worker-finished event re-runs admission in the decider, so a freed fix slot is filled in seconds instead of on the next 5-min tick. The old fix sweep stops in the same change.

## Acceptance

- [A1] **Executable** — a test with the fix cap full appends a worker-finished event and asserts the decider requests the next queued fix in the same handling pass, not on a timer.
- [A2] The fix executor reads only fix action-requested events through its own cursor, on its own clone.
- [A3] It re-checks the precondition on the head commit before dispatch, and writes worker started/finished events.
- [A4] The decider's fix rules flip from shadow to live and the old fix sweep stops in the same change.
- [A5] Measured: fix first look 219 s to under 30 s; fix GitHub calls per hour ~1,200 to under 150; time held on caps reported in minutes.

## Non-goals

- [N1] No change to the fix agent brief or what a fix does.
- [N2] Cap values are not changed here; they stay settings.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — review findings passed to the fix worker stay data.
2. **Truncated reads** — a failed log read starts nothing and leaves the cursor in place.
3. **Shared state files** — slot holders are derived from worker events, not a second counter file.
4. **Fail closed** — a worker with no finished event past its lease is treated as holding the slot until the lease expires.
5. **Identity scoping** — requests are keyed to repo, PR, head commit and review round.
6. **State over time** — a request for a superseded head is skipped.
7. **Who wrote it** — worker events name the executor role, clone and edge version.
