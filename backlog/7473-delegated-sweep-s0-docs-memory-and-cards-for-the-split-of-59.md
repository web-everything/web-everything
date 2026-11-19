---
bornAs: x703e22
kind: story
size: 2
status: open
scope: ["we:docs/agent/testing.md", "we:agent-memory-src/"]
dateOpened: "2026-10-29"
tags: []
---

# Delegated sweep S0: docs, memory and cards for the split of #5983

Docs, memory and cards for the R211 split of closed #5983 (branch lane/r130-delegated-sweep kept for salvage). Records the threat-model brief and invariants I1-I9 (I1 exact head, I2 block wins, I3 dismissal never outlives a later block, I4 expiry admitted once at commit point, I5 refusal final, I6 per-PR isolation, I7 write-once baselines, I8 fail closed, I9 shadow until a valid deadline). Owns docs only; no code.

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
