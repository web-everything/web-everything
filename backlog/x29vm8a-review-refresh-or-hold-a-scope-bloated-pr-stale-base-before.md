---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/scope-bloat.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Review: refresh or hold a scope-bloated PR (stale base) before reviewing its diff

PR #4361 reached review with a diff of +3277/-96 across 44 files when its own change was about 5 files: the branch carried other lanes' work on a stale base and every review re-read it all. Before dispatching a review, if the PR diff against current main includes files already on main or files far outside its card scope (we:scripts/conveyor/reconcile-core.mjs plan, we:scripts/conveyor/reconcile-pass.mjs enrichment), refresh/rebase it through the existing mechanical refresh path (we:scripts/conveyor/ci-red-recovery-watch.mjs, refresh-onto-main), or hold it with reason scope-bloat and route it to a fixer to rebase, never review the bloated diff. Gate change: needs human review.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/scope-bloat.test.mjs` (fails before: no detector, no `scope-bloat` refusal; passes after).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR file paths and head ref are author-controlled: paths are folded to one line and capped before entering the fixer prompt, and a head ref starting with `-` is refused before any git call.
2. **Truncated reads** — an unreadable or failed diff or card read leaves the PR unannotated (no claim, no hold).
3. **Shared state files** — n/a: the only shared state is the per-head `rebase-onto-main` thread marker, written through the existing comment helper.
4. **Fail closed** — n/a: the detector fails OPEN on purpose (an unreadable diff never holds a PR); a held PR never reads as reviewed, and spent fix rounds refuse it for a person.
5. **Identity scoping** — the refresh attempt is keyed by PR number and head sha, so a new push earns a new attempt.
6. **State over time** — one mechanical refresh per head, remembered in process and on the thread; a moved head is re-assessed.
7. **Who wrote it** — the card id comes from the PR title (author-controlled); it can only weaken the scope signal, and the stale-base signal does not read it.
