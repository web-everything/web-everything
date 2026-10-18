---
bornAs: xogmcq9
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job-red-team.test.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: drain requests a red-team re-run when a run left no usable result (wire requestRedTeam)

The drain's requestRedTeam hook in we:scripts/lib/drain-merge-strategy.mjs (around lines 211 and 346) defaults to null and no caller passes it, so a red-team run that left no usable result is never re-requested. Live case: PR #5485, red team unparseable at 21:22Z; the review daemon's already-reviewed hold means nothing re-runs it. Wire requestRedTeam so a missing result gets one red-team-only re-run. (Releasing the review daemon's hold would not help: an accepted PR is never owed a review, so nothing would be dispatched.)

Wiring the hook alone is not enough. Today a run that failed still counts as `recorded`:

- `completeRedTeam` (we:scripts/operations/review-extra-seats.mjs) writes the seat row of a failed run and still returns status `ran`.
- we:scripts/operations/review-job.mjs stores that `ran` as the status file's `result`.
- `readDrainRedTeamEvidence` (we:scripts/lib/drain-red-team-evidence.mjs) sets `recorded` from any matching seat row, and from `result === 'ran'`, without checking that the run succeeded.
- The drain returns before `requestRedTeam` whenever `recorded` is true.

So an unparseable run never reaches the hook. This card makes the evidence say whether a recorded run left a usable result, and keys the re-run on that.

**What the hook does.** we:scripts/lib/drain-red-team-evidence.mjs exports `requestRedTeamRerun({ repo, pr, head, loopPayload })`. It writes one head-keyed request file next to the red-team status files, atomically, and returns `{ requested: false }` if a request for that head already exists. Otherwise it starts one detached red-team-only job and returns `{ requested: true }`. It is synchronous and makes no network call: the job is spawned detached and unref'd, the way `defaultSpawnJob` in we:scripts/operations/review-job.mjs already starts review jobs, so the hook is safe inside the drain's land-write lock. Both `createDrainMergeStrategy` callers in we:scripts/merge-ai-prs.mjs pass it.

**What the job does.** A new red-team-only mode of we:scripts/operations/review-job.mjs takes the PR, repo and head. It refuses if the PR head has moved. Otherwise it runs `runRedTeam` (we:scripts/operations/review-extra-seats.mjs) on the review run already recorded for that head, in a review-loop lane, and records the outcome with `recordRedTeamStatus`, including the seat status. It runs no new panel and changes no review label. The review daemon is not involved, so neither the same-head hold (an accepted PR is never owed a review) nor the auto-fix retry count (`countRearmComments` in we:scripts/conveyor/rearm-review.mjs) is touched.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/drain-merge-strategy.test.mjs, we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs, and we:scripts/operations/__tests__/review-job-red-team.test.mjs. Named tests, one per guarantee:
  - `evidence reports usable only for a red-team seat row with status ok on this head`
  - `a recorded seat row with status unparseable, error or timeout counts as no usable result`
  - `the status file carries the seat status, so a failed run marked ran is not usable`
  - `a status file written before this change (result ran, no seat status) is usable only if a seat row with status ok exists`
  - `an unreadable scorecard store is reported as unreadable, not as no usable result, and nothing is requested`
  - `the drain passes requestRedTeam so a run with no usable result requests a re-run`
  - `a recorded but unusable run reaches requestRedTeam, which the recorded early return used to block`
  - `a quota-exhausted seat row is not re-requested, and neither is a run whose status-file result is disabled, not-owed, skipped or error with no seat row`
  - `requestRedTeamRerun writes one request file and starts one detached red-team-only job, without waiting on it`
  - `the red-team-only job runs runRedTeam on the recorded review run for that head and records the seat status`
  - `the red-team-only job refuses when the PR head has moved, and runs no panel and changes no label`
  - `a re-run request posts no re-arm comment and does not count toward the auto-fix retry cap`
  - `a head with a usable red-team result is not re-requested`
  - `the request is made once per head, not every tick`
  - `a re-run that is unusable again is not re-requested on the same head and stays held`
  - `a recorded but unusable run is held, not enqueued, when no request succeeds (never waived by enqueueWhenRedTeamNeverScheduled)`
  - `a failing requestRedTeam call is caught and the drain continues with other PRs`
- [A2] Live case: PR #5485 (red team unparseable at 21:22Z) gets a re-run with before/after evidence. First confirm the PR is still on the head that run judged; if it moved, use the newest PR with an unparseable red-team row on its current head.

## Non-goals

- [N1] Does not change how the red team judges, only when a missing result is re-requested.
- [N2] Does not change which seat statuses the quota hold and daily cap read.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the red-team output is only checked for a usable result, never evaluated.
2. **Truncated reads** — an unparseable or truncated result counts as no usable result. Only seat status `ok` is usable. An unreadable scorecard store is its own state: the PR stays held and nothing is requested. The evidence reader reads the store strictly, not through `readStore` (we:scripts/conveyor/run-scorecard-store.mjs), which returns an empty list on any error.
3. **Shared state files** — one request file per head, written atomically; an existing file means "already requested". The drain also keeps `requestedAt` in its existing follow-up state.
4. **Fail closed** — a failing request is caught and logged. The drain moves on to other PRs, but the PR whose run was recorded and unusable stays held: it is never enqueued without a usable red-team result.
5. **Identity scoping** — only trusted lane PRs are re-requested.
6. **State over time** — the request is keyed by head sha, so a new push starts fresh. One re-run per head: a second unusable run on the same head stays held for the operator. A status file from before this change counts as usable only with an `ok` seat row.
7. **Who wrote it** — the request file records that the drain, not a person, asked for the re-run.
8. **Quota and cap** — a failure caused by quota (a `quota-exhausted` seat row), a disabled red team, a not-owed pass, a skipped budget reservation or a top-level error before any seat call (status-file results with no seat row) is not retried; those stay under the quota hold and daily cap.
9. **Normalization** — the head sha is compared lowercased in the evidence reader and the request file, the same way the drain's queue safety compares it.
