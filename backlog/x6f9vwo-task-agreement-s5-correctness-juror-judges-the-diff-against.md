---
kind: story
size: 5
parent: "5399"
status: open
blockedBy: ["xdeqs8k"]
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/converge-cli.mjs", "we:scripts/operations/review-prep.mjs", "we:skills-src/converge/SKILL.md"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S5: correctness juror judges the diff against the card Acceptance and Non-goals

Slice S5 of #5399 (ruled 2026-10-08, Forks 4b and 5b): the review read looks up the PR card on main (PR to card ids to sections) and fences its [A#]/[N#] lines into the correctness juror goal only, in review-pr and converge. The list is a floor, not a ceiling; a build PR that weakens its own card criteria is flagged and judged against the main copy. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a `review-pr` mandate test shows a PR whose card has `[A#]` lines carries them, with ids, inside the correctness juror's fenced goal block and in no other lens's; a PR with no resolvable card keeps the title-only goal.
- [A2] **Executable** — a test shows a build PR that edits its own card's `## Acceptance` or `## Non-goals` is flagged, and the juror reads the `main` copy; a prepare PR is exempt.
- [A3] **Observable** — correctness findings cite the `A#`/`N#` id they judge; a missing Acceptance line or a built Non-goal blocks, while other findings keep the existing three-question disposition.

## Non-goals

- [N1] A new dedicated review lens (Fork 4 (a)).
- [N2] Treating the list as a ceiling (Fork 5 (a)).
- [N3] Running tier-1 criteria automatically at review.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card lines reach the juror only inside the fenced goal block, never as instructions.
2. **Truncated reads** — an unreadable or missing card is "no card" with a logged reason, never "empty list = agreed".
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
5. **Identity scoping** — hash (`bornAs`) and NNN spellings of a card resolve to the same card.
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
