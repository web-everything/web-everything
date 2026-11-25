---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json", "we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs", "we:protocols/plateau/decision-method/v0.1/rules/__tests__/flow-rules.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a guarantee-to-test manifest separating declaration checks from execution guarantees, with a CI gate… (from plateauapp/plateau-app#243 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json:2` — Add a guarantee-to-test manifest separating declaration checks from execution guarantees, with a CI gate requiring named behavioral cases for each guarantee, including omitted defaults; retain these as explicitly planned cases until the runtime exists.
2. `we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs:97` — Make the meta-test require each distinct problem-message code or string emitted by we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs to appear as an expected `error` in some negative vector. Alternatively, run a mutation check in CI. Both are deterministic gates.
3. `we:protocols/plateau/decision-method/v0.1/defs/compensation.schema.json:2` — Add a `default` keyword with a vector that asserts it, or move the claim to the runtime executor's test plan. A lint rule could require that any 'by default' wording in a schema description has a matching `default` keyword.
4. `we:protocols/plateau/decision-method/v0.1/rules/flow-rules.mjs` — Extend the named direct-child-entry test to assert approvalMarks succeeds, and require positive approval-entry vectors to exercise both approval validators.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#243@86b8afaf077a530634655eed11572ae66659cbb6

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
