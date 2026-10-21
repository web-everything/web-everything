---
bornAs: xd1sfms
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-09-25"
tags: []
---

# CI job timeouts + hung-run cancel/rerun recovery

LIVE 2026-09-25: PR #2636's `test-shard (1)` job (run 36161558017) sat `in_progress` 3h+ while its 3 sibling shards finished in minutes. `we:.github/workflows/ci.yml` sets no `timeout-minutes` on any job, so GitHub's 360-min default applies -- a single hung shard blocks a PR for 6 hours. The fix daemon logs `nothing-owed` for #2636: `we:scripts/conveyor/reconcile-core.mjs` and `we:scripts/conveyor/main-red-recovery.mjs` only ever reason about a required check that already FAILED, never one stuck IN_PROGRESS/QUEUED far past normal. Scope: (1) add data-driven `timeout-minutes` to every `we:.github/workflows/ci.yml` job, sized off real p95 durations from recent successful runs (test-shard p95~250s, test p95~380s, smoke p95~146s; visual/test-selection-measure are off by default today, sized conservatively). (2) a new hung-run pure planner beside `we:scripts/conveyor/main-red-recovery.mjs` plus an IO sweep beside `we:scripts/conveyor/ci-red-recovery-watch.mjs`: a PR whose required check has sat in_progress/queued past a configurable threshold (default 45min) counts HUNG; cancel the run (`gh run cancel`) and rerun it, capped at N attempts per head sha, escalating to ci-heal past the cap. (3) wire the sweep into an ALREADY-RUNNING daemon's own tick -- `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs` -- since `we:scripts/conveyor/ci-red-recovery-watch.mjs` is registered in `we:skills-src/conveyor/daemon-manifest.mjs` but has no installed launchd job today, so nothing actually calls it live. (4) log every hung-run action with its reason. (5) tests; note the soak-harness hung-CI scenario as follow-up if that harness doesn't exist yet on main.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
