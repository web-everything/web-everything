---
bornAs: xzrrib4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/coroner-executors.mjs", "we:scripts/operations/__tests__/coroner-extract.test.mjs", "we:scripts/operations/__tests__/coroner-executors.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a review-lens check that every env-var switch named in a we:SKILL.md or comment has a test th… (from web-everything/web-everything#4202 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-extract.mjs:715` — Add a review-lens check that every env-var switch named in a we:SKILL.md or comment has a test that sets it.
2. `we:scripts/operations/coroner-executors.mjs:131` — Add a deterministic test with more than maxFiles out-of-window rollouts in eligible folders and assert that at most maxFiles rollout files are read; maintain a separate read-budget counter.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4202@35d8efc1274e90c672d7d342e05c87a12274c228

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
