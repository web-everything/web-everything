## Review fast-pass admission

The CLI fast pass uses the ordinary daemon's self-sync wrapper, host start budget,
and queue-aware live-round budget. Both dispatch paths take the separate
`<conveyor:review-dispatch-lease>` mutex around capacity discovery and spawning,
releasing it after each candidate's admission/spawn. Discovery, planning, hold sweeps,
promotion and status tagging do not hold it. The ordinary daemon keeps its own singleton lease
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

The `cadence-load` case charges 45 seconds to ordinary maintenance and five seconds
per live PR read. `contention` holds the dispatch mutex for 45 seconds, requires the
fast attempt to defer, then advances one real configured interval before retrying.
Both run in the unit configuration as well as the soak. The `maintenance` case
holds the fast mutex while the ordinary pass performs its hold sweep.

Deployment probe: **dispatches ten pending PRs under host load within acceptance thresholds**.
Run `node scripts/operations/review-fast-pass-acceptance.mjs <evidence.json>` after
deployment. The JSON contains `labels` (ten distinct `{repo, pr, label:
"review:pending", createdAt}` GitHub events), `logLines` (raw `ISO-UTC-timestamp
review-fast-pass: owner/repo#N dispatched` lines), and `loadSamples` (`{at,
loadPerCore}` every ten seconds). All timestamps use UTC ISO strings. Require
load/core at least 0.4, no sampling gaps over 15 seconds, maximum latency at most
180000 ms and median strictly below 180000 ms. Missing evidence fails the gate.
Preserve the captured input, output, deployed SHA and settings. Synthetic fixtures
test this checker, not the LIVE guarantee. The offline repair has not run this probe
on deployed PRs; the deployment card #x7fp746
remains open.

Prevention coverage: strict stack/freshness forwarding and lost ownership are pinned
in `review-fast-pass-cli.test.mjs`; individual strict reader failures are pinned in
`review-fast-stack-evidence.test.mjs`; dynamic jobs, lanes and no-start refunds are
pinned in `review-fast-pass.test.mjs`. Job routing tests follow high care through the
job argv and into the review-loop model override. Missing or capped file scope is
high care. Unsupported job options are rejected before effects.

Session workers receive the admitted repo, PR and head through their settings
environment. The real review reader refuses a changed head before reading a diff,
checks the resolved local revision, and the label, advisory and stack-hold sinks
enforce the same pin before the existing live publication check. The session soak
executes the reader and sink using the settings captured from the spawned argv.

Prevention cards cover affected-break PR selection (#x7fp745)
and mutation/explicit ownership gates (#x7fp747).
