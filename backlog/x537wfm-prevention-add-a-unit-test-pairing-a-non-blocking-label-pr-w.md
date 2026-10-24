---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-stall-detector.mjs", "we:scripts/conveyor/__tests__/pr-stall-detector.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a unit test pairing a non-blocking-label PR with an invalid head. Longer term, a check that e… (from web-everything/web-everything#5856 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-stall-detector.mjs:62` — Add a unit test pairing a non-blocking-label PR with an invalid head. Longer term, a check that every guard branch in `identity()` has a paired accept/reject test.
2. `we:scripts/conveyor/__tests__/pr-stall-detector.test.mjs:60` — Add a table-driven test that iterates Object.keys(DETECTOR_DEFAULTS) and asserts each leaf has an invalid-value fallback case. A lint or standards check could also require every validator key to appear in a test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5856@27fe2455019eb09ded71a5292368040b06373416

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
