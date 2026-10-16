---
bornAs: x3o0ohn
kind: story
size: 2
status: open
blockedBy: ["5968"]
scope: ["we:scripts/conveyor/exhausted-retry.mjs", "we:scripts/conveyor/__tests__/exhausted-retry.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# exhausted-retry: use the shared CI-heal budget evidence so undated heals stay charged

we:scripts/conveyor/exhausted-retry.mjs `exhaustionFacts` keeps its own copy of the fix-head reset filter and still refunds heals with no readable time (`Date.parse(undefined) > cut` is false, so the heal is dropped). Route it through `ciHealBudgetEvidence` in we:scripts/conveyor/ci-heal-mark.mjs so every reader fails closed, as reconcile, tick and landing now do (#5968).

## Acceptance

- [A1] **Executable** — the test file we:scripts/conveyor/__tests__/exhausted-retry.test.mjs, run through the heavy-admission queue with `npx vitest run`, includes a case where three dated heals precede a trusted fixer push and one undated heal exists: `exhaustionFacts` treats exactly one heal (the undated one) as chargeable, where the old filter dropped it and counted zero. It fails before this item lands and passes after.
- [A2] `exhaustionFacts` reads its count and its reset boundary from `ciHealBudgetEvidence`; no local copy of the reset filter remains.

## Non-goals

- [N1] No change to cap values, stand-down handling, or the lapse rules for stand-down comments.

## Edge cases this change must handle

1. **Untrusted text** — n/a: comments are only counted, never rendered.
2. **Truncated reads** — n/a: the caller already owns the comment read; this change only changes how a given list is counted.
3. **Shared state files** — n/a: pure function, no state file.
4. **Fail closed** — a heal whose time is missing or invalid stays charged; an invalid reset is no reset.
5. **Identity scoping** — n/a: keyed by the comment list of one PR, as before.
6. **State over time** — heals at or before the reset time are refunded; one at any later time is kept; an attempt covered by both a reset and an attributed window is refunded once.
7. **Who wrote it** — only trusted-author markers count, exactly as `ciHealBudgetResetAt` and `countCiHealComments` already decide.
