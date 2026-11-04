/** IO sink for `runs-retention` (R549). Thin: all logic is in runs-retention-core.mjs. */
import { runsRetention } from './runs-retention-core.mjs';
import { RUNS_RETENTION_EFFECT } from './runs-retention.mjs';

/**
 * Completion is the ENGINE's own definition (`engine.runStatus`: cursor >= the registry declaration's step count, no
 * pending) - the very declaration `--resume` steps with, so a run that reads complete here has nothing left to resume.
 * op name -> declared step count, from the live registry (dynamic import: run.mjs imports this file). */
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
      const { OPERATIONS } = deps.isComplete ? {} : await import('./run.mjs');
      // review-pr declarations vary with the saved roster: build THAT run's own declaration (as --resume does).
      const stepsFor = r => {
        if (r.op === 'review-pr') { try { return OPERATIONS['review-pr']({ resumeId: r.id }).declaration.steps.length; } catch { return null; } }
        return counts.has(r.op) ? counts.get(r.op) : null;
      };
      const isComplete = deps.isComplete ?? (r => { const n = stepsFor(r); return n !== null && r.cursor === n && !r.pending; });
      return runsRetention({ dryRun: payload.dryRun, month: payload.month || undefined, ...deps, isComplete });
    },
  };
}
