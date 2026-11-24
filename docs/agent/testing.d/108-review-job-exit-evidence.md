## Review job exit evidence

Review-job diagnostics use `diagnostics/<slug>.exit.json` and `diagnostics/<slug>.ended.json`,
a subdirectory beside the live `<slug>.json` records so no valid slug can collide. Exit markers
are usable only for the ended pid; SIGKILL cannot leave a marker. Keep missing/stale
marker, redaction, bounded-tail and diagnostic-write-failure regressions in the scoped
review-job and review-daemon suites.

