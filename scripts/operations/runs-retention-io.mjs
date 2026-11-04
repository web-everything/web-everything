/** IO sink for `runs-retention` (R549). Thin: all logic is in runs-retention-core.mjs. */
import { runsRetention } from './runs-retention-core.mjs';
import { RUNS_RETENTION_EFFECT } from './runs-retention.mjs';

export function createRunsRetentionSinks(deps = {}) {
  return { [RUNS_RETENTION_EFFECT]: async (payload) => runsRetention({ dryRun: payload.dryRun, month: payload.month || undefined, ...deps }) };
}
