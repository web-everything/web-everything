---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/infra-cancelled.test.mjs", "we:scripts/conveyor/infra-cancelled.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a review-lens or lint check that every new WE_* env knob resolver has a unit test covering un… (from web-everything/web-everything#4336 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/infra-cancelled.test.mjs:29` — Add a review-lens or lint check that every new `WE_*` env knob resolver has a unit test covering unset, empty, invalid, zero and boundary values.
2. `we:scripts/conveyor/infra-cancelled.mjs:40` — Record the heuristic's false-positive class in the knob's doc comment and add a test that pins the chosen behaviour for a long, superseded cancel.
3. `we:scripts/conveyor/__tests__/infra-cancelled.test.mjs:25` — Add a deterministic unit test that sets WE_CI_HUNG_JOB_MINUTES='0', calls isInfraCancelledJob without options, asserts true for a long-running cancelled job, and restores the environment afterward.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4336@c54adc4d61bd55f385a2ece19656a61d944065f5

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
