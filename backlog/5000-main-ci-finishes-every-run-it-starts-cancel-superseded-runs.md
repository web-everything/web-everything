---
bornAs: xbdefjb
kind: story
size: 2
parent: "3383"
status: resolved
scope: ["we:.github/workflows/ci.yml", "we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/main-ci-coverage.mjs"]
dateOpened: "2026-10-03"
dateStarted: "2026-10-03"
dateResolved: "2026-10-03"
tags: []
---

# Main CI finishes every run it starts: cancel superseded runs on PR refs only, and publish main-CI coverage

Measured 2026-10-03: of the last 100 runs of we:.github/workflows/ci.yml on main (09:25Z to 17:55Z), 85 were cancelled, 11 failed and 3 passed; every completed main run from 12:00Z to 17:24Z failed, so main was red for hours with few observations. Cause: we:.github/workflows/ci.yml:50-52 sets a per-ref concurrency group with cancel-in-progress true, and that also applies to pushes to main, so each landed PR cancels the run for the previous main head. Change: cancel superseded runs only for pull_request events (cancel-in-progress set to an expression that is true for pull_request and false for push). GitHub then keeps one running and at most one pending main run (a newer pending run replaces the older pending one), so every completed run brackets a known commit range. Also add a main-coverage signal (completed main runs over main pushes, minutes since the last completed run, the last green and first red SHA) as a JSON CLI, read by the decider (card 4998) and by #3361. Update the note in we:scripts/conveyor/main-red-recovery.mjs that calls main cancellations normal traffic. Prior art: Chromium tree sheriffs rely on a completed postsubmit signal; the GitHub Actions concurrency docs describe the one-running-one-pending behaviour. Survey: we:reports/2026-10-03-delivery-strategy-survey-and-decider.md. Done when: live proof, before and after, from gh run list on main shows the cancelled share falling and each started main run completing during a burst of merges; unit tests cover the coverage calculation.

## Done when

1. **Executable** — `npx vitest run we:scripts/__tests__/ci-main-runs-not-cancelled.test.mjs` fails on the old `cancel-in-progress: true` and passes once main runs are never cancelled.
2. **Executable** — unit tests cover the main-coverage calculation (completed main runs over main pushes, minutes since the last completed run, last green and first red SHA).
3. **Live** — `gh run list` on main, before and after, shows the cancelled share falling and each started main run completing during a burst of merges.

## Progress

- 2026-10-03 (operator-approved fast path, main-red recovery): slice 1 is in its own PR. `we:.github/workflows/ci.yml` now sets `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`, guarded by `we:scripts/__tests__/ci-main-runs-not-cancelled.test.mjs` (before: 1 failed, after: 2 passed). Still owed: the main-coverage JSON CLI, the note in `we:scripts/conveyor/main-red-recovery.mjs`, and the live before/after proof.
