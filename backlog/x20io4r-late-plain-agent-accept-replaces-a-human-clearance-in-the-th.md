---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/human-surface-repark.mjs", "we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Late plain agent accept replaces a human clearance in the thread while labels still say cleared

Flow-sim gap C-G9, class K9 (divergent predicates for one state). Failing input: Operator ran clear-human at head H (labels: review:accepted, review:human removed). A review run that started earlier finishes afterward and posts a plain accept comment with reviewed-sha H (or the review daemon posts an advisory-fix accept).' 'E7 approve before review finishes Cited: we:scripts/conveyor/human-surface-repark.mjs:64-70, we:scripts/lib/review-escalation.mjs:2038-2061, we:scripts/lib/review-escalation.mjs:3177, we:scripts/lib/review-escalation.mjs:3178-3199. Soak-break sketch: human-surface-repark-concurrent-clearance covers the sweep-vs-clear race; fixPresent true (we:human-surface-repark.mjs:154,180,86 contain the three required strings). Not this ordering.

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
