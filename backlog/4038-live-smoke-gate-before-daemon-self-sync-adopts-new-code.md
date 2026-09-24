---
bornAs: xyptg6f
kind: story
size: 5
parent: "3383"
status: resolved
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/bounded-child.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Live smoke gate before daemon self-sync adopts new code

we:scripts/lib/daemon-self-sync.mjs (withSelfSync/selfSyncCheckout) merges origin/main and restarts onto it unconditionally today -- any merged PR goes live with zero live check. A 2026-09-24 lane-pool regression shipped this way and broke every review-daemon session (401s / lane crashes). Add a live smoke gate that runs AFTER the merge, BEFORE onRestart: (a) we:scripts/lane-pool.mjs list --acquirable --no-cache --limit=1 for the WE pool then a real acquire+immediate release of one lane (purpose=smoke, unique session slug); (b) one GitHub read through we:scripts/lib/gh-app-shim.mjs (gh api --method GET repos/<repo>, plus gh pr list --limit 1); (c) one we:scripts/conveyor/reconcile-pass.mjs#runReconcilePass dry-run per configured repo -- all via we:scripts/lib/bounded-child.mjs with a budget. Pass -> restart as today (adopt). Fail -> git reset --hard to the pre-merge HEAD (clone verified clean first), record the rejected origin/main sha so it is not retried until main moves again, log an alert line, stay on old code. Centralize budgets/checks in one list with env overrides, plus a kill-switch env var. Also add a manual-load CLI, we:scripts/lib/daemon-load-overlay.mjs, for early loads onto a given clone+ref: merge, run the SAME smoke gate, roll back on failure -- same code path as the daemon gate, so manual loads are gated too. Must not break the parallel-restart / HEAD-moved-restart logic (PR #2558, we:scripts/lib/daemon-self-sync.mjs#withSelfSync) and must keep its diff separate from the not-yet-merged per-clone lock work (PR #2578, stacked, not merged).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
