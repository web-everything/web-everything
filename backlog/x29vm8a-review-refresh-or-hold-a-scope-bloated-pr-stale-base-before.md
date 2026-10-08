---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/review-dispatch.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Review: refresh or hold a scope-bloated PR (stale base) before reviewing its diff

PR #4361 reached review with a diff of +3277/-96 across 44 files when its own change was about 5 files: the branch carried other lanes' work on a stale base and every review re-read it all. Before dispatching a review, if the PR diff against current main includes files already on main or files far outside its card scope (we:scripts/conveyor/reconcile-core.mjs plan, we:scripts/conveyor/reconcile-pass.mjs enrichment), refresh/rebase it through the existing mechanical refresh path (we:scripts/conveyor/ci-red-recovery-watch.mjs, refresh-onto-main), or hold it with reason scope-bloat and route it to a fixer to rebase, never review the bloated diff. Gate change: needs human review.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
