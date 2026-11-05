---
bornAs: xbtxfej
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# codex-direct-task runs over the 600 s Bash limit get auto-backgrounded, and the worker then cannot wait (every

HIGH priority hint. - [HIGH] codex-direct-task runs over the 600 s Bash limit get auto-backgrounded, and the worker then cannot wait (every wait is denied), so it ends its turn mid-task. Seen 3x on 10-28: the fix-top m3 merge, the auto main-merge verify, and #6027. Fix: give codex-direct-task a `--detach` mode plus a bounded `codex-direct-task check --wait=540000` command (like verify-lane check), and teach worker-brief to use it (20:29 ET).

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
