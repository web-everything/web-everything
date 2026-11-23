---
bornAs: x7ihyw5
kind: story
size: 3
status: open
scope: ["we:skills-src/jury/subject-jury.workflow.js", "we:skills-src/jury/__tests__/redteam-honesty-lenses.test.mjs", "we:skills-src/jury/SKILL.md"]
dateOpened: "2026-11-22"
tags: [plateau, design-plan, carried-acceptance]
---

# Red-team honesty-lens checklist in redTeamPrompt, with regression assertions (carried from #2697)

Carried from closed #2697: add a named honesty-lens checklist (internal contradiction, false precision, scale unproven, a11y truth, data-model truth) to redTeamPrompt in we:skills-src/jury/subject-jury.workflow.js, with regression assertions in a new redteam-honesty-lenses test. Must not add a second severity vocabulary (#2950 owns it); data-model truth overlaps #2695. Also tracked on plan step DZ-STUDIO-RATIFY.

## Acceptance

- [A1] **Executable** — running the jury red-team test suite: a test asserts redTeamPrompt names all five honesty checks and fails on main (the prompt names none today), and the existing panel-fanout suite stays green.
- [A3] The five checks are added in addition to the existing generic adversarial hunt, not instead of it: the existing generic adversarial hunt stays in redTeamPrompt, and a test asserts it is present. The test calls redTeamPrompt() with sample inputs and asserts on the returned prompt text, so comments or unused strings in the source cannot satisfy it: both the five lens names and the generic hunt text must appear in the returned prompt. A finding may self-tag its free-text `category` with a lens name; no schema edit.
- [A4] we:skills-src/jury/SKILL.md's #2707 red-team section names the five-lens checklist and cites #2697 and #2695 (data-model truth is a by-eye check here; #2695 is the automated deeper version). The scoped jury suites (skills-src/jury and the jury-core tests) are green and npm run check:standards reports 0 errors.
- [A2] RED_TEAM_SCHEMA, redTeamRequired, foldRedTeamVerdict and DISPOSITIONS stay unchanged (fail-closed invariants), pinned by tests that fail if any of them changes.



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
