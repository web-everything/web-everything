---
bornAs: x2gsr9p
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper*.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "17469e55bc0bd7c2cb28364b533360d130d724ed"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2855's independent review

Filed mechanically on approval: the independent review owed three prevention guards — an order-test review checklist, ownership-aware claim release, and durable non-PR hold persistence before settlement. This item implements the ordering guard and files the other two debts after deduplication.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2855@a538d451018986910658228b551e5b2825fd4b3c

## Progress

- Premise rechecked against WE `17469e55bc0bd7c2cb28364b533360d130d724ed` by source inspection. The goal is not already delivered: settlement still precedes hold persistence and claim release (we:scripts/operations/deliver-item-wrapper.mjs:351-370). This is not a runtime verification.
- **Old premise:** the previous preparation located terminal ordering at wrapper lines 347–366, daemon retirement/filtering at lines 522–561, and the settled-row reader at line 1067. **Corrected premise:** ordering is at we:scripts/operations/deliver-item-wrapper.mjs:351-370; retirement is at we:skills-src/conveyor/build-dispatch-daemon.mjs:524-553; hold exclusion is at we:skills-src/conveyor/build-dispatch-daemon.mjs:563. PR success still intentionally retains its claim (we:scripts/operations/deliver-item-wrapper.mjs:635; we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3870).
- **Test-premise correction:** both real run-row readers are asynchronous (we:skills-src/conveyor/build-dispatch-daemon.mjs:1054 and we:skills-src/conveyor/build-dispatch-daemon.mjs:1098), while the tick consumes settled rows synchronously (we:skills-src/conveyor/build-dispatch-daemon.mjs:470). Await readers against each disposable store copy before supplying synchronous effects. Seed a dispatch-lane-prefixed run ID and an explicit attempt timestamp: the reader filters IDs by that prefix, and the existing seed omits `startedAt` (we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3515). Map raw hold records through their `meta` fields; the tick expects top-level item numbers (we:skills-src/conveyor/build-dispatch-daemon.mjs:486).
- **Old scope → corrected scope:** unchanged production scope, we:scripts/operations/deliver-item-wrapper.mjs, paired with we:scripts/operations/__tests__/deliver-item-wrapper*.test.mjs. That allowed pattern covers the existing suite and the proposed separate ordering suite, which does not exist in this checkout. The existing non-PR test only asserts final disk state (we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3614-3624). The daemon, claim module, and settlement module are existing dependencies to exercise, not implementation edits. The original goal also retains filing/linking the two other prevention debts during implementation.
- **Size remains 3:** one local reorder plus isolated order/persisted-prefix tests using the existing terminal fixture and effects seam (we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:320). No ownership redesign or daemon production change is included. Backlog searches for order spies, ordering comments, per-attempt ownership, and the originating review found no separate matching guard card; repeat deduplication before filing. No dependency-edge change is proposed. Existing preparation stamps are left untouched for the runner.

## Design

For terminal exits requesting a hold, execute **hold → settle → release** in `settleTerminal` (we:scripts/operations/deliver-item-wrapper.mjs:351). Keep the at-most-once latch, outcome merging, optional run identity, and per-operation best-effort handling. Move the existing hold block ahead of settlement and update its comment to explain both settlement and release ordering. Do not change which terminal outcomes request a hold or release.

Why settlement matters: the daemon can retire a still-present claim from a matching settled non-PR row (we:skills-src/conveyor/build-dispatch-daemon.mjs:530-547). A crash after today's settlement but before the hold therefore leaves neither an in-flight exclusion nor a durable hold after retirement. The candidate filter only excludes held items when the hold is actually present (we:skills-src/conveyor/build-dispatch-daemon.mjs:563).

The guarantee is bounded: after a **successful hold write**, every subsequent completed persistence boundary preserves exclusion while that hold remains unexpired. Hold replacement itself deletes then reserves (we:scripts/conveyor/build-dispatch-claim.mjs:155-156); this item does not promise atomic replacement, recovery from failed storage, protection after TTL expiry, or owner-safe release. Preserve best-effort outcome reporting and explicitly test its exceptions without claiming they provide durable exclusion.

Use a dedicated proposed suite, we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs. Partial mocks wrap the real hold, settlement, and release functions, record their call order, and copy the temporary coordination/run-store directories immediately after each completed operation. These immutable disk snapshots model interruption after that persistence boundary: subsequent wrapper writes must never reach the snapshot. For each snapshot, invoke the real `runBuildDispatchTick` from we:skills-src/conveyor/build-dispatch-daemon.mjs with disk-backed claim/hold reads and run rows derived from that snapshot; stub external queue/PR/provider effects. Read each immutable snapshot through a disposable working copy so the live tick can retire claims without mutating the saved evidence. Use the real exported run-row readers, including `cliListSettledBuilds` (we:skills-src/conveyor/build-dispatch-daemon.mjs:1098), against that copy rather than inventing settled rows. Await both `cliListSettledBuilds` and `cliListRunStoreInFlight` before invoking the tick; return their materialized arrays from synchronous effects. Set `OPERATION_RUNS_DIR` and `WE_COORDINATION_ROOT` to disposable directories and restore their previous values afterward. Map real hold records to the top-level `num`/`reason` shape the tick consumes. Never pass an async reader directly as a synchronous tick effect. This tests the persisted prefixes without pretending that a swallowed throwing spy stops execution. No production fault-injection hook or host daemon is required.

## MVP

1. Reorder hold persistence before settlement and keep claim release last in we:scripts/operations/deliver-item-wrapper.mjs. Preserve no-hold and once-only behavior.
2. Add order spies and the deterministic persisted-prefix/tick cases in we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs. Use real temporary stores, not fabricated postconditions.
3. Deduplicate and file or link the two owed backlog items: ordering-comment review checklist and per-attempt owner-token release. Record their assigned identifiers here during implementation. Implementing those two mechanisms is outside this story.

## Test plan

- Reuse the non-PR delivery setup at we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3586 in the new ordering suite. Spy on all three operations while delegating to their real implementations. Assert exact hold → settle → release order, the actual hold on disk when settlement starts, and the claim present during settlement but absent after release. Cover both `not-ready` and `gate-red`.
- Capture isolated persisted-prefix snapshots after hold, after settle, and after release. Freeze time inside the hold lease, keep the item in the cleared queue and spawn proposal, provide no PR, explicitly return empty build backoffs and pending launches, disable hold-routing side effects, and seed the run with a `dispatch-lane`-prefixed ID and `startedAt` matching the claim's attempt timestamp. Explicitly disable freeze/kill switches and supply no in-flight prepares or borrowed fixes. Run the real tick against each snapshot with dispatch calls recorded; assert zero redispatch. Include a positive control with an eligible unheld, unclaimed item and spare budget that actually dispatches, so unrelated admission gates cannot make the test vacuous. Use the effects-injection patterns in we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:320. Run with `live: true` against disposable snapshot copies; stub dispatch to record intent without launching a worker.
- Run the same capture harness against the old settlement-first sequence: the after-settle snapshot must have no hold, allow claim retirement, and permit redispatch. This is the regression's red evidence, not a synthetic hand-authored state standing in for wrapper execution.
- Verify `pr-opened` settles without hold or release; missing run identity still permits hold/release; a later telemetry throw cannot perform terminal side effects twice. Existing regression coverage includes we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3870 and we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:3979.
- Inject individual persistence exceptions and unsuccessful return values to pin best-effort reporting and at-most-once behavior. A non-throwing hold call is not proof of success: require its successful result and a readable live hold in the successful-prefix cases. Do not assert crash safety when the hold write fails. Reset mocks/environment and delete all temporary snapshots after each case.

## Proof plan

1. During implementation, run the new suite with the original ordering and save the failing order assertion and after-settle redispatch observation; then apply the reorder and obtain green results from the identical suite. No reset of unrelated lane work is necessary.
2. Run tests only through we:scripts/readiness/heavy-admission.mjs: queue Vitest for we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs, we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs, we:scripts/operations/__tests__/deliver-item-settle.test.mjs, and we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs. The invocation is Node on that admission script with `run -- npx vitest run` followed by checkout-relative paths (strip the documentation-only `we:` prefix).
3. Queue `npm run check:standards` through the same admission script. Record command results, persisted snapshot contents, and tick dispatch counts. The snapshots plus real tick are the local behavioral proof; do not claim a production daemon soak or a real process-kill test.
4. Confirm both owed follow-up identifiers are linked and represent the specific guards, not merely neighboring ownership/checklist work. No implementation, tests, or new cards are executed as part of this preparation; runner owns preparation validation and stamping.

## Follow-ups

- **Required filing — guard 1:** a review-lens checklist item requiring an order-spy test whenever a comment justifies an ordering/atomicity choice. Include the terminal ordering comment and new test as its motivating example (we:scripts/operations/deliver-item-wrapper.mjs:359). Deduplicate before filing; implementing the checklist change belongs to that follow-up.
- **Required filing — guard 2:** require a per-attempt owner token by default for `releaseBuildDispatchClaim`, with resource-only release an explicit opt-out. The current unchecked deletion and threading gap are documented at we:scripts/conveyor/build-dispatch-claim.mjs:73-89. The follow-up must trace acquisition through daemon dispatch, CLI boundary and wrapper launch, test stale-attempt release against a newer claim, and consider an owner-less-call lint/write gate. Do not implement or choose its full ownership protocol here.
- The remaining run-store read/write CAS race is separate debt, already described at we:scripts/operations/deliver-item-settle.mjs:21-24. Do not conflate that race with this ordering fix or require its implementation here.
- Real process-kill testing and failed-hold/atomic-replacement recovery remain separate hardening; the deterministic completed-persistence-prefix tests above are required here, not deferred.

## Done when

The ordering suite fails against settlement-first code and passes after hold-first ordering; each successful persistence-prefix snapshot excludes redispatch through the real tick; existing terminal semantics remain green; and the two required follow-up cards are linked. Claims are limited to successful hold persistence within its lease.
