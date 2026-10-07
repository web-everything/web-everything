---
bornAs: xxrweoe
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/__tests__/dispatch-retry-backoff.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a tick-level integration test for the full prepare lifecycle (fail, hold, backoff release, re… (from web-everything/web-everything#4162 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:299` — Add a tick-level integration test for the full prepare lifecycle (fail, hold, backoff release, retry succeeds) that asserts the ledger ends completed. A review lens on 'new state transition: what clears it' would also help.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:302` — Wrap the release per card in the shared helper (or let `releaseOwnPrepareHolds` catch per card, as rearm does), plus a fault-injection test. A lens question 'what if the second step of a two-step state change throws' would also catch it.
3. `we:scripts/conveyor/__tests__/dispatch-retry-backoff.test.mjs:116` — Add a convention or lens that every new live-only side effect in the tick ships with a `live:false` test asserting the effect is not called.
4. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1097` — Add a test with an injected exec stub for cliDispatch and cliDispatchDetached that asserts no token-shaped substring survives in the returned reason. A lint rule that flags `.slice(` applied before `redactSpawnText(` in scripts/ and skills-src/ would catch the whole class.
5. `we:scripts/conveyor/__tests__/dispatch-retry-backoff.test.mjs:190` — Anchor this named test after NOT_CONFIRMED_FIX_LANDED_AT, assert the stored timestamp exceeds that cutoff, and verify that removing the exhausted exemption makes it fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4162@8f5abac7dac9bb081d2d659b3ab7db488bba67fc

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
