---
bornAs: xaabq35
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/state.mjs", "we:scripts/operations/start-build-jobs.mjs", "we:scripts/__tests__/state.test.mjs", "we:scripts/operations/__tests__/start-build-jobs.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a renderCard test with a stub buildJob and one we:scripts/state.mjs card test that sets WE_ST… (from web-everything/web-everything#4227 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/state.mjs:38` — Add a `renderCard` test with a stub `buildJob` and one `we:scripts/state.mjs` card test that sets WE_START_BUILD_JOBS_DIR with a job record. Longer term, a standards rule that every changed exported function in scripts/ is referenced by a test file.
2. `we:scripts/operations/start-build-jobs.mjs:88` — Have the wrapper write its verdict to a separate structured outcome file, or into the job record, that agent stdout cannot reach, instead of parsing the shared log. Failing that, add a test that feeds a forged full verdict line.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4227@8682367df81a95d2b906cc44f752c532f9b5dd02

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
