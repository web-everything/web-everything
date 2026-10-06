// Tmp-sweep defaults, kept import-free so the pure health-watch core (and read-only modules that import it)
// never reach the sweep's fs/child_process code. Every key is overridable in the health config.json.
export const TMP_SWEEP_DEFAULTS = Object.freeze({
  tmpSweepEnabled: true,
  tmpSweepEveryMs: 24 * 60 * 60 * 1000,
  tmpSweepOlderThanMs: 24 * 60 * 60 * 1000,
  tmpSweepBatchSize: 200,
  tmpSweepPauseMs: 50,
  tmpSweepMaxDeletesPerRun: 20000,
  tmpSweepTimeBudgetMs: 15000, // deletion + batch pauses only
  tmpSweepScanBudgetMs: 30000, // total walk wall time; a capped run resumes next tick
});
