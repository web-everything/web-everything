---
bornAs: x2cs2ap
kind: task
status: open
dateOpened: "2026-11-16"
tags: [daemon, probation]
related: ["8409", "89"]
---

# S2c: external probation watcher for pre-hook crashes and stalled ticks

PR #6882's S2a ruling accepts two R825 residuals: r1, a process crashing while
modules load before its boot hook; and r2, a tick that never reaches its next
synchronous probation check. Code inside that process cannot observe its own
absence. S2a's next boot enforces the adoption deadline; the existing tick-starved
alert reports stalled progress.

## Acceptance

- Place observation outside the adopted process, using the health watcher or the
  versioned current-pointer design from card 89.
- Demonstrate an actual module-load crash and a forever-pending tick. Recovery
  remains bounded even when neither reaches another internal hook.
- Bind every observation and recovery request to the adoption UUID. Preserve
  newer adoptions, active reader leases, and unreadable recovery evidence.
- Use the runner's drain and lease-release shutdown contract; never introduce an
  in-process timer that exits independently of the caller.

## Non-goals

Application outcome checks belong to S2b. No change to the S2a guarantees or the
existing `8409` (born as `xp2v9dc`) no-reclaim/fail-closed acceptance criteria.
