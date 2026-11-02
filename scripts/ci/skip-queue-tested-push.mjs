#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
// Dependency-free modules only: the `changes` job runs this before any `npm ci`.
import { QUARANTINE_BRANCH, QUARANTINE_LIST_PATH, validateQuarantineList } from '../lib/red-main-quarantine.mjs';

const trackingRefspec = (branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

export const MAX_RUNS_CHECKED = 20;
/** An outside input's newest push must predate the matched queue run by this much. */
export const INPUT_SETTLE_MS = 10 * 60 * 1000;
/** The sibling repo every full-suite job checks out at its default-branch tip (no `ref:`). */
export const SIBLING_REPO = 'frontier-ui/frontierui';
export const SIBLING_DEFAULT_BRANCH = 'main';
/** Each git/gh call is bounded; the workflow step adds its own overall timeout-minutes. */
const CALL_TIMEOUT_MS = 30_000;
const isSha = (value) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/i.test(value);
const full = (reason) => ({ skip: false, reason: `${reason}; running full CI` });

/**
 * The queue run read `name` at some point after its creation; the push run would read it now.
 * Both read the same content only if the ref's tip is unchanged since before the run. Proof uses
 * GitHub's own record of the newest push (GET /repos/{repo}/activity): a server timestamp, so the
 * writer's clock, a stalled push or a force-reset back to an old commit cannot make it look old.
 * The record must name the tip read now, so a push between the two reads is caught too.
 */
function inputChangedReason(name, { tip, lastPush }, run, now) {
  if (!isSha(tip)) return `${name} tip unreadable`;
  if (!lastPush || typeof lastPush !== 'object') return `${name} push activity unreadable`;
  if (lastPush.activity_type === 'branch_deletion') return `${name} branch was deleted`;
  if (!isSha(lastPush.after) || lastPush.after.toLowerCase() !== tip.toLowerCase()) {
    return `${name} moved since its last recorded push`;
  }
  const pushedAt = typeof lastPush.timestamp === 'string' ? Date.parse(lastPush.timestamp) : NaN;
  if (!Number.isFinite(pushedAt)) return `${name} push time unreadable`;
  if (!Number.isFinite(now) || pushedAt > now) return `${name} push time is in the future`;
  if (pushedAt > Date.parse(run.created_at) - INPUT_SETTLE_MS) return `${name} changed near or after the merge-group run`;
  return null;
}

async function readState(name, read) {
  try {
    const state = await read();
    return state?.ok === true ? { state } : { reason: `${name} state unreadable` };
  } catch {
    return { reason: `${name} read failed` };
  }
}

/**
 * A merge_group run's success proves what a push to main would test only if it read the same outside
 * inputs and excluded nothing. Inputs: the ops/quarantine list (scripts/ci/quarantine-skip.mjs excludes
 * entries on merge_group, never on a push to main) and the frontierui sibling. The list must be out of
 * quarantine mode or empty (every entry counts: expired, job-tagged and name-qualified ones too).
 * Returns null when proven, else the reason.
 */
async function queueRunUnproven({ readQuarantineState, readSiblingState }, run, now) {
  const q = await readState('ops/quarantine', readQuarantineState);
  if (q.reason) return q.reason;
  if (!q.state.list || typeof q.state.list !== 'object') return 'ops/quarantine list unreadable';
  const { mode, entries } = q.state.list;
  if (!Array.isArray(entries)) return 'ops/quarantine list entries unreadable';
  if (mode !== undefined && mode !== 'stop' && mode !== 'quarantine') return 'unknown quarantine mode';
  if (mode === 'quarantine' && entries.length > 0) {
    return 'quarantine mode has entries, so the merge-group run may have excluded tests';
  }
  const qChanged = inputChangedReason('ops/quarantine', q.state, run, now);
  if (qChanged) return qChanged;
  const s = await readState('frontierui', readSiblingState);
  if (s.reason) return s.reason;
  return inputChangedReason('frontierui', s.state, run, now);
}

/** Decide from injected evidence; unavailable evidence always retains full CI. */
export async function decideQueueTestedSkip({
  event, ref, sha, pushTree, listMergeGroupRuns, getCommitTree, readQuarantineState, readSiblingState,
  now = Date.now(),
} = {}) {
  if (event !== 'push') return full('only push events qualify');
  if (ref !== 'refs/heads/main') return full('only the main branch qualifies');
  if (!isSha(sha)) return full('invalid push SHA');
  if (!isSha(pushTree)) return full('invalid push tree');

  let runs;
  try {
    runs = await listMergeGroupRuns();
  } catch {
    return full('merge-group run listing failed');
  }
  if (!Array.isArray(runs)) return full('merge-group run listing is not an array');
  const candidates = runs.filter((run) => run?.conclusion === 'success' && isSha(run.head_sha)
    && typeof run.created_at === 'string' && Number.isFinite(Date.parse(run.created_at)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_RUNS_CHECKED);
  if (!candidates.length) return full('no valid successful merge-group runs');

  // A newer non-success run on the same head SHA (a re-run that failed) overrides an older success.
  const newerNonSuccess = (run) => runs.some((r) => r && r !== run && isSha(r.head_sha)
    && r.head_sha.toLowerCase() === run.head_sha.toLowerCase()
    && r.conclusion !== 'success' && typeof r.created_at === 'string'
    && Date.parse(r.created_at) > Date.parse(run.created_at));
  const accept = async (run, reason) => {
    if (newerNonSuccess(run)) return full('a newer merge-group run on the same SHA did not succeed');
    const unproven = await queueRunUnproven({ readQuarantineState, readSiblingState }, run, now);
    return unproven ? full(unproven) : { skip: true, matchedSha: run.head_sha, reason };
  };
  for (const run of candidates) {
    if (run.head_sha.toLowerCase() === sha.toLowerCase()) {
      return accept(run, 'push head already passed merge-group CI');
    }
    let tree;
    try {
      tree = await getCommitTree(run.head_sha);
    } catch {
      return full('merge-group commit tree lookup failed');
    }
    if (!isSha(tree)) return full('invalid merge-group commit tree');
    if (tree.toLowerCase() === pushTree.toLowerCase()) {
      return accept(run, 'push tree already passed merge-group CI');
    }
  }
  return full(`tree differs from the newest ${candidates.length} successful runs (limit ${MAX_RUNS_CHECKED})`);
}

/** The newest push GitHub recorded for a branch (undefined when none). */
function lastPushOf(exec, repo, branch, env) {
  const activity = JSON.parse(exec('gh', ['api',
    `repos/${repo}/activity?ref=refs/heads/${branch}&direction=desc&per_page=1`], env));
  if (!Array.isArray(activity)) throw new Error('activity is not an array');
  return activity[0];
}

/** Read the published list from one fetched tip (same transport as quarantine-skip), plus its newest push. */
function readQuarantineAt(exec, repo) {
  exec('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', trackingRefspec(QUARANTINE_BRANCH)]);
  const tip = exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${QUARANTINE_BRANCH}^{commit}`]);
  if (!isSha(tip)) return { ok: false, error: 'invalid quarantine tip' };
  const listed = exec('git', ['ls-tree', '--name-only', tip, '--', QUARANTINE_LIST_PATH]);
  const list = listed ? JSON.parse(exec('git', ['show', `${tip}:${QUARANTINE_LIST_PATH}`])) : { version: 1, entries: [] };
  const valid = validateQuarantineList(list);
  if (!valid.ok) return { ok: false, error: valid.errors.join('; ') };
  return { ok: true, list, tip, lastPush: lastPushOf(exec, repo, QUARANTINE_BRANCH) };
}

/** The sibling's default-branch tip (what an unpinned checkout gets) and its newest push, read with FUI_TOKEN only. */
function readSiblingAt(exec, token) {
  if (typeof token !== 'string' || token.trim() === '') return { ok: false, error: 'no FUI token' };
  const env = { GH_TOKEN: token };
  const branch = exec('gh', ['api', `repos/${SIBLING_REPO}`, '--jq', '.default_branch'], env);
  // The activity log does not record a default-branch switch, so a switch to an old branch would look
  // unchanged. Accept only the expected default; anything else keeps the full suite.
  if (branch !== SIBLING_DEFAULT_BRANCH) return { ok: false, error: 'unexpected default branch' };
  const tip = exec('gh', ['api', `repos/${SIBLING_REPO}/branches/${branch}`, '--jq', '.commit.sha'], env);
  return { ok: true, tip, lastPush: lastPushOf(exec, SIBLING_REPO, branch, env) };
}

async function main() {
  let result;
  try {
    const { values } = parseArgs({ options: Object.fromEntries(
      ['event', 'ref', 'sha', 'repo'].map((name) => [name, { type: 'string' }]),
    ) });
    if (typeof values.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)
      || values.repo.includes('\n')) throw new Error('invalid repository');
    if (!isSha(values.sha)) throw new Error('invalid push SHA');
    const exec = (command, args, env) => execFileSync(command, args, {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CALL_TIMEOUT_MS, killSignal: 'SIGKILL', ...(env ? { env: { ...process.env, ...env } } : {}),
    }).trim();
    result = await decideQueueTestedSkip({
      ...values,
      pushTree: exec('git', ['rev-parse', `${values.sha}^{tree}`]),
      listMergeGroupRuns: () => JSON.parse(exec('gh', ['api',
        `repos/${values.repo}/actions/workflows/ci.yml/runs?event=merge_group&per_page=100`,
      ])).workflow_runs,
      getCommitTree: (sha) => exec('gh', ['api', `repos/${values.repo}/git/commits/${sha}`, '--jq', '.tree.sha']),
      readQuarantineState: () => readQuarantineAt(exec, values.repo),
      readSiblingState: () => readSiblingAt(exec, process.env.FUI_TOKEN),
    });
  } catch {
    result = full('queue-tested evidence could not be read');
  }
  process.stdout.write(`queue_tested=${result.skip}\n`);
  process.stderr.write(`queue-tested: ${result.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
