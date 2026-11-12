import { classifyRun } from '../conveyor/main-ci-red-core.mjs';

/** Read one run's jobs straight from the API, keeping each job's own status, conclusion and attempt. */
function readJobs(run, { repo, exec }) {
  // The run's OWN attempt: a re-run started after the run list was read cannot leak its jobs in.
  const page = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${run.databaseId}/attempts/${Number(run.attempt) || 1}/jobs?per_page=100`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }) || 'null');
  const jobs = Array.isArray(page?.jobs) ? page.jobs : [];
  return { complete: Number.isInteger(page?.total_count) && page.total_count === jobs.length, jobs };
}

/** Infra-only proof: a complete, non-empty job list, every job finished as success/skipped/cancelled or never started (none running), all from the run's own attempt, and at least one cancelled. Anything else stays red. */
export function jobsProveInfraOnly(read, run) {
  if (!read?.complete || !read.jobs.length) return false;
  const attempt = Number(run?.attempt) || 1;
  // A job that never started (still queued/waiting in a finished run) is a runner that never came: infra too.
  const never = (j) => ['queued', 'waiting', 'pending', 'requested'].includes(String(j?.status)) && j?.conclusion == null;
  const finished = (j) => String(j?.status) === 'completed' && ['success', 'skipped', 'cancelled'].includes(String(j?.conclusion));
  const done = read.jobs.every((j) => (finished(j) || never(j)) && (j?.run_attempt == null || Number(j.run_attempt) === attempt));
  return done && read.jobs.some((j) => String(j.conclusion) === 'cancelled' || never(j));
}

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
      // A re-run (attempt > 1) may hide an earlier genuine failure behind cancelled jobs: it stays red.
      if (Number(run.attempt) > 1) continue;
      if (reads >= limit) break;
      reads += 1;
      try {
        if (jobsProveInfraOnly(readJobs(run, { repo, exec }), run)) run.infraOnly = true;
      } catch { /* fail closed: retain the run's red verdict */ }
    }
  } catch { /* malformed inputs must not break the caller's fact read */ }
  return runs;
}
