---
kind: story
size: 2
parent: "5399"
status: open
scope: ["we:scripts/backlog/task-agreement.mjs", "we:scripts/backlog/__tests__/task-agreement.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S1 follow-up: the landed reader's draft marker becomes a visible line, not an HTML comment

What is left of slice S1 of #5399 (ruled 2026-10-08, Fork 3). The rest of S1 is already built on `main`: commit e0da013e4 (PR 4484, card xj67z1d) landed `readTaskAgreement`, the `## Acceptance` / legacy `## Done when` / `## Non-goals` reading, the numbered `[A#]` / `[N#]` ids, the fail-closed problems list and the setting file `we:scripts/lib/task-agreement-policy.json`; commit cecdc6a92 (S7) moved the other readers onto it and switched the card skeleton to `## Acceptance` plus `## Non-goals`. This card does not rebuild any of that.

One thing landed wrong. The reader's draft marker is the HTML comment `<!-- agreement: draft -->` (`AGREEMENT_DRAFT_MARKER`), but the epic and S2, S3, S4 all rule the marker is a visible line, `Draft: model-written, not yet confirmed.`, as the first non-blank line under the heading. `prepareCardStatus` strips `<!--…-->` comments before it reads sections, so a comment marker is invisible to the S4 gate and fails open: a draft section would read as agreed. This card moves the marker to the visible line. S2 (the refresh writes the line) and S4 (the gate holds a draft) both depend on it.

Measured on `main` @ e0da013e4 (the reader copied out of that tree and run on a card with the ruled marker):

```
visible line (ruled format) draft = false
comment marker, direct read draft = true
comment marker after comment stripping (prepareCardStatus path) draft = false
```

## Acceptance

- [A1] **Executable** — `node --test we:scripts/backlog/__tests__/task-agreement.test.mjs` passes: `readTaskAgreement` reports `draft: true` when the visible line `Draft: model-written, not yet confirmed.` is the first non-blank line under `## Acceptance` or under `## Non-goals`, and that line is not counted as an item (fails before: the reader only knows the comment, so the visible line reads `draft: false`).
- [A2] **Executable** — the same test file passes a full card (frontmatter and HTML comments included) through the real `prepareCardStatus` comment-stripping path and asserts the draft flag is still reported, and asserts a card marked with the old `<!-- agreement: draft -->` comment is NOT read as draft, so the format cannot drift back to a comment unnoticed (fails before: the comment reads as draft on a direct read and disappears after stripping).
- [A3] **Observable** — `AGREEMENT_DRAFT_MARKER` is the visible line, the test pins its exact text, and `git grep -n "agreement: draft" -- we:scripts we:skills-src` finds only the A2 negative case in `we:scripts/backlog/__tests__/task-agreement.test.mjs`. The grep is scoped to code paths on purpose: card text under `we:backlog/` (this card and #5399 explain the old comment marker) and `we:docs/` may name it, and those explanatory matches are allowed.

## Non-goals

- [N1] Rebuilding the reader, the skeleton or the setting file, which are on `main` (e0da013e4, cecdc6a92).
- [N2] Changing the setting's shape (`mode`, `advise | enforce`) or any gate that reads it (S3, S4).
- [N3] Writing the marker into any card (S2) or confirming a draft section (S4).
- [N4] Moving the other `## Done when` readers (done by S7 on `main`).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the reader parses card text into data and never executes it.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — the marker survives comment stripping (A2), so a draft section never reads as agreed on the gate's read path. A marker line inside a code fence or above the heading is still not read as the section's marker, as `main` already tests.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — no card carries the old comment marker: nothing writes it before S2, and A3 checks the code paths for it (the explanatory text in card bodies is allowed). Dropping it therefore turns no draft section into an agreed one.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
