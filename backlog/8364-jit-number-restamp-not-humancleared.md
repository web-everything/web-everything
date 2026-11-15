---
bornAs: xs0p47z
kind: story
size: 3
status: open
dateOpened: "2026-11-15"
tags: []
---

# Drain restamp skipped after a JIT-number push when the PR is not humanCleared (PR 6881)

After the drain pushes a JIT-number commit to a review:accepted PR branch, needsAcceptanceRestamp in we:scripts/merge-ai-prs.mjs requires v.humanCleared && !v.reviewHeld, so a plain agent-accepted PR gets no restamp comment and its acceptance stays stale (PR 6881: JIT commit 7e806d75 at 16:07Z, no drain restamp, gate red until a manual restamp at 12:40 ET). Decide whether plain review:accepted PRs may carry across a drain-own JIT-number commit: prove the commit is the drain's own and the tree diff is only the backlog card rename plus id-reference rewrite; humanClearance.mechanicalCarry=refuse must stay for human-cleared PRs absent a ruling. Control: any content change after the reviewed sha stays stale. Related: lane/carry-over-jit-number (gate:refresh after restamp).

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
