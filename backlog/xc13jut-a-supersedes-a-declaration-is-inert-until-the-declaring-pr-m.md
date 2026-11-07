---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/supersede-watch.mjs", "we:scripts/conveyor/supersede-rule.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A 'Supersedes #A' declaration is inert until the declaring PR merges, so old and new PR are both live (double…

Flow-sim gap R9b-G2, class K7 (unserialized duplicate actors). Failing input: Open PR #B body 'Supersedes: #A' (as we:open-pr.mjs:40-47 tells authors), #A open with review:changes or in review. No hold, no relation recorded anywhere.' 'Review, fix and ci-heal daemons both work #A and #B in parallel; #A can also be accepted and merged first. Cited: we:scripts/conveyor/supersede-watch.mjs:36-41, we:scripts/conveyor/supersede-rule.mjs:303-304, we:scripts/conveyor/reconcile-core.mjs. Soak-break sketch: fixture: open #B body 'Supersedes: #A'; open #A review:changes, no stand-down. action: reconcile plan for #A while #B is open. assert #A is not dispatched a fixer (or carries a 'superseding PR in flight' note) - today it is dispatched.

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
