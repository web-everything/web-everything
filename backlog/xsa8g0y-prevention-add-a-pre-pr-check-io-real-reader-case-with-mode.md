---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/pre-pr-check.mjs", "we:skills-src/conveyor/delivery-agent-brief.md", "we:scripts/operations/__tests__/pre-pr-check.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a pre-pr-check-io real-reader case with mode off. Better, build unit-test decision fixtures f… (from web-everything/web-everything#4406 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/pre-pr-check.mjs:23` — Add a pre-pr-check-io real-reader case with mode off. Better, build unit-test decision fixtures from the real function's return shape.
2. `we:skills-src/conveyor/delivery-agent-brief.md:321` — Add a deterministic brief-contract test requiring all three briefs to distinguish a gated head with a valid receipt from one needing review, alongside the existing valid-receipt test.
3. `we:scripts/operations/pre-pr-check.mjs:61` — Add a deterministic oversized-error test asserting exactly 300 retained characters through the operation's read step.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4406@13612eb7f0fe25b5436d06e238c19df0ffbb20da

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
