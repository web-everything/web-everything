---
bornAs: x428kgj
kind: task
priority: high
parent: "2405"
relatedTo: ["3007"]
status: resolved
blockedBy: ["3929"]
scope: ["we:scripts/review-ledger-check.mjs", "we:scripts/lib/review-ledger-history.mjs"]
dateOpened: "2026-09-23"
dateResolved: "2026-10-09"
tags: []
---

# record review-ledger-check runs over time across all constellation repos

From an Opus design review 2026-09-23 of #3007 Phase 2 readiness: we:scripts/review-ledger-check.mjs is a point-in-time read that saves nothing, defaults to one repo (web-everything), and #3007's own done-when asks for roughly a week of clean agreement before the merge-authority flip -- today nothing records that history, so 'a week of clean runs' cannot actually be demonstrated to a reviewer. Fix: run we:scripts/review-ledger-check.mjs on all CONSTELLATION_REPOS (we:scripts/lib/constellation-repos.mjs) on a schedule, append each run's summary (compared/agree/disagree/unledgered/unlabeled counts plus exit code) to a durable log, and surface a rolling window (e.g. last 7 days) so Phase-2 readiness becomes a checkable fact instead of a one-off manual run. Blocked on the write-gap fix (xavd54t) landing first -- otherwise every run just re-reports the same known-stale gap.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/review-ledger-history.test.mjs we:scripts/__tests__/review-ledger-check.test.mjs` passes (the history module does not exist before this item). The tests pin: a clean day needs a run for EVERY constellation repo that ET day with zero disagreement and zero unreadable PRs for the family; a gap, a missing repo, or a drift resets that family's streak only; `--history` exits 0 only when every family has 7.
2. **Live** — `node we:scripts/review-ledger-check.mjs` (no `--repo`) checks web-everything, frontierui and plateau-app and appends one run record each; `node we:scripts/review-ledger-check.mjs --history [--json]` prints per-family `streak N/7` from those records (2026-10-09: 4 records, all families streak 0 — drift on WE, plateau-app PR unreadable).

## Delivered

- New we:scripts/lib/review-ledger-history.mjs: reads the `review-ledger-check` run records and answers clean days per label family (ET days, consecutive streak, 7-day window, `ready`).
- we:scripts/review-ledger-check.mjs: no `--repo` now runs every constellation repo (one run record each; `--json` prints one `{repos:[…]}` document); `--history` runs the query. we:scripts/lib/verdict-ledger.mjs needed no change.
- Follow-ups: the schedule (generic pass-daemon manifest entry) and the WE-only `readPrFacts` that makes other repos' PRs unreadable are filed as separate cards.
