---
kind: story
size: 3
parent: "5399"
status: open
blockedBy: ["xdeqs8k"]
scope: ["we:scripts/lib/citation-check.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/operations/codex-worker.mjs", "we:scripts/lib/probation-launcher.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S7: move hard-coded Done when readers to the shared task-agreement reader

Slice S7 of #5399 (ruled 2026-10-08, Fork 3): every code path that hard-codes the `## Done when` heading (the provenance escape in `citation-check`, the Must-cite, TODO-placeholder and scope guards in `check-standards`, the codex worker and the probation launcher) reads it through the shared task-agreement reader instead. The same slice then switches the card skeleton's acceptance heading to `## Acceptance`, because only now do the readers recognize it. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a `citation-check` test shows an unresolved path under `## Acceptance` gets the same provenance escape as one under `## Done when`.
- [A2] **Executable** — check-standards tests show the Must-cite, TODO-placeholder and scope guards treat `## Acceptance` exactly as `## Done when`.
- [A3] **Observable** — no hard-coded `## Done when` string remains in the touched files outside the S1 reader.
- [A4] **Executable** — a scaffold test shows a new story body carries `## Acceptance` with an `[A1]` TODO line and `## Non-goals` with an `[N1]` TODO line, and no `## Done when`; and a check-standards test passes that scaffolded body through the TODO-placeholder guard and the Must-cite check and shows both still see the section (S1 deliberately left the skeleton on `## Done when` until this slice).

## Non-goals

- [N1] Changing what any of these checks enforce, beyond reading the new heading.
- [N2] Rewriting card bodies (S2).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — the skeleton heading switch (A4) lands in the same slice as the reader move (A1, A2), so no card is ever scaffolded with a heading the readers do not yet recognize.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
