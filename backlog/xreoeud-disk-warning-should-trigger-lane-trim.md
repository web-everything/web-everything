---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Disk warning should trigger lane trim

MED priority hint. ## (held 2026-10-27 12:56 ET) Disk warning should trigger lane trim At 12:13 ET the disk warning fired with 29.9 GB free and the web-everything pool at 90 lanes (cap 60). I ran a trim by hand on the operator's go, which removed 30 idle lanes and left 64 GB free. Fix: health-watch runs `lane-pool trim` (and gc) automatically on a disk-space warning. Prove it on the next warning. - Review ledger push to ops/review-requests failed 5x at 15:53Z ("failed to push some refs"), which parked #5958. Its bounded retry recovered it. Card: retry fetch+rebase on non-fast-forward before counting an attempt.

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
