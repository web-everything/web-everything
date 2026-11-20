/**
 * @file scripts/lib/hot-patch-ci.mjs
 * @description Exact-SHA hot-patch CI evidence from required jobs on mapped Actions workflows.
 * GitHub reads are injected; unreadable or ambiguous evidence is unknown, never green.
 */
import { readRequiredStatusChecksDetailed, FALLBACK_REQUIRED_STATUS_CHECKS } from './required-status-checks.mjs';

export const REQUIRED_CHECK_WORKFLOW = Object.freeze({
  test: '.github/workflows/ci.yml',
  smoke: '.github/workflows/ci.yml',
  'daemon-soak': '.github/workflows/ci.yml',
  'soak-replay-gate': '.github/workflows/soak-replay-gate.yml',
});
const REPO = 'web-everything/web-everything';
const validId = id => ['string', 'number'].includes(typeof id) && /^[1-9][0-9]*$/.test(String(id))
  && (typeof id !== 'number' || Number.isSafeInteger(id));

/** Read main's required names, retaining the declared policy when the read is unavailable. */
export function requiredChecksForMain() {
  try {
    const { checks } = readRequiredStatusChecksDetailed({ repo: REPO, branch: 'main' });
    if (Array.isArray(checks) && checks.length && checks.every(name => typeof name === 'string' && name.length))
      return checks;
  } catch { /* The declared required set is the fallback, never an empty green set. */ }
  return FALLBACK_REQUIRED_STATUS_CHECKS;
}

/** Evaluate required jobs on each workflow's newest trusted run, ordered by numeric ID. */
export async function hotPatchCiVerdict({ repo, sha, required, fetchJson } = {}) {
  const unknown = reason => ({ state: 'unknown', reason });
  if (repo !== REPO) return unknown('Unsupported hot-patch repository');
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/i.test(sha)) return unknown('Invalid commit SHA');
  if (!Array.isArray(required) || !required.length) return unknown('Required checks unavailable');
  if (required.some(name => typeof name !== 'string' || !Object.hasOwn(REQUIRED_CHECK_WORKFLOW, name)))
    return unknown('Required check has no trusted workflow mapping');
  const workflows = new Map();
  for (const name of new Set(required)) {
    const path = REQUIRED_CHECK_WORKFLOW[name];
    if (!workflows.has(path)) workflows.set(path, []);
    workflows.get(path).push(name);
  }
  let pending = false, red = false;
  try {
    for (const [workflow, names] of workflows) {
      const filename = workflow.split('/').at(-1);
      const payload = await fetchJson(`/repos/${repo}/actions/workflows/${filename}/runs?head_sha=${sha}`);
      if (!Array.isArray(payload?.workflow_runs)) return unknown('Workflow runs unreadable');
      const candidates = [], ids = new Set();
      for (const run of payload.workflow_runs) {
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
      const jobsPayload = await fetchJson(`/repos/${repo}/actions/runs/${run.id}/jobs`);
      if (!Array.isArray(jobsPayload?.jobs)) return unknown('Actions jobs unreadable');
      for (const name of names) {
        const jobs = jobsPayload.jobs.filter(job => job?.name === name);
        if (jobs.length > 1) return unknown('Ambiguous duplicate required jobs');
        const job = jobs[0];
        if (!job) { pending = true; continue; }
        if (typeof job.status !== 'string' || !job.status.length) return unknown('Required job status unreadable');
        if (job.status !== 'completed') { pending = true; continue; }
        if (typeof job.conclusion !== 'string' || !job.conclusion.length)
          return unknown('Completed required job conclusion unreadable');
        if (job.conclusion !== 'success') red = true;
      }
    }
    if (red) return { state: 'red', reason: 'A required Actions job completed without success' };
    if (pending) return { state: 'pending', reason: 'Required Actions jobs are missing or unfinished' };
    return { state: 'green', reason: 'Every required Actions job succeeded for the exact SHA' };
  } catch {
    return unknown('CI evidence unavailable; repair GitHub access or retry the exact-SHA workflow read');
  }
}
