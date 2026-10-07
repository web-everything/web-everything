---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/conveyor/review-status-tag.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Make planAdvisoryRepairLabels return no plan while review:changes is present. Add a sweep test fo… (from web-everything/web-everything#4177 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-set-label.mjs:535` — Make planAdvisoryRepairLabels return no plan while review:changes is present. Add a sweep test for that case. The cheaper general guard is a rule that any label-set change names the other planners that write the same label, with a cross-planner test.
2. `we:scripts/conveyor/review-status-tag.mjs:247` — Add a deterministic unit test covering reviewState alongside the preserved draft-withdrawn label, including null and live derived statuses.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4177@20ef7b2195620caae2769d7ce14d3331df6cea62

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
