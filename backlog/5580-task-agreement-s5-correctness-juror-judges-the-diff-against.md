---
bornAs: x6f9vwo
kind: story
size: 5
parent: "5399"
status: open
blockedBy: ["5578"]
scope: ["we:scripts/lib/review-core.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/converge-cli.mjs", "we:scripts/operations/review-prep.mjs", "we:skills-src/converge/SKILL.md", "we:scripts/lib/__tests__/review-core.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/operations/__tests__/review-prep.test.mjs", "we:scripts/__tests__/converge-cli.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S5: correctness juror judges the diff against the card Acceptance and Non-goals

Slice S5 of #5399 (ruled 2026-10-08, Forks 4b and 5b): the review read looks up the PR card on main (PR to card ids to sections) and fences its [A#]/[N#] lines into the correctness juror goal only, in review-pr and converge. The list is a floor, not a ceiling; a build PR that weakens its own card criteria is flagged and judged against the main copy. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a `review-pr` mandate test shows a PR whose card has `[A#]` lines carries them, with ids, inside the correctness juror's fenced goal block and in no other lens's; a build PR with no resolvable card id, or whose branch or title names a different (easier) card than the one it edits, is marked `unverified against task agreement` in the review output instead of silently keeping the plain title-only goal; the mismatch case is a `review-pr` mandate test with an unresolvable lane branch and a branch that names a sibling card.
- [A2] **Executable** — a test shows a build PR that edits its own card's `## Acceptance` or `## Non-goals` is flagged, and the juror reads the `main` copy; a prepare PR is exempt. A prepare PR is classified by its diff alone: every changed file is a `backlog/*.md` card file, and a PR that changes any other file is not one. The PR title and branch name are never read for this, because the author controls them. A PR that changes a card's criteria and any non-card file (for example under `scripts/`) is a build PR, even when its title or branch says `prepare(...)`. A `review-pr` mandate test covers that mixed PR: a prepare-titled PR on a `lane/prepare-*` branch that also changes a `scripts/` file is flagged and judged against the `main` copy.
- [A3] **Observable** — correctness findings cite the `A#`/`N#` id they judge; a missing Acceptance line or a built Non-goal blocks, while other findings keep the existing three-question disposition.
- [A4] **Executable** — a `review-pr` mandate test shows an unreadable or missing card gives "no card" with a logged reason, the title-only goal and the `unverified against task agreement` mark, never an empty list read as agreed; and a PR that names its card by hash (`bornAs`) and one that names it by NNN resolve to the same card and the same lines. A card line holding a fence marker, a heading or an instruction-shaped sentence stays inside the fenced goal block as text.

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
7. **Who wrote it** — the prepare-PR exemption is decided from the changed-file list, never from the title or branch the author chose; a mixed card-and-code PR is a build PR (tested by [A2]).
