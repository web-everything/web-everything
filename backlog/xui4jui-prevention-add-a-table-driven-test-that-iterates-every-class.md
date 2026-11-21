---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-stall-classify.mjs", "we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a table-driven test that iterates every CLASSIFY_VALID leaf with boundary values (0, max, max… (from web-everything/web-everything#7230 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-stall-classify.mjs:52` — Add a table-driven test that iterates every CLASSIFY_VALID leaf with boundary values (0, max, max+1, non-integer), so a new setting gets bounds coverage when it is added to CLASSIFY_DEFAULTS.
2. `we:scripts/conveyor/__tests__/pr-stall-classify.test.mjs:700` — For every new condition that narrows a fail-open path, require a paired negative test. A review-lens checklist item works; a mutation-testing gate on classifier files would catch it deterministically.
3. `we:scripts/conveyor/pr-stall-classify.mjs:52` — Require each new CLASSIFY_VALID leaf to have a table test with at least one refused value above the bound. A check:standards rule that every CLASSIFY_VALID key appears in a test would enforce it.
4. `we:scripts/conveyor/pr-stall-classify.mjs:318` — Use a table-driven boundary test (exact bound, bound+1, negative, NaN, Infinity) for every new age comparison.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7230@1a4a235880d029f9aae3a48a445807fdac320917

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
