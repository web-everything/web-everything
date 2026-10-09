---
bornAs: xl5oele
kind: story
size: 3
status: open
scope: ["we:scripts/operations/free-scope-io.mjs", "we:scripts/operations/__tests__/free-scope.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# free-scope: compute open-PR file sets from git against current main, not gh's stale PR files list

Live 2026-10-08 ~18:45 ET, scoped-rereview pre-push recheck: free-scope reported we:scripts/lib/jury-core.mjs, we:scripts/operations/review-pr.mjs and we:scripts/lib/verdict-ledger.mjs OCCUPIED by PRs #4502, #4508, #4512, and UNKNOWN because PR #4461 lists 100 files (the gh cap). All false: after the drain merged main into those lane branches, gh pr list --json files still diffs against a stale base (baseRefOid dc96f883), so main's own changes (#4441, #4484) show as the PR's. git diff --stat origin/main...origin/lane/<branch> on the same files is empty for all three. Fix: free-scope-io derives each open PR's touched files from git (fetch the head ref, three-dot diff against the current base), falling back to gh files only when git cannot resolve the ref; the gh 100-file cap then stops forcing UNKNOWN. Proof: the same recheck on a lane after a drain merge reports FREE, and a real overlap still reports OCCUPIED.

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
