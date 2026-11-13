/** Queue admission and removal share this policy and head-bound red-team evidence. */
import { inspectMqReruns, requestMqReruns } from './drain-mq-flake-rerun.mjs';
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
import { readRedTeamDisposition, readRedTeamProbes, redTeamHoldPendingOnly } from './red-team-gate.mjs';
import { readQuarantine } from './red-main-quarantine-io.mjs';
import { activeEntries, parseVitestFailures, QUARANTINE_SAFETY_NET_DEFAULTS } from './red-main-quarantine.mjs';

const mqOid = value => typeof value === 'string' && /^[a-f0-9]{40}(?![\s\S])/i.test(value) ? value.toLowerCase() : null;
// Explicit failure reasons only; future enum values require operator inspection.
const MQ_MERGE_CONFLICT_RETRY_CAP = 3;
const MQ_MAIN_GREEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MQ_INFRA_MAX_JOBS = 10;
const MQ_INFRA_LOG_BYTES = 4 * 1024 * 1024;
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
  if (failedChecksRemovals > 2)
    return hold(`failed_checks (${failedChecksRemovals} removals on this head); operator must inspect history and enqueue manually`);
  if (failedChecksRemovals > 0 && reenqueuedAfterFailure >= 2)
    return hold('failed_checks (the two infrastructure retries were already spent); operator must inspect history and enqueue manually');
  // Every failing test is in the active red-main quarantine: a known flake, not a head failure.
  const quarantineRetry = retryEvidence?.infra === 'quarantined' && retryEvidence.mergeState === 'CLEAN';
  // Evidence-backed flake: the same failing test(s) passed on the PR head's CI and on a later main run. Once per head.
  const flakeRetry = retryEvidence?.infra === 'flaky-test' && retryEvidence.mainGreen === true
    && retryEvidence.mergeState === 'CLEAN' && failedChecksRemovals === 1 && reenqueuedAfterFailure === 0;
  if (failedChecksRemovals > 0 && !quarantineRetry && !flakeRetry && !(retryEvidence?.mainGreen === true
    && ['infra', 'main-red', 'rerun-green'].includes(retryEvidence.infra) && retryEvidence.mergeState === 'CLEAN'))
    // A re-entry after a failed removal never authorizes the author-recovery route (it ends differently
    // from a plain "— failed_checks" hold), so a spent first retry stays with the operator.
    return hold(reenqueuedAfterFailure > 0
      ? 'failed_checks (re-queued after the failed removal without retry evidence); operator must inspect history and enqueue manually'
      : 'failed_checks');
  if (mergeConflictRemovals >= MQ_MERGE_CONFLICT_RETRY_CAP)
    return hold(`repeated merge_conflict ejection (${mergeConflictRemovals} times); operator must inspect history and enqueue manually`);
  if (mergeConflictRemovals > 0 && mergeState !== 'CLEAN')
    return hold(`merge_conflict removal and the PR is not CLEAN (${String(mergeState ?? 'unknown')}); not re-enqueuing`);
  const retryDetails = `${retryEvidence?.mainRunId != null ? `; main run ${retryEvidence.mainRunId}` : ''}${retryEvidence?.failedNames?.length ? `; failed check(s): ${retryEvidence.failedNames.join(', ')}` : ''}${mqDerivedDetails(retryEvidence)}`;
  return { hold: false, line: failedChecksRemovals > 0
    ? hold((quarantineRetry ? 'failed_checks quarantine retry 1/1 (every failing test quarantined, PR CLEAN)'
      : flakeRetry ? 'failed_checks flake retry 1/1 (failing test(s) passed on the PR head CI and on a later main run, PR CLEAN)'
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

/** At most ten failed jobs, with metadata, logs, reruns and main pages sharing a 30-call budget.
 * Incomplete evidence leaves the historical hold in place for operator inspection.
 */
function readMqRetryEvidence({ repo, pr, head, timeline, exec, rerunScope, dryRun = false, quarantine, retryPolicy, now = Date.now() }) {
  try {
    const removals = timeline.nodes.filter(event => event?.__typename === 'RemovedFromMergeQueueEvent'
      && mqFailureReasons.has(mqRemovalReason(event))
      && mqOid(event.beforeCommit?.parents?.nodes?.[1]?.oid) === head);
    if (timeline.error || timeline.hasPreviousPage !== false || removals.length < 1 || removals.length > 2
      || removals.some(event => mqRemovalReason(event) !== 'failed_checks')) return null;
    if (timeline.nodes.filter(event => event?.__typename === 'AddedToMergeQueueEvent'
      && timeline.nodes.indexOf(event) > timeline.nodes.indexOf(removals[0])).length >= 2) return null;
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
    const attempts = inspectMqReruns({ checks: readPages(`repos/${repo}/commits/${oid}/check-runs?filter=all`, 'check_runs'), repo, commit: oid, removedAt });
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
    if (failed.length <= MQ_INFRA_MAX_JOBS && readQuarantineCover({ repo, commit: oid, failed, exec, quarantine }))
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
    let freezeProven = false;
    if (gates.length === 1 && failed.every(check => check === gates[0] || cancelledOnly(check)) && budget > 2) {
      try {
        const jobPath = /^\/([^/]+)\/([^/]+)\/actions\/runs\/[1-9][0-9]*\/job\/([1-9][0-9]*)$/.exec(new URL(gates[0].details_url).pathname);
        if (jobPath && `${jobPath[1]}/${jobPath[2]}` === repo && new URL(gates[0].details_url).origin === 'https://github.com') {
          budget--;
          const log = String(exec('gh', ['api', `repos/${repo}/actions/jobs/${Number(jobPath[3])}/logs`], {
            encoding: 'utf8', timeout: 60_000, maxBuffer: MQ_INFRA_LOG_BYTES, stdio: ['ignore', 'pipe', 'pipe'], throttle: { maxAttempts: 1 } }))
            .slice(-MQ_INFRA_SCAN_BYTES);
          const holds = log.split('\n').filter(line => /^\S+\s+hold\s{2,}\S+/.test(line));
          freezeProven = holds.length === 1 && /^\S+\s+hold\s{2,}red-main-freeze\s+main is RED \(freeze:/.test(holds[0]);
        }
      } catch { /* unreadable gate log: the hold stays */ }
    }
    const noLogInfra = failed.every(cancelledOnly) || freezeProven;
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
        if (check.conclusion !== 'failure' && !hasAggregateCandidates) continue;
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
    if (!intrinsic.length && !noLogInfra)
      logReason = 'only derived aggregate failures; operator must inspect failed jobs and enqueue manually';
    let infra = !logReason && (noLogInfra || intrinsic.every(check => (!hasAggregateCandidates && summaryInfra(check)) || logVerdicts.get(check.id) === true));
    const rerun = requestMqReruns({ attempts, repo, exec, scope: rerunScope,
      eligible: !infra && !logReason && !hasAggregateCandidates, dryRun,
      spend: () => { if (budget <= 2) throw new Error('retry evidence budget exhausted'); budget--; } });
    if (rerun.reason) logReason = rerun.reason;
    if (attempts.reason) infra = false;
    else if (!logReason && attempts.confirmed) infra = true;
    // These queries need only their first page, regardless of the workflow's history size.
    const mainEndpoint = `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push`;
    const readRunPage = (endpoint, limit, allowEmpty = false) => {
      if (budget-- <= 0) throw new Error('retry evidence budget exhausted');
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
      || (run.status === 'completed' && !Number.isFinite(timestamp(run.updated_at))))) return null;
    runs.sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || b.id - a.id);
    const before = runs.find(run => run.status === 'completed' && timestamp(run.created_at) < removedAt
      && timestamp(run.updated_at) < removedAt);
    const mainRed = ['failure', 'cancelled', 'timed_out'].includes(before?.conclusion);
    newest.sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at) || b.id - a.id);
    // R780: timed_out is red (decides, declines); cancelled and the rest stay skipped.
    const ignored = new Set([...infraConclusions].filter(c => c !== 'timed_out').concat('stale', 'action_required'));
    const deciding = newest.find(run => run.status === 'completed' && !ignored.has(run.conclusion));
    const stale = deciding && (!Number.isFinite(now) || now - timestamp(deciding.updated_at) > MQ_MAIN_GREEN_MAX_AGE_MS);
    const mergeState = readMqMergeState({ repo, pr, head, exec });
    if (attempts.confirmed && mergeState !== 'CLEAN')
      logReason = `PR is not CLEAN (${typeof mergeState === 'string' && /^[A-Z_]{1,32}$/.test(mergeState) ? mergeState : 'unknown'})`;
    // Evidence-backed flake: every failing test passed on the PR head's own CI AND on a main run created after
    // the ejection, the PR is CLEAN, and this is the head's first removal. One retry only (decideMqSameHead).
    let flaky = false;
    if (!infra && !logReason && !attempts.reason && removals.length === 1 && mergeState === 'CLEAN'
      && deciding?.conclusion === 'success' && !stale && timestamp(deciding.created_at) > removedAt
      && failed.length <= MQ_INFRA_MAX_JOBS && budget > 4) {
      try {
        const headChecks = readPages(`repos/${repo}/commits/${head}/check-runs?filter=all`, 'check_runs');
        const unitOk = headChecks.some(c => /^test-shard \(\d+\)$/.test(localJob(c.name)) && c.conclusion === 'success');
        const headGreen = unitOk && headChecks.every(c => c.status === 'completed' && passing.has(c.conclusion));
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
          const hits = (files[0].assertionResults ?? []).filter(a => [...(a?.ancestorTitles ?? []), a?.title].join(' > ') === name);
          return hits.length === 1 && hits[0].status === 'passed';
        };
        flaky = headGreen && failed.every(check => shardArtifact(check) !== undefined || derivedAggregate(check));
        if (flaky) {
          flaky = readQuarantineCover({ repo, commit: oid, failed, exec, flake: { passed: (file, name, check) => {
            const shard = shardArtifact(check);
            const headRuns = headChecks.filter(c => localJob(c.name) === localJob(check.name));
            return shard !== undefined && headRuns.length === 1 && headRuns[0].conclusion === 'success'
              && passedIn(readReport(runOf(headRuns[0]), shard, head), file, name)
              && passedIn(readReport(deciding.id, shard, deciding.head_sha), file, name);
          } } }) === true;
        }
      } catch { flaky = false; }
    }
    return { mainGreen: !!deciding && !stale && deciding.conclusion === 'success',
      mainRunId: deciding?.id ?? null,
      mainGreenReason: !deciding ? 'no completed run in latest 100 runs; operator must inspect main CI before retrying'
        : `newest completed run ${deciding.id} ${stale ? 'stale (older than 2h); wait for fresh main CI before retrying' : `concluded ${deciding.conclusion}`}`,
      failedNames,
      derivedNames,
      infra: infra ? (attempts.confirmed ? 'rerun-green' : 'infra') : flaky ? 'flaky-test' : !hasAggregateCandidates && !logReason && mainRed ? 'main-red' : null,
      logReason,
      mergeState };
  } catch { return null; }
}

/** Why a same-head failed_checks retry was declined, so a held PR is never silent. */
function mqRetryDeclineReason(evidence, holdLine) {
  if (/removals on this head|already spent/.test(holdLine ?? '')) return 'retry bound reached (this head already had its single retry)';
  if (!evidence) return 'retry evidence unreadable or incomplete';
  if (evidence.logReason) return evidence.logReason;
  if (evidence.infra === 'quarantined')
    return `PR is not CLEAN (${typeof evidence.mergeState === 'string' && /^[A-Z_]{1,32}$/.test(evidence.mergeState) ? evidence.mergeState : 'unknown'})`;
  if (evidence.mainGreen !== true) return `main CI is not green (${evidence.mainGreenReason ?? 'no completed run'})`;
  if (!['infra', 'main-red', 'flaky-test'].includes(evidence.infra))
    return `non-infrastructure failed check(s): ${(evidence.failedNames ?? []).join(', ') || 'unknown'}; main was not red at removal`;
  if (evidence.mergeState !== 'CLEAN') return `PR is not CLEAN (${typeof evidence.mergeState === 'string' && /^[A-Z_]{1,32}$/.test(evidence.mergeState) ? evidence.mergeState : 'unknown'})`;
  return 'retry conditions not met';
}

export function mqSameHeadGuard({ repo, pr, head, exec = execFileSyncThrottled, log = () => {}, allowAlreadyQueued = true, refresh, dryRun = false, now = Date.now(),
  // Hermetic under test: the live ops/quarantine branch is only consulted when a test injects a reader.
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
          ? readMqRetryEvidence({ repo, pr, head: currentHead, timeline, exec, rerunScope, dryRun, quarantine, now,
            retryPolicy: readDrainQueueSafety().value }) : undefined),
        mergeState: timelineHasConflict(timeline) ? readMqMergeState({ repo, pr, head: currentHead, exec }) : undefined });
  if (!decision.hold && decision.line) log(decision.line);
  if (decision.hold) {
    log(decision.line);
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
    env, platform, standard: { mqAggregateJobs: MQ_AGGREGATE_JOBS, mqInfraSignatures: MQ_INFRA_SIGNATURES, queueRebuildMax: 3, waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true, redTeamPendingBackoffSec: 300, redTeamPendingMaxMin: 45 },
    valid: { mqAggregateJobs: validMqAggregateJobs, mqInfraSignatures: validMqInfraSignatures, queueRebuildMax: v => Number.isSafeInteger(v) && v > 0, waitForRedTeamBeforeEnqueue: v => typeof v === 'boolean', dequeueOnSendBack: v => typeof v === 'boolean', redTeamPendingBackoffSec: positive, redTeamPendingMaxMin: positive },
    envValues: { mqAggregateJobs, mqInfraSignatures, queueRebuildMax: numberEnv('WE_DRAIN_QUEUE_REBUILD_MAX'), waitForRedTeamBeforeEnqueue: booleanEnv('WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE'), dequeueOnSendBack: booleanEnv('WE_DRAIN_DEQUEUE_ON_SEND_BACK'), redTeamPendingBackoffSec: numberEnv('WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC'), redTeamPendingMaxMin: numberEnv('WE_DRAIN_RED_TEAM_PENDING_MAX_MIN') },
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
