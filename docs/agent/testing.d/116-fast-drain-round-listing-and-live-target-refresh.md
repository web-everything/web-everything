## Fast-drain round listing and live target refresh

Catch-up children share the `--listing-snapshot` round file. Its default TTL is 60 seconds;
`WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC` retains the existing override. Publication time starts
the TTL after the cold listing completes. Rows retain both PR number and head OID; the target
row is replaced wholesale by a live read, so checks/body from an old head never carry forward.
The writer stores the resolved default branch with the rows; readers reuse it in process. A
historical snapshot missing the branch is upgraded under the same lock without listing again.

Waiters retry while the writer owns a live heartbeat lease up to the unchanged overall
180-second default deadline. At expiry they log an exact live-listing fallback
without publishing over the writer's shared snapshot.
The shared clone-lock primitive reclaims a dead PID or stale lease; the next writer refreshes
the snapshot. Lock IO failures defer to the next pass with an explicit error rather than
launching independent live listings.

Round rows are candidate evidence only (`complete:false`), including within the 60-second TTL.
Ordering context always re-lists live pages to discover newly opened blockers and implementation
siblings, including context-only constellation repos. Candidate repos reuse `readLiveRows` and
its hydrated heavy-field cache/shared host seed; cached fields require a matching live head and
`updatedAt`. Default-branch reuse avoids a second branch read without substituting cached rows
for live sibling discovery. Eviction reuses live context rows, or re-lists when reconcile is off.
The target always comes from `readTarget` and passes through `resolveListedChecks`, never the
snapshot's cached target row. Missing target readers throw instead of returning cached rows.
The existing drain gates and enqueue-time live revalidation run unchanged.

`fast-drain-round-lock.test.mjs` covers concurrent single-flight, a waiter within the 180-second deadline,
exact live fallback at the overall deadline despite a heartbeating writer,
stale-writer takeover, lock failure, historical branch upgrade, branch failure, TTL bounds,
oversized/incomplete/foreign evidence, target head invalidation, snapshot exclusion from live context, and
a live target replacing a stale cached target with a different head and red check.
Run it with `fast-drain-scope.test.mjs` and `merge-ai-prs.test.mjs` through heavy-admission. Keep `listing.*` phase timers for
comparison against daemon observations; fixtures prove IO counts without live GitHub calls.

Drain heavy-field hydration uses the shared ordered pool at width six. Keep seed/freshness and
cache assembly shared with the synchronous reader; a failed or incomplete heavy read rejects
the whole listing. Join outstanding reads before retrying so retries cannot exceed the pool
bound. Async listings need `withListRetryAsync` to observe rejected reads. Default-branch names
are static per process, with concurrent round/listing lookups sharing one pending read; gate
evidence still comes from live reads. The `listing hydrates heavy fields with bounded concurrency`
tests in `pr-list-paged.test.mjs` and `merge-ai-prs.test.mjs` cover these guarantees.

