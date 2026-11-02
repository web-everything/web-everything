---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Evaluate Gemini 4 Carbon (operator 10-29 15:39 ET

LOW priority hint. - [LOW, planned, not now] Evaluate Gemini 4 Carbon (operator 10-29 15:39 ET: "plan but stay focused on priority"). Steps: 1) look up its capability, cost and agy/Gemini CLI model id; 2) trial it as an ADVISORY extra review seat via agy (WE_REVIEW_SEAT_CAP_AGY_GEMINI is currently 0) on about 5 PRs and compare its findings vs the Claude/Codex seats; 3) only then consider gemini-direct-task routing. Pick it up after the merge backlog clears (O<=12) or in the weekly plan.

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
