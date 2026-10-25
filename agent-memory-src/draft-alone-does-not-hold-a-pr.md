---
name: draft-alone-does-not-hold-a-pr
description: "Draft and review labels are not durable PR holds: CI repair can remove draft-withdrawn and review:changes triggers repair. Close the PR while retaining its branch when withdrawing it from the drain."
metadata:
  type: feedback
---

Marking a PR as draft is not enough to keep it from merging.

**Why:** Draft-promotion promotes green `lane/*` drafts. On 2026-10-24 #5853 merged and #5839 and #5849 were un-drafted despite being held as drafts.

**How to apply:** To withdraw a PR from the drain, close it while retaining its branch for later work; verify that its state is CLOSED. Draft and review labels are not durable holds. CI repair can remove `review-status:draft-withdrawn`: red CI still dispatches repair, ordinary `fix-begin` replaces the withdrawal label with `review-status:fixing`, and `fix-end` removes fixing without restoring withdrawal. Once CI is green, draft-promotion can make the PR ready again. Likewise, `review:changes` requests automated repair rather than an indefinite pause. Related: [[drain-is-a-resident-daemon]].
