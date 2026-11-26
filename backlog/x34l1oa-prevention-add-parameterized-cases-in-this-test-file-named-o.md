---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add parameterized cases in this test file named 'otherwise eligible E1 stays held for excluded fl… (from web-everything/web-everything#7524 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3029` — Add parameterized cases in this test file named 'otherwise eligible E1 stays held for <excluded flag>', using matching valid heads and asserting the pending hold; gate these cases with mutations removing each exclusion independently.
2. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3041` — Add 'E2 with no live base read stays held' in this test file, supplying matching heads and CONFLICTING while omitting baseRefName, and assert the exact pending hold; gate it with a mutation defaulting missing baseRefName to 'main'.
3. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3030` — Add the both-missing and equal-non-hex rows to the it.each. Longer term, run mutation testing over security-guard predicates in the conveyor so a removed clause that no test catches fails a gate.
4. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3029` — Add a targeted mutation gate requiring removal of the takeover-flag guard to fail a named test whose remaining eligibility conditions all pass.
5. `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs:3023` — Add a parameterized exclusion matrix using otherwise eligible matching-head fixtures, and a deterministic mutation gate requiring each exclusion's removal to fail its named case.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7524@defe2dad3f121458078c59a8d1f8009fa80d9bc8

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
