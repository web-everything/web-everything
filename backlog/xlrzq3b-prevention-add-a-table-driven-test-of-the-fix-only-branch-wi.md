---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/worker-result.mjs", "we:scripts/operations/__tests__/worker-result.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a table-driven test of the fix-only branch with scope empty, using real-world option label sh… (from web-everything/web-everything#4436 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/worker-result.mjs:214` — Add a table-driven test of the fix-only branch with scope empty, using real-world option label shapes ('A fix X', '(a) Fix X', 'Option A - fix X', '1. fix X'). Optionally strip a leading label token before matching.
2. `we:scripts/operations/worker-result.mjs:119` — Add a generic reader pass that walks the schema and caps every string leaf and array length by default, plus a test that every string leaf in a maximal fixture is rejected when oversized.
3. `we:scripts/operations/worker-result.mjs:297` — Sanitize first, then take the tail (`sanitizeDeniedCommand(prose)` over a bounded scan, then slice). Add a boundary-straddling-secret case to the unparseableOutcome test.
4. `we:scripts/operations/worker-result.mjs:311` — Run the whole assembled evidence text through one sanitizer at the S2 single write point, with a test that feeds a hostile key name and expects one line and no comment delimiters.
5. `we:scripts/operations/worker-result.mjs` — Add a deterministic parameterized test for the option-only trigger with no code scope, including the replay fixture's unpunctuated labels, punctuated labels, and genuine taste choices.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4436@d6c348f1956d0a77f4fa77a6b569a0028a1961a6

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
