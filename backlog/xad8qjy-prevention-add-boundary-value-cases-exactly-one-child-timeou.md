---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/drain-classify-only.mjs", "we:scripts/__tests__/drain-classify-only.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add boundary-value cases (exactly one child timeout left, and an unsafe-integer PR number) to the… (from web-everything/web-everything#7302 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/drain-classify-only.mjs:175` — Add boundary-value cases (exactly one child timeout left, and an unsafe-integer PR number) to the classify-only test file. A mutation-testing gate on changed lines would also have caught this.
2. `we:scripts/drain-classify-only.mjs:112` — Add the two tests named above (clock jump past the deadline mid-PR; 20-digit PR number). Longer term, a coverage-threshold gate on scripts/drain-*.mjs would flag untested new branches deterministically.
3. `we:scripts/__tests__/drain-classify-only.test.mjs:127` — Link existing tests or add deterministic regression tests asserting no merge invocation and verifier rejection of a budget-skipped unknown verdict, and run them in CI.
4. `we:scripts/__tests__/drain-classify-only.test.mjs` — Add a deterministic test asserting that classification invokes no merge operation, and reference that named test alongside the acceptance guarantee.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7302@5f4372fc2b2e76885ab4b95ceb82ac5b7da448a8

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
