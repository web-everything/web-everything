/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { execFileSync } from 'node:child_process';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { readRedTeamDisposition, readRedTeamProbes } from './red-team-gate.mjs';

const mqOid = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value) ? value.toLowerCase() : null;
// Explicit failure reasons only; future enum values require operator inspection.
const mqFailureReasons = new Set(['failed_checks', 'ci_failure', 'merge_conflict',
  'branch_protection_failure', 'invalid_merge_commit']);
const mqRemovalReason = event => typeof event?.reason === 'string' ? event.reason.trim().toLowerCase() : '';

function mqLiveReadOptions() {
  const env = { ...process.env };
  delete env.WE_GH_READ_MEMO_DIR;
  // gh-throttle consults throttle.env for memoization independently of the child env.
  return { env, throttle: { env } };
}

function mqSameHeadHold({ pr, head }, reason) {
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  return { hold: true, line: `mq-same-head-failed: #${safe(pr)} head ${safe(head)} — ${safe(reason)}` };
}

/** Only the merge-group commit's second parent identifies the tested PR head. */
export function decideMqSameHead({ pr, head, timeline } = {}) {
  const hold = reason => mqSameHeadHold({ pr, head }, reason);
  const currentHead = mqOid(head);
  if (!currentHead) return hold('missing or invalid head');
  if (timeline?.error || !Array.isArray(timeline?.nodes) || typeof timeline.hasPreviousPage !== 'boolean')
    return hold('unreadable merge-queue timeline; inspect timeline before retrying');
  if (timeline.hasPreviousPage)
    return hold('incomplete timeline at 100-event cap; operator must inspect full history before retrying');
  // Force-push events omit fast-forwards: a push TO this SHA can be a restoration of a failed head.
  // Neither those events nor commit dates can bind an otherwise unbound removal to an older head.
  // Retain the operator-visible hold; a live operator re-enqueue can still reach bookkeeping below.
  for (const event of timeline.nodes) {
    if (event?.__typename === 'AddedToMergeQueueEvent' || event?.__typename === 'HeadRefForcePushedEvent') continue;
    if (event?.__typename !== 'RemovedFromMergeQueueEvent') return hold('unreadable merge-queue event');
    const reason = mqRemovalReason(event);
    if (reason === 'manual' || reason === 'merged') continue;
    if (!mqFailureReasons.has(reason))
      return hold('unknown removal reason; operator must inspect history and enqueue manually');
    const testedHead = mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid);
    if (!testedHead) {
      return hold('no commit binding for merge-queue removal; operator must inspect history and enqueue manually');
    }
    if (testedHead === currentHead) return hold(reason || 'unknown removal reason');
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
        timelineItems(last:100,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT,ADDED_TO_MERGE_QUEUE_EVENT,HEAD_REF_FORCE_PUSHED_EVENT]){
          pageInfo{hasPreviousPage}
          nodes{__typename
            ... on RemovedFromMergeQueueEvent{reason createdAt beforeCommit{oid parents(first:2){nodes{oid}}}}
            ... on AddedToMergeQueueEvent{createdAt}
            ... on HeadRefForcePushedEvent{createdAt beforeCommit{oid} afterCommit{oid}}
          }
        }
      }}
    }`;
    const result = JSON.parse(exec('gh', ['api', 'graphql', '-f', `query=${query}`,
      '-f', `owner=${parts[0]}`, '-f', `name=${parts[1]}`, '-F', `number=${pr}`],
    { ...mqLiveReadOptions(), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    const items = result?.data?.repository?.pullRequest?.timelineItems;
    if (result?.errors?.length || !Array.isArray(items?.nodes) || typeof items?.pageInfo?.hasPreviousPage !== 'boolean')
      return { error: 'unreadable merge-queue timeline' };
    return { nodes: items.nodes, hasPreviousPage: items.pageInfo.hasPreviousPage };
  } catch {
    return { error: 'unreadable merge-queue timeline' };
  }
}

export const mqSameHeadRefreshStatePath = (env = process.env) => env.WE_DRAIN_MQ_REFRESH_STATE_PATH
  || join(homedir(), '.claude', 'conveyor', 'mq-same-head-refresh-state.json');

/** Append-only spent heads. All readers/writers share a lock, never a cached snapshot. */
export function createMqSameHeadRefreshStore({ path = mqSameHeadRefreshStatePath() } = {}) {
  const load = () => {
    let saved;
    try { saved = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
    if (!Array.isArray(saved) || saved.some(key => typeof key !== 'string')) throw new Error('invalid refresh ledger');
    return new Set(saved);
  };
  return {
    has: key => load().has(key),
    claim(key) {
      // Contention never falls back to an unlocked write. A failed request also spends its head.
      mkdirSync(dirname(path), { recursive: true });
      return withFileLock(`${path}.lock`, () => {
        const keys = load();
        if (keys.has(key)) return false;
        keys.add(key);
        writeJsonAtomic(path, [...keys], { mode: 0o600 });
        return true;
      }, { timeoutMs: 0 });
    },
  };
}

export function createMqSameHeadRefreshOptions({ store, approvedHeadHold, enqueueAllowed, repo, pr, head }) {
  return { store, allow: () => enqueueAllowed?.() === true
    && approvedHeadHold({ repo, num: pr }, head, { strict: true }) === false };
}

function mqSameHeadRefresh({ repo, pr, head, exec, log, store, allow }) {
  if (!store) return;
  const key = `${repo}#${pr}@${head}`;
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  const prefix = `mq-same-head-refresh: #${safe(pr)} head ${safe(head)} — `;
  const unavailable = () => log(`${prefix}state unavailable; not requesting; inspect shared refresh ledger and lock before retrying`);
  try { if (store.has(key)) return; } catch { unavailable(); return; }
  const liveOptions = mqLiveReadOptions();
  const opts = { ...liveOptions, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], throttle: { ...liveOptions.throttle, maxAttempts: 1 } };
  try {
    const live = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo,
      '--json', 'mergeStateStatus,headRefOid,statusCheckRollup'], opts));
    if (mqOid(live?.headRefOid) !== head || live.mergeStateStatus !== 'CLEAN') return;
    const checks = live.statusCheckRollup;
    if (!Array.isArray(checks) || !checks.length || !checks.every(check => check
      && (check.status == null || check.status === 'COMPLETED')
      && ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? check.state))) return;
    // Unreadable enqueue or approval evidence is never permission to refresh.
    let allowed = false;
    try { allowed = allow?.() === true; } catch { /* Fail closed before labels or claim. */ }
    if (!allowed) {
      log(`${prefix}authorization refused or unreadable; inspect red-team evidence and workflow/human approval before retrying`);
      return;
    }
    // Read labels LIVE after approval and before spending the claim. Recheck the head too.
    const labeled = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo,
      '--json', 'labels,headRefOid'], opts));
    if (mqOid(labeled?.headRefOid) !== head || !Array.isArray(labeled.labels)) return;
    const names = queueLabels(labeled.labels);
    if (names.some(name => typeof name !== 'string' || !name.trim())
      || sendBackReason(names) || redTeamLabelHoldReason(names)) return;
  } catch { return; }
  try { if (store.claim(key) !== true) { unavailable(); return; } }
  catch { unavailable(); return; }
  try {
    exec('gh', ['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/update-branch`,
      '-f', `expected_head_sha=${head}`], opts);
    log(`${prefix}update-branch requested`);
  } catch (error) {
    const message = safe(String(error?.stderr || error?.message || error).split('\n')[0]).slice(0, 240);
    log(`${prefix}update-branch refused (${message}); not retrying at this head`);
  }
}

export function mqSameHeadGuard({ repo, pr, head, exec = execFileSyncThrottled, log = () => {}, allowAlreadyQueued = true, refresh } = {}) {
  // A human's live retry must reach the strategy's already-queued path and its follow-up/ledger writes.
  // This only skips historical admission for bookkeeping. Fresh mutations use allowAlreadyQueued:false
  // at enqueuePr's mutation boundary, even if another reader still reports the PR as queued.
  const queue = readMergeQueueState({ repo, pr, readJson: args => JSON.parse(exec('gh', args,
    { ...mqLiveReadOptions(), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })) });
  const currentHead = mqOid(head);
  let timeline;
  const decision = queue.error || !currentHead || mqOid(queue.head) !== currentHead
    ? mqSameHeadHold({ pr, head }, 'unreadable or mismatched live merge-queue state; inspect queue before retrying')
    : allowAlreadyQueued && queue.inQueue === true ? { hold: false, line: null }
      : decideMqSameHead({ pr, head, timeline: (timeline = readMqTimeline({ repo, pr, exec })) });
  if (decision.hold) {
    log(decision.line);
    // Unknown/incomplete history cannot authorize recovery. Require a failed removal bound to H.
    const confirmed = !timeline?.error && timeline?.hasPreviousPage === false
      && Array.isArray(timeline.nodes) && timeline.nodes.every(event =>
        event?.__typename === 'AddedToMergeQueueEvent' || event?.__typename === 'HeadRefForcePushedEvent'
        || (event?.__typename === 'RemovedFromMergeQueueEvent'
          && (['manual', 'merged'].includes(mqRemovalReason(event))
            || (mqFailureReasons.has(mqRemovalReason(event))
              && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid)))))
      && timeline.nodes.some(event =>
      event?.__typename === 'RemovedFromMergeQueueEvent'
      && mqFailureReasons.has(mqRemovalReason(event))
      && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === currentHead);
    if (refresh && confirmed) mqSameHeadRefresh({ repo, pr, head: currentHead, exec, log, ...refresh });
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
