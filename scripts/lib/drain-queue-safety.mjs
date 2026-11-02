/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withNumberingLock } from '../readiness/drain-lock.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { readRedTeamDisposition, readRedTeamProbes } from './red-team-gate.mjs';

/** Only the merge-group commit's second parent identifies the tested PR head. */
export function decideMqSameHead({ pr, head, timeline } = {}) {
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  const hold = reason => ({ hold: true, line: `mq-same-head-failed: #${safe(pr)} head ${safe(head)} — ${reason}` });
  if (typeof head !== 'string' || !head.trim()) return hold('missing head');
  if (timeline?.error || !Array.isArray(timeline?.nodes) || typeof timeline.hasPreviousPage !== 'boolean')
    return hold('unreadable merge-queue timeline; inspect timeline before retrying');
  if (timeline.hasPreviousPage)
    return hold('incomplete timeline at 100-event cap; operator must inspect full history before retrying');
  for (const event of timeline.nodes) {
    if (event?.__typename === 'AddedToMergeQueueEvent') continue;
    if (event?.__typename !== 'RemovedFromMergeQueueEvent') return hold('unreadable merge-queue event');
    const reason = typeof event.reason === 'string' ? event.reason.trim().toLowerCase() : '';
    if (reason === 'manual' || reason === 'merged') continue;
    const testedHead = event.beforeCommit?.parents?.nodes?.[1]?.oid;
    if (typeof testedHead !== 'string' || !/^[a-f0-9]{40}$/i.test(testedHead))
      return hold('no commit binding for merge-queue removal; inspect timeline before retrying');
    if (testedHead === head) {
      // Preserve the public enumerable decision shape for existing callers/serializers.
      return Object.defineProperty(hold(safe(reason) || 'unknown removal reason'), 'removal', { value: true });
    }
  }
  return { hold: false, line: null };
}

/** One bounded read: incomplete history is evidence to hold, never to paginate or guess. */
export function readMqTimeline({ repo, pr, exec = execFileSync } = {}) {
  try {
    const parts = typeof repo === 'string' ? repo.split('/') : [];
    if (parts.length !== 2 || parts.some(part => !part) || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0)
      return { error: 'invalid repository or PR' };
    const query = `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){pullRequest(number:$number){
        timelineItems(last:100,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT,ADDED_TO_MERGE_QUEUE_EVENT]){
          pageInfo{hasPreviousPage}
          nodes{__typename
            ... on RemovedFromMergeQueueEvent{reason createdAt beforeCommit{oid parents(first:2){nodes{oid}}}}
            ... on AddedToMergeQueueEvent{createdAt}
          }
        }
      }}
    }`;
    const result = JSON.parse(exec('gh', ['api', 'graphql', '-f', `query=${query}`,
      '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${pr}`],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const items = result?.data?.repository?.pullRequest?.timelineItems;
    if (result?.errors?.length || !Array.isArray(items?.nodes) || typeof items?.pageInfo?.hasPreviousPage !== 'boolean')
      return { error: 'unreadable merge-queue timeline' };
    return { nodes: items.nodes, hasPreviousPage: items.pageInfo.hasPreviousPage };
  } catch {
    return { error: 'unreadable merge-queue timeline' };
  }
}

/** Append-only spent-head ledger: no expiry, since old heads must never be retried.
 * Persistence must succeed before requesting; unavailable state disables refresh.
 */
export function createMqSameHeadRefreshStore({ path,
  read = () => readFileSync(path, 'utf8'),
  write = data => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  },
  withLock = fn => withNumberingLock(fn, {
    lockRoot: join(dirname(path), 'locks'), lockPath: path,
    owner: `mq-refresh:${process.pid}:${randomUUID()}`, waitMs: 0, runUnlockedOnContention: false,
  }),
}) {
  let unavailable = false;
  const load = () => {
    try {
      const saved = JSON.parse(read());
      if (!Array.isArray(saved) || saved.some(key => typeof key !== 'string')) throw new Error('invalid ledger');
      return new Set(saved);
    } catch (error) {
      if (error?.code === 'ENOENT') return new Set();
      unavailable = true;
      return null;
    }
  };
  return {
    has(key) { return load()?.has(key) ?? false; },
    add(key) {
      if (unavailable) return false;
      try {
        // A dedicated ledger key avoids nesting the land-write mutex. Contention defers
        // this request to a later pass; never use the shared helper's unlocked fallback.
        const locked = withLock(() => {
          const keys = load();
          if (!keys || keys.has(key)) return false;
          keys.add(key);
          write(JSON.stringify([...keys]) + '\n');
          return true;
        });
        return locked.ran === true && locked.result === true;
      } catch { unavailable = true; return false; }
    },
  };
}

/** Bind the sweep's approval resolver lazily; only an explicit release permits refresh.
 * Resolver errors propagate to mqSameHeadRefresh's fail-closed allow boundary.
 */
export function createMqSameHeadRefreshOptions({ store, approvedHeadHold, repo, pr, head }) {
  return { store, allow: () => approvedHeadHold({ repo, num: pr }, head, { strict: true }) === false };
}

/** Owns recovery of a confirmed removal; the admission hold remains until the head changes. */
export function mqSameHeadRefresh({ repo, pr, head, decision, exec = execFileSyncThrottled,
  log = () => {}, store, allow } = {}) {
  if (!decision?.hold || !decision.removal || !store) return;
  const key = `${repo}#${pr}@${head}`;
  if (store.has(key)) return;
  const opts = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } };
  let live;
  try {
    live = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo,
      '--json', 'mergeStateStatus,headRefOid,statusCheckRollup'], opts));
  } catch { return; }
  if (live?.headRefOid !== head) return;
  const checks = live.statusCheckRollup;
  const green = Array.isArray(checks) && checks.length > 0 && checks.every(check => {
    if (!check || (check.status != null && check.status !== 'COMPLETED')) return false;
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? check.state);
  });
  if (live.mergeStateStatus !== 'CLEAN' && !green) return;
  // Evaluate retention lazily, after green evidence and immediately before spending.
  try { if (allow && !allow()) return; } catch { return; }
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  const prefix = `mq-same-head-refresh: #${safe(pr)} head ${safe(head)} — `;
  // Persist before IO: even a refused request (including a head race/422) is never repeated.
  try {
    if (store.add(key) === false) throw new Error('state unavailable');
  } catch {
    log(`${prefix}state unavailable; not requesting`);
    return;
  }
  try {
    exec('gh', ['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/update-branch`,
      '-f', `expected_head_sha=${head}`], opts);
    log(`${prefix}update-branch requested`);
  } catch (error) {
    const message = safe(String(error?.stderr || error?.message || error).split('\n')[0]).slice(0, 240);
    log(`${prefix}update-branch refused (${message}); not retrying at this head`);
  }
}

export function mqSameHeadGuard({ repo, pr, head, exec = execFileSyncThrottled, log = () => {}, refresh } = {}) {
  const decision = decideMqSameHead({ pr, head, timeline: readMqTimeline({ repo, pr, exec }) });
  if (decision.hold) {
    log(decision.line);
    if (refresh) mqSameHeadRefresh({ repo, pr, head, decision, exec, log, store: refresh.store, allow: refresh.allow });
  }
  return decision;
}

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
