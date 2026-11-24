## Constellation conveyor probes

Inject `exec` and `fetchOpenPrs` into `makeCliMechanicalPasses` to inspect each repo's argv
and snapshot lifetime without spawning workers. Review briefs select the checkout with
`--repo` on the pool `acquire`; release stays `--all-pools --session=<slug>` (it sweeps every pool).
The fix and review refusal writers preserve each other's actions in `unsupported-repo.json`.
CI history keeps WE's filename and adds the constellation key for sibling repos, including
when `CONVEYOR_CI_QUEUE_FILE` supplies the base path. Subprocess tests that use fake `gh`
still acquire the throttle lock; set `LANE_POOL_ROOT` to a temporary directory in a sandbox.

Daemon simulator worlds must override `WE_GH_THROTTLE_LOCK_ROOT` under their own temporary
root. Vitest's per-file override takes precedence over `LANE_POOL_ROOT` and otherwise shares
budget windows across worlds. A world that advances its clock can leave future-dated spend
that makes a later world wait; sibling daemons within one world should share its throttle.

