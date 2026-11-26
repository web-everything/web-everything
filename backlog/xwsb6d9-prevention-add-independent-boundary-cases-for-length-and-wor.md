---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tests/unit/protocols.test.ts", "we:protocols/tools/validate-protocols.mjs", "we:protocols/tools/__tests__/validate-protocols.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add independent boundary cases for length and word count, and a targeted mutation gate requiring the name… (from plateauapp/plateau-app#244 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tests/unit/protocols.test.ts` — Add independent boundary cases for length and word count, and a targeted mutation gate requiring the named test to fail when either predicate is removed.
2. `we:tests/unit/protocols.test.ts:685` — Add a lint rule or check:standards rule that flags exported or top-level helpers in test files with no references. Add a check that README claims naming a test map to a test file symbol.
3. `we:protocols/tools/validate-protocols.mjs:350` — Test each condition of a compound guard with an input that satisfies all the others, or run mutation testing on the validator.
4. `we:tests/unit/protocols.test.ts:686` — Add a deterministic table-driven test for flow-lint default/configured paths, presence, and hermetic mode, asserting whether execution is skipped.
5. `we:tests/unit/protocols.test.ts` — Bind the stated acceptance totals to a named automated test and update its expectations deliberately when the accepted corpus changes.
6. `we:tests/unit/protocols.test.ts` — Add a named test 'rejects a four-word design-only reason shorter than 24 characters' asserting the substantive-reason diagnostic, and require it in the unit gate.
7. `we:tests/unit/protocols.test.ts` — Add a named parameterized test 'requires negative evidence for heading MUST clauses' with otherwise valid trace rows and positive-only vectors, asserting 'MUST has no traced negative vector' for MUST before the identifier, after it, and on the following line.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#244@0fbf26a49abbae31130818de55f1ff2f42cd4d95

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
