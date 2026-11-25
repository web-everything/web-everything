---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tests/unit/protocols.test.ts", "we:protocols/plateau/decision-method/v0.1/defs/state.schema.json"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a deterministic test that walks every shipped definition, neutralises each ref or type constraint und… (from plateauapp/plateau-app#242 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tests/unit/protocols.test.ts:593` — Add a deterministic test that walks every shipped definition, neutralises each $ref or type constraint under properties and items, and requires at least one vector for that file to fail. A cheaper version requires a rejected row whose error path reaches each $ref-bearing property. File it as a backlog card, for example alongside DZ-PROTO-VALIDATOR-HARDEN.
2. `we:protocols/plateau/decision-method/v0.1/defs/state.schema.json:38` — Add a deterministic test requiring each property that references another definition to have a rejected vector through the referring schema.
3. `we:protocols/plateau/decision-method/v0.1/defs/state.schema.json:3` — Add a deterministic mutation-style test that removes each constraint in every definition file and requires some vector to fail.
4. `we:tests/unit/protocols.test.ts` — Require acceptance guarantees to reference test-file paths and named cases, with a deterministic check that those references exist.
5. `we:protocols/plateau/decision-method/v0.1/defs/state.schema.json:69` — Add a checked clause-to-test manifest requiring runtime guarantees to identify a named behavioral test separately from schema validation tests.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#242@9394b37c6f1abc64b795cf4bef4def0801389b42

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
