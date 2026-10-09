---
bornAs: xy5mlnw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "c1bcbb43f37019b5f4deb96d9b9cbf63a70057ef"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2838's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). Preserve the independent review's two prevention goals: prove dispatch capacity independently of the displayed tick count, and reject backlog entries with missing or invalid work classification. The original request used the retired `workItem` field; the current classification is `kind`.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2838@061e687357d7b3b2755dcfe7c7a8a8d8b93e24fc

## Progress

- Original premise/scope: only we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md was reserved; its old line-75 citation requested a six-building/zero-in-flight dry-run guard and corrected proof wording, and its line-2 citation requested a new `workItem: story|epic|task` schema check.
- Corrected premise: the dispatch-only regression already exists at we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:460–470, but asserts only three planned dispatches. The daemon reads `buildingInFlight` at we:skills-src/conveyor/build-dispatch-daemon.mjs:575, then uses that value as `tickCore.building` at we:skills-src/conveyor/build-dispatch-daemon.mjs:928; the dry-run printer consumes it at we:skills-src/conveyor/build-dispatch-daemon.mjs:2138. Thus the six/zero fixture currently projects zero, rather than preserving the original tick count of six. The proof text still demands zero at we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md:73–78. Correct both projection and proof to preserve the review's display-semantics goal.
- Capacity has since changed: we:scripts/conveyor/build-dispatch-policy.mjs:173–183 and we:scripts/conveyor/build-dispatch-policy.mjs:239–241 explicitly exclude machine-wide `externalBuilding` from the cap; durable in-flight builds govern it. The fallback regression at we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:478–487 already protects this. Do not restore the old capacity algorithm.
- Classification drift: we:scripts/check-standards-rules.mjs:224–236 documents replacement of `workItem` by `kind`, including decision, feature, and investigation. Presence and enum validation already exist at we:scripts/check-standards-rules.mjs:375–388 and run for every parsed backlog item at we:scripts/check-standards.mjs:851. Adding the requested legacy field would contradict the current schema. Preserve that implementation and add focused negative coverage in we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs, whose current tests cover vocabulary and a valid investigation.
- Corrected scope: the proof card, daemon projection/rendering and its matching existing test file, and classification validator tests. No tick-core or cap-policy changes are needed. Size remains 3: one bounded reporting correction plus two regression groups and proof wording. Evidence above is source inspection; no runtime or passing-test claim is made during preparation.

- Re-preparation scope audit: the previous preparation already reserved the daemon, its matching test, classification tests, and the proof card; that implementation scope remains sufficient. Its daemon citations (573/899/2101) and policy citation (236–238) had drifted; the current locations are recorded above. A further interface correction is needed: the CLI report at we:skills-src/conveyor/build-dispatch-daemon.mjs:2099–2130 does not contain `tickCore`; the printer closes over `core`, `policy`, and `rows` at we:skills-src/conveyor/build-dispatch-daemon.mjs:2132–2147. A report-only renderer would therefore lose the count or require an unnecessary JSON-shape change. Pass the existing core projection explicitly, and use the report’s existing policy/items fields. Each source edit is covered by we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs; the proof-card edit is prose verified against the same fixture. Classification work remains test-only. Old size 3 → retained size 3, supported by the single projection at we:skills-src/conveyor/build-dispatch-daemon.mjs:928, bounded printer extraction at we:skills-src/conveyor/build-dispatch-daemon.mjs:2132–2147, and existing validator at we:scripts/check-standards-rules.mjs:375–387. No dependency change or unresolved policy choice was found. Existing preparation stamps are left untouched for the runner.

## Design

Keep capacity and display as separate observations. In we:skills-src/conveyor/build-dispatch-daemon.mjs, project the original numeric `d.counts.building` into `tickCore.building` (default zero when unavailable); retain the existing in-flight input to policy and all durable-cap behavior. For the six-proposal fixture, the report must show six building and three proposed dispatches, without launching anything.

Extract the production dry-run text rendering as an exported helper in we:skills-src/conveyor/build-dispatch-daemon.mjs accepting `{ report, core }` and an output sink, so we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs can assert the actual displayed line without consulting live coordination state. Have the CLI invoke that helper after its existing JSON early return. Read policy and rows from `report.policy` and `report.items`; pass the existing `tick.tickCore` as `core`, without adding fields to the JSON report. Preserve the other report fields and text. Feed its display count from the tick result; do not create a second count calculation in the test.

Treat classification enforcement as already implemented. Add tests of the existing validator in we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs; do not add `workItem` requirements or restrict the current six-kind vocabulary. Update the live-proof paragraph in we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md to distinguish the proposal-inclusive display from durable capacity.

## MVP

1. Extend the existing six/zero dry-run regression in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs to assert three planned dispatches, `tickCore.building === 6`, and the production text `tick core counts 6 building`. Replace the fixture’s claim acquisition, claim release, and dispatch stubs with spies and assert none are called in dry-run mode. Rename the existing test to describe durable capacity rather than implying `buildingInFlight` still governs the cap.
2. Correct the projection and expose the production rendering seam in we:skills-src/conveyor/build-dispatch-daemon.mjs. Preserve JSON structure, cap policy, and live-mode behavior except for the corrected display count.
3. Add missing/empty/invalid-kind rejection cases and accepted-kind cases to we:scripts/__tests__/check-standards-rules-kind-axis.test.mjs, using otherwise valid fixtures for each kind. A legacy `workItem` alone must not satisfy required `kind`.
4. Correct the proof instructions in we:backlog/4342-blocker-build-daemon-counts-tick-core-s-own-proposed-spawns.md: six proposed builds may still display six while admitting three; live occupancy and other holds can change the observed dispatch count. Do not require a live launch to prove this reporting guard.

## Test plan

- we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs: six building / zero in flight / cap three; report and production text retain six; three dispatches are planned; no mutating effects execute. Keep the existing missing-`buildingInFlight` fallback regression and durable-cap tests passing. Include differing nonzero counts (`building: 8`, `buildingInFlight: 2`) and a missing `building` with a present `buildingInFlight` to prove the display uses only the original building count and defaults to zero. Render the actual returned `tickCore` with deterministic report metadata; assert the count line and the three-item `would dispatch now` line together.
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
