---
bornAs: x428kgj
kind: task
priority: high
parent: "2405"
relatedTo: ["3007"]
status: open
blockedBy: ["3929"]
scope: ["we:scripts/review-ledger-check.mjs", "we:scripts/lib/verdict-ledger.mjs"]
dateOpened: "2026-09-23"
tags: []
---

# record review-ledger-check runs over time across all constellation repos

From an Opus design review 2026-09-23 of #3007 Phase 2 readiness: we:scripts/review-ledger-check.mjs is a point-in-time read that saves nothing, defaults to one repo (web-everything), and #3007's own done-when asks for roughly a week of clean agreement before the merge-authority flip -- today nothing records that history, so 'a week of clean runs' cannot actually be demonstrated to a reviewer. Fix: run we:scripts/review-ledger-check.mjs on all CONSTELLATION_REPOS (we:scripts/lib/constellation-repos.mjs) on a schedule, append each run's summary (compared/agree/disagree/unledgered/unlabeled counts plus exit code) to a durable log, and surface a rolling window (e.g. last 7 days) so Phase-2 readiness becomes a checkable fact instead of a one-off manual run. Blocked on the write-gap fix (xavd54t) landing first -- otherwise every run just re-reports the same known-stale gap.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
