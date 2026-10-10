---
bornAs: x0ijpls
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-admission.mjs", "we:scripts/lib/resource-policy.mjs", "we:scripts/lib/__tests__/resource-admission.test.mjs", "we:scripts/lib/__tests__/resource-policy.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a unit test that calls shadowAdmission with a missing snapshot and asserts exactly one shadow… (from web-everything/web-everything#4722 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-admission.mjs:96` — Add a unit test that calls shadowAdmission with a missing snapshot and asserts exactly one shadow row. Cheaper still, make admit() take an `audit:false` option that shadowAdmission passes.
2. `we:scripts/lib/resource-policy.mjs:83` — Before slice 2, decide whether a null cpuIdlePct on a heavy kind should be unknown (hold). Pin that in a slice-2 test, and have the sampler skip writing the first snapshot, which has no CPU delta.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4722@e125ac99929f8d0f210d253b0969d1f6017ffd4a

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
