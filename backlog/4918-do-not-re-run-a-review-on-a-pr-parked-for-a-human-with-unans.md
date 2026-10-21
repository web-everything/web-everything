---
bornAs: xux0rs9
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Do not re-run a review on a PR parked for a human with unanswered mandatory referrals

Live 2026-10-02/03: PRs #3481 and #3507 sat review:human with mandatory referrals whose single automated ruling attempt was spent; the review daemon re-dispatched a full review every 4-7 minutes, each parking again with no advisory, spending about 0.70 USD of judge calls per run and a large share of the bot GraphQL budget (hundreds of comments re-read page by page). Fix: when the head is unchanged and the only blocker is pending referrals already attempted on that head, the review daemon must not dispatch again until something changes (new head, a ruling, an operator answer, or a send-back); surface it once as needs-ruling instead. Files: we:scripts/operations/review-dispatch.mjs, we:scripts/operations/review-pr-io.mjs.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
