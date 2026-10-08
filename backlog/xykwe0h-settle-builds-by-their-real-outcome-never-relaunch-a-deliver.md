---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/conveyor/build-delivery-evidence.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/conveyor/__tests__/build-delivery-evidence.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Settle builds by their real outcome; never relaunch a delivered card; await-verify is not dead

Every Claude and agy build is recorded orphan-released even when it opened a PR (#4388 to #4339). A build awaiting verify (#5189) was treated as dead and redone, and #4382 was relaunched after its PR merged. Settle from the real PR or card state, check PR and card before dispatch, and treat a paused await-verify session as alive.

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
