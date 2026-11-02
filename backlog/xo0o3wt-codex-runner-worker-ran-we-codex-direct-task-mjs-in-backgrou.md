---
kind: story
size: 2
status: open
scope: ["we:codex-direct-task.mjs", "we:CLAUDE.md"]
dateOpened: "2026-11-02"
tags: []
---

# codex-runner worker ran we:codex-direct-task.mjs in background then stopped (pinned we:CLAUDE.md rule violated

HIGH priority hint. - [HIGH 2026-10-31 07:43 ET] codex-runner worker ran we:codex-direct-task.mjs in background then stopped (pinned we:CLAUDE.md rule violated again). Make the hook deny run_in_background for codex-direct-task/gemini-direct-task. → filed as xdsqhci (PR #6123)

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
