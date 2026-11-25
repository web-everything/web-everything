---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs", "we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json", "we:tests/unit/protocols.test.ts", "we:protocols/plateau/decision-method/v0.1/rules/__tests__/flow-rules.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a check:standards rule that fails when a file under rules/ is not imported by any test or by the vali… (from plateauapp/plateau-app#243 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs:38` — Add a check:standards rule that fails when a file under rules/ is not imported by any test or by the validator. Alternatively, add a flow-rules vector table that runs when the root schema switches over in the final slice.
2. `we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs:88` — Add a check:standards rule that fails when a rules module exports a rule with no fixture-driven test, for example a good/bad vector table keyed by rule name. File it as a backlog item, to land before the final cutover slice.
3. `we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json:2` — Lint that a description saying 'by default' has a matching `default` keyword or a named runtime test reference. File it as a backlog item.
4. `we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json:2` — Add a machine-checked guarantee-to-test manifest requiring named execution tests and omitted-default cases for these promises.
5. `we:tests/unit/protocols.test.ts` — Gate acceptance manifests on repository-qualified test files, named cases, and assertions for each behavioral guarantee.
6. `we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json:2` — Add a deterministic requirement-to-test coverage gate that requires named runtime vectors for compensation ordering, omitted policy defaults, and failed or unknown undo propagation.
7. `we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs:22` — Require direct named behavioral vectors for each exported flow rule, including each graph edge category, before activating the module.
8. `we:tests/unit/protocols.test.ts` — Require Acceptance entries to reference concrete test names and assertions, checked against the test inventory.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#243@dcad7f8e361512257922f9153951fe373b2d4628

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
