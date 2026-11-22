---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test that feeds the advice string's example gate back through the refusal path and expects… (from web-everything/web-everything#7323 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:480` — Add a test that feeds the advice string's example gate back through the refusal path and expects acceptance. Alternatively derive the advice from a constant that the same test exercises.
2. `we:scripts/verify-lane.mjs:472` — Add a test that stamps a pre-change default gate string, runs the dispatched-child path, and expects a recognised default gate or a deliberate refusal. Consider a stamped-gate fixture corpus replayed by the verify-lane tests.
3. `we:scripts/conveyor/verify-dispatch.mjs:729` — Add a `runLaneGate` argv test for each marker-derived flag (`--local`, `--gate-uncapped`). A standards rule requiring a test reference for each `args.push('--…')` site would be a deterministic gate.
4. `we:scripts/conveyor/verify-dispatch.mjs:729` — Add a runLaneGate argv test for the marker.gateUncapped forwarding, and persist gateUncapped from the prior marker the way gateExplicit is. A check:standards rule that every marker audit field has a producer-to-consumer round-trip test would cover the whole class.
5. `we:scripts/lib/verify-lane-gate.mjs:559` — Add a deterministic regression test with named suites exceeding the byte budget, asserting that every emitted command remains bounded; budget guards too or execute them in bounded batches.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7323@93d09c0f1951944b19e16d8d828a7e802da1c98c

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
