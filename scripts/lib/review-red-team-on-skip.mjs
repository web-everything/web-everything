/** Recover an owed red-team result on an already-reviewed head through the existing review job. */
import { execFileSync } from 'node:child_process';
import { proveCardOnlyHeadMove } from './card-only-head-move.mjs';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir } from '../operations/run-store.mjs';
import { daemonEventsPath } from './daemon-events.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDrainRedTeamEvidence, readRedTeamStatus, redTeamStatusDir } from './drain-red-team-evidence.mjs';
import { redTeamForHead, redTeamMarker, parseRedTeamComment } from './red-team-gate.mjs';
import { redTeamOwedFor, redTeamCardOnly } from './review-red-team-policy.mjs';
import { readRedTeamCarry } from './red-team-carry-machine.mjs';
import { isRealHead, safeErrorText, settleRedTeamSkip } from './red-team-skip-outcome.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { publishAttention } from '../operations/needs-you-feed.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { failedRedTeamRetry, redTeamStatusWithoutRun } from './red-team-run-result.mjs';

import { redTeamRequired } from './jury-core.mjs';
import { isLaterVerdictBody, latestAcceptRecord, laterReviewHold } from './accept-carry-forward.mjs';
import { restampRecord, strandedNumberingRecords } from './numbering-carry.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';
import { RED_TEAM_STATUS_LABELS } from './red-team-status-label-meta.mjs';

export const STALE_RUN_DEADLINE_MS = 2 * 60 * 60 * 1000;

export function staleRunDeadlineMs(env = process.env) {
  const value = env.WE_RED_TEAM_STALE_RUN_MS;
  return /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value))
    ? Number(value) : STALE_RUN_DEADLINE_MS;
}

/** A matching live local owner always wins over the age deadline. Unknown age stays closed. */
export function staleRedTeamRun({ status, now = Date.now(), deadlineMs = STALE_RUN_DEADLINE_MS,
  probe = {} } = {}) {
  const answer = (stale, reason) => ({ stale, reason });
  if (status?.status !== 'running' || status.result != null) return answer(false, 'no incomplete running pass');
  const { host = hostname(), namespace = pidNamespace(), isAlive = pidAlive, readPidStart = pidStartTime } = probe;
  try {
    if (status.host === host && status.pidNamespace === namespace && Number.isInteger(status.pid) && status.pid > 0) {
      const alive = isAlive(status.pid);
      if (alive === false) return answer(true, 'running red team owner is dead');
      if (alive === true) {
        const start = status.pidStart == null ? null : readPidStart(status.pid);
        if (status.pidStart == null || start === status.pidStart) return answer(false, 'running red team owner is live');
        if (start != null) return answer(true, 'running red team owner pid was reused');
        return answer(false, 'running red team owner identity unreadable');
      }
    }
  } catch { return answer(false, 'running red team owner probe unreadable'); }
  const at = Date.parse(status.pidStart);
  return Number.isFinite(at) && Number.isFinite(deadlineMs) && deadlineMs >= 0 && now - at > deadlineMs
    ? answer(true, 'unprobeable running red team owner exceeded deadline')
    : answer(false, 'unprobeable running red team owner within deadline or age unknown');
}

const staleStatusPath = ({ repo, pr, head, env = process.env }) =>
  join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

export function staleRedTeamSpent(key) {
  try { statSync(`${staleStatusPath(key)}.stale-redispatch-1`); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The exclusive-create marker spends recovery; the re-read is a best-effort recheck, not an atomic lock.
 * Only a confirmed non-start may release the recovery spend.
 */
export function abandonStaleRedTeamRun({ repo, pr, head, status, env = process.env, now = Date.now(), probe = {} }) {
  const path = staleStatusPath({ repo, pr, head, env }), marker = `${path}.stale-redispatch-1`;
  let claimed = false;
  const release = () => { try { unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  try {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current.repo !== repo || Number(current.pr) !== Number(pr) || current.head !== head
      || current.status !== 'running' || current.result != null
      || current.pid !== status?.pid || current.pidStart !== status?.pidStart
      || current.host !== status?.host || current.pidNamespace !== status?.pidNamespace) return { ok: false };
    if (staleRedTeamRun({ status: current, now, probe }).stale !== true) return { ok: false };
    closeSync(openSync(marker, 'wx')); claimed = true;
    const reason = 'running red team owner is dead or exceeded stale deadline';
    const at = new Date(now).toISOString();
    writeJsonAtomic(path, { ...current, staleAbandoned: { at, pid: status.pid, reason } });
    const events = daemonEventsPath({ env });
    mkdirSync(dirname(events), { recursive: true });
    appendFileSync(events, `${JSON.stringify({ at, kind: 'red-team-stale-run-abandoned', repo, pr,
      daemon: 'review', detail: { head, pid: status.pid, reason } })}\n`);
    return { ok: true, release };
  } catch { if (claimed) { try { release(); } catch { /* keep closed */ } } return { ok: false }; }
}

/** Runs are updated in place: the newest matching review by file mtime decides whether recovery is owed. */
export function recoverStaleRunPayload({ repo, pr, head, env = process.env,
  runsDir = env.OPERATION_RUNS_DIR || env.WE_SHARED_RUNS_DIR || resolveRunsDir(), list = listRunIds, read = readRun }) {
  try {
    let newest = null, newestAt = -Infinity;
    for (const id of list(runsDir)) {
      if (!id.startsWith('review-pr-')) continue;
      const run = read(id, runsDir);
      if (run?.op !== 'review-pr' || run.input?.repo !== repo || Number(run.input?.pr) !== Number(pr)
        || run.findings?.read?.netBasis?.rev !== head) continue;
      const at = statSync(join(runsDir, `${id}.json`)).mtimeMs;
      if (at > newestAt) { newest = run; newestAt = at; }
    }
    return newest?.carriedFrom == null && redTeamOwedFor(newest) ? newest : null;
  } catch { return null; }
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
  setting, lastDispatch, proveMove = () => ({ ok: false }), readCarry = () => null, probe, staleSpent = staleRedTeamSpent,
  deadlineMs = STALE_RUN_DEADLINE_MS }) {
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
      const evidence = readEvidence({ repo, pr, head });
      if (evidence?.carryConflict) return skip('later review supersedes the carry');
      const unfinishedCarry = evidence?.carry && evidence.carry.step !== 'done';
      if (redTeamForHead(rawPr.comments, pr, head) && !unfinishedCarry) return skip('red-team result already on head');
      const accepted = Array.isArray(rawPr.labels) && rawPr.labels.some(label => (typeof label === 'string' ? label : label?.name) === 'review:accepted');
      if (evidence?.queued || (evidence?.inFlight && (!accepted
        || !staleRedTeamRun({ status: readStatus({ repo, pr, head }), now, probe, deadlineMs }).stale))) return skip('red-team pass in flight');
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
      const stale = staleRedTeamRun({ status, now, probe, deadlineMs }).stale;
      const staleOwed = stale && accepted && status?.head === head
        && evidence?.loopPayload?.findings?.read?.netBasis?.rev === head;
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
      if (!staleOwed && !movedCardOnly && !pendingCardOnly && (!owed || accepted)) {
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
      if ((!staleOwed && evidence.inFlight) || evidence.queued) return skip('red-team pass in flight');
      if (staleOwed) {
        if (status?.retryCount >= 1) return skip('red-team retry already spent; inspect stored evidence');
        if (staleSpent({ repo, pr, head })) {
          // Admission replaces the abandoned row with queued before a run starts.
          // An unchanged abandoned row means the prior job never launched a call.
          if (redTeamStatusWithoutRun(status)) return dispatchDecision({ action: 'dispatch', mode: 'fresh', abandonStale: false,
            why: 'abandoned stale run never restarted; re-dispatch without re-abandoning' });
          return skip('stale red team already re-dispatched; inspect review run');
        }
        return dispatchDecision({ action: 'dispatch', mode: 'fresh', abandonStale: true,
          why: 'running red team owner is dead; abandon and re-dispatch' });
      }
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
  env = process.env, setting, probe,
  staleSpent = key => staleRedTeamSpent({ ...key, env }),
  recoverPayload = recoverStaleRunPayload, abandonStale = abandonStaleRedTeamRun,
  readEvidence = readDrainRedTeamEvidence, readStatus = readRedTeamStatus,
  readCarry = key => readRedTeamCarry({ ...key, env }),
  readReviews = ({ repo, pr }) => JSON.parse(runGhSync([
    'pr', 'view', String(pr), '--repo', repo, '--json', 'reviews',
  ], { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })).reviews,
  exec = execFileSync, cwd = process.cwd(), mainRef = 'origin/main',
  proveMove = move => proveCardOnlyHeadMove({ ...move, exec, cwd, mainRef }),
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
      now: at, setting: resolved, lastDispatch: history, proveMove, readCarry, probe, staleSpent,
      deadlineMs: staleRunDeadlineMs(env) }));
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
          let abandonment;
          if (row.abandonStale) {
            try {
              if (!recoverPayload({ repo, pr: row.prNumber, head: row.head, env })) {
                row.why = 'accepting review run unavailable; inspect stored evidence';
              } else {
                abandonment = abandonStale({ repo, pr: row.prNumber, head: row.head,
                  status: readStatus({ repo, pr: row.prNumber, head: row.head }), env, now: at, probe });
                if (abandonment?.ok !== true) row.why = 'stale red team abandonment refused; inspect review run';
              }
            } catch { row.why = 'stale review run recovery unreadable; inspect stored evidence'; }
            if (abandonment?.ok !== true) {
              row.action = 'skip';
              notStarted.push({ prNumber: row.prNumber, reason: row.why });
              note(`review-daemon: ${repo}#${row.prNumber}: ${row.why}`);
              continue;
            }
          }
          const reserved = budget && Number.isFinite(budget.left);
          if (reserved) budget.left--;
          try {
            const result = dispatch({ pr: row.prNumber, repo,
              ...(row.action === 'dispatch' ? { redTeamOnly: true, redTeamMode: row.mode } : {}),
              ...(preferLane != null ? { preferLane } : {}) });
            if (result?.skipped || !Number.isInteger(result?.jobPid)) {
              const refundable = result?.skipped !== 'live-job'
                || (budget?.countedJobPids instanceof Set && budget.countedJobPids.has(result.jobPid));
              if (reserved && refundable) budget.left++;
              row.why = result?.skipped ?? 'job did not start';
              abandonment?.release?.();
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
