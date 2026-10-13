---
bornAs: xweb502
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "b4676cf68f6edcf092c80d4f878fa7003a340756"
tags: []
---

# Decide needs-a-human before review, and reuse a same-head review as the advisory

Held finding 218 (2026-10-10, operator OK). Live #4763: unattended review accepted 17:11 ET, flipped ready-to-merge, drain parked it gate-self at 17:24 (review:human + awaiting-advisory), mutual exclusivity removed review:accepted, then it waited for a second identical advisory run. Fix: (a) compute humanRequired from the touch-set shape before review and label review:human up front; (b) setting review.reuseAcceptAsAdvisory (cascade, default on): when a PR turns human-required, the latest review on the same head counts as its advisory iff its seated lenses/rounds meet what the shape earned, else re-run; (c) status labels follow (no stale status:ready-to-merge).

## Acceptance

- [A1] **Executable** — `npx vitest run review-pr review-dispatch merge-ai-prs-acceptance-restamp` (the suites for we:scripts/operations/__tests__/review-pr.test.mjs, we:scripts/operations/__tests__/review-dispatch.test.mjs and we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs) fails on the new cases before this lands and passes after.
- [A2] **Must** — on error (shape unscorable, settings unreadable, advisory comment unreadable) the code refuses to reuse and re-runs the advisory; it never reuses on a failed read.
- [A3] **Must** — the shape scoring and the reuse check treat docs, config, data and backlog paths exactly as `buildShapePlan` does today (no path kind is waived); reuse only ever loosens the re-run, never the `review:human` hold.

## Non-goals

- [N1] Does not let a reused review clear `review:human`; the human ceremony is unchanged (`planRecordDecision` INVARIANT 2, we:scripts/operations/review-pr.mjs:1907).
- [N2] Does not change how `earnedShape` is scored (`buildShapePlan`) or add lenses; it only reads the result earlier.

## Edge cases this change must handle

1. **Untrusted text** — the reused advisory is read only from comments passing `trustedAdvisoryComments` (we:scripts/lib/advisory-labels.mjs:126); its text is parsed for head sha, lenses and rounds only and never reaches argv, a shell or a note unfolded (`foldUntrusted`).
2. **Truncated reads** — the comment list comes from `readCompletePrComments` (we:scripts/conveyor/pr-comments-complete.mjs); a truncated page is an error and means "re-run", never "no advisory found" or "advisory found".
3. **Shared state files** — n/a: no new state file; the setting is read-only from we:scripts/review-settings.json, and labels use the existing label writer.
4. **Fail closed** — an unscorable shape (`assertDeclaredShapeHolds` returns `null`), unreadable settings, or an unparseable advisory means: no early `review:human` guess, no reuse, re-run the advisory; the refusal reason is named in the log line.
5. **Identity scoping** — reuse is keyed by repo + PR + full head sha via `advisoryCoversHead` (we:scripts/lib/advisory-labels.mjs:131); a review of any other head, PR or repo never counts.
6. **State over time** — a new head voids the reuse (the advisory no longer covers it); a daemon restart between review and park re-derives from comments and labels, so no in-memory state is needed; the stale `review:awaiting-advisory` and `status:ready-to-merge` labels are removed in the same park step.
7. **Who wrote it** — only trusted-marker-author comments count (see 1); a comment from anyone else with the same text is ignored, and an operator-added `review:human` label is never removed by this change.

## Design

Today the shape is only read inside `review-pr read` (we:scripts/operations/review-pr.mjs:1219, `assertDeclaredShapeHolds`), and `humanRequired` comes off the LABELS (we:scripts/operations/review-pr.mjs:1271), so a PR whose touch-set earns human review is reviewed as agent-reviewable until the drain parks it later (we:scripts/merge-ai-prs.mjs:865-875, `decideReviewGate`).

(a) Up-front: `planReviewDispatch` (we:scripts/operations/review-dispatch.mjs:506) is pure over `{pr, repo}` (no gh, no labels), so it stays untouched. The site is `dispatchReview` (we:scripts/operations/review-dispatch.mjs:551), which already receives `scopePaths` (the net touch-set). Add a pure `decideUpfrontHuman({ netChangedFiles })` there that runs `buildShapePlan` and returns `humanRequired` plus the labels to add; `dispatchReview` calls it through an injected `applyLabels` seam (default: the existing label writer) before spawning the session. When `humanRequired` is true and the PR lacks `review:human`, it adds `review:human` + `review:awaiting-advisory` first, so the review that follows is the advisory run, not an accept that gets undone. No file list (empty `scopePaths`) means no early label (fail closed to today's behaviour).

(b) Reuse: add `reuseAcceptAsAdvisory` (default `true`) to we:scripts/lib/review-settings.mjs (`BUILT_IN_REVIEW_SETTINGS`, `REVIEW_SETTINGS_ENV`, a boolean parser) and to we:scripts/review-settings.json. `parseAdvisories` (we:scripts/lib/advisory-labels.mjs:96) returns only outcome/head, so extend it to also parse the lens list and round count that the review write-up already prints (`renderVerdictWriteUp`, we:scripts/operations/review-pr.mjs); a comment missing them parses as zero lenses/rounds (never reusable). Add a pure `decideAdvisoryReuse({ advisories, headSha, earnedShape, setting })` in we:scripts/lib/advisory-labels.mjs: reuse iff the setting is on, the latest trusted advisory with outcome `accept` covers the head (`advisoryCoversHead`), and its lenses and rounds are at least `earnedShape.earnedLenses` / `earnedShape.rounds`. At the park-to-human site in we:scripts/merge-ai-prs.mjs (the `review:human` park at ~5524, which carries `review:awaiting-advisory`), a reuse verdict skips adding `review:awaiting-advisory`; no new advisory comment is posted, so no advisory is forged and `review:human` still holds (N1).

(c) Labels: `stripReadyOnPark` (we:scripts/merge-ai-prs.mjs:5323, via `decideParkReadyStrip`) already strips `status:ready-to-merge` at all three park sites (:5524, :5644, :5720). The Must here is only a regression test replaying the #4763 order (accepted, ready-to-merge, then a gate-self park) proving the strip and the `review:accepted` removal both happen; if that test is RED, fix `stripReadyOnPark` for the missed case.

## MVP

Musts: (a) up-front `review:human` from shape in `dispatchReview`, (b) the setting, the lens/round parse and `decideAdvisoryReuse`, (c) a #4763-order regression test for the existing strip (code change only if RED), with the A2/A3 refusals. Out of scope: any change to scoring, the human clearance flow, or other advisory providers.

## Test plan

- `dispatchReview` with a gate-self `scopePaths` calls `applyLabels` with `review:human` + `review:awaiting-advisory` before spawning; RED today because `dispatchReview` never labels before review.
- Same for a docs-only touch-set: no label added (asserts no false positive).
- `decideAdvisoryReuse`: same head and lenses/rounds meet the shape → reuse; RED today (function absent).
- Fewer lenses or rounds than earned → re-run, no reuse.
- Different head → re-run.
- Setting `false` → re-run.
- Unreadable settings, truncated comments, unparseable advisory → re-run with a named reason.
- Advisory by an untrusted author → ignored.
- #4763-order regression: after accepted + ready-to-merge, a gate-self park removes `status:ready-to-merge` and `review:accepted` (may already pass; it pins the behaviour, and a failure is fixed in `stripReadyOnPark`).
- `parseAdvisories` returns lenses and rounds from a real write-up; a comment without them yields zero (not reusable).

## Proof plan

Replay the #4763 shape on a throwaway lane PR touching a gate-self path, running the drain's park pass with label writes on (not DRY_RUN) against that PR only: before, the log shows accepted → parked → second advisory wait; after, it shows `review:human` up front, a single advisory run, and (with a matching same-head review) a reuse line and no second run. Capture both logs in the PR body.

## Follow-ups

- Report the reuse decision in the pr-watch status line.
- Extend reuse to advisories posted by other providers once their lens counts are comparable.
