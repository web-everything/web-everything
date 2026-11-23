## Catch-up snapshot warming

Catch-up warms every context repo before each child with `WE_PR_SNAPSHOT_STALE_OK_MS`
removed from a copied environment. Warm failures still launch the child; cache-only freshness
remains authoritative there. Only `SnapshotColdError` (including a wrapped cause) yields a
successful `snapshot-cold` deferral, releases catch-up room and avoids miss-backoff holds.
Validation, main movement, lock loss and incomplete lean inventory remain hard failures.
Dirty-cache fixtures must exceed the existing 10-second dirty refresh floor; keep the
production freshness rules unchanged.
Keep the CLI negative cases and the error-class-only source diff guard in
`merge-ai-prs-fast-drain-context.test.mjs`, plus the warm/spawn and room/hold contracts in
`enqueue-on-event.test.mjs`; run these through heavy admission.
