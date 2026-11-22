---
kind: story
size: 3
status: open
scope: ["we:skills-src/jury/subject-jury.workflow.js"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team honesty-lens checklist in redTeamPrompt, with regression assertions (carried from #2697)

Carried from closed #2697: add a named honesty-lens checklist (internal contradiction, false precision, scale unproven, a11y truth, data-model truth) to redTeamPrompt in we:skills-src/jury/subject-jury.workflow.js, with regression assertions in a new redteam-honesty-lenses test. Must not add a second severity vocabulary (#2950 owns it); data-model truth overlaps #2695. Also tracked on plan step DZ-STUDIO-RATIFY.

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
