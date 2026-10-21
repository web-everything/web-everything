---
bornAs: xtbxcp8
kind: story
size: 2
status: closed
closedReason: duplicate
closedInto: "6637"
dateClosed: "2026-10-20"
scope: ["we:scripts/conveyor/fix-scope-fence.mjs", "we:scripts/conveyor/fix-scope-fence.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# fix-scope-fence: human-review send-back header must not disable removal-marker enforcement

Red-team break at we:scripts/conveyor/fix-scope-fence.mjs:41 (PR #5461): the supported human-review send-back header silently disables removal-marker enforcement. Scenario: a fix PR is sent back with the supported human-review header; the fence reads that header as an opt-out and skips removal-marker checks, so a removal outside the allowed scope passes unflagged. Harmless today because the fence is warn-only, but it must be fixed before the fence moves to blocking: the header must not disable removal-marker enforcement; add tests in the fence's test file for the header case. Ruled CARD by the operator 2026-10-17 (Ok to all). [A1] Executable.

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
