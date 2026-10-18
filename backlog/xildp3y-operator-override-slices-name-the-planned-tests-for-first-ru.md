---
kind: story
size: 1
status: active
scaffoldedBy: "rule-5549-lane-2-436f6567"
dateScaffolded: "2026-10-18"
scope: ["we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md", "we:backlog/6269-we-operator-override-slice-3-guard-floor-confirm-and-flag-on.md"]
dateOpened: "2026-10-18"
tags: []
---

# Operator-override slices: name the planned tests for first-run replay, pagination, invalid-identity cursor hold, and slice-3 fail-closed edges

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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
