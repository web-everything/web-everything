/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { execFileSync } from 'node:child_process';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { readRedTeamDisposition, readRedTeamProbes } from './red-team-gate.mjs';

export function readDrainQueueSafety({ env = process.env, tool, platform, log = () => {} } = {}) {
  const booleanEnv = key => env[key] === undefined ? undefined
    : /^(true|1|on)$/i.test(env[key]) ? true : /^(false|0|off)$/i.test(env[key]) ? false : env[key];
  const numberEnv = key => env[key] === undefined ? undefined : Number(env[key]);
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, standard: { queueRebuildMax: 3, waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true, redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 },
    valid: { queueRebuildMax: v => Number.isSafeInteger(v) && v > 0, waitForRedTeamBeforeEnqueue: v => typeof v === 'boolean', dequeueOnSendBack: v => typeof v === 'boolean', redTeamPendingBackoffSec: positive, redTeamPendingMaxMin: positive },
    envValues: { queueRebuildMax: numberEnv('WE_DRAIN_QUEUE_REBUILD_MAX'), waitForRedTeamBeforeEnqueue: booleanEnv('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE'), dequeueOnSendBack: booleanEnv('WE_DRAIN_DEQUEUE_ON_SEND_BACK'), redTeamPendingBackoffSec: numberEnv('WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC'), redTeamPendingMaxMin: numberEnv('WE_DRAIN_RED_TEAM_PENDING_MAX_MIN') },
  });
  log(formatCascadeSourcesLine('drain', r));
  // Retired: this switch let the drain enqueue an owed head with NO red-team result once the deadline passed. It is no
  // longer read; past the deadline the PR is held (redTeam.deadlineAction). Name a leftover value so nobody trusts it.
  const retired = [env.WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED !== undefined ? 'env WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED' : null,
    r.layered?.enqueueWhenRedTeamNeverScheduled !== undefined ? 'drain.enqueueWhenRedTeamNeverScheduled setting' : null].filter(Boolean);
  if (retired.length) log(`⚠ ${retired.join(' and ')} is retired and ignored: past the red-team deadline the PR is held (redTeam.deadlineAction)`);
  return r;
}

export const queueLabels = labels => (labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
/** Admission holds also cover pending work; pending alone must not evict a queued PR. */
export function redTeamLabelHoldReason(labels) {
  const names = queueLabels(labels);
  const hold = ['red-team:blocked', 'red-team:pending'].find(l => names.includes(l));
  return hold ? `state is ${hold}` : null;
}

export function sendBackReason(labels) {
  const names = queueLabels(labels);
  const hold = ['review:changes', 'review:human', 'review:pending', 'red-team:blocked'].find(l => names.includes(l));
  return hold ? `state is ${hold}` : !names.includes('ready-to-merge') ? 'ready-to-merge was removed' : null;
}

/** Only head-bound scheduled work is owed; acceptance and status labels cannot invent a run. */
export function postAcceptRedTeamOwed(loopPayload, env = process.env, evidence = {}) {
  return redTeamOwedOnHead({ read: loopPayload?.findings?.read, evidence, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly });
}

export function redTeamEnqueueHold({ loopPayload, comments, pr, head, repo = null, standingRuling = null, env = process.env, confirmedBreaks, scheduled = false, inFlight = false, recorded = false, skipCardOnly } = {}) {
  // A recorded break still holds even if the scheduler is now disabled or the payload is unavailable.
  // `standingRuling`: the verified scope, so an automatic grant counts here exactly as in the gate (PR #5758).
  const disposition = readRedTeamDisposition({ comments, pr, head, env, setting: confirmedBreaks, repo, standingRuling });
  if (disposition.sendBack.length || disposition.held.length)
    return 'post-accept red team confirmed a break requiring send-back';
  if (!postAcceptRedTeamOwed(loopPayload, env, { scheduled, inFlight, recorded, skipCardOnly }) || disposition.result) return null;
  return 'post-accept red team has no recorded result on the live head';
}

/** Membership is authoritative both before and after the mutation. A retry after success posts no duplicate. */
export function dequeueSentBack({ repo, pr, reason, exec = execFileSync, log = () => {} } = {}) {
  const readJson = args => JSON.parse(exec('gh', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const before = readMergeQueueState({ repo, pr, readJson });
  if (before.error) throw new Error(before.error);
  if (!before.inQueue) return { dequeued: false };
  const { id } = readJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'id']);
  if (!id) throw new Error('dequeue: missing PR node id');
  const query = 'mutation($id:ID!){dequeuePullRequest(input:{pullRequestId:$id}){clientMutationId}}';
  const r = readJson(['api', 'graphql', '-f', `query=${query}`, '-f', `id=${id}`]);
  if (r.errors?.length || !r.data?.dequeuePullRequest) throw new Error(`dequeue refused: ${JSON.stringify(r.errors ?? r)}`);
  const after = readMergeQueueState({ repo, pr, readJson });
  if (after.error || after.inQueue !== false) throw new Error(`dequeue unconfirmed: ${after.error ?? 'isInMergeQueue is still true'}`);
  log(`merge-queue: dequeued ${repo}#${pr}: ${reason} (isInMergeQueue=false)`);
  try {
    exec('gh', ['pr', 'comment', String(pr), '--repo', repo, '--body', `Removed from the merge queue: ${reason}.`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(`⚠ merge-queue comment #${pr} failed (${String(e?.message ?? e).split('\n')[0]}) — removal confirmed`);
  }
  return { dequeued: true };
}

/**
 * PURE: should the drain refuse to enqueue `head` because its OWN merge_group run already failed there?
 * `runs`: this PR's completed merge_group runs, each `{ conclusion, completedAt (ms), prHead }` (prHead = the PR head the
 * group was built from). A cancelled run (an entry ahead failed) never counts; a later success on the same head, or a
 * `freshGreenAt` check newer than the failure, releases it. A failed read (`readError`) holds, visibly. No flake
 * classifier exists for merge_group failures, so there is no retry: a new head or a green rerun is the only way out.
 */
export function sameHeadFailedDecision({ pr, head, runs = [], freshGreenAt = null, readError = null } = {}) {
  const short = String(head).slice(0, 12);
  if (readError) return { hold: true, kind: 'mq-same-head-unreadable', reason: `merge_group failure read errored: ${readError.message ?? readError}`,
    line: `mq-same-head-unreadable: #${pr} head ${short} — merge_group failure read errored (${String(readError.message ?? readError).split('\n')[0].slice(0, 120)}); holding the enqueue` };
  const own = runs.filter(r => r.prHead === head);
  const failed = own.filter(r => r.conclusion === 'failure' || r.conclusion === 'timed_out');
  if (!failed.length) return { hold: false };
  const lastFail = Math.max(...failed.map(r => r.completedAt ?? 0));
  if (own.some(r => r.conclusion === 'success' && (r.completedAt ?? 0) > lastFail)) return { hold: false };
  if (freshGreenAt != null && freshGreenAt > lastFail) return { hold: false };
  const line = `mq-same-head-failed: #${pr} head ${short} — waiting for a new head or green rerun`;
  return { hold: true, kind: 'mq-same-head-failed', reason: line, line };
}

/** Reads this PR's recent merge_group runs and newer green checks through gh, decides, and logs the one named line. */
export function sameHeadFailedHold({ repo, pr, head, exec = execFileSync, log = () => {}, maxRuns = 6 } = {}) {
  const readJson = args => JSON.parse(exec('gh', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  let decision;
  try {
    const listed = readJson(['api', `repos/${repo}/actions/runs?event=merge_group&per_page=100`]);
    const mine = (listed.workflow_runs ?? []).filter(r => r.status === 'completed' && new RegExp(`/pr-${pr}-`).test(r.head_branch ?? '')
      && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped').slice(0, maxRuns);
    const runs = mine.map(r => {
      const parents = readJson(['api', `repos/${repo}/commits/${r.head_sha}`]).parents ?? [];
      return { conclusion: r.conclusion, completedAt: Date.parse(r.updated_at ?? r.run_started_at) || 0, prHead: parents.map(p => p.sha).find(s => s === head) ?? parents.at(-1)?.sha };
    });
    let freshGreenAt = null;
    if (runs.some(r => r.prHead === head && (r.conclusion === 'failure' || r.conclusion === 'timed_out'))) {
      const checks = readJson(['api', `repos/${repo}/commits/${head}/check-runs?per_page=100`]).check_runs ?? [];
      const times = c => Date.parse(c.completed_at) || 0;
      const lastFail = Math.max(...runs.filter(r => r.prHead === head).map(r => r.completedAt));
      const newer = checks.filter(c => times(c) > lastFail);
      // Green only when something finished after the failure and nothing newer is red.
      if (newer.length && newer.every(c => ['success', 'skipped', 'neutral'].includes(c.conclusion))) freshGreenAt = Math.max(...newer.map(times));
    }
    decision = sameHeadFailedDecision({ pr, head, runs, freshGreenAt });
  } catch (error) { decision = sameHeadFailedDecision({ pr, head, readError: error }); }
  if (decision.hold) log(decision.line);
  return decision;
}
