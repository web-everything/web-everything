---
bornAs: xgj8yvn
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["4281"]
relatedTo: ["4075", "4282", "4284", "3007"]

dateOpened: "2026-10-04"
tags: []
---

# Declare the PR lifecycle as data over ledger state (states, next states, owner, max time, label rendering)

Epic 4075 (webhooks-not-polling) is moving PR state off GitHub: per-PR state is derived from webhook events (4281), the verdict ledger is the merge authority (3007), and labels become display-only mirrors (4284). This card therefore defines the lifecycle over LEDGER STATE, not GitHub labels. Write one data file declaring each PR state, its allowed next states, the single owning daemon, a max time in state, and how the state renders to labels. States derive from ledger events (head sha, draft, check conclusion per name per sha, review/verdict, merged/closed), the shape 4281 serves; labels are a mirror computed from the state, never an input. Provider-neutral: GitHub is one event source and one mirror target, never the state store; the map names no GitHub-only concept. Daemons keep running; this is the map they must agree with, not a new runner. Done when: (1) we:scripts/conveyor/pr-lifecycle.mjs exports the state table with fields state, derivedFrom (ledger event kinds and fields, not label names), next[], owner (a daemon id that exists in we:skills-src/conveyor/daemon-manifest.mjs), maxTimeInState, and renderLabels (the label set the mirror writes for that state, e.g. review:pending, review:human, ci:failed, ready-to-merge); (2) a pure derive function maps a PR's ledger events to exactly one state, and every state combination handled in we:scripts/conveyor/reconcile-core.mjs maps to a declared state; (3) MIGRATION ADAPTER: while labels are still the live store, a single adapter function (labelsToLedgerState) reads labels plus check status and yields the same state the ledger derive would; nothing else in the map reads labels. The adapter is removed once card 4284 (labels display-only) lands, in that card's follow-up or the first change after it, and a test fails if the adapter is still imported after 4284 is resolved; (4) a unit test in we:scripts/conveyor/__tests__/pr-lifecycle.test.mjs checks every owner is a real manifest daemon, every next[] target is a declared state, and every state has a renderLabels entry (a pure function state to labels, so the mirror is computed from it); (5) the review:human + red required check case is a declared state with an owner. Order: blocked by 4281 (event-derived state is the substrate). Not blocked by 4282, 4283 or 4284; 4284 consumes this map's renderLabels, and the adapter removal follows 4284. Incidents 2026-10-03/04: (a) review outage loop, where every review job ended blocked-on-infra in under 2s and about 20 PRs sat at review:pending, re-dispatched repeatedly with only a medium health-watch stall after 20 min; (b) #3771 re-reviewed on an unchanged head because two branches in we:scripts/conveyor/reconcile-core.mjs emitted review directly and skipped the hold; (c) a review:human PR with a red required check that no daemon owned until a ci-heal fix on 10-04; (d) silent ruling waits where a dispatch sat blocked for days with nobody told. Research: the claude.ai research page "Graph Engineering vs Our Conveyor" (4 Oct 2026). Root cause: the PR lifecycle is implicit across daemons. Keep the daemons; do not port to LangGraph/Temporal or a central orchestrator.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Findings (standalone worker, 2026-10-09)

The build-dispatch daemon held #5052 with:

> worker-declined: **could-not-prepare** — an ownership design choice remains. No files changed or stamped. Commit '2a786ea24' delivered the lifecycle table and ledger derivation, but 'HUMAN-HOLD-CI-RED' names one recovery watcher ('we:scripts/conveyor/pr-lifecycle.mjs:36') while reconcile supports CI healing, review-gate refusal, and exhausted-budget escalation ('we:scripts/conveyor/__tests__/reconcile-core.test.mjs:816'). The unresolved choice is whether to split that state by responsible owner or define 'owner' as an accountable coordinator distinct from the executor. Preparing the remaining contract would requ…

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
