---
bornAs: x27r9a2
kind: story
size: 3
status: open
scope: ["we:scripts/lib/verdict-ledger-io.mjs", "we:scripts/lib/git-transport-branch.mjs", "we:scripts/__tests__/apply-review-request.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Push-ref guard: the applier workflow's push path may write only refs/heads/ops/review-requests, never forced

PR #4318 gave the applier workflow `contents: write`. Operator decision 2026-10-08: keep it, and harden it. The only push path is we:scripts/lib/verdict-ledger-io.mjs over we:scripts/lib/git-transport-branch.mjs. It now refuses, before any git call, every ref except `refs/heads/ops/review-requests`, always pushes the full ref, and the push is never forced. The workflow file itself is pinned to have no pushing step.

## Done when

1. **Executable** - the suite we:scripts/lib/__tests__/verdict-ledger-io.test.mjs (push-ref guard block) and we:scripts/__tests__/apply-review-request.test.mjs fail on the old code (12 red) and pass after.

Must: on error (a wrong, forced, refspec-shaped or caller-loosened ref) refuse and run no git command at all. Must: the guard treats every input kind cautiously, a branch name from config or data gets the same refusal as one from code.

## Edge cases this change must handle

1. **Untrusted text** - the branch name is validated against ref-syntax characters (`:`, `+`, leading `-`, whitespace, `..`, `refs/` prefix) before it reaches a git argv.
2. **Truncated reads** - n/a: the guard reads no files.
3. **Shared state files** - n/a: the guard is a pure check ahead of the existing retry loop.
4. **Fail closed** - a refused ref throws before fetch, checkout or write; a caller cannot loosen it through the passed-through seams.
5. **Identity scoping** - n/a: ref-based, not identity-based.
6. **State over time** - n/a: the allowed ref is a constant, not remembered state.
7. **Who wrote it** - applies to every caller of the ledger append, human or agent.
