---
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["xgj8yvn", "4281", "3007"]
relatedTo: ["4075", "4282", "4284"]
scope: ["we:scripts/conveyor/pr-transition.mjs", "we:scripts/conveyor/__tests__/pr-transition.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Route every PR state change through one transition check that appends to the ledger (edge-level loop caps)

Epic 4075 (webhooks-not-polling) is moving PR state off GitHub: per-PR state is derived from webhook events (4281), the verdict ledger is the merge authority (3007), and labels become display-only mirrors (4284). This card makes the transition check the SINGLE WRITER OF LEDGER TRANSITIONS. Daemons call one function for every PR state change. It refuses moves the lifecycle map (card xgj8yvn) does not allow, and on an allowed move it APPENDS a transition event to the PR ledger; it does not flip labels. Label mirroring is a downstream effect: a mirror consumer renders the new state to labels via the map's renderLabels, and until 4284 lands that consumer is the existing label writer. Visit counts per (PR, head SHA, state) live in the ledger (derived from its transition events), so loop caps sit on the edge, not on each code path, and survive daemon restarts. Provider-neutral: GitHub is one event source and one mirror target, never the state store. It would have stopped #3771's re-reviews whichever branch emitted them. Done when: (1) we:scripts/conveyor/pr-transition.mjs exports a transition function that checks the lifecycle map and refuses a disallowed move with a stated reason; (2) an allowed move appends one transition event to the ledger, and the visit count per (PR, head SHA, state) is read from the ledger with a per-edge cap taken from the map; no in-memory or label-based counter; (3) the function never writes a label itself; label mirroring is a separate downstream effect triggered by the appended event; (4) every state change in we:scripts/conveyor/reconcile-core.mjs, we:skills-src/conveyor/review-daemon.mjs, we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs and we:skills-src/conveyor/build-dispatch-daemon.mjs goes through it, proven by a test that fails on any direct label write or direct ledger write outside it; (5) a regression test replays the #3771 case (review emitted twice on an unchanged head from two different code paths) and shows the second is refused. Order: blocked by xgj8yvn (the map), 4281 (the event-derived ledger it appends to) and 3007 (the verdict ledger as merge authority, so verdict events and transition events share one ledger). Not blocked by 4282 (daemons reading the ledger) or 4284 (labels display-only): this card can land first, with the mirror consumer still the existing label writer; 4284 then swaps the label write for a pure mirror and defines label-drift handling (a hand-applied label is an input event, recorded, not trusted). Incidents 2026-10-03/04: (a) review outage loop, where every review job ended blocked-on-infra in under 2s and about 20 PRs sat at review:pending, re-dispatched repeatedly with only a medium health-watch stall after 20 min; (b) #3771 re-reviewed on an unchanged head because two branches in we:scripts/conveyor/reconcile-core.mjs emitted review directly and skipped the hold; (c) a review:human PR with a red required check that no daemon owned until a ci-heal fix on 10-04; (d) silent ruling waits where a dispatch sat blocked for days with nobody told. Research: the claude.ai research page "Graph Engineering vs Our Conveyor" (4 Oct 2026). Root cause: the PR lifecycle is implicit across daemons. Keep the daemons; do not port to LangGraph/Temporal or a central orchestrator.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
