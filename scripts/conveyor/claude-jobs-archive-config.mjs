// Import-free defaults leaf for the pure health-watch core. Overridable in health config.json.
export const CLAUDE_JOBS_ARCHIVE_DEFAULTS = Object.freeze({
  claudeJobsArchiveEnabled: true,
  claudeJobsArchiveEveryMs: 24 * 60 * 60 * 1000,
  claudeJobsArchiveOlderThanMs: 2 * 24 * 60 * 60 * 1000,
  claudeJobsArchiveMaxMovesPerRun: 1000,
  claudeJobsArchiveTimeBudgetMs: 15000,
});
