---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Raise gh slot throughput once the role Apps are live

[held entry 346] (operator 2026-10-15 ~07:45 ET, held, do after #5345 is live and merger is added) Raise gh slot throughput once the role Apps are live. Today there are 6 slots host-wide for one shared App. With per-role Apps, each has its own quota and burst limit. Fix idea: per-App slot pools (cascade setting ghThrottle.pools.<role>, e.g. 4-6 each) plus the existing host cap raised, with priority (merger > fixer/reviewer > observer/smoke). Prove: 120 s waits/h and drain fast-drain seconds before vs after, with no secondary-rate-limit 403s.

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
