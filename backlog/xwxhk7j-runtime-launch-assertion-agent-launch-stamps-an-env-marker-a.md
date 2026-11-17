---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/agent-launch.mjs", "we:scripts/__tests__/agent-launch.test.mjs"]
dateOpened: "2026-11-17"
tags: []
---

# Runtime launch assertion: agent-launch stamps an env marker and launched sessions refuse to start without it

Real enforcement follow-up to the agent-launch lint (R1019): we:scripts/lib/agent-launch.mjs stamps an env marker on every launch it makes, and launched claude/codex sessions refuse to start without it, so a launch that bypasses the module fails at runtime. The structural test we:scripts/__tests__/agent-launch-structure.test.mjs is a lint for literal launches only.

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
