---
bornAs: x1ydtnx
kind: story
size: 5
parent: "3383"
status: resolved
scope: ["we:scripts/lane-pool.mjs", "we:scripts/conveyor/lane-pool-health-watch.mjs"]
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
tags: []
---

# Lane pools grow forever and never shrink — add trim + fix acquirable-growth fail-open

we:scripts/lane-pool.mjs acquire/provision --acquirable grows the pool (ACQUIRABLE_PROVISION_HEADROOM) whenever nothing looks free, but nothing ever shrinks it — the real WE pool hit 118 lanes/87GB and we:scripts/lane-pool.mjs list --acquirable now takes ~90s (was ~45s at 83 lanes per PR #2547's own bound), growing with pool size and slowing every acquire. Root cause of the 2026-09-23 burst (lanes 84-114, 31 new lanes in 4 minutes, ~= ACQUIRABLE_PROVISION_HEADROOM=32): an acquirability probe failing/timing out under load was read fail-safe as 0-acquirable, so cmdProvision's --acquirable branch cloned all the way to its headroom looking for enough. Add a trim command to we:scripts/lane-pool.mjs (delete-eligible-lane-dirs down to an env-overridable cap, reusing we:scripts/conveyor/lease-reaper.mjs's classifyReap/reapPlan for dead-lease liveness and PR #2547's bounded aheadIsProvablyPushed for ahead-but-pushed detection, never removing a reserved lane or one with real uncommitted/unpushed work, highest lane numbers first, crash-safe rename-then-delete), wire it into we:scripts/conveyor/lane-pool-health-watch.mjs's periodic pass, and fix cmdProvision's --acquirable branch so a failed/timed-out remote-reachability probe stops growth and alerts instead of quietly cloning to the 32-lane headroom, plus a small per-call cap on brand-new lane clones.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
