---
bornAs: x99glld
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# stand-down crashes after posting its comment: circular dynamic import never settles

Live on PR 7452 (2026-11-25 13:58Z): we:scripts/conveyor/stand-down.mjs posted its comment, then exited 13 with 'Detected unsettled top-level await' at its dynamic import of we:scripts/conveyor/fix-dispatch-claim.mjs. That module imports we:scripts/conveyor/reconcile-core.mjs, which imports the still-evaluating stand-down entry module. So the dispatch claim is not released and the stood-down label is never added. Want: the CLI finishes both steps; a test runs the real CLI as a child process.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- stand-down-cli` passes on a new test (we:scripts/conveyor/__tests__/stand-down-cli.test.mjs) that runs the real CLI as a child process with a stubbed `gh` and expects exit 0, the claim release and the label write. Today the CLI exits 13.

## Non-goals

- [N1] No change to what the stand-down comment says or to which stops are terminal.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input; the comment body is unchanged.
2. **Truncated reads** — n/a: no new reads.
3. **Shared state files** — claim release stays scoped to the claims minted for the posting session.
4. **Fail closed** — a failed release or label write is reported and never undoes the posted comment.
5. **Identity scoping** — release still needs `--who` and a known `--repo`.
6. **State over time** — a claim left by an earlier crashed run still expires on its own.
7. **Who wrote it** — n/a: no marker reading changes.
