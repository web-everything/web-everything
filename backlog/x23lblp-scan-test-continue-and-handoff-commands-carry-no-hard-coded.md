---
kind: story
size: 2
status: open
scope: ["we:.claude/commands/continue.md", "we:.claude/commands/handoff.md"]
dateOpened: "2026-11-22"
tags: []
---

# Scan test: continue and handoff commands carry no hard-coded PR or lane state (carried from #3767)

Carried from closed #3767 (done-when 6): a test scans the tracked we:.claude/commands/continue.md and we:.claude/commands/handoff.md and fails on a hard-coded PR number or lane number used as a state claim (today continue names PR 1853 and lane-54, handoff names lane-54); also choose whether a warning comes before a deploy overwrites a hand-edited command. Also tracked on plan step DZ-LINT.

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
