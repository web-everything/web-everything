---
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["xgj8yvn"]
scope: ["we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-smells", "we:scripts/conveyor/pr-lifecycle-diagram.mjs", "we:scripts/conveyor/__tests__/pr-lifecycle-graph.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Health-watch checks the PR lifecycle map, and a diagram is drawn from the file

Health-watch gains map-based checks, and the lifecycle (card xgj8yvn) is rendered and tested from the same file. Done when: (1) a health smell flags any open PR in a state with no live owner daemon; (2) a smell flags any PR past its state's max time in state; (3) a smell parks and alerts when the same step failed fast N times for one PR, moving it to a parked alerting state instead of re-dispatching; (4) we:scripts/conveyor/pr-lifecycle-diagram.mjs renders the lifecycle as a diagram (WIP page or docs) generated from the file, never hand-drawn; (5) we:scripts/conveyor/__tests__/pr-lifecycle-graph.test.mjs fails on a dead-end state (no exit and no owner) and on a cycle with no cap. Incidents 2026-10-03/04: (a) review outage loop, where every review job ended blocked-on-infra in under 2s and about 20 PRs sat at review:pending, re-dispatched repeatedly with only a medium health-watch stall after 20 min; (b) #3771 re-reviewed on an unchanged head because two branches in we:scripts/conveyor/reconcile-core.mjs emitted review directly and skipped the hold; (c) a review:human PR with a red required check that no daemon owned until a ci-heal fix on 10-04; (d) silent ruling waits where a dispatch sat blocked for days with nobody told. Research: the claude.ai research page "Graph Engineering vs Our Conveyor" (4 Oct 2026). Root cause: the PR lifecycle is implicit across daemons. Keep the daemons; do not port to LangGraph/Temporal or a central orchestrator.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
