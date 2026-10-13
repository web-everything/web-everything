---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/accept-carry-forward.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Wire the human-review advisory into the native review mirror (COMMENT)

Follow-up to card xk8ab41. The advise step's sink in we:scripts/operations/review-pr-io.mjs (createReviewPrSinks, held by open PR #5025 when xk8ab41 landed) posts the independent advisory on a review:human PR as a bare comment plus an advisory:* label. Add the one-line call mirrorNativeReview({ repo, pr, verdict: 'advisory', labels, headSha }) from we:scripts/lib/native-github-review.mjs there, so the advisory also posts as a native GitHub COMMENT review (never APPROVE; the operator approves a human-review PR). Before wiring, make we:scripts/lib/accept-carry-forward.mjs#laterReviewHold ignore a COMMENTED review by the configured reviewer bot login, because its first clause counts any COMMENTED review submitted after the accept as an objection, and the mirror must change no gates.

## Acceptance

- [A1] **Executable** — a test in the review-pr-io suite fails before and passes after: an advise sink run calls `mirrorNativeReview` with `verdict: 'advisory'` and the reviewed head, and the planned event is COMMENT, never APPROVE.
- [A2] A `laterReviewHold` test: a COMMENTED review by the reviewer bot after the accept is not an objection; one by any other login still is.

## Non-goals

- [N1] No gate or ruleset change (mirror mode only).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the adapter body is fixed text; the advisory text is not copied into the native review.
2. **Truncated reads** — n/a: the adapter already reads reviews with pagination and fails closed.
3. **Shared state files** — n/a: no new shared state.
4. **Fail closed** — the adapter already posts nothing on any read miss or identity mismatch.
5. **Identity scoping** — the laterReviewHold exception covers only the configured reviewer bot login, never the operator or any other reviewer.
6. **State over time** — pinned to the advised head via `commit_id`.
7. **Who wrote it** — n/a: the reviewer App authors the native review, as in xk8ab41.
