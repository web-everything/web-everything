## Merge queue timeout evidence

A timeout signature does not prove a flake. Same-head timeout retries require the existing
per-test flake proof (passes on the PR head and a later main run), green main and a CLEAN PR.
Check details URLs must be corroborated by Actions job/run metadata before reading timeout logs.
Unknown or captured timeout output and incomplete aggregate logs refuse automatic recovery;
the operator must inspect the complete Actions evidence and enqueue manually.

Keep negative parser and metadata probes in `mq-timeout-audit.test.mjs`, including duplicate test
identities and final exit annotations. Historical timeout-only admission fixtures must assert a
hold; do not recreate an unconditional timeout exemption to preserve an old green fixture.
