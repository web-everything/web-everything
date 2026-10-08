---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/conveyor/__tests__/"]
dateOpened: "2026-10-08"
tags: []
---

# Orphan-adopt: a session blocked on a human for over 30 minutes must not lose its build claim

Follow-up from #4361 advisory review (operator approved with follow-up cards 2026-10-08). we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:395 treats blocked as alive only while updatedAt is under 30 min, so a session waiting on a human longer is released as orphan-released and a second build of the same card can start. Give blocked its own longer window (setting) or treat it alive until terminal; add a defaultSessionLiveness test for a stale blocked record.

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
