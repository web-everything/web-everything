---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# hold:fix label and fix-dispatch.kill do not stop review:changes fixers

Flow-sim gap E-G1, class K10 (hold without a settler). Failing input: open lane PR with review:changes, no live claim, operator has created ~/.claude/conveyor/fix-dispatch.kill or put hold:fix on the PR' 'next fix-daemon tick Cited: we:scripts/conveyor/reconcile-fix-dispatch.mjs:2046-2179. Soak-break sketch: review fixer is dispatched anyway (acts despite operator hold)

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
