---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/__tests__/coroner-extract.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Export the page and job-call bounds as constants and add a test that asserts the default call cou… (from web-everything/web-everything#4164 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-extract.mjs:6` — Export the page and job-call bounds as constants and add a test that asserts the default call count, so the documented number is checked. Optionally add a doc-drift lint that cross-checks numeric bounds in we:SKILL.md against exported constants.
2. `we:scripts/operations/coroner-extract.mjs:560` — Add a test with a counting gh stub that asserts the total gh calls from collectInputs stay under one shared budget. Better, give collectInputs a single call budget that every fetcher draws from.
3. `we:scripts/operations/coroner-extract.mjs:253` — Map check names to a fixed allowlist, with everything else becoming `other`. Cap the length of any external string that reaches the report. Build `causes` with Object.create(null) or a Map. Add a test that feeds a hostile job name through ciCheckName.
4. `we:scripts/operations/coroner-extract.mjs:664` — Add a deterministic fixture test with a current log at the cap and relevant events in .1, asserting that both files contribute to the counts.
5. `we:scripts/operations/coroner-extract.mjs` — Add a deterministic fixture containing old and current prepare attempts repeated across ticks; assert timestamp preservation, window exclusion, and deduplication.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4164@0fbada8fe9737cf1dadd2ac954f2e6cb8dd635af

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
