/** Pure, fail-closed admission for missing-run synchronize pushes. */
import { ghAuthIdentity } from '../lib/gh-throttle.mjs';
import { isStartupFailure } from './main-red-recovery.mjs';

export function recoveryPushCredential(token, env = {}) {
  if (typeof token !== 'string' || !token) return false;
  if (token.startsWith('ghs_')) return ghAuthIdentity({ ...env, GH_TOKEN: token }).startsWith('app-installation-');
  return /^(ghp_|github_pat_|gho_)/.test(token);
}

export function recoveryPreflight({
  repo, head, headRefName, defaultBranch = 'main', pr, recoveryEvidence,
  claimed, token, env = {}, attemptsForSha, attemptsForPr, maxRetriesPerSha, maxRetriesPerPr,
} = {}) {
  const refuse = reason => ({ allow: false, reason });
  const fallback = 'needs human/operator or ci-heal inspection';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')
    || typeof headRefName !== 'string' || !headRefName.startsWith('lane/') || headRefName.length <= 5) {
    return refuse(`recovery requires a repository, exact head and lane/ branch; ${fallback}`);
  }
  if (!pr || String(pr.state).toUpperCase() !== 'OPEN' || pr.baseRefName !== defaultBranch
    || pr.isCrossRepository !== false || pr.mergeable !== 'MERGEABLE'
    || pr.headRefOid !== head || pr.headRefName !== headRefName) {
    return refuse(`live PR state is ineligible, moved or unreadable; ${fallback}`);
  }
  if (claimed !== false) return refuse(`fix claim is held or unreadable; ${fallback}`);
  if (!recoveryPushCredential(token, env)) return refuse(`ineligible recovery push credential; ${fallback}`);
  if (![attemptsForSha, attemptsForPr, maxRetriesPerSha, maxRetriesPerPr].every(n => Number.isSafeInteger(n) && n >= 0)
    || attemptsForSha >= maxRetriesPerSha || attemptsForPr >= maxRetriesPerPr) {
    return refuse(`missing-run cap exhausted or unreadable; ${fallback}`);
  }
  const { requiredContexts, rollup, workflowRuns } = recoveryEvidence ?? {};
  if (!Array.isArray(requiredContexts) || !requiredContexts.length
    || requiredContexts.some(n => typeof n !== 'string' || !n.trim())
    || !Array.isArray(rollup) || !Array.isArray(workflowRuns)) {
    return refuse(`missing or unreadable recovery evidence; ${fallback}`);
  }
  // Match workflow names/paths to contexts where possible. Independently reject
  // pending/failed workflows: absence in the rollup is not proof they never ran.
  const reported = new Set();
  for (const row of rollup) {
    const name = row?.name || row?.context;
    const statusContext = row?.__typename === 'StatusContext' || (row?.state && !row?.status);
    if (typeof name !== 'string' || !name || (statusContext
      ? !['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'].includes(String(row.state).toUpperCase())
      : String(row?.status).toUpperCase() !== 'COMPLETED' || typeof row?.conclusion !== 'string')) {
      return refuse(`pending or unreadable rollup evidence; ${fallback}`);
    }
    const conclusion = String(statusContext ? row.state : row.conclusion).toUpperCase();
    if (['PENDING', 'EXPECTED'].includes(conclusion)
      || (requiredContexts.includes(name) && !['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STARTUP_FAILURE'].includes(conclusion))) {
      return refuse(`required check failed or is pending; ${fallback}`);
    }
    if (!isStartupFailure(row)) reported.add(name);
  }
  for (const run of workflowRuns) {
    if (!Number.isSafeInteger(run?.id) || run.id <= 0 || typeof run.name !== 'string' || !run.name
      || typeof run.path !== 'string' || !run.path || typeof run.event !== 'string' || !run.event
      || run.head_sha !== head || String(run.status).toUpperCase() !== 'COMPLETED'
      || !['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STARTUP_FAILURE'].includes(String(run.conclusion).toUpperCase())) {
      return refuse(`workflow evidence is failed, pending, stale or unreadable; ${fallback}`);
    }
    if (!isStartupFailure(run)) {
      reported.add(run.name);
      reported.add(run.name.toLowerCase().replace(/\s+/g, '-'));
      reported.add(run.path.split('/').at(-1).replace(/\.ya?ml(?:@.*)?$/, ''));
    }
  }
  if (requiredContexts.every(name => reported.has(name))) return refuse(`no required context is absent; ${fallback}`);
  return { allow: true, reason: 'required context absent with complete recovery evidence and available caps' };
}
