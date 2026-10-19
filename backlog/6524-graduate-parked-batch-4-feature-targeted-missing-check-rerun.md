---
bornAs: x6605ax
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor", "we:scripts/settings/missing-run-rerequest.json"]
dateOpened: "2026-10-19"
tags: []
---

# Graduate parked batch-4 feature: targeted missing-check rerun

Parked on branch lane/proto-b4-missing-check (feature b4b: re-request a missing required check run for the live head, with cooldown; commit e0d00b083; reverted from the proto-daemon branch in 4e640e983). It must land through a graduation PR, not by merging the prototype branch. The audit findings that parked it are in the operator audit transcript of 2026-10-18 and were not restated in the filing request: the graduating worker must recover them first, fix each, and give each a named test.

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
