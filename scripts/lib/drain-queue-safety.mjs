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
const MQ_MERGE_CONFLICT_RETRY_CAP = 3;
const mqFailureReasons = new Set(['failed_checks', 'ci_failure',
  'branch_protection_failure', 'invalid_merge_commit']);
const mqRemovalReason = event => typeof event?.reason === 'string' ? event.reason.trim().toLowerCase() : '';

/** One live reader for every same-head authorization dependency, including nested readers.
 * Strip the smoke memo from BOTH gh-throttle's environment and the child environment.
 * Preserve caller options and non-GitHub IO without mutating shared process state.
 */
export function createMqLiveReader(exec = execFileSyncThrottled) {
  return (file, args, opts = {}) => {
    if (file !== 'gh') return exec(file, args, opts);
    const env = { ...(opts.env ?? process.env) };
    const throttleEnv = { ...(opts.throttle?.env ?? process.env) };
    delete env.WE_GH_READ_MEMO_DIR;
    delete throttleEnv.WE_GH_READ_MEMO_DIR;
    return exec(file, args, { ...opts, env, throttle: { ...opts.throttle, env: throttleEnv } });
  };
}

function mqSameHeadHold({ pr, head }, reason) {
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  return { hold: true, line: `mq-same-head-failed: #${safe(pr)} head ${safe(head)} — ${safe(reason)}` };
}

/** Only the merge-group commit's second parent identifies the tested PR head. */
export function decideMqSameHead({ pr, head, timeline, mergeState, retryEvidence } = {}) {
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
  let mergeConflictRemovals = 0;
  let failedChecksRemovals = 0;
  let reenqueuedAfterFailure = false;
  for (const event of timeline.nodes) {
    // The one retry is spent as soon as the PR is queued again after its failed removal, even if that
    // retry later leaves the queue by a manual removal.
    if (event?.__typename === 'AddedToMergeQueueEvent' && failedChecksRemovals > 0) reenqueuedAfterFailure = true;
    if (event?.__typename === 'AddedToMergeQueueEvent' || event?.__typename === 'HeadRefForcePushedEvent') continue;
    if (event?.__typename !== 'RemovedFromMergeQueueEvent') return hold('unreadable merge-queue event');
    const reason = mqRemovalReason(event);
    if (reason === 'manual' || reason === 'merged') continue;
    // A base-dependent conflict is not head-failure evidence, but only while the live PR is CLEAN (checked below).
    // A base-dependent conflict is not head-failure evidence, but only while the live PR is CLEAN (checked below).
    if (reason === 'merge_conflict') {
      mergeConflictRemovals++;
      continue;
    }
    if (!mqFailureReasons.has(reason))
      return hold('unknown removal reason; operator must inspect history and enqueue manually');
    const testedHead = mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid);
    if (!testedHead) {
      return hold('no commit binding for merge-queue removal; operator must inspect history and enqueue manually');
    }
    if (testedHead === currentHead) {
      if (reason === 'failed_checks') failedChecksRemovals++;
      else return hold(reason || 'unknown removal reason');
    }
  }
  if (failedChecksRemovals > 1)
    return hold(`failed_checks (${failedChecksRemovals} removals on this head); operator must inspect history and enqueue manually`);
  if (failedChecksRemovals === 1 && reenqueuedAfterFailure)
    return hold('failed_checks (the single infrastructure retry was already spent); operator must inspect history and enqueue manually');
  if (failedChecksRemovals === 1 && !(retryEvidence?.mainGreen === true
    && ['infra', 'main-red'].includes(retryEvidence.infra) && retryEvidence.mergeState === 'CLEAN'))
    return hold('failed_checks');
  if (mergeConflictRemovals >= MQ_MERGE_CONFLICT_RETRY_CAP)
    return hold(`repeated merge_conflict ejection (${mergeConflictRemovals} times); operator must inspect history and enqueue manually`);
  if (mergeConflictRemovals > 0 && mergeState !== 'CLEAN')
    return hold(`merge_conflict removal and the PR is not CLEAN (${String(mergeState ?? 'unknown')}); not re-enqueuing`);
  return { hold: false, line: failedChecksRemovals === 1
    ? hold(`failed_checks infra retry 1/1 (main green, PR CLEAN, ${retryEvidence.infra})`).line
      .replace(/^mq-same-head-failed:/, 'mq-same-head-retry:')
    : null };
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
    const result = JSON.parse(createMqLiveReader(exec)('gh', ['api', 'graphql', '-f', `query=${query}`,
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

// Skip diagnostics are process-local: refusing a refresh must never spend a shared claim.
const mqSameHeadRefreshSkips = new Set();

// Display names alone do not establish a check origin. StatusContext rows and
// incomplete/non-Actions URLs cannot prove that a failed check was superseded.
function mqRefreshCheckIdentity(check, workflowId) {
  const text = value => typeof value === 'string' && value.trim() ? value : null;
  const name = text(check.name);
  if (check.__typename === 'StatusContext' || !name || !text(check.detailsUrl)) return null;
  let url;
  try { url = new URL(check.detailsUrl); } catch { return null; }
  if (url.origin !== 'https://github.com' || url.username || url.password) return null;
  const run = url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9]\d*)(?:\/job\/([1-9]\d*))?\/?$/);
  if (!run) return null;
  const [, owner, repo, runId, jobId = null] = run;
  const identity = { name, owner: owner.toLowerCase(), repo: repo.toLowerCase(), runId, jobId };
  const workflow_id = workflowId(identity);
  return workflow_id === null ? null : { ...identity, workflow_id };
}

function mqRefreshSameWorkflow(first, second) {
  // Same-name jobs within one run are independent evidence, never retries.
  return second !== null && first.owner === second.owner && first.repo === second.repo
    && first.name === second.name && first.workflow_id === second.workflow_id
    && first.runId !== second.runId;
}

function mqRefreshCheckLater(success, failure) {
  // Completion order alone cannot identify retries: overlapping older attempts
  // can finish last. Require valid start ordering before discarding a failure.
  const laterStart = Date.parse(success.startedAt), earlierStart = Date.parse(failure.startedAt);
  if (!Number.isFinite(laterStart) || !Number.isFinite(earlierStart) || laterStart <= earlierStart) return false;
  for (const field of ['startedAt', 'completedAt']) {
    const later = Date.parse(success[field]), earlier = Date.parse(failure[field]);
    // Missing, tied or contradictory ordering cannot prove supersession.
    if (!Number.isFinite(later) || !Number.isFinite(earlier) || later <= earlier) return false;
  }
  return true;
}

function mqRefreshChecksGreen(checks, exec, opts) {
  // Cache successes AND unreadable evidence only for this decision, never across refreshes.
  const workflows = new Map();
  const workflowId = ({ owner, repo, runId }) => {
    const endpoint = `repos/${owner}/${repo}/actions/runs/${runId}`;
    if (!workflows.has(endpoint)) {
      let id = null;
      try {
        const run = JSON.parse(exec('gh', ['api', endpoint], opts));
        if (Number.isSafeInteger(run?.workflow_id) && run.workflow_id > 0) id = run.workflow_id;
      } catch { /* Unknown workflow identity keeps the failure blocking. */ }
      workflows.set(endpoint, id);
    }
    return workflows.get(endpoint);
  };
  if (!Array.isArray(checks) || !checks.length) return false;
  // Never discard live work, even when a completed success appears later.
  if (checks.some(check => !check || typeof check !== 'object'
    || (check.status != null && check.status !== 'COMPLETED')
    || ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'].includes(check.state))) return false;
  const failures = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  return checks.every(check => {
    const conclusion = check.conclusion ?? check.state;
    if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion)) return true;
    if (check.status !== 'COMPLETED' || !failures.has(conclusion)) return false;
    const identity = mqRefreshCheckIdentity(check, workflowId);
    return identity !== null && checks.some(success => success.status === 'COMPLETED'
      && (success.conclusion ?? success.state) === 'SUCCESS'
      && mqRefreshSameWorkflow(identity, mqRefreshCheckIdentity(success, workflowId)) && mqRefreshCheckLater(success, check));
  });
}

function mqSameHeadRefresh({ repo, pr, head, exec, log, store, allow }) {
  const key = `${repo}#${pr}@${head}`;
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  const prefix = `mq-same-head-refresh: #${safe(pr)} head ${safe(head)} — `;
  const skip = reason => {
    const skipKey = JSON.stringify([repo, pr, head, reason]);
    if (mqSameHeadRefreshSkips.has(skipKey)) return;
    mqSameHeadRefreshSkips.add(skipKey);
    log(`${prefix}skipped (${safe(reason)})`);
  };
  const unavailable = () => skip('state unavailable; inspect shared refresh ledger and lock before retrying');
  if (!store) { unavailable(); return; }
  try { if (store.has(key)) { skip('already requested'); return; } } catch { unavailable(); return; }
  exec = createMqLiveReader(exec);
  const opts = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } };
  let stage = 'checks unreadable';
  try {
    const live = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo,
      '--json', 'mergeStateStatus,headRefOid,statusCheckRollup'], opts));
    if (mqOid(live?.headRefOid) !== head) { skip('head moved'); return; }
    if (live.mergeStateStatus !== 'CLEAN') { skip('not CLEAN'); return; }
    if (!mqRefreshChecksGreen(live.statusCheckRollup, exec, opts)) { skip('checks not green'); return; }
    // Unreadable enqueue or approval evidence is never permission to refresh.
    let allowed = false;
    try { allowed = allow?.() === true; } catch { /* Fail closed before labels or claim. */ }
    if (!allowed) {
      skip('authorization refused or unreadable; inspect red-team evidence and workflow/human approval before retrying');
      return;
    }
    // Read labels LIVE after approval and before spending the claim. Recheck the head too.
    stage = 'labels unreadable';
    const labeled = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo,
      '--json', 'labels,headRefOid'], opts));
    if (mqOid(labeled?.headRefOid) !== head) { skip('head moved'); return; }
    if (!Array.isArray(labeled.labels)) { skip('labels unreadable'); return; }
    const names = queueLabels(labeled.labels);
    if (names.some(name => typeof name !== 'string' || !name.trim())) { skip('labels unreadable'); return; }
    if (sendBackReason(names) || redTeamLabelHoldReason(names)) { skip('blocking label'); return; }
  } catch { skip(stage); return; }
  try { if (store.claim(key) !== true) { skip('claim lost'); return; } }
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

const timelineHasConflict = timeline => Array.isArray(timeline?.nodes)
  && timeline.nodes.some(event => event?.__typename === 'RemovedFromMergeQueueEvent' && mqRemovalReason(event) === 'merge_conflict');

/** Live merge state on the same head, or null (unreadable or head moved) so the conflict exemption fails closed. */
function readMqMergeState({ repo, pr, head, exec }) {
  try {
    const live = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'mergeStateStatus,headRefOid'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    return mqOid(live?.headRefOid) === head ? live.mergeStateStatus ?? null : null;
  } catch { return null; }
}

const timelineHasFailedChecks = (timeline, head) => Array.isArray(timeline?.nodes)
  && timeline.nodes.some(event => event?.__typename === 'RemovedFromMergeQueueEvent'
    && mqRemovalReason(event) === 'failed_checks'
    && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === head);

/** At most ten REST pages per retry probe, shared between checks and main history.
 * Incomplete evidence leaves the historical hold in place for operator inspection.
 */
function readMqRetryEvidence({ repo, pr, head, timeline, exec }) {
  try {
    const removals = timeline.nodes.filter(event => event?.__typename === 'RemovedFromMergeQueueEvent'
      && mqFailureReasons.has(mqRemovalReason(event))
      && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === head);
    if (timeline.error || timeline.hasPreviousPage !== false || removals.length !== 1
      || mqRemovalReason(removals[0]) !== 'failed_checks') return null;
    const removal = removals[0];
    const oid = mqOid(removal.beforeCommit?.oid);
    const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
    const removedAt = timestamp(removal.createdAt);
    if (!oid || !Number.isFinite(removedAt)) return null;
    let budget = 10;
    const readPages = (endpoint, key) => {
      const items = [], ids = new Set();
      let total;
      for (let page = 1; page <= 5; page++) {
        if (budget-- <= 0) throw new Error('retry evidence budget exhausted');
        const result = JSON.parse(exec('gh', ['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`],
          { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
        if (!Number.isSafeInteger(result?.total_count) || result.total_count < 1
          || (total !== undefined && total !== result.total_count) || !Array.isArray(result[key])
          || result[key].length < 1 || result[key].length > 100) throw new Error('invalid retry evidence page');
        total = result.total_count;
        for (const item of result[key]) {
          if (!Number.isSafeInteger(item?.id) || item.id <= 0 || ids.has(item.id))
            throw new Error('invalid retry evidence identity');
          ids.add(item.id);
          items.push(item);
        }
        if (items.length === total) return items;
        if (items.length > total) throw new Error('inconsistent retry evidence count');
      }
      throw new Error('truncated retry evidence; operator must inspect full history');
    };
    const checks = readPages(`repos/${repo}/commits/${oid}/check-runs?filter=all`, 'check_runs');
    const infraConclusions = new Set(['cancelled', 'timed_out', 'startup_failure']);
    const passing = new Set(['success', 'neutral', 'skipped']);
    if (checks.some(check => check.status !== 'completed'
      || !(passing.has(check.conclusion) || infraConclusions.has(check.conclusion) || check.conclusion === 'failure')))
      return null;
    const failed = checks.filter(check => !passing.has(check.conclusion));
    if (!failed.length) return null;
    // Runner terminology alone also appears in ordinary assertion failures.
    const runnerLoss = /\blost communication\b|\b(?:self-hosted[ \t]+)?runner[ \t]+(?:(?:has|was|is)[ \t]+)?(?:disconnected|went away|lost connection|stopped responding|failed to (?:start|connect))\b/i;
    // Any test-failure wording vetoes runner-loss: a real failure must never look like infrastructure.
    const testFailure = /assert|expected|\bexpect\(|\btests?\b|✗|×|\bFAIL\b/i;
    const infra = failed.every(check => infraConclusions.has(check.conclusion)
      || [check.output?.title, check.output?.summary].some(value => typeof value === 'string' && runnerLoss.test(value))
        && ![check.output?.title, check.output?.summary, check.output?.text].some(value => typeof value === 'string' && testFailure.test(value)));
    const runs = readPages(`repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push`, 'workflow_runs');
    const conclusions = new Set([...passing, ...infraConclusions, 'failure', 'action_required', 'stale']);
    const unfinished = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
    if (runs.some(run => run.path !== '.github/workflows/ci.yml' || run.head_branch !== 'main'
      || run.event !== 'push' || (run.status === 'completed' ? !conclusions.has(run.conclusion)
        : !unfinished.has(run.status) || run.conclusion !== null)
      || !Number.isFinite(timestamp(run.created_at))
      || (run.status === 'completed' && !Number.isFinite(timestamp(run.updated_at))))) return null;
    runs.sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || b.id - a.id);
    const before = runs.find(run => run.status === 'completed' && timestamp(run.created_at) < removedAt
      && timestamp(run.updated_at) < removedAt);
    const mainRed = ['failure', 'cancelled', 'timed_out'].includes(before?.conclusion);
    return { mainGreen: runs[0].status === 'completed' && runs[0].conclusion === 'success',
      infra: infra ? 'infra' : mainRed ? 'main-red' : null,
      mergeState: readMqMergeState({ repo, pr, head, exec }) };
  } catch { return null; }
}

export function mqSameHeadGuard({ repo, pr, head, exec = execFileSyncThrottled, log = () => {}, allowAlreadyQueued = true, refresh } = {}) {
  // A human's live retry must reach the strategy's already-queued path and its follow-up/ledger writes.
  // This only skips historical admission for bookkeeping. Fresh mutations use allowAlreadyQueued:false
  // at enqueuePr's mutation boundary, even if another reader still reports the PR as queued.
  exec = createMqLiveReader(exec);
  const queue = readMergeQueueState({ repo, pr, readJson: args => JSON.parse(exec('gh', args,
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })) });
  const currentHead = mqOid(head);
  let timeline;
  const decision = queue.error || !currentHead || mqOid(queue.head) !== currentHead
    ? mqSameHeadHold({ pr, head }, 'unreadable or mismatched live merge-queue state; inspect queue before retrying')
    : allowAlreadyQueued && queue.inQueue === true ? { hold: false, line: null }
      : decideMqSameHead({ pr, head, timeline: (timeline = readMqTimeline({ repo, pr, exec })),
        retryEvidence: timelineHasFailedChecks(timeline, currentHead)
          ? readMqRetryEvidence({ repo, pr, head: currentHead, timeline, exec }) : undefined,
        mergeState: timelineHasConflict(timeline) ? readMqMergeState({ repo, pr, head: currentHead, exec }) : undefined });
  if (!decision.hold && decision.line) log(decision.line);
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
