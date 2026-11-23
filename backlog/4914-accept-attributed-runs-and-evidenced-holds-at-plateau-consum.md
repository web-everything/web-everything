---
bornAs: xukxoy9
kind: story
locus: plateau-app
size: 2
parent: "4624"
status: open
blockedBy: ["4757", "4620"]
scope: ["plateau-app:src/wip/types.ts", "plateau-app:src/wip/wip-source.ts", "plateau-app:src/wip/wip-source.test.ts", "plateau-app:src/wip/wip-relay-contract.test.ts", "plateau-app:wip-relay.js"]
dateOpened: "2026-10-01"
tags: []
---

# Accept attributed runs and evidenced holds at Plateau consumer boundaries

Make Plateau types, relay validation and browser acceptance consume the extended progress contract without losing provenance or hold evidence. Validate populated examples and preserve old snapshots, payload bounds and publisher ordering before any collector emits the new fields.

## Lineage and delivery boundary

This story carries its assigned part of the prepared Design, Test plan and Proof plan in we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md. Keep the all-configured-repos/all-authors goal, visible unmatched work, explicit unknowns, 120-second baseline and existing action/fork flows. No new dispatch policy, launcher registration, paid probe, or display-driven GitHub call. Parent grouping does not satisfy prerequisites: use the explicit blockedBy edges. Reconcile landed dependency revisions before building; the split itself claims no runtime proof.

## Design

Actual consumer seams: we:../plateau-app/src/wip/types.ts:248 has ProgressRun without executor provenance; :273 has basic holds. The client uses relay validation at we:../plateau-app/src/wip/wip-source.ts:44. The relay validates base run/hold fields at we:../plateau-app/wip-relay.js:786-800 but not the new evidence. Extend these existing boundaries against the landed WE fixture corpus; no new schema-major guess and no publisher enablement here.

Accept absent optional extensions as unknown, validate every present extension, and retain all valid provenance and source timestamps through serialization. Preserve schema-1 fallback, old schema-2 snapshots, scope-less contract snapshots, unknown-state evidence and payload limits. Deploy compatible relay/client before enabling publication in the integration story. This is independently useful compatibility hardening with a fixture-driven relay/client demonstration.

## Done when

1. The populated contract examples traverse the authenticated relay and browser source unchanged, including requested versus reported model and capacity/overlap evidence. Invalid extensions fail with exact errors; unknown majors and payloads above 900,000 bytes still reject.
2. Schema 1 and earlier schema 2 remain accepted; missing extension fields do not fabricate attribution. Boot/sequence ordering, including persisted ordering, remains intact.
3. Run the source and relay contract suites plus required Plateau gates; record deployed consumer compatibility or its remaining deployment limitation before publisher enablement.

## Test plan

Extend we:../plateau-app/src/wip/wip-source.test.ts:254 and we:../plateau-app/src/wip/wip-relay-contract.test.ts:898 with populated upstream fixtures and malformed provenance/hold extensions. RED today: malformed extensions are not checked. Assert exact retained values, rejection errors, stale timestamps, new publisher boot and lower-sequence rejection. Mutation: drop evidence in transit or remove extension validation; the matching test must fail.

## Scope budget and Follow-ups

Predicted implementation: 5 explicit paths; two areas (WIP and relay). Even allowing this WE backlog card as one bookkeeping path/area stays below 20 paths and 4 areas. No broad directory scope. If prerequisite drift changes the touch-set, re-probe and re-slice before exceeding the gate. Record testing lessons here, never in shared agent docs. Arbitrary custom-log registration/heartbeat remains a separate producer follow-up; keep discovery coverage partial until proven.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
