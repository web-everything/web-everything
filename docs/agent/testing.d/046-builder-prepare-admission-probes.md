## Builder prepare admission probes

The builder's `cliPlanTick` and `cliDispatch` must pass the same
`WE_MAX_CONCURRENT_LANES` override to their tick subprocesses. Otherwise the
second read can lose a planned prepare to capacity and report the original
build's `needs-prepare` hold. Probe both through `planTick`, `readTick`, and
`shapeDispatchRead` without applying dispatch effects. A refused prepare must
release its claim and discard its proposed guard so the next tick can retry;
only a claimed prepare guard's TTL retirement consumes the prepare retry budget.

