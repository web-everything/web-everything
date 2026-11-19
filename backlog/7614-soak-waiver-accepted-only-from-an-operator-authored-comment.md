---
bornAs: xwr4my4
kind: story
size: 3
status: open
scope: ["we:scripts/lib/soak-precheck-at-open.mjs", "we:scripts/lib/soak-replay-gate.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# soak-waiver accepted only from an operator-authored comment or ruling, never the PR body

Held card 2026-11-01 11:21 ET (#6169, #6174). open-pr itself demands a soak-waiver: line in the PR body, so workers add it and skip the soak precheck. Fix: the precheck accepts a waiver only from an operator-authored comment or ruling (operator identity), never from author-lane PR body text. Note #4479 made the gate re-read the live body; this card removes the body as a trusted source.

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
