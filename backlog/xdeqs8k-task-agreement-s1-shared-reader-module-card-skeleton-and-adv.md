---
kind: story
size: 3
parent: "5399"
status: open
scope: ["we:scripts/backlog/task-agreement.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/lib/task-agreement-policy.json", "we:scripts/backlog/__tests__/task-agreement.test.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S1: shared reader module, card skeleton and advise/enforce setting

Slice S1 of #5399 (ruled 2026-10-08, Fork 3): one pure reader, readTaskAgreement, for `## Acceptance` (legacy alias ` Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — `node --test we:scripts/backlog/__tests__/task-agreement.test.mjs` passes: `readTaskAgreement` reads `## Acceptance` and its legacy alias `## Done when`, reads `## Non-goals`, returns each `[A#]`/`[N#]` id with its line, drops TODO lines, treats `n/a: <why>` as answered, and reports a draft marker (fails before: the module does not exist).
- [A2] **Executable** — a scaffold test shows a new story body carries `## Acceptance` with an `[A1]` TODO line and `## Non-goals` with an `[N1]` TODO line, and no `## Done when`.
- [A3] **Observable** — `we:scripts/lib/task-agreement-policy.json` holds `taskAgreementPolicy: "advise"`, and its validator rejects any value outside `off | advise | enforce`.

## Non-goals

- [N1] Any gate or warning that reads the setting (S3, S4).
- [N2] Moving the existing hard-coded `## Done when` readers to the new module (S7).
- [N3] Rewriting existing cards (S2).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the reader parses card text into data and never executes it.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — an unparseable section reads as empty (not agreed), never as agreed.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
