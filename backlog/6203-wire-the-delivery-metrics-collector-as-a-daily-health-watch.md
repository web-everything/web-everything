---
bornAs: xxvode8
kind: story
size: 2
status: active
scaffoldedBy: "delivery-metrics-cards-2-lane-16-51caddc5"
dateScaffolded: "2026-10-17"
blockedBy: ["6201"]
scope: ["we:scripts/conveyor/delivery-metrics-job.mjs", "we:scripts/conveyor/__tests__/delivery-metrics-job.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Wire the delivery-metrics collector as a daily health-watch job

Run the delivery-metrics collector (we:scripts/operations/delivery-metrics.mjs) once a day as a health-watch job at 00:15 America/New_York, declared like the nightly coroner: a job module we:scripts/conveyor/delivery-metrics-job.mjs, a health-watch entry and a daemon manifest entry, honouring delivery.metrics.enabled and delivery.metrics.schedule. Split out of the collector card because PR #5487 (no card of its own) holds the health-watch and manifest files; start after it lands. Blocked on the collector card 6201.

## Acceptance

- [A1] **Executable** — From WE, `npm run test:unit -- delivery-metrics-job.test` selects we:scripts/conveyor/__tests__/delivery-metrics-job.test.mjs by filename filter; it fails before implementation and passes after, exercising every named case below.

## Test plan

All cases below are CAPABILITY tests (RED before implementation) in we:scripts/conveyor/__tests__/delivery-metrics-job.test.mjs. Drive the real health-watch registration with isolated scheduling state, a controlled clock and an observed collector invocation; tests must cover the call path as well as the job module.

- `manifestDeclaresCollectorJob` — RED; assert the real daemon manifest contains the job and health-watch resolves it to the collector module, with the intended repo/state root.
- `repeatedTicksCollectOncePerETDay` — RED; assert one collector invocation at 00:15 ET, none before it, no duplicate on subsequent ticks/restart and a new invocation on the next ET date; test both DST transitions and winter/summer UTC offsets.
- `disabledCollectorNeverRuns` — RED; delivery.metrics.enabled=false produces zero collector invocations across ticks/restarts and no scheduling-state success stamp.
- `configuredScheduleOverridesDefault` — RED; assert the default daily 00:15 America/New_York and a configured override through health-watch; invalid schedules refuse invocation without advancing success state.
- `failedAndConcurrentTicksDoNotLoseWork` — RED; race two ticks, crash before completion, recover a stale lease, resume its expired holder and restart health-watch. Assert a single active invocation, no success stamp on failure, retry through the collector's repo/date idempotency, and rejection of stale-holder completion. A successful daily publication remains unique even if a crash causes a retry.
- `boundsAndScopesCollectorInvocation` — RED; assert an argument-vector call to the fixed collector module (shell-like config cannot execute), repo/state-root scoping, a finite child timeout and explicit error on timeout/unreadable settings. The job passes the intended completed ET date and records job/attempt identity without rewriting source ledgers.

## Non-goals

- [N1] No collector calculations, history format changes, settings-file edits, dashboard or digest job. Reuse 6201's settings contract; preserve PR #5487's health-watch/manifest changes and start only after that PR lands.

## Edge cases this change must handle

1. **Untrusted text** — Call the fixed collector with an argument vector, validate schedules and bound child execution (`boundsAndScopesCollectorInvocation`, `configuredScheduleOverridesDefault`). No HTTP endpoint is added; body caps, CSRF and request rate controls do not apply.
2. **Truncated reads** — Unreadable/partial settings or scheduling state reports failure rather than defaulting to a successful run (`boundsAndScopesCollectorInvocation`, `failedAndConcurrentTicksDoNotLoseWork`). The collector owns ledger parsing.
3. **Shared state files** — Use the existing job lease mechanism, re-read state under lease, fence expired holders and stamp success after collector completion (`failedAndConcurrentTicksDoNotLoseWork`).
4. **Fail closed** — Disabled/invalid/unreadable configuration does not invoke collection; timeout/failure records an error and leaves the date retryable (`disabledCollectorNeverRuns`, `configuredScheduleOverridesDefault`, `boundsAndScopesCollectorInvocation`).
5. **Identity scoping** — Job identity, repo and coordination root follow the collector contract (`manifestDeclaresCollectorJob`, `boundsAndScopesCollectorInvocation`).
6. **State over time** — Deduplicate successful ET-day runs across ticks/restarts; retries rely on collector idempotency and DST uses America/New_York (`repeatedTicksCollectOncePerETDay`, `failedAndConcurrentTicksDoNotLoseWork`).
7. **Who wrote it** — Record the job/attempt identity and completion result; only the current lease holder may stamp success (`boundsAndScopesCollectorInvocation`, `failedAndConcurrentTicksDoNotLoseWork`).

## Risks

PR #5487 is an external prerequisite without a card; confirm it has landed before dispatch. Scheduling tests must drive health-watch and the manifest, since an isolated job test would miss registration failures. Exactly-once daily publication is the collector's guarantee; a crash before the success stamp can cause a safe retry.
