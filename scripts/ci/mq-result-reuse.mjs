#!/usr/bin/env node
// mq-result-reuse (CI-MAIN-REUSE-MQ). On a main push, decide whether the merge queue already ran CI IN FULL for
// this exact commit sha. If so, main may skip the heavy jobs and record that result; any doubt (no run, other sha,
// partial run, failed run, API error) means a full run. Fail closed: the verdict is reuse=false unless proven.
// Usage (CI): node scripts/ci/mq-result-reuse.mjs   env: GITHUB_SHA GITHUB_REPOSITORY GITHUB_TOKEN GITHUB_EVENT_NAME
// Writes reuse=true|false to $GITHUB_OUTPUT and one summary line to $GITHUB_STEP_SUMMARY and stdout.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CI_WORKFLOW_ID = 382175354;
// A full run has at least one successful job in every one of these groups (a light/card-only or soak-scoped
// merge-group run skips them, so it is partial and never reused).
export const FULL_RUN_GROUPS = ['test-shard', 'integration-part', 'soak-shard'];

const groupOf = (name) => FULL_RUN_GROUPS.find((g) => name === g || name.startsWith(`${g} `) || name.startsWith(`${g} (`));

/** Pure verdict over one merge_group run and its jobs. */
export function judgeRun(run, jobs, sha) {
  if (!run || run.event !== 'merge_group') return { reuse: false, why: 'not a merge_group run' };
  if (run.head_sha !== sha) return { reuse: false, why: 'different sha' };
  if (run.status !== 'completed' || run.conclusion !== 'success') return { reuse: false, why: `run ${run.status}/${run.conclusion}` };
  const seen = new Map(FULL_RUN_GROUPS.map((g) => [g, 0]));
  for (const job of jobs ?? []) {
    const g = groupOf(String(job.name ?? ''));
    if (g) {
      if (job.conclusion !== 'success') return { reuse: false, why: `${job.name} was ${job.conclusion}` };
      seen.set(g, seen.get(g) + 1);
    } else if (job.conclusion === 'skipped' && /^(test|smoke|daemon-soak)$/.test(String(job.name))) {
      return { reuse: false, why: `${job.name} skipped` };
    }
  }
  for (const [g, n] of seen) if (n === 0) return { reuse: false, why: `partial run: no ${g} job ran` };
  return { reuse: true, why: 'merge-queue run succeeded in full' };
}

/** Find the verdict via the GitHub API. `api(path)` returns parsed JSON. Any throw means reuse=false. */
export async function decide({ api, repo, sha, event }) {
  if (event !== 'push') return { reuse: false, why: `event ${event} is not a main push` };
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) return { reuse: false, why: 'no full sha' };
  try {
    const runs = await api(`/repos/${repo}/actions/workflows/${CI_WORKFLOW_ID}/runs?event=merge_group&head_sha=${sha}&per_page=20`);
    const candidates = (runs.workflow_runs ?? []).filter((r) => r.head_sha === sha && r.event === 'merge_group');
    if (candidates.length === 0) return { reuse: false, why: 'no merge-queue run for this sha' };
    let last = { reuse: false, why: 'no usable run' };
    for (const run of candidates) {
      const jobs = [];
      for (let page = 1; page <= 5; page += 1) {
        const res = await api(`/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
        jobs.push(...(res.jobs ?? []));
        if ((res.jobs ?? []).length < 100) break;
      }
      last = judgeRun(run, jobs, sha);
      if (last.reuse) return { ...last, runId: run.id };
    }
    return last;
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
  const v = await decide({ api, repo, sha, event });
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
