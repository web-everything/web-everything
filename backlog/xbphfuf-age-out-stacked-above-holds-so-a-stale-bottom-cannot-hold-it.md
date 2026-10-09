---
kind: story
size: 2
status: active
scaffoldedBy: "fix-4655"
dateScaffolded: "2026-10-09"
scope: ["we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs", "we:scripts/settings/pr-stack.json"]
dateOpened: "2026-10-09"
tags: []
---

# Age out stacked-above holds so a stale bottom cannot hold its top indefinitely

PR #4655 round-2 security finding (stacked-above has no aging bound): a top PR is refused stacked-above for as long as its bottom stays open and in sync. Same-actor ownership now limits who can form a stack, but a bottom that is simply idle still holds its top with no escape. Persist the time a pair was first held and, past a settable age, release the top to ordinary dispatch with a visible refusal. Prove with a test that drives passes against persisted memory.

Delivered in PR #4655 round 3: each remembered pair carries `heldSince` / `heldFor` (the bottom head the top was proven to contain); once the hold reaches `prStack.holdMaxAgeMs` (default 6h, env `WE_PR_STACK_HOLD_MAX_AGE_MS`) the top is dispatched as an ordinary peer with a `stacked-above-aged` refusal. The clock starts the first pass the top is actually withheld (never merely because the pair was seen in sync), is saved by the reconcile pass right after the order is applied, and restarts when the head the top is held against changes or when a pass withholds nothing (nothing owed, or `detect` / `bottomFirst` off).

## Acceptance

- [A1] **Executable** — the pr-stack unit suite's "a stacked-above hold ages out" block fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Must: an unreadable or missing clock never releases a hold early (a missing clock starts fresh and holds), and a malformed `heldSince` / `heldFor` drops only that memory entry. Must: the release only changes WHICH dispatch path the top takes; the scope-overlap fence and the round caps still apply to it.

## Non-goals

- [N1] No wall-clock alerting for a long-held pair: the visible `stacked-above-aged` refusal is the signal.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the clock is two numbers and a validated sha; no free text is stored.
2. **Truncated reads** — an unreadable memory file or entry carries no saved clock, so the hold starts fresh rather than releasing; a per-process mirror of the first-held time stops a memory file that never reads or writes from holding the top forever.
3. **Shared state files** — the clock rides the existing atomic temp-file-and-rename memory write.
4. **Fail closed** — a missing or invalid clock starts a fresh hold; only a proven expired clock releases the top.
5. **Identity scoping** — the clock is per (top, bottom) pair and per held bottom head, so one pair's age never frees another.
6. **State over time** — the clock restarts when the head the top is held against changes; it never resets just because a pass ran, and never runs while the top is not withheld.
7. **Who wrote it** — n/a: the memory file is written only by the fix daemon's own pass; entries are shape-checked on read.
