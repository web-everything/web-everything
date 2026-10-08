---
bornAs: xp4r23a
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/lease-reaper.mjs", "we:scripts/lane-pool.mjs", "we:scripts/conveyor/__tests__/lease-reaper.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Lease reaper reaps a fresh build lane as pr-merged off the item's earlier prepare PR

A conveyor-<N> build lease is reaped as pr-merged seconds after acquire because item N's PREPARE PR (lane/N-prepare-*) merged earlier; byItem lookup ignores when the PR merged vs when the lease was acquired. Live: lane-12 conveyor-4420 reaped 2s after acquire off PR #4358 (merged 00:03Z); 7 such reaps of conveyor-4420 today. Fix: a PR that reached its terminal state before the lease's acquiredAt cannot be that lease's work, so it never fires the PR-terminal axis (reaper + lane-pool deadLeasePlan).

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
