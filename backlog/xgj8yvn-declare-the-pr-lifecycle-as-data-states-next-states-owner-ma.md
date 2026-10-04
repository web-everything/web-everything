---
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/conveyor/pr-lifecycle.mjs", "we:scripts/conveyor/__tests__/pr-lifecycle.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Declare the PR lifecycle as data (states, next states, owner, max time)

Write one data file declaring each PR state (derived from labels plus check status), its allowed next states, the single owning daemon, and a max time in state. Daemons keep running; this is the map they must agree with, not a new runner. Done when: (1) we:scripts/conveyor/pr-lifecycle.mjs exports the state table with fields state, derivedFrom (labels + check status), next[], owner (a daemon id that exists in we:skills-src/conveyor/daemon-manifest.mjs), maxTimeInState; (2) a pure derive function maps a PR's labels + check status to exactly one state, and every label combination handled in we:scripts/conveyor/reconcile-core.mjs maps to a state; (3) a unit test in we:scripts/conveyor/__tests__/pr-lifecycle.test.mjs checks every owner is a real manifest daemon and every next[] target is a declared state; (4) the review:human + red required check case is a declared state with an owner. Incidents 2026-10-03/04: (a) review outage loop, where every review job ended blocked-on-infra in under 2s and about 20 PRs sat at review:pending, re-dispatched repeatedly with only a medium health-watch stall after 20 min; (b) #3771 re-reviewed on an unchanged head because two branches in we:scripts/conveyor/reconcile-core.mjs emitted review directly and skipped the hold; (c) a review:human PR with a red required check that no daemon owned until a ci-heal fix on 10-04; (d) silent ruling waits where a dispatch sat blocked for days with nobody told. Research: the claude.ai research page "Graph Engineering vs Our Conveyor" (4 Oct 2026). Root cause: the PR lifecycle is implicit across daemons. Keep the daemons; do not port to LangGraph/Temporal or a central orchestrator.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
