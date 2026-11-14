/** Recover an owed red-team result on an already-reviewed head through the existing review job. */
import { execFileSync } from 'node:child_process';
import { proveCardOnlyHeadMove } from './card-only-head-move.mjs';
import { readFileSync, statSync } from 'node:fs';
import { listRunIds, readRun, sharedRunsDir } from '../operations/run-store.mjs';
import { runBacklogOnlyPrep, readBacklogOnlyNetFiles } from './red-team-backlog-only.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { isUnderTest } from './under-test.mjs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { pidIdentity, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDrainRedTeamEvidence, readRedTeamStatus, readRecoveryWitness, redTeamStatusDir, withRedTeamStatusClaim } from './drain-red-team-evidence.mjs';
import { redTeamForHead, redTeamMarker, parseRedTeamComment } from './red-team-gate.mjs';
import { redTeamOwedFor, redTeamCardOnly } from './review-red-team-policy.mjs';
import { foreignStaleOwnerDead, localPidLive } from './red-team-foreign-host-stale.mjs';
import { readRedTeamCarry } from './red-team-carry-machine.mjs';
import { isRealHead, safeErrorText, settleRedTeamSkip } from './red-team-skip-outcome.mjs';
import { PreStartDispatchRefusalError } from './main-staleness.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { createPolicyClearPublisher, readRedTeamGateSource } from './red-team-check-run.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { failedRedTeamRetry, redTeamStatusWithoutRun, completedRedTeamSeat } from './red-team-run-result.mjs';

import { redTeamRequired, VERDICTS } from './jury-core.mjs';
import { isLaterVerdictBody, latestAcceptRecord, laterReviewHold } from './accept-carry-forward.mjs';
import { restampRecord, strandedNumberingRecords } from './numbering-carry.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { RED_TEAM_STATUS_LABELS } from './red-team-status-label-meta.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';
import { readReviewRunEvidence, refusedReferralsAreRuled, findResumableParkedRun } from '../conveyor/review-referral-hold.mjs';

// The shared reader returns reviewRunEvidence projections, not raw run records.
const defaultReadReviewRuns = () => isUnderTest() ? [] : readReviewRunEvidence();

export const staleRunDeadlineMs = (env = process.env) => /^\d+$/.test(env.WE_RED_TEAM_STALE_RUN_MS ?? '')
  && Number.isSafeInteger(Number(env.WE_RED_TEAM_STALE_RUN_MS)) ? Number(env.WE_RED_TEAM_STALE_RUN_MS) : 7_200_000;

const pendingAbandonment = w => w.markers.redispatch?.priorWriter === w.rawWriter.sha256
  && w.markers.redispatch?.evidence === w.evidenceSha256
  && typeof w.markers.redispatch?.abandonedAt === 'string';

/** Pure decision on a raw witness. Probes and time are supplied by the caller. */
export function planRedTeamRecovery(w, { now, probe, deadlineMs, env = process.env, setting = resolveReviewRedTeamOnSkip({ env }).value } = {}) {
  if (w?.ok === false) return { mode: 'skip', why: w.reason };
  const raw = w.rawWriter.parsed;
  let executionPrior = raw;
  const reject = why => ({ rawWriter: w.rawWriter, executionPrior, mode: 'skip', why });
  const payload = w.newest;
  if (!redTeamOwedFor(payload) || payload?.carriedFrom || payload?.findings?.read?.netBasis?.rev !== w.head) return reject('newest review does not owe a pass');
  const active = ['queued', 'running'].includes(raw?.status);
  let dead = !active;
  let deathReason = 'age';
  if (active && w.unfinishedReviewException === true) {
    // Bypassing an unfinished-review hold requires observed owner death. Unknown
    // probes never fall back to age, and foreign records need the full stale-run deadline.
    const local = raw.host === probe.host && raw.pidNamespace === probe.namespace;
    const foreign = raw.host && raw.host !== probe.host
      && (raw.pidNamespace == null || raw.pidNamespace === probe.namespace);
    if (!local && !(foreign && Number.isFinite(w.statusAt) && w.statusAt > 0
      && Number.isFinite(now) && now - w.statusAt > (deadlineMs ?? staleRunDeadlineMs(env)))) {
      return reject('owner live or age unknown');
    }
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) return reject('owner live or age unknown');
    try {
      const alive = probe.isAlive(raw.pid);
      if (alive === false) {
        dead = true;
        deathReason = probe.deathReason?.(raw.pid) ?? 'gone';
      }
      else if (alive === true) {
        const start = raw.pidStart ? probe.readPidStart?.(raw.pid) : null;
        if (!raw.pidStart || start == null || start === raw.pidStart) return reject('owner live');
        dead = typeof raw.pidStart === 'string' && typeof start === 'string' && start.length > 0 && start !== raw.pidStart;
        if (dead) deathReason = 'start-mismatch';
      }
    } catch { dead = false; }
    if (!dead) return reject('owner live or age unknown');
  } else if (active) {
    dead = false;
    if (raw.host === probe.host && raw.pidNamespace === probe.namespace && Number.isInteger(raw.pid) && raw.pid > 0) {
      try {
        const alive = probe.isAlive(raw.pid);
        if (alive === false) {
          dead = true;
          deathReason = probe.deathReason?.(raw.pid) ?? 'gone';
        }
        else if (alive === true) {
          // An existence probe already proved a live pid. Only a verified birth-time
          // mismatch proves reuse; an unavailable ps probe must never fall back to age.
          let start;
          try { start = raw.pidStart ? probe.readPidStart?.(raw.pid) : null; }
          catch { return reject('owner live; start unreadable'); }
          if (!raw.pidStart || start == null || start === raw.pidStart) return reject('owner live');
          dead = true;
          deathReason = 'start-mismatch';
        }
      } catch { /* Unprobeable owners use the explicit age deadline. */ }
    }
    if (!dead) {
      // A host rename after a crash leaves a record no local pid probe can settle: apply the same stale-record rule the
      // evidence reader uses, so recovery and the reader never disagree. An unprobeable owner stays held.
      try {
        // Our own abandonment rewrites the file and resets the mtime this rule reads, so a foreign-host abandonment whose
        // marker still binds this exact writer AND evidence stays proven dead (it was proven under the claim). It is still
        // probed: a pid that is alive here with its recorded birth time keeps the record held, and a throwing probe holds it.
        const m = w.markers.redispatch;
        const boundAbandonment = Boolean(raw.staleAbandoned && raw.host && raw.host !== probe.host
          && (raw.pidNamespace == null || raw.pidNamespace === probe.namespace) && m?.writer === w.rawWriter.sha256 && m?.evidence === w.evidenceSha256);
        dead = (boundAbandonment && !localPidLive(raw, { isAlive: probe.isAlive, readPidStart: probe.readPidStart ?? (() => null) }))
          || foreignStaleOwnerDead(raw, { host: probe.host, namespace: probe.namespace, statusAt: w.statusAt, now, env, isAlive: probe.isAlive, readPidStart: probe.readPidStart ?? (() => null) });
      } catch { dead = false; }
    }
    if (!dead) {
      const stamp = raw.pidStart;
      const at = Date.parse(/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(stamp ?? '') ? `${stamp} UTC` : stamp);
      dead = Number.isFinite(at) && now - at > deadlineMs;
    }
    if (!dead) return reject('owner live or age unknown');
  }
  const marker = w.markers.redispatch;
  if (marker != null && (typeof marker !== 'object' || Array.isArray(marker))) return reject('stale re-dispatch marker malformed; inspect stored evidence');
  if (marker && !raw) return reject('stale marker without writer; inspect stored evidence');
  if (raw?.staleAbandoned && (!marker || marker.writer !== w.rawWriter.sha256 || marker.evidence !== w.evidenceSha256)) return reject('abandonment witness changed');
  let refill = false;
  let history;
  // Legacy markers (no abandonments array) stay admissible unless a refill is being decided.
  if (marker && (marker.abandonments !== undefined || active && !raw?.staleAbandoned && !pendingAbandonment(w))) {
    history = marker.abandonments === undefined ? [marker.abandonedAt] : marker.abandonments;
    const validTime = stamp => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))
      && new Date(Date.parse(stamp)).toISOString() === stamp;
    if (!Number.isFinite(now) || !['writer', 'evidence', 'priorWriter'].every(key =>
      typeof marker[key] === 'string' && /^[a-f0-9]{64}$/.test(marker[key]))
      || !validTime(marker.abandonedAt) || !Array.isArray(history) || !history.length
      || history.at(-1) !== marker.abandonedAt
      || history.some((stamp, index) => !validTime(stamp) || Date.parse(stamp) > now
        || index > 0 && Date.parse(stamp) < Date.parse(history[index - 1]))
      || !Number.isSafeInteger(setting.retryCooldownMin) || setting.retryCooldownMin < 0
      || !Number.isSafeInteger(setting.staleRedispatchDailyCap ?? 3) || (setting.staleRedispatchDailyCap ?? 3) < 1) {
      return reject('stale re-dispatch evidence unreadable; inspect stored evidence');
    }
  }
  if (marker && active && !raw?.staleAbandoned && !pendingAbandonment(w)) {
    const hasFindings = value => value != null && (typeof value !== 'object' || Object.keys(value).length > 0);
    if (raw.result != null || w.seats.some(completedRedTeamSeat)
      || hasFindings(raw.findings) || w.seats.some(seat => hasFindings(seat.findings))) {
      return reject('stale re-dispatch already spent');
    }
    if (history.filter(stamp => now - Date.parse(stamp) < 86_400_000).length >= (setting.staleRedispatchDailyCap ?? 3)) {
      return { ...reject('stale re-dispatch daily cap reached'), escalate: true,
        escalationContext: 'stale red-team recovery exhausted its daily abandonment cap; inspect the writer before retrying' };
    }
    if (now - Date.parse(marker.abandonedAt) < setting.retryCooldownMin * 60_000) return reject('stale re-dispatch cooldown active');
    refill = true;
  }
  const completed = w.seats.some(completedRedTeamSeat);
  const resumable = ['ran', 'resumed'].includes(normalizeRedTeamResult(raw?.result).priorResult);
  const failedSeatCount = w.seats.filter(r => !completedRedTeamSeat(r)).length;
  if (active && dead) {
    // A running writer can crash after appending its failed seat, before finishing.
    // Queued state cannot establish that an existing seat belongs to this writer.
    const interruptedFailure = raw.status === 'running' && failedSeatCount === 1 && raw.result == null
      && (raw.retryCount === undefined || raw.retryCount === 0);
    executionPrior = completed || resumable ? { ...raw, status: 'finished', result: resumable ? raw.result : 'ran' }
      : interruptedFailure ? { ...raw, status: 'finished', result: 'failed' } : null;
  }
  const retry = failedRedTeamRetry(executionPrior, { failedSeatCount, completedRecorded: completed });
  const priorResult = normalizeRedTeamResult(executionPrior?.result).priorResult;
  const mode = completed ? 'resume' : 'fresh';
  if (mode === 'resume' && (executionPrior?.status !== 'finished' || !['ran', 'resumed'].includes(priorResult)
    || normalizeRedTeamResult(executionPrior.result).priorComment === 'posted')) return reject('prior result not resumable');
  if (mode === 'fresh' && (w.markers.retry && !retry || w.seats.length && !retry
    || executionPrior && !retry && !redTeamStatusWithoutRun(executionPrior) && !redTeamSkipNeedsSettlement(executionPrior))) return reject('prior pass cannot restart');
  if (mode === 'fresh' && !retry) executionPrior = null;
  return { rawWriter: w.rawWriter, executionPrior, mode, payload, retry, abandon: active && !raw.staleAbandoned,
    ...(active && dead ? { deathReason } : {}), ...(refill ? { refill: true } : {}) };
}

/** Three-valued existence for recovery: ESRCH proves absence, success or EPERM proves presence. Any other
 *  kill(0) outcome is unknown and throws, so every caller holds the owner (localPidLive's contract). */
export function pidExistence(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('pid existence unknown: invalid pid');
  try { kill(pid, 0); return true; } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw Error(`pid existence unknown: ${error?.code ?? 'unreadable'}`);
  }
}

export const recoveryProbe = ({ alive = pidExistence, identity = pidIdentity } = {}) => {
  let lastPid, lastReason;
  return { host: hostname(), namespace: pidNamespace(), readPidStart: pidStartTime,
    isAlive: pid => {
      lastPid = pid;
      lastReason = null;
      const exists = alive(pid);
      if (exists === false) {
        lastReason = 'gone';
        return false;
      }
      // Only positive evidence of absence is death: an unknown existence answer holds the owner.
      if (exists !== true) throw Error('pid existence unknown');
      const result = identity(pid);
      lastReason = result?.reason ?? 'unreadable';
      // Unknown ps evidence retains the process that the existence probe found.
      return result?.alive !== false;
    },
    deathReason: pid => pid === lastPid ? lastReason : null,
  };
};

/** Spend one abandonment before spawning. The marker binds raw bytes, rows and newest review, never a plan. */
export function abandonStaleRedTeamRun(key, { readWitness = () => readRecoveryWitness(key), now = Date.now,
  probe = recoveryProbe(), deadlineMs = staleRunDeadlineMs(key.env), writeJson = writeJsonAtomic,
  setting = resolveReviewRedTeamOnSkip({ env: key.env }).value } = {}) {
  const path = join(redTeamStatusDir(key.env), `${encodeURIComponent(key.repo)}-${Number(key.pr)}-${key.head}.json`);
  try {
    return withRedTeamStatusClaim(path, () => {
      const at = now();
      const w = readWitness(), p = planRedTeamRecovery(w, { now: at, probe, deadlineMs, env: key.env, setting });
      if (p.mode !== 'skip' && w.rawWriter.parsed?.staleAbandoned) return { ok: true };
      if (!p.abandon || p.mode === 'skip' || (w.markers.redispatch && !pendingAbandonment(w) && !p.refill)) return { ok: false };
      const marker = `${path}.stale-redispatch-1`;
      const abandonedAt = p.refill ? new Date(at).toISOString() : w.markers.redispatch?.abandonedAt ?? new Date(at).toISOString();
      const next = { ...w.rawWriter.parsed, staleAbandoned: { at: abandonedAt } };
      // Bind the exact writeJsonAtomic rendering before publishing either file. A crash
      // leaves either the old writer plus this complete intent, or the bound new writer.
      const writer = createHash('sha256').update(`${JSON.stringify(next, null, 2)}\n`).digest('hex');
      if (w.markers.redispatch && !p.refill && w.markers.redispatch.writer !== writer) return { ok: false };
      if (!w.markers.redispatch || p.refill) writeJson(marker, { writer, evidence: w.evidenceSha256,
        priorWriter: w.rawWriter.sha256, abandonedAt, abandonments: [
          ...(p.refill ? w.markers.redispatch.abandonments ?? [w.markers.redispatch.abandonedAt] : []), abandonedAt] }, { mode: 0o600 });
      writeJson(path, next);
      return { ok: true };
    }, { readPidStart: probe.readPidStart });
  } catch { return { ok: false }; }
}

// review-labels.mjs exports names only. Fail closed for every review hold namespace,
// including future merge holds, rather than maintaining a partial list here.
function conflictsWithPolicyClear(label, { settlesPending = false, settlesReviewPending = false } = {}) {
  const name = typeof label === 'string' ? label : label?.name;
  // A finished not-owed result settles the stale pending status; blocked and review holds still refuse (D-R338).
  if (settlesPending && name === 'red-team:pending') return false;
  // A parked run retains review:pending itself, so once its referrals are ruled it is the resume's own label, not a hold.
  if (settlesReviewPending && name === 'review:pending') return false;
  return typeof name === 'string' && (
    (name.startsWith('review:') && name !== 'review:accepted')
    || name.startsWith('review-status:')
    || (RED_TEAM_STATUS_LABELS.includes(name) && name !== 'red-team:clear')
  );
}

/** The daemon's own referral pause notice (`decideReferralHold`'s need-a-ruling shape, automation author only). Only a
 * caller that has just proven every referral ruled may treat it as settled. A persistence-failure notice (detail
 * paragraph, or the retries-spent lead) is settled only when the caller also proves persistence recovered
 * (`persistRecovered`: the newest run is no longer persistenceFailed); the ledger variant and any look-alike from
 * another author are different holds and stay. PURE. */
const RULING_PAUSE_LEAD = /^review paused: \d+ referrals need a ruling; it resumes on a new push, a ruling, or a send-back(?:\n|$)/;
const PERSIST_EXHAUSTED_LEAD = /^review paused: \d+ referrals could not be persisted and the automatic retries are spent; it resumes on a new push or an operator reply(?:\n|$)/;
const PERSIST_DETAIL = /\n\nReferral persistence (?:failed; the next bounded retry is at [0-9TZ:.-]+\.|retries are exhausted; waiting for a new event\.)\n\n<!-- review-referral-hold: [0-9a-f]+ -->$/;

function isSettledReferralPauseNotice(comment, { persistRecovered = false } = {}) {
  // Same trust set the producer's own dedupe uses (notifyReferralHoldNotice): the daemon sometimes posts under the operator's credential.
  if (!isTrustedMarkerAuthor(comment) || typeof comment?.body !== 'string') return false;
  const body = comment.body.trim();
  // The real notice is `${why}${findings}${detail}\n\n<!-- review-referral-hold: <episode> -->` (notifyReferralHoldNotice):
  // the leading line, an optional "Waiting on your ruling" findings block, then the episode marker. A persistence-failure
  // detail means a persist hold, not a pause for rulings, so it never counts as settled. That detail is the standalone
  // paragraph between the findings block and the marker, so it is matched only there, anchored to the marker:
  // a finding summary (interpolated into the findings block) that merely quotes the phrase is not that detail.
  if (!/\n<!-- review-referral-hold: [0-9a-f]+ -->$/.test(body)) return false;
  // The caller proves persistence is no longer failing (the newest run has none), so a persistence notice is a stale
  // episode from before the retry succeeded: the producer never removes it, and a ruling cannot clear it.
  if (RULING_PAUSE_LEAD.test(body)) return persistRecovered || !PERSIST_DETAIL.test(body);
  return persistRecovered && PERSIST_EXHAUSTED_LEAD.test(body);
}

/** A reviewed-sha marker alone never proves acceptance or supersedes a newer hold. */
function provenAcceptance({ comments, reviews, labels, head }) {
  if (!isRealHead(head) || !Array.isArray(comments) || comments.some(c => typeof c?.body !== 'string')
    || !Array.isArray(reviews) || laterReviewHold(reviews) || !Array.isArray(labels)) return null;
  const names = labels.map(label => typeof label === 'string' ? label : label?.name);
  if (names.some(name => typeof name !== 'string' || !name.trim()) || !names.includes('review:accepted')) return null;
  const acceptance = latestAcceptRecord(comments, reviews);
  if (acceptance?.sha !== head || acceptance.laterVerdict || acceptance.laterBodyDerivedHold) return null;
  const body = comments[acceptance.index]?.body;
  if (!/^\s*✅/.test(body) || isLaterVerdictBody(body)) return null;
  const acceptedAt = Date.parse(acceptance.at);
  if (comments.some((comment, index) => isLaterVerdictBody(comment.body)
    && (index > acceptance.index || Date.parse(comment.createdAt ?? comment.created_at) > acceptedAt))) return null;
  return acceptance;
}

/** Live holds supersede both carried and stored policy-clears. PURE.
 * Without an acceptance record nothing is "later", so any explicit hold comment stands (any author: fail closed).
 */
function publishableClearGuard({ labels, acceptance, comments, reviews, settlesPending = false, settlesReviewPending = false }) {
  if (acceptance?.laterVerdict || acceptance?.laterBodyDerivedHold) {
    return 'later verdict or hold supersedes acceptance';
  }
  if (!acceptance && (!Array.isArray(comments) || comments.some(c => isLaterVerdictBody(c?.body)))) {
    return 'explicit review hold comment prevents full review; inspect the PR thread';
  }
  if (acceptance?.reviewsUnreadable) return 'PR reviews unreadable; inspect formal reviews before policy-clear';
  if (!Array.isArray(labels)) return 'PR labels unreadable';
  if (labels.some(label => conflictsWithPolicyClear(label, { settlesPending, settlesReviewPending }))) {
    return 'conflicting label prevents policy-clear';
  }
  // A trusted marker alone is not acceptance provenance. Use numbering's whole-thread
  // validation, including stale forks, clearance changes and holds hidden by re-dating.
  if (strandedNumberingRecords(comments, reviews).length) {
    return 'invalid acceptance re-stamp; withdraw stranded records before recovery';
  }
  return null;
}

/** Normalize both persisted production result shapes at the recovery boundary. */
export function normalizeRedTeamResult(result) {
  return {
    priorResult: typeof result === 'string' ? result : result?.status,
    priorComment: typeof result === 'object' ? (result?.comment?.status ?? result?.comment) : undefined,
  };
}

/** Historical card-only skips need a result comment, not a resumed model pass. PURE. */
export function redTeamSkipNeedsSettlement(status) {
  const read = status?.loopPayload?.findings?.read;
  const result = status?.result;
  if (result && typeof result === 'object' && result.policy !== 'card-only') return false;
  // Legacy plain-string records carry no policy. With the writer's skipCardOnly=true,
  // a non-empty card-only read and matching pinned head, the producer's card-only
  // branch runs before every other applicable skip reason, so this combination
  // can only be a card-only skip. Never infer that provenance for object results.
  return typeof read?.diffText === 'string' && read.diffText.trim().length > 0
    && isRealHead(status?.head) && read.netBasis?.rev === status.head
    && status?.status === 'finished' && normalizeRedTeamResult(status.result).priorResult === 'skipped'
    && status.skipCardOnly === true && redTeamCardOnly(status.loopPayload?.findings?.read);
}

/** A finished policy skip with no seat can be re-settled after a proven card-only move. PURE. */
export function cardOnlyHeadMoveCandidate(evidence, head) {
  const read = evidence?.loopPayload?.findings?.read;
  return !evidence?.carryConflict && isRealHead(read?.netBasis?.rev) && read.netBasis.rev !== head
    && redTeamCardOnly(read) && redTeamSkipNeedsSettlement(evidence?.status)
    && evidence.status.head === read.netBasis.rev
    && evidence.recorded === false && evidence.seatRecorded === false
    && !evidence.inFlight && !evidence.queued;
}

/** A failed policy comment remains retryable after the carried read has been pinned to this head. */
export function cardOnlySkipSettlementCandidate(evidence, head) {
  const read = evidence?.loopPayload?.findings?.read;
  return !evidence?.carryConflict && isRealHead(head) && read?.netBasis?.rev === head
    && redTeamCardOnly(read) && redTeamSkipNeedsSettlement(evidence?.status)
    && evidence.status.head === head
    && evidence.recorded === false && evidence.seatRecorded === false
    && !evidence.inFlight && !evidence.queued;
}

export function resolveReviewRedTeamOnSkip({ env = process.env, log, readFile = readFileSync,
  toolPath = join(dirname(fileURLToPath(import.meta.url)), '../settings/review-red-team-on-skip.json') } = {}) {
  let tool;
  try { const data = JSON.parse(readFile(toolPath, 'utf8')); tool = { enabled: data.enabled, retryCooldownMin: data.retryCooldownMin, staleRedispatchDailyCap: data.staleRedispatchDailyCap }; } catch { /* lower layers */ }
  const raw = env.WE_REVIEW_RED_TEAM_ON_SKIP;
  const cooldown = env.WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN;
  const dailyCap = env.WE_REVIEW_RED_TEAM_ON_SKIP_STALE_REDISPATCH_DAILY_CAP;
  return cascadePolicy('reviewRedTeamOnSkip', tool, {
    env, log, standard: { enabled: true, retryCooldownMin: 30, staleRedispatchDailyCap: 3 },
    envValues: { enabled: raw === '0' ? false : raw === '1' ? true : raw || undefined,
      retryCooldownMin: typeof cooldown === 'string' && /^\d+$/.test(cooldown) ? Number(cooldown) : cooldown || undefined,
      staleRedispatchDailyCap: typeof dailyCap === 'string' && /^\d+$/.test(dailyCap) ? Number(dailyCap) : dailyCap || undefined },
    valid: { enabled: v => typeof v === 'boolean', retryCooldownMin: v => Number.isSafeInteger(v) && v >= 0,
      staleRedispatchDailyCap: v => Number.isSafeInteger(v) && v >= 1 },
  });
}

// Complete scans deliberately do not use a newest-run shortcut: an unread row can
// hide a review or an unfinished attempt. At the cap, retain the hold for inspection.
const runsDirectory = env => env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env);
const strictListRuns = dir => { statSync(dir); return listRunIds(dir); };
function* reviewRuns({ runsDir, list, read, stat }) {
  const ids = list(runsDir).filter(id => id.startsWith('review-pr-'));
  if (ids.length > 400) throw Error('run scan capped; inspect stored evidence');
  for (const id of ids) {
    const at = stat(join(runsDir, `${id}.json`)).mtimeMs;
    if (!Number.isFinite(at)) throw Error('run metadata unreadable');
    const run = read(id, runsDir);
    const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
    if (!object(run) || typeof run.op !== 'string' || !run.op.trim()) throw Error('run identity unreadable');
    // The filename is only a candidate selector. Missing identity must not classify
    // a corrupt review as unrelated and turn an incomplete scan into a proof.
    if (run.op === 'review-pr' && (!object(run.input)
      || typeof run.input.repo !== 'string' || !run.input.repo.trim()
      || !['string', 'number'].includes(typeof run.input.pr)
      || !Number.isSafeInteger(Number(run.input.pr)) || Number(run.input.pr) <= 0
      || !Array.isArray(run.effects)
      || !(run.pending == null || object(run.pending))
      || !(run.verdict === null || (object(run.verdict)
        && typeof run.verdict.verdict === 'string' && run.verdict.verdict.trim())))) {
      throw Error('review run identity or evidence unreadable');
    }
    yield { id, run, at };
  }
}

/** Complete bounded proof; unknown state never establishes a never-reviewed head. */
export function headNeverReviewedFromRuns({ repo, pr, head, env = process.env,
  runsDir = runsDirectory(env), list = strictListRuns, read = readRun, stat = statSync } = {}) {
  try {
    if (!isRealHead(head)) return false;
    for (const { run } of reviewRuns({ runsDir, list, read, stat })) {
      if (run.op !== 'review-pr' || run.input?.repo !== repo || Number(run.input?.pr) !== Number(pr)) continue;
      const rev = run.findings?.read?.netBasis?.rev;
      // R640: unfinished reviews on other heads do not veto a review of this head.
      if (!isRealHead(rev) || rev === head) return false;
    }
    return true;
  } catch { return false; }
}

const UNFINISHED_REVIEW_CONTEXT = 'review-unfinished: an unfinished review run holds this head; a human must answer or cancel the pending confirmation';

/**
 * PURE: readers are injected; each refusal produces one decision, including unreadable evidence.
 *
 * @verdicts-partial the planner is not a verdict reducer. It names only `accept` and `prevention-outstanding`: a stored
 *   `accept` (or a judge-accepted `prevention-outstanding`) with a provable accept comment on the live head may settle
 *   a kept `red-team:pending`. Every other stored verdict flows through the evidence and owed-ness checks unchanged,
 *   so a verdict added to the enum needs no branch here.
 */
export function planRedTeamOnSkip({ repo, refusals = [], rawPrs, readEvidence, readStatus, now,
  setting, lastDispatch, proveMove = () => ({ ok: false }), readCarry = () => null, readWitness, recoveryOptions,
  headNeverReviewed = headNeverReviewedFromRuns, readReviewRuns = defaultReadReviewRuns }) {
  return refusals.filter(r => r?.kind === 'already-reviewed-head').map(refusal => {
    const pr = Number(refusal.prNumber);
    const rawPr = (rawPrs ?? []).find(p => Number(p?.number) === pr);
    const head = rawPr?.headRefOid ?? null;
    const row = { prNumber: pr, head, action: 'skip' };
    const skip = why => ({ ...row, why });
    const resultOnHead = () => ({ ...skip('red-team result already on head'),
      ...(Array.isArray(rawPr?.labels) && rawPr.labels.some(label =>
        (typeof label === 'string' ? label : label?.name) === 'red-team:pending') ? {
        escalate: true,
        escalationContext: 'red-team result already on head but red-team:pending is still set; the drain/job label sync did not settle it',
      } : {}) });
    const guardedSkip = why => ({ ...skip(why),
      ...(why === 'conflicting label prevents policy-clear' ? { escalate: true } : {}) });
    const dispatchDecision = decision => {
      const last = lastDispatch.get(`${repo}#${pr}@${head}`);
      if (last != null && now - last < setting.retryCooldownMin * 60_000) return skip('retry cooldown active');
      return { ...row, ...decision };
    };
    const failedRead = result => {
      if (result.reason === 'review-unfinished') {
        try {
          const runs = readReviewRuns({ repo, pr, head });
          const resumable = findResumableParkedRun({ number: pr, headRefOid: head }, runs, { repo });
          if (resumable && runs.some(r => r.id === resumable.id && r.retryableRecordEffect === true)) {
            return dispatchDecision({ action: 'review', why: 'unfinished review has only a retryable pre-write effect; resume it' });
          }
        } catch { /* Unreadable evidence keeps the human hold. */ }
        let neverReviewed = false;
        try { neverReviewed = headNeverReviewed({ repo, pr, head }) === true; } catch { /* Unknown scan keeps escalation. */ }
        if (neverReviewed) {
          const reviews = Array.isArray(rawPr.reviews) ? rawPr.reviews : null;
          const acceptance = latestAcceptRecord(rawPr.comments, reviews);
          const refusal = publishableClearGuard({ labels: rawPr.labels, acceptance,
            comments: rawPr.comments, reviews, settlesPending: true });
          if (refusal) return guardedSkip(refusal);
          if (reviews === null) return skip('PR reviews unreadable; inspect formal reviews before full review');
          if (laterReviewHold(reviews)) return skip('formal review hold prevents full review; inspect formal reviews');
          // R640: a review is always allowed here; a red team still needs a finished review.
          return dispatchDecision({ action: 'review', why: 'head never reviewed; a review is always allowed' });
        }
        return { ...skip(result.reason), escalate: true, escalationContext: UNFINISHED_REVIEW_CONTEXT };
      }
      return skip(result.reason);
    };
    try {
      if (!setting.enabled) return skip('reviewRedTeamOnSkip.enabled=false');
      if (!isRealHead(head) || (refusal.headSha != null && refusal.headSha !== head)) return skip('live head missing or changed');
      // Unknown comments cannot establish that no result was published.
      if (!Array.isArray(rawPr.comments)) return skip('PR comments unreadable');
      const journal = readCarry({ repo, pr, head });
      if (redTeamForHead(rawPr.comments, pr, head) && (!journal || journal.step === 'done')) return resultOnHead();
      if (readWitness) {
        const w = readWitness({ repo, pr, head });
        if (w?.ok === false) return failedRead(w);
        if (['queued', 'running'].includes(w.rawWriter.parsed?.status) || w.rawWriter.parsed?.staleAbandoned) {
          const recovery = planRedTeamRecovery(w, { ...recoveryOptions, setting });
          return recovery.mode === 'skip' ? { ...skip(recovery.why),
            ...(recovery.escalate ? { escalate: true, escalationContext: recovery.escalationContext } : {}) }
            : dispatchDecision({ action: 'dispatch', mode: recovery.mode, staleRecovery: true, why: 'dead owner recovery' });
        }
      }
      const evidence = readEvidence({ repo, pr, head });
      if (evidence?.ok === false) return failedRead(evidence);
      if (evidence?.carryConflict) return skip('later review supersedes the carry');
      const unfinishedCarry = evidence?.carry && evidence.carry.step !== 'done';
      if (redTeamForHead(rawPr.comments, pr, head) && !unfinishedCarry) return resultOnHead();
      const accepted = Array.isArray(rawPr.labels) && rawPr.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'review:accepted');
      if (evidence?.inFlight || evidence?.queued) return skip('red-team pass in flight');
      const reviews = Array.isArray(rawPr.reviews) ? rawPr.reviews : null;
      const acceptance = accepted ? latestAcceptRecord(rawPr.comments, reviews) : null;
      if (acceptance?.sha === head
        && evidence?.inFlight === false && evidence.recorded !== true && evidence.seatRecorded !== true
        && evidence.completedRecorded !== true && readStatus({ repo, pr, head }) == null
        && /^📌 review — acceptance re-stamped after a rebase \(no new review\)/.test(rawPr.comments[acceptance.index]?.body ?? '')) {
        const priorComments = rawPr.comments.slice(0, acceptance.index);
        // Share numbering's trusted provenance parser; comment order alone cannot bind a carry.
        const restamp = restampRecord(rawPr.comments[acceptance.index]);
        // Select the declared source without dropping intervening verdicts or holds.
        const source = restamp ? latestAcceptRecord(priorComments, reviews, { sha: restamp.from }) : null;
        const comment = priorComments.findLast(c => {
          const parsed = parseRedTeamComment(c?.body);
          return parsed?.pr === pr && redTeamForHead([c], pr, parsed.rev);
        });
        const parsed = parseRedTeamComment(comment?.body);
        const result = source && redTeamForHead(rawPr.comments, pr, source.sha);
        // Late results on any revision also supersede the proposed source clear.
        const latestResult = rawPr.comments.findLast(c => {
          const parsed = parseRedTeamComment(c?.body);
          return parsed?.pr === pr && redTeamForHead([c], pr, parsed.rev);
        });
        if (restamp?.to === head && source?.sha === restamp.from
          && !source.laterVerdict && !source.laterBodyDerivedHold && source.sha !== head && parsed?.rev === source.sha
          && latestResult === comment && result && result.findings.length === 0
          && comment.body.split(/\r?\n/).filter(line => line.trim()).length === 2
          && /^Red team not required on this head: [^\r\n]+$/m.test(comment.body)) {
          const context = { labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews };
          const refusal = publishableClearGuard(context);
          if (refusal) return guardedSkip(refusal);
          return { ...row, action: 'carry', from: source.sha, why: 'prior policy-clear across acceptance re-stamp' };
        }
      }
      const movedCardOnly = cardOnlyHeadMoveCandidate(evidence, head)
        && proveMove({ fromSha: evidence.loopPayload.findings.read.netBasis.rev, toSha: head })?.ok === true;
      const status = unfinishedCarry ? evidence.status : readStatus({ repo, pr, head });
      const pendingCardOnly = cardOnlySkipSettlementCandidate({ ...evidence, status }, head);
      const owed = redTeamOwedFor(evidence?.loopPayload);
      const verdict = evidence?.loopPayload?.verdict?.verdict;
      const finishedNotOwed = [evidence?.status, status].every(candidate => candidate?.status === 'finished'
        && normalizeRedTeamResult(candidate.result).priorResult === 'not-owed'
        && !candidate.result?.deferredByGuard && !candidate.result?.deferredByCap);
      const recordedNotOwed = verdict === VERDICTS.ACCEPT && !owed;
      const keepsPending = Array.isArray(rawPr.labels) && rawPr.labels.some(label =>
        (typeof label === 'string' ? label : label?.name) === 'red-team:pending');
      const acceptedReview = verdict === VERDICTS.ACCEPT
        && provenAcceptance({ comments: rawPr.comments, reviews, labels: rawPr.labels, head }) !== null;
      // A judge accept after the round cap leaves prevention-outstanding stored; the trusted accept comment on this head proves it.
      const judgeAccepted = verdict === VERDICTS.PREVENTION_OUTSTANDING
        && provenAcceptance({ comments: rawPr.comments, reviews, labels: rawPr.labels, head }) !== null;
      const provenanceEscalation = keepsPending && !acceptedReview ? { escalate: true,
        escalationContext: 'red-team:pending kept: not-owed review lacks acceptance provenance; needs a human look' } : {};
      const notOwed = (why = 'stored review does not owe a red team') => {
        // Review labels independently block merge; thread/formal holds still forbid settlement.
        const acceptance = latestAcceptRecord(rawPr.comments, reviews);
        const hold = reviews === null || laterReviewHold(reviews)
          || (acceptance ? acceptance.laterVerdict || acceptance.laterBodyDerivedHold
            : rawPr.comments.some(comment => isLaterVerdictBody(comment?.body)));
        return { ...skip(why), ...provenanceEscalation,
        ...(!hold && acceptedReview && recordedNotOwed && evidence?.loopPayload?.findings?.read?.netBasis?.rev === head
          && evidence.inFlight === false && !evidence.queued
          && evidence.recorded === false && evidence.seatRecorded === false ? { settle: 'not-owed' } : {}) };
      };
      // A missing live-head review requires the full loop; stale reads cannot authorize a red-team-only pass.
      const storedHead = evidence?.loopPayload?.findings?.read?.netBasis?.rev;
      const needsReview = !movedCardOnly && !pendingCardOnly && !unfinishedCarry && accepted
        && (evidence?.loopPayload == null || (isRealHead(storedHead) && storedHead !== head))
        && evidence?.inFlight === false && !evidence.queued
        && evidence.recorded === false && evidence.seatRecorded === false
        && evidence.completedRecorded !== true && evidence.cleanRecorded !== true
        && (evidence.status == null || (isRealHead(evidence.status.head) && evidence.status.head !== head))
        && readStatus({ repo, pr, head }) == null;
      const fullReviewDecision = (why, { referralsRuled = false } = {}) => {
        // R640: pending is a merge hold, and does not prevent the full review.
        // Once every refused referral is ruled, the daemon's own "referrals need a ruling" pause notice (trusted author
        // only) is settled, and the parked run's retained review:pending is the resume's own label. Every other hold stands.
        const guardComments = referralsRuled && Array.isArray(rawPr.comments)
          ? rawPr.comments.filter(comment => !isSettledReferralPauseNotice(comment, { persistRecovered: true })) : rawPr.comments;
        const guardAcceptance = referralsRuled ? (accepted ? latestAcceptRecord(guardComments, reviews) : null) : acceptance;
        const context = { labels: rawPr.labels, acceptance: guardAcceptance, comments: guardComments, reviews,
          settlesPending: true, settlesReviewPending: referralsRuled };
        const refusal = publishableClearGuard(context);
        if (refusal) return guardedSkip(refusal);
        // Formal holds apply even without an acceptance comment. No timestamp
        // floor: a missing acceptance cannot establish that a review was cleared.
        if (reviews === null) return skip('PR reviews unreadable; inspect formal reviews before full review');
        if (laterReviewHold(reviews)) return skip('formal review hold prevents full review; inspect formal reviews');
        return dispatchDecision({ action: 'review', why });
      };
      if (needsReview) return fullReviewDecision('unprovable head move needs a full review');
      if (verdict === VERDICTS.NEEDS_HUMAN && storedHead === head) {
        let ruled = false;
        try {
          // Only the newest attempt on this head counts: an older ruled run must not mask a newer one that still owes a human.
          const newest = readReviewRuns().filter(run => run?.repo === repo && Number(run.pr) === pr && run.head === head)
            .reduce((best, run) => !best || Number(run.startedAt) > Number(best.startedAt) ? run : best, null);
          // A run still failing to persist is the persistence retry path's, not a ruling resume (and its notices stay holds).
          ruled = newest != null && newest.persistenceFailed === false
            && refusedReferralsAreRuled({ ...rawPr, number: pr }, newest, { repo });
        } catch { /* Unknown run evidence preserves the existing not-owed decision. */ }
        if (ruled) return fullReviewDecision('stored review needs-human only on referrals now ruled; resume the parked run',
          { referralsRuled: true });
      }
      if (!movedCardOnly && !pendingCardOnly && (!owed || accepted || finishedNotOwed)) {
        if (evidence?.inFlight || evidence?.queued) return skip('red-team pass in flight');
        if (evidence?.loopPayload?.findings?.read?.netBasis?.rev === head
          && accepted
          && (() => {
            const status = readStatus({ repo, pr, head });
            // An accepting review with no status still owes its normal pass.
            // Both the selected evidence and the live status must permit clearing:
            // a raw reread must not resurrect a status discarded for a newer acceptance.
            return (status == null && !owed) || (evidence.seatRecorded === false
              && [evidence.status, status].every(candidate => candidate?.status === 'finished'
                && normalizeRedTeamResult(candidate.result).priorResult === 'not-owed'
                && !candidate.result?.deferredByGuard && !candidate.result?.deferredByCap));
          })()
          // The stored verdict may predate the acceptance (a round-budget accept leaves `changes` behind);
          // a finished not-owed status on this accepted head settles as policy-clear (R100/R338).
          && (redTeamRequired(evidence.loopPayload?.verdict?.verdict)
            // A judge/round-budget accept (provable accept comment on this head) leaves prevention-outstanding stored.
            // A red-team-only job returns not-owed for it WITHOUT writing a status, so dispatching one would only
            // re-run that no-op each cooldown; with no red-team state at all, settle the kept pending label here.
            || (keepsPending && judgeAccepted && evidence.status == null && status == null)
            || [evidence.status, status].every(candidate => candidate?.status === 'finished'
              && normalizeRedTeamResult(candidate.result).priorResult === 'not-owed'))
          && evidence.recorded !== true && evidence.seatRecorded !== true) {
          if (acceptance?.sha !== head) return notOwed();
          const context = { labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews, settlesPending: true };
          const refusal = publishableClearGuard(context);
          if (refusal) return { ...guardedSkip(refusal), ...provenanceEscalation };
          if (keepsPending && !acceptedReview && !judgeAccepted) return notOwed();
          return { ...row, action: 'clear', why: 'not owed (stored review)' };
        }
        if (!owed || finishedNotOwed) return notOwed();
      }
      if (!movedCardOnly && evidence.loopPayload?.findings?.read?.netBasis?.rev !== head) return skip('stored review does not match live head');
      if (evidence.inFlight || evidence.queued) return skip('red-team pass in flight');
      const { priorResult: prior, priorComment: comment } = normalizeRedTeamResult(status?.result);
      const completedSeat = evidence.completedRecorded === true || evidence.cleanRecorded === true;
      // A null completion alone is unknown. Only the recovery reader's normalization
      // of an originally queued writer can make it a never-started placeholder.
      const placeholder = redTeamStatusWithoutRun(status, { originalStatus: evidence.status });
      let mode;
      if (movedCardOnly && (status != null || evidence.completedRecorded === true)) return skip('live head already has red-team state');
      if (comment === 'posted') return skip('result posted; comment not visible yet');
      // Only one explicitly failed seat permits a fresh retry. Successful execution
      // can resume effects even when its verdict contains confirmed breaks.
      if (movedCardOnly || failedRedTeamRetry(status, evidence)) mode = 'fresh';
      else if (status?.status === 'finished' && (['ran', 'resumed'].includes(prior) || status.result === 'resumed')
        && (completedSeat || (!placeholder && typeof status.result === 'object'
          && evidence.recorded === true && evidence.completedRecorded !== false))) {
        mode = 'resume';
      } else if (redTeamSkipNeedsSettlement(status)) mode = 'fresh';
      else if (placeholder && (evidence.seatRecorded === false
        || (evidence.seatRecorded === undefined && evidence.recorded === false))) mode = 'fresh';
      else if (status == null && evidence.recorded === false) mode = 'fresh';
      else return skip(`prior result ${typeof prior === 'string' ? prior : 'unknown'} (status ${status?.status ?? 'missing'}); not re-run`);
      // Even a policy-settlement fallback must not turn a spent retry into fresh provider work.
      if (mode === 'fresh' && status?.retryCount >= 1) return skip('red-team retry already spent; inspect stored evidence');
      return dispatchDecision({ action: 'dispatch', mode, why: mode === 'resume' ? 'recorded pass needs its result comment/effects' : 'head never had a red-team pass' });
    } catch { return skip('red-team evidence unreadable; inspect stored evidence before retrying'); }
  });
}

const lastDispatch = new Map();
const safeLine = value => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600);

/** Complete review evidence: at most ten requests and one MiB, never a truncated success. */
export function readCompletePrReviews({ repo, pr, env = process.env, exec = runGhSync } = {}) {
  if (exec === runGhSync && (isUnderTest() || isUnderTest(env))) return undefined;
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo ?? '') || !Number.isSafeInteger(Number(pr)) || Number(pr) <= 0) {
    throw Error('PR reviews identity unreadable; inspect complete reviews');
  }
  const reviews = [];
  let bytes = 0;
  for (let page = 1; page <= 10; page++) {
    const text = exec(['api', `repos/${repo}/pulls/${Number(pr)}/reviews?per_page=100&page=${page}`],
      { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (typeof text !== 'string' || (bytes += Buffer.byteLength(text, 'utf8')) > 1024 * 1024) {
      throw Error('PR reviews size cap exceeded; inspect complete reviews');
    }
    let rows;
    try { rows = JSON.parse(text); }
    catch { throw Error('PR reviews JSON unreadable; inspect complete reviews'); }
    if (!Array.isArray(rows) || rows.length > 100) throw Error('PR reviews page unreadable; inspect complete reviews');
    reviews.push(...rows);
    if (rows.length < 100) return reviews;
  }
  throw Error('PR reviews page cap reached; inspect complete reviews');
}

function holdGuardedProvider(provider, head) {
  const refuse = state => {
    if (state?.headRefOid !== head) throw Error('head moved before settlement; label unchanged');
    const names = Array.isArray(state?.labels) ? state.labels.map(label => (typeof label === 'string' ? label : label?.name)) : null;
    if (!names || names.some(name => typeof name !== 'string' || !name)
      || !names.includes('review:accepted')
      || names.some(name => conflictsWithPolicyClear(name, { settlesPending: true }))) {
      throw Error('hold label appeared before settlement; label unchanged');
    }
  };
  return { ...provider,
    readPrState: (repo, pr) => { const state = provider.readPrState(repo, pr); refuse(state); return state; },
    setLabels: (repo, pr, change) => { refuse(provider.readPrState(repo, pr)); return provider.setLabels(repo, pr, change); } };
}

/** Re-read the live head and labels before removing a stale pending status. */
export function settlePendingFor({ provider, env = process.env } = {}) {
  return ({ repo, pr, head }) => {
    if (!provider && (isUnderTest() || isUnderTest(env))) return;
    const labels = provider ?? createGhProvider({ exec: (args, options) => runGhSync(args,
      { ...options, env, encoding: 'utf8', timeout: 60_000 }) });
    const live = labels.readPrState(repo, pr);
    if (!isRealHead(head) || live?.headRefOid !== head) return { skipped: 'head-moved' };
    if (!Array.isArray(live.labels)) throw Error('PR labels unreadable');
    const names = live.labels.map(label => typeof label === 'string' ? label : label?.name);
    if (names.some(name => typeof name !== 'string')) throw Error('PR labels unreadable');
    if (!names.includes('red-team:pending') || names.includes('red-team:blocked')) return;
    return labels.setLabels(repo, pr, { remove: ['red-team:pending'] });
  };
}

const hasReviewCapacity = capacity => capacity?.lanes > 0
  && (!capacity.budget || capacity.budget.left > 0)
  && (capacity.remainingStarts == null || capacity.remainingStarts > 0);

/** Bounded recovery, sharing lane, live-review and host start capacity. Errors never abort the daemon tick.
 * `capacity.remainingStarts` caps starts after ordinary dispatches; `capacity.take()` consumes one shared
 * host start on success or an unknown outcome. Both are optional for standalone callers.
 */
export function runRedTeamOnSkip({ repo, plan, rawPrs, capacity, dispatch, log = () => {}, dryRun = false,
  env = process.env, setting,
  readEvidence = readDrainRedTeamEvidence, readStatus = readRedTeamStatus,
  readCarry = key => readRedTeamCarry({ ...key, env }),
  readReviewRuns = isUnderTest() || isUnderTest(env) ? () => [] : readReviewRunEvidence,
  readReviews, readCompleteReviews,
  // Test defaults use the supplied fixture without external IO. Race tests inject live readers.
  provider = isUnderTest() || isUnderTest(env) ? {
    readPrState: (_repo, pr) => rawPrs?.find(raw => Number(raw.number) === Number(pr)),
    setLabels: () => {}, ensureLabel: () => {},
  } : createGhProvider({ exec: (args, options) => runGhSync(args,
    { ...options, env, encoding: 'utf8', timeout: 60_000 }) }),
  readComments = ({ repo, pr }) => isUnderTest() || isUnderTest(env)
    ? rawPrs?.find(raw => Number(raw.number) === Number(pr))?.comments
    : readCompletePrComments(Number(pr), { repo,
      exec: (_file, args, options) => runGhSync(args, { ...options, env }) }),
  readHeadFiles = key => isUnderTest() || isUnderTest(env)
    ? rawPrs?.find(raw => Number(raw.number) === Number(key.number))?.netFiles
    : readBacklogOnlyNetFiles(key),
  exec = execFileSync, cwd = process.cwd(), mainRef = 'origin/main',
  proveMove = move => proveCardOnlyHeadMove({ ...move, exec, cwd, mainRef }),
  readWitness = readEvidence === readDrainRedTeamEvidence && readStatus === readRedTeamStatus
    ? key => readRecoveryWitness({ ...key, env }) : null,
  headNeverReviewed = key => headNeverReviewedFromRuns({ ...key, env }),
  settlePending = settlePendingFor({ provider, env }),
  escalate = ({ repo, pr, head, why }) => {
    if (isUnderTest() || isUnderTest(env)) return;
    let error;
    const result = settleRedTeamSkip({ repo, pr, head, redTeam: { status: 'skipped', reason: why },
      io: { env, publishNeedsYou: publishAttention, log: message => { error = safeErrorText(message); } } });
    if (error) throw Error(error);
    return result;
  },
  abandon = key => abandonStaleRedTeamRun({ ...key, env }),
  now = Date.now, lastDispatch: history = lastDispatch, preferLane, settle = settleRedTeamSkip, syncLabels = syncRedTeamStatusLabels,
  publishCheck = null } = {}) {
  const rows = [], dispatched = [], notStarted = [];
  // PR #6535: a policy-clear settlement here runs no round, so it publishes the head's red-team check itself, BEFORE
  // its result comment. A failed check post throws, so no comment is posted and the next pass retries the row.
  // Under `redTeamGate.source=drain-scan` (the rollback) no gate reads the check, so the post is best-effort there: it is
  // still attempted (as round writers publish in every mode), so a head settled during a rollback is not stranded
  // once the source switches back, but a failure does not block the settlement. Test runs need explicit IO for this
  // channel, as recordRedTeamStatus does.
  // The App id comes from the shared resolver (the `redTeamGate.appId` setting, WE_APP_ID env as its top layer: the
  // daemon never sets the env), and the writes run as that App, never this daemon's reviewer role (#6535, R907).
  const publisher = publishCheck ?? (isUnderTest() || isUnderTest(env) ? null : createPolicyClearPublisher({ env }));
  const publishPolicyClearCheck = (pr, head) => {
    if (!publisher) return;
    let posted;
    try { posted = publisher({ repo, pr, headSha: head }); }
    catch (error) { posted = { ok: false, reason: safeErrorText(error) }; }
    if (posted?.ok === true) return;
    // `detail` names a superseding post that did not land (the one fail-open case), so the log never hides it.
    const reason = `red-team check not published: ${posted?.reason ?? 'unknown error'}${posted?.detail ? ` (${posted.detail})` : ''}`;
    if (readRedTeamGateSource({ env }).value.source !== 'drain-scan') throw Error(reason);
    note(`review-daemon: ${repo}#${pr} ${reason} (redTeamGate.source=drain-scan: settlement continues)`);
  };
  const note = line => { try { log(safeLine(line)); } catch { /* diagnostic only */ } };
  try {
    const at = now();
    const resolved = setting ?? resolveReviewRedTeamOnSkip({ env, log: note }).value;
    const refusals = plan?.refusals ?? [];
    // Reconcile rows omit formal reviews. Read recovery candidates, including unaccepted not-owed heads,
    // once per PR, without mutating the daemon's shared snapshot. Failed/oversized
    // reads stay unknown: the planner requires operator inspection before clearing.
    const reviewReader = readReviews ?? (({ repo, pr }) => JSON.parse(runGhSync([
      'pr', 'view', String(pr), '--repo', repo, '--json', 'reviews',
    ], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })).reviews);
    const reviewsByPr = new Map();
    const planningPrs = (rawPrs ?? []).map(rawPr => {
      const pr = Number(rawPr?.number), head = rawPr?.headRefOid;
      if (!resolved.enabled || Array.isArray(rawPr?.reviews) || !isRealHead(head)
        || !refusals.some(r => r?.kind === 'already-reviewed-head' && Number(r.prNumber) === pr
          && (r.headSha == null || r.headSha === head))
        || !Array.isArray(rawPr.comments) || redTeamForHead(rawPr.comments, pr, head)
        || !Array.isArray(rawPr.labels) || !rawPr.labels.some(label =>
          // review:pending is the parked run's own retained label: a ruled referral-blocked review resumes through
          // fullReviewDecision, which needs the formal reviews even when no accept or red-team label is present.
          ['review:accepted', 'red-team:pending', 'review:pending'].includes(typeof label === 'string' ? label : label?.name))) return rawPr;
      if (reviewsByPr.has(pr)) return { ...rawPr, reviews: reviewsByPr.get(pr) };
      let reviews;
      try {
        const result = reviewReader({ repo, pr });
        if (Array.isArray(result)) reviews = result;
      } catch { /* Unknown reviews must keep policy-clear closed. */ }
      reviewsByPr.set(pr, reviews);
      return { ...rawPr, reviews };
    });
    const planningOptions = { repo, refusals, rawPrs: planningPrs,
      readEvidence, readStatus, readReviewRuns,
      now: at, setting: resolved, lastDispatch: history, proveMove, readCarry, readWitness, headNeverReviewed,
      recoveryOptions: { now: at, probe: recoveryProbe(), deadlineMs: staleRunDeadlineMs(env), env } };
    rows.push(...planRedTeamOnSkip(planningOptions));
    const escalateRow = row => {
      try {
        if (row.escalationContext) note(`review-daemon: ${repo}#${row.prNumber} ${row.why}: ${row.escalationContext}`);
        const result = escalate({ repo, pr: row.prNumber, head: row.head, why: row.why });
        if (result?.error || result?.outcome === 'error') {
          row.settleError = safeErrorText(result.error ?? result.reason ?? 'unknown error');
        }
      } catch (error) { row.settleError = safeErrorText(error); }
    };
    const holdUnfinishedReview = row => {
      row.action = 'skip'; row.why = 'review-unfinished'; row.escalate = true;
      row.escalationContext = UNFINISHED_REVIEW_CONTEXT;
      delete row.settle;
      escalateRow(row);
    };
    const freshSettlement = row => {
      const live = provider.readPrState(repo, row.prNumber);
      const comments = readComments({ repo, pr: row.prNumber });
      const reviews = readCompleteReviews ? readCompleteReviews({ repo, pr: row.prNumber })
        : !(isUnderTest() || isUnderTest(env)) ? readCompletePrReviews({ repo, pr: row.prNumber, env })
          : readReviews ? reviewReader({ repo, pr: row.prNumber })
            : (rawPrs?.find(raw => Number(raw.number) === row.prNumber)?.reviews
              ?? planningPrs.find(raw => Number(raw.number) === row.prNumber)?.reviews);
      if (live?.headRefOid !== row.head || !Array.isArray(live.labels)
        || live.labels.some(label => typeof (typeof label === 'string' ? label : label?.name) !== 'string')
        || !Array.isArray(comments) || comments.some(comment => typeof comment?.body !== 'string')
        || !Array.isArray(reviews)) throw Error('fresh PR evidence unreadable or head changed before settlement');
      if (row.action === 'clear'
        && !provenAcceptance({ comments, reviews, labels: live.labels, head: row.head })) {
        throw Error('no proven acceptance for this head; label unchanged');
      }
      const acceptance = latestAcceptRecord(comments, reviews);
      if (laterReviewHold(reviews) || acceptance?.laterVerdict || acceptance?.laterBodyDerivedHold
        || !acceptance && comments.some(comment => isLaterVerdictBody(comment.body))) {
        throw Error('evidence changed before settlement');
      }
      const rawPr = { ...live, number: row.prNumber, comments, reviews };
      const refusal = refusals.find(r => r.kind === 'already-reviewed-head' && Number(r.prNumber) === row.prNumber);
      const [fresh] = planRedTeamOnSkip({ ...planningOptions, refusals: refusal ? [refusal] : [],
        rawPrs: [rawPr], now: now() });
      if (fresh?.why === 'review-unfinished' && fresh.escalate) {
        holdUnfinishedReview(row);
        return null;
      }
      if (fresh?.action !== row.action || fresh.settle !== row.settle || fresh.head !== row.head) {
        throw Error('evidence changed before settlement');
      }
      return rawPr;
    };
    for (const row of rows) {
      let started = false;
      if (!dryRun && row.action === 'skip') {
        try {
          const key = { repo, pr: row.prNumber, head: row.head };
          if (row.escalate) {
            escalateRow(row);
          } else if (row.settle === 'not-owed') {
            const rawPr = planningPrs.find(p => Number(p?.number) === row.prNumber);
            if (Array.isArray(rawPr?.labels) && !rawPr.labels.some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:blocked')) {
              if (freshSettlement(row)) settlePending({ ...key, remove: ['red-team:pending'] });
            }
          }
        } catch (error) { row.settleError = safeErrorText(error); }
      }
      if (row.action === 'carry') {
        if (dryRun) row.why = 'dry run (carry)';
        else {
          try {
            const body = `${redTeamMarker(row.prNumber, row.head)}\nRed team not required on this head: prior policy-clear carried from ${row.from.slice(0, 8)} across a content-preserving rebase (acceptance re-stamped)`;
            publishPolicyClearCheck(row.prNumber, row.head);
            runGhSync(['pr', 'comment', String(row.prNumber), `--repo=${repo}`, '--body-file', '-'],
              { input: body, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
            syncLabels({ repo, pr: row.prNumber, head: row.head, env, log: note });
          } catch (error) { row.action = 'skip'; row.why = `carry failed: ${safeErrorText(error)}`; }
        }
      }
      if (row.action === 'clear') {
        if (dryRun) row.why = 'dry run (clear)';
        else {
          try {
            let rawPr;
            try { rawPr = freshSettlement(row); if (!rawPr) continue; }
            catch { throw Error('evidence changed before settlement'); }
            let publishFailure = null;
            const result = settle({ redTeam: { status: 'not-owed' }, repo, pr: row.prNumber,
              head: row.head, readHead: row.head, accepted: true, storedReviewPolicyClear: true, comments: rawPr.comments, reason: row.why,
              io: { env, log: note,
                // settleRedTeamSkip reaches this only once it decided policy-clear and the head shows no result.
                postComment: ({ repo, pr, body }) => {
                  // settleRedTeamSkip bounds its reason to 80 chars for the needs-you feed, which would cut a yield's
                  // `detail` (the one fail-open case) or a comment failure's cause out of the row. Keep the full
                  // failure text for the row; the feed keeps its bound.
                  try {
                    publishPolicyClearCheck(pr, row.head);
                    return runGhSync([
                      'pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-',
                    ], { input: body, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
                  } catch (error) { publishFailure = safeErrorText(error); throw error; }
                },
                publishNeedsYou: publishAttention,
              } });
            if (['policy-clear', 'already'].includes(result?.outcome)) {
              syncLabels({ repo, pr: row.prNumber, head: row.head, env, log: note, provider: holdGuardedProvider(provider, row.head) });
            } else {
              row.action = 'skip';
              row.why = `clear failed: ${publishFailure ? `policy-clear comment failed: ${publishFailure}` : result?.reason ?? result?.outcome ?? 'unknown outcome'}`;
            }
          } catch (error) {
            row.action = 'skip';
            row.why = `clear failed: ${safeErrorText(error)}`;
          }
        }
      }
      if (row.action === 'dispatch' || row.action === 'review') {
        const budget = capacity?.budget;
        if (!hasReviewCapacity(capacity)) row.why = 'no review capacity left';
        else if (dryRun) row.why = `dry run (${row.mode ?? row.action})`;
        else {
          const reserved = budget && Number.isFinite(budget.left);
          if (reserved) budget.left--;
          try {
            if (row.staleRecovery && !abandon({ repo, pr: row.prNumber, head: row.head }).ok) throw new PreStartDispatchRefusalError('stale abandonment refused');
            const result = dispatch({ pr: row.prNumber, repo,
              ...(row.action === 'dispatch' ? { redTeamOnly: true, redTeamMode: row.mode } : {}),
              ...(preferLane != null ? { preferLane } : {}) });
            if (result?.skipped || !Number.isInteger(result?.jobPid)) {
              const refundable = result?.skipped !== 'live-job'
                || (budget?.countedJobPids instanceof Set && budget.countedJobPids.has(result.jobPid));
              if (reserved && refundable) budget.left++;
              row.why = result?.skipped ?? 'job did not start';
            } else {
              capacity.lanes--;
              if (capacity.remainingStarts != null) capacity.remainingStarts--;
              capacity.take?.();
              history.set(`${repo}#${row.prNumber}@${row.head}`, at);
              dispatched.push({ prNumber: row.prNumber, jobPid: result.jobPid, mode: row.mode ?? row.action });
              started = true;
            }
          } catch (error) {
            const message = safeErrorText(error);
            const text = safeLine(message).slice(0, 300);
            note(`review-daemon: ${repo}#${row.prNumber} red-team dispatch threw: ${text}`);
            if (error instanceof PreStartDispatchRefusalError) {
              // These guards refuse before spawning; leave capacity and cooldown available for retry.
              if (reserved) budget.left++;
              row.why = `dispatch refused before start: ${text}`;
            } else {
              // An unclassified throw may follow a spawn: retain its reservation until the next live process read.
              capacity.lanes--;
              if (capacity.remainingStarts != null) capacity.remainingStarts--;
              capacity.take?.();
              row.why = `dispatch failed; start unknown: ${text}`;
            }
          }
        }
        if (!started) { row.action = 'skip'; notStarted.push({ prNumber: row.prNumber, reason: row.why }); }
      }
      if (started && row.action === 'review') {
        note(`review-daemon: ${repo}#${row.prNumber} already-reviewed-head — fresh review dispatched for unprovable head move ${String(row.head).slice(0, 12)}`);
      } else note(`review-daemon: ${repo}#${row.prNumber} already-reviewed-head — red team ${started ? `dispatched (${row.mode})` : ['clear', 'carry'].includes(row.action) && !dryRun ? 'cleared' : 'not dispatched'} for head ${String(row.head ?? 'unknown').slice(0, 12)}: ${row.why}`);
    }
    try {
      rows.push(...runBacklogOnlyPrep({ repo, rawPrs, env, log: note, dryRun, readComments, readHeadFiles,
        readLive: ({ repo, pr }) => provider.readPrState(repo, pr), syncLabels,
        post: ({ pr, body }) => runGhSync(['pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-'],
          { input: body, env, timeout: 60_000, maxBuffer: 1024 * 1024 }),
      }));
    } catch (error) { note(`red-team: backlog-only prep held: ${safeErrorText(error)}`); }
  } catch {
    rows.push({ prNumber: null, head: null, action: 'skip', why: 'red-team recovery inputs unreadable' });
    note(`review-daemon: ${repo}#? already-reviewed-head — red team not dispatched for head unknown: red-team recovery inputs unreadable`);
  }
  return { rows, dispatched, notStarted };
}
