---
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["xgj8yvn", "4281"]
relatedTo: ["4075", "4282", "4284", "xzzwakm"]
scope: ["we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-smells", "we:scripts/conveyor/pr-lifecycle-diagram.mjs", "we:scripts/conveyor/__tests__/pr-lifecycle-graph.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Health-watch checks the PR lifecycle map from the ledger, and a diagram is drawn from the file

Epic 4075 (webhooks-not-polling) is moving PR state off GitHub: per-PR state is derived from webhook events (4281), the verdict ledger is the merge authority (3007), and labels become display-only mirrors (4284). Health-watch therefore reads the LEDGER, not labels. It gains map-based checks, and the lifecycle (card xgj8yvn) is rendered and tested from the same file. State and time-in-state come from the ledger's derived per-PR state and transition events (4281, written by card xzzwakm); no smell calls a label API or gh to learn a PR's state. Provider-neutral: GitHub is one event source and one mirror target, never the state store; a stale event feed is its own smell (pr-events-stale), not a reason to fall back to labels. Done when: (1) a health smell flags any open PR whose ledger state has no live owner daemon; (2) a smell flags any PR past its state's max time in state, measured from the ledger's last transition event; (3) a smell parks and alerts when the same step failed fast N times for one PR (counted from ledger visit counts per (PR, head SHA, state)), appending a transition to a parked alerting state instead of re-dispatching; (4) we:scripts/conveyor/pr-lifecycle-diagram.mjs renders the lifecycle as a diagram (WIP page or docs) generated from the file, never hand-drawn, and shows each state's label rendering; (5) we:scripts/conveyor/__tests__/pr-lifecycle-graph.test.mjs fails on a dead-end state (no exit and no owner) and on a cycle with no cap; (6) a test fails if any new smell reads PR labels. Order: blocked by xgj8yvn (the map) and 4281 (the ledger it reads). Not blocked by 4282 or 4284; the smells read through the same ledger read client the daemons will use, so they need no change when 4282 and 4284 land. Incidents 2026-10-03/04: (a) review outage loop, where every review job ended blocked-on-infra in under 2s and about 20 PRs sat at review:pending, re-dispatched repeatedly with only a medium health-watch stall after 20 min; (b) #3771 re-reviewed on an unchanged head because two branches in we:scripts/conveyor/reconcile-core.mjs emitted review directly and skipped the hold; (c) a review:human PR with a red required check that no daemon owned until a ci-heal fix on 10-04; (d) silent ruling waits where a dispatch sat blocked for days with nobody told. Research: the claude.ai research page "Graph Engineering vs Our Conveyor" (4 Oct 2026). Root cause: the PR lifecycle is implicit across daemons. Keep the daemons; do not port to LangGraph/Temporal or a central orchestrator.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
