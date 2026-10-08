---
bornAs: xyloz19
kind: story
size: 5
parent: "128"
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/operations/runner-activity-io.mjs", "we:scripts/operations/land-advance-cli.mjs", "we:scripts/operations/__tests__/run-store.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Run records move to one shared folder (D6 of 128)

Each daemon clone keeps its own .operations/runs so no reader sees another daemon's run history; /sessions flags review-history:per-clone-store-d6-pending. Move the run store to one shared root (~/workspace/.operations/runs, OPERATION_RUNS_DIR still wins), atomic writes, one-time move of old per-clone records at first use. Test: a record written from the review daemon's clone is readable from the fix daemon's clone.

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
