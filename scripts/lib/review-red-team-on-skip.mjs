/** Recover an owed red-team result on an already-reviewed head through the existing review job. */
import { readSavedRedTeamGateResult, sameRepo } from './drain-saved-red-team.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDrainRedTeamEvidence, readRedTeamStatus, readFreshRedTeamAttempts } from './drain-red-team-evidence.mjs';
import { redTeamForHead } from './red-team-gate.mjs';
import { redTeamOwedFor } from './review-red-team-policy.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { verifiedPriorRedTeamRow } from '../operations/review-extra-seats.mjs';
import { cascadePolicy } from './policy-cascade.mjs';

/** Strict snapshot shared by recovery admission; provenance is exactly the child's predicate. */
export function redTeamRecoveryRows(records, { repo, pr, head, env = process.env, readAttempts = readFreshRedTeamAttempts }) {
  if (!Array.isArray(records)) throw Error('invalid scorecard records');
  const attempts = readAttempts({ repo, pr, head, env });
  if (!Array.isArray(attempts)) throw Error('invalid fresh red-team attempts');
  const rows = records.filter(row => row?.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head.toLowerCase());
  return {
    verifiedRow: verifiedPriorRedTeamRow(records, { repo, pr, rev: head, env }),
    freshAttempts: attempts.length,
    recordedRow: rows.length > 0,
    onlyOkRows: rows.length > 0 && rows.every(row => row.status === 'ok'),
    onlyRetryableRows: rows.length > 0 && rows.every(row => ['ok', 'error'].includes(row.status)),
  };
}

/** Recovery is narrower than a general re-run: legacy errors/statuses remain held. A skipped
 * resume with unattested clean rows launched no call; an already admitted bounded recovery may
 * retry its failed publication. Neither case can mint resume provenance or bypass the fresh cap. */
export function freshRedTeamRecoveryAllowed({ status, recovery, recorded }) {
  if (recovery.verifiedRow) return false;
  if (status == null && recorded !== true && recovery.recordedRow !== true
    && (recovery.recordedRow === false || recorded === false)) return true;
  const { priorResult, priorComment } = normalizeRedTeamResult(status?.result);
  if (recovery.onlyOkRows && status?.status === 'finished' && priorResult === 'skipped'
    && status.result?.reason === 'resume-only: no clean prior red-team row — no call launched') return true;
  return recovery.freshAttempts > 0 && recovery.onlyRetryableRows === true
    && (status == null || (status.status === 'finished' && ['ran', 'resumed'].includes(priorResult) && priorComment === 'error'));
}
export function readRedTeamRecoveryRows({ env = process.env, ...input }) {
  return redTeamRecoveryRows(readStore({ path: resolveScorecardStorePath(env), strict: true }).records, { ...input, env });
}

/** Normalize both persisted production result shapes at the recovery boundary. */
export function normalizeRedTeamResult(result) {
  return {
    priorResult: typeof result === 'string' ? result : result?.status,
    priorComment: typeof result === 'object' ? (result?.comment?.status ?? result?.comment) : undefined,
  };
}

export function resolveReviewRedTeamOnSkip({ env = process.env, log, readFile = readFileSync,
  toolPath = join(dirname(fileURLToPath(import.meta.url)), '../settings/review-red-team-on-skip.json') } = {}) {
  let tool;
  try { const data = JSON.parse(readFile(toolPath, 'utf8')); tool = { enabled: data.enabled, retryCooldownMin: data.retryCooldownMin, maxFreshPerHead: data.maxFreshPerHead }; } catch { /* lower layers */ }
  const raw = env.WE_REVIEW_RED_TEAM_ON_SKIP;
  const cooldown = env.WE_REVIEW_RED_TEAM_ON_SKIP_RETRY_COOLDOWN_MIN;
  const maxFresh = env.WE_REVIEW_RED_TEAM_ON_SKIP_MAX_FRESH_PER_HEAD;
  return cascadePolicy('reviewRedTeamOnSkip', tool, {
    env, log, standard: { enabled: true, retryCooldownMin: 30, maxFreshPerHead: 2 },
    envValues: { enabled: raw === '0' ? false : raw === '1' ? true : raw || undefined,
      retryCooldownMin: typeof cooldown === 'string' && /^\d+$/.test(cooldown) ? Number(cooldown) : cooldown || undefined,
      maxFreshPerHead: typeof maxFresh === 'string' && /^\d+$/.test(maxFresh) ? Number(maxFresh) : maxFresh || undefined },
    valid: { maxFreshPerHead: v => Number.isSafeInteger(v) && v >= 0, enabled: v => typeof v === 'boolean', retryCooldownMin: v => Number.isSafeInteger(v) && v >= 0 },
  });
}

/** PURE: readers are injected; each refusal produces one decision, including unreadable evidence. */
export function planRedTeamOnSkip({ repo, refusals = [], rawPrs, readEvidence, readStatus, readRecoveryRows, readSavedResult = readSavedRedTeamGateResult, now,
  setting = { enabled: true, maxFreshPerHead: 2, retryCooldownMin: 30 }, lastDispatch = new Map() }) {
  return refusals.filter(r => r?.kind === 'already-reviewed-head').map(refusal => {
    const pr = Number(refusal.prNumber);
    const rawPr = (rawPrs ?? []).find(p => Number(p?.number) === pr);
    const head = rawPr?.headRefOid ?? null;
    const row = { prNumber: pr, head, action: 'skip' };
    const skip = why => ({ ...row, why });
    try {
      if (!setting.enabled) return skip('reviewRedTeamOnSkip.enabled=false');
      if (!/^[a-f0-9]{40}$/i.test(head ?? '') || (refusal.headSha != null && refusal.headSha !== head)) return skip('live head missing or changed');
      // Unknown comments cannot establish that no result was published.
      if (!Array.isArray(rawPr.comments)) return skip('PR comments unreadable');
      if (redTeamForHead(rawPr.comments, pr, head)) return skip('red-team result already on head');
      const evidence = readEvidence({ repo, pr, head });
      if (!redTeamOwedFor(evidence?.loopPayload)) return skip('stored review does not owe a red team');
      if (evidence.loopPayload?.findings?.read?.netBasis?.rev !== head) return skip('stored review does not match live head');
      if (evidence.inFlight || evidence.queued) return skip('red-team pass in flight');
      const status = readStatus({ repo, pr, head });
      const { priorResult, priorComment: comment } = normalizeRedTeamResult(status?.result);
      if (status?.status === 'finished' && priorResult === 'ran' && comment === 'withheld') {
        const saved = readSavedResult({ repo, pr, head });
        if (!saved || saved.pr !== pr || saved.rev !== head)
          return skip('saved result unavailable; inspect stored evidence before retrying');
        return { ...row, action: 'apply-gate', why: 'finished withheld result needs gate application' };
      }
      if (comment === 'posted') return skip('result posted; comment not visible yet');
      const recovery = readRecoveryRows({ repo, pr, head });
      if (!recovery || !Number.isSafeInteger(recovery.freshAttempts) || recovery.freshAttempts < 0) throw Error('invalid recovery evidence');
      let mode;
      // Verified finished passes resume effects; narrowly proven recovery cases use
      // a durable fresh reservation. All other prior rows/statuses retain their hold.
      if (status?.status === 'finished' && ['ran', 'resumed'].includes(priorResult) && evidence.recorded === true && recovery.verifiedRow) {
        mode = 'resume';
      } else if (freshRedTeamRecoveryAllowed({ status, recovery, recorded: evidence.recorded })) mode = 'fresh';
      else if (status?.status === 'finished' && ['ran', 'resumed'].includes(priorResult) && evidence.recorded === true)
        return skip('recorded pass lacks verified provenance; inspect stored evidence before retrying');
      else return skip(`prior result ${typeof priorResult === 'string' ? priorResult : 'unknown'} (status ${status?.status ?? 'missing'}); not re-run`);
      if (mode === 'resume' && !recovery.verifiedRow) return skip('recorded pass lacks verified provenance; inspect stored evidence before retrying');
      if (mode === 'fresh' && recovery.freshAttempts >= (setting.maxFreshPerHead ?? 2)) return skip('fresh attempts exhausted for head');
      const last = Math.max(lastDispatch.get(`${repo}#${pr}@${head}`) ?? -Infinity, status?.updatedAtMs ?? -Infinity);
      if (last != null && now - last < setting.retryCooldownMin * 60_000) return skip('retry cooldown active');
      return { ...row, action: 'dispatch', mode, why: mode === 'resume' ? 'recorded pass needs its result comment/effects' : 'head never had a red-team pass' };
    } catch { return skip('red-team evidence unreadable; inspect stored evidence before retrying'); }
  });
}

const lastDispatch = new Map();
const lastGateApplications = new Map();
const safeLine = value => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600);

/** Bounded recovery, sharing lane, live-review and host start capacity. Errors never abort the daemon tick.
 * `capacity.remainingStarts` caps starts after ordinary dispatches; `capacity.take()` consumes one shared
 * host start on success or an unknown outcome. Both are optional for standalone callers.
 */
export function runRedTeamOnSkip({ repo, plan, rawPrs, capacity, dispatch, log = () => {}, dryRun = false,
  env = process.env, setting, readEvidence = readDrainRedTeamEvidence, readStatus = readRedTeamStatus, readRecoveryRows = readRedTeamRecoveryRows,
  now = Date.now, lastDispatch: history = lastDispatch, preferLane, applyGate, history: gateHistory = lastGateApplications, readSavedResult = readSavedRedTeamGateResult } = {}) {
  const rows = [], dispatched = [], uncertain = [], notStarted = [], applied = [];
  let gateAttempted = false;
  const note = line => { try { log(safeLine(line)); } catch { /* diagnostic only */ } };
  try {
    const at = now();
    const resolved = setting ?? resolveReviewRedTeamOnSkip({ env, log: note }).value;
    rows.push(...planRedTeamOnSkip({ repo, refusals: plan?.refusals, rawPrs, readEvidence: input => readEvidence({ ...input, env }), readStatus: input => readStatus({ ...input, env }),
      readSavedResult: input => readSavedResult({ ...input, env }), readRecoveryRows: input => readRecoveryRows({ ...input, env }), now: at, setting: resolved, lastDispatch: history }));
    const gateKey = row => `${repo}#${row.prNumber}@${row.head}`;
    rows.sort((a, b) => a.action === 'apply-gate' && b.action === 'apply-gate'
      ? (gateHistory.get(gateKey(a)) ?? -Infinity) - (gateHistory.get(gateKey(b)) ?? -Infinity) : 0);
    for (const row of rows) {
      let started = false;
      if (row.action === 'apply-gate') {
        if (at - (gateHistory.get(gateKey(row)) ?? -Infinity) < resolved.retryCooldownMin * 60_000) row.why = 'retry cooldown active';
        else if (gateAttempted) row.why = 'gate application limit reached; retry next tick';
        else if (dryRun) row.why = 'dry run (saved gate application)';
        else {
          gateAttempted = true;
          gateHistory.set(gateKey(row), at);
          try {
            const result = applyGate({ repo, pr: row.prNumber });
            applied.push({ prNumber: row.prNumber, status: result?.status ?? 'unknown' });
          } catch { row.why = 'saved gate application failed; retry next tick or inspect stored evidence'; }
        }
      }
      if (row.action === 'dispatch') {
        const budget = capacity?.budget;
        if (!(capacity?.lanes > 0) || (budget && !(budget.left > 0))
          || (capacity.remainingStarts != null && !(capacity.remainingStarts > 0))) row.why = 'no review capacity left';
        else if (dryRun) row.why = `dry run (${row.mode})`;
        else {
          const reserved = budget && Number.isFinite(budget.left);
          if (reserved) budget.left--;
          try {
            const result = dispatch({ pr: row.prNumber, repo, redTeamOnly: true, redTeamMode: row.mode,
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
              dispatched.push({ prNumber: row.prNumber, jobPid: result.jobPid, mode: row.mode });
              started = true;
            }
          } catch {
            // A throw may follow a spawn: retain its reservation until the next live process read.
            capacity.lanes--;
            if (capacity.remainingStarts != null) capacity.remainingStarts--;
            capacity.take?.();
            row.why = 'dispatch failed; start unknown';
            uncertain.push({ prNumber: row.prNumber, reason: row.why });
          }
        }
        if (!started) { row.action = 'skip'; notStarted.push({ prNumber: row.prNumber, reason: row.why }); }
      }
      note(`review-daemon: ${repo}#${row.prNumber} already-reviewed-head — red team ${started ? `dispatched (${row.mode})` : 'not dispatched'} for head ${String(row.head ?? 'unknown').slice(0, 12)}: ${row.why}`);
    }
  } catch {
    rows.push({ prNumber: null, head: null, action: 'skip', why: 'red-team recovery inputs unreadable' });
    note(`review-daemon: ${repo}#? already-reviewed-head — red team not dispatched for head unknown: red-team recovery inputs unreadable`);
  }
  return { rows, dispatched, uncertain, notStarted, applied };
}
