---
bornAs: x1153mp
kind: task
status: open
scope: ["we:scripts/operations", "we:.claude/skills/coroner"]
dateOpened: "2026-10-25"
tags: []
---

# Coroner ASSISTANT section script (bounded transcript read, counts only)

coroner 2026-10-23: the ASSISTANT section has no script in the repo - a hand-run read of the orchestrator transcript each night (R24), so numbers are not reproducible. Add we:scripts/operations/coroner-assistant.mjs (bounded streaming read: user turns, compactions, tokens by model, corrected-claim and ruling-miss candidate ids) and call it from the skill. Tonight's window: 56 user turns, 2 compactions, 1164 assistant turns, cache read 663 M.

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
