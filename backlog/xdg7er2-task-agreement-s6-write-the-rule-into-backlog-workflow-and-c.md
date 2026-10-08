---
kind: story
size: 3
parent: "5399"
status: open
blockedBy: ["xdeqs8k"]
scope: ["we:docs/agent/backlog-workflow.md", "we:scripts/audit-backlog-health.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S6: write the rule into backlog-workflow and count missing sections in the health audit

Slice S6 of #5399 (ruled 2026-10-08): `we:docs/agent/backlog-workflow.md` gains the rule (every buildable card carries Acceptance and Non-goals with [A#]/[N#] items, checked at prepare, reviewed as a floor), the #2949 composition sentence and the Done when to Acceptance heading change; the backlog health audit reports open stories missing either section. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Observable** — `we:docs/agent/backlog-workflow.md` states the rule (every buildable card carries `## Acceptance` and `## Non-goals` with `[A#]`/`[N#]` items, checked at prepare, reviewed as a floor), the #2949 composition sentence, and that `## Done when` is a legacy alias.
- [A2] **Executable** — the health audit test shows an open story missing either section is counted, and a draft section is counted separately.

## Non-goals

- [N1] Any gate that refuses or holds a card (S4).
- [N2] Rewriting existing cards (S2).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
