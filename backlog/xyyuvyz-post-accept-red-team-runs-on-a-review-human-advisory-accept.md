---
kind: story
size: 2
priority: high
status: resolved
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/__tests__/review-job-red-team.test.mjs"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Post-accept red team runs on a review:human advisory accept, once per head

Live gap on PR #4722: the red team ran on head ea117e881 (02:04Z) and found 2 confirmed breaks; the PR was fixed, and at 14:03Z the panel accepted the new head e125ac999 (every juror accept) — but the PR carries review:human, so derivePanelVerdict reduced the run to needs-human (gate-self) and we:scripts/operations/review-job.mjs gated the red team on redTeamRequired(verdict) === accept. No red team ran on the fixed head. The keying is already per head (scorecard row + comment marker by pr+rev); the gate is what missed. Fix: one predicate (redTeamOwedFor) in we:scripts/operations/review-extra-seats.mjs — a recorded accept, or a needs-human whose only cause is the human gate and whose panel reduces to the advisory accept (the same advisoryLabelOutcome the advisory note and advisory:accepted label use) — read by the job, the sequential pass and the speculative finish.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/review-job-red-team.test.mjs` fails before this change (11 of 12 red) and passes after: an advisory accept dispatches the red team for its head; an accept on a new head after an earlier red team dispatches again for the new head; the same head with a clean row resumes without a new model call; a review:human run whose panel did not accept never reaches it.
- [A2] **Live replay** — feeding #4722's real 14:03Z run record (review-pr-e540ca63, head e125ac999) through `runReviewJob` with a dry io: the daemon build dispatches no red team; this change dispatches it for e125ac99929f.

## Non-goals

- [N1] No new setting: the keying was already per head (row + comment marker by `(pr, netBasis.rev)`), so `redTeam.perHead` is not needed. A human `/review` ceremony that records accept outside the review job still does not start a red team; the advisory accept on the same head already ran it.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the predicate reads only the loop's own verdict fields, never PR text.
2. **Truncated reads** — an unpinned or degraded read (`netBasis.rev` null, `read.degraded`) is not owed — the same rule as the advisory label.
3. **Shared state files** — n/a: no new state; the existing scorecard row and comment marker do the dedup.
4. **Fail closed** — a missing payload, pending or blocked referrals, or any non-accept lens returns false (no red team), same as before.
5. **Identity scoping** — keyed by `(pr, head sha)` through the existing row and marker; a new head is a new key.
6. **State over time** — a re-review of an already red-teamed head resumes its row and never re-runs the model.
7. **Who wrote it** — n/a: the comment marker's trusted-author check is unchanged.
