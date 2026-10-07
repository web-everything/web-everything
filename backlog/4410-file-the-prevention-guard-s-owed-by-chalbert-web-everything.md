---
bornAs: x2gsr9p
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper*.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "75bf1ba119e1f94d53c53fcb4d4b8904c5077d85"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2855's independent review

Filed mechanically on approval: the independent review owed three prevention guards — an order-test review checklist, ownership-aware claim release, and durable non-PR hold persistence before settlement. This item implements the ordering guard and files the other two debts after deduplication.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2855@a538d451018986910658228b551e5b2825fd4b3c

## Progress

- Premise rechecked at WE `75bf1ba119e1f94d53c53fcb4d4b8904c5077d85`. This is source inspection, not a running-system verification. The goal is not already delivered: `settleTerminal` still settles first, then places the hold, then releases the claim (we:scripts/operations/deliver-item-wrapper.mjs:346-365).
- **Old premise:** the original wrapper citations were lines 330/339/353; the previous preparation cited daemon lines 314/349-367, treated an order spy as a substitute for interruption testing, and expected a PR outcome to release its claim. **Corrected premise:** the current ordering is at we:scripts/operations/deliver-item-wrapper.mjs:346-365; daemon hold collection is at we:skills-src/conveyor/build-dispatch-daemon.mjs:480 and settled-claim retirement plus candidate exclusion at we:skills-src/conveyor/build-dispatch-daemon.mjs:518-557. PR success intentionally retains its claim (we:scripts/operations/deliver-item-wrapper.mjs:630; existing test we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3820). Restore deterministic persistence-boundary fault injection with a real tick; final-state or order assertions alone do not satisfy guard 3.
- **Old scope:** wrapper plus we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs. **Corrected scope:** same production file, with the permitted we:scripts/operations/__tests__/deliver-item-wrapper*.test.mjs pattern to include a separate ordering/persistence suite. Existing terminal fixtures start at we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3428; its non-PR test checks only final state at lines 3565-3573. The separate suite avoids changing that file's real-store mock assumptions. No daemon or claim implementation change is needed; both are imported as existing dependencies. Filing the two named follow-ups remains an implementation deliverable, not an edit performed during this preparation.
- Size remains **3**: one local reorder plus isolated order/persisted-prefix tests, using the existing terminal fixture and daemon tick seam. No ownership protocol redesign is included. Preparation stamps are left to the runner.

## Design

For terminal exits requesting a hold, execute **hold → settle → release** in `settleTerminal` (we:scripts/operations/deliver-item-wrapper.mjs:346). Keep the at-most-once latch, outcome merging, optional run identity, and per-operation best-effort handling. Move the existing hold block ahead of settlement and update its comment to explain both settlement and release ordering. Do not change which terminal outcomes request a hold or release.

Why settlement matters: the daemon can retire a still-present claim from a matching settled non-PR row (we:skills-src/conveyor/build-dispatch-daemon.mjs:525-541). A crash after today's settlement but before the hold therefore leaves neither an in-flight exclusion nor a durable hold after retirement. The candidate filter only excludes held items when the hold is actually present (we:skills-src/conveyor/build-dispatch-daemon.mjs:557).

The guarantee is bounded: after a **successful hold write**, every subsequent completed persistence boundary preserves exclusion while that hold remains unexpired. Hold replacement itself deletes then reserves (we:scripts/conveyor/build-dispatch-claim.mjs:151-156); this item does not promise atomic replacement, recovery from failed storage, protection after TTL expiry, or owner-safe release. Preserve best-effort outcome reporting and explicitly test its exceptions without claiming they provide durable exclusion.

Use a dedicated proposed suite, we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs. Partial mocks wrap the real hold, settlement, and release functions, record their call order, and copy the temporary coordination/run-store directories immediately after each completed operation. These immutable disk snapshots model interruption after that persistence boundary: subsequent wrapper writes must never reach the snapshot. For each snapshot, invoke the real `runBuildDispatchTick` from we:skills-src/conveyor/build-dispatch-daemon.mjs with disk-backed claim/hold reads and run rows derived from that snapshot; stub external queue/PR/provider effects. This tests the persisted prefixes without pretending that a swallowed throwing spy stops execution. No production fault-injection hook or host daemon is required.

## MVP

1. Reorder hold persistence before settlement and keep claim release last in we:scripts/operations/deliver-item-wrapper.mjs. Preserve no-hold and once-only behavior.
2. Add order spies and the deterministic persisted-prefix/tick cases in we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs. Use real temporary stores, not fabricated postconditions.
3. Deduplicate and file or link the two owed backlog items: ordering-comment review checklist and per-attempt owner-token release. Record their assigned identifiers here during implementation. Implementing those two mechanisms is outside this story.

## Test plan

- Reuse the non-PR delivery setup at we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3536 in the new ordering suite. Spy on all three operations while delegating to their real implementations. Assert exact hold → settle → release order, the actual hold on disk when settlement starts, and the claim present during settlement but absent after release. Cover both `not-ready` and `gate-red`.
- Capture isolated persisted-prefix snapshots after hold, after settle, and after release. Freeze time inside the hold lease, keep the item in the cleared queue and spawn proposal, provide no PR, and make the settled row match the claim's attempt timestamp. Run the real tick against each snapshot with dispatch calls recorded; assert zero redispatch. Include a positive control with an eligible unheld, unclaimed item and spare budget that actually dispatches, so unrelated admission gates cannot make the test vacuous. Use the effects-injection patterns in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs.
- Run the same capture harness against the old settlement-first sequence: the after-settle snapshot must have no hold, allow claim retirement, and permit redispatch. This is the regression's red evidence, not a synthetic hand-authored state standing in for wrapper execution.
- Verify `pr-opened` settles without hold or release; missing run identity still permits hold/release; a later telemetry throw cannot perform terminal side effects twice. Existing regression coverage includes we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3820 and we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3930.
- Inject individual persistence exceptions to pin best-effort reporting and at-most-once behavior. Do not assert crash safety when the hold write fails. Reset mocks/environment and delete all temporary snapshots after each case.

## Proof plan

1. During implementation, run the new suite with the original ordering and save the failing order assertion and after-settle redispatch observation; then apply the reorder and obtain green results from the identical suite. No reset of unrelated lane work is necessary.
2. Run tests only through we:scripts/readiness/heavy-admission.mjs: queue Vitest for we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs, we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs, we:scripts/operations/__tests__/deliver-item-settle.test.mjs, and we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs. The invocation is Node on that admission script with `run -- npx vitest run` followed by checkout-relative paths (strip the documentation-only `we:` prefix).
3. Queue `npm run check:standards` through the same admission script. Record command results, persisted snapshot contents, and tick dispatch counts. The snapshots plus real tick are the local behavioral proof; do not claim a production daemon soak or a real process-kill test.
4. Confirm both owed follow-up identifiers are linked and represent the specific guards, not merely neighboring ownership/checklist work. No implementation, tests, or new cards are executed as part of this preparation; runner owns preparation validation and stamping.

## Follow-ups

- **Required filing — guard 1:** a review-lens checklist item requiring an order-spy test whenever a comment justifies an ordering/atomicity choice. Include the terminal ordering comment and new test as its motivating example (we:scripts/operations/deliver-item-wrapper.mjs:354). Deduplicate before filing; implementing the checklist change belongs to that follow-up.
- **Required filing — guard 2:** require a per-attempt owner token by default for `releaseBuildDispatchClaim`, with resource-only release an explicit opt-out. The current unchecked deletion and threading gap are documented at we:scripts/conveyor/build-dispatch-claim.mjs:73-89. The follow-up must trace acquisition through daemon dispatch, CLI boundary and wrapper launch, test stale-attempt release against a newer claim, and consider an owner-less-call lint/write gate. Do not implement or choose its full ownership protocol here.
- The remaining run-store read/write CAS race is separate debt, already described at we:scripts/operations/deliver-item-settle.mjs:24-27. Do not conflate that race with this ordering fix or require its implementation here.
- Real process-kill testing and failed-hold/atomic-replacement recovery remain separate hardening; the deterministic completed-persistence-prefix tests above are required here, not deferred.

## Done when

The ordering suite fails against settlement-first code and passes after hold-first ordering; each successful persistence-prefix snapshot excludes redispatch through the real tick; existing terminal semantics remain green; and the two required follow-up cards are linked. Claims are limited to successful hold persistence within its lease.
