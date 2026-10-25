---
name: draft-alone-does-not-hold-a-pr
description: "A draft alone does not hold a PR off the drain because draft-promotion promotes green lane/* drafts; hold with draft plus review-status:draft-withdrawn, or review:changes via review-set-label."
metadata:
  type: feedback
---

Marking a PR as draft is not enough to keep it from merging.

**Why:** Draft-promotion promotes green `lane/*` drafts. On 2026-10-24 #5853 merged and #5839 and #5849 were un-drafted despite being held as drafts.

**How to apply:** To hold a PR, set it to draft AND add `review-status:draft-withdrawn`, or set `review:changes` through `review-set-label`. Check the labels afterwards. Related: [[drain-is-a-resident-daemon]].
