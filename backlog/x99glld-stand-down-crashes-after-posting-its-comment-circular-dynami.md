---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# stand-down crashes after posting its comment: circular dynamic import never settles

Live on PR 7452 (2026-11-25 13:58Z): we:scripts/conveyor/stand-down.mjs posted its comment, then exited 13 with 'Detected unsettled top-level await' at its dynamic import of we:scripts/conveyor/fix-dispatch-claim.mjs. That module imports we:scripts/conveyor/reconcile-core.mjs, which imports the still-evaluating stand-down entry module. So the dispatch claim is not released and the stood-down label is never added. Want: the CLI finishes both steps; a test runs the real CLI as a child process.

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
