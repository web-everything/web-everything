---
bornAs: xw4t55l
kind: story
size: 2
status: active
scaffoldedBy: "fix-6046"
dateScaffolded: "2026-10-30"
scope: ["we:scripts/conveyor/review-stack-base.mjs", "we:scripts/conveyor/__tests__/review-stack-base.test.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Stack-base tree must merge with main's attributes, not the clone's checkout

stackBaseTree runs git merge-tree with attributes from the calling clone's working tree. In a daemon clone whose checkout predates the we:docs/agent/testing.md merge=union attribute (fix and merge daemon clones today), the bottom PR's head conflicts with main on that file, the tree read fails, and a stacked top is held as stack-base-unresolved (cause tree-unreadable, PR #6046). The review daemon clone, which has the attribute, resolves the same stack to an 8-file own diff. Fix: run merge-tree with --attr-source=<mainBase> so the result depends only on the commits. Live proof: in the fix-daemon clone, merge-tree of f00b1fc with ee8d580 conflicts without the flag and yields tree 460e848 with it, matching the review daemon.

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
