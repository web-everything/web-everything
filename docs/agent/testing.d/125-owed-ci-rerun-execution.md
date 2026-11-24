## Owed CI rerun execution

The review daemon executes its planned `ci-timeout-rerun` rows independently of fixer seats.
Keep `owed-ci-rerun-executor.test.mjs` in the scoped gate with the timeout dispatcher and review
daemon suites. Cover oldest-first cap, non-fatal effects, an unknown-freshness (offline) checkout
refusing reruns, and executor refusals carrying `why` so logs never read "(no reason given)".
