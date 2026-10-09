---
kind: story
size: 2
parent: "3383"
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Auto-policy block on the current head hides a came-back finding from the fixer ladder (endless not-applicable fix loop)

Live 2026-10-09 plateau-app #217: auto-policy blocked the same finding on 166d067 and again on the fix head dfa0b5c. ignoredRulings counted the auto-policy ruling on the current head as the operator having looked, so the came-back was invisible; reconcile took the block-ruled-referral branch (no fixer-return count, no ladder) and re-dispatched fix-pa-217 ~25 times, each ending not-applicable (already fixed). Fix: only a person's ruling on this head settles it; an auto-policy block does not. The finding now reaches the ruling-not-addressed ladder (resend, stronger model test-first, then ruling-dispute to the operator). Follow-up: an arbiter rung instead of the operator for fixer-vs-reviewer disputes; and the block-ruled-referral branch itself should count fixer returns.

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
