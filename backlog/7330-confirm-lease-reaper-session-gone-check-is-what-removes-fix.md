---
bornAs: xg0g2q7
kind: task
status: open
scope: ["we:scripts/conveyor/lease-reaper.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Confirm lease-reaper session-gone check is what removes fix-run lane leases

2026-10-28 10:04 ET. Lease reaper's session-gone check (we:scripts/conveyor/lease-reaper.mjs ~:1074) is the suspected remover of fix-run lane leases (#5983/#5964 lease-lost loops); unproven. Confirm with reaper logs after #6030 is live.

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
