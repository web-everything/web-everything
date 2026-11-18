#!/usr/bin/env node
/**
 * @file ci-durations.mjs — recent CI execution and runner-wait percentiles (seconds).
 * Usage: node scripts/ci/ci-durations.mjs [--workflow=ci.yml] [--branch=main] [--limit=10] [--json]
 * Read-only: one run list, at most ten job views and ten jobs API reads (21 logical calls; the gh throttle may add its own retries, which are not counted),
 * through gh-throttle without a shell. Each API read is capped at 100 jobs; larger
 * runs require manual inspection of paginated API evidence rather than a partial summary.
 * Run duration uses updatedAt as the completion proxy supplied by gh run list. Job duration
 * uses completedAt; wait uses the REST job's created_at, joined to the CLI job by ID
 * (gh run view omits creation time). Missing creation evidence aborts collection. Other missing samples
 * are omitted, with null percentiles/count zero when no evidence exists. Percentiles use
 * linear interpolation at (n - 1) * p. Errors abort without printing a partial report.
 */
import { pathToFileURL } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';

export function parseArgs(argv) {
  const options = { workflow: 'ci.yml', branch: 'main', limit: 10, json: false };
  for (const arg of argv) {
    if (arg === '--json') { options.json = true; continue; }
    const match = /^--(workflow|branch|limit)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown or empty option: ${arg}`);
    const [, key, value] = match;
    if (key === 'limit') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new Error('--limit must be a positive safe integer (maximum 10; larger values are capped)');
      }
      options.limit = Math.min(10, Number(value));
    } else options[key] = value;
  }
  return options;
}

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p;
    const lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
  };
  return { count: sorted.length, p50: at(0.5), p90: at(0.9) };
}

function seconds(start, end) {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

export function summarizeDurations(runs) {
  const jobs = new Map();
  const runSamples = { duration: [], wait: [] };
  const add = (samples, duration, wait) => {
    if (duration !== null) samples.duration.push(duration);
    if (wait !== null) samples.wait.push(wait);
  };
  const summarize = (samples) => ({ duration: percentiles(samples.duration), wait: percentiles(samples.wait) });
  for (const run of runs) {
    if (run.status !== 'completed' || run.conclusion === 'skipped') continue;
    add(runSamples, seconds(run.startedAt, run.updatedAt), seconds(run.createdAt, run.startedAt));
    if (!Array.isArray(run.jobs)) throw new Error('Incomplete job evidence: expected jobs array');
    for (const job of run.jobs) {
      if (job.status !== 'completed' || job.conclusion === 'skipped' || typeof job.name !== 'string') continue;
      const duration = seconds(job.startedAt, job.completedAt);
      if (duration === null) continue;
      if (!jobs.has(job.name)) jobs.set(job.name, { duration: [], wait: [] });
      add(jobs.get(job.name), duration, seconds(job.createdAt, job.startedAt));
    }
  }
  return { runs: summarize(runSamples), jobs: Object.fromEntries([...jobs].sort(([a], [b]) => a.localeCompare(b)).map(([name, samples]) => [name, summarize(samples)])) };
}

export function collectDurations(options, exec = execFileSyncThrottled) {
  const limit = parseArgs([`--limit=${options.limit ?? 10}`]).limit;
  const read = (args) => JSON.parse(exec('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }));
  const runs = read(['run', 'list', '--workflow', options.workflow, '--branch', options.branch,
    '--limit', String(limit), '--status', 'completed', '--json', 'databaseId,status,conclusion,createdAt,startedAt,updatedAt']);
  if (!Array.isArray(runs) || runs.length > limit) throw new Error('Invalid or oversized run list; lower --limit and retry');
  const ids = new Set();
  for (const run of runs) {
    if (!Number.isSafeInteger(run?.databaseId) || run.databaseId < 1 || ids.has(run.databaseId)) {
      throw new Error('Invalid or duplicate run ID; inspect gh run list evidence and retry');
    }
    ids.add(run.databaseId);
  }
  return summarizeDurations(runs.map(run => {
    const view = read(['run', 'view', String(run.databaseId), '--json', 'jobs']);
    if (!Array.isArray(view?.jobs)) throw new Error('Incomplete job evidence: expected jobs array');
    const api = read(['api', `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs?per_page=100&filter=latest`]);
    if (!Array.isArray(api?.jobs) || !Number.isSafeInteger(api.total_count) || api.total_count < 0 ||
        api.total_count > 100 || api.jobs.length !== api.total_count) {
      throw new Error('Incomplete or oversized jobs API evidence (100-job cap); inspect the paginated jobs API manually');
    }
    const byId = new Map();
    for (const job of api.jobs) {
      if (!Number.isSafeInteger(job?.id) || job.id < 1 || byId.has(job.id)) {
        throw new Error('Invalid or duplicate API job ID; inspect jobs API evidence and retry');
      }
      byId.set(job.id, job);
    }
    // Every finished REST job must appear in the CLI view; a truncated view must not yield a quiet partial summary.
    const viewIds = new Set(view.jobs.map(job => job.databaseId));
    if (api.jobs.some(job => job.status === 'completed' && job.conclusion !== 'skipped' && !viewIds.has(job.id))) {
      throw new Error('Job views are missing completed jobs from the jobs API; retry or inspect the run');
    }
    const jobs = view.jobs.map(job => {
      if (job.status !== 'completed' || job.conclusion === 'skipped') return job;
      if (seconds(job.startedAt, job.completedAt) === null) throw new Error('Invalid CLI job timestamps for a completed job; inspect the run and retry');
      const createdAt = byId.get(job.databaseId)?.created_at;
      if (seconds(createdAt, job.startedAt) === null) {
        throw new Error('Missing or invalid job creation evidence; inspect jobs API timestamps/IDs and retry');
      }
      return { ...job, createdAt };
    });
    return { ...run, jobs };
  }));
}

export function formatTable(report) {
  const number = (value) => value === null ? 'n/a' : value.toFixed(1);
  const row = (name, samples) => [name.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '),
    samples.duration.count, number(samples.duration.p50), number(samples.duration.p90),
    samples.wait.count, number(samples.wait.p50), number(samples.wait.p90)].join('\t');
  return ['name\tduration n\tp50 s\tp90 s\twait n\tp50 s\tp90 s',
    row('Run (end=updatedAt)', report.runs), ...Object.entries(report.jobs).map(([name, samples]) => row(name, samples))].join('\n');
}

export function main(argv, exec = execFileSyncThrottled, output = (text) => process.stdout.write(text)) {
  const options = parseArgs(argv);
  const report = collectDurations(options, exec);
  output(`${options.json ? JSON.stringify(report, null, 2) : formatTable(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${String(error.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\n`); process.exitCode = 1; }
}
