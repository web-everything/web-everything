---
bornAs: xd1tvd0
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/scope-bloat.mjs", "we:scripts/conveyor/net-scope.mjs", "we:scripts/conveyor/net-scope-settings.json", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/net-scope.test.mjs", "we:scripts/conveyor/__tests__/fixtures/net-scope/"]
dateOpened: "2026-10-09"
tags: []
---

# Scope-bloat/scope-overlap deadlock: compute PR scope from the net diff vs main, exempt stale-base rebases from scope-overlap

Live 2026-10-09 ~04:00Z: 7 PRs (#4538 #4536 #4525 #4512 #4479 #4453 #4439) deadlocked 80+ min. Review daemon refused review as scope-bloat (e.g. 98 of 100 files already on main) because it judged GitHub's stale-base, 100-capped PR file list; fix daemon refused the owed rebase fix as scope-overlap on the same inflated lists. Net diffs vs merge-base are 5-17 files with zero already-on-main. Fix: scope from git net diff (reuse #4525 readNetFileSets), stale-base rebase fix exempt from scope-overlap (one per head), declared settings, replay fixtures.

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
