---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/tools/validate-protocols.mjs", "we:protocols/plateau/decision-method/v0.1/defs/keys.schema.json", "we:protocols/plateau/decision-method/v0.1/defs/guardName.schema.json", "we:tests/unit/protocols.test.ts", "we:protocols/tools/__tests__/validate-protocols.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Make the walk treat the keys of properties and defs as names, and add tests with properties named const,… (from plateauapp/plateau-app#239 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/tools/validate-protocols.mjs:54` — Make the walk treat the keys of `properties` and `$defs` as names, and add tests with properties named const, enum and $id. File under DZ-PROTO-VALIDATOR-HARDEN.
2. `we:protocols/tools/validate-protocols.mjs:44` — Reject `$defs` in walk() when `from !== null`, with a deep-nesting test.
3. `we:protocols/plateau/decision-method/v0.1/defs/keys.schema.json:15` — A validator check that loads every defs/*.schema.json and resolves its references; the PR describes this as planned for B2.
4. `we:protocols/tools/validate-protocols.mjs:39` — Add a test where a defs/ file references a sibling file and a vector depends on the sibling's constraint; the B2 load-every-defs-file check would also exercise it.
5. `we:protocols/tools/validate-protocols.mjs:43` — Add a test where we:defs/x.schema.json is a symlink pointing outside the protocol folder and assert 'symlink escapes protocol'.
6. `we:protocols/tools/validate-protocols.mjs:51` — Add one test with a file reference and a nested $id inside a oneOf array.
7. `we:protocols/tools/validate-protocols.mjs:54` — Add a negative test that puts a nested $id and a `#` ref under properties.enum and $defs.const, and make the walker treat keys of properties/$defs as names rather than keywords (file with DZ-PROTO-VALIDATOR-HARDEN).
8. `we:protocols/tools/validate-protocols.mjs:43` — Add tests with a symlinked defs/*.schema.json pointing outside the protocol and with a definition file that is an array or boolean (file with DZ-PROTO-VALIDATOR-HARDEN).
9. `we:protocols/tools/validate-protocols.mjs:32` — Add these named regression tests to the required validator test gate, including literal-data assertions that fail when const or enum content is discarded.
10. `we:protocols/plateau/decision-method/v0.1/defs/guardName.schema.json:2` — Require a named positive/negative contract-test matrix for newly added definition files and run it independently of whether the root schema references them.
11. `we:protocols/tools/validate-protocols.mjs:44` — Add a parameterized regression test covering $defs at the document root and within schema-bearing keywords, asserting the specific rejection.
12. `we:tests/unit/protocols.test.ts:126` — Add the named cases to the bundler regression suite and require each new resolver guarantee to have an executable case.
13. `we:protocols/plateau/decision-method/v0.1/defs/guardName.schema.json:2` — Add a definition-contract test suite that loads every delivered definition and checks explicit positive and negative cases for each documented constraint.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#239@1fb19a69541ccefcebe293a91fdcdf040a4a3f5a

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
