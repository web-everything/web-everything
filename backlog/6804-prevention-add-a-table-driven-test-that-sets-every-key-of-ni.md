---
bornAs: xsd19oz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a table-driven test that sets every key of NIGHTLY_DEFAULTS to a nondefault value, runs tick… (from web-everything/web-everything#5487 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs:225` — Add a table-driven test that sets every key of `NIGHTLY_DEFAULTS` to a nondefault value, runs `tick` and `runNightlyCoronerJob`, and asserts the observable effect of each. Also add a standards check that every `NIGHTLY_DEFAULTS` key appears in a test with a nondefault literal.
2. `we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs` — A standards check that, for each key in NIGHTLY_DEFAULTS, requires a test referencing the key with a value different from the default; failing that, a review-lens note.
3. `we:scripts/conveyor/__tests__/nightly-coroner-job.test.mjs` — Add a parameterized configuration-contract test covering default and valid nondefault attempt limits, and run it as a deterministic CI gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5487@1cbf326956bd56f0480ff93918b949b545fff4c8

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
