/**
 * @file scripts/lib/merge-queue-enqueue.mjs
 * @description Strategy `github-merge-queue` (`./merge-delivery-policy.mjs`): instead of `gh pr merge`, the drain
 *   ENQUEUES a ready PR on GitHub's native merge queue (GraphQL `enqueuePullRequest`), and GitHub re-tests and
 *   merges it. The drain's merge-time gates run in the required `merge-gate` check (`./merge-gate-ci.mjs`), so
 *   moving the merge off the drain never drops a gate. `drain-direct` (the default) is untouched: for it
 *   `mergeActionFor` says `merge` and nothing here runs.
 *
 *   Pure helpers + one IO function with an injectable `exec`. Post-merge follow-up (numbering, regen,
 *   resolve-on-land) still belongs to the drain: `planQueueFollowUps` names the PRs GitHub merged since the
 *   drain last followed up, so the drain's existing post-land path runs for them.
 */
import { execFileSync } from 'node:child_process';

export const ENQUEUE_MUTATION = 'mutation($id:ID!,$sha:GitObjectID){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$sha}){mergeQueueEntry{id position state}}}';

/** What the drain does with a PR that passed every drain gate this pass. Pure. */
export function mergeActionFor(policy) {
  return policy?.strategy === 'github-merge-queue' ? 'enqueue' : 'merge';
}

/** `gh api graphql` argv for the enqueue. `expectedHeadOid` pins the queue entry to the head the drain judged. */
export function buildEnqueueArgs({ nodeId, headSha }) {
  if (!nodeId) throw new Error('enqueue: PR node id required');
  if (!headSha) throw new Error('enqueue: expected head SHA required (never enqueue an unpinned head)');
  return ['api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`, '-f', `id=${nodeId}`, '-f', `sha=${headSha}`];
}

/** Is a gh error the "already in the merge queue" case (idempotent success)? Pure. */
export function isAlreadyQueuedError(text) {
  return /already (?:in|queued in) the merge queue|is already queued/i.test(String(text || ''));
}

/**
 * Enqueue one PR. Never throws. `{ok:true, entry}` / `{ok:true, already:true}` / `{ok:false, error}`.
 * @param {{repo:string, num:number, headSha:string, exec?:Function}} o
 */
export function enqueuePr({ repo, num, headSha, exec = execFileSync }) {
  let nodeId;
  try {
    nodeId = JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'id'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}')?.id;
  } catch (e) { return { ok: false, error: `node id read failed: ${errText(e)}` }; }
  if (!nodeId) return { ok: false, error: 'node id missing' };
  try {
    const out = JSON.parse(exec('gh', buildEnqueueArgs({ nodeId, headSha }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}');
    const errs = out?.errors;
    if (Array.isArray(errs) && errs.length) {
      const msg = errs.map((x) => x?.message).join('; ');
      return isAlreadyQueuedError(msg) ? { ok: true, already: true } : { ok: false, error: msg };
    }
    const entry = out?.data?.enqueuePullRequest?.mergeQueueEntry ?? null;
    return entry ? { ok: true, entry } : { ok: false, error: 'no merge queue entry returned' };
  } catch (e) {
    const t = errText(e);
    return isAlreadyQueuedError(t) ? { ok: true, already: true } : { ok: false, error: t };
  }
}

/**
 * PRs the merge queue merged that the drain has not followed up yet. Pure.
 * @param {{merged:Array<{number:number, mergedAt?:string, mergeCommit?:{oid?:string}}>, followedUp:Iterable<number>}} o
 */
export function planQueueFollowUps({ merged = [], followedUp = [] } = {}) {
  const done = new Set([...followedUp].map(Number));
  return merged.filter((p) => Number.isInteger(Number(p?.number)) && !done.has(Number(p.number)))
    .sort((a, b) => String(a.mergedAt || '').localeCompare(String(b.mergedAt || '')))
    .map((p) => ({ num: Number(p.number), mergeSha: p.mergeCommit?.oid ?? null, mergedAt: p.mergedAt ?? null }));
}

/** The GitHub Actions app: a required check is only accepted when this app posted it (a status from anyone else cannot satisfy it). */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

/**
 * Every workflow file that defines a required check. GitHub reads a workflow's YAML from the PR merge ref
 * (`pull_request`) or the group commit (`merge_group`), so a PR could edit one to `exit 0`, or add a new workflow
 * whose job carries a required check's name. The ruleset's `workflows` rule runs each of these from `main`
 * instead; a test fails when a workflow defining a required check is missing here.
 */
export const REQUIRED_WORKFLOW_PATHS = ['.github/workflows/ci.yml', '.github/workflows/merge-gate.yml', '.github/workflows/soak-replay-gate.yml'];

/** The ruleset the operator enables for a policy (GitHub reads the ruleset, never this file). Pure. */
export function rulesetSuggestion(policy, requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate']) {
  return {
    target: 'branch main',
    mergeQueue: {
      mergeMethod: String(policy?.mergeMethod || 'merge').toUpperCase(),
      maxEntriesToBuild: policy?.batchSize ?? 1,
      minEntriesToMerge: 1,
      maxEntriesToMerge: policy?.batchSize ?? 1,
      minEntriesToMergeWaitMinutes: policy?.maxGroupWaitMinutes ?? 5,
      groupingStrategy: 'ALLGREEN',
      checkResponseTimeoutMinutes: 60,
    },
    requiredStatusChecks: requiredChecks,
    requiredStatusCheckIntegrationId: GITHUB_ACTIONS_INTEGRATION_ID,
    requiredWorkflows: REQUIRED_WORKFLOW_PATHS.map((path) => ({ path, ref: 'refs/heads/main' })),
  };
}

function errText(e) {
  return String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
}
