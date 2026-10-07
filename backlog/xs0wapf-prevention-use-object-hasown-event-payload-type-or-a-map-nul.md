---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Use Object.hasOwn(EVENT_PAYLOAD, type) (or a Map / null-prototype object) for data-keyed lookups,… (from web-everything/web-everything#4277 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verdict-ledger.mjs:636` — Use Object.hasOwn(EVENT_PAYLOAD, type) (or a Map / null-prototype object) for data-keyed lookups, and add a prototype-key case such as 'constructor' or '__proto__' to the never-throws test. A lint rule against indexing literal objects with untrusted keys would be the deterministic gate.
2. `we:scripts/lib/verdict-ledger.mjs:681` — Build EVENT_PAYLOAD as a Map or null-prototype object, or guard with Object.hasOwn. Add a lint/check:standards rule against indexing a literal lookup table with untrusted input, plus a test table of `constructor`/`__proto__`/`toString` types in validateLedgerEvent and parseLedgerEvents.
3. `we:scripts/lib/verdict-ledger.mjs` — Use an own-property check or a prototype-free registry in both lookup paths, and add a deterministic parameterized test asserting that inherited property names are rejected and parsing continues to the next valid event.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4277@6db03a4284b27919979a0230ecde5b10b52f10b4

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
