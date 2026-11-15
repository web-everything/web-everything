---
kind: story
size: 5
status: open
dateOpened: "2026-11-14"
tags: []
---

# Migrate remaining Claude session readers before enabling account B

Auth-split PR2 ships routing.accountB false. Do not flip it until all production session consumers use we:scripts/lib/claude-sessions.mjs and this card's tests pass. Launch routing alone cannot protect claims held by B workers when an unmapped watchdog reads A. Keep B's config entry and directory through rollback until every B session has drained.

## Acceptance

- [A1] Replace direct agents/stop commands in the sites below with the shared profile-aware helper. Preserve each caller's injected IO, active versus all-session semantics, timeout and error-to-unknown behavior. No partial profile result may authorize claim release.
- [A2] Add `orphan claim release keeps claims for a live account B session` in we:scripts/conveyor/__tests__/orphan-claim-release.test.mjs. An unmapped daemon sees an unrelated A session and a live B claim owner; the real reader must return both and the pass must release nothing. Repeat after rollback. Inject failure in each profile and assert no release.
- [A3] Add a table-driven wiring test for every migrated consumer and a CLI fixture proving options.env reaches the subprocess through local run wrappers. Test enable/rollback with simultaneous A/B workers; retain claims and stop each originating job.
- [A5] Resume reaches the session's ORIGINAL profile. Rows from we:scripts/lib/claude-sessions.mjs carry the job store they came from, and a `--resume <id>` spawn (we:scripts/operations/dispatch-lane-io.mjs buildAgentArgv) plus its trust grant use that store, never the current routing. Add `resume after enable and rollback reaches the originating profile`; a resume whose profile is unknown refuses instead of falling back to a fresh dispatch beside a live session.
- [A4] `npm run check:standards` reports no direct production Claude agents/stop calls outside the helper. Promote the migration warnings to whole-repository errors once the legacy sites are removed. Only then may the operator's separate switch-flip change enable B.

## Remaining sites

- we:scripts/conveyor/orphan-claim-release.mjs, we:scripts/conveyor/session-watchdog.mjs, we:scripts/conveyor/driver-watchdog.mjs, we:scripts/conveyor/liveness-sweep.mjs, we:scripts/conveyor/pool-exhaustion.mjs, we:scripts/conveyor/health-watch.mjs and we:scripts/conveyor/reconcile-pass.mjs.
- we:scripts/lib/lane-salvage.mjs, we:scripts/lib/pr-state-io.mjs and we:scripts/lib/reap-dead-review-runs.mjs.
- we:scripts/operations/land-advance-io.mjs, we:scripts/operations/explore-io.mjs, we:scripts/operations/operator-controls-io.mjs and we:scripts/operations/operator-why-io.mjs.
- we:scripts/lane-whois.mjs and we:scripts/probes/worker-result-probe.mjs.

## Risks and test plan

- A swallowed env option silently restores A-only reads. A3 captures actual child environment through the real wrapper, not only a helper spy.
- One unreadable profile must not look empty. A2 injects timeout, malformed JSON, missing login and permission failures; ownership remains held.
- Cached rows must remain profile-scoped and validate profile state first. Run we:scripts/operations/__tests__/dispatch-account-lifecycle.test.mjs and we:scripts/operations/__tests__/session-role.test.mjs as controls; add the A2/A3 fixtures before migration and record their red results.
- The direct-call standards guard is syntax-aware; comments and CLI fixture strings must remain excluded. Run we:scripts/__tests__/check-standards-account-routing.test.mjs.

## Non-goals

No switch flip, token migration, new account provisioning, or repair of the separately disclosed unreadable-map residual.

## Edge cases this change must handle

1. **Untrusted text** — argv arrays only; stop exact validated handles; never include credentials in settings or logs.
2. **Truncated reads** — oversized/malformed output is unknown, not an empty successful listing; A2/A3.
3. **Shared state files** — retain existing profile cache isolation and claim locking; A2 claims survive repeated passes.
4. **Fail closed** — a failed profile read blocks orphan release and is visible; A2.
5. **Identity scoping** — unmapped daemons must query the same job stores as mapped workers; A2/A3.
6. **State over time** — enable and rollback preserve both profiles until drained; A3.
7. **Who wrote it** — session presence alone never grants ownership; retain exact claim-owner/session checks; A2.

## Duplicate admission

This follows PR2's remaining session-reader coverage findings; the existing account-switch preservation story concerns lane content and launch provenance, not migration of these management readers.
