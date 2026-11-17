#!/usr/bin/env node
/**
 * @file scripts/operations/ci-ghost-rerun.mjs
 * @description Standalone, audited recovery of completed-step GitHub Actions ghost jobs.
 * One invocation recovers one workflow; every in-progress Actions check must be a ghost.
 * Incomplete/oversized evidence requires manual inspection in GitHub. A busy state lock
 * requires retry, or operator cleanup after confirming its owner is no longer running.
 */
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleepDefault } from 'node:timers/promises';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { isValidCiGhostRerunSettings, readCiGhostRerunSettings } from '../lib/ci-ghost-rerun-settings.mjs';

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const oneLine = value => typeof value === 'string' && value.trim().length > 0
  && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/u.test(value);
const failure = (reason, exitCode = 2) => ({ reason, exitCode });

/** Pure, conservative classification. No candidate is returned if any job is real/unknown. */
export function detectGhostJobs({ jobs, now, thresholdMin }) {
  const time = Number(now);
  if (!Array.isArray(jobs) || !Number.isFinite(time) || !(thresholdMin > 0)) return failure('not-ghost');
  const pending = jobs.filter(job => job?.status === 'in_progress');
  if (!pending.length) return failure('no-in-progress-job');
  for (const job of pending) {
    if (!Array.isArray(job.steps) || !job.steps.length) return failure('no-steps');
    if (job.steps.some(step => step?.status !== 'completed')) return failure('not-ghost');
    const dates = job.steps.map(step => typeof step.completed_at === 'string' ? Date.parse(step.completed_at) : NaN);
    if (dates.some(date => !Number.isFinite(date))) return failure('not-ghost');
    if (time - Math.max(...dates) <= thresholdMin * 60_000) return failure('too-young');
  }
  return { exitCode: 0, reason: 'ghost', jobs: pending };
}

/** A single JSONL ledger holds audit and counted attempt reservations; the lock spans the effect. */
export function createStateStore(dir = join(homedir(), '.claude', 'ci-ghost-rerun'), io = {
  appendFileSync, mkdirSync, readFileSync, rmdirSync, statSync,
}) {
  const ledger = join(dir, 'attempts.jsonl');
  const lock = join(dir, 'operation.lock');
  return {
    read() {
      let contents;
      try {
        if (io.statSync(ledger).size > 8 * 1024 * 1024) throw new Error('state oversized; archive ledger before retry');
        contents = io.readFileSync(ledger, 'utf8');
      } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return contents.split('\n').filter(Boolean).map(line => {
        const row = JSON.parse(line);
        if (!row || !Number.isFinite(Date.parse(row.ts)) || typeof row.outcome !== 'string'
          || !Object.hasOwn(row, 'counted') || typeof row.counted !== 'boolean'
          || (row.counted && (!row.repo || !positiveId(row.pr) || !row.head))) {
          throw new Error('state unreadable; inspect ledger before retry');
        }
        return row;
      });
    },
    append(row) {
      io.mkdirSync(dir, { recursive: true, mode: 0o700 });
      io.appendFileSync(ledger, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    },
    async withLock(fn) {
      io.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { io.mkdirSync(lock, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') return failure('state-busy', 3); throw error; }
      try { return await fn(); } finally { io.rmdirSync(lock); }
    },
  };
}

/** Injectable runner takes argv, never shell text. POSTs intentionally have no JSON response. */
export function defaultGh(args) {
  const output = execFileSyncThrottled('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.trim() ? JSON.parse(output) : null;
}

export async function runCiGhostRerun(options, {
  gh = defaultGh, clock = Date.now, sleep = sleepDefault,
  state = createStateStore(), settings = readCiGhostRerunSettings(),
} = {}) {
  const { actor, channel, pr, repo = 'web-everything/web-everything', dryRun = false } = options;
  const audit = { ts: new Date(clock()).toISOString(), actor: actor ?? null, channel: channel ?? null,
    repo, pr: pr ?? null, head: null, runId: null, jobId: null };
  let before = null;
  const finish = result => {
    state.append({ ...audit, ts: new Date(clock()).toISOString(), outcome: result.reason, counted: false });
    return { ...result, ...audit, before, newRunAttempt: result.newRunAttempt ?? null };
  };
  const api = (endpoint, method = 'GET') => gh(['api', `repos/${repo}/${endpoint}`, '--method', method]);
  try {
    if (options.invalid || !oneLine(actor) || !/^[a-z\d](?:[a-z\d-]*)(?:\[bot\])?$/i.test(actor)
      || !oneLine(channel)) return finish(failure('invalid-attribution'));
    if (!positiveId(pr) || !/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(repo)) return finish(failure('invalid-target'));
    if (!isValidCiGhostRerunSettings(settings)) {
      return finish(failure('invalid-settings'));
    }
    const result = await state.withLock(async () => {
      const pull = await api(`pulls/${pr}`);
      audit.head = pull?.head?.sha ?? null;
      if (typeof audit.head !== 'string' || !/^[a-f\d]{40}$/i.test(audit.head)) return failure('head-unreadable');
      const checks = await api(`commits/${audit.head}/check-runs?per_page=100`);
      // No partial first-page evidence: the operator must inspect larger runs manually.
      if (!Array.isArray(checks?.check_runs) || !Number.isSafeInteger(checks.total_count)
        || checks.total_count !== checks.check_runs.length || checks.total_count > 100) return failure('checks-incomplete');
      const jobs = [];
      const jobsByRun = new Map();
      for (const check of checks.check_runs) {
        if (check?.app?.slug !== 'github-actions' || check.status !== 'in_progress') continue;
        if (!positiveId(check.id)) return failure('job-unreadable');
        // Checks and Actions jobs have independent IDs. Locate the workflow from
        // its details URL, then join its jobs to the check via check_run_url.
        const checkUrl = `https://api.github.com/repos/${repo}/check-runs/${check.id}`;
        let details;
        try { details = new URL(check.details_url); } catch { return failure('job-unreadable'); }
        const runId = Number(/^\/(.+)\/actions\/runs\/([1-9]\d*)(?:\/job\/[1-9]\d*)?$/.exec(details.pathname)?.[2]);
        if (check.url !== checkUrl || details.origin !== 'https://github.com' || !positiveId(runId)
          || !details.pathname.startsWith(`/${repo}/actions/runs/`)) return failure('job-unreadable');
        if (!jobsByRun.has(runId)) {
          const listed = await api(`actions/runs/${runId}/jobs?per_page=100&filter=latest`);
          if (!Array.isArray(listed?.jobs) || !Number.isSafeInteger(listed.total_count)
            || listed.total_count !== listed.jobs.length || listed.total_count > 100) return failure('jobs-incomplete');
          jobsByRun.set(runId, listed.jobs);
        }
        const matches = jobsByRun.get(runId).filter(job => job?.check_run_url === checkUrl);
        if (matches.length !== 1 || !positiveId(matches[0].id) || matches[0].run_id !== runId) return failure('job-unreadable');
        const job = await api(`actions/jobs/${matches[0].id}`);
        if (job?.id !== matches[0].id || job.run_id !== runId || job.check_run_url !== checkUrl) return failure('job-unreadable');
        if (job.status !== 'in_progress') return failure('not-ghost');
        jobs.push(job);
      }
      const decision = detectGhostJobs({ jobs, now: clock(), thresholdMin: settings.thresholdMin });
      if (decision.exitCode) return decision;
      // Cancellation affects the entire workflow, including siblings absent from checks.
      for (const [runId, listedJobs] of jobsByRun) {
        const validated = new Set(decision.jobs.filter(job => job.run_id === runId).map(job => job.id));
        if (listedJobs.some(job => !job || (job.status !== 'completed'
          && !(job.status === 'in_progress' && validated.has(job.id))))) return failure('sibling-active');
      }
      const job = decision.jobs[0];
      audit.jobId = job.id;
      audit.runId = job.run_id;
      const runPath = `actions/runs/${job.run_id}`;
      const run = await api(runPath);
      before = { status: run?.status ?? null, jobStatus: job.status, runAttempt: run?.run_attempt ?? null };
      if (run?.head_sha !== audit.head) return failure('head-sha-mismatch');
      if (run.id !== job.run_id || !positiveId(run.run_attempt) || run.status !== 'in_progress') return failure('run-unreadable');
      const attempts = await state.read();
      const since = clock() - settings.windowHours * 3_600_000;
      if (attempts.filter(row => row.counted && row.repo === repo && row.pr === pr
        && row.head === audit.head && Date.parse(row.ts) > since).length >= settings.maxPerWindow) return failure('rate-capped', 3);
      if (dryRun) return { exitCode: 0, reason: 'dry-run' };
      // Durable reservation precedes all POSTs, including ambiguous failures and process death.
      await state.append({ ...audit, ts: new Date(clock()).toISOString(), outcome: 'attempt', counted: true });
      const waitCompleted = async () => {
        // At most 13 reads per phase, regardless of injected clock behavior.
        const ticks = Math.min(12, Math.ceil(settings.cancelWaitSec / 5));
        for (let tick = 0; tick <= ticks; tick++) {
          const current = await api(runPath);
          if (current?.id !== job.run_id || current.head_sha !== audit.head) throw new Error('run evidence changed');
          if (current.run_attempt !== run.run_attempt) return failure('run-attempt-changed', 4);
          if (current.status === 'completed') return true;
          if (tick < ticks) await sleep(settings.cancelWaitSec * 1000 / ticks);
        }
        return false;
      };
      try { await api(`${runPath}/cancel`, 'POST'); } catch { /* force-cancel remains available */ }
      let completed = await waitCompleted();
      if (typeof completed !== 'boolean') return completed;
      if (!completed) {
        try {
          await api(`${runPath}/force-cancel`, 'POST');
        } catch { /* still poll to confirm cancellation */ }
        completed = await waitCompleted();
        if (typeof completed !== 'boolean') return completed;
      }
      if (!completed) return failure('cancel-unconfirmed', 4);
      await api(`${runPath}/rerun`, 'POST');
      return { exitCode: 0, reason: 'rerun', newRunAttempt: run.run_attempt + 1 };
    });
    return finish(result);
  } catch {
    // Do not print child output (which can contain untrusted terminal escapes or credentials).
    try { return finish(failure('evidence-or-state-unreadable', 4)); }
    catch { return { ...failure('audit-unwritable', 4), before, newRunAttempt: null }; }
  }
}

export function parseArgs(args) {
  const options = {};
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(pr|actor|channel|repo)=(.*)$/s.exec(arg);
    const key = match?.[1] ?? (arg === '--dry-run' ? 'dryRun' : arg === '--json' ? 'json' : null);
    if (!key || seen.has(key)) { options.invalid = true; continue; }
    seen.add(key);
    options[key] = match ? (key === 'pr' ? Number(match[2]) : match[2]) : true;
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCiGhostRerun(options);
  console.log(options.json ? JSON.stringify(result) :
    `${result.reason}; before=${JSON.stringify(result.before)}; newRunAttempt=${result.newRunAttempt ?? 'none'}`);
  if (result.reason === 'invalid-settings') console.error('Correct or remove invalid ciGhostRerun overrides before retrying: thresholdMin >= 5, maxPerWindow integer 1..3, windowHours 1..24, cancelWaitSec 5..300.');
  else if (result.exitCode) console.error('Inspect workflow evidence in GitHub; retry after the cap/window or state lock clears. Inspect state before removing a stale lock.');
  process.exitCode = result.exitCode;
}
