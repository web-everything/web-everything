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

/** A repo path reduced to the form the prefix test uses (separators, case, `./`, NFKC). Pure. */
export function normalizeGatePath(p) {
  return String(p ?? '').normalize('NFKC').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/').replace(/^(?:\.?\/)+/, '');
}

/**
 * Does this PR's change list let it be enqueued? Pure. A PR is held for a HUMAN (`humanOnly: true`, not an
 * escalation an AI reviewer can accept) when any changed path, or any renamed-from path, is a workflow or action
 * file; and it is held fail-closed but RETRYABLE (`humanOnly: false`) when the list cannot be trusted to be
 * complete (a read error or a count mismatch is transient, not a decision).
 * @param {{files:Array<string|{filename:string, previous_filename?:string}>, expectedCount:number}} o
 * @returns {{hold:false}|{hold:true, humanOnly:boolean, retryable?:boolean, reason:'workflow-edit'|'unreadable', paths:string[], error:string}}
 */
export function workflowEditHold({ files, expectedCount } = {}) {
  const unreadable = (why) => ({ hold: true, humanOnly: false, retryable: true, reason: 'unreadable', paths: [], error: `changed files unreadable (${why}) — a PR is only enqueued when its whole change list is known not to touch workflow files` });
  if (!Array.isArray(files)) return unreadable('no list');
  if (!Number.isInteger(expectedCount) || expectedCount < 0) return unreadable('no file count');
  if (files.length !== expectedCount) return unreadable(`listed ${files.length} of ${expectedCount}`);
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

const SHA_RE = /^[0-9a-f]{40}$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * The change list OF THE EXACT COMMIT being enqueued (`headSha`), read from git — never a listing of whatever the
 * PR's branch points at now (PR #4708 round 6: the REST `pulls/{n}/files` list is not pinned to a sha, so a head
 * that moved between the read and the enqueue could be judged on another commit's files). The diff is
 * `origin/<base>...<headSha>` (merge-base to head, what the queue lands) with `--no-renames`, so a rename shows
 * BOTH its old and new path. Every path is listed (no 3000-file REST cap). `{files}` or `{error}`. Never throws.
 */
export function readPinnedChangedFiles({ headSha, base = 'main', cwd, exec = execFileSync } = {}) {
  if (!SHA_RE.test(String(headSha))) return { error: 'head sha is not a 40-hex commit id' };
  if (!SAFE_BRANCH_RE.test(String(base)) || String(base).startsWith('-')) return { error: 'base branch name unusable' };
  if (!cwd) return { error: 'no checkout to read the pinned diff from' };
  const git = (args) => String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }) ?? '');
  try {
    git(['fetch', '--quiet', '--end-of-options', 'origin', headSha, `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    git(['cat-file', '-e', `${headSha}^{commit}`]);
    const out = git(['diff', '--name-only', '--no-renames', '-z', '--end-of-options', `refs/remotes/origin/${base}...${headSha}`]);
    return { files: out.split('\0').filter(Boolean) };
  } catch (e) { return { error: errText(e) }; }
}

/**
 * Enqueue one PR. Never throws. `{ok:true, entry}` / `{ok:true, already:true}` / `{ok:false, error}`; a PR whose
 * diff touches a workflow file (or whose change list cannot be fully read) comes back `{ok:false, held:true,
 * humanOnly, error}` and is never enqueued.
 * PINNED TO ONE COMMIT: the PR's live head must equal `headSha` (else it moved since the drain judged it — held,
 * retryable), the workflow-edit refusal reads the change list OF `headSha` (`readPinnedChangedFiles`), and the
 * mutation carries `expectedHeadOid: headSha`, so GitHub refuses the entry if the head moves after the read. The
 * refusal and the queue entry therefore always describe the same commit.
 * @param {{repo:string, num:number, headSha:string, cwd:string, exec?:Function}} o  `cwd`: a clone of `repo`.
 */
export function enqueuePr({ repo, num, headSha, cwd, exec = execFileSync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo)) || !Number.isInteger(Number(num))) {
    return { ok: false, held: true, humanOnly: false, retryable: true, reason: 'unreadable', paths: [], error: 'changed files unreadable (repo or PR number is malformed)' };
  }
  let pr;
  try {
    pr = JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'id,headRefOid,baseRefName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '{}');
  } catch (e) { return { ok: false, error: `node id read failed: ${errText(e)}` }; }
  const nodeId = pr?.id;
  if (!nodeId) return { ok: false, error: 'node id missing' };
  if (pr?.headRefOid !== headSha) {
    return { ok: false, held: true, humanOnly: false, retryable: true, reason: 'head-moved', paths: [], error: `PR head is ${String(pr?.headRefOid).slice(0, 9)}, not the judged ${String(headSha).slice(0, 9)} — re-judge the new head before enqueueing` };
  }
  const read = readPinnedChangedFiles({ headSha, base: pr?.baseRefName || 'main', cwd, exec });
  const hold = workflowEditHold({ files: read.files, expectedCount: read.files?.length });
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
