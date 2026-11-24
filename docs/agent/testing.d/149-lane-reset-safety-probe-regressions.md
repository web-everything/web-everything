## Lane reset safety probe regressions

`lane-pool-acquire-reset-probe-failed.test.mjs` uses a PATH Git shim activated after fetch
to isolate the reset-time status/ahead probes. Cover both transient recovery and persistent
refusal, and assert no checkout/reset/clean follows a failed probe. The bounded process
reader wraps the original stderr in `ProcReadError.cause`; preserve that stderr (or the
spawn error message) in probe diagnostics rather than reporting zero counts as proof.

