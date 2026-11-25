---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs", "we:scripts/settings/delivery-strategy-table.json", "we:scripts/settings/delivery-strategy.json"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/strategy-selector-core into focused changes

size-split-key:ec1ec6c29e05618354736fc068c84ee74151f6b7468c888d31b1c56fa485f517. Plan follow-up splits for PR lane/strategy-selector-core. File groups: we:scripts/conveyor: 230; we:scripts/settings: 443

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
