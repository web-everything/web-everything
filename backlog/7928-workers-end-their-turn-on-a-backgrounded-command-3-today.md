---
bornAs: xu50hhf
kind: story
size: 2
status: open
scope: ["we:CLAUDE.md", "we:worker-brief.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Workers end their turn on a backgrounded command (3× today

MED priority hint. - (2026-11-01 12:08 ET) Workers end their turn on a backgrounded command (3× today: perf10, perf5, perf2) despite the pinned we:CLAUDE.md rule. Fix: a Stop hook for worker subagents that refuses to end while a run_in_background Bash or Monitor it started is still live (names the task), plus we:worker-brief.mjs states it in the rules block. FILED → appended to 3879 (PR #6192, 2026-11-01)

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
