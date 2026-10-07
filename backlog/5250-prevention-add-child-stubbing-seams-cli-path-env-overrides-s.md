---
bornAs: xl42qbs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/__tests__/dispatch-plan-output-identity.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add child-stubbing seams (CLI path env overrides) so conveyor-state and dispatch-plan can be run… (from web-everything/web-everything#4194 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/__tests__/dispatch-plan-output-identity.test.mjs:48` — Add child-stubbing seams (CLI path env overrides) so conveyor-state and dispatch-plan can be run in non-fixture mode with fake children. Then assert errors[] order and snapshot-key sharing.
2. `we:scripts/readiness/__tests__/dispatch-plan-output-identity.test.mjs:46` — Add a deterministic integration test with stubbed child reads, varied completion order, and comparison against sequential results, including read failures.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4194@c206d0855d7ae6bcd6a6bb4b0a4a3bef37065791

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
