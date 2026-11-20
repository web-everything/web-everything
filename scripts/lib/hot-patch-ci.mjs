/**
 * @file scripts/lib/hot-patch-ci.mjs
 * @description Exact-SHA hot-patch CI evidence from required jobs on mapped Actions workflows.
 * GitHub reads are injected; unreadable or ambiguous evidence is unknown, never green.
 */
import { readRequiredStatusChecksDetailed } from './required-status-checks.mjs';

export const REQUIRED_CHECK_WORKFLOW = Object.freeze({
  test: '.github/workflows/ci.yml',
  smoke: '.github/workflows/ci.yml',
  'daemon-soak': '.github/workflows/ci.yml',
  'soak-replay-gate': '.github/workflows/soak-replay-gate.yml',
});
const REPO = 'web-everything/web-everything';
const validId = id => ['string', 'number'].includes(typeof id) && /^[1-9][0-9]*$/.test(String(id))
  && (typeof id !== 'number' || Number.isSafeInteger(id));

/** Unreadable or degraded policy cannot authorize a hot patch. */
export function requiredChecksForMain(read = readRequiredStatusChecksDetailed) {
  try {
    const { checks, partialChecks, source } = read({ repo: REPO, branch: 'main' });
    if (partialChecks !== undefined || (source !== undefined && !['live', 'cache'].includes(source))) return null;
    return Array.isArray(checks) && checks.length && checks.every(name => typeof name === 'string' && name.length)
      ? checks : null;
  } catch { return null; }
}

class IncompleteCiEvidence extends Error {}

/** At most ten 100-item pages per collection; incomplete evidence never authorizes green. */
async function readPages(fetchJson, path, key, observe = () => {}) {
  const items = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const payload = await fetchJson(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(payload?.[key])) throw new IncompleteCiEvidence('Unreadable Actions page; repair access and retry');
    if (payload.total_count !== undefined) {
      if (!Number.isSafeInteger(payload.total_count) || payload.total_count < 0) throw new IncompleteCiEvidence('Invalid Actions total; inspect workflows manually');
      total = Math.max(total ?? 0, payload.total_count);
    }
    observe(payload[key]);
    items.push(...payload[key]);
    if (total !== undefined && items.length >= total) return items;
    if (payload[key].length < 100) {
      if (total !== undefined && items.length < total) throw new IncompleteCiEvidence('Incomplete Actions pages; inspect workflows manually or retry');
      return items;
    }
  }
  throw new IncompleteCiEvidence('Actions page cap reached; inspect workflows manually or retry with complete evidence');
}

/** Evaluate required jobs on each workflow's newest trusted run, ordered by numeric ID. */
export async function hotPatchCiVerdict({ repo, sha, required, fetchJson } = {}) {
  let pending = false, red = false;
  const unknown = reason => red
    ? { state: 'red', reason: 'A required Actions job completed without success' }
    : { state: 'unknown', reason };
  if (repo !== REPO) return unknown('Unsupported hot-patch repository');
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) return unknown('Invalid commit SHA');
  if (!Array.isArray(required) || !required.length) return unknown('Required-check policy unreadable');
  if (required.some(name => typeof name !== 'string' || !Object.hasOwn(REQUIRED_CHECK_WORKFLOW, name)))
    return unknown('Required check has no trusted workflow mapping');
  const workflows = new Map();
  for (const name of new Set(required)) {
    const path = REQUIRED_CHECK_WORKFLOW[name];
    if (!workflows.has(path)) workflows.set(path, []);
    workflows.get(path).push(name);
  }
  try {
    for (const [workflow, names] of workflows) {
      const filename = workflow.split('/').at(-1);
      const runs = await readPages(fetchJson, `/repos/${repo}/actions/workflows/${filename}/runs?head_sha=${sha}`, 'workflow_runs');
      const candidates = [], ids = new Set();
      for (const run of runs) {
        if (run?.head_sha !== sha) continue;
        // Preserve string precision above 2^53; a rounded numeric ID cannot establish ordering.
        if (!validId(run.id) || !validId(run.check_suite_id))
          return unknown('Invalid Actions run ID');
        // Workflow runs expose check_suite_id, not app; verify the linked producer explicitly.
        const suite = await fetchJson(`/repos/${repo}/check-suites/${run.check_suite_id}`);
        if (!validId(suite?.id) || BigInt(suite.id) !== BigInt(run.check_suite_id) || suite.head_sha !== sha)
          return unknown('Unreadable or mismatched Actions check suite');
        if (suite.app?.id !== 15368 || suite.app?.slug !== 'github-actions') continue;
        const id = BigInt(run.id);
        if (ids.has(id)) return unknown('Ambiguous equal Actions run IDs');
        ids.add(id);
        candidates.push({ run, id });
      }
      candidates.sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
      if (!candidates.length) return unknown('No trusted exact-SHA Actions run');
      const { run } = candidates[0];
      const allJobs = await readPages(fetchJson, `/repos/${repo}/actions/runs/${run.id}/jobs`, 'jobs', jobs => {
        // Preserve trusted red evidence even when a subsequent jobs page is unavailable.
        if (jobs.some(job => names.includes(job?.name) && job.status === 'completed'
          && typeof job.conclusion === 'string' && job.conclusion.length && job.conclusion !== 'success')) red = true;
      });
      for (const name of names) {
        const jobs = allJobs.filter(job => job?.name === name);
        if (!jobs.length) { pending = true; continue; }
        for (const job of jobs) {
          if (typeof job.status !== 'string' || !job.status.length) return unknown('Required job status unreadable');
          if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(job.status)) { pending = true; continue; }
          if (job.status !== 'completed') return unknown('Required job status unreadable');
          if (typeof job.conclusion !== 'string' || !job.conclusion.length)
            return unknown('Completed required job conclusion unreadable');
          if (job.conclusion !== 'success') red = true;
        }
      }
    }
    if (red) return { state: 'red', reason: 'A required Actions job completed without success' };
    if (pending) return { state: 'pending', reason: 'Required Actions jobs are missing or unfinished' };
    return { state: 'green', reason: 'Every required Actions job succeeded for the exact SHA' };
  } catch (error) {
    if (error instanceof IncompleteCiEvidence) return unknown(error.message);
    return unknown('CI evidence unavailable; repair GitHub access or retry the exact-SHA workflow read');
  }
}
