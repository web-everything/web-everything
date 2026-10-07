---
bornAs: xs1y8je
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/fix-slot-borrow.test.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add an integration-style test that round-trips acquireFixDispatchClaim({borrowed}) - listFixDispa… (from web-everything/web-everything#4216 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/fix-slot-borrow.test.mjs:131` — Add an integration-style test that round-trips acquireFixDispatchClaim({borrowed}) -> listFixDispatchClaims -> liveBorrowedFixInFlight, so a break in either end reddens; consider a rule that every PR prose guarantee (e.g. 'claim meta records borrowed') names a defending test.
2. `we:skills-src/conveyor/build-dispatch-daemon.mjs:200` — A lint rule (jsdoc/require-jsdoc-adjacent or a check:standards rule) flagging a JSDoc block that is not immediately followed by its declaration.
3. `we:scripts/lib/fix-slot-borrow.mjs` — Add a deterministic sequential-admission test with a mutable live-claim source, asserting that each published borrow consumes exactly one slot; reconcile reservations with published claims.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4216@89f3d9e7cc263b00a158ee25a8a13bf23b35dd08

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
