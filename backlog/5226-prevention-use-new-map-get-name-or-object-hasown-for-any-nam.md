---
bornAs: x8lmt8w
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Use new Map([...]).get(name) or Object.hasOwn for any name-keyed dispatch table. Add a unit case… (from web-everything/web-everything#4158 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-pass.mjs:1484` — Use `new Map([...]).get(name)` or `Object.hasOwn` for any name-keyed dispatch table. Add a unit case with a check named `constructor` to isDerivedTimeoutCheck's test. A lint rule against computed lookups on object literals keyed by external strings would cover the whole class.
2. `we:scripts/conveyor/reconcile-pass.mjs:1486` — Use an own-property lookup or Map, and add a deterministic regression test covering constructor, toString, and __proto__ check names.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4158@5bd25985f0931ecd6a65257ccac05e1353f396e6

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
