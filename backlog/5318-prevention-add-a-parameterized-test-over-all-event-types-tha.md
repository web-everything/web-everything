---
bornAs: xgagkqs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a parameterized test over all event types that asserts writer-only fields (unlocked) survive… (from web-everything/web-everything#4330 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger.mjs:1307` — Add a parameterized test over all event types that asserts writer-only fields (`unlocked`) survive appendVerdictHome when the lock is unavailable.
2. `we:scripts/lib/verdict-ledger.mjs:1067` — Add a table-driven test that states, for each of the 10 event types, whether a git miss refuses or spills. This forces an explicit decision per type.
3. `we:scripts/lib/verdict-ledger.mjs:1066` — Add a table-driven test over EVENT_TYPE_VALUES that asserts, for each type, whether a git miss refuses (clearing) or spills (holding). Adding a type then forces an explicit clears decision.
4. `we:scripts/lib/verdict-ledger.mjs:1307` — Add a test that forces lock failure and asserts `unlocked:true` survives for every event type. Alternatively, have validateLedgerEvent preserve `unlocked` the way the v1 validator does.
5. `we:scripts/lib/verdict-ledger.mjs:1069` — Add a deterministic parameterized git-failure test covering every event type's clearing semantics, asserting both the return status and whether a home row exists.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4330@34956d02919d3d21dfeffba1089a13175f741d6d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
