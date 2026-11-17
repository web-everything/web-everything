---
bornAs: xnt2yre
kind: story
size: 3
status: active
scaffoldedBy: "fix-5082"
dateScaffolded: "2026-10-13"
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/land-advance.mjs", "we:scripts/operations/land-advance-io.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Carry the drain-number hold (owedMainRule) into fix, conflict-fix and land-advance ci-heal dispatches

PR #5082 self-review: when test fails only on drain-assigned hand-picked-NNN numbers, only the reconcile ci-heal path is told to leave those card numbers alone. A fix or conflict-fix agent on the same PR, and land-advance's opt-in ci-heal (its reconcile-hold lookup maps only dispatch-review/dispatch-fix), carry no owedMainRule and could rename the drain-assigned cards.

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
