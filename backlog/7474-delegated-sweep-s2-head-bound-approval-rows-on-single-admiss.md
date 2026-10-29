---
bornAs: x660rls
kind: story
size: 5
status: open
scope: ["we:scripts/lib/pr-state/holds/verdict.mjs", "we:scripts/conveyor/delegated-clear-human.mjs", "we:scripts/lib/verdict-ledger.mjs"]
dateOpened: "2026-10-29"
tags: []
---

# Delegated sweep S2: head-bound approval rows on single admission

Pre-approval rows must carry approvedHead (no inferred baseline); built on #5982 single admission via admitClearHuman as the only gate. Owns invariants I1 exact head, I2 block wins, I8 fail closed. Depends on the clear-human rebuild PRs (#6036 head binding, #6043 shared snapshot) landing.

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
