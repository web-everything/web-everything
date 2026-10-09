---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stand-down-answer-core.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# A close-superseded operator answer resolves every earlier stand-down on the PR

Live #4522: two stand-downs (fixer 04:36Z, supersede-watch 05:38Z); the close-superseded answer named only the latest, so the earlier one kept REFUSAL 1 (stood-down) firing before the disposition branch and the PR never closed. Fix: a later answer carrying a disposition supersedes every earlier stand-down (stand-down-answer-core isOperatorAnswerStandDownSuperseded); a stand-down after the answer and a live fix claim still hold.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/stand-down-disposition.test.mjs`: the `#4522` block fails on main (the live thread is refused `stood-down`) and passes after (planned `close-superseded`).
- [A2] **Must refuse on error** — an answer that does not parse, names no earlier terminal comment, or comes from a login outside the operator/automation allow-list widens nothing; the earlier stand-down stays terminal (tested).
- [A3] **Must keep every other input cautious** — only an answer carrying a DISPOSITION widens; an ordinary ruling still resolves only the stand-down it names, and a stand-down posted AFTER the answer stays terminal (tested). The change touches comment-thread reading only; no docs, config or data paths are involved.

Hint: the endpoint hint does not apply — no receive or write endpoint is added.

## Non-goals

- [N1] Does not change the CLI (`we:scripts/conveyor/stand-down-answer.mjs`) or which stand-down it targets, and does not change the close executor (`we:scripts/operations/promote-draft-pr-dispatch.mjs`) or its card-on-main refusal.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the answer's power comes only from `parseOperatorAnswer`, which requires a trusted posting login and a byte-identical rebuilt body; forged markers parse to null (tested).
2. **Truncated reads** — n/a: a missing comment can only drop an answer, which leaves the stand-down terminal (fail closed).
3. **Shared state files** — n/a: pure reader over the PR's comment list.
4. **Fail closed** — a non-array or unparseable thread returns false (stand-down stays terminal).
5. **Identity scoping** — the answer must name a terminal comment that precedes it on THIS PR's thread.
6. **State over time** — only stand-downs BEFORE the answer are resolved; a later stand-down is a new question and stays terminal; a live fix claim still blocks the close.
7. **Who wrote it** — operator/automation logins only (`OPERATOR_LOGINS`/`AUTOMATION_LOGINS` via `parseOperatorAnswer`).
