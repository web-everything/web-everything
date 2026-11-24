## Lane lease renewal races

Stale-verdict deletion pins lease identity and `renewedAt`, then rechecks TTL on the moved marker.
Owner release uses identity alone so its own renewal remains releasable. Short acquire TTL fixtures
must pass `--exact-ttl` with a finite positive TTL; ordinary acquire raises short TTLs to 240 minutes,
including stored metadata. Already-expired CLI fixtures acquire normally, then use
`scripts/__tests__/fixtures/expired-lane-lease.mjs` to backdate their persisted heartbeat rather than
requesting a rejected zero TTL or sleeping for expiry. Private-IO acquire replays must supply both
TTL helpers and `DEFAULT_LEASE_TTL_MINUTES` to the VM context.
The lease-keep regression shares a real CLI barrier scenario with the soak break. Its ready FIFO
provides synchronization without filesystem watchers or polling (macOS watchers can fail with EMFILE).
