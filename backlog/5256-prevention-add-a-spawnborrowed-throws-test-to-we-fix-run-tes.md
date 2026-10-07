---
bornAs: xr95qk3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a spawnBorrowed-throws test to we:fix-run.test.mjs asserting the prompt file is removed. More… (from web-everything/web-everything#4221 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1147` — Add a spawnBorrowed-throws test to we:fix-run.test.mjs asserting the prompt file is removed. More generally, a review lens could require a test for each stated cleanup-on-failure guarantee.
2. `we:scripts/operations/fix-run.mjs:216` — Add a deterministic failure-sequence test covering marker-write failure followed by successful push and failed re-arm, then retry; require durable recovery state before pushing or provide an independent recovery mechanism.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4221@99aa238f8be78037873c32197fc9600e47f88d02

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
