#!/usr/bin/env node
// mq-result-reuse (CI-MAIN-REUSE-MQ). On a main push, decide whether the merge queue already ran CI IN FULL for
// this exact commit sha. If so, main may skip the heavy jobs and record that result; any doubt (no run, other sha,
// partial run, failed run, API error) means a full run. Fail closed: the verdict is reuse=false unless proven.
// Usage (CI): node scripts/ci/mq-result-reuse.mjs   env: GITHUB_SHA GITHUB_REPOSITORY GITHUB_TOKEN GITHUB_EVENT_NAME
// Writes reuse=true|false to $GITHUB_OUTPUT and one summary line to $GITHUB_STEP_SUMMARY and stdout.
import { appendFileSync } from 'node:fs';
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
  }
  return { reuse: true, why: 'merge-queue run succeeded in full' };
}

/**
 * Find the verdict via the GitHub API. `api(path)` returns parsed JSON. Any throw means reuse=false.
 * `quarantineClear()` resolves true only when no red-main quarantine entry is active (the queue may have skipped
 * quarantined tests; main runs every test).
 */
export async function decide({ api, repo, sha, event, quarantineClear = async () => false }) {
  if (event !== 'push') return { reuse: false, why: `event ${event} is not a main push` };
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return { reuse: false, why: 'no full sha' };
  try {
    const runs = await api(`/repos/${repo}/actions/workflows/${CI_WORKFLOW_ID}/runs?event=merge_group&head_sha=${sha}&per_page=20`);
    const candidates = (runs.workflow_runs ?? [])
      .filter((r) => r.head_sha === sha && r.event === 'merge_group')
      .sort((a, b) => Number(b.id) - Number(a.id));
    if (candidates.length === 0) return { reuse: false, why: 'no merge-queue run for this sha' };
    // Only the NEWEST run for the sha counts: a newer failed or unfinished run is contrary evidence.
    const run = candidates[0];
    const jobs = [];
    let total = null;
    for (let page = 1; page <= 10; page += 1) {
      const res = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
      if (!Array.isArray(res.jobs) || !Number.isInteger(res.total_count)) return { reuse: false, why: 'incomplete jobs listing' };
      total = res.total_count;
      jobs.push(...res.jobs);
      if (jobs.length >= total || res.jobs.length === 0) break;
    }
    if (jobs.length !== total) return { reuse: false, why: 'jobs listing incomplete' };
    const verdict = judgeRun(run, jobs, sha);
    if (!verdict.reuse) return verdict;
    if (!(await quarantineClear())) return { reuse: false, why: 'red-main quarantine active or unreadable' };
    return { ...verdict, runId: run.id };
  } catch (err) {
    return { reuse: false, why: `error: ${err?.message ?? err}` };
  }
}

async function main() {
  const { GITHUB_SHA: sha, GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, GITHUB_EVENT_NAME: event } = process.env;
  const api = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
  };
  const quarantineClear = async () => {
    const { readQuarantine } = await import('../lib/red-main-quarantine-io.mjs');
    const { activeEntries } = await import('../lib/red-main-quarantine.mjs');
    const got = readQuarantine({});
    return got.ok === true && activeEntries(got.list, { now: Date.now() }).length === 0;
  };
  const v = await decide({ api, repo, sha, event, quarantineClear });
  const line = v.reuse
    ? `mq-result-reuse: REUSING merge-queue run ${v.runId} for ${sha}; heavy jobs skipped (${v.why})`
    : `mq-result-reuse: full run (${v.why})`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${v.reuse ? 'true' : 'false'}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.log(`mq-result-reuse: full run (error: ${err?.message ?? err})`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'reuse=false\n');
  });
}
