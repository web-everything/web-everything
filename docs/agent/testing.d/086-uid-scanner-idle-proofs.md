## UID scanner idle proofs

An absent UID does not guarantee an idle result from a shared host's `/proc`: repeated process
churn or unreadable credentials deliberately retain reservations. In `forge-exec-run-reap.test.mjs`,
keep the live host busy probe, but pin the idle probe's PID listing to the test process and read
its real status file. Inject process churn, unreadable entries, and settled scans separately to
verify the production scanner's fail-closed behavior without relying on host quiescence.

