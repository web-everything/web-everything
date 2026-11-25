#!/usr/bin/env node
// mq-result-reuse (CI-MAIN-REUSE-MQ). On a main push, decide whether the merge queue already ran CI IN FULL for
// this exact commit sha. If so, main may skip the heavy jobs and record that result; any doubt (no run, other sha,
// partial run, failed run, API error) means a full run. Fail closed: the verdict is reuse=false unless proven.
// Usage (CI): node scripts/ci/mq-result-reuse.mjs   env: GITHUB_SHA GITHUB_REPOSITORY GITHUB_TOKEN GITHUB_EVENT_NAME
// Writes reuse=true|false to $GITHUB_OUTPUT and one summary line to $GITHUB_STEP_SUMMARY and stdout.
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CI_WORKFLOW_ID = 382175354;
// Interface forge.merge-queue: a queue result is reusable only for the exact same integration state (same sha).
// FULL-RUN EVIDENCE: every matrix job of every heavy group ran and succeeded, and every aggregate/required job
// succeeded (a light/card-only or soak-scoped merge-group run skips some of these, so it is never reused). The
// expected names mirror the matrices in ci.yml (a test pins them to the workflow).
export const EXPECTED_MATRIX_JOBS = [
  ...Array.from({ length: 10 }, (_, i) => `test-shard (${i + 1})`),
  ...['scan-chain', 'sim-scenarios', 'lane-pool-a', 'lane-pool-b', 'parallel'].map((g) => `integration-part (${g})`),
  ...Array.from({ length: 8 }, (_, i) => `soak-shard (${i + 1})`),
];
export const REQUIRED_JOBS = ['changes', 'standards', 'coverage-merge', 'host-paths', 'integration', 'test', 'smoke', 'daemon-soak'];
export const FULL_TEST_RECEIPT = 'Full test run (no quarantine exclusions)';

/** Pure verdict over one merge_group run and its COMPLETE job list. */
export function judgeRun(run, jobs, sha) {
  if (!run || run.event !== 'merge_group') return { reuse: false, why: 'not a merge_group run' };
  if (run.head_sha !== sha) return { reuse: false, why: 'different sha' };
  if (run.status !== 'completed' || run.conclusion !== 'success') return { reuse: false, why: `run ${run.status}/${run.conclusion}` };
  const byName = new Map();
  for (const job of jobs ?? []) byName.set(String(job.name ?? ''), job);
  for (const name of [...EXPECTED_MATRIX_JOBS, ...REQUIRED_JOBS]) {
    const job = byName.get(name);
    if (!job) return { reuse: false, why: `partial run: no ${name} job` };
    if (job.conclusion !== 'success') return { reuse: false, why: `${name} was ${job.conclusion}` };
    // A successful job may have excluded quarantined tests. Require evidence from its actual runner args,
    // rather than reconstructing historical quarantine from today's list (entries can expire or be removed).
    if (EXPECTED_MATRIX_JOBS.includes(name) && !job.steps?.some(s => s.name === FULL_TEST_RECEIPT && s.conclusion === 'success')) {
      return { reuse: false, why: `partial run: no full-test receipt for ${name}` };
    }
  }
  return { reuse: true, why: 'merge-queue run succeeded in full' };
}

/**
 * Provider-neutral reuse rule (forge.merge-queue: the tested integration state; forge.check-status: the checks'
 * outcomes). NO provider calls here: every read is injected.
 *   listQueueRuns(sha) -> [{id, head_sha, event, status, conclusion}]  merge-queue runs of that exact state
 *   listRunJobs(runId) -> [{name, conclusion}]  the COMPLETE job list (the adapter throws if it cannot prove completeness)
 *   quarantineClear()  -> true only when today's quarantine is readable and clear. Per-job full-test receipts
 *                         independently prove that the queue did not skip tests under historical quarantine.
 * Any throw means reuse=false.
 */
export async function decide({ listQueueRuns, listRunJobs, sha, event, quarantineClear = async () => false }) {
  if (event !== 'push') return { reuse: false, why: `event ${event} is not a main push` };
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return { reuse: false, why: 'no full sha' };
  try {
    const candidates = ((await listQueueRuns(sha)) ?? [])
      .filter((r) => r.head_sha === sha && r.event === 'merge_group')
      .sort((a, b) => Number(b.id) - Number(a.id));
    if (candidates.length === 0) return { reuse: false, why: 'no merge-queue run for this sha' };
    // Only the NEWEST run for the sha counts: a newer failed or unfinished run is contrary evidence.
    const run = candidates[0];
    const verdict = judgeRun(run, await listRunJobs(run.id), sha);
    if (!verdict.reuse) return verdict;
    if (!(await quarantineClear())) return { reuse: false, why: 'red-main quarantine active or unreadable' };
    return { ...verdict, runId: run.id };
  } catch (err) {
    return { reuse: false, why: `error: ${err?.message ?? err}` };
  }
}

/** GitHub adapter for the two reads (the only place that knows the provider). */
export function githubReads({ repo, token, fetchImpl = fetch, timeoutMs = 30_000 }) {
  // One budget for all pages and response bodies, not a fresh budget for every request.
  const signal = AbortSignal.timeout(timeoutMs);
  const api = async (path) => {
    signal.throwIfAborted();
    const res = await fetchImpl(`https://api.github.com${path}`, {
      signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
  };
  return {
    listQueueRuns: async (sha) => {
      // Ruleset-pinned queue workflow IDs are not addressable via /actions/workflows/<id>/runs.
      // Read the repository endpoint, then filter identity only after proving the listing complete.
      const runs = [];
      let total;
      for (let page = 1; page <= 10; page += 1) {
        const res = await api(`/repos/${repo}/actions/runs?event=merge_group&head_sha=${sha}&per_page=100&page=${page}`);
        if (!Array.isArray(res.workflow_runs) || !Number.isInteger(res.total_count) || res.total_count < 0
          || res.total_count > 1000 || (total !== undefined && total !== res.total_count)) throw new Error('incomplete runs listing');
        total = res.total_count;
        runs.push(...res.workflow_runs);
        if (runs.length >= total || res.workflow_runs.length === 0) break;
      }
      if (runs.length !== total || runs.some(r => !Number.isSafeInteger(r?.id) || r.id <= 0)
        || new Set(runs.map(r => r.id)).size !== total) throw new Error('runs listing incomplete');
      return runs.filter(r => r.workflow_id === CI_WORKFLOW_ID);
    },
    listRunJobs: async (runId) => {
      const jobs = [];
      let total = null;
      for (let page = 1; page <= 10; page += 1) {
        const res = await api(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
        if (!Array.isArray(res.jobs) || !Number.isInteger(res.total_count)) throw new Error('incomplete jobs listing');
        total = res.total_count;
        jobs.push(...res.jobs);
        if (jobs.length >= total || res.jobs.length === 0) break;
      }
      if (jobs.length !== total) throw new Error('jobs listing incomplete');
      return jobs;
    },
  };
}

/** Current quarantine guard; injected dependencies also exercise the real adapter without network access. */
export async function quarantineClear({ readQuarantine, activeEntries, board = process.cwd(), run, now = Date.now() } = {}) {
  const rules = await import('../lib/red-main-quarantine.mjs');
  activeEntries ??= rules.activeEntries;
  if (!readQuarantine) {
    // This checkout-only job must not load the quarantine writer's npm dependencies.
    // Reuse the shared transport and schema, within the optional step's one-minute budget.
    const { readFromTransportBranch } = await import('../lib/git-transport-branch.mjs');
    readQuarantine = ({ board, run = (args, options) => execFileSync('git', args, options) }) => {
      const deadline = Date.now() + 15_000;
      const boundedRun = (args, options) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('quarantine read timed out');
        return run(args, {
          ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          timeout: Math.min(5000, remaining), maxBuffer: 16 * 1024 * 1024,
        });
      };
      try {
        const got = readFromTransportBranch({ board, branch: rules.QUARANTINE_BRANCH, paths: [rules.QUARANTINE_LIST_PATH], run: boundedRun });
        const text = got[rules.QUARANTINE_LIST_PATH];
        const list = text == null ? { version: 1, entries: [] } : JSON.parse(text);
        return { ok: rules.validateQuarantineList(list).ok, list };
      } catch { return { ok: false }; }
    };
  }
  const got = readQuarantine({ board, ...(run ? { run } : {}) });
  return got.ok === true && activeEntries(got.list, { now }).length === 0;
}

export async function main({ env = process.env, fetchImpl = fetch, quarantineOptions } = {}) {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, GITHUB_EVENT_NAME: event } = env;
  const v = await decide({ ...githubReads({ repo, token, fetchImpl }), sha, event, quarantineClear: () => quarantineClear(quarantineOptions) });
  const line = v.reuse
    ? `mq-result-reuse: REUSING merge-queue run ${v.runId} for ${sha}; heavy jobs skipped (${v.why})`
    : `mq-result-reuse: full run (${v.why})`;
  console.log(line);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reuse=${v.reuse ? 'true' : 'false'}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.log(`mq-result-reuse: full run (error: ${err?.message ?? err})`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'reuse=false\n');
  });
}
