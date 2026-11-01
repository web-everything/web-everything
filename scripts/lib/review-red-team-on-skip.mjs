/** Recover an owed red-team result on an already-reviewed head through the existing review job. */
import { execFileSync } from 'node:child_process';
import { proveCardOnlyHeadMove } from './card-only-head-move.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDrainRedTeamEvidence, readRedTeamStatus, readRecoveryWitness, redTeamStatusDir, withRedTeamStatusClaim } from './drain-red-team-evidence.mjs';
import { redTeamForHead, redTeamMarker, parseRedTeamComment } from './red-team-gate.mjs';
import { redTeamOwedFor, redTeamCardOnly } from './review-red-team-policy.mjs';
import { readRedTeamCarry } from './red-team-carry-machine.mjs';
import { isRealHead, safeErrorText, settleRedTeamSkip } from './red-team-skip-outcome.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { failedRedTeamRetry, redTeamStatusWithoutRun, completedRedTeamSeat } from './red-team-run-result.mjs';

import { redTeamRequired } from './jury-core.mjs';
import { isLaterVerdictBody, latestAcceptRecord, laterReviewHold } from './accept-carry-forward.mjs';
import { restampRecord, strandedNumberingRecords } from './numbering-carry.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { RED_TEAM_STATUS_LABELS } from './red-team-status-label-meta.mjs';

export const staleRunDeadlineMs = (env = process.env) => /^\d+$/.test(env.WE_RED_TEAM_STALE_RUN_MS ?? '')
  && Number.isSafeInteger(Number(env.WE_RED_TEAM_STALE_RUN_MS)) ? Number(env.WE_RED_TEAM_STALE_RUN_MS) : 7_200_000;

const pendingAbandonment = w => w.markers.redispatch?.priorWriter === w.rawWriter.sha256
  && w.markers.redispatch?.evidence === w.evidenceSha256
  && typeof w.markers.redispatch?.abandonedAt === 'string';

/** Pure decision on a raw witness. Probes and time are supplied by the caller. */
export function planRedTeamRecovery(w, { now, probe, deadlineMs } = {}) {
  const raw = w.rawWriter.parsed;
  let executionPrior = raw;
  const reject = why => ({ rawWriter: w.rawWriter, executionPrior, mode: 'skip', why });
  const payload = w.newest;
  if (!redTeamOwedFor(payload) || payload?.carriedFrom || payload?.findings?.read?.netBasis?.rev !== w.head) return reject('newest review does not owe a pass');
  const active = ['queued', 'running'].includes(raw?.status);
  let dead = !active;
  if (active) {
    dead = false;
    if (raw.host === probe.host && raw.pidNamespace === probe.namespace && Number.isInteger(raw.pid) && raw.pid > 0) {
      try {
        const alive = probe.isAlive(raw.pid);
        if (alive === false) dead = true;
        else if (alive === true) {
          // An existence probe already proved a live pid. Only a verified birth-time
          // mismatch proves reuse; an unavailable ps probe must never fall back to age.
          let start;
          try { start = raw.pidStart ? probe.readPidStart?.(raw.pid) : null; }
          catch { return reject('owner live; start unreadable'); }
          if (!raw.pidStart || start == null || start === raw.pidStart) return reject('owner live');
          dead = true;
        }
      } catch { /* Unprobeable owners use the explicit age deadline. */ }
    }
    if (!dead) {
      const stamp = raw.pidStart;
      const at = Date.parse(/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(stamp ?? '') ? `${stamp} UTC` : stamp);
      dead = Number.isFinite(at) && now - at > deadlineMs;
    }
    if (!dead) return reject('owner live or age unknown');
  }
  const marker = w.markers.redispatch;
  if (marker && !raw) return reject('stale marker without writer; inspect stored evidence');
  if (raw?.staleAbandoned && (!marker || marker.writer !== w.rawWriter.sha256 || marker.evidence !== w.evidenceSha256)) return reject('abandonment witness changed');
  if (marker && active && !raw?.staleAbandoned && !pendingAbandonment(w)) return reject('stale re-dispatch already spent');
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
  return { rawWriter: w.rawWriter, executionPrior, mode, payload, retry, abandon: active && !raw.staleAbandoned };
}

export const recoveryProbe = () => ({ host: hostname(), namespace: pidNamespace(), isAlive: pidAlive, readPidStart: pidStartTime });

/** Spend one abandonment before spawning. The marker binds raw bytes, rows and newest review, never a plan. */
export function abandonStaleRedTeamRun(key, { readWitness = () => readRecoveryWitness(key), now = Date.now,
  probe = recoveryProbe(), deadlineMs = staleRunDeadlineMs(key.env), writeJson = writeJsonAtomic } = {}) {
  const path = join(redTeamStatusDir(key.env), `${encodeURIComponent(key.repo)}-${Number(key.pr)}-${key.head}.json`);
  try {
    return withRedTeamStatusClaim(path, () => {
      const w = readWitness(), p = planRedTeamRecovery(w, { now: now(), probe, deadlineMs });
      if (p.mode !== 'skip' && w.rawWriter.parsed?.staleAbandoned) return { ok: true };
      if (!p.abandon || p.mode === 'skip' || (w.markers.redispatch && !pendingAbandonment(w))) return { ok: false };
      const marker = `${path}.stale-redispatch-1`;
      const abandonedAt = w.markers.redispatch?.abandonedAt ?? new Date(now()).toISOString();
      const next = { ...w.rawWriter.parsed, staleAbandoned: { at: abandonedAt } };
      // Bind the exact writeJsonAtomic rendering before publishing either file. A crash
      // leaves either the old writer plus this complete intent, or the bound new writer.
      const writer = createHash('sha256').update(`${JSON.stringify(next, null, 2)}\n`).digest('hex');
      if (w.markers.redispatch && w.markers.redispatch.writer !== writer) return { ok: false };
      if (!w.markers.redispatch) writeJson(marker, { writer, evidence: w.evidenceSha256,
        priorWriter: w.rawWriter.sha256, abandonedAt }, { mode: 0o600 });
      writeJson(path, next);
      return { ok: true };
    }, { readPidStart: probe.readPidStart });
  } catch { return { ok: false }; }
}

// review-labels.mjs exports names only. Fail closed for every review hold namespace,
// including future merge holds, rather than maintaining a partial list here.
function conflictsWithPolicyClear(label) {
  const name = typeof label === 'string' ? label : label?.name;
  return typeof name === 'string' && (
    (name.startsWith('review:') && name !== 'review:accepted')
    || name.startsWith('review-status:')
    || (RED_TEAM_STATUS_LABELS.includes(name) && name !== 'red-team:clear')
  );
}

/** Live holds supersede both carried and stored policy-clears. PURE.
 * Without an acceptance record nothing is "later", so any explicit hold comment stands (any author: fail closed).
 */
function publishableClearGuard({ labels, acceptance, comments, reviews }) {
  if (acceptance?.laterVerdict || acceptance?.laterBodyDerivedHold) {
    return 'later verdict or hold supersedes acceptance';
  }
  if (!acceptance && (!Array.isArray(comments) || comments.some(c => isLaterVerdictBody(c?.body)))) {
    return 'explicit review hold comment prevents full review; inspect the PR thread';
  }
  if (acceptance?.reviewsUnreadable) return 'PR reviews unreadable; inspect formal reviews before policy-clear';
  if (!Array.isArray(labels)) return 'PR labels unreadable';
  if (labels.some(conflictsWithPolicyClear)) {
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
  try { const data = JSON.parse(readFile(toolPath, 'utf8')); tool = { enabled: data.enabled, retryCooldownMin: data.retryCooldownMin }; } catch { /* lower layers */ }
  const raw = env.WE_REVIEW_RED_TEAM_ON_SKIP;
  const cooldown = env.WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN;
  return cascadePolicy('reviewRedTeamOnSkip', tool, {
    env, log, standard: { enabled: true, retryCooldownMin: 30 },
    envValues: { enabled: raw === '0' ? false : raw === '1' ? true : raw || undefined,
      retryCooldownMin: typeof cooldown === 'string' && /^\d+$/.test(cooldown) ? Number(cooldown) : cooldown || undefined },
    valid: { enabled: v => typeof v === 'boolean', retryCooldownMin: v => Number.isSafeInteger(v) && v >= 0 },
  });
}

/** PURE: readers are injected; each refusal produces one decision, including unreadable evidence. */
export function planRedTeamOnSkip({ repo, refusals = [], rawPrs, readEvidence, readStatus, now,
  setting, lastDispatch, proveMove = () => ({ ok: false }), readCarry = () => null, readWitness, recoveryOptions }) {
  return refusals.filter(r => r?.kind === 'already-reviewed-head').map(refusal => {
    const pr = Number(refusal.prNumber);
    const rawPr = (rawPrs ?? []).find(p => Number(p?.number) === pr);
    const head = rawPr?.headRefOid ?? null;
    const row = { prNumber: pr, head, action: 'skip' };
    const skip = why => ({ ...row, why });
    const dispatchDecision = decision => {
      const last = lastDispatch.get(`${repo}#${pr}@${head}`);
      if (last != null && now - last < setting.retryCooldownMin * 60_000) return skip('retry cooldown active');
      return { ...row, ...decision };
    };
    try {
      if (!setting.enabled) return skip('reviewRedTeamOnSkip.enabled=false');
      if (!isRealHead(head) || (refusal.headSha != null && refusal.headSha !== head)) return skip('live head missing or changed');
      // Unknown comments cannot establish that no result was published.
      if (!Array.isArray(rawPr.comments)) return skip('PR comments unreadable');
      const journal = readCarry({ repo, pr, head });
      if (redTeamForHead(rawPr.comments, pr, head) && (!journal || journal.step === 'done')) return skip('red-team result already on head');
      if (readWitness) {
        const w = readWitness({ repo, pr, head });
        if (['queued', 'running'].includes(w.rawWriter.parsed?.status) || w.rawWriter.parsed?.staleAbandoned) {
          const recovery = planRedTeamRecovery(w, recoveryOptions);
          return recovery.mode === 'skip' ? skip(recovery.why)
            : dispatchDecision({ action: 'dispatch', mode: recovery.mode, staleRecovery: true, why: 'dead owner recovery' });
        }
      }
      const evidence = readEvidence({ repo, pr, head });
      if (evidence?.carryConflict) return skip('later review supersedes the carry');
      const unfinishedCarry = evidence?.carry && evidence.carry.step !== 'done';
      if (redTeamForHead(rawPr.comments, pr, head) && !unfinishedCarry) return skip('red-team result already on head');
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
          const refusal = publishableClearGuard({ labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews });
          if (refusal) return skip(refusal);
          return { ...row, action: 'carry', from: source.sha, why: 'prior policy-clear across acceptance re-stamp' };
        }
      }
      const movedCardOnly = cardOnlyHeadMoveCandidate(evidence, head)
        && proveMove({ fromSha: evidence.loopPayload.findings.read.netBasis.rev, toSha: head })?.ok === true;
      const status = unfinishedCarry ? evidence.status : readStatus({ repo, pr, head });
      const pendingCardOnly = cardOnlySkipSettlementCandidate({ ...evidence, status }, head);
      const owed = redTeamOwedFor(evidence?.loopPayload);
      // A missing live-head review requires the full loop; stale reads cannot authorize a red-team-only pass.
      const storedHead = evidence?.loopPayload?.findings?.read?.netBasis?.rev;
      const needsReview = !movedCardOnly && !pendingCardOnly && !unfinishedCarry && accepted
        && (evidence?.loopPayload == null || (isRealHead(storedHead) && storedHead !== head))
        && evidence?.inFlight === false && !evidence.queued
        && evidence.recorded === false && evidence.seatRecorded === false
        && evidence.completedRecorded !== true && evidence.cleanRecorded !== true
        && (evidence.status == null || (isRealHead(evidence.status.head) && evidence.status.head !== head))
        && readStatus({ repo, pr, head }) == null;
      if (needsReview) {
        const refusal = publishableClearGuard({ labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews });
        if (refusal) return skip(refusal);
        // Formal holds apply even without an acceptance comment. No timestamp
        // floor: a missing acceptance cannot establish that a review was cleared.
        if (reviews === null) return skip('PR reviews unreadable; inspect formal reviews before full review');
        if (laterReviewHold(reviews)) return skip('formal review hold prevents full review; inspect formal reviews');
        return dispatchDecision({ action: 'review', why: 'unprovable head move needs a full review' });
      }
      if (!movedCardOnly && !pendingCardOnly && (!owed || accepted)) {
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
          && redTeamRequired(evidence.loopPayload?.verdict?.verdict)
          && evidence.recorded !== true && evidence.seatRecorded !== true) {
          if (acceptance?.sha !== head) return skip('stored review does not owe a red team');
          const refusal = publishableClearGuard({ labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews });
          if (refusal) return skip(refusal);
          return { ...row, action: 'clear', why: 'not owed (stored review)' };
        }
        if (!owed) return skip('stored review does not owe a red team');
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

/** Bounded recovery, sharing lane, live-review and host start capacity. Errors never abort the daemon tick.
 * `capacity.remainingStarts` caps starts after ordinary dispatches; `capacity.take()` consumes one shared
 * host start on success or an unknown outcome. Both are optional for standalone callers.
 */
export function runRedTeamOnSkip({ repo, plan, rawPrs, capacity, dispatch, log = () => {}, dryRun = false,
  env = process.env, setting, readEvidence = readDrainRedTeamEvidence, readStatus = readRedTeamStatus,
  readCarry = key => readRedTeamCarry({ ...key, env }),
  readReviews = ({ repo, pr }) => JSON.parse(runGhSync([
    'pr', 'view', String(pr), '--repo', repo, '--json', 'reviews',
  ], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })).reviews,
  exec = execFileSync, cwd = process.cwd(), mainRef = 'origin/main',
  proveMove = move => proveCardOnlyHeadMove({ ...move, exec, cwd, mainRef }),
  readWitness = readEvidence === readDrainRedTeamEvidence && readStatus === readRedTeamStatus ? key => readRecoveryWitness({ ...key, env }) : null,
  abandon = key => abandonStaleRedTeamRun({ ...key, env }),
  now = Date.now, lastDispatch: history = lastDispatch, preferLane, settle = settleRedTeamSkip, syncLabels = syncRedTeamStatusLabels } = {}) {
  const rows = [], dispatched = [], notStarted = [];
  const note = line => { try { log(safeLine(line)); } catch { /* diagnostic only */ } };
  try {
    const at = now();
    const resolved = setting ?? resolveReviewRedTeamOnSkip({ env, log: note }).value;
    const refusals = plan?.refusals ?? [];
    // Reconcile rows omit formal reviews. Read only accepted recovery candidates,
    // once per PR, without mutating the daemon's shared snapshot. Failed/oversized
    // reads stay unknown: the planner requires operator inspection before clearing.
    const planningPrs = (rawPrs ?? []).map(rawPr => {
      const pr = Number(rawPr?.number), head = rawPr?.headRefOid;
      if (!resolved.enabled || Array.isArray(rawPr?.reviews) || !isRealHead(head)
        || !refusals.some(r => r?.kind === 'already-reviewed-head' && Number(r.prNumber) === pr
          && (r.headSha == null || r.headSha === head))
        || !Array.isArray(rawPr.comments) || redTeamForHead(rawPr.comments, pr, head)
        || !Array.isArray(rawPr.labels) || !rawPr.labels.some(label =>
          (typeof label === 'string' ? label : label?.name) === 'review:accepted')) return rawPr;
      let reviews;
      try {
        const result = readReviews({ repo, pr });
        if (Array.isArray(result)) reviews = result;
      } catch { /* Unknown reviews must keep policy-clear closed. */ }
      return { ...rawPr, reviews };
    });
    rows.push(...planRedTeamOnSkip({ repo, refusals, rawPrs: planningPrs, readEvidence, readStatus,
      now: at, setting: resolved, lastDispatch: history, proveMove, readCarry, readWitness,
      recoveryOptions: { now: at, probe: recoveryProbe(), deadlineMs: staleRunDeadlineMs(env) } }));
    for (const row of rows) {
      let started = false;
      if (row.action === 'carry') {
        if (dryRun) row.why = 'dry run (carry)';
        else {
          try {
            const body = `${redTeamMarker(row.prNumber, row.head)}\nRed team not required on this head: prior policy-clear carried from ${row.from.slice(0, 8)} across a content-preserving rebase (acceptance re-stamped)`;
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
            const rawPr = rawPrs.find(p => Number(p?.number) === row.prNumber);
            const result = settle({ redTeam: { status: 'not-owed' }, repo, pr: row.prNumber,
              head: row.head, readHead: row.head, accepted: true, storedReviewPolicyClear: true, comments: rawPr.comments, reason: row.why,
              io: { env, log: note,
                postComment: ({ repo, pr, body }) => runGhSync([
                  'pr', 'comment', String(pr), `--repo=${repo}`, '--body-file', '-',
                ], { input: body, env, timeout: 60_000, maxBuffer: 1024 * 1024 }),
                publishNeedsYou: publishAttention,
              } });
            if (['policy-clear', 'already'].includes(result?.outcome)) {
              syncLabels({ repo, pr: row.prNumber, head: row.head, env, log: note });
            } else {
              row.action = 'skip';
              row.why = `clear failed: ${result?.reason ?? result?.outcome ?? 'unknown outcome'}`;
            }
          } catch (error) {
            row.action = 'skip';
            row.why = `clear failed: ${safeErrorText(error)}`;
          }
        }
      }
      if (row.action === 'dispatch' || row.action === 'review') {
        const budget = capacity?.budget;
        if (!(capacity?.lanes > 0) || (budget && !(budget.left > 0))
          || (capacity.remainingStarts != null && !(capacity.remainingStarts > 0))) row.why = 'no review capacity left';
        else if (dryRun) row.why = `dry run (${row.mode ?? row.action})`;
        else {
          const reserved = budget && Number.isFinite(budget.left);
          if (reserved) budget.left--;
          try {
            if (row.staleRecovery && !abandon({ repo, pr: row.prNumber, head: row.head }).ok) throw Error('stale abandonment refused');
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
          } catch {
            // A throw may follow a spawn: retain its reservation until the next live process read.
            capacity.lanes--;
            if (capacity.remainingStarts != null) capacity.remainingStarts--;
            capacity.take?.();
            row.why = 'dispatch failed; start unknown';
          }
        }
        if (!started) { row.action = 'skip'; notStarted.push({ prNumber: row.prNumber, reason: row.why }); }
      }
      if (started && row.action === 'review') {
        note(`review-daemon: ${repo}#${row.prNumber} already-reviewed-head — fresh review dispatched for unprovable head move ${String(row.head).slice(0, 12)}`);
      } else note(`review-daemon: ${repo}#${row.prNumber} already-reviewed-head — red team ${started ? `dispatched (${row.mode})` : ['clear', 'carry'].includes(row.action) && !dryRun ? 'cleared' : 'not dispatched'} for head ${String(row.head ?? 'unknown').slice(0, 12)}: ${row.why}`);
    }
  } catch {
    rows.push({ prNumber: null, head: null, action: 'skip', why: 'red-team recovery inputs unreadable' });
    note(`review-daemon: ${repo}#? already-reviewed-head — red team not dispatched for head unknown: red-team recovery inputs unreadable`);
  }
  return { rows, dispatched, notStarted };
}
