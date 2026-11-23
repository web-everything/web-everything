---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/delivery-tier.mjs", "we:scripts/lib/__tests__/delivery-tier.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a deterministic test assertion that every test file importing we:scripts/lib/delivery-tier.mj… (from web-everything/web-everything#7397 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/delivery-tier.mjs:43` — Add a deterministic test assertion that every test file importing we:scripts/lib/delivery-tier.mjs or we:protected-path-floor.mjs classifies HIGH. Or add `**/delivery-tier*.test.mjs` to HIGH_MUST_STAY. Carry it with the S2/S10 classifier-tightening card.
2. `we:scripts/lib/delivery-tier.mjs:58` — Add a deterministic test that every `*.test.mjs` file whose basename matches a floor or TRUST_CHAIN module classifies HIGH. Alternatively, derive the tests of protected modules into HIGH_MUST_STAY. Add `we:CLAUDE.md`, `we:AGENTS.md` and `**/CLAUDE.md` to the must-stay list.
3. `we:scripts/lib/__tests__/delivery-tier.test.mjs:78` — Pin an explicit snapshot or minimum set of must-stay globs or paths in the test (a literal array). Fail if any entry is missing from HIGH_MUST_STAY. A check:standards-style rule could flag tests that derive their cases from the artifact they guard.
4. `we:scripts/lib/__tests__/delivery-tier.test.mjs:39` — Add the named LOW-plus-MEDIUM aggregation test and a targeted mutation gate requiring replacement of the MEDIUM aggregate result with LOW to fail it.
5. `we:scripts/lib/delivery-tier.mjs:73` — Extend the invalid-settings parameterized test with sparse extraHigh arrays, asserting HIGH without throwing, and run it in the unit-test gate.
6. `we:scripts/lib/__tests__/delivery-tier.test.mjs:38` — Add a table-driven aggregation test covering LOW-only, LOW/MEDIUM, and LOW/MEDIUM/HIGH inputs with explicit built-in settings, enforced by the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7397@7a3fe798cc635ff04156693a7c9d9cb1ecabcad0

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
