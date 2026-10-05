---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a test that sets the kill file and asserts that no retryTimeout, flushTimeouts or dispatch ca… (from web-everything/web-everything#4023 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:353` — Add a test that sets the kill file and asserts that no retryTimeout, flushTimeouts or dispatch call is made. Alternatively, move the check to function entry.
2. `we:scripts/operations/ci-heal-pr-dispatch.mjs:380` — Add a unit test that injects a throwing `readRows` and asserts dispatch still happens. Raise a health-watch alert when the ledger probe errors, so the failure is visible and not silent.
3. `we:scripts/operations/ci-heal-pr-dispatch.mjs:386` — Either reword the message to 'for WE_FIX_LOOP_WINDOW_HOURS' or make the hold persist until the head changes. Add an expiry test.
4. `we:scripts/operations/ci-heal-pr-dispatch.mjs:381` — Add a deterministic dispatch test injecting a throwing readRows function and asserting successful dispatch without refusals; removing the catch should redden that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4023@bfde2e372fe3561120adab8e8c5f468c27e79820

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
