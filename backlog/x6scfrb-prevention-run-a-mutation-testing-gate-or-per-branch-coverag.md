---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs", "we:tests/unit/protocols.test.ts", "we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json", "we:protocols/plateau/decision-method/v0.1/rules/__tests__/flow-rules.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Run a mutation-testing gate or per-branch coverage threshold (for example Stryker on rules/*.mjs) in CI.… (from plateauapp/plateau-app#243 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs:60` — Run a mutation-testing gate or per-branch coverage threshold (for example Stryker on `rules/*.mjs`) in CI. Failing that, make the table-completeness test key on distinct error strings: extract the `(PLT-DM-xxx)` messages from the module source and require each to appear in a row's `error`.
2. `we:tests/unit/protocols.test.ts:57` — Add a check that each rule's `out.push(` message literals each appear as `error` in some negativeRules row. A simple script gate in the test (grep the rules source for `(PLT-DM-` literals and assert each is substring-matched by a row) would make the one-vector-per-rule gap fail deterministically.
3. `we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json:2` — Either add `"default": "halt-dependents"` and a vector asserting it, or have the runtime slice carry a named test such as `compensation absent onFailure halts dependents`. A lint that flags 'by default' in schema descriptions without a `default` keyword would catch this class.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#243@a91a0a8b5bfca1722adebc432d2dbbdb8acc6205

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
