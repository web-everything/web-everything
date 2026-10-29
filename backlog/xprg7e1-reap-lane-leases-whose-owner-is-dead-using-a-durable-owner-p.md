---
bornAs: xprg7e1
kind: story
size: 5
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-lease.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Reap lane leases whose owner is dead, using a durable owner pid

we:scripts/lane-pool.mjs lease pid is the short-lived acquire process, so pid-liveness cannot prove the owner is gone. Record a durable owner pid (the long-lived worker/session process) in the lease and have we:scripts/lane-pool.mjs reapDeadLeasesInPool reap leases whose owner pid is dead on this host. Seen 2026-10-28: coordinator hand-released 4 leaked leases, one 3 h old. Must keep exclusivity: never reap a live owner; fail closed when the pid is unreadable.

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
