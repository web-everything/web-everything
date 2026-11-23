/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { redTeamEnabled, redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { execFileSync } from 'node:child_process';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { ciJobLogApiArgs } from './gh-ci-log.mjs';
import { readNormalizedJobLog } from './ansi-log-text.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { redTeamForHead, isPublishableRedTeamResult, readRedTeamDisposition, readRedTeamProbes, redTeamHoldPendingOnly } from './red-team-gate.mjs';

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
export function decideMqSameHead({ pr, head, timeline, mergeState } = {}) {
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
  for (const event of timeline.nodes) {
    if (event?.__typename === 'AddedToMergeQueueEvent' || event?.__typename === 'HeadRefForcePushedEvent') continue;
    if (event?.__typename !== 'RemovedFromMergeQueueEvent') return hold('unreadable merge-queue event');
    const reason = mqRemovalReason(event);
    if (reason === 'manual' || reason === 'merged') continue;
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
  // History holds admission regardless of log contents. Only update-branch may rerun CI once.
  if (failedChecksRemovals > 0) return hold('failed_checks');
  if (mergeConflictRemovals >= MQ_MERGE_CONFLICT_RETRY_CAP)
    return hold(`repeated merge_conflict ejection (${mergeConflictRemovals} times); operator must inspect history and enqueue manually`);
  if (mergeConflictRemovals > 0 && mergeState !== 'CLEAN')
    return hold(`merge_conflict removal and the PR is not CLEAN (${String(mergeState ?? 'unknown')}); not re-enqueuing`);
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
    hasPr: (repo, pr) => [...load()].some(key => key.startsWith(`${repo}#${pr}@`)),
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
function logMqRefreshSkip({ repo, pr, head, log }, reason) {
  const key = JSON.stringify([repo, pr, head, reason]);
  if (mqSameHeadRefreshSkips.has(key)) return;
  mqSameHeadRefreshSkips.add(key);
  const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  log(`mq-same-head-refresh: #${safe(pr)} head ${safe(head)} — skipped (${safe(reason)})`);
}

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

// Parent shape alone also matches an author's local merge of main. Only a
// verified GitHub web-flow commit can inherit a spent refresh from its parent.
function mqRefreshSuccessor(commit, head) {
  return mqOid(commit?.sha) === head && commit.parents?.length === 2
    && commit.parents.every(parent => mqOid(parent?.sha))
    && commit.committer?.login === 'web-flow' && commit.commit?.verification?.verified === true;
}

function mqSameHeadRefresh({ repo, pr, head, exec, log, store, allow }) {
  const key = `${repo}#${pr}@${head}`;
  const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  const prefix = `mq-same-head-refresh: #${safe(pr)} head ${safe(head)} — `;
  const skip = reason => logMqRefreshSkip({ repo, pr, head, log }, reason);
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
    // UNSTABLE = GitHub says every REQUIRED check passes and only non-required checks (e.g. a stale
    // review-gate / red-team run) fail; the rollup scan would wrongly treat those as blocking (#6774).
    const unstable = live.mergeStateStatus === 'UNSTABLE';
    if (live.mergeStateStatus !== 'CLEAN' && !unstable) { skip('not CLEAN'); return; }
    // Fail closed: UNSTABLE still needs a readable, non-empty REQUIRED-check list that is entirely passing.
    const requiredGreen = () => {
      const req = JSON.parse(exec('gh', ['pr', 'checks', String(pr), '--repo', repo, '--required', '--json', 'name,bucket'], opts));
      if (!(Array.isArray(req) && req.length > 0 && req.every(c => c && ['pass', 'skipping'].includes(c.bucket)))) return false;
      // Only COMPLETED advisory gates (their truth lives in drain-scan labels, rechecked below) may be red; anything
      // else failing or still running keeps blocking, exactly as before.
      const advisory = new Set(['red-team', 'review-gate']);
      return Array.isArray(live.statusCheckRollup) && live.statusCheckRollup.length > 0 && live.statusCheckRollup.every(c => c && c.status === 'COMPLETED'
        && (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion ?? c.state) || advisory.has(c.name)));
    };
    let checksOk = false;
    try { checksOk = unstable ? requiredGreen() : mqRefreshChecksGreen(live.statusCheckRollup, exec, opts); } catch { checksOk = false; }
    if (!checksOk) { skip('checks not green'); return; }
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
    // GitHub can create a new merge commit. Bind that generated head to the spent
    // attempt too; a later author push still has its own independent ledger key.
    try {
      const after = JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'], opts));
      const refreshed = mqOid(after?.headRefOid);
      if (refreshed && refreshed !== head) {
        const commit = JSON.parse(exec('gh', ['api', `repos/${repo}/commits/${refreshed}`], opts));
        if (mqRefreshSuccessor(commit, refreshed) && mqOid(commit.parents[0]?.sha) === head)
          store.claim(`${repo}#${pr}@${refreshed}`);
      }
    } catch { log(`${prefix}post-write head binding unavailable; inspect refresh ledger before further recovery`); }
  } catch (error) {
    const message = safe(String(error?.stderr || error?.message || error).split('\n')[0]).slice(0, 240);
    log(`${prefix}update-branch refused (${message}); not retrying at this head`);
  }
  return true; // The claim is spent even when update-branch refuses the request.
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

// Logs can veto the refresh in favour of the fixer; they never release admission.
// Match failure output across the WHOLE normalized log; command headers are not failure evidence.
const realMqFailure = /^[\t ]*(?:\d{4}-\d\d-\d\dT[\d:.]+Z[\t ]+)?(?:##\[error\][\t ]*)?(?:FAIL(?:ED)?[\t ]+(?:\S+[/\\]\S+|\S+\.[cm]?[jt]sx?\b|[^\r\n]+[\t ]>[\t ])|AssertionError\b|(?:Type|Reference|Syntax|Range)Error:|Error:[\t ]*(?:expect\b|assert(?:ion)?\b|expected\b)|Expected:|Received:|(?:[⎯─━-]+[\t ]*)?Unhandled (?:Rejection|Error)s?\b|Errors[\t ]+\d+ errors?\b|[✗×❯](?=\s))/mi;
function readMqFailureLog({ repo, removal, exec }) {
  const unknown = detail => ({ realFailure: false, detail });
  const commit = mqOid(removal.beforeCommit?.oid);
  if (!commit) return unknown('merge-group commit unavailable; refresh once before fixer');
  const opts = { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } };
  try {
    const checks = [], ids = new Set();
    let total;
    // At most ten pages and ten logs: a fixed twenty-call ceiling.
    for (let page = 1; page <= 10; page++) {
      const data = JSON.parse(exec('gh', ['api', `repos/${repo}/commits/${commit}/check-runs?per_page=100&page=${page}`], opts));
      if (!Number.isSafeInteger(data?.total_count) || data.total_count < 1 || data.total_count > 1000
        || !Array.isArray(data.check_runs) || (total != null && total !== data.total_count)
        || data.check_runs.length !== Math.min(100, data.total_count - checks.length))
        return unknown('failed checks unreadable or incomplete; refresh once before fixer');
      total = data.total_count;
      for (const check of data.check_runs) {
        if (!Number.isSafeInteger(check?.id) || check.id <= 0 || ids.has(check.id) || mqOid(check.head_sha) !== commit)
          return unknown('failed check identity unavailable; refresh once before fixer');
        ids.add(check.id); checks.push(check);
      }
      if (checks.length === total) break;
    }
    const failed = checks.filter(check => !['success', 'skipped', 'neutral'].includes(check.conclusion));
    // A cost bound limits diagnosis, never turns absent evidence into a green verdict.
    if (failed.length > 10) return unknown('failed jobs exceed 10-job limit; refresh once, then fixer must inspect');
    let detail = 'no real assertion failure observed; refresh once before fixer';
    for (const check of failed) {
      let url;
      try { url = new URL(check.details_url); } catch { detail = 'job identity unavailable; refresh once before fixer'; continue; }
      const job = /^\/([^/]+)\/([^/]+)\/actions\/runs\/[1-9][0-9]*\/job\/([1-9][0-9]*)$/.exec(url.pathname);
      if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !job
        || `${job[1]}/${job[2]}` !== repo || !Number.isSafeInteger(Number(job[3]))) continue;
      try {
        const normalized = readNormalizedJobLog(exec('gh', ciJobLogApiArgs(`repos/${repo}/actions/jobs/${job[3]}/logs`), opts));
        if (!normalized.ok) { detail = 'job log normalization failed; refresh once before fixer'; continue; }
        if (!normalized.text.trim()) { detail = 'job log unreadable; refresh once before fixer'; continue; }
        if (realMqFailure.test(normalized.text)) return { realFailure: true, detail: 'real failure observed; route to fixer without refresh' };
      } catch { detail = 'job log unreadable; refresh once before fixer'; }
    }
    return unknown(detail);
  } catch { return unknown('failed job evidence unreadable; refresh once before fixer'); }
}

export function mqSameHeadGuard({ repo, pr, head, exec = execFileSyncThrottled, log = () => {}, allowAlreadyQueued = true,
  refresh, dryRun = false } = {}) {
  // Already queued is bookkeeping only; enqueue rechecks with allowAlreadyQueued:false at its mutation boundary.
  exec = createMqLiveReader(exec);
  const queue = readMergeQueueState({ repo, pr, readJson: args => JSON.parse(exec('gh', args,
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })) });
  const currentHead = mqOid(head);
  let timeline;
  const decision = queue.error || !currentHead || mqOid(queue.head) !== currentHead
    ? mqSameHeadHold({ pr, head }, 'unreadable or mismatched live merge-queue state; inspect queue before retrying')
    : allowAlreadyQueued && queue.inQueue === true ? { hold: false, line: null }
      : decideMqSameHead({ pr, head, timeline: (timeline = readMqTimeline({ repo, pr, exec })),
        mergeState: timelineHasConflict(timeline) ? readMqMergeState({ repo, pr, head: currentHead, exec }) : undefined });
  let recoveryAction = null, detail = null, retriesExhausted;
  if (decision.hold) {
    log(decision.line);
    // Unknown/incomplete history cannot authorize a mutation or a recovery route.
    const confirmed = !timeline?.error && timeline?.hasPreviousPage === false
      && Array.isArray(timeline.nodes) && timeline.nodes.length <= 100 && timeline.nodes.every(event =>
        event?.__typename === 'AddedToMergeQueueEvent' || event?.__typename === 'HeadRefForcePushedEvent'
        || (event?.__typename === 'RemovedFromMergeQueueEvent'
          && (['manual', 'merged'].includes(mqRemovalReason(event))
            || (mqFailureReasons.has(mqRemovalReason(event))
              && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid)))));
    const removals = confirmed ? timeline.nodes.filter(event => event?.__typename === 'RemovedFromMergeQueueEvent'
      && mqFailureReasons.has(mqRemovalReason(event))
      && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === currentHead) : [];
    if (removals.length) {
      let spent = false, ledgerUnreadable = false;
      try {
        const store = refresh?.store, key = `${repo}#${pr}@${currentHead}`;
        spent = store?.has(key) === true;
        // Recover successor binding if the process died or the post-write read failed.
        // Author commits, including local two-parent merges, receive their own attempt.
        if (!spent && store?.hasPr?.(repo, pr) === true) {
          const commit = JSON.parse(exec('gh', ['api', `repos/${repo}/commits/${currentHead}`], {
            encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 },
          }));
          if (mqOid(commit?.sha) !== currentHead || !Array.isArray(commit.parents)
            || ![1, 2].includes(commit.parents.length) || commit.parents.some(parent => !mqOid(parent?.sha)))
            throw new Error('refresh successor binding unavailable');
          if (mqRefreshSuccessor(commit, currentHead) && store.has(`${repo}#${pr}@${mqOid(commit.parents[0].sha)}`)) {
            if (!dryRun) store.claim(key);
            spent = true;
          }
        }
      }
      catch { ledgerUnreadable = true; }
      retriesExhausted = ledgerUnreadable ? undefined : spent;
      if (removals.length > 1 || spent || ledgerUnreadable) {
        recoveryAction = 'fixer';
        detail = ledgerUnreadable ? 'refresh ledger unreadable; hold for fixer inspection'
          : 'single refresh already spent or second same-head failure; hold for fixer';
        // Queue additions never renew a claim for this exact authored head.
        if (spent && refresh && !dryRun) logMqRefreshSkip({ repo, pr, head: currentHead, log }, 'already requested');
        if (ledgerUnreadable && refresh && !dryRun) logMqRefreshSkip({ repo, pr, head: currentHead, log },
          'state unavailable; inspect shared refresh ledger and lock before retrying');
      } else {
        const diagnostic = readMqFailureLog({ repo, removal: removals.at(-1), exec });
        recoveryAction = diagnostic.realFailure ? 'fixer' : 'refresh-first';
        detail = diagnostic.detail;
        if (!dryRun && !diagnostic.realFailure) {
          if (refresh && mqSameHeadRefresh({ repo, pr, head: currentHead, exec, log, ...refresh }) === true)
            retriesExhausted = true;
          else {
            recoveryAction = 'fixer';
            detail = 'single refresh unavailable or refused by preconditions; hold for fixer inspection';
          }
        }
      }
      log(`mq-same-head-recovery: #${String(pr).replace(/\D/g, '')} head ${currentHead} — ${detail}`);
    }
  }
  Object.defineProperties(decision, {
    reason: { value: detail ? `${decision.line}; ${detail}` : decision.line },
    recoveryAction: { value: recoveryAction },
    retriesExhausted: { value: retriesExhausted },
  });
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

/** Trusted, publishable evidence bound to this PR and exact live head. PURE; unreadable is absent proof. */
export function redTeamClearProof({ comments, pr, head } = {}) {
  try {
    if (Array.isArray(comments)) {
      const result = redTeamForHead(comments, pr, head);
      if (isPublishableRedTeamResult(result)) return { ok: true, kind: result.policyClear ? 'policy-clear' : 'result' };
    }
  } catch { /* An unreadable thread never proves clearance. */ }
  return { ok: false, reason: 'unknown(missing)' };
}

export const redTeamClearHoldReason = head => `post-accept red team unknown(missing) on ${String(head ?? '').slice(0, 12)}: no result, policy-clear or carry for this head; re-run the red team on the head`;

export function redTeamEnqueueHold({ ok, reason, loopPayload, comments, pr, head, repo = null, standingRuling = null, env = process.env, confirmedBreaks, scheduled = false, inFlight = false, recorded = false, skipCardOnly } = {}) {
  // A recorded break still holds even if the scheduler is now disabled or the payload is unavailable.
  // `standingRuling`: the verified scope, so an automatic grant counts here exactly as in the gate (PR #5758).
  let disposition;
  try {
    if (!Array.isArray(comments)) return redTeamClearHoldReason(head);
    disposition = readRedTeamDisposition({ comments, pr, head, env, setting: confirmedBreaks, repo, standingRuling });
  } catch { return redTeamClearHoldReason(head); }
  // A hold that is only "publication pending" (PR #6622) is no break: it still holds, but after the unknown-evidence
  // reason, so a capped scan is reported as such.
  const pendingOnly = redTeamHoldPendingOnly(disposition);
  if (!pendingOnly && (disposition.sendBack.length || disposition.held.length))
    return 'post-accept red team confirmed a break requiring send-back';
  // Unknown run evidence holds after the break check, so a capped scan never hides send-back routing; a result
  // comment cannot release it either.
  if (ok === false) return `post-accept red team evidence unknown (${reason}); hold and inspect run evidence`;
  if (pendingOnly) return 'post-accept red team result is not published yet (stored evidence not sealed); hold until the sweep publishes it';
  // Proof from a completed pass cannot release a different pass that is still running.
  if (inFlight && redTeamEnabled(env)) return 'post-accept red team has no recorded result on the live head';
  if (isPublishableRedTeamResult(disposition.result)) return null;
  if (!postAcceptRedTeamOwed(loopPayload, env, { scheduled, inFlight, recorded, skipCardOnly })) {
    // Kill switch thrown (WE_REVIEW_RED_TEAM / WE_REVIEW_EXTRA_SEATS off): enqueue without a result still works.
    if (!redTeamEnabled(env)) return null;
    return redTeamClearProof({ comments, pr, head }).ok ? null : redTeamClearHoldReason(head);
  }
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
