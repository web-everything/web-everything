## Fast-drain pass freshness and parity

Catch-up pass reuse must retain both freshness bounds: the configured round TTL
(`WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC`, zero disables it) and the cache-only source
snapshot's TTL/dirty checks. Recheck them after awaiting membership, including a hit
found under the pass lock. Cold publication also requires the lock callback's current
`stillHeld()` fence before writing; a post-callback lock rejection cannot retract
published evidence. Expired, dirty or incomplete evidence defers to the next pass;
cache-disabled operators can select live listing instead.

Head and `updatedAt` equality do not prove current CI or mergeability. Full-scope
lifecycle reconciliation needs live full rows and resolved checks for every PR it can
mutate; target scope still reads only the target and its related component live.
Keep the tier-1 zero-full-pagination assertion and frozen/recorded 18-PR parity in
`merge-ai-prs-fast-drain-listing.test.mjs`. Parity must exercise `reduceOpenPrContext`,
carrier health/couple join, overlap planning and enqueue head revalidation with differing
snapshot/live facts. Invalidation tests must distinguish rebuilding from reuse, and
lost-ownership tests must assert no file was published, not merely an eventual error.

Round target check hydration can fail closed before dependency ordering. Keep live
`blockedBy`/`stackParents` waits visible only for targets skipped for incomplete
checks while excluding them from `ready`, even after their blocker lands. The round CLI freshness regressions in
`merge-ai-prs.test.mjs` cover newly opened siblings with fresh and expired snapshots;
its incomplete-target cases pin the separate check hold with and without an open blocker.
Other skipped verdicts (review holds, red CI, fix claims, drafts and other eligibility
holds) must keep their original skip reason and must not keep idle polling alive merely
because they name an open dependency. `requiredCheckReadError` retains its separate
`required-check-read` deferral. The skip-class table in `merge-ai-prs.test.mjs` checks
both dependency types and the watch/confirm idle consumers.

For shared-planner edits, check every consumer: `ready` admission, `deferred` dependency
ordering, `isPassIdle`, `isConfirmSweepSettled`, `decideBatchesIdleExit`, and
`buildSkipReasons` precedence. Keep the operative hold visible in operator output.
`classifyPr` still accepts legacy rows without `rowsComplete`; the contract test pins
that existing behavior. Fast snapshot reuse separately requires `rowsComplete === true`.

Acceptance 5, **live single-PR catch-up drain completes within 60 seconds**, is
**OWED and unmeasured**. Hermetic CLI tests and the fixture subprocess timeout do not
prove this live latency budget. The named CLI transport/budget test checks one full
check-run read and one status read, no full pagination, and at most 30 gh calls for
an unrelated 18-PR inventory; the fake rejects check/status reads without the throttle's
invocation marker. These checks bound request shape, not GitHub or lock wait latency.

Follow-up work owed for PR #7367 (external filing and execution require network access):

- Record a live timing artifact for the named acceptance above. Time the complete
  single-PR catch-up child from spawn through exit, including throttle and lock waits,
  against an 18-open-PR inventory. Record the reviewed revision, command argv, PR and
  inventory size, cold/warm snapshot state, UTC start/end, exit status and `elapsedMs`.
  Require exit status zero and `elapsedMs <= 60000`; publish stdout/stderr with the
  artifact. Repeat for target and related-component cases. A dry run must be labeled
  as such and cannot stand in for a live enqueue measurement.
- Add a named live benchmark and evidence validator that rejects missing artifacts,
  revision mismatches, nonzero exits and elapsed times over 60000 ms. Add a PREP
  acceptance-to-evidence lint requiring each live-only acceptance to link a valid
  artifact or an explicitly open follow-up card. Green unit tests alone must never
  satisfy that acceptance.
- Mechanically require the shared-planner consumer checklist above when its behavior
  changes. The skip-class table and CLI throttle regression are implemented here.
