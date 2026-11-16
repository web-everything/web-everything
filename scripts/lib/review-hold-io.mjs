/**
 * @file scripts/lib/review-hold-io.mjs
 * @description Read-only evidence reader for the review-gate check (design: review-hold-model, slice S2).
 *   Proves the latest `review-gate` job and, for failures, its log through GET-only `gh api` calls and returns the
 *   `reviewGate` input `deriveReviewHold` (review-hold-model.mjs) expects. Evidence is bound to head, repo, run,
 *   job and check run. Returns clear, hold, or unreadable with a reason; never null. It never writes.
 */
import { runGhSync } from './gh-throttle.mjs';
import { REVIEW_GATE_HOLD_KINDS, REVIEW_GATE_MARKER, REVIEW_GATE_CLEAR_MARKER, REVIEW_GATE_VERDICT_STEPS, sealReviewGateEvidence } from './review-hold-model.mjs';

/** Every loss of proof carries an operator-visible reason. */
const unreadable = (reason) => sealReviewGateEvidence({ state: 'unreadable', reason });
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const validSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/i.test(s);
const ROLLUP_CAP = 100;
const MAX_LOG = 1024 * 1024;
const stripTs = (line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /, '');
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
const labelNames = (labels) => [...new Set(labels.map((l) => typeof l === 'string' ? l : l.name))].sort();
const validLabels = (labels) => Array.isArray(labels) && labels.every((l) => typeof l === 'string'
  || (l && typeof l === 'object' && !Array.isArray(l) && typeof l.name === 'string'));

/** Exactly one schema-strict clear marker, bound to this head and run. */
export function parseReviewGateClearMarker(logText, { headSha, runId } = {}) {
  if (!validSha(headSha) || !isPosInt(runId)) return { ok: false, why: 'clear-marker-binding' };
  const lines = String(logText ?? '').split(/\r?\n/).map(stripTs).filter((l) => l.startsWith(REVIEW_GATE_CLEAR_MARKER));
  if (lines.length !== 1) return { ok: false, why: 'clear-marker-count' };
  if (lines[0].length > MAX_LOG) return { ok: false, why: 'clear-marker-oversize' };
  let m;
  try { m = JSON.parse(lines[0].slice(REVIEW_GATE_CLEAR_MARKER.length)); } catch { return { ok: false, why: 'clear-marker-unreadable' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)
    || Object.keys(m).sort().join(',') !== 'headSha,labels,runId') return { ok: false, why: 'clear-marker-schema' };
  if (!Array.isArray(m.labels) || !m.labels.every((l) => typeof l === 'string')) return { ok: false, why: 'clear-marker-labels' };
  if (!validSha(m.headSha) || !isPosInt(m.runId) || !sameSha(m.headSha, headSha) || m.runId !== runId) return { ok: false, why: 'clear-marker-foreign' };
  return { ok: true, labels: labelNames(m.labels) };
}

/** Exactly one marker line, parseable, bound to this head and run. Pure.
 *  @returns {{ok:true, holds:string[]}|{ok:false, why:string}} */
export function parseReviewGateMarker(logText, { headSha, runId } = {}) {
  if (!validSha(headSha) || !isPosInt(runId)) return { ok: false, why: 'marker-binding' };
  const lines = String(logText ?? '').split(/\r?\n/).map(stripTs).filter((l) => l.startsWith(REVIEW_GATE_MARKER));
  if (lines.length !== 1) return { ok: false, why: 'marker-count' };
  if (lines[0].length > 1024) return { ok: false, why: 'marker-oversize' };
  let m;
  try { m = JSON.parse(lines[0].slice(REVIEW_GATE_MARKER.length)); } catch { return { ok: false, why: 'marker-unreadable' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)
    || Object.keys(m).sort().join(',') !== 'headSha,holds,runId') return { ok: false, why: 'marker-schema' };
  if (!Array.isArray(m.holds) || m.holds.length !== 1 || !REVIEW_GATE_HOLD_KINDS.includes(m.holds[0])) return { ok: false, why: 'marker-holds' };
  if (!validSha(m.headSha) || !isPosInt(m.runId) || !sameSha(m.headSha, headSha) || m.runId !== runId) return { ok: false, why: 'marker-foreign' };
  return { ok: true, holds: m.holds };
}

/** Files that define the gate. A PR editing them could fabricate its own marker or verdict, so it proves nothing. */
const GATE_FILES = Object.freeze(['.github/workflows/review-gate.yml', 'scripts/check-review-gate.mjs']);
/** Clear needs a verdict step that really ran: a skipped step or the main-lacks-the-script bootstrap proves nothing. */
const verdictRan = (steps) => Array.isArray(steps) && steps.some((s) => REVIEW_GATE_VERDICT_STEPS.includes(s?.name)
  && s.status === 'completed' && s.conclusion === 'success');

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
    || job.check_run_url !== `https://api.github.com/repos/${repo}/check-runs/${row.id}`) return null;
  // The row and the fetched job must tell the same story: a stale row cannot hide a finished failure.
  if (job.status !== row.status || (row.status === 'completed' && String(job.conclusion ?? '').toLowerCase() !== String(row.conclusion ?? '').toLowerCase())) return null;
  const run = JSON.parse(runGh(['api', `repos/${repo}/actions/runs/${runId}`], options));
  if (run.id !== runId || String(run.path ?? '').split('@')[0] !== WORKFLOW_PATH || !sameSha(run.head_sha, headSha)) return null;
  // review-gate.yml triggers on `pull_request` only; a dispatched or foreign-PR run at the same path proves nothing.
  if (run.event !== 'pull_request' || !Array.isArray(run.pull_requests)
    || !run.pull_requests.some((p) => p?.number === prNumber)) return null;
  // The proving job must be the run's LATEST attempt, and a clear needs the run itself finished green: an older
  // successful attempt cannot hide a pending or failing re-run. A failed latest attempt is only a hold if the run says so.
  if (!isPosInt(job.run_attempt) || !isPosInt(run.run_attempt) || job.run_attempt !== run.run_attempt) return null;
  if (run.status !== 'completed' || String(run.conclusion ?? '').toLowerCase() !== String(row.conclusion ?? '').toLowerCase()) return null;
  return { runId, jobId, job, path, options };
}

/**
 * Read closed tri-state evidence. Clear requires a proven latest successful verdict; hold requires
 * exactly one failed verdict step and one schema-strict bound marker. Missing, unfinished, malformed,
 * truncated, foreign or unprovable inputs return unreadable with a reason. Every gate row must prove
 * provenance so an unrelated newer row cannot shadow a failure. `changedFiles` and `labels` are required.
 * @returns {{state:'clear', evidence:{headSha:string, runId:number, jobId:number}}|
 *   {state:'hold', holds:string[], evidence:{headSha:string, runId:number, jobId:number}}|
 *   {state:'unreadable', reason:string}}
 */
export function readReviewGateEvidence(rows, { repo, headSha, prNumber, changedFiles, labels, runGh = runGhSync } = {}) {
  try {
    if (!isPosInt(prNumber) || !validSha(headSha) || typeof repo !== 'string' || !/^[^/]+\/[^/]+$/.test(repo)) return unreadable('invalid-binding');
    if (!validLabels(labels)) return unreadable('labels-unreadable');
    if (!Array.isArray(changedFiles) || changedFiles.some((f) => typeof f !== 'string')) return unreadable('changed-files-unreadable');
    if (changedFiles.some((f) => GATE_FILES.includes(f))) return unreadable('gate-file-edit');
    if (!Array.isArray(rows) || !rows.every(validRow)) return unreadable('rollup-unreadable');
    if (rows.length >= ROLLUP_CAP) return unreadable('rollup-truncated');
    const gates = rows.filter((r) => r.name === 'review-gate');
    if (!gates.length) return unreadable('missing-check');
    if (gates.some((r) => !sameSha(r.head_sha ?? r.headSha, headSha) || !isPosInt(r.id))) return unreadable('row-unbound');
    const proofs = gates.map((r) => proveRow(r, { repo, headSha, prNumber, runGh }));
    if (proofs.some((p) => !p)) return unreadable('provenance-unproven');
    const row = gates.reduce((a, b) => (b.id > a.id ? b : a));
    const proof = proofs[gates.indexOf(row)];
    if (proofs.some((p, i) => p.runId > proof.runId
      && (gates[i].status !== 'completed' || gates[i].conclusion !== 'success'))) return unreadable('newer-run-not-green');
    if (row.status !== 'completed') return unreadable('run-unfinished');
    const { job, runId, jobId, path, options } = proof;
    const steps = job.steps;
    if (!Array.isArray(steps) || !steps.length || steps.some((s) => s?.status !== 'completed')) return unreadable('steps-incomplete');
    const evidence = { headSha: job.head_sha, runId, jobId };
    const conclusion = String(row.conclusion ?? '').toLowerCase();
    if (conclusion === 'success') {
      if (!verdictRan(steps) || steps.some((s) => !['success', 'skipped'].includes(s.conclusion))) return unreadable('successful-verdict-unproven');
      const log = String(runGh(['api', `${path}/logs`], options));
      if (Buffer.byteLength(log, 'utf8') > MAX_LOG) return unreadable('log-oversize');
      const marker = parseReviewGateClearMarker(log, { headSha, runId });
      if (!marker.ok) return unreadable(marker.why);
      if (JSON.stringify(marker.labels) !== JSON.stringify(labelNames(labels))) return unreadable('clear-marker-labels-stale');
      return sealReviewGateEvidence({ state: 'clear', evidence });
    }
    if (conclusion !== 'failure' || job.conclusion !== 'failure') return unreadable('conclusion-unproven');
    const failed = steps.filter((s) => s.conclusion === 'failure');
    if (failed.length !== 1 || !REVIEW_GATE_VERDICT_STEPS.includes(failed[0].name)
      || steps.some((s) => s !== failed[0] && !['success', 'skipped'].includes(s.conclusion))) return unreadable('infrastructure-failure');
    const log = String(runGh(['api', `${path}/logs`], options));
    if (Buffer.byteLength(log, 'utf8') > MAX_LOG) return unreadable('log-oversize');
    const marker = parseReviewGateMarker(log, { headSha, runId });
    if (!marker.ok) return unreadable(marker.why);
    return sealReviewGateEvidence({ state: 'hold', holds: marker.holds, evidence });
  } catch { return unreadable('evidence-read-failed'); }
}
