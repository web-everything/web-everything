---
kind: task
status: open
dateOpened: "2026-11-25"
tags: [ci, testing]
---

# Check the first main CI run after merge-queue reuse lands

PR #7453 review requested live provider evidence beyond hermetic fixtures. The repair sandbox has no network; this check requires a completed post-merge run with full-test receipts.

Acceptance:

- Record the first successful full merge-group CI run after deployment, its exact SHA, and the subsequent main push run for that SHA.
- Read the main run's reuse step summary and log. Confirm it contains `mq-result-reuse: REUSING merge-queue run` with that queue run ID and SHA; verify heavy shards skip and all required checks succeed.
- Record a main push without a matching full queue run. Confirm the summary says `mq-result-reuse: full run` and heavy suites execute.
- Confirm the timing refresh following the reused push selects older runs carrying timing artifacts and can refresh timings. If no artifact-bearing run exists in the bounded window, confirm the diagnostic names the explicit-run fallback.
- Attach run URLs and observed summaries to this card before resolving it. Missing receipts, missing summaries or unavailable runs leave the live acceptance check open.

Implementation and hermetic contracts: `we:scripts/ci/mq-result-reuse.mjs`, `we:scripts/ci/refresh-timings.mjs`, `we:scripts/ci/__tests__/mq-result-reuse.test.mjs`, and `we:scripts/ci/__tests__/refresh-timings.test.mjs`.
