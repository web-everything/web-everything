---
bornAs: x75vli4
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/prevention-filer.mjs", "we:scripts/conveyor/__tests__/prevention-filer.test.mjs", "we:scripts/settings/prevention-filer.json"]
dateOpened: "2026-10-17"
tags: []
---

# The prevention filer batches its standards rules so its PRs do not collide

Operator "Yes go", 2026-10-17. Live: around 23:00Z the approval-prevention filer opened about 8 PRs (5515, 5524, 5527, 5529, 5532, 5533, 5534, 5535), each adding a check:standards rule to the same file. 4 went DIRTY (conflict) against each other. Fix: prevention cards filed within a window (setting, default 30 min) that target the same rule file go into ONE PR, or stack. The filer checks open prevention PRs on the same file before opening a new one. Setting with its source logged. [A1] Executable: node --test we:scripts/conveyor/__tests__/prevention-filer.test.mjs, where 3 approvals in one window give 1 PR and a different file gives a separate PR.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
