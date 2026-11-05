/** Recover an owed red-team result on an already-reviewed head through the existing review job. */
import { execFileSync } from 'node:child_process';
import { proveCardOnlyHeadMove } from './card-only-head-move.mjs';
import { readFileSync, statSync } from 'node:fs';
import { isRunRecordTerminal, listRunIds, readRun, sharedRunsDir } from '../operations/run-store.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { isUnderTest } from './under-test.mjs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDrainRedTeamEvidence, readRedTeamStatus, readRecoveryWitness, redTeamStatusDir, withRedTeamStatusClaim, RUN_MTIME_SLACK_MS, ABANDONED_REVIEW_AFTER_MS } from './drain-red-team-evidence.mjs';
import { redTeamForHead, redTeamMarker, parseRedTeamComment, breakClass } from './red-team-gate.mjs';
import { redTeamOwedFor, redTeamCardOnly } from './review-red-team-policy.mjs';
import { readRedTeamCarry } from './red-team-carry-machine.mjs';
import { isRealHead, safeErrorText, settleRedTeamSkip } from './red-team-skip-outcome.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { failedRedTeamRetry, redTeamStatusWithoutRun, completedRedTeamSeat } from './red-team-run-result.mjs';

import { redTeamRequired, VERDICTS } from './jury-core.mjs';
import { isLaterVerdictBody, latestAcceptRecord, laterReviewHold } from './accept-carry-forward.mjs';
import { restampRecord, strandedNumberingRecords } from './numbering-carry.mjs';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { RED_TEAM_STATUS_LABELS } from './red-team-status-label-meta.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';

export const staleRunDeadlineMs = (env = process.env) => /^\d+$/.test(env.WE_RED_TEAM_STALE_RUN_MS ?? '')
  && Number.isSafeInteger(Number(env.WE_RED_TEAM_STALE_RUN_MS)) ? Number(env.WE_RED_TEAM_STALE_RUN_MS) : 7_200_000;

const pendingAbandonment = w => w.markers.redispatch?.priorWriter === w.rawWriter.sha256
  && w.markers.redispatch?.evidence === w.evidenceSha256
  && typeof w.markers.redispatch?.abandonedAt === 'string';

/** Pure decision on a raw witness. Probes and time are supplied by the caller. */
export function planRedTeamRecovery(w, { now, probe, deadlineMs } = {}) {
  if (w?.ok === false) return { mode: 'skip', why: w.reason };
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
function conflictsWithPolicyClear(label, { settlesPending = false } = {}) {
  const name = typeof label === 'string' ? label : label?.name;
  // A finished not-owed result settles the stale pending status; blocked and review holds still refuse (D-R338).
  if (settlesPending && name === 'red-team:pending') return false;
  return typeof name === 'string' && (
    (name.startsWith('review:') && name !== 'review:accepted')
    || name.startsWith('review-status:')
    || (RED_TEAM_STATUS_LABELS.includes(name) && name !== 'red-team:clear')
  );
}

/** Live holds supersede both carried and stored policy-clears. PURE.
 * Without an acceptance record nothing is "later", so any explicit hold comment stands (any author: fail closed).
 */
function publishableClearGuard({ labels, acceptance, comments, reviews, settlesPending = false }) {
  if (acceptance?.laterVerdict || acceptance?.laterBodyDerivedHold) {
    return 'later verdict or hold supersedes acceptance';
  }
  if (!acceptance && (!Array.isArray(comments) || comments.some(c => isLaterVerdictBody(c?.body)))) {
    return 'explicit review hold comment prevents full review; inspect the PR thread';
  }
  if (acceptance?.reviewsUnreadable) return 'PR reviews unreadable; inspect formal reviews before policy-clear';
  if (!Array.isArray(labels)) return 'PR labels unreadable';
  if (labels.some(label => conflictsWithPolicyClear(label, { settlesPending }))) {
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

const settledReviewEffects = run => Array.isArray(run?.effects)
  && run.effects.every(effect => ['applied', 'failed'].includes(effect?.status));
const terminalReviewRun = run => settledReviewEffects(run) && isRunRecordTerminal(run);

/** Complete bounded proof; unknown state never establishes a never-reviewed head. */
export function headNeverReviewedFromRuns({ repo, pr, head, env = process.env,
  runsDir = runsDirectory(env), list = strictListRuns, read = readRun, stat = statSync } = {}) {
  try {
    if (!isRealHead(head)) return false;
    for (const { run } of reviewRuns({ runsDir, list, read, stat })) {
      if (run.op !== 'review-pr' || run.input?.repo !== repo || Number(run.input?.pr) !== Number(pr)) continue;
      const rev = run.findings?.read?.netBasis?.rev;
      if (!isRealHead(rev) || rev === head) return false;
      const activeEffects = !settledReviewEffects(run);
      const unfinished = !run.verdict || run.pending != null || activeEffects;
      if (unfinished) return false;
    }
    return true;
  } catch { return false; }
}

/** The same chronology predicate is required at scan time and every evidence re-read. */
function ignorableConfirm(run, at, acceptedAt) {
  const start = Date.parse(run.stepTimings?.find(t => t?.step === 'read')?.startedAt);
  const resumed = Date.parse(run.resumedAt);
  return Number.isFinite(acceptedAt) && !terminalReviewRun(run)
    && run.verdict?.verdict === 'needs-human' && run.pending?.kind === 'confirm'
    && settledReviewEffects(run)
    && Number.isFinite(start) && start + RUN_MTIME_SLACK_MS < acceptedAt
    && Number.isFinite(at) && at + RUN_MTIME_SLACK_MS < acceptedAt
    && (run.resumeOf == null && run.resumedAt == null
      || Number.isFinite(resumed) && resumed + RUN_MTIME_SLACK_MS < acceptedAt);
}

/** Revalidate ignored cursors at list time; changed or unreadable rows stay visible to evidence readers. */
export function revalidatedConfirmList({ repo, pr, head, ignoreRunIds = [], acceptedAt,
  list = strictListRuns, read = readRun, stat = statSync } = {}) {
  return runsDir => list(runsDir).filter(id => {
    if (!isRealHead(head) || !Array.isArray(ignoreRunIds) || !ignoreRunIds.includes(id)
      || !Number.isFinite(acceptedAt)) return true;
    try {
      const [entry] = reviewRuns({ runsDir, list: () => [id], read, stat });
      return !entry || entry.run.op !== 'review-pr' || entry.run.input.repo !== repo
        || Number(entry.run.input.pr) !== Number(pr) || !ignorableConfirm(entry.run, entry.at, acceptedAt);
    } catch { return true; }
  });
}

/** Ignore old confirm cursors only after a later, live acceptance supersedes them. */
export function ignorableConfirmRunIds({ repo, pr, head, comments, labels, reviews, env = process.env,
  runsDir = runsDirectory(env), list = strictListRuns, read = readRun, stat = statSync, now = Date.now() } = {}) {
  const closed = { ok: false, ids: [] };
  try {
    if (!isRealHead(head) || !Array.isArray(comments) || !Array.isArray(reviews)
      || !Array.isArray(labels) || !labels.some(l => (typeof l === 'string' ? l : l?.name) === 'review:accepted')) return closed;
    const acceptance = latestAcceptRecord(comments, reviews);
    const acceptedAt = Date.parse(acceptance?.at);
    // The marker alone is not an acceptance: the comment must read as an accepting verdict, never a hold.
    const acceptBody = comments[acceptance?.index]?.body ?? '';
    if (!/^\s*✅/.test(acceptBody) || isLaterVerdictBody(acceptBody)) return closed;
    // A re-stamp carries an earlier acceptance forward: its timestamp is not the original acceptance time.
    if (/^\s*📌 review — acceptance re-stamped/.test(comments[acceptance?.index]?.body ?? '')) return closed;
    if (acceptance?.sha !== head || !Number.isFinite(acceptedAt)
      || publishableClearGuard({ labels, acceptance, comments, reviews, settlesPending: true })) return closed;
    const ids = [];
    for (const { id, run, at } of reviewRuns({ runsDir, list, read, stat })) {
      if (run.op !== 'review-pr' || run.input?.repo !== repo || Number(run.input?.pr) !== Number(pr)) continue;
      const terminal = terminalReviewRun(run);
      if (terminal && (run.verdict || (run.resumeOf == null && now - at >= ABANDONED_REVIEW_AFTER_MS))) continue;
      if (!ignorableConfirm(run, at, acceptedAt)) return closed;
      ids.push(id);
    }
    return { ok: true, ids, acceptedAt };
  } catch { return closed; }
}

/** Retry unfinished evidence only through freshly validated confirm exclusions. */
function readWithConfirmExclusions(reader, { repo, pr, head, rawPr, readIgnorableConfirms, headNeverReviewed }) {
  const key = { repo, pr, head };
  const first = reader(key);
  if (first?.ok !== false || first.reason !== 'review-unfinished') return first;
  let confirms;
  try { confirms = readIgnorableConfirms?.({ ...key, rawPr }); }
  catch { return first; }
  const ids = Array.isArray(confirms) ? confirms : confirms?.ok ? confirms.ids : [];
  if (Array.isArray(ids) && ids.length) return reader({ ...key, ignoreRunIds: ids,
    ...(Number.isFinite(confirms.acceptedAt) ? { acceptedAt: confirms.acceptedAt } : {}) });
  try {
    if (headNeverReviewed?.({ ...key, rawPr }) === true) return { ...first, neverReviewed: true };
  } catch { /* Unknown scan retains review-unfinished. */ }
  return first;
}

/** PURE: readers are injected; each refusal produces one decision, including unreadable evidence. */
export function planRedTeamOnSkip({ repo, refusals = [], rawPrs, readEvidence, readStatus, now,
  setting, lastDispatch, proveMove = () => ({ ok: false }), readCarry = () => null, readWitness, recoveryOptions, readIgnorableConfirms, headNeverReviewed }) {
  return refusals.filter(r => r?.kind === 'already-reviewed-head').map(refusal => {
    const pr = Number(refusal.prNumber);
    const rawPr = (rawPrs ?? []).find(p => Number(p?.number) === pr);
    const head = rawPr?.headRefOid ?? null;
    const row = { prNumber: pr, head, action: 'skip' };
    const skip = why => ({ ...row, why });
    const guardedSkip = why => ({ ...skip(why),
      ...(why === 'conflicting label prevents policy-clear' ? { escalate: true } : {}) });
    const dispatchDecision = decision => {
      const last = lastDispatch.get(`${repo}#${pr}@${head}`);
      if (last != null && now - last < setting.retryCooldownMin * 60_000) return skip('retry cooldown active');
      return { ...row, ...decision };
    };
    const failedRead = result => ({ ...skip(result.reason),
      ...(result.reason === 'review-unfinished' ? { escalate: true,
        ...(result.neverReviewed ? { escalationContext: 'head has no recorded review; inspect unfinished review evidence' } : {}) } : {}) });
    const readWithConfirms = reader => readWithConfirmExclusions(reader,
      { repo, pr, head, rawPr, readIgnorableConfirms, headNeverReviewed });
    try {
      if (!setting.enabled) return skip('reviewRedTeamOnSkip.enabled=false');
      if (!isRealHead(head) || (refusal.headSha != null && refusal.headSha !== head)) return skip('live head missing or changed');
      // Unknown comments cannot establish that no result was published.
      if (!Array.isArray(rawPr.comments)) return skip('PR comments unreadable');
      const journal = readCarry({ repo, pr, head });
      if (redTeamForHead(rawPr.comments, pr, head) && (!journal || journal.step === 'done')) return { ...skip('red-team result already on head'), settle: 'result' };
      if (readWitness) {
        const w = readWithConfirms(readWitness);
        if (w?.ok === false) return failedRead(w);
        if (['queued', 'running'].includes(w.rawWriter.parsed?.status) || w.rawWriter.parsed?.staleAbandoned) {
          const recovery = planRedTeamRecovery(w, recoveryOptions);
          return recovery.mode === 'skip' ? skip(recovery.why)
            : dispatchDecision({ action: 'dispatch', mode: recovery.mode, staleRecovery: true, why: 'dead owner recovery' });
        }
      }
      const evidence = readWithConfirms(readEvidence);
      if (evidence?.ok === false) return failedRead(evidence);
      if (evidence?.carryConflict) return skip('later review supersedes the carry');
      const unfinishedCarry = evidence?.carry && evidence.carry.step !== 'done';
      if (redTeamForHead(rawPr.comments, pr, head) && !unfinishedCarry) return { ...skip('red-team result already on head'), settle: 'result' };
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
      const acceptedReview = verdict === VERDICTS.ACCEPT && accepted && acceptance?.sha === head
        && !acceptance.laterVerdict && !acceptance.laterBodyDerivedHold;
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
      if (needsReview) {
        const context = { labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews };
        const refusal = publishableClearGuard(context);
        if (refusal) return guardedSkip(refusal);
        // Formal holds apply even without an acceptance comment. No timestamp
        // floor: a missing acceptance cannot establish that a review was cleared.
        if (reviews === null) return skip('PR reviews unreadable; inspect formal reviews before full review');
        if (laterReviewHold(reviews)) return skip('formal review hold prevents full review; inspect formal reviews');
        return dispatchDecision({ action: 'review', why: 'unprovable head move needs a full review' });
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
            || [evidence.status, status].every(candidate => candidate?.status === 'finished'
              && normalizeRedTeamResult(candidate.result).priorResult === 'not-owed'))
          && evidence.recorded !== true && evidence.seatRecorded !== true) {
          if (acceptance?.sha !== head) return notOwed();
          const context = { labels: rawPr.labels, acceptance, comments: rawPr.comments, reviews, settlesPending: true };
          const refusal = publishableClearGuard(context);
          if (refusal) return { ...guardedSkip(refusal), ...provenanceEscalation };
          if (keepsPending && !acceptedReview) return notOwed();
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

/** 'clean' only for a known template with an explicit completed outcome; 'broken' for a parsed confirmed break. */
function strictBodyKind(body, pr, head) {
  const parsed = parseRedTeamComment(body);
  if (!parsed) return false;
  // Every finding-shaped line must have been parsed: an indented or oddly tagged one is silently skipped downstream.
  const findingShaped = body.split(/\r?\n/).filter(line => /^\s*(?:\d+[.)]|[-*•])\s*\[/.test(line)).length;
  if (findingShaped !== parsed.findings.length) return false;
  if (parsed.findings.some(finding => breakClass(finding) === 'broken')) return 'broken';
  if (parsed.findings.length !== 0) return false;
  const advisory = "Advisory only: this comment changes no label itself; the red-team gate (setting `redTeam.confirmedBreaks`) sends a confirmed broken break back to the fixer. Head `"
    + String(head).slice(0, 12) + '` · red team ';
  const lines = body.split(/\r?\n/).filter(line => line.trim());
  // An explicit completed outcome is required: a bare marker (or marker plus advisory) proves no pass.
  const outcome = line => line === 'The red team tried to break this change and reported nothing.'
    || /^Red team not required on this head: [^\r\n]+$/.test(line) || /^Findings: none\.?$/i.test(line);
  if (!lines.some(outcome)) return false;
  return lines.every(line =>
    line === redTeamMarker(pr, head)
    || line === '### Post-accept red team — no break found'
    || line === 'The red team tried to break this change and reported nothing.'
    || /^Red team not required on this head: [^\r\n]+$/.test(line)
    || /^Findings: none\.?$/i.test(line)
    || line.startsWith(advisory) && /^[^\s`/]+\/[^\s`]+ · recorded verdict `(accept|changes|needs-human|prevention-outstanding)`\.$/.test(line.slice(advisory.length))) ? 'clean' : false;
}

/** Only known clean templates can clear; parsed confirmed breaks retain the send-back path. */
function resultMaySynchronize(comments, pr, head) {
  // Every comment carrying this head's marker must itself be strictly understood: the downstream parser can consume a
  // malformed or carried comment that redTeamForHead does not accept, and would silently skip its findings.
  // Match like the downstream parser does: case-insensitive and whitespace-tolerant.
  const markerPattern = new RegExp(`we:red-team-advisory\\s+pr\\s*=\\s*${Number(pr)}\\s+rev\\s*=\\s*${String(head)}`, 'i');
  const marked = comments.filter(c => typeof c?.body === 'string' && markerPattern.test(c.body));
  if (marked.some(c => !strictBodyKind(c.body, pr, head))) return false;
  return comments.some(c => redTeamForHead([c], pr, head));
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
  exec = execFileSync, cwd = process.cwd(), mainRef = 'origin/main',
  proveMove = move => proveCardOnlyHeadMove({ ...move, exec, cwd, mainRef }),
  listReviewRuns = strictListRuns, readReviewRun = readRun, statReviewRun = statSync,
  readWitness = readEvidence === readDrainRedTeamEvidence && readStatus === readRedTeamStatus ? ({ ignoreRunIds = [], acceptedAt, ...key }) => readRecoveryWitness({ ...key, env,
    runsDir: runsDirectory(env), list: revalidatedConfirmList({ ...key, ignoreRunIds, acceptedAt, list: listReviewRuns, read: readReviewRun, stat: statReviewRun }) }) : null,
  readIgnorableConfirms = ({ rawPr, ...key }) => {
    const result = ignorableConfirmRunIds({ ...key, env, list: listReviewRuns, read: readReviewRun, stat: statReviewRun, comments: rawPr.comments, labels: rawPr.labels, reviews: rawPr.reviews });
    return result;
  },
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
  now = Date.now, lastDispatch: history = lastDispatch, preferLane, settle = settleRedTeamSkip, syncLabels = syncRedTeamStatusLabels } = {}) {
  const rows = [], dispatched = [], notStarted = [];
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
          ['review:accepted', 'red-team:pending'].includes(typeof label === 'string' ? label : label?.name))) return rawPr;
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
      readEvidence: readEvidence === readDrainRedTeamEvidence ? ({ ignoreRunIds = [], acceptedAt, ...key }) => readEvidence({ ...key, env,
        runsDir: runsDirectory(env), list: revalidatedConfirmList({ ...key, ignoreRunIds, acceptedAt, list: listReviewRuns, read: readReviewRun, stat: statReviewRun }) }) : readEvidence,
      readStatus: readStatus === readRedTeamStatus ? key => readStatus({ ...key, env }) : readStatus,
      now: at, setting: resolved, lastDispatch: history, proveMove, readCarry, readWitness,
      readIgnorableConfirms, headNeverReviewed,
      recoveryOptions: { now: at, probe: recoveryProbe(), deadlineMs: staleRunDeadlineMs(env) } };
    rows.push(...planRedTeamOnSkip(planningOptions));
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
      // A trusted red-team result supplies its own blocked/clear disposition. Its finding text
      // is not an independent review hold; all other thread comments still guard settlement.
      const holdComments = row.settle === 'result' ? comments.filter(comment =>
        !redTeamForHead([comment], row.prNumber, row.head) || isLaterVerdictBody(comment.body)) : comments;
      const acceptance = latestAcceptRecord(holdComments, reviews);
      if (laterReviewHold(reviews) || acceptance?.laterVerdict || acceptance?.laterBodyDerivedHold
        || !acceptance && holdComments.some(comment => isLaterVerdictBody(comment.body))) {
        throw Error('evidence changed before settlement');
      }
      const rawPr = { ...live, number: row.prNumber, comments, reviews };
      const refusal = refusals.find(r => r.kind === 'already-reviewed-head' && Number(r.prNumber) === row.prNumber);
      const [fresh] = planRedTeamOnSkip({ ...planningOptions, refusals: refusal ? [refusal] : [],
        rawPrs: [rawPr], now: now() });
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
            if (row.escalationContext) note(`review-daemon: ${repo}#${row.prNumber} ${row.why}: ${row.escalationContext}`);
            const result = escalate({ ...key, why: row.why });
            if (result?.error || result?.outcome === 'error') {
              row.settleError = safeErrorText(result.error ?? result.reason ?? 'unknown error');
            }
          } else if (row.settle === 'result') {
            const rawPr = planningPrs.find(p => Number(p?.number) === row.prNumber);
            if (rawPr?.labels?.some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:pending')) {
              const live = freshSettlement(row);
              const evidence = readWithConfirmExclusions(planningOptions.readEvidence,
                { ...key, rawPr: live, readIgnorableConfirms });
              // Active work outranks a stale result: never lift the hold while a pass is queued, running or unfinished.
              const active = evidence?.inFlight || evidence?.queued || ['queued', 'running'].includes(evidence?.status?.status)
                || (evidence?.carry && evidence.carry.step !== 'done');
              let witness = null;
              if (!active && planningOptions.readWitness) {
                witness = readWithConfirmExclusions(planningOptions.readWitness, { ...key, rawPr: live, readIgnorableConfirms });
              }
              if (active) row.settleError = 'red-team pass still active; label unchanged';
              else if (evidence?.carryConflict || witness?.ok === false) row.settleError = 'conflicting review evidence; label unchanged';
              else if (!resultMaySynchronize(live.comments, row.prNumber, row.head)) row.settleError = 'result comment not strictly clean';
              else {
                const verdict = evidence?.status?.status === 'finished' ? evidence.status.result?.foldedVerdict : null;
                if (!['accept', 'changes'].includes(verdict)) row.settleError = 'no recorded red-team verdict; label unchanged';
                else if (verdict === 'accept' && evidence?.loopPayload?.verdict?.verdict !== 'accept') row.settleError = 'review payload is not an accept; label unchanged';
                else if (verdict === 'accept' && witness && witness.newest?.verdict?.verdict !== 'accept') row.settleError = 'newest same-head review is not an accept; label unchanged';
                else if (verdict === 'accept' && normalizeRedTeamResult(evidence.status.result).priorComment !== 'posted') row.settleError = 'red-team result comment not confirmed posted; label unchanged';
                else {
                  // A withheld changes result must never inherit the clear disposition of an older comment.
                  const labels = verdict === 'changes' ? planRedTeamStatusLabels({ ...key, env, evidence,
                    comments: live.comments, labels: live.labels, standingRuling: null }) : null;
                  const blocked = labels?.add === 'red-team:blocked' || labels?.add == null
                    && live.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'red-team:blocked')
                    && !labels?.remove.includes('red-team:blocked');
                  if (verdict === 'changes' && !blocked) row.settleError = 'recorded red-team changes; label unchanged';
                  else syncLabels({ ...key, env, log: note, evidence, provider, comments: live.comments,
                    ...(verdict === 'changes' ? { standingRuling: null } : {}) });
                }
              }
            }
          }
          else if (row.settle === 'not-owed') {
            const rawPr = planningPrs.find(p => Number(p?.number) === row.prNumber);
            if (Array.isArray(rawPr?.labels) && !rawPr.labels.some(l => (typeof l === 'string' ? l : l?.name) === 'red-team:blocked')) {
              freshSettlement(row);
              settlePending({ ...key, remove: ['red-team:pending'] });
            }
          }
        } catch (error) { row.settleError = safeErrorText(error); }
      }
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
            let rawPr;
            try { rawPr = freshSettlement(row); }
            catch { throw Error('evidence changed before settlement'); }
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
        if (!hasReviewCapacity(capacity)) row.why = 'no review capacity left';
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
