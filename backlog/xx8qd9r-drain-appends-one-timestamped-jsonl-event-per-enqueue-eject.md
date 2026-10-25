---
kind: task
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/operations/coroner-extract.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Drain appends one timestamped JSONL event per enqueue, eject and dequeue

coroner 2026-10-16: merge-queue events are not recorded with a time. The drain log is 36 MB since July with mostly untimestamped lines; whole-file greps give 264 eject and 3095 dequeue lines, mostly policy text. Append one JSONL event (PR, head, reason, time) per enqueue, eject and dequeue to the drain state dir; the coroner reads it.

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
