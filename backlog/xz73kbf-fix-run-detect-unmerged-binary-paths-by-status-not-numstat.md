---
kind: story
size: 1
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-10-12"
tags: []
---

# fix-run: detect unmerged binary paths by status, not numstat

From the PR #4984 review finding (operator ruled card, 2026-10-12): we:scripts/operations/fix-run.mjs (~line 395) detects binary merge conflicts by looking for '-\t-\t' rows in git diff --numstat, but git prints '0\t0\t<path>' for unmerged binary paths, so binary UU conflicts are never caught and the launcher could commit an unresolved binary conflict. Detect unmerged paths with git diff --name-only --diff-filter=U (or git ls-files -u) and refuse/abort the merge with a recorded reason; add a real-git test with a conflicted binary file.

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
