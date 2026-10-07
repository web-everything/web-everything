---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a table-driven test that runs every review-status:* hold label against the review:changes + r… (from web-everything/web-everything#4234 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/review-status-tag.mjs:198` — Add a table-driven test that runs every `review-status:*` hold label against the `review:changes` + `review:human` combination in `describeReviewState`. Tests that pin precedence rules would catch a mis-ordered branch.
2. `we:scripts/conveyor/__tests__/review-status-tag.test.mjs:272` — Add a deterministic regression test combining draft-withdrawn with a status that derives another state, asserting that draft-withdrawn wins.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4234@b0e7700c8f22ce08fdac4fbb0fb9b5a01fc00079

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
