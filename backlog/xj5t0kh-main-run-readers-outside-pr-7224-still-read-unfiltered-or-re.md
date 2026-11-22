---
kind: task
status: active
scaffoldedBy: "fix-7224"
dateScaffolded: "2026-11-22"
scope: ["we:scripts/conveyor/fix-loop-ledger.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-22"
tags: []
related: ["7224"]
---

# Main-run readers outside PR 7224 still read unfiltered or reused main runs (fix-loop-ledger, reconcile-pass)

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

## Duplicate admission

same defect class as PR 7224 send-back findings 4 and 5: main CI readers must count only push/schedule events and treat a proven-reused push as neither red nor green
