---
bornAs: ximkvqu
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor", "we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Fixer 'already addressed, no push' re-arms review on the same head; a lost lane lease re-acquires safely

2026-10-24 18:30 ET live #5848: stuck 2 sweeps under review:changes - fixer finds both findings addressed, pushes nothing, then fails with a lane-lease mismatch 3 times. Want: the no-push outcome re-arms review on the same head, and the lease mismatch is fixed. 19:47 ET (#5888 worker): a fix run must re-acquire a genuinely lost lane lease safely without discarding finished work (acquire on a freed lane currently resets it).

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
