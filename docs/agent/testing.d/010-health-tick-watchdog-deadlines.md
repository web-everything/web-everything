## Health tick watchdog deadlines

`scripts/conveyor/__tests__/health-watch.test.mjs` keeps the real child-process kill probe and uses an
injected child with virtual time to cover production-sized deadlines without waiting minutes. Inject load
readings through `resolveTickWatchdogLimit.readLoad`; do not depend on the host's current load.
The deadline is `min(tickKillCeilingMs, tickBudgetMs * 3 * clamp(load1 / cores, 1, tickKillLoadScaleMax))`.
Defaults are a 60000ms budget, maximum scale 3 and absolute ceiling 540000ms. Policy
`healthWatchTickWatchdog` resolves standard → platform → flat health-dir `config.json` keys → environment
(`WE_HEALTH_TICK_KILL_LOAD_SCALE_MAX`, `WE_HEALTH_TICK_KILL_CEILING_MS`). Invalid settings fall back to
their standard values with provenance logged; invalid/unreadable load uses scale 1. Keep named cases for
healthy 174s completion under load, the idle 180s deadline, exact scaled-limit SIGKILL, actual-limit
`overrun.json` persistence, invalid knobs and oversized values capped by the absolute ceiling.

