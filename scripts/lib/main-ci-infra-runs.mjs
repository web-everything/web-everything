import { classifyRun } from '../conveyor/main-ci-red-core.mjs';
import { readRunJobs } from '../conveyor/main-ci-red-probe.mjs';

/** Mark proven infrastructure-only failures in newest-first runs. Unread or unreadable runs stay red;
 * when the read budget is exhausted, the remaining red window retains the merge hold for operator review.
 * Mutates and returns the same array; never throws.
 */
export function markInfraOnlyRuns(runs, { repo, exec, maxReads = 4 } = {}) {
  try {
    if (!Array.isArray(runs)) return runs;
    const limit = Number.isFinite(maxReads) ? Math.max(0, Math.floor(maxReads)) : 4;
    let reads = 0;
    for (const run of runs) {
      const verdict = classifyRun(run);
      if (verdict === 'green') break;
      if (verdict !== 'red') continue;
      if (reads >= limit) break;
      reads += 1;
      try {
        const jobs = readRunJobs(run.databaseId, { exec, repoSlug: repo });
        if (jobs?.complete && jobs.count > 0 && jobs.failed.length === 0) run.infraOnly = true;
      } catch { /* fail closed: retain the run's red verdict */ }
    }
  } catch { /* malformed inputs must not break the caller's fact read */ }
  return runs;
}
