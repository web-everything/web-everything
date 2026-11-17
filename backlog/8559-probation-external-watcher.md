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

- A1: Place observation outside the adopted process, using the health watcher or
  the versioned current-pointer design from card 89. Planned case
  `external observer detects adoption with no internal hooks` in
  `we:scripts/conveyor/soak/breaks/probation-external-observer.soak.test.mjs`
  must assert observer and adopted PIDs differ, no boot/tick hook runs in the
  adopted child, and the observer records the matching adoption UUID by its
  configured detection deadline.
- A2: Recover from an actual module-load crash. Planned case
  `module load crash recovers by the external deadline` in
  `we:scripts/conveyor/soak/breaks/probation-module-load-crash.soak.test.mjs`
  must launch a child whose imported module throws before the boot hook, assert
  its nonzero exit and absent boot proof, then observe rollback to proven-good
  and a healthy replacement within the configured total recovery budget.
- A3: Recover from a forever-pending tick without another internal hook. Planned
  case `forever pending tick recovers by the external deadline` in
  `we:scripts/conveyor/soak/breaks/probation-stalled-tick.soak.test.mjs` must hold
  a real child's first tick unresolved, assert no next tick or internal probation
  hook, and observe externally requested recovery and a healthy replacement
  within the configured total recovery budget.
- A4: Bind observations and recovery to the adoption UUID. Planned case
  `late observation for B preserves newer adoption C` in
  `we:scripts/conveyor/soak/breaks/probation-external-observer.soak.test.mjs`
  must replace B with C before each recovery await resumes and assert unchanged
  C probation, marker, rejection and proven-good bytes, with no C restart/reset.
- A5: Preserve active readers and unreadable recovery evidence. Planned cases
  `external recovery waits for live and unknown readers` and
  `external recovery retains unreadable evidence` in
  `we:scripts/conveyor/soak/breaks/probation-external-observer.soak.test.mjs`
  must assert reader entries (including expired unknown-liveness leases) are
  unchanged, HEAD is untouched while blocked, corrupt/directory evidence remains
  intact, and one needs-you alert describes the refusal. Release a known-live
  reader and assert recovery then completes within the remaining recovery budget.
- A6: Keep caller-owned drain and lease release, with no independent exit timer.
  Planned case `external recovery waits for caller drain and lease release` in
  `we:scripts/conveyor/soak/breaks/probation-external-shutdown.soak.test.mjs`
  must hold caller drain, assert the child stays alive, then release drain and
  assert accepted work completes and the lease is released exactly once before
  exit. Planned case `external probation restart uses runner shutdown ownership`
  in `we:skills-src/conveyor/__tests__/runner-shutdown.test.mjs` must assert the
  observer invokes the runner shutdown callback and installs no exit timer.

## Non-goals

Application outcome checks belong to S2b. No change to the S2a guarantees or the
existing `8409` (born as `xp2v9dc`) no-reclaim/fail-closed acceptance criteria.
