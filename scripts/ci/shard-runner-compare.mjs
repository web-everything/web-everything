#!/usr/bin/env node
/**
 * @file scripts/ci/shard-runner-compare.mjs
 * @description #5027 — measurement helper for the Arm-runner experiment. `ci.yml`'s `test-shard` job runs on
 * `${{ vars.WE_SHARD_RUNNER || 'ubuntu-latest' }}`; this tabulates its shard jobs per runner type (x86 vs
 * Arm) — median and p90 shard minutes, failures, flakes, queue wait — so the keep-or-revert call is made from
 * numbers pasted onto the card, not from a feel.
 *
 * Runner type comes from the job's runner labels (`gh api …/runs/<id>/jobs` carries `labels` +
 * `runner_name`; `gh run view --json jobs` does not, so the CLI uses the API). Both snake_case (REST) and
 * camelCase (`gh … --json`) job shapes are accepted. A job with no runner info is bucketed `unknown`, never
 * guessed into x86 or Arm.
 *
 * Definitions:
 *   - duration = completed − started (run time, NOT queue; queue = started − created is reported alongside).
 *   - failure  = a shard job that ended `failure` or `timed_out` (cancelled / skipped jobs are ignored — they
 *     measure nothing about the runner).
 *   - flake    = a failed shard job whose SAME shard on the SAME commit later (or elsewhere) passed — i.e. the
 *     failure did not reproduce on a re-run. Attributed to the runner the failed job ran on.
 *   - percentiles use nearest-rank (p90 of 30 samples is the 27th smallest), so they are always an observed value.
 *
 * Usage: node scripts/ci/shard-runner-compare.mjs [--limit=80] [--per-runner=30] [--workflow=ci.yml]
 *                                                 [--input=<jobs.json>] [--json]
 *   --input reads an array of job objects instead of calling `gh` (offline / re-analysis).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SHARD_JOB_RE = /^test-shard \(\d+\)$/;
const FAIL_CONCLUSIONS = new Set(['failure', 'timed_out']);
const SETTLED_CONCLUSIONS = new Set(['success', ...FAIL_CONCLUSIONS]);

/** @param {string|undefined|null} iso @returns {number|null} epoch ms, or null when absent/unparseable */
function ms(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Normalise one job from either the REST API (snake_case) or `gh … --json jobs` (camelCase).
 * @param {Record<string, any>} job
 * @param {{runId?: number|string, headSha?: string}} [ctx] run-level fields the job object may lack
 */
export function normalizeJob(job, ctx = {}) {
  const labels = Array.isArray(job.labels) ? job.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
  return {
    runId: job.run_id ?? job.runId ?? ctx.runId ?? null,
    headSha: job.head_sha ?? job.headSha ?? ctx.headSha ?? null,
    name: String(job.name ?? ''),
    conclusion: job.conclusion ?? null,
    createdAt: job.created_at ?? job.createdAt ?? null,
    startedAt: job.started_at ?? job.startedAt ?? null,
    completedAt: job.completed_at ?? job.completedAt ?? null,
    labels,
    runnerName: job.runner_name ?? job.runnerName ?? null,
  };
}

/**
 * Bucket a job by runner type. Arm if any label (or the runner name) says `arm`; x86 if it has runner info
 * that does not; `unknown` when there is no runner info at all.
 * @param {{labels?: string[], runnerName?: string|null}} job
 * @returns {'arm'|'x86'|'unknown'}
 */
export function classifyRunner(job) {
  const labels = job.labels ?? [];
  if (labels.some((l) => /(^|[-_.])arm(64)?($|[-_.])/i.test(l))) return 'arm';
  if (labels.length > 0) return 'x86';
  if (job.runnerName) return /arm/i.test(job.runnerName) ? 'arm' : 'x86';
  return 'unknown';
}

/** Nearest-rank percentile of an unsorted numeric list; null for an empty list. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

/**
 * Tabulate shard jobs per runner type.
 * @param {Array<Record<string, any>>} rawJobs REST- or gh-shaped job objects (any workflow; non-shard jobs are ignored)
 * @param {{perRunner?: number}} [opts] perRunner — keep only the newest N runs per runner type (the "~30 each" sample)
 */
export function compareRunners(rawJobs, { perRunner = Infinity } = {}) {
  const shardJobs = rawJobs.map((j) => normalizeJob(j)).filter((j) => SHARD_JOB_RE.test(j.name) && SETTLED_CONCLUSIONS.has(j.conclusion));

  // Sample the newest `perRunner` runs of each runner type, by each run's latest job start.
  const runInfo = new Map(); // runId → { runner, last }
  for (const j of shardJobs) {
    const key = j.runId ?? `${j.headSha}:${j.name}`;
    const last = ms(j.startedAt) ?? 0;
    const cur = runInfo.get(key);
    if (!cur) runInfo.set(key, { runner: classifyRunner(j), last });
    else cur.last = Math.max(cur.last, last);
  }
  const keep = new Set();
  for (const runner of ['x86', 'arm', 'unknown']) {
    [...runInfo.entries()]
      .filter(([, v]) => v.runner === runner)
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, perRunner)
      .forEach(([k]) => keep.add(k));
  }
  const sampled = shardJobs.filter((j) => keep.has(j.runId ?? `${j.headSha}:${j.name}`));

  // A failed shard is a flake when the same shard on the same commit also passed.
  const passedKeys = new Set(sampled.filter((j) => j.conclusion === 'success').map((j) => `${j.headSha}|${j.name}`));

  const buckets = {};
  for (const j of sampled) {
    const runner = classifyRunner(j);
    const b = (buckets[runner] ??= { runs: new Set(), durations: [], queues: [], failures: 0, flakes: 0 });
    b.runs.add(j.runId ?? `${j.headSha}:${j.name}`);
    if (FAIL_CONCLUSIONS.has(j.conclusion)) {
      b.failures += 1;
      if (j.headSha && passedKeys.has(`${j.headSha}|${j.name}`)) b.flakes += 1;
    }
    const start = ms(j.startedAt);
    const end = ms(j.completedAt);
    if (start !== null && end !== null && end >= start) b.durations.push((end - start) / 60000);
    const created = ms(j.createdAt);
    if (created !== null && start !== null && start >= created) b.queues.push((start - created) / 60000);
  }

  const out = {};
  for (const [runner, b] of Object.entries(buckets)) {
    out[runner] = {
      runs: b.runs.size,
      shardJobs: b.durations.length,
      medianMin: round1(percentile(b.durations, 50)),
      p90Min: round1(percentile(b.durations, 90)),
      medianQueueMin: round1(percentile(b.queues, 50)),
      failures: b.failures,
      flakes: b.flakes,
    };
  }
  return out;
}

/** Render `compareRunners` output as the markdown table pasted onto the card. */
export function formatTable(result) {
  const rows = ['x86', 'arm', 'unknown'].filter((r) => result[r]);
  const fmt = (v) => (v === null ? 'n/a' : String(v));
  const lines = [
    '| runner | runs | shard jobs | median shard min | p90 shard min | median queue min | failures | flakes |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      const s = result[r];
      return `| ${r} | ${s.runs} | ${s.shardJobs} | ${fmt(s.medianMin)} | ${fmt(s.p90Min)} | ${fmt(s.medianQueueMin)} | ${s.failures} | ${s.flakes} |`;
    }),
  ];
  if (rows.length === 0) lines.push('| _no completed test-shard jobs found_ | | | | | | | |');
  return lines.join('\n');
}

/**
 * Pull shard jobs for the most recent completed runs of a workflow via `gh`.
 * @param {{workflow?: string, limit?: number, exec?: (cmd: string, args: string[]) => string}} [opts]
 *   exec is injectable so the wiring is testable without the network.
 */
export function fetchShardJobs({ workflow = 'ci.yml', limit = 80, exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) } = {}) {
  const runs = JSON.parse(exec('gh', ['run', 'list', `--workflow=${workflow}`, '--status=completed', `--limit=${limit}`, '--json=databaseId,headSha']));
  const jobs = [];
  for (const run of runs) {
    // filter=all includes jobs from earlier attempts of a re-run — exactly what flake detection needs.
    const body = JSON.parse(exec('gh', ['api', `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs?filter=all&per_page=100`]));
    for (const job of body.jobs ?? []) {
      if (SHARD_JOB_RE.test(String(job.name))) jobs.push(normalizeJob(job, { runId: run.databaseId, headSha: run.headSha }));
    }
  }
  return jobs;
}

function parseFlags(argv) {
  return Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }));
}

export function main(argv = process.argv.slice(2), { exec } = {}) {
  const flags = parseFlags(argv);
  const jobs = flags.input
    ? JSON.parse(readFileSync(String(flags.input), 'utf8'))
    : fetchShardJobs({ workflow: flags.workflow || 'ci.yml', limit: Number(flags.limit) || 80, exec });
  const result = compareRunners(jobs, { perRunner: Number(flags['per-runner']) || 30 });
  process.stdout.write((flags.json ? JSON.stringify(result, null, 2) : formatTable(result)) + '\n');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
