---
bornAs: xrsehyk
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-15"
tags: []
---

# Capacity gate should use delivery signals, not just idle CPU

2026-11-15 13:20 ET MED: capacity gate should use delivery signals, not just idle CPU: heavy-queue projected wait (>15 min means no builds), review holds on host load (any means deliver mode), merge throughput vs open PRs (S2 shadow cap), idle averaged over 5-10 min, memory pressure (swap/compressor). Operator 13:16 ET: "just want to make sure we use the correct signals". Related: #8328 (R940 follow-up slice 15:09 ET is tracked there).

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
