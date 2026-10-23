---
bornAs: xkmrswh
kind: story
size: 8
parent: "6899"
status: open
blockedBy: ["6896", "6898"]
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/review-stack-base.mjs", "we:scripts/settings/pr-stack.json"]
dateOpened: "2026-10-17"
tags: []
---

# we: stacked PR policy slice 3 - drain ordered landing, restack, delta re-review

Make the drain land a policy-stacked child only after its base, restack the child when the base head moves (stack.onBaseHeadMove), and re-review only the child delta. The hold marker moves only when the delta fingerprint is unchanged and the base's new commits touch none of the child's files. Ruled in 6903.

## Acceptance

- [A1] **Executable** — `node --test` on we:scripts/conveyor/__tests__/pr-stack-policy.test.mjs and we:scripts/__tests__/merge-ai-prs-stack-order.test.mjs fails before and passes after. Named tests, one per guarantee:
  - `drain: a policy-stacked child is held until its base is proven landed, then lands` (through the real `classifyPr` and `planLabelDrain`, never a candidate with a preset `decision`: once the base merges, the existing `retargetStackedPrs` moves the child to the default branch and `classifyPr` returns `merge`. Control: the same child left on the base's `lane/*` branch is skipped with `base is not main (lane/…)`).
  - `drain: the base lands first when both are ready in the same pass`.
  - `restack: a moved base head restacks the child, bottom first, under the round cap`.
  - `restack: gate-feeding settings and mixed docs-plus-guard children stay guard class at the drain entry point even with settings and docs in lowRiskClasses` (include we:scripts/settings/pr-stack.json, an in-review base and a fixing base; assert no policy-stack treatment and the child stays held by the lane-base guard, using slice 1's path classifier).
  - `restack: a restacked head needs review, CI and proof-of-land through the real classifyPr and planLabelDrain before landing` (in we:scripts/__tests__/merge-ai-prs-stack-order.test.mjs, construct state from the restack's actual new head, never a preset decision. Old-head approval and CI cannot authorize it; independently withhold new-head review, green CI and base proof-of-land, asserting no landing for each. With every gate satisfied, assert it becomes ready. Include unchanged-delta marker carry: it alone grants neither review:accepted nor CI or landing proof).
  - `re-review: after a restack only the child delta is re-reviewed, never the base's lines`.
  - `hold marker: re-pointed to the new base head only when the delta fingerprint is unchanged and the base's new commits touch no file of the child delta`.
  - `hold marker: left unmoved and the delta re-reviewed when the base's new commits touch a child file`.
  - `hold marker: left unmoved and the delta re-reviewed when the delta fingerprint changed, even though the base's new commits touch no child file`.
  - `truncated read: a truncated diff leaves the hold marker unmoved and re-reviews the delta`.
  - `truncated read: a truncated file list leaves the hold marker unmoved and re-reviews the delta`.
  - `fail closed: an unknown base head holds the child`.
  - `fail closed: a failed restack holds the child`.
  - `fail closed: a restack that fails partway up the stack holds that child and every child above it`.
  - `fail closed: a restack that hits the round cap holds the child`.
  - `fail closed: a missing gate holds the child`.
  - `review:accepted is applied only at collapse through the net-diff carry (gate not weakened)`.
  - `onBaseHeadMove setting set to a different value changes the behaviour (not a constant)`.
  - `untrusted text: fingerprint and touched files come from git data; PR text naming other files or a fingerprint is ignored`.
  - `shared state: the drain reads its own keys from we:scripts/settings/pr-stack.json and writes no key to we:scripts/settings/stack.json`.
  - `identity: a base and child by different actors get no policy-stack treatment (no restack, no carried marker) and the child stays held by the existing lane-base guard`.
  - `identity: a base or child that is not a trusted lane PR gets no policy-stack treatment and the child stays held by the existing lane-base guard`.
  - `state over time: each base move re-evaluates the cell and fingerprint at that moment, never reusing the values from an earlier move`.
  - `who wrote it: a hold marker echoed inside another automation's comment (e.g. a juror), placed mid-comment, or posted by an untrusted author is ignored; only the hold comment's own exact shape counts`.

## Non-goals

- [N1] Does not handle a closed or rejected base (slice 4) and does not change the proof-of-land gate itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — fingerprints and touched files come from git data, never from PR text.
2. **Truncated reads** — a truncated diff or file list means the marker is not moved and the delta is re-reviewed.
3. **Shared state files** — we:scripts/settings/pr-stack.json keeps its own keys; the stack settings file stays owned by slice 1.
4. **Fail closed** — an unknown base head, a failed restack or a missing gate holds the child.
5. **Identity scoping** — the relation counts only between trusted lane PRs of the same actor, as we:scripts/conveyor/review-stack-base.mjs already requires.
6. **State over time** — every base move re-evaluates the cell and the fingerprint at that moment.
7. **Who wrote it** — only the hold comment's own exact shape from a trusted author moves the hold marker (as `parseStackMarkers` in we:scripts/conveyor/review-stack-base.mjs already requires); a marker echoed in another automation's comment is ignored.
