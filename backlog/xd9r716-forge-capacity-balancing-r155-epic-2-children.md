---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Forge capacity balancing (R155) — epic + 2 children

MED priority hint. ## (held 2026-10-26 21:50 ET) Forge capacity balancing (R155) — epic + 2 children Phase 1 (now): measure Forge CPU/RAM saturation and what waited (CI jobs queued for the hetzner label, heavy-admission waiters, Mac load). Child A (Phase 2): an admission gate on Forge handing out ~28 thread-units by priority: merge-queue CI > main-fix > fix-round PR CI/worker gates > other worker runs and daemon smoke. Overflow: remote exec runs locally, PR CI on GitHub-hosted. Child B (Phase 3): a balancing robot that reads merge-queue depth, queued hetzner jobs, heavy-queue waiters, Mac load and Forge load every minute, and adjusts the online runner count (start/stop runner services) and remote intake; policy-cascade settings. Gate: build A only if the Phase 1 data shows contention.

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
