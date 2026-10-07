---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a deterministic integration test that omits ciHealReserve, controls the default claim-store a… (from web-everything/web-everything#4256 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/ci-heal-pr-dispatch.mjs:301` — Add a deterministic integration test that omits ciHealReserve, controls the default claim-store and host-load dependencies, and asserts dispatch at a full fixer cap; changing the default initializer to null must make that test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4256@4720d4304f0296f083214941efa0e8863cc52cfd

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
