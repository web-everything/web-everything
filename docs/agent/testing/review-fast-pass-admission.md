## Review fast-pass admission

The CLI fast pass uses the ordinary daemon's self-sync wrapper, host start budget,
and queue-aware live-round budget. Its tick also takes the ordinary daemon lease;
when that lease is held it defers to the ordinary tick. Keep that lease around
both evidence discovery and dispatch: a separate fast-pass singleton cannot prevent
the ordinary and fast paths from spending the same last seat.

`review-fast-pass-cli.test.mjs` and the soak break's `fixPresent` share the CLI
integration fixture. It exercises real lease and checkout locks and the real
self-sync wrapper with injected external evidence. The negative cases must refuse
before discovery on locked, quarantined or unreadable checkouts. Do not replace
this probe with a pure-orchestrator test: that would miss disconnected CLI gates.
