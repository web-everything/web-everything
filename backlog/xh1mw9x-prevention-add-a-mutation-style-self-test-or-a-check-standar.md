---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/tools/validate-protocols.mjs", "we:protocols/plateau/watch-inventory/v0.1/vectors/vectors.json", "we:protocols/plateau/decision-method/v0.1/rules.mjs", "we:protocols/plateau/decision-method/v0.1/spec.md", "we:protocols/plateau/watch-inventory/v0.1/spec.md", "we:protocols/plateau/delivery-snapshot/v0.1/spec.md", "we:protocols/README.md", "we:protocols/tools/__tests__/validate-protocols.test.mjs", "we:protocols/plateau/decision-method/v0.1/__tests__/rules.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a mutation-style self-test, or a check:standards rule, that requires each fail-closed branch in the r… (from plateauapp/plateau-app#236 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/tools/validate-protocols.mjs:1` — Add a mutation-style self-test, or a check:standards rule, that requires each fail-closed branch in the runner to be exercised by at least one tamper test. Another option is a README-claim-to-test table in the PR template.
2. `we:protocols/plateau/watch-inventory/v0.1/vectors/vectors.json:1` — Extend Link B so a clause with several MUST sentences or conjuncts must list a vector for each. Alternatively, split compound clauses into one MUST per clause so the one-negative-per-clause rule bites.
3. `we:protocols/tools/validate-protocols.mjs:299` — Add a unit test that spawns the CLI against a stub validator script (exit 3, hang, non-executable) and asserts exit 1. A coverage rule requiring each README 'rejects/fails' sentence to name a test would catch the class.
4. `we:protocols/tools/validate-protocols.mjs:18` — Add a unit test that copies the tree, sets a vector fixture to `we:../../escape.json`, and asserts exit 1.
5. `we:protocols/plateau/decision-method/v0.1/rules.mjs:18` — Express the rule structurally: every transition out of a decider confirm state that can reach `record` must be guarded by `approval-valid`, regardless of event name. Add a negative vector with renamed outcomes (the DZ-PROTO-V0B rule-gap card is a suitable home).
6. `we:protocols/tools/validate-protocols.mjs:105` — Add the named boundary tests to we:tests/unit/protocols.test.ts and run them as a deterministic CI gate.
7. `we:protocols/plateau/decision-method/v0.1/spec.md:18` — Gate each independent requirement with a distinguishing negative vector and an error assertion specific to that requirement.
8. `we:protocols/plateau/watch-inventory/v0.1/spec.md:10` — Add a table-driven vector matrix for schedule mode, base-time availability, expiry, overdue status, and empty criteria to the existing validation gate.
9. `we:protocols/plateau/delivery-snapshot/v0.1/spec.md:8` — Require populated positive fixtures and distinguishing negative vectors for each promised collection-item contract in the CI validation gate.
10. `we:protocols/plateau/watch-inventory/v0.1/vectors/vectors.json:661` — Add parameterized schedule-boundary tests and a mutation gate covering each derivation and suppression branch.
11. `we:protocols/README.md:40` — Gate the validator with malformed-schema and thrown-rule fixtures whose subprocess executions must exit 1.
12. `we:protocols/tools/validate-protocols.mjs:303` — Add subprocess integration tests that exercise present-validator failure and explicit skipping through the actual CLI.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#236@a75adc6e3e9d2fe83de5b00a67f4320cafa3c073

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
