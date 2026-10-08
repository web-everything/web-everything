---
kind: story
size: 5
parent: "5112"
status: active
scaffoldedBy: "main-red-soak"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/conveyor/health-smells/main-ci-red.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells-notify-list.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# A red main gets an owner: main-ci-red health smell plus a main ci-heal dispatch

LIVE 2026-10-08: main CI was red from 17:04Z to past 22:35Z (over 5.5 hours, about 25 failed runs on soak-shard / daemon-soak, build-dispatch-orphan-adopt broken by PR #4361) and nothing owned it; a human noticed. What exists only reacts to PRs: we:scripts/conveyor/main-red-recovery.mjs computes main red windows (computeMainRedWindows, isMainCurrentlyRed) so red PRs wait for main and ci-red-recovery-watch refreshes them after main recovers; the pre-existing-red-on-main smell sees only local lane verify markers, never CI-only jobs like soak shards; #5118 (halt and signal) and #5001 (culprit finding) are open but neither assigns a fixer. Missing: (1) a pure health smell main-ci-red (probe: main CI runs via the existing defaultReadMainRuns in we:scripts/conveyor/reconcile-pass.mjs) that opens after main stays red past a declared threshold (setting, default 15 min) and names the failing job, test and first red SHA; listed in NOTIFY_EVEN_IN_SHADOW so it alerts while health-watch runs in shadow mode; replay fixture from the 2026-10-08 window. (2) a main ci-heal dispatch: when the smell is open and no open PR claims to fix main, dispatch ONE ci-heal agent (reuse dispatchCiHeal in we:scripts/operations/ci-heal-pr-dispatch.mjs, new target kind main) with the failing log excerpt and the merged-PR range since the last green run, deduped per first red SHA, budgeted, and recorded so the smell shows the owner. Never weakens merge-gate guards. Done when: replaying the 2026-10-08 runs opens the smell within the threshold and plans exactly one main ci-heal dispatch; a live red main shows the episode and the dispatched owner in the health-watch log.

## Done when

1. **Executable** — a replay test over the 2026-10-08 main CI runs (last green 26b439b79 at 16:55Z, red from 17:04Z) opens `main-ci-red` once the threshold passes and plans exactly one main ci-heal dispatch for the first red SHA. It fails before this lands and passes after.
2. **Live** — the next real red main shows the open episode and the dispatched owner in the health-watch log, with before/after evidence.

## Edge cases this change must handle

1. **Untrusted text** — failing-log excerpts go into the agent brief as quoted data, never as instructions.
2. **Truncated reads** — an unreadable or rate-limited main-runs read is `unknown`. It never opens or closes the smell and never dispatches.
3. **Shared state files** — the dispatch is deduped per first red SHA through the existing claim and budget stores, so two ticks never send two fixers.
