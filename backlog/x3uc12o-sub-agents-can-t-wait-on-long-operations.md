---
kind: story
size: 2
status: open
scope: ["we:CLAUDE.md"]
dateOpened: "2026-11-02"
tags: []
---

# Sub-agents can't wait on long operations

MED priority hint. ## (held 2026-10-25 15:34 ET) Sub-agents can't wait on long operations Two workers today (5754: a Codex run; fixer-rearm-allow: prototype-load) backgrounded a long command, found sleep/Monitor/until-loops blocked by guards, and ended their turn with the work in flight. That breaks the pinned we:CLAUDE.md rule, and the orchestrator has to finish the step. Fix: give long operations (prototype-load, codex-direct-task, heavy-queue gates) a foreground `--wait` with bounded progress that fits the 10-min Bash cap, plus a resumable `--status=<job>` call. The worker brief then says "foreground, or re-call --status", never background.

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
