---
kind: story
size: 2
status: active
scaffoldedBy: "fix-4655"
dateScaffolded: "2026-10-09"
scope: ["we:scripts/conveyor/pr-stack.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Age out stacked-above holds so a stale bottom cannot hold its top indefinitely

PR #4655 round-2 security finding (stacked-above has no aging bound): a top PR is refused stacked-above for as long as its bottom stays open and in sync. Same-actor ownership now limits who can form a stack, but a bottom that is simply idle still holds its top with no escape. Persist the time a pair was first held and, past a settable age, release the top to ordinary dispatch with a visible refusal. Prove with a test that drives passes against persisted memory.

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
