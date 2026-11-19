/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { inspectMqReruns, requestMqReruns } from './drain-mq-flake-rerun.mjs';
import { readMqInfraJobs } from './drain-mq-infra-evidence.mjs';
import { redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { execFileSync } from 'node:child_process';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { withFileLock, writeJsonAtomic } from './atomic-json-file.mjs';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSharedFreeze } from './red-main-freeze-shared.mjs';
import { readSettings } from './settings-files.mjs';
import { readMergeQueueState } from './merge-queue-enqueue.mjs';
import { readRedTeamDisposition, readRedTeamProbes, redTeamHoldPendingOnly } from './red-team-gate.mjs';
import { readQuarantine } from './red-main-quarantine-io.mjs';
import { activeEntries, parseVitestFailures, QUARANTINE_SAFETY_NET_DEFAULTS } from './red-main-quarantine.mjs';

const mqOid = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value) ? value.toLowerCase() : null;
// Explicit failure reasons only; future enum values require operator inspection.
const MQ_MERGE_CONFLICT_RETRY_CAP = 3;
const MQ_MAIN_GREEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Hard cap even when the shared main reader proves an older success still belongs to main HEAD.
const MQ_INFRA_MAIN_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MQ_INFRA_MAX_JOBS = 10;
const MQ_SUMMARY_TAIL_BYTES = 64 * 1024;
const MQ_INFRA_LOG_BYTES = 4 * 1024 * 1024;

// Every gate row the merge-gate prints for one PR. A pending-freeze verdict is main-caused only when the log is
// structurally complete: header, all of these rows once, the freeze row as the sole blocking row, final HOLD line.
const MQ_GATE_ROWS = ['required-check-read', 'candidate-label', 'producer-certified', 'default-base', 'required-check-green',
  'codeql', 'mergeable', 'landable-state', 'non-empty-body', 'red-team', 'review-hold-labels', 'review-acceptance',
  'manifest-baseline', 'test-gaming', 'head-pin', 'freshness', 'red-main-freeze', 'duplicate-id-on-main', 'couple-whole',
  'blocked-by', 'overlap-yield', 'card-group', 'pass-cap', 'ledger'];
function pendingFreezeLogComplete(log, pr) {
  const lines = log.split('\n').map(line => line.replace(/\r$/, ''));
  const headers = lines.flatMap((line, i) => new RegExp(`^\\S+\\s+#${Number(pr)}: HOLD\\s*$`).test(line) ? [i] : []);
  if (headers.length !== 1) return false;
  const finals = lines.flatMap((line, i) => new RegExp(`^\\S+\\s+merge-gate: HOLD — held: #${Number(pr)}\\s*$`).test(line) ? [i] : []);
  if (finals.length !== 1 || finals[0] <= headers[0]) return false;
  const seen = new Map();
  for (const line of lines.slice(headers[0] + 1, finals[0])) {
    const m = /^\S+\s+(pass|queue|enqueue|fail-closed|hold)\s{2,}([a-z][a-z-]*)\s{2,}\S/.exec(line);
    if (!m || seen.has(m[2])) return false;
    seen.set(m[2], m[1]);
  }
  if (seen.size !== MQ_GATE_ROWS.length || MQ_GATE_ROWS.some(name => !seen.has(name))) return false;
  const blocking = [...seen].filter(([, status]) => status === 'hold' || status === 'fail-closed');
  return blocking.length === 1 && blocking[0][0] === 'red-main-freeze' && blocking[0][1] === 'fail-closed';
}
const MQ_INFRA_SCAN_BYTES = 64 * 1024;
const MQ_INFRA_LINE_CHARS = 512;
const MQ_INFRA_SIGNATURES = ['could not fetch \\S+ from promisor remote'];
const MQ_AGGREGATE_JOBS = ['test', 'coverage-merge'];
const MQ_AGGREGATE_SUMMARY_STEPS = new Map([
  ['test', 'Gate on shard results'], ['coverage-merge', 'Require successful shards'],
]);
const validMqAggregateJobs = value => Array.isArray(value) && value.length > 0 && value.length <= 16
  && value.every(name => typeof name === 'string' && name.length <= 80
    && /^[A-Za-z0-9][A-Za-z0-9 _-]*(?![\s\S])/.test(name));
const mqDerivedDetails = evidence => evidence?.derivedNames?.length
  ? `; derived aggregates skipped: ${evidence.derivedNames.join(', ')}` : '';

function validMqInfraSignatures(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(source => {
    if (typeof source !== 'string' || source.length > 200 || !/^[A-Za-z0-9]/.test(source)) return false;
    let literals = 0, alphanumerics = 0, wildcards = 0, previousWildcard = false;
    // Consume only literal ASCII letters/digits/spaces, escaped punctuation,
    // and the three wildcard tokens. Unknown syntax fails closed.
    for (let i = 0; i < source.length;) {
      if (/^[A-Za-z0-9 ]$/.test(source[i])) {
        literals++;
        if (source[i] !== ' ') alphanumerics++;
        previousWildcard = false;
        i++;
      } else if (source[i] === '\\') {
        const escaped = source[i + 1];
        if (['S', 'd', 's'].includes(escaped) && source[i + 2] === '+') {
          if (previousWildcard || ++wildcards > 1) return false;
          const next = source[i + 3];
          // Require a delimiter after each greedy class; escaped punctuation
          // is allowed by the grammar below. End-of-source is also safe.
          if (next !== undefined && (escaped === 'S' && next !== ' ' && next !== '\\'
            || escaped === 's' && next === ' '
            || escaped === 'd' && /[0-9]/.test(next))) return false;
          previousWildcard = true;
          i += 3;
        } else if (escaped && /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(escaped)) {
          previousWildcard = false;
          i += 2;
        } else return false;
      } else return false;
    }
    if (literals < 11 || alphanumerics < 10) return false;
    try {
      const re = new RegExp(source);
      // Generic failure wording is not an infra signature, whatever the grammar admits.
      return !['test failed', 'Error: assertion failed', 'tests failed', 'command failed'].some(probe => re.test(probe));
    } catch { return false; }
  });
}
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
  let reenqueuedAfterFailure = 0;
  for (const event of timeline.nodes) {
    // Each retry is spent when queued after a failed removal, including manual withdrawal.
    if (event?.__typename === 'AddedToMergeQueueEvent' && failedChecksRemovals > 0) reenqueuedAfterFailure++;
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
  const infraJobs = retryEvidence?.infra === 'infra-jobs';
  if (infraJobs && (failedChecksRemovals > 1 || reenqueuedAfterFailure > 0))
    return hold('failed_checks (infrastructure requeue already spent: 1/1); operator must inspect history and enqueue manually');
  const infraJobsRetry = infraJobs && retryEvidence.mainGreen === true && retryEvidence.mergeState === 'CLEAN';
  const cancelledRegroup = retryEvidence?.infra === 'cancelled-regroup';
  const cancelledMax = retryEvidence?.mqCancelledRetryMax ?? 2;
  const cancelledRetry = cancelledRegroup && retryEvidence.mergeState === 'CLEAN'
    && Number.isSafeInteger(cancelledMax) && cancelledMax >= 1 && cancelledMax <= 2;
  if (cancelledRegroup && (!Number.isSafeInteger(cancelledMax) || cancelledMax < 1 || cancelledMax > 2))
    return hold('invalid cancellation retry bound; operator must inspect history and enqueue manually');
  if (cancelledRegroup && reenqueuedAfterFailure >= cancelledMax)
    return hold(`failed_checks (cancelled/regroup retries already spent: ${reenqueuedAfterFailure}/${cancelledMax}); operator must inspect history and enqueue manually`);
  if (failedChecksRemovals > 2)
    return hold(`failed_checks (${failedChecksRemovals} removals on this head); operator must inspect history and enqueue manually`);
  if (!cancelledRegroup && failedChecksRemovals > 0 && reenqueuedAfterFailure >= 2)
    return hold('failed_checks (the two infrastructure retries were already spent); operator must inspect history and enqueue manually');
  // Every failing test is in the active red-main quarantine: a known flake, not a head failure.
  const quarantineRetry = retryEvidence?.infra === 'quarantined' && retryEvidence.mergeState === 'CLEAN';
  // Evidence-backed flake: the same failing test(s) passed on the PR head's CI and on a later main run. Once per head.
  const flakeRetry = retryEvidence?.infra === 'flaky-test' && retryEvidence.mainGreen === true
    && retryEvidence.mergeState === 'CLEAN' && failedChecksRemovals === 1 && reenqueuedAfterFailure === 0;
  const exactTestRetry = retryEvidence?.infra === 'exact-test' && retryEvidence.mainGreen === true
    && retryEvidence.mergeState === 'CLEAN' && failedChecksRemovals === 2 && reenqueuedAfterFailure === 1;
  if (failedChecksRemovals > 0 && !infraJobsRetry && !cancelledRetry && !quarantineRetry && !flakeRetry && !exactTestRetry && !(retryEvidence?.mainGreen === true
    && ['infra', 'main-red', 'rerun-green'].includes(retryEvidence.infra) && retryEvidence.mergeState === 'CLEAN'))
    // A re-entry after a failed removal never authorizes the author-recovery route (it ends differently
    // from a plain "— failed_checks" hold), so a spent first retry stays with the operator.
    return hold(failedChecksRemovals === 2 && reenqueuedAfterFailure === 1
      ? 'failed_checks (exact-test proof missing, unreadable or incomplete); operator must inspect history and enqueue manually'
      : reenqueuedAfterFailure > 0
      ? 'failed_checks (re-queued after the failed removal without retry evidence); operator must inspect history and enqueue manually'
      : 'failed_checks');
  if (mergeConflictRemovals >= MQ_MERGE_CONFLICT_RETRY_CAP)
    return hold(`repeated merge_conflict ejection (${mergeConflictRemovals} times); operator must inspect history and enqueue manually`);
  if (mergeConflictRemovals > 0 && mergeState !== 'CLEAN')
    return hold(`merge_conflict removal and the PR is not CLEAN (${String(mergeState ?? 'unknown')}); not re-enqueuing`);
  const retryDetails = `${retryEvidence?.mainRunId != null ? `; main run ${retryEvidence.mainRunId}` : ''}${retryEvidence?.failedNames?.length ? `; failed check(s): ${retryEvidence.failedNames.join(', ')}` : ''}${mqDerivedDetails(retryEvidence)}`;
  return { hold: false, line: failedChecksRemovals > 0
    ? hold((infraJobsRetry ? `failed_checks infrastructure retry 1/1 (INFRA: ${retryEvidence.infraNames.join(', ')}; PR CLEAN)`
      : cancelledRetry ? `failed_checks cancelled/regroup retry ${reenqueuedAfterFailure + 1}/${cancelledMax} (no failed required job; cancelled: ${retryEvidence.cancelledNames.join(', ')}; aggregate derived: ${retryEvidence.derivedNames.join(', ') || 'none'}; PR CLEAN)`
      : quarantineRetry ? 'failed_checks quarantine retry 1/1 (every failing test quarantined, PR CLEAN)'
      : flakeRetry ? 'failed_checks flake retry 1/1 (failing test(s) passed on the PR head CI and on a later main run, PR CLEAN)'
      : exactTestRetry ? 'failed_checks exact-test retry 2/2 (sole failing test passed on the PR head CI, same head, PR CLEAN, main green)'
      : `failed_checks infra retry ${failedChecksRemovals}/2 (main green, PR CLEAN, ${retryEvidence.infra}${retryEvidence.infra === 'rerun-green' ? ' — rerun-confirmed flake' : ''})`) + retryDetails).line
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

/** Same job scoping as CI's quarantine skip: an untagged entry covers unit shards only. */
const derivedAggregate = check => new Set(QUARANTINE_SAFETY_NET_DEFAULTS.derivedJobs).has(localJob(check.name));
const localJob = name => typeof name === 'string' ? name.split(' / ').at(-1) : name;
const entryCoversJob = (entry, job) => entry.job === undefined
  ? /^test-shard \(\d+\)$/.test(localJob(job)) : localJob(entry.job) === localJob(job);

/**
 * Are ALL failing checks explained by active quarantine entries? The list must be stamped `quarantine` (else CI
 * skips nothing). Each failing job is bound to this merge-group commit, its log must give a complete vitest failure
 * list (distinct failing tests == the summary's failed-test count, no truncated names), and every failing test must
 * be covered. Aggregators (`test`, `coverage-merge`) must show no uncovered test failure of their own and only
 * count after at least one unit job. Anything unreadable, incomplete or uncovered returns null: the hold stays.
 */
function readQuarantineCover({ repo, commit, failed, exec, quarantine, flake }) {
  try {
    // `flake`: a test that passed on the PR head's own CI and on a later main run covers itself (no quarantine list).
    let entries = [];
    if (!flake) {
      if (typeof quarantine?.readList !== 'function') return null;
      const read = quarantine.readList();
      if (read?.ok !== true || read.list?.mode !== 'quarantine') return null;
      entries = activeEntries(read.list, { now: (quarantine.now ?? Date.now)() });
      if (!entries.length) return null;
    }
    const unitRe = new RegExp(QUARANTINE_SAFETY_NET_DEFAULTS.unitJobPattern);
    const derived = new Set(QUARANTINE_SAFETY_NET_DEFAULTS.derivedJobs);
    const read1 = (endpoint, max) => String(exec('gh', ['api', endpoint], { encoding: 'utf8', timeout: 60_000,
      maxBuffer: max, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
    let units = 0;
    for (const check of failed) {
      if (typeof check.name !== 'string' || !Number.isSafeInteger(check.id) || check.id <= 0) return null;
      const isDerived = derived.has(localJob(check.name));
      if (!isDerived && !unitRe.test(check.name)) return null;
      // The check-run id is the Actions job id only when the job really is this check on the failed commit.
      // Flake mode: the check-run's own details URL must name this same Actions job (never trust a bare check id).
      if (flake) {
        const u = new URL(check.details_url);
        const m = /^\/([^/]+)\/([^/]+)\/actions\/runs\/[1-9][0-9]*\/job\/([1-9][0-9]*)$/.exec(u.pathname);
        if (u.origin !== 'https://github.com' || u.search || !m || `${m[1]}/${m[2]}` !== repo || Number(m[3]) !== check.id) return null;
      }
      const job = JSON.parse(read1(`repos/${repo}/actions/jobs/${check.id}`, 1024 * 1024));
      if (job?.name !== check.name || mqOid(job?.head_sha) !== commit) return null;
      const text = read1(`repos/${repo}/actions/jobs/${check.id}/logs`, 64 * 1024 * 1024);
      const failures = parseVitestFailures(text);
      const plain = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, '');
      const summary = /^\s*Tests\s+(\d+) failed\b/m.exec(plain);
      const names = new Set(failures.tests.map(t => `${t.file}::${t.name}`));
      // Unhandled errors/rejections fail a run without being a listed test failure: never covered by a quarantine.
      if (/\bUnhandled (?:Rejection|Error)s?\b|^\s*Errors\s+\d+ errors?\b/mi.test(plain)) return null;
      if (isDerived) {
        // An aggregator must positively say a unit/coverage job failed, and nothing else.
        const errors = plain.split('\n').filter(l => l.startsWith('##[error]'));
        if (failures.tests.length || !errors.at(-1)?.startsWith('##[error]Process completed with exit code 1.') || !errors.some(l => /^##\[error\](?:Unit shards|Coverage merge) did not succeed/.test(l))
          || errors.some(l => !/^##\[error\](?:(?:Unit shards|Coverage merge) did not succeed[^\n]*|Process completed with exit code 1\.)$/.test(l))) return null;
        continue;
      }
      // Test output may print `##[error]` text; after vitest's summary only the final exit-code line may follow.
      const afterSummary = plain.slice(plain.search(/^\s*Test Files\s/m)).split('\n').filter(l => l.startsWith('##[error]'));
      if (afterSummary.length !== 1 || !afterSummary[0].startsWith('##[error]Process completed with exit code 1.')) return null;
      if (failures.complete !== true || !summary || !/^##\[error\]Process completed with exit code 1\.\s*$/m.test(plain) || Number(summary[1]) !== names.size
        || failures.tests.some(t => t.name !== null && t.name.length >= 200)) return null;
      for (const { file, name } of failures.tests) {
        if (flake) { if (name === null || !flake.passed(file, name, check)) return null; continue; }
        if (!entries.some(e => entryCoversJob(e, check.name)
          && (e.test === file || (name !== null && e.test === `${file}::${name}`)))) return null;
      }
      if (!isDerived) units++;
    }
    return units > 0 ? true : null;
  } catch { return null; }
}

/** Completed rows only: an unknown timestamp or a tied/newer failure vetoes success. */
function strictHeadSuccess(same, passing) {
  if (!same.length) return { reason: 'no same-named head check' };
  const at = row => typeof row.completed_at === 'string' ? Date.parse(row.completed_at) : NaN;
  if (same.some(row => row.status !== 'completed' || !Number.isFinite(at(row))))
    return { reason: 'unfinished or undated same-named head check' };
  const win = same.filter(row => row.conclusion === 'success')
    .sort((a, b) => at(b) - at(a) || b.id - a.id)[0];
  if (!win) return { reason: 'no successful same-named head check' };
  if (same.some(row => row !== win && !passing.has(row.conclusion) && at(row) >= at(win)))
    return { reason: 'same-named head failure ties or follows success' };
  return { win };
}

const normaliseTestId = assertion => [...(assertion.ancestorTitles ?? []), assertion.title]
  .map(part => String(part ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean).join(' > ');
const newestRunFirst = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id;
function assertionMatches(report, file, id) {
  return report.testResults.filter(result => result.name === file)
    .flatMap(result => result.assertionResults.filter(assertion => normaliseTestId(assertion) === id));
}

/** Reports, job steps, annotations and a bounded summary. Incomplete evidence retains the hold. */
function readMqExactTestEvidence({ repo, pr, head, timeline, exec, now }) {
  try {
    if (timeline.error || timeline.hasPreviousPage !== false || !mqOid(head)) return null;
    const removals = timeline.nodes.filter(event => event?.__typename === 'RemovedFromMergeQueueEvent'
      && mqRemovalReason(event) === 'failed_checks' && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === head);
    if (removals.length !== 2 || timeline.nodes.filter((event, index) => index > timeline.nodes.indexOf(removals[0])
      && event?.__typename === 'AddedToMergeQueueEvent').length !== 1) return null;
    const oid = mqOid(removals[1].beforeCommit?.oid), removedAt = Date.parse(removals[1].createdAt);
    if (!oid || !Number.isFinite(removedAt) || !Number.isFinite(now) || removedAt > now) return null;
    const read = (endpoint, binary = false) => {
      // The staged executor owns the shared allowance, including base-reader IO and cached requests.
      return exec('gh', ['api', `repos/${repo}/${endpoint}`], { encoding: binary ? 'buffer' : 'utf8',
        timeout: binary ? 120_000 : 60_000, maxBuffer: binary ? 64 * 1024 * 1024 : 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } });
    };
    const json = endpoint => JSON.parse(read(endpoint));
    const pages = (endpoint, key) => {
      const rows = [], ids = new Set();
      let total;
      for (let page = 1; page <= 5; page++) {
        const result = json(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0
          || total !== undefined && total !== result.total_count || !Array.isArray(result[key])
          || result[key].length !== Math.min(100, result.total_count - rows.length)) throw new Error('invalid evidence page');
        total = result.total_count;
        for (const row of result[key]) {
          if (!Number.isSafeInteger(row?.id) || row.id <= 0 || ids.has(row.id)) throw new Error('invalid evidence identity');
          ids.add(row.id); rows.push(row);
        }
        if (rows.length === total) return rows;
      }
      throw new Error('incomplete evidence; operator must inspect full history');
    };
    const passing = new Set(['success', 'neutral', 'skipped']);
    const checks = pages(`commits/${oid}/check-runs?filter=all`, 'check_runs');
    if (!checks.length || checks.some(c => c.status !== 'completed'
      || !passing.has(c.conclusion) && c.conclusion !== 'failure')) return null;
    const failed = checks.filter(c => !passing.has(c.conclusion));
    const shards = failed.filter(c => /^test-shard \([1-9][0-9]*\)$/.test(localJob(c.name)));
    if (shards.length !== 1 || failed.some(c => c !== shards[0]
      && (!derivedAggregate(c) || !MQ_AGGREGATE_SUMMARY_STEPS.has(localJob(c.name))))) return null;
    const identity = check => {
      const url = new URL(check.details_url);
      const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(url.pathname);
      if (url.origin !== 'https://github.com' || url.search || url.hash || !match
        || `${match[1]}/${match[2]}` !== repo || Number(match[4]) !== check.id
        || !Number.isSafeInteger(Number(match[3]))) throw new Error('invalid check URL');
      return Number(match[3]);
    };
    const mqRunId = identity(shards[0]);
    const mqRun = json(`actions/runs/${mqRunId}`);
    if (mqRun?.id !== mqRunId || mqRun.path !== '.github/workflows/ci.yml'
      || mqRun.event !== 'merge_group' || mqOid(mqRun.head_sha) !== oid) return null;
    const shardJob = json(`actions/jobs/${shards[0].id}`);
    const unitStep = step => /^Unit suite shard \d+\/\d+ /.test(step.name);
    if (shardJob?.id !== shards[0].id || shardJob.name !== shards[0].name || shardJob.run_id !== mqRunId
      || mqOid(shardJob.head_sha) !== oid || shardJob.status !== 'completed' || shardJob.conclusion !== 'failure'
      || !Array.isArray(shardJob.steps) || shardJob.steps.filter(step => step.conclusion === 'failure').length !== 1
      || !shardJob.steps.some(step => unitStep(step) && step.conclusion === 'failure')
      || shardJob.steps.some(step => step.status !== 'completed'
        || !['success', 'skipped'].includes(step.conclusion) && !(unitStep(step) && step.conclusion === 'failure'))) return null;
    for (const check of failed.filter(c => c !== shards[0])) {
      if (identity(check) !== mqRunId) return null;
      const job = json(`actions/jobs/${check.id}`);
      const gate = MQ_AGGREGATE_SUMMARY_STEPS.get(localJob(check.name));
      if (job?.id !== check.id || job.name !== check.name || job.run_id !== mqRunId || mqOid(job.head_sha) !== oid
        || job.status !== 'completed' || job.conclusion !== 'failure' || !Array.isArray(job.steps)
        || job.steps.filter(step => step.conclusion === 'failure').length !== 1
        || !job.steps.some(step => step.name === gate && step.conclusion === 'failure')
        || job.steps.some(step => step.status !== 'completed' || !['success', 'skipped'].includes(step.conclusion)
          && !(step.name === gate && step.conclusion === 'failure'))) return null;
    }
    const reportOf = (artifact, runId, sha) => {
      if (artifact.expired !== false || artifact.workflow_run?.id !== runId
        || mqOid(artifact.workflow_run?.head_sha) !== sha) throw new Error('invalid report artifact');
      const zip = read(`actions/artifacts/${artifact.id}/zip`, true);
      const report = JSON.parse(String(exec('funzip', [], { input: zip, encoding: 'utf8', timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })));
      if (!Array.isArray(report?.testResults) || report.testResults.some(result => typeof result?.name !== 'string'
        || !Array.isArray(result.assertionResults) || result.assertionResults.some(a => !a || typeof a.title !== 'string'
          || !Array.isArray(a.ancestorTitles) || a.ancestorTitles.some(t => typeof t !== 'string')
          || typeof a.status !== 'string'))) throw new Error('invalid report');
      return report;
    };
    const shard = /^test-shard \((\d+)\)$/.exec(localJob(shards[0].name))[1];
    const artifacts = pages(`actions/runs/${mqRunId}/artifacts?name=timing-unit-${shard}`, 'artifacts');
    if (artifacts.length !== 1 || artifacts[0].name !== `timing-unit-${shard}`) return null;
    const mqReport = reportOf(artifacts[0], mqRunId, oid);
    const failures = mqReport.testResults.flatMap(result => result.assertionResults
      .filter(a => a.status === 'failed').map(a => ({ file: result.name, id: normaliseTestId(a) })));
    // numRuntimeErrorTestSuites is absent from vitest's JSON report when zero; when present it must be 0.
    const failureCounters = ['numFailedTests', 'numFailedTestSuites'];
    const counters = new Set([...failureCounters, ...Object.keys(mqReport).filter(key => /^num.*(?:fail|error)/i.test(key))]);
    if ([...counters].some(key => !Number.isSafeInteger(mqReport[key]) || mqReport[key] < 0
      || mqReport[key] > (['numFailedTests', 'numFailedTestSuites'].includes(key) ? 1 : 0))
      || mqReport.numFailedTests !== 1 || failures.length !== 1 || !failures[0].id
      || mqReport.testResults.some(result => typeof result.message !== 'string' || result.message.trim() !== '')
      || mqReport.testResults.some(result => result.status === 'failed'
        && !result.assertionResults.some(a => a.status === 'failed'))
      // Suite-level agreement: exactly one failed test file, and it is the file holding the failed test.
      || mqReport.testResults.filter(result => result.status === 'failed').length !== 1
      || mqReport.testResults.find(result => result.status === 'failed').name !== failures[0].file) return null;
    // Second structured source 1: the shard job's check-run annotations. vitest's JSON report omits global unhandled
    // errors, so require the one generic exit-code failure and no other failure-level annotation. Warnings and notices
    // are runner chatter. An unreadable or incomplete (count mismatch, over one page) list holds.
    const crun = json(`check-runs/${shards[0].id}`);
    const annotationCount = crun?.output?.annotations_count;
    if (crun?.id !== shards[0].id || !Number.isSafeInteger(annotationCount) || annotationCount < 0 || annotationCount > 100) return null;
    const annotations = json(`check-runs/${shards[0].id}/annotations?per_page=100`);
    if (!Array.isArray(annotations) || annotations.length !== annotationCount) return null;
    const failureNotes = annotations.filter(a => a?.annotation_level === 'failure');
    if (annotations.some(a => !a || typeof a.annotation_level !== 'string' || typeof a.message !== 'string')
      || failureNotes.length !== 1 || failureNotes[0].message.trim() !== 'Process completed with exit code 1.') return null;
    // Additional source: vitest's own final summary block, read from a bounded tail of the failed shard log
    // only (never classified as a whole; aggregators' logs are never read). `Errors  N error(s)` marks unhandled errors.
    const rawLog = read(`actions/jobs/${shards[0].id}/logs`, true);
    const tail = Buffer.from(rawLog).subarray(-MQ_SUMMARY_TAIL_BYTES).toString('utf8')
      .replace(/\x1b\[[0-9;]*m/g, '').replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z /gm, '');
    const tailLines = tail.split(/\r?\n/);
    const starts = tailLines.map((line, i) => /^\s*Test Files\s/.test(line) ? i : -1).filter(i => i >= 0);
    if (starts.length !== 1) return null;
    const block = tailLines.slice(starts[0], starts[0] + 4);
    if (!/^\s*Test Files\s+1 failed\b(?! *\|? *\d+ failed)/.test(block[0]) || !/^\s*Tests\s+1 failed\b/.test(block[1])
      || !/^\s*Start at\s+\S/.test(block[2]) || !/^\s*Duration\s+\S/.test(block[3])
      || tailLines.some(line => /^\s*Errors\s+\d/.test(line))) return null;
    const headChecks = pages(`commits/${head}/check-runs?filter=all`, 'check_runs');
    const { win } = strictHeadSuccess(headChecks.filter(c => c.name === shards[0].name), passing);
    if (!win) return null;
    const headRunId = identity(win), headRun = json(`actions/runs/${headRunId}`), job = json(`actions/jobs/${win.id}`);
    if (headRun?.id !== headRunId || headRun.path !== '.github/workflows/ci.yml' || headRun.event !== 'pull_request'
      || mqOid(headRun.head_sha) !== head || job?.id !== win.id || job.run_id !== headRunId
      || job.name !== win.name || mqOid(job.head_sha) !== head) return null;
    // Scan every timing shard: reassignment is valid, duplicate identities are not.
    // Oversized or incomplete evidence retains the hold for operator inspection.
    const exactPassed = (runId, sha, knownChecks = []) => {
      const shardNumber = name => /^test-shard \(([1-9][0-9]*)\)$/.exec(localJob(name))?.[1];
      const jobs = pages(`actions/runs/${runId}/jobs?filter=latest`, 'jobs')
        .filter(job => shardNumber(job.name) !== undefined);
      const expected = new Set(jobs.map(job => `timing-unit-${shardNumber(job.name)}`));
      if (!jobs.length || jobs.length > 16 || expected.size !== jobs.length
        || jobs.some(job => job.run_id !== runId || mqOid(job.head_sha) !== sha
          || job.status !== 'completed' || job.conclusion !== 'success')
        || knownChecks.some(check => shardNumber(check.name) !== undefined && identity(check) === runId
          && !expected.has(`timing-unit-${shardNumber(check.name)}`))) return false;
      const artifacts = pages(`actions/runs/${runId}/artifacts`, 'artifacts')
        .filter(a => typeof a.name === 'string' && a.name.startsWith('timing-unit-'));
      // Every expected shard must have exactly one artifact, including shards unrelated to the target test.
      if (artifacts.length !== expected.size || new Set(artifacts.map(a => a.name)).size !== expected.size
        || artifacts.some(a => !expected.has(a.name))) return false;
      const hits = artifacts.flatMap(a => assertionMatches(reportOf(a, runId, sha), failures[0].file, failures[0].id));
      return hits.length === 1 && hits[0].status === 'passed';
    };
    if (!exactPassed(headRunId, head, headChecks)) return null;
    const mainEndpoint = 'actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100';
    const mainPage = json(mainEndpoint), runs = mainPage?.workflow_runs;
    const conclusions = new Set([...passing, 'failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required', 'stale']);
    const unfinished = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
    if (!Number.isSafeInteger(mainPage?.total_count) || mainPage.total_count < 0 || !Array.isArray(runs)
      || runs.length !== Math.min(mainPage.total_count, 100) || new Set(runs.map(r => r?.id)).size !== runs.length
      || runs.some(r => !Number.isSafeInteger(r?.id) || r.id <= 0 || r.path !== '.github/workflows/ci.yml'
        || r.event !== 'push' || r.head_branch !== 'main' || !mqOid(r.head_sha)
        || !Number.isFinite(Date.parse(r.created_at))
        || (r.status === 'completed' ? !conclusions.has(r.conclusion) || !Number.isFinite(Date.parse(r.updated_at))
          : !unfinished.has(r.status) || r.conclusion !== null))) return null;
    runs.sort(newestRunFirst);
    const ignored = new Set(['cancelled', 'startup_failure', 'stale', 'action_required']);
    const main = runs.find(r => r.status === 'completed' && !ignored.has(r.conclusion));
    if (!main || main.conclusion !== 'success' || Date.parse(main.created_at) <= removedAt
      || Date.parse(main.created_at) > now || Date.parse(main.updated_at) > now) return null;
    // A newer main run that has not finished is unresolved evidence about main: keep the hold.
    if (runs.some(r => r.status !== 'completed' && newestRunFirst(r, main) < 0)) return null;
    if (now - Date.parse(main.updated_at) > MQ_MAIN_GREEN_MAX_AGE_MS) {
      const mainHead = mqOid(json('git/ref/heads/main')?.object?.sha);
      if (!mainHead || runs.find(run => mqOid(run.head_sha) === mainHead)?.id !== main.id) return null;
    }
    const mainRun = json(`actions/runs/${main.id}`);
    if (mainRun?.id !== main.id || mainRun.path !== '.github/workflows/ci.yml' || mainRun.event !== 'push'
      || mainRun.head_branch !== 'main' || mqOid(mainRun.head_sha) !== mqOid(main.head_sha)
      || mainRun.status !== 'completed' || mainRun.conclusion !== 'success'
      || mainRun.created_at !== main.created_at || mainRun.updated_at !== main.updated_at
      || !exactPassed(main.id, mqOid(main.head_sha))
      || readMqMergeState({ repo, pr, head, exec }) !== 'CLEAN') return null;
    return { mainGreen: true, mainRunId: main.id, infra: 'exact-test', failedNames: failed.map(c => c.name), mergeState: 'CLEAN' };
  } catch { return null; }
}

/** Preserve base-reader evidence, then try the exact-test proof on the second removal.
 * Replay completed IO, including rerun requests, so staging never duplicates a side effect.
 * All readers share the same 68-call ceiling; exhaustion leaves manual inspection as the fallback.
 */
function readMqRetryEvidence(options) {
  const { timeline, head, now = Date.now() } = options;
  const removals = timeline.nodes.filter(e => e?.__typename === 'RemovedFromMergeQueueEvent'
    && mqRemovalReason(e) === 'failed_checks' && mqOid(e.beforeCommit?.parents?.nodes?.[1]?.oid) === head);
  if (removals.length !== 2) return readMqBaseRetryEvidence({ ...options, now });
  let budget = 68;
  const cache = new Map();
  const uncachedExec = (command, args, opts) => {
    if (command === 'gh' && budget-- <= 0)
      throw new Error('retry evidence budget exhausted; operator must inspect evidence manually');
    return options.exec(command, args, opts);
  };
  const exec = (command, args, opts) => {
    if (command !== 'gh') return options.exec(command, args, opts);
    const key = JSON.stringify(args);
    if (!cache.has(key)) {
      try { cache.set(key, { value: uncachedExec(command, args, opts) }); }
      catch (error) { cache.set(key, { error }); }
    }
    const result = cache.get(key);
    if (result.error) throw result.error;
    return result.value;
  };
  // The authorizing PR-state read is its own uncached live read taken last, never the memoized evidence reader.
  const live = evidence => evidence?.mergeState !== 'CLEAN' ? evidence
    : { ...evidence, mergeState: readMqMergeState({ repo: options.repo, pr: options.pr, head, exec: uncachedExec }) };
  const baseOptions = { ...options, exec, now };
  const base = readMqBaseRetryEvidence(baseOptions);
  if (['cancelled-regroup', 'infra-jobs'].includes(base?.infra)) return live(base);
  if (base?.infraJobsDeclined) return base;
  if (base?.mergeState === 'CLEAN' && (base.infra === 'quarantined'
    || base.mainGreen === true && ['infra', 'rerun-green', 'main-red'].includes(base.infra))) return live(base);
  // The exact-test reader alone may read ONE job log: the failed shard's, for vitest's final summary block (a bounded tail).
  let shardLogReads = 0;
  const exactExec = (command, args, opts) => {
    if (command === 'gh' && args.some(arg => /\/logs(?:\?|$)/.test(arg))) {
      if (shardLogReads++ > 0 || !args.some(arg => /\/actions\/jobs\/[1-9][0-9]*\/logs$/.test(arg)))
        throw new Error('log evidence deferred');
    }
    return exec(command, args, opts);
  };
  const exact = readMqExactTestEvidence({ ...baseOptions, exec: exactExec });
  return live(exact ?? base);
}

function readMqMainRetryState({ repo, exec, removedAt, now, spend }) {
  const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
  const passing = new Set(['success', 'neutral', 'skipped']);
  const infraConclusions = new Set(['cancelled', 'timed_out', 'startup_failure']);
  // These queries need only their first page, regardless of the workflow's history size.
  const mainEndpoint = `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push`;
  const readRunPage = (endpoint, limit, allowEmpty = false) => {
    spend();
    const result = JSON.parse(exec('gh', ['api', endpoint],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
    const runs = result?.workflow_runs;
    if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0
      || !Array.isArray(runs) || runs.length !== Math.min(result.total_count, limit)
      || (runs.length === 0 && !(allowEmpty && result.total_count === 0)))
      throw new Error('invalid retry evidence page');
    const ids = new Set();
    for (const run of runs) {
      if (!Number.isSafeInteger(run?.id) || run.id <= 0 || ids.has(run.id))
        throw new Error('invalid retry evidence identity');
      ids.add(run.id);
    }
    return runs;
  };
  const newest = readRunPage(`${mainEndpoint}&per_page=100`, 100, true);
  const runs = readRunPage(`${mainEndpoint}&status=completed&created=<${new Date(removedAt).toISOString()}&per_page=100`, 100, true);
  const conclusions = new Set([...passing, ...infraConclusions, 'failure', 'action_required', 'stale']);
  const unfinished = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
  if ([...newest, ...runs].some(run => run.path !== '.github/workflows/ci.yml' || run.head_branch !== 'main'
    || run.event !== 'push' || (run.status === 'completed' ? !conclusions.has(run.conclusion)
      : !unfinished.has(run.status) || run.conclusion !== null)
    || !Number.isFinite(timestamp(run.created_at))
    || (run.status === 'completed' && !Number.isFinite(timestamp(run.updated_at))))) throw new Error('invalid main CI run');
  runs.sort(newestRunFirst);
  const before = runs.find(run => run.status === 'completed' && timestamp(run.created_at) < removedAt
    && timestamp(run.updated_at) < removedAt);
  const mainRed = ['failure', 'cancelled', 'timed_out'].includes(before?.conclusion);
  newest.sort(newestRunFirst);
  const ignored = new Set([...infraConclusions].filter(c => c !== 'timed_out').concat('stale', 'action_required'));
  const deciding = newest.find(run => run.status === 'completed' && !ignored.has(run.conclusion));
  let stale = deciding && (!Number.isFinite(now) || now - timestamp(deciding.updated_at) > MQ_MAIN_GREEN_MAX_AGE_MS);
  // Freshness is judged by main HEAD: when nothing merged, the newest run for the CURRENT head decides regardless of
  // age. Any unreadable piece keeps the age rule (fail closed); a cancelled/failed/unfinished run for the head never counts.
  if (stale && Number.isFinite(now) && deciding.conclusion === 'success') {
    try {
      spend();
      const mainHead = mqOid(JSON.parse(exec('gh', ['api', `repos/${repo}/git/ref/heads/main`],
        { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }))?.object?.sha);
      const forHead = newest.filter(run => mainHead && mqOid(run.head_sha) === mainHead);
      if (mainHead && forHead[0]?.id === deciding.id) stale = false;
    } catch { /* unreadable main head: keep the age rule */ }
  }
  return { newest, deciding, stale, mainRed,
    mainGreen: !!deciding && !stale && deciding.conclusion === 'success',
    mainGreenReason: !deciding ? 'no completed run in latest 100 runs; operator must inspect main CI before retrying'
      : `newest completed run ${deciding.id} ${stale ? 'stale (older than 2h); wait for fresh main CI before retrying' : `concluded ${deciding.conclusion}`}` };
}

/** Legacy evidence always decides first. Only uncovered shapes may spend the remaining shared budget.
 * Record (rather than memoize) legacy IO so its call counts and mutation ordering stay unchanged.
 */
function readMqBaseRetryEvidence(options) {
  let budget = 30, captured, legacyReading = true;
  const cache = new Map();
  const exec = (command, args, opts) => {
    if (command !== 'gh') return options.exec(command, args, opts);
    if (!legacyReading && budget <= 0) throw new Error('retry evidence budget exhausted');
    budget--;
    const key = JSON.stringify(args);
    try {
      const value = options.exec(command, args, opts);
      cache.set(key, { value });
      return value;
    } catch (error) { cache.set(key, { error }); throw error; }
  };
  const legacy = readMqLegacyRetryEvidence({ ...options, exec, captureChecks: value => { captured = value; } });
  legacyReading = false;
  if (legacy?.infra || !captured) return legacy;
  const { checks: rawChecks, oid, removedAt } = captured;
  const cancelled = check => ['cancelled', 'startup_failure'].includes(check.conclusion);
  const passing = check => ['success', 'neutral', 'skipped'].includes(check.conclusion);
  const failed = rawChecks.filter(check => !passing(check));
  // Even declined regroup evidence belongs to the legacy validator: unreadable attempts,
  // oversized sets and non-CLEAN heads must not trigger extra IO or a different retry allowance.
  const cancelledRegroup = rawChecks.every(check => check.status === 'completed') && failed.some(cancelled)
    && failed.some(check => check.conclusion === 'failure' && options.retryPolicy.mqAggregateJobs.includes(localJob(check.name)))
    && failed.every(check => cancelled(check) || check.conclusion === 'failure'
      && options.retryPolicy.mqAggregateJobs.includes(localJob(check.name)));
  if (cancelledRegroup || !failed.some(check => check.conclusion === 'failure'
    && options.retryPolicy.mqAggregateJobs.includes(localJob(check.name)))) return legacy;
  const replay = (command, args, opts) => {
    const result = command === 'gh' && cache.get(JSON.stringify(args));
    if (!result) return exec(command, args, opts);
    if (result.error) throw result.error;
    return result.value;
  };
  const infraRead = (path, json = true) => {
    const value = replay('gh', ['api', `repos/${options.repo}/${path}`], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: MQ_INFRA_LOG_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 },
    });
    return json ? JSON.parse(value) : value;
  };
  const infraJobs = readMqInfraJobs({ checks: rawChecks, repo: options.repo, commit: oid, removedAt,
    aggregateJobs: options.retryPolicy.mqAggregateJobs, readJson: infraRead, readLog: path => infraRead(path, false) });
  if (!infraJobs) return legacy;
  if (infraJobs.infra !== 'infra-jobs') return { ...infraJobs, infraJobsDeclined: true };
  try {
    const { newest, deciding, mainGreen, mainGreenReason } = readMqMainRetryState({
      repo: options.repo, exec: replay, removedAt, now: options.now, spend: () => {},
    });
    if (!newest.length) throw new Error('missing main CI runs');
    const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
    const bounded = deciding?.status === 'completed' && deciding.conclusion === 'success'
      && [deciding.created_at, deciding.updated_at].every(value => Number.isFinite(timestamp(value))
        && timestamp(value) <= options.now && options.now - timestamp(value) <= MQ_INFRA_MAIN_RUN_MAX_AGE_MS)
      && timestamp(deciding.updated_at) >= timestamp(deciding.created_at);
    return { ...infraJobs, mainGreen: mainGreen && bounded, mainRunId: deciding?.id ?? null,
      logReason: !mainGreen || !bounded
        ? `main CI is not green (${mainGreenReason}; successful run must be created and updated within 24h); operator must inspect main CI and enqueue manually` : null,
      mergeState: readMqMergeState({ repo: options.repo, pr: options.pr, head: options.head, exec }) };
  } catch {
    return { infraJobsDeclined: true,
      logReason: 'main CI evidence unreadable or incomplete (shared API budget may be exhausted); operator must inspect main CI and enqueue manually' };
  }
}

/** At most ten failed jobs, with metadata, logs, reruns and main pages sharing a 30-call budget.
 * Incomplete evidence leaves the historical hold in place for operator inspection.
 */
function readMqLegacyRetryEvidence({ repo, pr, head, timeline, exec, rerunScope, dryRun = false, quarantine, retryPolicy, readFreeze, now = Date.now(), captureChecks = () => {} }) {
  try {
    const removals = timeline.nodes.filter(event => event?.__typename === 'RemovedFromMergeQueueEvent'
      && mqFailureReasons.has(mqRemovalReason(event))
      && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === head);
    if (timeline.error || timeline.hasPreviousPage !== false || removals.length < 1
      || removals.some(event => mqRemovalReason(event) !== 'failed_checks')) return null;
    const removal = removals.at(-1);
    const oid = mqOid(removal.beforeCommit?.oid);
    const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
    const removedAt = timestamp(removal.createdAt);
    if (!oid || !Number.isFinite(removedAt)) return null;
    // Reserve two calls for deciding main CI even when job evidence exhausts its allowance.
    let budget = 30;
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
    const rawChecks = readPages(`repos/${repo}/commits/${oid}/check-runs?filter=all`, 'check_runs');
    captureChecks({ checks: rawChecks, oid, removedAt });
    const cancelled = check => ['cancelled', 'startup_failure'].includes(check.conclusion);
    const passingCheck = check => ['success', 'neutral', 'skipped'].includes(check.conclusion);
    const rawFailed = rawChecks.filter(check => !passingCheck(check));
    const cancelledRegroup = rawChecks.every(check => check.status === 'completed') && rawFailed.some(cancelled)
      && rawFailed.some(check => check.conclusion === 'failure'
        && retryPolicy.mqAggregateJobs.includes(localJob(check.name)))
      && rawFailed.every(check => cancelled(check) || check.conclusion === 'failure'
        && retryPolicy.mqAggregateJobs.includes(localJob(check.name)));
    const attempts = inspectMqReruns({ checks: rawChecks, repo, commit: oid, removedAt });
    if (cancelledRegroup) {
      if (rawFailed.length > MQ_INFRA_MAX_JOBS)
        return { logReason: `failed-job count exceeds ${MQ_INFRA_MAX_JOBS}-job limit; operator must inspect failed jobs and enqueue manually` };
      // Apply the failure validator to cancellations too, without changing ordinary retry evidence.
      // This binds each cancelled/startup_failure original and its reruns to the head and Actions run.
      const regroupAttempts = inspectMqReruns({
        checks: rawChecks.map(check => cancelled(check) ? { ...check, conclusion: 'failure' } : check),
        repo, commit: oid, removedAt,
      });
      // An absent reason is not proof: unreadable attempts also have no reason.
      // Every non-passing check must have a validated original candidate, or confirmed green reruns.
      if (regroupAttempts.reason || regroupAttempts.confirmed !== true
        && regroupAttempts.candidates.length !== rawFailed.length)
        return { logReason: regroupAttempts.reason || 'job attempt evidence unreadable or incomplete; operator must inspect failed jobs and enqueue manually' };
    }
    // Other evidence kinds retain their historical removal and re-enqueue limits.
    if (!cancelledRegroup && (removals.length > 2 || timeline.nodes.filter(event => event?.__typename === 'AddedToMergeQueueEvent'
      && timeline.nodes.indexOf(event) > timeline.nodes.indexOf(removals[0])).length >= 2)) return null;
    const checks = attempts.checks;
    const infraConclusions = new Set(['cancelled', 'timed_out', 'startup_failure']);
    const passing = new Set(['success', 'neutral', 'skipped']);
    if (checks.some(check => check.status !== 'completed'
      || !(passing.has(check.conclusion) || infraConclusions.has(check.conclusion) || check.conclusion === 'failure')))
      return null;
    const failed = checks.filter(check => !passing.has(check.conclusion));
    if (!failed.length) return null;
    const hasAggregateCandidates = failed.some(check => retryPolicy.mqAggregateJobs.includes(localJob(check.name))
      && MQ_AGGREGATE_SUMMARY_STEPS.has(localJob(check.name)));
    const failedNames = failed.map(check => (typeof check.name === 'string' ? check.name : 'unnamed')
      .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')).slice(0, 5);
    // readQuarantineCover validates the aggregators itself (positive evidence, no uncovered failure), so a
    // quarantined shard failure still earns its single retry when `test`/`coverage-merge` fail with it.
    if (!cancelledRegroup && failed.length <= MQ_INFRA_MAX_JOBS && readQuarantineCover({ repo, commit: oid, failed, exec, quarantine }))
      return { mainGreen: false, mainRunId: null, infra: 'quarantined', failedNames, mergeState: readMqMergeState({ repo, pr, head, exec }) };
    // Runner terminology alone also appears in ordinary assertion failures.
    const runnerLoss = /\blost communication\b|\b(?:self-hosted[ \t]+)?runner[ \t]+(?:(?:has|was|is)[ \t]+)?(?:disconnected|went away|lost connection|stopped responding|failed to (?:start|connect))\b/i;
    // Any test-failure wording vetoes runner-loss: a real failure must never look like infrastructure.
    const testFailure = /assert|expected|\bexpect\(|\btests?\b|✗|×|\bFAIL\b/i;
    const summaryInfra = check => infraConclusions.has(check.conclusion)
      || [check.output?.title, check.output?.summary].some(value => typeof value === 'string' && runnerLoss.test(value))
        && ![check.output?.title, check.output?.summary, check.output?.text].some(value => typeof value === 'string' && testFailure.test(value));
    // Infra proof without logs: every failed job was cancelled/never ran, or the only real failure is the
    // merge-gate's own red-main-freeze HOLD (caused by main, not by this PR). A real failing job never qualifies.
    const cancelledOnly = check => check.conclusion === 'cancelled' || check.conclusion === 'startup_failure';
    // The merge-gate's reason is only in its job log: read it once (budgeted) and require the freeze to be the SOLE hold.
    const gates = failed.filter(check => localJob(check.name) === 'merge-gate' && check.conclusion === 'failure');
    // `blocked`: the gate log or shared freeze could not prove the failure main-caused. No fallback may authorize a retry.
    let blocked = false;
    let freezeProven = false, freezePending = false, freezeRunId = NaN, freezeAttempt = NaN;
    if (gates.length === 1 && failed.every(check => check === gates[0] || cancelledOnly(check)) && budget > 2) {
      try {
        const jobPath = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(new URL(gates[0].details_url).pathname);
        if (jobPath && `${jobPath[1]}/${jobPath[2]}` === repo && new URL(gates[0].details_url).origin === 'https://github.com') {
          budget--;
          const log = String(exec('gh', ['api', `repos/${repo}/actions/jobs/${Number(jobPath[4])}/logs`], {
            encoding: 'utf8', timeout: 60_000, maxBuffer: MQ_INFRA_LOG_BYTES, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
          // The WHOLE gate log must be read (a hold outside a tail window would be missed): oversize fails closed.
          if (Buffer.byteLength(log, 'utf8') >= MQ_INFRA_LOG_BYTES) throw new Error('gate log too large to classify');
          // `fail-closed` rows count too: a red-main freeze read that raced a main CI re-run fails closed
          // ("red-main freeze unreadable: … verdict pending") — main-caused and transient, not this PR's defect.
          const holds = log.split('\n').filter(line => /^\S+\s+(?:hold|fail-closed)\s{2,}\S+/.test(line));
          freezeProven = holds.length === 1
            && /^\S+\s+(?:hold\s{2,}red-main-freeze\s+main is RED \(freeze:|fail-closed\s{2,}red-main-freeze\s+red-main freeze unreadable: main CI run ([1-9][0-9]*) is being re-run \(attempt ([1-9][0-9]*)\) — verdict pending\s*$)/.test(holds[0]);
          freezePending = freezeProven && /fail-closed/.test(holds[0]);
          if (freezePending && !pendingFreezeLogComplete(log, pr)) { freezeProven = freezePending = false; blocked = true; }
          if (freezePending) {
            // Bind the log to the expected merge_group run: workflow "Merge gate", job merge-gate, the merge-group commit.
            budget--;
            const job = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/jobs/${Number(jobPath[4])}`], {
              encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
            if (job?.id !== Number(jobPath[4]) || job.name !== 'merge-gate' || job.workflow_name !== 'Merge gate'
              || mqOid(job.head_sha) !== oid || job.status !== 'completed' || job.conclusion !== 'failure')
              { freezeProven = freezePending = false; blocked = true; }
            else if (!(() => {
              // Display names are not identity: the run itself must be the merge-gate workflow's merge_group run for this commit.
              if (!Number.isSafeInteger(job.run_id) || job.run_id !== Number(jobPath[3])) return false;
              const run = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${job.run_id}`], {
                encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
              return run?.id === job.run_id && run.path === '.github/workflows/merge-gate.yml' && run.event === 'merge_group' && mqOid(run.head_sha) === oid;
            })()) { freezeProven = freezePending = false; blocked = true; }
            // The freeze row blames an unreadable MAIN CI verdict; an active (or unreadable) shared freeze always blocks.
            else {
              const shared = readFreeze?.();
              if (!shared || shared.error || shared.frozen !== false) { freezeProven = freezePending = false; blocked = true; }
            }
          }
          if (freezePending) {
            const named = /main CI run ([1-9][0-9]*) is being re-run \(attempt ([1-9][0-9]*)\)/.exec(holds[0]);
            freezeRunId = Number(named?.[1]); freezeAttempt = Number(named?.[2]);
          }
        }
      } catch { blocked = true; /* unreadable gate log: the hold stays */ }
    }
    let noLogInfra = failed.every(cancelledOnly) || freezeProven;
    if (noLogInfra && !freezeProven && failed.length > MQ_INFRA_MAX_JOBS) {
      // Complete cancellation identities retain the legacy no-log path, even above the
      // job-reader cap. Unbound oversized evidence cannot bypass that cap on conclusions alone.
      const cancelledAttempts = inspectMqReruns({
        checks: checks.map(check => cancelledOnly(check) ? { ...check, conclusion: 'failure' } : check),
        repo, commit: oid, removedAt,
      });
      noLogInfra = !cancelledAttempts.reason && (cancelledAttempts.confirmed === true
        || cancelledAttempts.candidates.length === failed.length);
    }
    let logReason = null;
    const patterns = retryPolicy.mqInfraSignatures.map(source => new RegExp(source));
    const logVerdicts = new Map();
    const derived = new Set();
    if (noLogInfra) {
      // No log reads: the job conclusions themselves are the evidence.
    } else if (failed.length > MQ_INFRA_MAX_JOBS) {
      logReason = `failed-job count exceeds ${MQ_INFRA_MAX_JOBS}-job limit; operator must inspect failed jobs and enqueue manually`;
    } else {
      for (const check of failed) {
        if (check.conclusion !== 'failure' && (cancelledRegroup || !hasAggregateCandidates)) continue;
        const summaryStep = retryPolicy.mqAggregateJobs.includes(localJob(check.name))
          ? MQ_AGGREGATE_SUMMARY_STEPS.get(localJob(check.name)) : undefined;
        if (!summaryStep && summaryInfra(check) && !hasAggregateCandidates) continue;
        // Actions job IDs and check-run IDs are separate namespaces. Use only the job
        // ID from an Actions details URL validated against this repository.
        let url;
        try { url = new URL(check.details_url); } catch { continue; }
        const jobPath = /^\/([^/]+)\/([^/]+)\/actions\/runs\/[1-9][0-9]*\/job\/([1-9][0-9]*)$/.exec(url.pathname);
        if (url.origin !== 'https://github.com' || url.search || url.hash || !jobPath
          || `${jobPath[1]}/${jobPath[2]}` !== repo) continue;
        const jobId = Number(jobPath[3]);
        if (!Number.isSafeInteger(jobId) || jobId <= 0) continue;
        if (summaryStep) {
          try {
            if (budget <= 2) throw new Error('retry evidence budget exhausted');
            budget--;
            const job = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/jobs/${jobId}`], {
              encoding: 'utf8', timeout: 60_000, maxBuffer: MQ_INFRA_LOG_BYTES,
              stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 },
            }));
            if (job?.id === jobId && job.name === check.name && mqOid(job.head_sha) === oid
              && job.status === 'completed' && job.conclusion === 'failure'
              && Array.isArray(job.steps) && job.steps.length > 0
              && job.steps.some(step => step?.name === summaryStep && step.conclusion === 'failure')
              && job.steps.every(step => typeof step?.name === 'string'
                && (passing.has(step.conclusion) || step.name === summaryStep && step.conclusion === 'failure'))) {
              derived.add(check.id);
              continue;
            }
          } catch { /* Unknown metadata requires ordinary log evidence below. */ }
        }
        if (cancelledRegroup) continue; // Only validated dependency failures qualify; logs cannot substitute.
        try {
          if (budget <= 2) throw new Error('retry evidence budget exhausted');
          budget--;
          const text = exec('gh', ['api', `repos/${repo}/actions/jobs/${jobId}/logs`], {
            encoding: 'utf8', timeout: 60_000, maxBuffer: MQ_INFRA_LOG_BYTES,
            stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 },
          });
          if (typeof text !== 'string' || !text.trim()) throw new Error('unreadable log');
          // Bound the scan as well as subprocess output. Injected readers may return oversized text.
          const tail = Buffer.from(text.slice(-MQ_INFRA_SCAN_BYTES), 'utf8').subarray(-MQ_INFRA_SCAN_BYTES).toString('utf8');
          let truncatedLine = false;
          const matched = tail.split('\n').some(line => {
            if (line.length > MQ_INFRA_LINE_CHARS) truncatedLine = true;
            const boundedLine = line.slice(-MQ_INFRA_LINE_CHARS);
            return patterns.some(pattern => pattern.test(boundedLine));
          });
          logVerdicts.set(check.id, matched);
          if (!matched && truncatedLine)
            logReason = `non-infrastructure job log within ${MQ_INFRA_LINE_CHARS}-character line scan limit; operator must inspect failed jobs and enqueue manually`;
        } catch {
          logReason = 'job log evidence unreadable or incomplete; operator must inspect failed jobs and enqueue manually';
          logVerdicts.set(check.id, false);
        }
      }
    }
    const intrinsic = failed.filter(check => !derived.has(check.id));
    const derivedNames = failed.filter(check => derived.has(check.id)).map(check => check.name
      .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' '));
    if (cancelledRegroup) {
      if (logReason || intrinsic.some(check => !cancelled(check))) return null;
      return { infra: 'cancelled-regroup', mqCancelledRetryMax: retryPolicy.mqCancelledRetryMax,
        cancelledNames: failed.filter(cancelled).map(check => String(check.name ?? 'unnamed')
          .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')),
        derivedNames, mergeState: readMqMergeState({ repo, pr, head, exec }) };
    }
    if (!intrinsic.length && !noLogInfra)
      logReason = 'only derived aggregate failures; operator must inspect failed jobs and enqueue manually';
    let infra = !logReason && (noLogInfra || intrinsic.every(check => (!hasAggregateCandidates && summaryInfra(check)) || logVerdicts.get(check.id) === true));
    const rerun = requestMqReruns({ attempts, repo, exec, scope: rerunScope,
      eligible: !infra && !logReason && !hasAggregateCandidates, dryRun,
      spend: () => { if (budget <= 2) throw new Error('retry evidence budget exhausted'); budget--; } });
    if (rerun.reason) logReason = rerun.reason;
    if (attempts.reason) infra = false;
    else if (!logReason && attempts.confirmed) infra = true;
    const { newest, deciding, stale, mainRed, mainGreen, mainGreenReason } = readMqMainRetryState({
      repo, exec, removedAt, now, spend: () => { if (budget-- <= 0) throw new Error('retry evidence budget exhausted'); },
    });
    const mergeState = readMqMergeState({ repo, pr, head, exec });
    if (attempts.confirmed && mergeState !== 'CLEAN')
      logReason = `PR is not CLEAN (${typeof mergeState === 'string' && /^[A-Z_]{1,32}$/.test(mergeState) ? mergeState : 'unknown'})`;
    // Evidence-backed flake: every failing test passed on the PR head's own CI AND on a main run created after
    // the ejection, the PR is CLEAN, and this is the head's first removal. One retry only (decideMqSameHead).
    let flaky = false, flakeReason = null;
    if (!infra && !logReason && !attempts.reason && removals.length === 1 && mergeState === 'CLEAN'
      && deciding?.conclusion === 'success' && !stale && timestamp(deciding.created_at) > removedAt
      && failed.length <= MQ_INFRA_MAX_JOBS && budget > 4) {
      try {
        const headChecks = readPages(`repos/${repo}/commits/${head}/check-runs?filter=all`, 'check_runs');
        // Per-name proof: unrelated workflows' checks (e.g. review-gate) on the head are ignored. Each failed check's
        // name needs a successful same-named run with no failing run of that name completed after it.
        const doneAt = c => { const v = Date.parse(c.completed_at ?? c.started_at ?? ''); return Number.isFinite(v) ? v : 0; };
        const newestSuccess = new Map();
        let headGreen = true;
        for (const name of new Set(failed.map(check => localJob(check.name)))) {
          const same = headChecks.filter(c => localJob(c.name) === name);
          const wins = same.filter(c => c.status === 'completed' && c.conclusion === 'success').sort((a, b) => doneAt(b) - doneAt(a) || b.id - a.id);
          if (!wins.length) { flakeReason = `PR head has no successful run of ${name}`; headGreen = false; break; }
          if (same.some(c => c !== wins[0] && c.status === 'completed' && !passing.has(c.conclusion) && doneAt(c) > doneAt(wins[0]))) {
            flakeReason = `PR head has a failing run of ${name} newer than its success`; headGreen = false; break;
          }
          newestSuccess.set(name, wins[0]);
        }
        // Name-level proof: CI uploads each shard's vitest JSON report (artifact `timing-unit-<n>`). The SAME shard on
        // the PR head's run and on the deciding main run must list the failing test, by exact file and full name,
        // with status `passed`. Anything unreadable, expired, unparsable or ambiguous fails closed.
        const shardArtifact = check => /^test-shard \((\d+)\)$/.exec(localJob(check.name))?.[1];
        const runOf = check => {
          const url = new URL(check.details_url);
          const m = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/.exec(url.pathname);
          return url.origin === 'https://github.com' && !url.search && m && `${m[1]}/${m[2]}` === repo ? Number(m[3]) : NaN;
        };
        const reports = new Map();
        const readReport = (runId, shard, sha) => {
          const key = `${runId}:${shard}`;
          if (reports.has(key)) return reports.get(key);
          if (!Number.isSafeInteger(runId) || runId <= 0 || budget <= 3) throw new Error('retry evidence budget exhausted');
          budget -= 2;
          const list = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${runId}/artifacts?name=timing-unit-${shard}&per_page=100`],
            { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
          // The artifact must belong to exactly this run, built from exactly the expected commit.
          const found = (list?.artifacts ?? []).filter(a => a?.name === `timing-unit-${shard}` && a.expired !== true && Number.isSafeInteger(a.id)
            && a.workflow_run?.id === runId && mqOid(a.workflow_run?.head_sha) === mqOid(sha));
          if (found.length !== 1) throw new Error('report artifact missing, expired or ambiguous');
          const zip = exec('gh', ['api', `repos/${repo}/actions/artifacts/${found[0].id}/zip`],
            { encoding: 'buffer', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } });
          const json = String(exec('funzip', [], { input: zip, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'] }));
          const report = JSON.parse(json);
          if (!Array.isArray(report?.testResults)) throw new Error('unparsable report');
          reports.set(key, report);
          return report;
        };
        const passedIn = (report, file, name) => {
          const suffix = `/${file}`;
          const files = report.testResults.filter(r => typeof r?.name === 'string' && (r.name === file || r.name.endsWith(suffix)));
          if (files.length !== 1) return false;
          // Exact match after whitespace normalisation only (real reports carry an empty root title and padded names).
          const norm = text => String(text).trim().split(/\s+>\s+/).map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' > ');
          const want = norm(name);
          const hits = (files[0].assertionResults ?? []).filter(a => norm([...(a?.ancestorTitles ?? []), a?.title]
            .map(part => String(part ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean).join(' > ')) === want);
          return hits.length === 1 && hits[0].status === 'passed';
        };
        const headIdentity = new Map();
        flaky = headGreen && failed.every(check => shardArtifact(check) !== undefined || derivedAggregate(check));
        if (flaky) {
          flaky = readQuarantineCover({ repo, commit: oid, failed, exec, flake: { passed: (file, name, check) => {
            const shard = shardArtifact(check);
            const headRuns = [newestSuccess.get(localJob(check.name))].filter(Boolean);
            const headRunId = headRuns.length === 1 ? runOf(headRuns[0]) : NaN;
            const identityKey = `${headRunId}:${headRuns[0]?.id}`;
            if (!headIdentity.has(identityKey)) {
              // The run must be this repo's ci.yml on the PR head, and the job must be this check's own job in that run.
              budget -= 2;
              const runInfo = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${headRunId}`], { encoding: 'utf8',
                timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
              const jobInfo = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/jobs/${Number(/\/job\/([1-9][0-9]*)$/.exec(new URL(headRuns[0].details_url).pathname)?.[1])}`],
                { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }));
              headIdentity.set(identityKey, runInfo?.id === headRunId && runInfo.path === '.github/workflows/ci.yml'
                && mqOid(runInfo.head_sha) === head && jobInfo?.run_id === headRunId && jobInfo.name === headRuns[0].name
                && mqOid(jobInfo.head_sha) === head);
            }
            if (headIdentity.get(identityKey) !== true) return false;
            return shard !== undefined && headRuns.length === 1 && headRuns[0].conclusion === 'success'
              && passedIn(readReport(runOf(headRuns[0]), shard, head), file, name)
              && passedIn(readReport(deciding.id, shard, deciding.head_sha), file, name);
          } } }) === true;
        }
        if (!flaky && headGreen && !flakeReason) flakeReason = 'per-test pass proof missing, unreadable, expired or not from this shard (fails closed)';
      } catch { flaky = false; }
    }
    // A pending-rerun freeze proof needs main settled: any unfinished main run keeps the verdict unknown.
    return { mainGreen: mainGreen
        && !(freezePending && (newest.some(run => run.status !== 'completed')
          || !newest.some(run => run.id === freezeRunId && run.run_attempt === freezeAttempt && run.status === 'completed' && run.conclusion === 'success'))),
      mainRunId: deciding?.id ?? null,
      mainGreenReason,
      failedNames,
      derivedNames,
      infra: blocked ? null : infra ? (attempts.confirmed ? 'rerun-green' : 'infra') : flaky ? 'flaky-test' : !hasAggregateCandidates && !logReason && mainRed ? 'main-red' : null,
      logReason,
      flakeReason: flaky ? null : flakeReason,
      mergeState };
  } catch { return null; }
}

/** Why a same-head failed_checks retry was declined, so a held PR is never silent. */
function mqRetryDeclineReason(evidence, holdLine) {
  const base = mqRetryDeclineReasonBase(evidence, holdLine);
  return evidence?.flakeReason ? `${base}; flake evidence: ${evidence.flakeReason}` : base;
}
function mqRetryDeclineReasonBase(evidence, holdLine) {
  if (evidence?.infra === 'infra-jobs' && /already spent/.test(holdLine ?? ''))
    return 'infrastructure requeue exhausted (1/1); operator must inspect history and enqueue manually';
  if (evidence?.infra === 'cancelled-regroup' && /already spent/.test(holdLine ?? ''))
    return 'cancelled/regroup retry bound reached; operator must inspect history and enqueue manually';
  if (/removals on this head|already spent/.test(holdLine ?? '')) return 'retry bound reached (this head already had its single retry)';
  if (!evidence) return 'retry evidence unreadable or incomplete';
  if (evidence.logReason) return evidence.logReason;
  if (['quarantined', 'cancelled-regroup', 'infra-jobs'].includes(evidence.infra))
    return `PR is not CLEAN (${typeof evidence.mergeState === 'string' && /^[A-Z_]{1,32}$/.test(evidence.mergeState) ? evidence.mergeState : 'unknown'})`;
  if (evidence.mainGreen !== true) return `main CI is not green (${evidence.mainGreenReason ?? 'no completed run'})`;
  if (!['infra', 'main-red', 'flaky-test', 'exact-test'].includes(evidence.infra))
    return `non-infrastructure failed check(s): ${(evidence.failedNames ?? []).join(', ') || 'unknown'}; main was not red at removal`;
  if (evidence.mergeState !== 'CLEAN') return `PR is not CLEAN (${typeof evidence.mergeState === 'string' && /^[A-Z_]{1,32}$/.test(evidence.mergeState) ? evidence.mergeState : 'unknown'})`;
  return 'retry conditions not met';
}

export function mqSameHeadGuard({ repo, pr, head, exec = execFileSyncThrottled, log = () => {}, allowAlreadyQueued = true, refresh, dryRun = false, now = Date.now(),
  // Hermetic under test: the live ops/quarantine branch is only consulted when a test injects a reader.
  readFreeze = readSharedFreeze,
  quarantine = { readList: process.env.VITEST || process.env.WE_UNDER_TEST ? null : () => readQuarantine() } } = {}) {
  // A human's live retry must reach the strategy's already-queued path and its follow-up/ledger writes.
  // This only skips historical admission for bookkeeping. Fresh mutations use allowAlreadyQueued:false
  // at enqueuePr's mutation boundary, even if another reader still reports the PR as queued.
  const rerunScope = exec;
  exec = createMqLiveReader(exec);
  const queue = readMergeQueueState({ repo, pr, readJson: args => JSON.parse(exec('gh', args,
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })) });
  const currentHead = mqOid(head);
  let timeline, retryEvidence;
  const decision = queue.error || !currentHead || mqOid(queue.head) !== currentHead
    ? mqSameHeadHold({ pr, head }, 'unreadable or mismatched live merge-queue state; inspect queue before retrying')
    : allowAlreadyQueued && queue.inQueue === true ? { hold: false, line: null }
      : decideMqSameHead({ pr, head, timeline: (timeline = readMqTimeline({ repo, pr, exec })),
        retryEvidence: (retryEvidence = timelineHasFailedChecks(timeline, currentHead)
          ? readMqRetryEvidence({ repo, pr, head: currentHead, timeline, exec, rerunScope, dryRun, quarantine, now, readFreeze,
            retryPolicy: readDrainQueueSafety().value }) : undefined),
        mergeState: timelineHasConflict(timeline) ? readMqMergeState({ repo, pr, head: currentHead, exec }) : undefined });
  if (!decision.hold && decision.line) log(decision.line);
  if (decision.hold) {
    log(decision.line);
    if (retryEvidence?.infra === 'infra-jobs' && /already spent/.test(decision.line ?? ''))
      log(`mq-infra-requeue-exhausted: #${String(pr).replace(/\D/g, '')} head ${currentHead} — automatic infrastructure retry 1/1 spent; operator must inspect history and enqueue manually`);
    if (timelineHasFailedChecks(timeline, currentHead))
      log(`mq-same-head-retry-declined: #${String(pr).replace(/\D/g, '')} head ${currentHead} — ${mqRetryDeclineReason(retryEvidence, decision.line)}${retryEvidence?.failedNames?.length ? `; failed check(s): ${retryEvidence.failedNames.join(', ')}` : ''}${mqDerivedDetails(retryEvidence)}${retryEvidence?.derivedNames?.length && retryEvidence.mainRunId != null ? `; main run ${retryEvidence.mainRunId}` : ''}`);
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
  // Keep the historical enumerable hold/line shape for existing callers. Outcome producers
  // explicitly forward reason so catch-up logs retain the explanation and deciding main run.
  const reason = decision.hold && timelineHasFailedChecks(timeline, currentHead)
    ? `${decision.line}; ${mqRetryDeclineReason(retryEvidence, decision.line)}${mqDerivedDetails(retryEvidence)}${retryEvidence?.mainRunId != null ? `; main run ${retryEvidence.mainRunId}` : ''}`
    : decision.line;
  Object.defineProperties(decision, {
    reason: { value: reason }, mainRunId: { value: retryEvidence?.mainRunId ?? null },
  });
  return decision;
}

export function readDrainQueueSafety({ env = process.env, tool, platform, log = () => {} } = {}) {
  const booleanEnv = key => env[key] === undefined ? undefined
    : /^(true|1|on)$/i.test(env[key]) ? true : /^(false|0|off)$/i.test(env[key]) ? false : env[key];
  const numberEnv = key => env[key] === undefined ? undefined : Number(env[key]);
  let mqInfraSignatures;
  let mqAggregateJobs;
  if (env.WE_DRAIN_MQ_AGGREGATE_JOBS !== undefined) {
    try { mqAggregateJobs = JSON.parse(env.WE_DRAIN_MQ_AGGREGATE_JOBS); }
    catch { mqAggregateJobs = env.WE_DRAIN_MQ_AGGREGATE_JOBS; }
  }
  if (env.WE_DRAIN_MQ_INFRA_SIGNATURES !== undefined) {
    try { mqInfraSignatures = JSON.parse(env.WE_DRAIN_MQ_INFRA_SIGNATURES); }
    catch { mqInfraSignatures = env.WE_DRAIN_MQ_INFRA_SIGNATURES; }
  }
  const positive = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, standard: { mqAggregateJobs: MQ_AGGREGATE_JOBS, mqInfraSignatures: MQ_INFRA_SIGNATURES, mqCancelledRetryMax: 2, queueRebuildMax: 3, waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true, redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 },
    valid: { mqAggregateJobs: validMqAggregateJobs, mqInfraSignatures: validMqInfraSignatures, mqCancelledRetryMax: v => Number.isSafeInteger(v) && v >= 1 && v <= 2, queueRebuildMax: v => Number.isSafeInteger(v) && v > 0, waitForRedTeamBeforeEnqueue: v => typeof v === 'boolean', dequeueOnSendBack: v => typeof v === 'boolean', redTeamPendingBackoffSec: positive, redTeamPendingMaxMin: positive },
    envValues: { mqAggregateJobs, mqInfraSignatures, mqCancelledRetryMax: numberEnv('WE_DRAIN_MQ_CANCELLED_RETRY_MAX'), queueRebuildMax: numberEnv('WE_DRAIN_QUEUE_REBUILD_MAX'), waitForRedTeamBeforeEnqueue: booleanEnv('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE'), dequeueOnSendBack: booleanEnv('WE_DRAIN_DEQUEUE_ON_SEND_BACK'), redTeamPendingBackoffSec: numberEnv('WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC'), redTeamPendingMaxMin: numberEnv('WE_DRAIN_RED_TEAM_PENDING_MAX_MIN') },
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

export function redTeamEnqueueHold({ ok, reason, loopPayload, comments, pr, head, repo = null, standingRuling = null, env = process.env, confirmedBreaks, scheduled = false, inFlight = false, recorded = false, skipCardOnly } = {}) {
  // A recorded break still holds even if the scheduler is now disabled or the payload is unavailable.
  // `standingRuling`: the verified scope, so an automatic grant counts here exactly as in the gate (PR #5758).
  const disposition = readRedTeamDisposition({ comments, pr, head, env, setting: confirmedBreaks, repo, standingRuling });
  // A hold that is only "publication pending" (PR #6622) is no break: it still holds, but after the unknown-evidence
  // reason, so a capped scan is reported as such.
  const pendingOnly = redTeamHoldPendingOnly(disposition);
  if (!pendingOnly && (disposition.sendBack.length || disposition.held.length))
    return 'post-accept red team confirmed a break requiring send-back';
  // Unknown run evidence holds after the break check, so a capped scan never hides send-back routing; a result
  // comment cannot release it either.
  if (ok === false) return `post-accept red team evidence unknown (${reason}); hold and inspect run evidence`;
  if (pendingOnly) return 'post-accept red team result is not published yet (stored evidence not sealed); hold until the sweep publishes it';
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
