/** Reuse is neither red code nor fresh green execution. Prove it per run and
 * attempt, never per SHA. Unknown evidence and exhausted budgets retain red.
 */
export function withoutReusedMainPushes(runs, { repo, exec }) {
  let reads = 0;
  return runs.filter((run) => {
    // Reruns may conceal a genuine earlier failure; retain their existing hold.
    if (run.event !== 'push' || run.status !== 'completed' || run.conclusion !== 'failure'
      || (run.attempt != null && Number(run.attempt) !== 1)
      || !Number.isSafeInteger(run.databaseId) || run.databaseId <= 0 || reads >= 30) return true;
    reads += 1;
    try {
      const page = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${run.databaseId}/attempts/1/jobs?per_page=100`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }) || 'null');
      const jobs = page?.jobs;
      if (!Array.isArray(jobs) || !jobs.length || page.total_count !== jobs.length) return true;
      const markers = jobs.filter(job => job?.name === 'main-execution');
      const reused = markers.length === 1 && markers[0].conclusion === 'failure'
        && jobs.every(job => job?.status === 'completed'
          && (job.run_attempt == null || Number(job.run_attempt) === 1)
          && (job === markers[0] || ['success', 'skipped'].includes(job.conclusion)));
      return !reused;
    } catch { return true; }
  });
}
