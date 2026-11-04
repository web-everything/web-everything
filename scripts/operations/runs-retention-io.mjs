/** IO sink for `runs-retention` (R549). Thin: all logic is in runs-retention-core.mjs. */
import { runsRetention } from './runs-retention-core.mjs';
import { RUNS_RETENTION_EFFECT } from './runs-retention.mjs';

/** op name -> declared step count, from the live registry (dynamic import: run.mjs imports this file). */
async function stepCounts() {
  const { OPERATIONS } = await import('./run.mjs');
  const counts = new Map();
  for (const [name, make] of Object.entries(OPERATIONS)) {
    try { const n = make()?.declaration?.steps?.length; if (Number.isInteger(n)) counts.set(name, n); } catch { /* needs deps: unknown, retained */ }
  }
  return counts;
}

export function createRunsRetentionSinks(deps = {}) {
  return {
    [RUNS_RETENTION_EFFECT]: async (payload) => {
      const counts = deps.isComplete ? null : await stepCounts();
      const isComplete = deps.isComplete ?? (r => counts.has(r.op) && r.cursor >= counts.get(r.op) && !r.pending);
      return runsRetention({ dryRun: payload.dryRun, month: payload.month || undefined, ...deps, isComplete });
    },
  };
}
