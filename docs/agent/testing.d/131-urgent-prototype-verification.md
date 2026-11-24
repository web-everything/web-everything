## Urgent prototype verification

`node scripts/operations/run.mjs urgent-verify --sha=<full sha>` requires a clean checkout at
that SHA. It reads CI's unit shard matrix, uses the current time-balanced covered/nocov assignments
and npm-script Vitest arguments, and runs each group sequentially through heavy admission before
`check:standards`. Unknown workflow/command layouts refuse; repair the runner or wait for CI.
Admission exhaustion stops the run without an outer retry loop. Only this runner appends full-suite
green/red receipts to `~/workspace/.operations/coordination/urgent-full-green.jsonl`.

`prototype-load --urgent --reason=<at least 10 characters>` prefers passing CI, otherwise requires
the latest exact-SHA receipt to be full, green, current-shard-count and at most two hours old.
Its signed steps must start with `fetch-main-history`, `install-fui`, `install`, then match the current CI unit plan in order, followed by coverage,
hostPaths, integration and standards. Before selecting or binding a test suite, any completed
exact-SHA check-run with failure, cancelled, timed_out, action_required or startup_failure vetoes
urgent loading. An unreadable raw check-runs response still requires the signed receipt.
Other admission gates remain in force; merging still requires real CI. Urgent admissions append
`prototype-load.urgent` events to `~/workspace/.operations/coordination/urgent-loads.jsonl`.
`urgent-verify.test.mjs` and `prototype-load.test.mjs` cover runner authorship, closed paths,
later-red supersession, event logging and the unchanged non-urgent CI gate. Run via heavy admission.

The first local step runs the workflow-pinned `sh scripts/ci/fetch-main-history.sh` in the checkout; a failure signs a red receipt before any suites. Historical green never disables verdict timeouts: after green, persist `nonGreenSince` on the first current non-green read and apply the 6h escalation / 24h unload deadlines from that observation. Loads that never passed retain their load-time deadline. A recovered green clears that episode clock and its six-hour escalation deduplication; a later non-green episode can escalate again.

