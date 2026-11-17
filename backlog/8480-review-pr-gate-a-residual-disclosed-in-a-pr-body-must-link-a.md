---
bornAs: xgjd9if
kind: story
size: 2
status: active
scaffoldedBy: "fix-6699"
dateScaffolded: "2026-11-12"
scope: ["we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-11-12"
tags: []
related: ["8036"]
---

# Review/PR gate: a residual disclosed in a PR body must link a filed card id

Prevention owed by the PR 6699 review. The PR body disclosed a residual with only 'Reinforce-later card owed', and nothing checked that the card existed. Add a check (PR-body lint or review pre-step) that every line in a PR body naming a residual, reinforce-later or follow-up links a backlog card id that resolves, and refuses the hand-off otherwise.

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

prevention owed by the PR 6699 review
