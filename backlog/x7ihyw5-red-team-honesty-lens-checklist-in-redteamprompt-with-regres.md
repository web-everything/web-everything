---
kind: story
size: 3
status: open
scope: ["we:skills-src/jury/subject-jury.workflow.js"]
dateOpened: "2026-11-22"
tags: [plateau, design-plan, carried-acceptance]
---

# Red-team honesty-lens checklist in redTeamPrompt, with regression assertions (carried from #2697)

Carried from closed #2697: add a named honesty-lens checklist (internal contradiction, false precision, scale unproven, a11y truth, data-model truth) to redTeamPrompt in we:skills-src/jury/subject-jury.workflow.js, with regression assertions in a new redteam-honesty-lenses test. Must not add a second severity vocabulary (#2950 owns it); data-model truth overlaps #2695. Also tracked on plan step DZ-STUDIO-RATIFY.

## Acceptance

- [A1] **Executable** — running the jury red-team test suite: a test asserts redTeamPrompt names all five honesty checks and fails on main (the prompt names none today), and the existing panel-fanout suite stays green.



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
