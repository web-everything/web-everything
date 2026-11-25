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

The removal-race matrix covers acquire takeover, acquire-time reap, trim, reclaim and salvage.
Each path pauses both after its verdict and after moving the marker. The moved-marker tests separately
change `renewedAt` and extend only `ttlMinutes`; the latter must keep identity and renewal version
unchanged to independently defend the freshness predicate. An isolated expression mutation test checks
that removing the freshness conjunct breaks that invariant without editing any on-disk guard.
An inventory test fails when a stale-verdict marker take is added without extending the matrix.

Renewal comparison uses the persisted JSON value, including malformed values and the distinction
between absent and null. Unchanged corrupt renewal evidence remains reclaimable after TTL expiry;
changed evidence after a verdict refuses removal. Missing-lease diagnostics select the caller's session
in history, so a later holder's release cannot hide that caller's expiry. Trim and both reclaim branches
journal the expired session as soon as its marker is taken, including later recovery refusals.

Completion signals in acquire's reaper remain gated on TTL expiry (the existing #3283 policy).
A resolved item or merged PR does not by itself prove the lane's current holder has stopped working.

`check:standards` parses production JavaScript/TypeScript callers under `scripts/` and `tools/` for
literal short-TTL acquire argv arrays without `--exact-ttl` (including joined/resolved script paths).
Dynamic argv construction and shell commands are outside this literal-array check. It also requires
each `takeMarkerIf` predicate to use `sameStaleLease` or carry a nearby `owner-operation:` explanation;
owner release and cleanup of a temporary claim intentionally accept the holder's own renewal.
