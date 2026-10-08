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

Slice S1 of #5399 (ruled 2026-10-08, Fork 3): one pure reader, `readTaskAgreement`, for `## Acceptance` (legacy alias `## Done when`) and `## Non-goals`; the card skeleton gains a `## Non-goals` section next to the existing `## Done when`; and the advise/enforce setting. The skeleton keeps emitting `## Done when` until S7 moves the hard-coded readers, so a card filed between S1 and S7 never loses the provenance escape, the Must-cite check or the TODO-placeholder guard. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — `node --test we:scripts/backlog/__tests__/task-agreement.test.mjs` passes: `readTaskAgreement` reads `## Acceptance` and its legacy alias `## Done when`, reads `## Non-goals`, returns each `[A#]`/`[N#]` id with its line, drops TODO lines, treats `n/a: <why>` as answered, and reports a draft marker (fails before: the module does not exist).
- [A2] **Executable** — a scaffold test shows a new story body still carries its `## Done when` TODO line and now also carries `## Non-goals` with an `[N1]` TODO line, and no `## Acceptance` (the heading switch is S7's).
- [A5] **Executable** — a scaffold test passes a newly scaffolded story body through the existing TODO-placeholder guard and the Must-cite check and shows both still see its `## Done when` section (the TODO line is still flagged; a Must is still cited by number), so the S1-to-S7 window loses no check.
- [A3] **Observable** — `we:scripts/lib/task-agreement-policy.json` holds `taskAgreementPolicy: "advise"`, and its validator rejects any value outside `off | advise | enforce`.
- [A4] **Executable** — the same test file shows an unparseable section (a malformed id, an unclosed fence, a heading with no body) reads as empty and not agreed, never as agreed.

## Non-goals

- [N1] Any gate or warning that reads the setting (S3, S4).
- [N2] Moving the existing hard-coded `## Done when` readers to the new module (S7).
- [N3] Rewriting existing cards (S2).
- [N4] Switching the scaffold's acceptance heading from `## Done when` to `## Acceptance`. It waits for S7, which moves the readers that key on the old heading.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the reader parses card text into data and never executes it.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — an unparseable section reads as empty (not agreed), never as agreed.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — the window between S1 and S7: the skeleton keeps `## Done when` (A2) and A5 proves the existing guards still see it, so a card filed in the window loses no check.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
