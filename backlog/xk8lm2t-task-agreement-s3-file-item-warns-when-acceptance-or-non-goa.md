---
kind: story
size: 2
parent: "5399"
status: open
blockedBy: ["xdeqs8k"]
scope: ["we:scripts/operations/file-item.mjs", "we:scripts/operations/scaffold.mjs", "we:skills-src/file-item/SKILL.md", "we:scripts/operations/__tests__/file-item.test.mjs", "we:scripts/operations/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S3: file-item warns when Acceptance or Non-goals is empty, never refuses

Slice S3 of #5399 (ruled 2026-10-08, Fork 2 = both, asymmetric): file-item and scaffold take optional acceptance and nonGoals inputs that fill the new sections, and the verdict carries a warning when either is empty. Filing never refuses a card for a missing task agreement. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a file-item test shows `acceptance` and `nonGoals` inputs fill `## Acceptance` and `## Non-goals` with `[A#]`/`[N#]` ids.
- [A2] **Executable** — a file-item test shows a card filed with neither input is still written, and the verdict carries a warning naming the empty section.
- [A3] **Observable** — `we:skills-src/file-item/SKILL.md` documents both inputs and says filing never refuses on them.

## Non-goals

- [N1] Refusing a card at filing time (Fork 2 (a)).
- [N2] Any check at prepare or dispatch (S4).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the inputs are author prose written into the card body as text, never passed to a shell.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
