---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs", "we:scripts/conveyor/__tests__/delivery-strategy.test.mjs", "we:scripts/lib/protected-path-floor.mjs", "we:scripts/lib/__tests__/protected-path-floor.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a deterministic timestamp boundary test covering unequal fractional instants that Date.parse… (from web-everything/web-everything#7498 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/delivery-strategy.mjs:54` — Add a deterministic timestamp boundary test covering unequal fractional instants that Date.parse maps to the same millisecond, and either preserve that precision or reject unsupported precision.
2. `we:scripts/conveyor/delivery-strategy.mjs:225` — Add a table-driven regression gate that passes missing and malformed settings through both select and decisionFindings, asserting closed selection and returned diagnostics without exceptions.
3. `we:scripts/conveyor/delivery-strategy.mjs:215` — Add deterministic, one-field-at-a-time schema tests for decision identifiers, candidate identifiers, nonnegative integer positions, textual position reasons, and action arrays.
4. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs:1` — Maintain a fourteen-entry finding-to-test manifest naming the repository test file and case, with a deterministic check that every finding maps to an existing test; record mutation results separately.
5. `we:scripts/lib/protected-path-floor.mjs:135` — A check:standards rule or unit test asserting that every STANDALONE_POLICY_FILES entry (a protected settings reader's output) also appears in FLOOR_SETTINGS.
6. `we:scripts/conveyor/delivery-strategy.mjs:29` — Add the parameterized core-schema test to CI and a targeted mutation gate requiring removal of the INPUTS enforcement loop to make that named test fail.
7. `we:scripts/conveyor/delivery-strategy.mjs:222` — Add a parameterized regression test covering absent and null settings across both public validation entry points.
8. `we:scripts/conveyor/delivery-strategy.mjs:212` — Add deterministic schema validation and parameterized wrong-type tests for every decision metadata field.
9. `we:scripts/conveyor/delivery-strategy.mjs:82` — Gate changes with the named two-call regression test, including a valid first selection and an invalid second selection using the same object.
10. `we:scripts/conveyor/__tests__/delivery-strategy.test.mjs:1` — Add a machine-checked finding-to-test manifest containing all fourteen finding IDs, repository-qualified test paths, case names, and assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7498@70a7089156a7e07b4ec3f5a3b2dbeb87012ecb85

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
