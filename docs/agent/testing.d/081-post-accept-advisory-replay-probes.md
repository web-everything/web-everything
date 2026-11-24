## Post-accept advisory replay probes

The shadow advisory ledger uses recorded order, unique accepted-head identities, and a per-accept
set of measured run IDs. Persist a run marker even when no earlier accept exists; otherwise a
restart can turn an old run into a later run against a newly accepted head. Historical accepts
also fence their own head when migrating to run markers. Probe partial fanout writes followed by
a later accept and restart, concurrent duplicate and distinct runs, and duplicate or inconsistent
persisted rows. The report and recorder share the replay reducer so skipped rows cannot suppress
a valid replacement or inflate measurements. Keep these probes in the three review-loop-policy,
review-loop-cli, and review-pr-io test files.


