---
bornAs: xyufys9
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-10-06"
preparedAgainstSha: "936580aaf242cea3bea3221d58c9bf83947e35c9"
tags: []
---

# A PR shows one consistent review state: a send-back clears stale advisory labels and the status says what happens next

Live case 2026-10-02: PR #3490 carried review:changes, review:human, review-status:fixing and advisory:accepted at once after the operator sent it back. The fixer was correctly working the send-back, but the labels contradicted each other: advisory:accepted came from the review before the send-back, and review:human reads as waiting on the operator now although it means a human approval is still owed after the fix. Fix: (1) we:scripts/review-set-label.mjs --to=changes removes any advisory:* label (it described an earlier verdict); (2) the status tagger publishes one plain combined state when changes and human are both present (for example "fixing the send-back, then needs operator approval") and Plateau shows that single state instead of raw labels. Replay #3490.

## Design

Premise check (2026-10-06, current `main`): not delivered. `git log -S4967` finds no delivering commit. The `changes` branch of `decideSetLabel` (`we:scripts/review-set-label.mjs:535`) removes only `review:pending`, `review:accepted`, `redteam:accepted` and `ready-to-merge`, so `advisory:accepted`/`advisory:changes` survive a send-back. `STATUS_LABEL_RE` (`we:scripts/conveyor/review-status-tag.mjs:64`) has no combined changes+human state.

1. **Stale advisory strip.** Add `ADVISORY_LABELS.ACCEPTED` and `ADVISORY_LABELS.CHANGES` to the `removeLabels` of the `changes` return (`we:scripts/review-set-label.mjs:535`). `ADVISORY_LABELS` is already imported (`we:scripts/review-set-label.mjs:128`) and `clear-human` already does the same strip (`we:scripts/review-set-label.mjs:307`, #4053). `presentRemoveLabels` (`we:scripts/review-set-label.mjs:550`) narrows to labels the PR carries, so no absent-label error. `review:human` stays (the card's own point: human approval is still owed).
2. **One plain combined state.** Add a pure export `describeReviewState({ labels, status })` (`labels`: strings or `{name}` objects, as `planStatusLabelChange` accepts; `status`: the `{role,state}`-or-null that `deriveReviewStatus` returns) in `we:scripts/conveyor/review-status-tag.mjs`. It returns `{ code, text }`. When `review:changes` and `review:human` are both present: with a live fixer (`status.state` of `fixing`, `fixing-conflict`) it returns text "fixing the send-back, then needs operator approval"; stalled fixer states (`fix-stalled`, `fixing-conflict-stalled`) read "send-back fix stalled, then needs operator approval"; with no fixer, "send-back waiting for a fix, then needs operator approval". Any other live state (`reviewing`, `review-stalled`, `healing-ci`) alongside changes+human is shown as the combined text with no fixer claim ("send-back waiting for a fix, then needs operator approval"). Otherwise it falls back to the single existing state (the status label text, or the lone review label). It is derived, not a new `review-status:*` label, so `STATUS_LABEL_RE`, `planStatusLabelChange` and every other label consumer stay unchanged.
`tagReviewStatus` is the consumer: its return value gains a `reviewState` field (`describeReviewState` of the PR labels and derived status), so the tagger publishes the single state for Plateau to read.
3. **Replay #3490** through both pure functions (see Proof plan).

## MVP

Musts:
- `--to=changes` removes any `advisory:*` label present, and keeps `review:human`.
- `describeReviewState` exported, pure, with the combined text above and a safe fallback.
- `tagReviewStatus` returns it as `reviewState` (the published single state).

Out of scope (Follow-ups): the Plateau UI rendering of the combined state (other repo, not in this card's scope), a new `review-status:*` label, removing advisory labels on other targets.

## Test plan

In `we:scripts/__tests__/review-set-label.test.mjs`:
- `changes` (with a non-empty `reason`, else the reasonless-bounce refusal fires first) on `[review:human, review:pending, advisory:accepted]` has `removeLabels` containing `advisory:accepted` and not `review:human`. RED before: removal list lacks the advisory label.
- Same with `advisory:changes`. RED before, same reason.
- `changes` with no advisory label still allowed and unchanged otherwise (regression guard).

In `we:scripts/conveyor/__tests__/review-status-tag.test.mjs`:
- changes+human with status `fixing` returns the "fixing the send-back, then needs operator approval" text. RED before: export does not exist.
- changes+human with a stalled status and with no status return their own texts.
- human only and changes only fall back to the single existing state (no false combination).

## Proof plan

Replay #3490's label set (`review:changes`, `review:human`, `review-status:fixing`, `advisory:accepted`) through `decideSetLabel({to:'changes'})` and `describeReviewState` in a CLI probe (`node -e` import of both from the lane). Show before (on `origin/main`: advisory not in `removeLabels`, no combined export) and after (advisory removed, one combined line). Record both outputs in the PR body.

## Follow-ups

- File as a backlog item: Plateau: show the single combined state instead of raw labels (plateau-app repo).
- Decide whether other review-label targets (`rearm`) should also strip stale advisories.

## Done when

1. **Executable** — `npx vitest run review-set-label review-status-tag` fails before this item lands and passes after.
