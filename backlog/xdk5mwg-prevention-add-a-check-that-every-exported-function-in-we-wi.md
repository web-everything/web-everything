---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/delivery/delivery-validate.test.ts", "we:wip-relay.js", "we:src/delivery/types.ts", "we:./__tests__/wip-relay.test.mjs", "we:src/delivery/__tests__/types.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a check that every exported function in we:wip-relay.js's delivery section is referenced by a named t… (from plateauapp/plateau-app#240 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/delivery/delivery-validate.test.ts:106` — Add a check that every exported function in we:wip-relay.js's delivery section is referenced by a named test, or require a test per stated 'never' guarantee when the PR is prepared.
2. `we:src/delivery/delivery-validate.test.ts:105` — Test review lens: each refusal test must be valid except for the field being refused, and assert the specific reason string.
3. `we:src/delivery/delivery-validate.test.ts:107` — Add a test in this slice or slice 2 that feeds validatePublished a worker with agentId, briefPath and a nested-object `lane`. Assert the output keys equal the allow-list and the nested value is gone. As a durable guard, add a check that every exported function in we:wip-relay.js's delivery section is referenced by at least one test.
4. `we:wip-relay.js:1525` — Project each validated item to its declared contract fields, or add a test asserting that unknown fields on PR and progress items are dropped. File this as a card for slice 2 or 5, before publishing starts.
5. `we:src/delivery/types.ts:35` — Re-export the shared parser and run the named autumn-hour test against that single implementation.
6. `we:wip-relay.js` — Add deterministic redaction tests to the existing test gate, including a valid published-snapshot round trip.
7. `we:src/delivery/delivery-validate.test.ts:50` — Parameterize the named test over all three forbidden keys and both assignment sites.
8. `we:src/delivery/delivery-validate.test.ts:95` — Add deterministic assertions for exact warning retention and counts at and above the cap.
9. `we:src/delivery/delivery-validate.test.ts:95` — Gate validation with a parameterized optional-worker-field test covering invalid, omitted, null, and valid values.
10. `we:wip-relay.js` — Add a table-driven redaction test covering both the direct helper and successful published-snapshot validation, and run it in the test gate.
11. `we:src/delivery/delivery-validate.test.ts` — Parameterize the existing test across all three forbidden keys and both dictionaries, asserting absence and the exact named warning.
12. `we:src/delivery/delivery-validate.test.ts` — Assert the exact retained first 49 warnings and '+12 more warnings', with boundary cases at 50 and 51 warnings in the test gate.
13. `we:src/delivery/delivery-validate.test.ts` — Add parameterized cases for every optional field, including absent, null, valid, and invalid values; assert named drops and preservation of valid workers.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#240@4506e70e7ed59942d5322a421fbbbdea4b897577

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
