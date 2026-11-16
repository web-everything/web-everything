/**
 * @file scripts/lib/review-hold-io.mjs
 * @description Read-only evidence reader for the review-gate check (design: review-hold-model, slice S2).
 *   Fetches the latest failed `review-gate` job and its log through GET-only `gh api` calls and returns the
 *   `reviewGate` input `deriveReviewHold` (review-hold-model.mjs) expects. Evidence is bound to head, repo, run,
 *   job and check run; anything unbound returns null (the model then holds). It never writes and never decides.
 */
import { runGhSync } from './gh-throttle.mjs';
import { REVIEW_GATE_MARKER } from './review-hold-model.mjs';

/** Fail-closed evidence: the model reads a non-success/failure state as unreadable and refuses to publish. */
const UNREADABLE = Object.freeze({ state: 'unreadable' });
const ROLLUP_CAP = 100;
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

const STATUSES = ['queued', 'in_progress', 'completed', 'pending', 'waiting', 'requested'];
const WORKFLOW_PATH = '.github/workflows/review-gate.yml';
const validRow = (r) => !!r && typeof r === 'object' && !Array.isArray(r)
  && typeof r.name === 'string' && r.name.length > 0 && STATUSES.includes(r.status)
  && /^[0-9a-f]{40}$/i.test(String(r.head_sha ?? r.headSha ?? ''));

/** Prove one `review-gate` row is this repo's own job: details URL, job, check run, head and workflow path all bind. */
function proveRow(row, { repo, headSha, prNumber, runGh }) {
  const url = new URL(row.details_url ?? row.detailsUrl);
  const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(url.pathname);
  if (url.origin !== 'https://github.com' || !match || match[1] !== repo) return null;
  const runId = Number(match[2]);
  const jobId = Number(match[3]);
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(row.id)) return null;
  const options = { encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_LOG, stdio: ['ignore', 'pipe', 'pipe'],
    throttle: { op: 'review-gate-hold', repo } };
  const path = `repos/${repo}/actions/jobs/${jobId}`;
  const job = JSON.parse(runGh(['api', path], options));
  if (job.id !== jobId || job.run_id !== runId || job.name !== 'review-gate' || !sameSha(job.head_sha, headSha)
    || !String(job.check_run_url ?? '').endsWith(`/check-runs/${row.id}`)) return null;
  // The row and the fetched job must tell the same story: a stale row cannot hide a finished failure.
  if (job.status !== row.status || (row.status === 'completed' && String(job.conclusion ?? '').toLowerCase() !== String(row.conclusion ?? '').toLowerCase())) return null;
  const run = JSON.parse(runGh(['api', `repos/${repo}/actions/runs/${runId}`], options));
  if (run.id !== runId || String(run.path ?? '').split('@')[0] !== WORKFLOW_PATH || !sameSha(run.head_sha, headSha)) return null;
  // review-gate.yml triggers on `pull_request` only; a dispatched or foreign-PR run at the same path proves nothing.
  if (run.event !== 'pull_request' || !Array.isArray(run.pull_requests)
    || !run.pull_requests.some((p) => p?.number === prNumber)) return null;
  return { runId, jobId, job, path, options };
}

/**
 * Read the review-gate evidence. Returns the model's `reviewGate` shape. Null means only "no review-gate row, or the
 * newest one is proven green or unfinished" (the model reads null as clear). Anything malformed, truncated, foreign
 * or unprovable returns an unreadable state, never null. Every `review-gate` row on the list must prove its own
 * provenance, so an unrelated newer green row cannot shadow a red one.
 */
export function readReviewGateEvidence(rows, { repo, headSha, prNumber, runGh = runGhSync } = {}) {
  try {
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return UNREADABLE;
    if (!Array.isArray(rows) || !rows.every(validRow)) return UNREADABLE;
    // A truncated rollup cannot prove the newest review-gate row is on the list.
    if (rows.length >= ROLLUP_CAP) return UNREADABLE;
    const gates = rows.filter((r) => r.name === 'review-gate');
    if (!gates.length) return null;
    if (gates.some((r) => !sameSha(r.head_sha ?? r.headSha, headSha) || !Number.isSafeInteger(r.id))) return UNREADABLE;
    const proofs = gates.map((r) => proveRow(r, { repo, headSha, prNumber, runGh }));
    if (proofs.some((p) => !p)) return UNREADABLE;
    const row = gates.reduce((a, b) => (b.id > a.id ? b : a));
    const proof = proofs[gates.indexOf(row)];
    const conclusion = String(row.conclusion ?? '').toLowerCase();
    if (row.status !== 'completed') {
      // A newer unfinished run must not mask an earlier failed one for this head.
      return gates.some((g) => g !== row && g.status === 'completed' && String(g.conclusion ?? '').toLowerCase() !== 'success') ? UNREADABLE : null;
    }
    if (conclusion === 'success') return null;
    if (conclusion !== 'failure') return UNREADABLE;
    const { job, runId, jobId, path, options } = proof;
    if (job.status !== 'completed' || job.conclusion !== 'failure' || !Array.isArray(job.steps) || !job.steps.length) return UNREADABLE;
    const log = String(runGh(['api', `${path}/logs`], options));
    if (Buffer.byteLength(log, 'utf8') > MAX_LOG) return UNREADABLE;
    return { state: 'failure', runId, jobId, jobHeadSha: job.head_sha, latest: true,
      steps: job.steps.map(({ name, status, conclusion: c }) => ({ name, status, conclusion: c })), logText: log };
  } catch { return UNREADABLE; }
}
