---
bornAs: xhluc7i
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-15"
tags: []
---

# Multi-profile Claude session management (account A/B): fail-closed per-profile listing, full-UUID ownership

2026-11-15 16:10 ET HIGH (redesign, from parked #6832): multi-profile Claude session management (account A/B): per-profile fail-closed listing (an invalid profile makes the whole listing unknown), ownership by FULL UUID per profile (never broadcast short IDs), dedupe stores by real path, and indeterminate account-validation results must release reserved lanes with a reason. Prerequisite for enabling routing.accountB. Opus design pass first.

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
