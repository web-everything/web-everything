---
bornAs: xv8d25t
kind: story
locus: plateau-app
size: 3
parent: "4624"
status: open
blockedBy: ["4914", "4340"]
scope: ["plateau-app:src/wip/progress-holds.ts", "plateau-app:src/wip/progress-holds.test.ts"]
dateOpened: "2026-10-01"
tags: []
---

# Project Plateau builder holds from persisted and tick observations

Add a bounded injectable Plateau hold adapter joining persisted holds and existing daemon tick refusals. Preserve overlap counterparts, preparation assignment, observed capacity, raw reasons and source ages; count held work once and expose unassigned system incidents without inventing human actions.

## Lineage and delivery boundary

This story carries its assigned part of the prepared Design, Test plan and Proof plan in we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md. Keep the all-configured-repos/all-authors goal, visible unmatched work, explicit unknowns, 120-second baseline and existing action/fork flows. No new dispatch policy, launcher registration, paid probe, or display-driven GitHub call. Parent grouping does not satisfy prerequisites: use the explicit blockedBy edges. Reconcile landed dependency revisions before building; the split itself claims no runtime proof.

## Design

Create we:../plateau-app/src/wip/progress-holds.ts and we:../plateau-app/src/wip/progress-holds.test.ts as a separate adapter, extracting the hold responsibility from the parent proposal for a single run module. The observed hand-off exists: we:../plateau-app/src/wip/wip-read.ts:113 reads dispatch observations and :417 collects them once; the model still supplies unknown holds at we:../plateau-app/src/wip/wip-model.ts:358. Read-only producer evidence is we:scripts/conveyor/build-dispatch-claim.mjs:166 (unexpired persisted holds) and we:scripts/readiness/dispatch-plan.mjs:604 (overlap lease/rival evidence).

Export collectProgressHolds({roots, now, io, daemonObservations}) and pure projectProgressHolds(observations), yielding holds, held-card measure and source-local coverage. Consume #4340 actual landed tick shape; never add a second daemon-status poll or panel. Adapter replay is independently demonstrable against the extended contract; integration is a later slice.

Join persisted holds with tick refusals, deduplicating by repo-qualified work/reason/source while retaining every distinct reason and counting each held work item once. Preserve overlap occupying ref and safe repo-qualified file, recorded preparer or unassigned, observed Claude capacity usage/limit with provenance/age, and unknown raw reasons. A policy limit is not observed capacity. Expired holds and historical ticks cannot assert a current hold. Since comes from hold evidence; an as-of-only tick has unknown since. Missing remediation is an unassigned system incident with unknown next step; never manufacture a human action. Missing owner/counterpart/usage remains unknown. Retain last-good source timestamps on failure and mark coverage partial.

## Done when

1. Populated overlap, preparation, capacity and unknown-reason outputs validate against the contract and retain all reasons while yielding exact unique held-card counts.
2. Expired holds, stale ticks, partial sources and duplicate observations cannot create fresh counts, owners, capacity limits or ages.
3. Supplied tick data is reused; bounded IO has no network, launcher or duplicate polling. Outputs carry only sanitized metadata and system next steps.

## Test plan

Test first in the new inline fixture suite (RED: adapter absent): persisted plus duplicate tick refusal; multiple reasons for one card; identical cross-repo card IDs; missing preparer, counterpart and usage; observed versus policy capacity; expired/old/unknown evidence; source failure preserving last-good age. Assert exact values and no invented human action. Mutation: reset an old tick age, infer capacity from policy, or count reasons as cards; each must fail. Replay sanitized normal tick/hold observations, compare as-of times and record gaps. Run scoped tests and Plateau gates.

## Scope budget and Follow-ups

Predicted implementation: 2 explicit paths; one WIP area. Even allowing this WE backlog card as one bookkeeping path/area stays below 20 paths and 4 areas. No broad directory scope. If prerequisite drift changes the touch-set, re-probe and re-slice before exceeding the gate. Record testing lessons here, never in shared agent docs. Arbitrary custom-log registration/heartbeat remains a separate producer follow-up; keep discovery coverage partial until proven.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
