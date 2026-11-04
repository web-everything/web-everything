---
bornAs: xvpe7pm
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# ready-to-merge label left on red-team:blocked PRs

MED priority hint. ## (held 2026-10-26 09:29 ET) ready-to-merge label left on red-team:blocked PRs #5973 and #5970 carry ready-to-merge + red-team:blocked (their last review was not accepted), so the drain spends a fast-drain slot to skip them as "sent-back" and #5973 sat unowned for 80+ min. Fix: label reconcile strips ready-to-merge when red-team:blocked or review:changes appears; the fix daemon picks up a red-team:blocked PR with a degraded finding (send-back or card).

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
