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
 * Paths a queued PR may never touch. The required `merge-gate` check is a workflow, and GitHub reads a workflow's
 * YAML from the PR merge ref (`pull_request`) or the group commit (`merge_group`), so a PR can edit one to
 * `exit 0` (or add a new workflow with a job named like a required check) and turn the check green from inside its
 * own diff. No check a PR can edit can defend against that, so the defence sits where the PR cannot reach: the
 * drain, running from the daemon's own `main` checkout, refuses to enqueue such a PR at all. A human merges it.
 */
export const GATE_PATH_PREFIXES = ['.github/workflows/', '.github/actions/'];

/** The REST `pulls/{n}/files` listing stops at 3000 files; a PR that reaches it has an unreadable tail. */
export const MAX_LISTED_PR_FILES = 3000;

/** A repo path reduced to the form the prefix test uses (separators, case, `./`, NFKC). Pure. */
export function normalizeGatePath(p) {
  return String(p ?? '').normalize('NFKC').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/').replace(/^(?:\.?\/)+/, '');
}

/**
 * Does this PR's change list let it be enqueued? Pure. A PR is held for a HUMAN (`humanOnly: true`, not an
 * escalation an AI reviewer can accept) when any changed path, or any renamed-from path, is a workflow or action
 * file; and it is held fail-closed but RETRYABLE (`humanOnly: false`) when the list cannot be trusted to be
 * complete (a gh error or a stale count is transient, not a decision).
 * @param {{files:Array<string|{filename:string, previous_filename?:string}>, expectedCount:number}} o
 * @returns {{hold:false}|{hold:true, humanOnly:boolean, retryable?:boolean, reason:'workflow-edit'|'unreadable', paths:string[], error:string}}
 */
export function workflowEditHold({ files, expectedCount } = {}) {
  const unreadable = (why) => ({ hold: true, humanOnly: false, retryable: true, reason: 'unreadable', paths: [], error: `changed files unreadable (${why}) — a PR is only enqueued when its whole change list is known not to touch workflow files` });
  if (!Array.isArray(files)) return unreadable('no list');
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return unreadable('no file count');
  if (files.length !== expectedCount) return unreadable(`listed ${files.length} of ${expectedCount}`);
  if (expectedCount >= MAX_LISTED_PR_FILES) return unreadable(`${expectedCount} files reaches the ${MAX_LISTED_PR_FILES}-file listing limit`);
  const hit = [];
  for (const f of files) {
    for (const raw of typeof f === 'string' ? [f] : [f?.filename, f?.previous_filename]) {
      if (raw === undefined || raw === null || raw === '') continue;
      const p = normalizeGatePath(raw);
      if (p.split('/').includes('..') || GATE_PATH_PREFIXES.some((pre) => p.startsWith(pre))) hit.push(String(raw));
    }
    if (typeof f !== 'string' && !f?.filename) return unreadable('entry without a filename');
  }
  return hit.length
    ? { hold: true, humanOnly: true, reason: 'workflow-edit', paths: [...new Set(hit)], error: `held for a human: the diff touches ${[...new Set(hit)].join(', ')} — workflow files decide the required checks, so only a person may land a change to them` }
    : { hold: false };
}

/** The PR's full change list (paginated REST, filename + rename source), or `{error}`. */
function readChangedFiles({ repo, num, exec }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo)) || !Number.isInteger(Number(num))) return { error: 'repo or PR number is malformed' };
  try {
    const out = exec('gh', ['api', '--paginate', `repos/${repo}/pulls/${num}/files?per_page=100`, '--jq', '.[] | [.filename, (.previous_filename // "")] | @json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const files = String(out ?? '').split('\n').filter((l) => l.trim()).map((l) => {
      const [filename, previous] = JSON.parse(l);
      return { filename, previous_filename: previous || undefined };
    });
    return { files };
  } catch (e) { return { error: errText(e) }; }
}

/**
 * Enqueue one PR. Never throws. `{ok:true, entry}` / `{ok:true, already:true}` / `{ok:false, error}`; a PR whose
 * diff touches a workflow file (or whose change list cannot be fully read) comes back `{ok:false, held:true,
 * humanOnly:true, error}` and is never enqueued.
 * @param {{repo:string, num:number, headSha:string, exec?:Function}} o
 */
export function enqueuePr({ repo, num, headSha, exec = execFileSync }) {
  let nodeId;
  let changedFiles;
  try {
    const pr = JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'id,changedFiles'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}');
    nodeId = pr?.id;
    changedFiles = pr?.changedFiles;
  } catch (e) { return { ok: false, error: `node id read failed: ${errText(e)}` }; }
  if (!nodeId) return { ok: false, error: 'node id missing' };
  const read = readChangedFiles({ repo, num, exec });
  const hold = workflowEditHold({ files: read.files, expectedCount: changedFiles });
  if (hold.hold) return { ok: false, held: true, humanOnly: hold.humanOnly, retryable: hold.retryable === true, reason: hold.reason, paths: hold.paths, error: read.error ? `${hold.error}: ${read.error}` : hold.error };
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
