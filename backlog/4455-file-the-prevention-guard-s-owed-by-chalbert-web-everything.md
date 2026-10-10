---
bornAs: xy5mlnw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "c67450aff51f611995a003fee3fcdd52d52817c5"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2838's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). Preserve the independent review's two prevention goals: prove dispatch capacity independently of the displayed tick count, and reject backlog entries with missing or invalid work classification. The original request used the retired `workItem` field; the current classification is `kind`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2838@061e687357d7b3b2755dcfe7c7a8a8d8b93e24fc

## Progress

- Original premise/scope: the approval requested a six-building/zero-in-flight capacity guard and a required `workItem: story|epic|task` guard, initially scoped only to we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md. The previous preparation expanded that to the daemon, its existing matching test, classification tests, and proof-card wording; that four-file scope is retained.
- Corrected premise: the six/zero regression already asserts three planned dispatches at we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:460–470, but never checks the displayed count. The daemon reads `buildingInFlight` with a `building` fallback at we:skills-src/conveyor/build-dispatch-daemon.mjs:607 and projects that value into `tickCore.building` at we:skills-src/conveyor/build-dispatch-daemon.mjs:983. The production printer uses this projection at we:skills-src/conveyor/build-dispatch-daemon.mjs:2287. The original proof still demands zero at we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md:74–80. The reporting guard and proof correction therefore remain undelivered.
- Capacity correction: machine-wide `externalBuilding` is diagnostic only, per we:scripts/conveyor/build-dispatch-policy.mjs:177–183. Durable builds now consume separate Claude/external pools at we:scripts/conveyor/build-dispatch-policy.mjs:247–256. The existing fixture has no executor, which is classified as Claude at we:scripts/conveyor/build-dispatch-policy.mjs:163–165. Pin that fixture to the Claude cap of three; do not describe three as the combined cap or restore the old algorithm. The fallback regression remains at we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:478–487.
- Classification correction: `kind` replaced `workItem`; its six values are defined at we:scripts/check-standards-rules.mjs:224–236. Required-field and enum guards already exist at we:scripts/check-standards-rules.mjs:375–387 and are called for parsed items at we:scripts/check-standards.mjs:851. The matching test file ends with a valid investigation at we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs:34–44. Only coverage is owed; no validator source change or legacy-field migration is needed.
- Citation/interface correction: the previous daemon references 577/932/2108–2157 moved to 607/983/2247–2296. The JSON report at we:skills-src/conveyor/build-dispatch-daemon.mjs:2247–2277 still excludes `tickCore`; text rendering closes over `core`, `policy`, and `rows` at we:skills-src/conveyor/build-dispatch-daemon.mjs:2279–2296. Pass the existing core projection explicitly when extracting the renderer, and read policy/items from the report, preserving the JSON shape.
- Scope and sizing: old size 3 → retained size 3. Evidence is one projection at we:skills-src/conveyor/build-dispatch-daemon.mjs:983, one bounded printer extraction at we:skills-src/conveyor/build-dispatch-daemon.mjs:2279–2296, and test-only classification coverage of we:scripts/check-standards-rules.mjs:375–387. Each planned daemon source change has we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs in scope; the proof-card prose is verified against the same fixture. No dependency change or unresolved policy fork was found. This audit is source inspection, not a runtime or passing-test claim. Existing stamps are untouched; the runner owns stamping and preparation checks.

## Design

Keep capacity and display as separate observations. In we:skills-src/conveyor/build-dispatch-daemon.mjs, project the original numeric `d.counts.building` into `tickCore.building` (default zero when unavailable); retain the existing in-flight input to policy and all durable-cap behavior. For the six-proposal fixture (all candidates unclassified/Claude, Claude cap three), the report must show six building and three proposed dispatches, without launching anything.

Extract the production dry-run text rendering as an exported helper in we:skills-src/conveyor/build-dispatch-daemon.mjs accepting `{ report, core }` and an output sink, so we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs can assert the actual displayed line without consulting live coordination state. Have the CLI invoke that helper after its existing JSON early return. Read policy and rows from `report.policy` and `report.items`; pass the existing `tick.tickCore` as `core`, without adding fields to the JSON report. Preserve the other report fields and text. Feed its display count from the tick result; do not create a second count calculation in the test.

Treat classification enforcement as already implemented. Add tests of the existing validator in we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs; do not add `workItem` requirements or restrict the current six-kind vocabulary. Update the live-proof paragraph in we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md to distinguish the proposal-inclusive display from durable capacity.

## MVP

1. Extend the existing six/zero dry-run regression in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs to assert three planned dispatches, `tickCore.building === 6`, and the production text `tick core counts 6 building`. Replace the fixture’s claim acquisition, claim release, and dispatch stubs with spies and assert none are called in dry-run mode. Keep every candidate in the Claude class (absent executor is currently Claude), set `maxConcurrentBuilds: 3` explicitly, and rename the existing test to describe durable capacity rather than implying `buildingInFlight` still governs the cap.
2. Correct the projection and expose the production rendering seam in we:skills-src/conveyor/build-dispatch-daemon.mjs. Preserve JSON structure, executor-class cap policy, and live-mode behavior except for the corrected display count.
3. Add missing/empty/invalid-kind rejection cases and accepted-kind cases to we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs, using otherwise valid fixtures for each kind. A legacy `workItem` alone must not satisfy required `kind`.
4. Correct the proof instructions in we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md: six proposed builds may still display six while admitting three; live occupancy and other holds can change the observed dispatch count. Do not require a live launch to prove this reporting guard.

## Test plan

- we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs: six building / zero in flight / Claude cap three; report and production text retain six; three dispatches are planned; no mutating effects execute. Keep the existing missing-`buildingInFlight` fallback regression and durable-cap tests passing. Include differing nonzero counts (`building: 8`, `buildingInFlight: 2`) and a missing `building` with a present `buildingInFlight` to prove the display uses only the original building count and defaults to zero. Render the actual returned `tickCore` with deterministic report metadata; derive `report.wouldDispatchNow` from the same result’s `plan.dispatch.map(x => x.num)`, as the CLI does at we:skills-src/conveyor/build-dispatch-daemon.mjs:2269, rather than hard-coding three report items. Assert the count line and the three-item `would dispatch now` line together. Supply every field consumed by the extracted renderer, including `holdRouting`, `openItems`, both executor-class policy caps, and items; preserve representative hold and route text so the extraction does not silently drop existing diagnostics.
- we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs: reject absent, null, empty, and unknown `kind`; reject legacy `workItem` without `kind`; accept all current enum members using fixtures satisfying their other constraints. Assert the classification diagnostic specifically, rather than unrelated fixture errors.
- Run each file through the host queue: invoke `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <repo-relative-test-file>` (the `we:` marker denotes repository locus; strip it when executing). Then use the same queue with `npm run check:standards`. The runner owns preparation checks; these are implementation verification steps.

## Proof plan

During implementation, capture a red/green assertion for the display projection: before the correction the six/zero fixture returns zero at the reporting boundary; afterward it returns and prints six while the planned dispatch count remains three. Capture the actual production-rendered text through the injected sink, not a test-authored imitation. Record queued test commands and results. The schema negatives should pass against the existing validator; a temporary local mutation removing required-kind or enum checking must make the corresponding test fail, then be reverted.

Review the corrected proof paragraph alongside that captured output. A read-only live dry run is optional corroboration, not a deterministic prerequisite: record occupancy, freezes, and holds before interpreting its dispatch list. Never start the live daemon or dispatch builds for this item's proof.

## Follow-ups

No new dependency edges or policy decisions are needed. Do not reintroduce `workItem`, alter the capacity policy, or broaden this into a backlog migration. If verification exposes unrelated failures, record their exact evidence separately rather than expanding this guard's scope.

## Done when

1. The queued daemon regression proves three planned dispatches and a displayed count of six for the six/zero fixture, with no dry-run mutation.
2. Queued classification regressions prove the existing required-kind and enum guards, and the standards gate passes.
3. The original proof card describes those same display and capacity semantics.
