---
bornAs: xk7jz9n
kind: story
locus: plateau-app
size: 3
parent: "4624"
status: open
blockedBy: ["4914"]
scope: ["plateau-app:src/wip/progress-runs.ts", "plateau-app:src/wip/progress-runs.test.ts"]
dateOpened: "2026-10-01"
tags: []
---

# Collect standalone and delegated Plateau runs with honest identity and liveness

Add a bounded injectable Plateau run adapter for build, prepare, standalone Codex and Gemini, fix, ci-heal and review observations. Join only explicit identities, keep actual executor evidence distinct from owner and supervisor, and report partial coverage and unknown liveness without inflating moving counts.

## Lineage and delivery boundary

This story carries its assigned part of the prepared Design, Test plan and Proof plan in we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md. Keep the all-configured-repos/all-authors goal, visible unmatched work, explicit unknowns, 120-second baseline and existing action/fork flows. No new dispatch policy, launcher registration, paid probe, or display-driven GitHub call. Parent grouping does not satisfy prerequisites: use the explicit blockedBy edges. Reconcile landed dependency revisions before building; the split itself claims no runtime proof.

## Design

Create we:../plateau-app/src/wip/progress-runs.ts and its inline redacted fixture suite, we:../plateau-app/src/wip/progress-runs.test.ts. These are new files, grounded in the existing pure conversion at we:../plateau-app/src/wip/progress-read.ts:52-63 and lossy live-state projection at we:../plateau-app/src/wip/wip-read.ts:278-310. The legacy converter assumes WE card identity and only sees mapped running rows. Export collectProgressRuns({roots, now, io, liveState}) and pure projectProgressRuns(observations), returning runs, separate logical-work/job measures and source-local coverage. The integration story owns wiring; this slice can replay sources and validate its output independently without changing the active publisher.

Reuse supplied live-state observations; read bounded metadata from actual configured producer roots and checkout/lane inventories, default and explicitly configured custom log locations. Review roots follow producer checkout/override; fix claims follow coordination owner. Read-only producer evidence: we:scripts/operations/review-job-store.mjs:28, we:scripts/conveyor/fix-claim-store.mjs:12, we:scripts/operations/agent-activity-io.mjs:189, we:scripts/codex-direct-task.mjs:814 and we:scripts/gemini-direct-task.mjs:535. Do not edit producers. Default-log discovery cannot establish exhaustive custom-path coverage.

Keep owner, author, supervisor and actual executor distinct; a default model pin or process name is not served-model evidence. Producer-qualified stable IDs and explicit aliases deduplicate mappings/logs; PID alone is never identity. Corroborate process start/cwd or explicit binding. Completion/death overrides stale claims, and missing liveness is unknown, not working. Only explicit repo-qualified linkage groups jobs into logical work; preserve cross-repo identical numbers, cardless, PR-only and unmapped work. Waiting/stale/unknown remain visible and excluded from moving counts. Retain last-good observations with original timestamps on source failure; never freshen malformed input or expose transcripts/absolute host paths.

## Done when

1. Deterministic replay covers build, prepare, standalone Codex, Gemini/agy, fix, ci-heal and review without Claude registration or author/epic filters. Every output validates against the landed extended contract.
2. Explicit parent/child gives one logical work and two jobs; aliases add neither; unlinked work stays visible with incomplete logical-work coverage. PID reuse and completed-then-stale claims do not create moving jobs.
3. Bounded IO spies prove one read per source per collection, no network/launcher calls and no raw content leakage. Unavailable/custom-path gaps remain partial with truthful ages.

## Test plan

Write the new adapter tests first (RED: adapter absent). Include missing owner/model, Gemini requested/served mismatch, identical cross-repo IDs, waiting/stale/unknown, unreadable/truncated/oversized logs, source-local retained data and process-start binding. Assert exact counts/provenance, not snapshots alone. Mutations removing standalone input, merging by PID, promoting requested to served or turning unknown into zero must each fail. Replay sanitized existing observations without launching paid jobs; record unavailable producer families as unproven. Run the scoped suite and required Plateau gates.

## Scope budget and Follow-ups

Predicted implementation: 2 explicit paths; one WIP area. Even allowing this WE backlog card as one bookkeeping path/area stays below 20 paths and 4 areas. No broad directory scope. If prerequisite drift changes the touch-set, re-probe and re-slice before exceeding the gate. Record testing lessons here, never in shared agent docs. Arbitrary custom-log registration/heartbeat remains a separate producer follow-up; keep discovery coverage partial until proven.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
