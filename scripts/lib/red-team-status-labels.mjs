/** Derived operator labels; head-bound scheduling and recorded dispositions remain authoritative. */
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { readFileSync } from 'node:fs';
import { redTeamCardOnly, redTeamOwedOnHead } from './review-red-team-policy.mjs';
import { RED_TEAM_SETTINGS_FILE, readRedTeamDisposition, readRedTeamProbes, redTeamHoldPendingOnly, redTeamClearGateCommentForHead } from './red-team-gate.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { isUnderTest } from './under-test.mjs';
import { runGhSync, WE_GH_READ_MEMO_DIR } from './gh-throttle.mjs';
import { ABANDONED_REVIEW_AFTER_MS, UNREAD_SETTLE_MARGIN_MS, carriedCheckMarkerPresent } from './drain-red-team-evidence.mjs';
import { redTeamCheckRunIsEvidence, readRedTeamPublicationHoldFact, readRedTeamRecoveryFact, resolveWeAppId } from './red-team-check-run.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';
import { standingRulingScope } from '../conveyor/standing-ruling-io.mjs';

import { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';
export { RED_TEAM_STATUS_LABELS, RED_TEAM_STATUS_LABEL_META } from './red-team-status-label-meta.mjs';

/** readRedTeamProbes swallows an unreadable settings file into the permissive default, which is never proof of the policy. */
function settingsReadable(path) {
  try { JSON.parse(readFileSync(path, 'utf8')); return true; } catch { return false; }
}

export function planRedTeamStatusLabels({ labels = [], comments, repo, pr, head, evidence = {}, env = {}, standingRuling = null, headFiles = null, headVerified = true, settingsPath = RED_TEAM_SETTINGS_FILE, checkClear = false, gateClear = false } = {}) {
  // The shared hold decision (PR #6622): the sealed stored evidence holds the head unless the posted comment shows the same
  // confirmed breaks. The PERSISTED status is read fresh (never the caller's snapshot, which may predate a publish), so one
  // pass never plans clear for a conflict it just recorded.
  const disposition = readRedTeamDisposition({ comments, pr, head, env, repo, standingRuling });
  // A hold that is only "publication pending" (stored evidence not sealed yet) is no break: pending, never clear.
  const pendingOnly = redTeamHoldPendingOnly(disposition);
  const broken = !pendingOnly && (disposition.sendBack.length || disposition.held.length);
  // A card-only CURRENT head with the skip on and no pass started owes no red team (the bypass writes no status, so a
  // `pending` set earlier would never clear): pending is a false hold. `headFiles` are the CURRENT head's live PR files (never
  // the stored status's read, which may be an older head's); unreadable or empty = unclassifiable = pending stays.
  const cardOnlyNotOwed = headVerified && !broken && !pendingOnly && !disposition.result && !evidence.inFlight && !evidence.recorded && !evidence.scheduled && !evidence.carryConflict
    && evidence.ok !== false && typeof evidence.skipCardOnly === 'boolean' && !(evidence.status?.status === 'finished' && evidence.status.result?.foldedVerdict) && readRedTeamProbes({ env, path: settingsPath }).value.skipCardOnly !== false
    && settingsReadable(settingsPath)
    && evidence.skipCardOnly
    && evidence.status?.status === 'finished' && evidence.status.result?.status === 'skipped' && evidence.status.result.policy === 'card-only'
    && Array.isArray(headFiles) && headFiles.length > 0 && isCardOnlyDiff(headFiles);
  if (cardOnlyNotOwed) {
    return { add: null, remove: labels.map(l => typeof l === 'string' ? l : l?.name).filter(n => n === 'red-team:pending' || n === 'red-team:clear') };
  }
  // The head's own red-team check run proved clear (readCheckClearFact: App-bound, head-bound, id-ordered, no open hold).
  // Only a strict `true` counts; a recorded break (above) and a publication-pending hold still win. Only pending is swapped.
  // Unreadable evidence, a running/scheduled pass, a carry conflict or a stored `changes` verdict keep their own (stricter) paths.
  if (checkClear === true && !broken && !pendingOnly && evidence.ok !== false && !evidence.inFlight && !evidence.scheduled
    && !evidence.carryConflict && !(evidence.status?.status === 'finished' && evidence.status.result?.foldedVerdict === 'changes')) {
    const have = labels.map(l => typeof l === 'string' ? l : l?.name);
    if (have.includes('red-team:pending') && !have.includes('red-team:blocked'))
      return { add: have.includes('red-team:clear') ? null : 'red-team:clear', remove: ['red-team:pending'] };
  }
  // Unknown run evidence holds, but after the break check: a recorded break still marks the PR blocked.
  if (evidence.ok === false && !broken) {
    const names = labels.map(label => typeof label === 'string' ? label : label?.name);
    if (evidence.reason === 'review-unfinished' && headVerified !== false && gateClear === true
      && names.includes('red-team:pending') && !names.includes('red-team:blocked')
      && !pendingOnly && !evidence.carryConflict && !evidence.inFlight && !evidence.scheduled
      && redTeamClearGateCommentForHead(comments, pr, head, (_gate, result) => gateSettleBoundsAllow(evidence, result, pr, head))) {
      return { add: names.includes('red-team:clear') ? null : 'red-team:clear',
        remove: names.filter(name => name === 'red-team:pending') };
    }
    return { add: names.includes('red-team:pending') || names.includes('red-team:blocked') ? null : 'red-team:pending',
      remove: names.filter(name => name === 'red-team:clear') };
  }
  const verdict = evidence.status?.status === 'finished' ? evidence.status.result?.foldedVerdict : null;
  const finished = verdict === 'changes' ? 'red-team:blocked' : verdict === 'accept' ? 'red-team:clear' : null;
  const desired = broken ? 'red-team:blocked'
    : pendingOnly ? 'red-team:pending'
    : disposition.result ? 'red-team:clear'
      : finished ? finished
      : redTeamOwedOnHead({ read: evidence.loopPayload?.findings?.read, evidence, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly }) ? 'red-team:pending' : null;
  const names = labels.map(l => typeof l === 'string' ? l : l?.name);
  // A head PROVEN card-only (readable net files, skip policy on) with no pass in flight, scheduled or recorded bypasses the
  // red-team pass and never gets an outcome, so its stale pending label would stay forever (#6733). Only pending is dropped:
  // blocked stays, and unreadable evidence or a missing/unknown read never counts as proof.
  // The skip policy must be EXPLICIT: the recorded status says so, or the probe resolves it from a real source (platform/
  // tool/env), or the standard default stands over a settings file that actually read. readRedTeamProbes swallows a read
  // failure into the permissive default, which is never proof (audit probe).
  const probes = readRedTeamProbes({ env, path: settingsPath });
  let fileReadable = false;
  try { JSON.parse(readFileSync(settingsPath, 'utf8')); fileReadable = true; } catch { /* unreadable policy */ }
  const skipCardOnly = typeof evidence.skipCardOnly === 'boolean' ? evidence.skipCardOnly
    : probes.value.skipCardOnly === true && (probes.sources?.skipCardOnly !== 'standard' || fileReadable);
  const cardOnlyBypass = desired === null && headVerified
    // Live head files, when read, must also prove card-only (the stored read alone never overrides them).
    && (headFiles == null || (headFiles.length > 0 && isCardOnlyDiff(headFiles))) && evidence.ok !== false && skipCardOnly === true
    && !evidence.inFlight && !evidence.scheduled && !evidence.recorded && !evidence.carryConflict
    // The read must be bound to THIS head: the historical fallback returns an older head's card-only read.
    && String(evidence.loopPayload?.findings?.read?.netBasis?.rev ?? '').toLowerCase() === String(head).toLowerCase()
    // Rename evidence must be present (an array): a missing list could hide a code-to-backlog rename.
    && Array.isArray(evidence.loopPayload?.findings?.read?.netRenameSources)
    && redTeamCardOnly(evidence.loopPayload?.findings?.read);
  return { add: desired && !names.includes(desired) ? desired : null,
    // With nothing owed and no result (`desired` null) a hold label (pending or blocked) must not be dropped on
    // unreadable or missing local evidence: only a recorded outcome replaces it.
    remove: names.filter(l => RED_TEAM_STATUS_LABELS.includes(l) && l !== desired
      && !(desired === null && (l === 'red-team:blocked' || (l === 'red-team:pending' && !cardOnlyBypass)))) };
}

/** Bound to the review result time, with the same quiet/complete bounds as result-comment settlement. */
function gateSettleBoundsAllow(evidence, comment, pr, head) {
  const bounds = evidence.settleBounds ?? {};
  const at = Date.parse(commentCreatedAt(comment));
  if (!Number.isFinite(at) || bounds.unfinishedUndecided !== true
    || !(bounds.evaluatedAt - bounds.unfinishedActiveAt >= ABANDONED_REVIEW_AFTER_MS)
    || !(at > bounds.unfinishedStartedAt)
    || ('unreadBoundaryAt' in bounds && !(at > bounds.unreadBoundaryAt + UNREAD_SETTLE_MARGIN_MS))) return false;
  try {
    const complete = bounds.completeHeadRead?.({ pr, head, at });
    return complete?.complete === true && complete.blocked === false;
  } catch { return false; }
}

function readPublicationClearFact({ repo, pr, head, env, gh }) {
  try {
    if (typeof gh !== 'function' || carriedCheckMarkerPresent({ repo, pr, head, env: { ...process.env, ...env } })) return false;
    return readRedTeamPublicationHoldFact({ repo, pr, headSha: head, gh, strictSummary: true }).ok === true;
  } catch { return false; }
}

/** A gh runner that never serves the read memo: a label swap is decided on fresh data only. */
export function createFreshGh(run = runGhSync, baseEnv = process.env) {
  return (args, opts = {}) => {
    const env = { ...(opts.throttle?.env ?? baseEnv) };
    delete env[WE_GH_READ_MEMO_DIR];
    const execEnv = opts.env ? { ...opts.env } : undefined;
    if (execEnv) delete execEnv[WE_GH_READ_MEMO_DIR];
    return run(args, { ...opts, ...(execEnv ? { env: execEnv } : {}), throttle: { ...opts.throttle, env } });
  };
}

/** The fresh (memo-free) runner a daemon caller passes as `gh` to enable the settle; none under a test run. */
export const settleGhFor = (env = process.env) => (isUnderTest() || isUnderTest(env) ? undefined : createFreshGh(runGhSync, env));

/** Is the head's red-team check run a trusted, completed success with no open publication hold? Every unreadable or
 * missing input is false (unknown means pending). Reuses the merge gate's own evaluators. */
export function readCheckClearFact({ repo, pr, head, env = process.env, gh = createFreshGh(runGhSync, env) } = {}) {
  try {
    const app = resolveWeAppId({ env });
    if (app.ok !== true) return false;
    const options = { repo, pr, headSha: head, appId: app.appId, gh };
    // An unconfirmed carried-check publish (its outbox marker, which may own a live hold) is no proof either.
    // A partial env inherits the process env, so the marker directory is never a different one (a missed hold).
    return readPublicationClearFact({ repo, pr, head, env, gh }) && readRedTeamRecoveryFact(options).ok === true;
  } catch { return false; }
}

/** Uses the existing label provider/writer, including the known-label metadata provisioning path. */
export function syncRedTeamStatusLabels({ repo, pr, head, evidence = {}, env = process.env,
  provider: injectedProvider, recheckProvider, log = () => {}, live, comments, dryRun = false, standingRuling, readGrantScope = standingRulingScope,
  // No injected runner means unknown (pending stays): the settle never builds a hidden live gh of its own.
  gh, readCheckClear = args => (typeof gh === 'function' ? readCheckClearFact({ ...args, env, gh }) : false) } = {}) {
  const provider = injectedProvider ?? createGhProvider();
  // Head rechecks decide a label swap, so they read fresh (no gh read memo), like the check reads.
  const freshGh = createFreshGh(runGhSync, env);
  // Production callers inject their own provider, so the rechecks never trust it: they always read fresh. Only a test run
  // (no live gh) reuses the injected fake.
  const recheck = recheckProvider ?? (injectedProvider && (isUnderTest() || isUnderTest(env)) ? injectedProvider
    : createGhProvider({ exec: (args, options) => freshGh(args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...options }) }));
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { add: null, remove: [] };
  const state = live ?? provider.readPrState(repo, pr);
  if (state.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
  const thread = comments ?? provider.readComments(repo, pr);
  // The verified standing-ruling scope (PR #5758): given by the caller, else read fresh; unreadable = no automatic credit.
  let scope = standingRuling ?? null;
  if (standingRuling === undefined) {
    try { scope = readGrantScope({ repo, pr: { number: Number(pr), headRefOid: head, comments: thread } }) ?? null; } catch { scope = null; }
  }
  // Only a held pending label needs the current head's files: read them lazily, and unreadable stays unclassified.
  let headFiles = null;
  // False when the head re-check could not run: no card-only bypass may drop pending then (fail closed); other transitions plan as usual.
  let headVerified = true;
  if ((state.labels ?? []).some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:pending')) {
    try {
      headFiles = provider.readPrFiles?.(repo, pr, { exact: true }) ?? null;
      // The files API lists at most 3000 files: a list at the cap may be truncated, so it classifies nothing. The head is
      // re-read AFTER the files, and a head that moved meanwhile makes the files someone else's: unclassified.
      if (!Array.isArray(headFiles) || headFiles.length >= 3000) { headFiles = null; headVerified = false; }
      if (provider.readPrState(repo, pr)?.headRefOid !== head) return { add: null, remove: [], skipped: 'head-moved' };
    } catch { headFiles = null; headVerified = false; }
  }
  // The head's check run settles a held pending label. Read only when pending is live; a throw or non-true is no proof.
  let checkClear = false;
  const liveNames = (state.labels ?? []).map(l => typeof l === 'string' ? l : l?.name);
  // The check run is evidence only when the configured gate source says so (the `drain-scan` rollback disables it).
  if (evidence.ok !== false && liveNames.includes('red-team:pending') && !liveNames.includes('red-team:blocked') && redTeamCheckRunIsEvidence({ env })) {
    try { checkClear = readCheckClear({ repo, pr, head }) === true; } catch { checkClear = false; }
  }
  const gateSettle = evidence.ok === false && evidence.reason === 'review-unfinished';
  const readClear = gateSettle ? args => readPublicationClearFact({ ...args, env, gh }) : readCheckClear;
  if (gateSettle && headVerified !== false && liveNames.includes('red-team:pending') && !liveNames.includes('red-team:blocked'))
    checkClear = readClear({ repo, pr, head });
  const planWith = (threadNow, clear) => planRedTeamStatusLabels({ ...state, repo, pr, head, evidence, env, comments: threadNow, standingRuling: scope, headFiles, headVerified, checkClear: gateSettle ? false : clear, gateClear: gateSettle && clear });
  let plan = planWith(thread, checkClear);
  // A check- or gate-derived settle only moves pending to clear. Re-verify the head, clearance fact and thread
  // right before writing; a block always wins: a recorded break found on that re-read is written as blocked, never skipped.
  if (checkClear && plan.add !== 'red-team:blocked' && plan.add !== 'red-team:pending' && (plan.add || plan.remove.length) && !dryRun) {
    let again = null;
    try { again = recheck.readPrState(repo, pr)?.headRefOid; } catch { again = null; }
    if (again !== head) return { add: null, remove: [], skipped: 'head-moved' };
    let still = false;
    try { still = readClear({ repo, pr, head }) === true; } catch { still = false; }
    let threadNow = null;
    try { threadNow = recheck.readComments(repo, pr); } catch { threadNow = null; }
    if (!Array.isArray(threadNow)) return { add: null, remove: [], skipped: 'thread-unreadable' };
    const next = planWith(threadNow, still);
    if (next.add === 'red-team:blocked') plan = next;
    else if (!still) return { add: null, remove: [], skipped: 'check-changed' };
    else if (gateSettle && (next.add === 'red-team:pending' || !next.remove.includes('red-team:pending')))
      return { add: null, remove: [], skipped: 'gate-changed' };
    else plan = next;
    // Fresh head and labels before the final clearance read.
    let last = null, lastLabels = null;
    try { const fresh = recheck.readPrState(repo, pr); last = fresh?.headRefOid; lastLabels = fresh?.labels; } catch { last = null; }
    if (last !== head) return { add: null, remove: [], skipped: 'head-moved' };
    // A blocked label on the fresh state vetoes any settle to clear (a block always wins); unreadable labels refuse too.
    if (!Array.isArray(lastLabels)) return { add: null, remove: [], skipped: 'labels-unreadable' };
    if (plan.add !== 'red-team:blocked' && lastLabels.some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:blocked'))
      return { add: null, remove: [], skipped: 'blocked-label' };
    // Compare-and-swap: clear is written only while pending is still on the fresh labels and the check is still clear for this head.
    if (plan.add === 'red-team:clear' || (plan.add === null && plan.remove.includes('red-team:pending'))) {
      if (!lastLabels.some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:pending')) return { add: null, remove: [], skipped: 'pending-gone' };
      let lastClear = false;
      try { lastClear = readClear({ repo, pr, head }) === true; } catch { lastClear = false; }
      if (!lastClear) return { add: null, remove: [], skipped: 'check-changed' };
    }
  }
  if (!dryRun && (plan.add || plan.remove.length)) {
    if (plan.add) provider.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
    // Publication reads and label provisioning can race a push: pin the head again immediately before writing.
    if (checkClear) {
      let finalHead = null;
      try { finalHead = recheck.readPrState(repo, pr)?.headRefOid; } catch { /* unreadable refuses the write */ }
      if (finalHead !== head) return { add: null, remove: [], skipped: 'head-moved' };
    }
    provider.setLabels(repo, pr, { add: plan.add, remove: plan.remove });
  }
  return plan;
}
