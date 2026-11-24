---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/tools/validate-protocols.mjs", "we:tests/unit/protocols.test.ts", "we:protocols/plateau/delivery-snapshot/v0.1/schema.json", "we:protocols/tools/__tests__/validate-protocols.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a validator unit test that calls compareTime directly with sub-millisecond, offset and invalid inputs… (from plateauapp/plateau-app#238 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/tools/validate-protocols.mjs:175` — Add a validator unit test that calls `compareTime` directly with sub-millisecond, offset and invalid inputs, and add a vector for each call site.
2. `we:protocols/tools/validate-protocols.mjs:175` — A check:standards rule that fails when a shared comparison helper gains a call site in the validator with no vector whose target exercises that rule path. Failing that, a review checklist item: one vector per call site when replacing `Date.parse` arithmetic.
3. `we:tests/unit/protocols.test.ts:92` — Add a deterministic named test comparing final-stack vector outcomes against pinned reference results, and include it in the final-slice validation command.
4. `we:protocols/plateau/delivery-snapshot/v0.1/schema.json:13` — Add a deterministic timestamp-pattern test covering trailing LF and CRLF for every timestamp schema location.
5. `we:protocols/tools/validate-protocols.mjs:175` — Add named boundary tests for each changed inventory comparison, asserting the specific error or valid verdict, and run them in the protocol test gate.
6. `(no file cited)` — Add a deterministic named parity test with pinned reference outcomes and require it at final-slice validation.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#238@3989dfc9fff6bff67a76a186aa04e5da9f985242

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
