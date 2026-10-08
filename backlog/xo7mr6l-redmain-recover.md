---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Re-run a PR once main recovers when its escalation blamed main's own defect

PRs #4368/#4369 sat needs-human after main was repaired: their red fell outside any red-main window (main's run was cancelled), so ci-heal escalated 'main's own defect' and nothing re-ran them. Recognise that escalation class and refresh onto main once, after main's required check is green on a newer main.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
