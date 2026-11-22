---
kind: story
size: 2
status: open
scope: ["we:.claude/commands/continue.md", "we:.claude/commands/handoff.md"]
dateOpened: "2026-11-22"
tags: [plateau, design-plan, carried-acceptance]
---

# Scan test: continue and handoff commands carry no hard-coded PR or lane state (carried from #3767)

Carried from closed #3767 (done-when 6): a test scans the tracked we:.claude/commands/continue.md and we:.claude/commands/handoff.md and fails on a hard-coded PR number or lane number used as a state claim (today continue names PR 1853 and lane-54, handoff names lane-54); also choose whether a warning comes before a deploy overwrites a hand-edited command. Also tracked on plan step DZ-LINT.

## Acceptance

- [A1] **Executable** — a test scanning we:.claude/commands/continue.md and we:.claude/commands/handoff.md fails on main (they name PR 1853 and lane-54) and passes once the hard-coded state is removed.



## Non-goals

- [N1] No second severity vocabulary and no work outside the named scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
2. **Truncated reads** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
3. **Shared state files** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
4. **Fail closed** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
5. **Identity scoping** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
6. **State over time** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
7. **Who wrote it** — n/a: repo-local prompt, validator or test change over tracked files; the build names any case it meets.
