---
bornAs: x1g164z
kind: story
size: 2
status: open
scope: ["we:scripts/forge-remote-health.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Forge health backoff on maxLoadPerCore: wait a busy-but-healthy Forge (bounded) instead of falling back to the Mac

R909 (2026-11-12 19:59 ET). The maxLoadPerCore backoff in we:scripts/forge-remote-health.mjs sends runs to the Mac when Forge is busy (load 28.5/32, 6/8 slots active). Extend the forge-busy-wait-retry budget to this trigger; health means unreachable or errors only.

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

## Duplicate admission

capability-search found no matching open card
