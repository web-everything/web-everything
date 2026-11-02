---
bornAs: xlp8jj8
kind: story
size: 5
status: open
scope: ["we:scripts/codex-direct-task.mjs", "we:scripts/verify-lane.mjs", "we:scripts/operations/prototype-load.mjs", "we:scripts/worker-brief.mjs", "we:CLAUDE.md"]
dateOpened: "2026-11-01"
tags: []
---

# Slow worker tools return a job id fast (--async) plus a bounded status/result subcommand

Held card 2026-11-01 17:19 ET, HIGH. Subagent Bash calls over about 180 s are auto-backgrounded, and we:scripts/codex-direct-task.mjs, we:scripts/verify-lane.mjs and we:scripts/operations/prototype-load.mjs routinely exceed that: the root cause of most worker-ended-turn-waiting slips. Fix: each tool takes --async and returns a job id fast, with a status/result subcommand using --wait=150000 (each call under 180 s). we:scripts/worker-brief.mjs teaches the pattern; update the pinned rule in we:CLAUDE.md, since codex-direct-task is no longer always foreground-synchronous in practice.

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
