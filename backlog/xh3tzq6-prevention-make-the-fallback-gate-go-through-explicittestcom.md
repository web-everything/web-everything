---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Make the fallback gate go through explicitTestCommand(tests, scaledTimeoutFlags(factor)), the sam… (from web-everything/web-everything#7323 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/verify-dispatch.mjs:442` — Make the fallback gate go through `explicitTestCommand(tests, scaledTimeoutFlags(factor))`, the same helper the default gate uses. Add a test that runs the real `fallbackGate` with factor 3 and asserts the timeout flags are present.
2. `we:scripts/verify-lane.mjs:480` — Add a test asserting the refusal `detail` suggests a gate that `explicitGateRefusal` accepts, or generate the suggestion from the accepted form (`npx vitest run <files>`).
3. `we:scripts/conveyor/verify-dispatch.mjs:732` — Add an args-forwarding test for `runLaneGate` and a CLI-level request test asserting `marker.gateUncapped`. Longer term, a lint that every audit field listed in `verifyStartBody` has a producer-to-consumer test.
4. `we:scripts/lib/verify-lane-gate.mjs:560` — Add a standards or unit rule that a selection with `status: capped-fallback` AND zero tests must be recorded as `infrastructure-failure` or a refusal rather than green. Or make a graph error fail the local gate closed, leaving CI as the authority.
5. `we:scripts/conveyor/verify-dispatch.mjs:732` — Add a `runLaneGate` unit test asserting `--gate-uncapped` appears in spawn args when `marker.gateUncapped === true`, plus a job-input round-trip assertion. A write-gate requiring each new marker audit field to have a forwarding test would catch the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7323@9b021adba6ccd18d77bef4edcf8609087c8013ab

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
