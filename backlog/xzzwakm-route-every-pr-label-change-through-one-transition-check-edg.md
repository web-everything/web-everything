---
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["xgj8yvn"]
scope: ["we:scripts/conveyor/pr-transition.mjs", "we:scripts/conveyor/__tests__/pr-transition.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Route every PR label change through one transition check (edge-level loop caps)

Daemons call one function for every PR label change. It refuses moves the lifecycle map (card xgj8yvn) does not allow and counts visits per (PR, head SHA, state), so loop caps sit on the edge, not on each code path. It would have stopped #3771's re-reviews whichever branch emitted them. Done when: (1) we:scripts/conveyor/pr-transition.mjs exports a transition function that checks the lifecycle map and refuses a disallowed move with a stated reason; (2) it keeps a visit counter keyed by (PR, head SHA, state) with a per-edge cap taken from the map; (3) every label write in we:scripts/conveyor/reconcile-core.mjs, we:skills-src/conveyor/review-daemon.mjs, we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs and we:skills-src/conveyor/build-dispatch-daemon.mjs goes through it, proven by a test that fails on any direct label write outside it; (4) a regression test replays the #3771 case (review emitted twice on an unchanged head from two different code paths) and shows the second is refused. Incidents 2026-10-03/04: (a) review outage loop, where every review job ended blocked-on-infra in under 2s and about 20 PRs sat at review:pending, re-dispatched repeatedly with only a medium health-watch stall after 20 min; (b) #3771 re-reviewed on an unchanged head because two branches in we:scripts/conveyor/reconcile-core.mjs emitted review directly and skipped the hold; (c) a review:human PR with a red required check that no daemon owned until a ci-heal fix on 10-04; (d) silent ruling waits where a dispatch sat blocked for days with nobody told. Research: the claude.ai research page "Graph Engineering vs Our Conveyor" (4 Oct 2026). Root cause: the PR lifecycle is implicit across daemons. Keep the daemons; do not port to LangGraph/Temporal or a central orchestrator.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
