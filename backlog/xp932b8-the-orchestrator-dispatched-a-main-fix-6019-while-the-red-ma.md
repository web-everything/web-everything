---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# The orchestrator dispatched a main-fix (#6019) while the red-main system had already opened #6018 (16:20 ET)

MED priority hint. 383. (coroner-1027, held; key: duplicate-main-fix) The orchestrator dispatched a main-fix (#6019) while the red-main system had already opened #6018 (16:20 ET). Cost: one duplicate worker/PR, closed as duplicate 21:04Z; the operator was first told to force-merge the wrong PR (20:57 vs 20:59Z). Fix idea: the free-scope/dispatch check refuses a main-fix when an open PR from the red-main alert targets the same red check; the BREAK-GLASS READY line names the PR from that source. Evidence: session bd616854 10-27 20:33-21:04Z, #6018, #6019. Scope: we:scripts/conveyor (dispatch check). Size 2.

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
