---
bornAs: xv6uz1q
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:wip-relay.js", "we:src/wip/sessions-feed.test.ts", "we:./__tests__/wip-relay.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a test that builds MAX_SESSION_ROWS rows at maximum field lengths and asserts the encoded delta is no… (from plateauapp/plateau-app#215 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:wip-relay.js:170` — Add a test that builds MAX_SESSION_ROWS rows at maximum field lengths and asserts the encoded delta is no larger than MAX_DELTA_BYTES. Alternatively, have filterSessions also trim by encoded size and name the loss in 'input-trimmed'.
2. `we:wip-relay.js:186` — Add `//Users/..`-style and UNC cases to the path-guard test table, or normalise runs of slashes before testing. A property-style test that prefixes known-bad paths with `/`, `.` and `-` would catch the whole class.
3. `we:src/wip/sessions-feed.test.ts:200` — Add a deterministic feed test that reads an initial verdict, an unchanged verdict, and a verdict with a changed session state, asserting identity reuse only for the unchanged read and the updated state in the final result.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#215@dcc26f1540ed5cd7debd20705dd11c18c1cc7165

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
