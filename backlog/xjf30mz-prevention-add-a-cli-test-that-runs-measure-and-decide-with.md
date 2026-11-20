---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/test-selection.mjs", "we:scripts/lib/static-selection-edges.mjs", "we:scripts/readiness/__tests__/test-selection.test.mjs", "we:scripts/lib/__tests__/static-selection-edges.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a CLI test that runs --measure and --decide with no shadow env and asserts no shadow key is e… (from web-everything/web-everything#7212 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/test-selection.mjs` — Add a CLI test that runs --measure and --decide with no shadow env and asserts no `shadow` key is emitted. Longer term, a lint requiring each documented env gate to appear in a test with both set and unset values.
2. `we:scripts/lib/static-selection-edges.mjs` — Review lens: for each guarantee sentence in a new docs section, name the test that defends it. Longer term, a standards rule that flags exported options (`maxTests`) never exercised by any test.
3. `we:scripts/lib/static-selection-edges.mjs` — Have the Saturday shadow run report the fraction of files marked partial. If it is above a threshold, add a deterministic check that fails or flags it. File this as a follow-up on the accuracy card (the 8613 backlog card).
4. `we:scripts/readiness/test-selection.mjs:701` — Add a CLI test for each arm of the gating condition (decide-mode absent, measure with env and flag unset absent, flag-only enabled, env-only enabled). Cheapest durable guard: a table-driven test over env and flag combinations.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7212@1f7c8f157d09b6434a0dd2f58fa9e9d1ac1eb868

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
