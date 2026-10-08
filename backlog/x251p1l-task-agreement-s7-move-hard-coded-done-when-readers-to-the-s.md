---
kind: story
size: 3
parent: "5399"
status: open
blockedBy: ["xdeqs8k"]
scope: ["we:scripts/lib/citation-check.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/operations/codex-worker.mjs", "we:scripts/lib/probation-launcher.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S7: move hard-coded Done when readers to the shared task-agreement reader

Slice S7 of #5399 (ruled 2026-10-08, Fork 3): every code path that hard-codes ` Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a `citation-check` test shows an unresolved path under `## Acceptance` gets the same provenance escape as one under `## Done when`.
- [A2] **Executable** — check-standards tests show the Must-cite, TODO-placeholder and scope guards treat `## Acceptance` exactly as `## Done when`.
- [A3] **Observable** — no hard-coded `## Done when` string remains in the touched files outside the S1 reader.

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
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
