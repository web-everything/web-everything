/**
 * @file scripts/lib/review-hold-io.mjs
 * @description Read-only evidence reader for the review-gate check (design: review-hold-model, slice S2).
 *   Fetches the latest failed `review-gate` job and its log through GET-only `gh api` calls and returns the
 *   `reviewGate` input `deriveReviewHold` (review-hold-model.mjs) expects. Evidence is bound to head, repo, run,
 *   job and check run; anything unbound returns null (the model then holds). It never writes and never decides.
 */
import { runGhSync } from './gh-throttle.mjs';
import { REVIEW_GATE_MARKER } from './review-hold-model.mjs';
import { latestCheckNamed } from './rollup-collapse.mjs';

const MAX_LOG = 1024 * 1024;
const stripTs = (line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /, '');
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();

/** Exactly one marker line, parseable, bound to this head and run. Pure.
 *  @returns {{ok:true, holds:string[]}|{ok:false, why:string}} */
export function parseReviewGateMarker(logText, { headSha, runId } = {}) {
  const lines = String(logText ?? '').split(/\r?\n/).map(stripTs).filter((l) => l.startsWith(REVIEW_GATE_MARKER));
  if (lines.length !== 1) return { ok: false, why: 'marker-count' };
  if (lines[0].length > 1024) return { ok: false, why: 'marker-oversize' };
  let m;
  try { m = JSON.parse(lines[0].slice(REVIEW_GATE_MARKER.length)); } catch { return { ok: false, why: 'marker-unreadable' }; }
  if (!Array.isArray(m?.holds) || !m.holds.length) return { ok: false, why: 'marker-holds' };
  if (!sameSha(m.headSha, headSha) || m.runId !== runId) return { ok: false, why: 'marker-foreign' };
  return { ok: true, holds: m.holds };
}

/**
 * Read the latest `review-gate` row's job and log. Returns the model's `reviewGate` shape, or null when the row
 * is not a completed failure on this head from this repo's own job (the model reads null as "no review-gate proof").
 */
export function readReviewGateEvidence(rows, { repo, headSha, runGh = runGhSync } = {}) {
  try {
    const row = latestCheckNamed(rows, 'review-gate');
    if (!row || String(row.status ?? '').toLowerCase() !== 'completed' || String(row.conclusion ?? '').toLowerCase() !== 'failure'
      || !sameSha(row.head_sha ?? row.headSha, headSha)) return null;
    const url = new URL(row.details_url ?? row.detailsUrl);
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(url.pathname);
    if (url.origin !== 'https://github.com' || !match || match[1] !== repo) return null;
    const runId = Number(match[2]);
    const jobId = Number(match[3]);
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || !Number.isSafeInteger(runId) || runId <= 0) return null;
    const path = `repos/${repo}/actions/jobs/${jobId}`;
    const options = { encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_LOG, stdio: ['ignore', 'pipe', 'pipe'],
      throttle: { op: 'review-gate-hold', repo } };
    const job = JSON.parse(runGh(['api', path], options));
    if (job.id !== jobId || job.run_id !== runId || job.name !== 'review-gate' || !sameSha(job.head_sha, headSha)
      || job.status !== 'completed' || job.conclusion !== 'failure'
      || !Number.isSafeInteger(row.id) || !String(job.check_run_url ?? '').endsWith(`/check-runs/${row.id}`)
      || !Array.isArray(job.steps) || !job.steps.length) return null;
    const log = String(runGh(['api', `${path}/logs`], options));
    if (Buffer.byteLength(log, 'utf8') > MAX_LOG) return null;
    return { state: 'failure', runId, jobId, jobHeadSha: job.head_sha, latest: true,
      steps: job.steps.map(({ name, status, conclusion }) => ({ name, status, conclusion })), logText: log };
  } catch { return null; }
}
