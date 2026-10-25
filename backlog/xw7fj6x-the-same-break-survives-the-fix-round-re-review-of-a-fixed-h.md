---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The same break survives the fix round: re-review of a fixed head never re-checks earlier confirmed breaks

[held entry 295] (coroner 2026-10-13, held) The same break survives the fix round: re-review of a fixed head never re-checks earlier confirmed breaks. 6 PRs: #5038 (zero-padded IDs, 2 heads), #5241 (starvation, 3 heads), #5045, #5235, #5195, #5082. Fix idea: feed the previous head's confirmed red-team breaks and blocked referrals into the next review as its aim (#3094 slot); each must be answered fixed / still-broken with a test cite before accept. Evidence: scratchpad redteam/confirmed.tsv. Scope: we:scripts/operations/review-pr.mjs buildPanelMandate. Size 3.

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
