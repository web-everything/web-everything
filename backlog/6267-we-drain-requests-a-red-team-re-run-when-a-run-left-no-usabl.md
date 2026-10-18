---
bornAs: xogmcq9
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job-red-team.test.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: drain requests a red-team re-run when a run left no usable result (wire requestRedTeam)

The drain's requestRedTeam hook in we:scripts/lib/drain-merge-strategy.mjs (around lines 211 and 346) defaults to null and no caller passes it, so a red-team run that left no usable result is never re-requested. Live case: PR #5485, red team unparseable at 21:22Z; the review daemon's already-reviewed hold means nothing re-runs it. Wire requestRedTeam and re-arm the review daemon.

Wiring the hook alone is not enough. Today a run that failed still counts as `recorded`:

- `completeRedTeam` (we:scripts/operations/review-extra-seats.mjs) writes the seat row of a failed run and still returns status `ran`.
- we:scripts/operations/review-job.mjs stores that `ran` as the status file's `result`.
- `readDrainRedTeamEvidence` (we:scripts/lib/drain-red-team-evidence.mjs) sets `recorded` from any matching seat row, and from `result === 'ran'`, without checking that the run succeeded.
- The drain returns before `requestRedTeam` whenever `recorded` is true.

So an unparseable run never reaches the hook. This card makes the evidence say whether a recorded run left a usable result, and keys the re-run on that. The drain's callers in we:scripts/merge-ai-prs.mjs pass the hook.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/drain-merge-strategy.test.mjs, we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs, we:scripts/operations/__tests__/review-job-red-team.test.mjs and we:scripts/conveyor/__tests__/review-referral-hold.test.mjs. Named tests, one per guarantee:
  - `evidence reports usable only for a red-team seat row with status ok on this head`
  - `a recorded seat row with status unparseable, error or timeout counts as no usable result`
  - `the status file carries the seat status, so a failed run marked ran is not usable`
  - `the drain passes requestRedTeam so a run with no usable result requests a re-run`
  - `a recorded but unusable run reaches requestRedTeam, which the recorded early return used to block`
  - `a seat row with status quota-exhausted, disabled or skipped is not re-requested, so the quota hold and daily cap stay in charge`
  - `a red team that left no usable result re-arms the review hold for that head`
  - `a head with a usable red-team result is not re-requested`
  - `the request is made once per head, not every tick`
  - `a re-run that is unusable again is not re-requested on the same head and stays held`
  - `a recorded but unusable run is held, not enqueued, when no request succeeds (never waived by enqueueWhenRedTeamNeverScheduled)`
  - `a failing requestRedTeam call is caught and the drain continues with other PRs`
- [A2] Live case: PR #5485 (red team unparseable at 21:22Z) gets a re-run with before/after evidence.

## Non-goals

- [N1] Does not change how the red team judges, only when a missing result is re-requested.
- [N2] Does not change which seat statuses the quota hold and daily cap read.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the red-team output is only checked for a usable result, never evaluated.
2. **Truncated reads** — an unparseable or truncated result counts as no usable result. Only seat status `ok` is usable.
3. **Shared state files** — the re-arm marker is written once per head through the existing hold ledger, and the drain records `requestedAt` in its existing follow-up state.
4. **Fail closed** — a failing request is caught and logged. The drain moves on to other PRs, but the PR whose run was recorded and unusable stays held: it is never enqueued without a usable red-team result.
5. **Identity scoping** — only trusted lane PRs are re-armed.
6. **State over time** — the request is keyed by head sha, so a new push starts fresh. One re-run per head: a second unusable run on the same head stays held for the operator.
7. **Who wrote it** — the hold marker records that the daemon, not a person, re-armed it.
8. **Quota and cap** — a failure caused by quota, a disabled seat or a skipped budget reservation is not retried; those rows stay under the quota hold and daily cap.
