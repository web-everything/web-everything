/** Reuse is neither red code nor fresh green execution. Prove it per run and
 * attempt, never per SHA. Unknown evidence and exhausted budgets retain red.
 */
/** The only `main-execution` step that fails on a reused push (ci.yml). */
export const REUSED_MARKER_STEP = 'Queue CI reused (no fresh main execution)';
const attemptOne = value => value === 1 || value === '1';

export function withoutReusedMainPushes(runs, { repo, exec }) {
  let reads = 0;
  return runs.filter((run) => {
    // Reruns, and runs whose attempt is unknown, may conceal a genuine later
    // failure; retain their existing hold.
    if (run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'failure'
      || !attemptOne(run.attempt)
      || !Number.isSafeInteger(run.databaseId) || run.databaseId <= 0 || reads >= 30) return true;
    reads += 1;
    try {
      const page = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${run.databaseId}/attempts/1/jobs?per_page=100`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }) || 'null');
      return !isReusedJobsPage(page);
    } catch { return true; }
  });
}

/** One attempt's complete jobs page proves reuse only when the marker failed on its reuse step. */
export function isReusedJobsPage(page) {
  const jobs = page?.jobs;
  if (!Array.isArray(jobs) || !jobs.length || page.total_count !== jobs.length) return false;
  const markers = jobs.filter(job => job?.name === 'main-execution');
  const steps = markers[0]?.steps;
  return markers.length === 1 && markers[0].conclusion === 'failure'
    && Array.isArray(steps) && steps.some(step => step?.name === REUSED_MARKER_STEP && step.conclusion === 'failure')
    && steps.every(step => step?.name === REUSED_MARKER_STEP || step?.conclusion !== 'failure')
    && jobs.every(job => job?.status === 'completed' && attemptOne(job.run_attempt)
      && (job === markers[0] || ['success', 'skipped'].includes(job.conclusion)));
}

/** Main evidence is push and the hourly backstop only. An unreadable event makes the inventory unknown. */
export function mainEventRuns(runs) {
  if (runs.some(r => typeof r?.event !== 'string' || !r.event.trim())) throw new Error('main CI run event unreadable');
  return runs.filter(r => ['push', 'schedule'].includes(r.event));
}

/**
 * A scheduled success speaks only for its own execution window: the current head, or an older SHA
 * with no other execution between that SHA reaching main and the backstop starting. Scheduled
 * failures are always kept: discarding known red is never fail-closed. `pushes` are the push runs
 * before reuse filtering (a reused push still dates when its SHA reached main).
 */
export function withoutStaleScheduledSuccesses(runs, { head = null, pushes = [] } = {}) {
  const at = value => Date.parse(value ?? '');
  const sha = value => (typeof value === 'string' ? value.toLowerCase() : null);
  // A PROVEN-REUSED push of a newer SHA is gone from `runs` but still moved main: it must close the
  // older SHA's window too, or that SHA's delayed backstop would read green for a commit never run on main.
  const moves = [...runs, ...pushes];
  return runs.filter(r => {
    if (r.event !== 'schedule' || r.conclusion !== 'success') return true;
    if (head && sha(r.headSha) === sha(head)) return true;
    const started = at(r.createdAt);
    if (typeof r.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(r.headSha) || !Number.isFinite(started)) return false;
    const reachedMain = Math.max(-Infinity, ...pushes.filter(push => sha(push.headSha) === sha(r.headSha)
      && at(push.createdAt) <= started).map(push => at(push.createdAt)));
    return !moves.some(other => sha(other.headSha) !== sha(r.headSha)
      && (!Number.isFinite(at(other.createdAt)) || (at(other.createdAt) >= reachedMain && at(other.createdAt) <= started)));
  });
}
