## Review fast-pass admission

The CLI fast pass uses the ordinary daemon's self-sync wrapper, host start budget,
and queue-aware live-round budget. Both dispatch paths take the separate
`<conveyor:review-dispatch-lease>` mutex around capacity discovery and spawning,
releasing it after the pass. The ordinary daemon keeps its own singleton lease
between ticks without blocking the fast pass. Capacity is read after acquiring
the mutex; ownership is checked again immediately before each spawn.

`review-fast-pass-cli.test.mjs` and the soak break's `fixPresent` share the CLI
integration fixture. It exercises real lease and checkout locks and the real
self-sync wrapper with injected external evidence. The negative cases must refuse
before discovery on locked, quarantined or unreadable checkouts. Do not replace
this probe with a pure-orchestrator test: that would miss disconnected CLI gates.

The `ordinary` case holds and heartbeats the daemon's lifetime lease. The `race`
case enters a fast tick during an ordinary tick's spawn and requires exactly one
start with one free seat, then retries against the updated inventory. The `cadence`
case uses the real loop with a fake clock: ten PRs labelled just after successive
ticks must produce ten dispatched log lines within 180 seconds each, with median
latency below three minutes. This is deterministic cadence evidence; live host-load
acceptance measurements remain a separate deployment check.

Prevention coverage: strict stack/freshness forwarding and lost ownership are pinned
in `review-fast-pass-cli.test.mjs`; individual strict reader failures are pinned in
`review-fast-stack-evidence.test.mjs`; dynamic jobs, lanes and no-start refunds are
pinned in `review-fast-pass.test.mjs`. Job routing tests follow high care through the
job argv and into the review-loop model override. Missing or capped file scope is
high care. Unsupported job options are rejected before effects.
