---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-ready-record.mjs", "we:scripts/operations/__tests__/fix-ready-record.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a parameterized regression test covering null, primitive and array entries alongside a valid… (from web-everything/web-everything#7244 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-ready-record.mjs:268` — Add a parameterized regression test covering null, primitive and array entries alongside a valid waiver, and include it in the existing test gate.
2. `we:scripts/operations/__tests__/fix-ready-record.test.mjs` — Require an expected diagnostic in the refusal helper and assert the captured error in each named refusal case through the existing test gate.
3. `we:scripts/operations/fix-ready-record.mjs:291` — Add a deterministic parameterized test distinguishing absent layers from null and other non-array values, asserting refusal and no output record.
4. `we:scripts/operations/fix-ready-record.mjs:269` — Add parameterized malformed-identity tests requiring refusal and no record when a same-ref entry lacks mandatory identity fields.
5. `we:scripts/operations/__tests__/fix-ready-record.test.mjs` — Require an expected reason in the refusal helper and assert the captured console error in each named refusal test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7244@74b11fc6d350167ef5a901eff16153d3dea6d2a5

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
