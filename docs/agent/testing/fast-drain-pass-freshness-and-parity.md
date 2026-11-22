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
`blockedBy`/`stackParents` waits visible for skipped targets while excluding them from
`ready`, even after their blocker lands. The round CLI freshness regressions in
`merge-ai-prs.test.mjs` cover newly opened siblings with fresh and expired snapshots;
its incomplete-target cases pin the separate check hold with and without an open blocker.
