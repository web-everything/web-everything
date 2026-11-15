/** Head-bound evidence for a review-gate human hold. Unknown or incomplete jobs stay red. */
import { runGhSync } from './gh-throttle.mjs';
import { HUMAN_REVIEW_HOLD_GATES } from './merge-gate-verdict.mjs';
import { latestCheckNamed } from './rollup-collapse.mjs';

const MARKER = 'review-gate-review-hold: ';
const VERDICT_STEPS = ['Fast verdict for a non-review label event', 'Check for an un-cleared review hold'];

/** Read only the latest failed job, never borrow proof from another check, head or repository. */
export function annotateReviewGateHold(rows, { repo, headSha, runGh = runGhSync } = {}) {
  try {
    const row = latestCheckNamed(rows, 'review-gate');
    if (row?.status?.toLowerCase() !== 'completed' || row.conclusion?.toLowerCase() !== 'failure'
      || row.head_sha !== headSha) return rows;
    const url = new URL(row.details_url ?? row.detailsUrl);
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(url.pathname);
    if (url.origin !== 'https://github.com' || !match || match[1] !== repo) return rows;
    const jobId = Number(match[3]);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return rows;
    const path = `repos/${repo}/actions/jobs/${jobId}`;
    const options = { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'review-gate-hold', repo } };
    const job = JSON.parse(runGh(['api', path], options));
    if (job.id !== jobId || String(job.run_id) !== match[2] || job.name !== 'review-gate'
      || job.head_sha !== headSha || job.status !== 'completed' || job.conclusion !== 'failure'
      || !Number.isSafeInteger(row.id) || !job.check_run_url?.endsWith(`/check-runs/${row.id}`)
      || !Array.isArray(job.steps) || !job.steps.length) return rows;
    // A hold emitted before another failed/cancelled step does not prove a hold-only job failure.
    const failed = job.steps.filter(step => step.conclusion === 'failure');
    if (failed.length !== 1 || !VERDICT_STEPS.includes(failed[0].name)
      || job.steps.some(step => step.status !== 'completed'
        || !['success', 'skipped', 'failure'].includes(step.conclusion))) return rows;
    const log = String(runGh(['api', `${path}/logs`], options));
    if (Buffer.byteLength(log, 'utf8') > options.maxBuffer) return rows;
    const markers = log.split(/\r?\n/).map(line => line.replace(/^\d{4}-\d\d-\d\dT\S+\s/, ''))
      .filter(line => line.startsWith(MARKER));
    if (markers.length !== 1 || markers[0].length > 1024) return rows;
    const { holds } = JSON.parse(markers[0].slice(MARKER.length));
    if (!Array.isArray(holds) || !holds.length || !holds.every(id => HUMAN_REVIEW_HOLD_GATES.includes(id))) return rows;
    return rows.map(check => check === row ? { ...check, reviewGateReviewHold: { holds, jobId } } : check);
  } catch { return rows; }
}
