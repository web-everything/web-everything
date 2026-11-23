---
bornAs: xowscy1
kind: story
locus: plateau-app
size: 3
parent: "4624"
status: open
blockedBy: ["4915", "4938"]
scope: ["plateau-app:src/wip/progress-read.ts", "plateau-app:src/wip/progress-read.test.ts", "plateau-app:src/wip/wip-read.ts", "plateau-app:src/wip/wip-read.test.ts", "plateau-app:src/wip/wip-model.ts", "plateau-app:src/wip/wip-model.test.ts", "plateau-app:src/wip/wip-view.ts", "plateau-app:src/wip/wip-view.css", "plateau-app:src/wip/wip-view.test.ts", "plateau-app:src/wip/wip-view.hostile.test.ts", "plateau-app:src/wip/wip-publish.test.ts", "plateau-app:scripts/wip-publish.ts"]
dateOpened: "2026-10-01"
tags: []
---

# Publish and render attributed Plateau jobs and builder holds end to end

Wire the tested run and hold adapters into the shared Plateau collector, publish their separate counts and coverage, and render every observed job with attribution and every held work item with its system next step. Prove populated publisher-to-phone delivery, stale behavior and accessible full text without extra GitHub calls.

## Lineage and delivery boundary

This story carries its assigned part of the prepared Design, Test plan and Proof plan in we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md. Keep the all-configured-repos/all-authors goal, visible unmatched work, explicit unknowns, 120-second baseline and existing action/fork flows. No new dispatch policy, launcher registration, paid probe, or display-driven GitHub call. Parent grouping does not satisfy prerequisites: use the explicit blockedBy edges. Reconcile landed dependency revisions before building; the split itself claims no runtime proof.

## Design

Wire the two adapter outputs into the existing shared collection and projection. Anchors: we:../plateau-app/src/wip/wip-read.ts:389 shares liveStatePromise, :417 reads dispatch, :440 collects progress sections; we:../plateau-app/src/wip/progress-read.ts:52 supplies the old moving projection; we:../plateau-app/src/wip/wip-model.ts:340-377 builds counts and empty holds. Keep legacy fallback where needed; enriched observations supply separate logical-work/jobs/held measures and per-source freshness, never summed units. Default collection spans configured constellation roots and authors, not the Flow epic filter. Preserve last-good ages and source-local failure boundaries.

Use the existing publisher at we:../plateau-app/scripts/wip-publish.ts and its single-flight loop; no new transport or poll. The wire guard was delivered in the compatibility predecessor. Show owner, supervisor, executor and evidence-backed model or unknown in Moving, and actual hold reasons/owner/age/counterpart or usage/next system step in Flow. Existing render seam: we:../plateau-app/src/wip/wip-view.ts:365 displays only description/state/age; :481 already renders daemon holds. Avoid duplicate counts/panels. Reuse native disclosure or existing trait, preserving focus and expansion. Full wrapping extends we:../plateau-app/src/wip/wip-view.css:197; existing focus styles at :205 remain visible.

## Done when

1. Shared collector calls each live-state/tick/source once per publish; all families, unmatched jobs and configured repos survive collector → model → publisher → authenticated relay → phone. Separate exact counts and source-local coverage match replay observations.
2. Failed/stale/unknown sources never display fresh zero or global completeness; finished/dead/waiting/stale/unknown jobs do not inflate moving. Holds do not create human actions. Existing Flow/fork links and schema-1 fallback work.
3. At 320/390 px all descriptions wrap in full, provenance remains distinct, unsafe strings are escaped, no transcripts/credentials/absolute host paths escape, and refresh preserves keyboard focus/disclosure state. Run axe and inspect landmarks, headings, names and focus order.
4. Consumer compatibility is confirmed before publisher activation. Keep the 120-second baseline, boot/sequence behavior, stale timestamps and unchanged GitHub spend over two cycles plus a second tab.

## Test plan

Extend we:../plateau-app/src/wip/progress-read.test.ts, we:../plateau-app/src/wip/wip-read.test.ts and we:../plateau-app/src/wip/wip-model.test.ts with the adapters shared populated fixtures: exact separate counts, one shared read, source-local retained ages, no author/epic filter and no synthetic human action. RED today: enriched adapters are not wired and holds stay empty. Extend we:../plateau-app/src/wip/wip-view.test.ts and we:../plateau-app/src/wip/wip-view.hostile.test.ts for full long descriptions, explicit unknown/partial states, owner versus executor, escaping and disclosure persistence. Extend we:../plateau-app/src/wip/wip-publish.test.ts:21 with populated contract payloads, unchanged serialization and failure secrecy. Re-run predecessor source/relay suites without widening their implementation scope.

Mutation checks: disconnect standalone input, drop a hold reason, mark unavailable input complete, or promote requested model to served; corresponding integration assertions must fail. Run scoped Plateau suites and required gates. No new browser harness path is assumed: use the existing running route for the manual proof below.

## Proof plan

Replay one sanitized existing observation per producer family through the publisher and authenticated phone route, recording source revision/as-of, expected ownership/liveness and exact counts. Include standalone Codex and Gemini absent from Claude listings, plus one dead/stale case and a real tick/hold case. Missing producer observations remain explicitly unproven/partial. Inspect JSON for secrets/content/absolute paths. Disconnect publication and observe aged not-live data without fresh counts. Capture 320/390 px screenshots and axe/keyboard results. Compare GitHub-spend ledger deltas over two 120-second cycles and a second tab with the unchanged baseline. No paid workers are launched for proof; record actual commands, results and limitations here.

## Scope budget and Follow-ups

Predicted implementation: 12 explicit paths; two areas (WIP and publisher). Even allowing this WE backlog card as one bookkeeping path/area stays below 20 paths and 4 areas. No broad directory scope. If prerequisite drift changes the touch-set, re-probe and re-slice before exceeding the gate. Record testing lessons here, never in shared agent docs. Arbitrary custom-log registration/heartbeat remains a separate producer follow-up; keep discovery coverage partial until proven.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
