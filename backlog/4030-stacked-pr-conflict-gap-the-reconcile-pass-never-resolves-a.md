---
bornAs: xqzxroq
kind: story
size: 5
parent: "3383"
status: resolved
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/conflict-fix-mark.mjs", "we:scripts/conveyor/open-pr-fetch.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/parked-pr-conflict-watch.test.mjs", "we:scripts/conveyor/__tests__/conflict-fix-mark.test.mjs", "we:scripts/conveyor/__tests__/open-pr-fetch.test.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Stacked-PR conflict gap — the reconcile pass never resolves a PR whose base isn't main

epic #3383. Live case: chalbert/web-everything#2578 (base lane/3681-ratify-daemon-lifecycle, stacked on PR #2549) carries review:accepted + merge-status:conflicting after a fixer pushed to its base. we:scripts/conveyor/reconcile-core.mjs#planReconcile refuses it owed-elsewhere ('the branch needs a rebase before it can merge'), but the drain never lands a PR whose base is not main (#poc-branch-declared-delivery-mode clause 5), and we:scripts/conveyor/parked-pr-conflict-watch.mjs sweep --dry-run reports nothing for it either (deferred into the drain's own queued-conflict grace window, which never fires for a non-default base) — a genuine stacked-PR gap no daemon closes. Add a STACKED-BASE CONFLICT dispatch branch to planReconcile: a conflicted-phase PR whose baseRefName differs from defaultBranch (default main) is dispatched a mechanical fix (mode stacked-rebase) against its own base instead, bound on the SAME CONFLICT_FIX_ROUND_CAP/marker we:scripts/conveyor/conflict-fix-round-count.mjs already added (#4027/PR #2579) rather than a new counter. we:scripts/conveyor/parked-pr-conflict-watch.mjs's queued-conflict grace path defers to this branch for a stacked base instead of bouncing via postFinding (which strips review:accepted). New we:scripts/conveyor/conflict-fix-mark.mjs posts the shared marker with NO label swap, since this population was never bounced. we:skills-src/conveyor/fix-agent-brief.md gets a STACKED-BASE MODE section instructing the fixer to resolve against the PR's own baseRefName, read live via gh (never assume main), plus generalizes the existing conflict wording to check the real base. The normal retarget-to-main path (GitHub flips baseRefName to main once the stacked base merges and is deleted) needs no special handling — it falls straight through to the pre-existing owed-elsewhere/conflict-fix behavior unchanged.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
