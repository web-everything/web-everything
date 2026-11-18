---
bornAs: xh6zcov
kind: investigation
status: open
dateOpened: "2026-10-28"
scope: ["we:.github/workflows/hetzner-jobs.yml", "we:.github/workflows/ci.yml", "we:scripts/merge-coverage.mjs", "we:scripts/ci/__tests__/ci-hetzner-routing.test.mjs"]
tags: [ci, coverage]
---

# Verify the Hetzner coverage artifact path through coverage-merge

The operator review of PR #6003 identified coverage-merge as a separate, unconfirmed concern near the reusable workflow's coverage upload steps. The confirmed job-name matching repair does not establish whether coverage transfer or merging is broken. Investigate this independently before changing the coverage path.

## Evidence to collect

- Inspect a completed merge-group or main-push CI run using the reusable Hetzner workflow, with the exact head SHA and job conclusions recorded.
- Trace every expected coverage-shard artifact from upload in `we:.github/workflows/hetzner-jobs.yml` to download and merge in `we:.github/workflows/ci.yml` and `we:scripts/merge-coverage.mjs`.
- Distinguish missing artifacts, wrong paths, incomplete shard coverage, and a failed coverage threshold. Record a reproducible failure or explicit evidence that the concern is not present.

## Acceptance

- Record the run and artifact evidence with a confirmed or not-reproduced conclusion.
- If confirmed, add a regression covering the actual failed transfer or merge and verify both hosted and reusable workflow paths.
- Preserve fail-closed handling for missing required coverage inputs and the existing coverage threshold.

Source: https://github.com/web-everything/web-everything/pull/6003#issuecomment-6482396728
