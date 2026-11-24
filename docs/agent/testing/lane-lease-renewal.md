## Lane lease renewal races

Stale-verdict deletion pins lease identity and `renewedAt`, then rechecks TTL on the moved marker.
Owner release uses identity alone so its own renewal remains releasable. Short acquire TTL fixtures
must pass `--exact-ttl`; ordinary acquire raises short TTLs to 240 minutes, including stored metadata.
The lease-keep regression shares a real CLI barrier scenario with the soak break. Its ready FIFO
provides synchronization without filesystem watchers or polling (macOS watchers can fail with EMFILE).
