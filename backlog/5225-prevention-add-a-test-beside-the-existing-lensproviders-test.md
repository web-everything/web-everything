---
bornAs: xdfduos
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a test beside the existing lensProviders test at we:review-pr.test.mjs:4191 for the held labe… (from web-everything/web-everything#4157 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr.mjs:2590` — Add a test beside the existing lensProviders test at we:review-pr.test.mjs:4191 for the held label. Longer term, a lint or review lens that flags a new exported predicate with a call site that has no test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4157@051cfd830c18ccb0d81655aa9c68387a2bcf646f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
