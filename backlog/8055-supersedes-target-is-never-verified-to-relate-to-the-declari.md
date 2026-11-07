---
bornAs: xtopkid
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/supersede-rule.mjs", "we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Supersedes target is never verified to relate to the declaring PR; any automation-authored PR can freeze any …

Flow-sim gap R9b-G5, class K8 (authority asymmetry). Failing input: Trusted (automation) PR #B merged with line 'Supersedes #5000' where #5000 is an unrelated open PR (typo, copy of a template line, wrong number, or a cross-repo number).' 'supersede-watch tick. Cited: we:scripts/conveyor/supersede-rule.mjs:274-280, we:scripts/conveyor/stand-down.mjs:233, we:scripts/conveyor/reconcile-core.mjs:2573. Soak-break sketch: fixture: merged trusted PR whose card/files do not overlap open PR #5000's; body 'Supersedes: #5000'. action: planSupersedeHolds. assert hold is not terminal-posted without relation evidence (or is posted as advisory) - today a terminal hold is planned.

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
