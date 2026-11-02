/** One free failed-jobs rerun per workflow on a repo/PR/head; storage and locking belong to the watcher. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isGhDeferred, isGhThrottled } from '../lib/gh-deferred.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { latestCheckNamed, isFailedCheckRow, requiredCheckReadNeeded } from '../lib/rollup-collapse.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';

const ioOptions = () => ({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
const validId = id => /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));
const validAttempt = e => e && validId(e.runId) && Number.isFinite(Date.parse(e.retriggeredAt)) &&
  (e.reserved === undefined || typeof e.reserved === 'boolean');
const rowRunId = (row, repo) => {
  try {
    const url = new URL(row.detailsUrl);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/\d+)?\/?$/);
    if (match && `${match[1]}/${match[2]}`.toLowerCase() === repo.toLowerCase()) return match[3];
  } catch {
    // An invalid URL cannot establish which workflow run owns the check.
  }
};
const errorText = error => String(error?.stderr || error?.message || error).slice(0, 500);
const notSubmitted = error => isGhThrottled(error) || error?.budgetBlocked ||
  /^gh-throttle: GitHub (?:core|graphql) API rate limit exceeded for this identity — shared backoff until [^\r\n]+, call not sent \(#gh-graphql-budget\)\r?$/m.test(String(error?.stderr || ''));

function readJson(args, exec) {
  const out = exec('gh', args, ioOptions());
  if (isGhDeferred(out) || isGhThrottled(out)) throw Error('GitHub read deferred; retry next tick');
  return JSON.parse(String(out));
}

function defaultReadRuns(sha, { repo, branch, exec = execFileSyncThrottled }) {
  const fields = 'databaseId,status,conclusion,workflowName,createdAt,headSha,headBranch,updatedAt';
  const list = filter => {
    const rows = readJson(['run', 'list', '--repo', repo, ...filter, '--limit', '100', '--json', fields], exec);
    if (!Array.isArray(rows) || rows.length >= 100) throw Error('run history incomplete; inspect CI manually or retry after history narrows');
    return rows;
  };
  const head = list(['--commit', sha]);
  // The ref history explains cancellations by newer heads, while only commit history gates eligibility.
  const ref = list(['--branch', branch]);
  return [...head, ...ref.filter(r => r.headSha !== sha)];
}

function defaultReadJobs(runId, { repo, exec = execFileSyncThrottled }) {
  const payload = readJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`], exec);
  if (!Array.isArray(payload?.jobs) || !Number.isInteger(payload.total_count) || payload.total_count > payload.jobs.length) {
    throw Error('job history incomplete; inspect CI manually');
  }
  return payload.jobs;
}

export function rerunPrCancelledRun(runId, { repo, exec = execFileSyncThrottled } = {}) {
  if (!validId(runId)) return { ok: false, uncertain: false, error: 'invalid run ID' };
  try {
    const out = exec('gh', ['api', '-X', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`], ioOptions());
    if (isGhDeferred(out) || isGhThrottled(out)) return { ok: false, uncertain: false, error: 'rerun deferred; nothing submitted' };
    return { ok: true };
  } catch (e) {
    const error = errorText(e);
    return { ok: false, error, uncertain: !notSubmitted(e) && !/\bHTTP 4(?!08)\d\d\b/.test(error) };
  }
}

export function sweepPrCancelledRerun(options = {}) {
  if (!options.apply) return sweepLocked(options);
  let held;
  try {
    held = options.lock(options.recordPath, ctx => sweepLocked({ ...options, assertHeld: ctx?.assertHeld }));
  } catch {
    return { dispatch: [], applied: [], refusals: [{ reason: 'record-lock-failed', error: 'inspect the attempt record and lock before retrying' }] };
  }
  return held?.locked ? held.value : { dispatch: [], applied: [], refusals: [{ reason: 'record-locked', error: 'retry next tick' }] };
}

function sweepLocked({ repo, apply = false, readOpenPrs, requiredChecks, readRequiredChecks,
  readRuns = defaultReadRuns, readJobs = defaultReadJobs, rerunFailed = rerunPrCancelledRun,
  recordPath, readRecord, writeRecord, lock: _lock, assertHeld = () => {}, now = Date.now(), maxPerTick = 3,
  emitEvent = event => appendDaemonEvent({ ...event, daemon: 'ci-red-recovery-watch' }),
} = {}) {
  const result = { dispatch: [], refusals: [], applied: [] };
  const refuse = (reason, detail = {}) => result.refusals.push({ reason, ...detail });
  const persist = value => { assertHeld(); writeRecord(recordPath, value); };
  let record;
  try {
    record = readRecord(recordPath);
    if (!record || Array.isArray(record) || typeof record !== 'object' || Object.values(record).some(e =>
      !validAttempt(e) || (Object.hasOwn(e, 'workflows') && (!e.workflows || Array.isArray(e.workflows) ||
        typeof e.workflows !== 'object' || !Object.keys(e.workflows).length ||
        Object.values(e.workflows).some(a => !validAttempt(a)) ||
        !Object.values(e.workflows).some(a => String(a.runId) === String(e.runId)))))) throw Error('invalid record');
  } catch {
    refuse('record-unreadable', { error: 'restore the attempt record or inspect PR CI before retrying' });
    return result;
  }
  let prs;
  try {
    if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw Error('repository missing');
    prs = readOpenPrs({ repo, extraFields: ['baseRefName'] });
    if (!Array.isArray(prs)) throw Error('incomplete PR evidence');
    if (!Number.isInteger(maxPerTick) || maxPerTick < 1) throw Error('invalid per-tick cap');
  } catch {
    refuse('prs-unreadable', { error: 'inspect PR and required-check evidence; retry next tick' });
    return result;
  }
  let inspected = 0;
  let jobsRead = 0;
  const alreadyAttempted = (attempt, detail) => refuse(attempt.reserved ? 'rerun-outcome-unknown' : 'already-rerun', {
    ...detail, runId: attempt.runId,
    error: attempt.reserved ? 'inspect PR CI before clearing the reservation' : 'this workflow has consumed its free attempt',
  });
  for (const pr of prs) {
    const sha = pr?.headRefOid;
    const detail = { pr: pr?.number, sha };
    if (pr?.state && pr.state !== 'OPEN') continue;
    if (!validId(pr?.number) || !/^[a-f\d]{40}$/i.test(sha || '') || !pr.headRefName ||
      !Array.isArray(pr.statusCheckRollup) || pr.requiredCheckReadError) { refuse('pr-evidence-incomplete', detail); continue; }
    let checks;
    try {
      if (typeof pr.baseRefName !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(pr.baseRefName)) throw Error('unsafe or missing PR base');
      checks = requiredChecks ?? readRequiredChecks({ repo, branch: pr.baseRefName });
      if (!Array.isArray(checks) || !checks.length || checks.some(c => typeof c !== 'string' || !c)) throw Error('incomplete required set');
    } catch {
      refuse('required-set-unreadable', { ...detail, error: 'inspect PR base and live required-check settings; retry next tick' });
      continue;
    }
    const rows = checks.map(name => latestCheckNamed(pr.statusCheckRollup, name));
    const conclusion = row => String(row?.conclusion || row?.state || '').toUpperCase();
    if (rows.some(row => ['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING'].includes(row?.status))) {
      refuse('required-pending', { ...detail, error: 'wait for the live required-check attempt to finish; retry next tick' });
      continue;
    }
    if (rows.some(row => isFailedCheckRow(row) && conclusion(row) !== 'CANCELLED')) continue;
    const cancelled = rows.filter(row => row?.status === 'COMPLETED' && conclusion(row) === 'CANCELLED');
    if (!cancelled.length) continue;
    if (checks.some(name => requiredCheckReadNeeded(pr, name))) {
      refuse('checks-incomplete', { ...detail, error: 'inspect missing or capped required-check evidence before retrying' });
      continue;
    }
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
      !(row.status === 'COMPLETED' && ['CANCELLED', 'SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(row.conclusion)))) {
      refuse('required-evidence-unreadable', { ...detail, error: 'inspect required-check evidence; retry next tick' });
      continue;
    }
    const key = `${repo}#${pr.number}@${sha}`;
    const previous = Object.hasOwn(record, key) ? record[key] : null;
    const knownAttempts = previous?.workflows;
    // Avoid spending the read budget on heads whose cancelled workflows are all already recorded.
    const recordedForRow = row => knownAttempts && (Object.hasOwn(knownAttempts, row.workflowName)
      ? knownAttempts[row.workflowName] : Object.values(knownAttempts).find(a => String(a.runId) === rowRunId(row, repo)));
    if (knownAttempts && cancelled.every(row => recordedForRow(row))) {
      for (const attempt of new Set(cancelled.map(recordedForRow))) alreadyAttempted(attempt, detail);
      continue;
    }
    // At most two run-list calls per inspected head, and maxPerTick jobs reads/submissions across all workflows.
    if (inspected >= maxPerTick || result.dispatch.length >= maxPerTick) { refuse('tick-cap', { ...detail, error: 'retry next tick; no attempt consumed' }); continue; }
    inspected++;
    let runs;
    try {
      runs = readRuns(sha, { repo, branch: pr.headRefName });
      if (!Array.isArray(runs) || runs.some(r => !r || !r.headSha || !r.headBranch || !r.workflowName ||
        !Number.isFinite(Date.parse(r.createdAt)))) throw Error('incomplete runs');
    } catch { refuse('runs-unreadable', { ...detail, error: 'inspect run history; retry next tick' }); continue; }
    const headRuns = runs.filter(r => r.headSha === sha);
    if (!headRuns.length) { refuse('runs-unreadable', detail); continue; }
    // Every workflow's history is evidence about this head, including superseded and non-required runs.
    if (headRuns.some(r => r.status === 'completed' &&
      ['failure', 'timed_out', 'startup_failure', 'action_required', 'error'].includes(r.conclusion))) {
      refuse('real-failure-in-run', { ...detail, error: 'inspect failing run history before retrying PR CI' });
      continue;
    }
    if (headRuns.some(r => !['completed', 'queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(r.status) ||
      (r.status === 'completed' ? !['cancelled', 'success', 'skipped', 'neutral'].includes(r.conclusion)
        : r.conclusion != null))) {
      refuse('run-history-contradicts-rollup', { ...detail, error: 'inspect contradictory run history; retry next tick' });
      continue;
    }
    if (headRuns.some(r => r.status !== 'completed')) { refuse('later-run-exists', detail); continue; }
    if (headRuns.some(r => !validId(r.databaseId))) { refuse('invalid-run-id', detail); continue; }
    // URL attribution must agree with this head's observed workflow history.
    // Without a URL, successful historical runs cannot own a cancelled row, but a
    // second cancelled run makes workflow-name attribution ambiguous.
    if (cancelled.some(row => {
      const id = rowRunId(row, repo);
      if (!id && !row.detailsUrl) return new Set(headRuns.filter(r =>
        r.workflowName === row.workflowName && r.conclusion === 'cancelled')
        .map(r => String(r.databaseId))).size > 1;
      const attributed = headRuns.find(r => String(r.databaseId) === id);
      return !attributed || (row.workflowName && attributed.workflowName !== row.workflowName);
    })) {
      refuse('attribution-contradiction', { ...detail, error: 'inspect check URLs and workflow run history; retry next tick' });
      continue;
    }
    const owners = cancelled.map(row => {
      const id = rowRunId(row, repo);
      return row.workflowName || headRuns.find(r => String(r.databaseId) === id)?.workflowName;
    });
    if (owners.some(owner => !owner)) { refuse('workflow-unknown', detail); continue; }
    let attempts = knownAttempts ?? {};
    if (previous && !knownAttempts) {
      // Old records contained one run but no workflow name. Attribute it only with observed history.
      const priorRun = headRuns.find(r => String(r.databaseId) === String(previous.runId));
      if (!priorRun) { refuse('record-workflow-unknown', { ...detail, error: 'inspect the legacy attempt before retrying' }); continue; }
      attempts = { [priorRun.workflowName]: previous };
    }
    // Consumed heads and uncertain reservations are permanent, even after PR closure.
    if (!Object.hasOwn(record, key) && Object.keys(record).length >= 500) {
      refuse('record-full', { ...detail, error: 'archive/trim the record file before admitting another attempt' });
      continue;
    }
    const newest = [...new Set(owners)].map(owner => headRuns.filter(r => r.workflowName === owner)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || Number(b.databaseId) - Number(a.databaseId))[0]);
    if (newest.some(target => target?.conclusion === 'cancelled' && cancelled.some((row, index) =>
      owners[index] === target.workflowName && rowRunId(row, repo) && rowRunId(row, repo) !== String(target.databaseId)))) {
      refuse('later-run-exists', { ...detail, error: 'wait for rollup to reflect the newest workflow run; retry next tick' });
      continue;
    }
    const refusalsBefore = result.refusals.length;
    const ready = [];
    const candidates = newest.filter(target => target && !Object.hasOwn(attempts, target.workflowName) &&
      target.conclusion === 'cancelled');
    if (jobsRead + candidates.length > maxPerTick || result.dispatch.length + candidates.length > maxPerTick) {
      refuse('tick-cap', { ...detail, error: 'retry next tick with sufficient tick budget; no attempt consumed' });
      continue;
    }
    // Validate the entire head before publishing dispatches or reserving any workflow.
    for (const target of newest) {
      if (!target) { refuse('workflow-unknown', detail); continue; }
      if (Object.hasOwn(attempts, target.workflowName)) { alreadyAttempted(attempts[target.workflowName], detail); continue; }
      if (target.conclusion !== 'cancelled') continue;
      const runId = target.databaseId;
      let jobs;
      jobsRead++;
      try {
        jobs = readJobs(runId, { repo });
        if (!Array.isArray(jobs) || Array.from(jobs).some(job => !job || typeof job !== 'object' ||
          Array.isArray(job) || typeof job.status !== 'string' ||
          !(typeof job.conclusion === 'string' || (job.conclusion === null && job.status !== 'completed')))) {
          throw Error('invalid jobs');
        }
      } catch { refuse('jobs-unreadable', detail); continue; }
      if (jobs.some(job => ['failure', 'timed_out', 'error', 'startup_failure', 'action_required', 'stale'].includes(job.conclusion))) {
        refuse('real-failure-in-run', detail);
        continue;
      }
      if (jobs.some(job => job.status !== 'completed' ||
        !['success', 'skipped', 'neutral', 'cancelled'].includes(job.conclusion))) {
        refuse('jobs-unreadable', detail);
        continue;
      }
      const cancelReason = jobs.some(j => j?.conclusion === 'cancelled' &&
        Date.parse(j.completedAt) - Date.parse(j.startedAt) >= 595_000) ? 'job-timeout'
        : runs.some(r => r.headBranch === target.headBranch && Date.parse(r.createdAt) > Date.parse(target.createdAt))
          ? 'superseded-by-newer-run' : 'unknown';
      const dispatch = { action: 'pr-cancelled-rerun', ...detail, runId, cancelReason };
      ready.push({ target, dispatch });
    }
    if (result.refusals.length !== refusalsBefore) continue;
    for (const { target, dispatch } of ready) {
      const { runId, cancelReason } = dispatch;
      result.dispatch.push(dispatch);
      if (!apply) continue;
      const attempt = { runId, retriggeredAt: new Date(now).toISOString() };
      const withAttempt = entry => ({ ...record, [key]: {
        ...entry, workflows: { ...attempts, [target.workflowName]: entry },
      } });
      const reservation = withAttempt({ ...attempt, reserved: true });
      try { persist(reservation); }
      catch { result.applied.push({ ...dispatch, ok: false, error: 'reservation failed; inspect the attempt record before retrying' }); return result; }
      let outcome;
      try { assertHeld(); outcome = rerunFailed(runId, { repo }); }
      catch (e) { outcome = { ok: false, uncertain: !notSubmitted(e), error: errorText(e) }; }
      if (outcome?.ok !== true) {
        let error = outcome?.error || 'rerun did not confirm success';
        if (outcome?.ok === false && outcome.uncertain !== true) {
          try { persist(record); }
          catch { error += '; rollback failed; inspect the reservation'; record = reservation; }
        } else { record = reservation; error += '; reservation retained; inspect PR CI before clearing it'; }
        attempts = record[key]?.workflows ?? attempts;
        result.applied.push({ ...dispatch, ok: false, error });
        continue;
      }
      const confirmed = withAttempt(attempt);
      try { persist(confirmed); record = confirmed; attempts = confirmed[key].workflows; }
      catch {
        result.applied.push({ ...dispatch, ok: false, error: 'confirmation write failed; reservation retained; inspect PR CI' });
        return result;
      }
      try { Promise.resolve(emitEvent({ kind: 'pr-ci-cancelled-rerun', detail: { ...detail, runId, cancelReason } })).catch(() => {}); }
      catch { /* Best-effort; the attempt record is authoritative. */ }
      result.applied.push({ ...dispatch, ok: true });
    }
  }
  return result;
}

export function formatPrCancelledReport({ dispatch = [], refusals = [], applied = [] } = {}) {
  const lines = dispatch.map(d => {
    const outcome = applied.find(a => a.pr === d.pr && a.sha === d.sha && a.runId === d.runId);
    return `${outcome ? (outcome.ok ? '✓' : '✗') : '→'} ${d.action} PR #${d.pr} ${d.sha} run ${d.runId} — ${d.cancelReason}${outcome?.error ? ` — ${outcome.error}` : ''}`;
  });
  for (const r of refusals) lines.push(`✗ pr-cancelled ${r.reason} PR #${r.pr ?? '?'} ${r.sha ?? ''}${r.error ? ` — ${r.error}` : ''}`);
  if (!lines.length) lines.push('ci-red-recovery-watch (pr-cancelled) — no eligible heads');
  return lines.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')).join('\n');
}
