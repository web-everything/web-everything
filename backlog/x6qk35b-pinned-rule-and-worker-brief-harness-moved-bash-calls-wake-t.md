---
kind: story
size: 2
status: open
scope: ["we:CLAUDE.md", "we:agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md", "we:scripts/worker-brief.mjs", "we:scripts/__tests__/worker-brief.test.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# Pinned rule and worker brief: harness-moved Bash calls wake the agent

Claude Code 2.1.316 moves a subagent's >180s foreground Bash call to the background and resumes the agent (proven 2026-10-31); update the pinned rule in we:CLAUDE.md, we:agent-memory-src/subagent-must-not-end-turn-on-passive-wait.md and we:scripts/worker-brief.mjs

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
