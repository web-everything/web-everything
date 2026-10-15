---
kind: task
status: open
scope: ["we:backlog/6127-card-number-ledger-switch.md"]
dateOpened: "2026-10-14"
tags: []
---

# Card-number ledger switch: rollback materialization must record formerSlugs aliases

Operator ruling 'card' on PR #5245 red-team break (2026-10-14 ~20:10 ET). Slice 6127 (we:backlog/6127-card-number-ledger-switch.md ~67) lets a landed x-id card be numbered through repair/numberPendingHashes after a switch back to rename-before-enqueue, but only the 6126 batch job records formerSlugs, so the published /backlog/<x-id>-<slug>/ and /backlog/<x-id>/ routes lose their redirect. Fix: every numeric materialization path (batch, repair, numberPendingHashes, rollback) records formerSlugs through one shared helper; add a rollback-path test. Amend slice 6127 when it is prepared.

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
