## Daemon smoke version skew

A rebuild runs the daemon's last-good smoke script against the candidate dispatch modules.
Stubbing a new live read in the candidate smoke script alone cannot unblock an older daemon.
Keep sentinel read isolation candidate-side: `isSmokeDryRunPr` requires both the shared
six-digit sentinel pattern and a defined `WE_SMOKE_DRYRUN_ONLY` marker (empty counts).
Limit this exception to reads; wrapped worker launches retain their sentinel refusal.

`daemon-live-smoke-skew.test.mjs` runs the historical c20bd31 fix row, or its minimal
embedded equivalent when unavailable, in a native child without test flags. It checks a
failing GitHub port, a live claim, the missing-marker refusal, and the wrapped launch refusal.
New direct smoke calls should also stub the dispatcher's actual live-read options.
The live-claim soak RED control removes both the explicit stub and the smoke marker
to deliberately exercise the production default claim reader.
