/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { scorecardOperationSnapshot, snapshotStoreRecords } from './scorecard-operation-snapshot.mjs';
import { readSavedRedTeamResult, attemptedRedTeamRun, sameRepo } from './drain-saved-red-team.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor, redTeamCardOnly, redTeamPanelSeatOwed } from './review-red-team-policy.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';
import { completedRedTeamSeat } from './red-team-run-result.mjs';
import { readRedTeamCarry, eligibleRedTeamCarryPayload } from './red-team-carry-machine.mjs';
import { readFilteredInOrder } from './stream-filter-runs.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
// Slugs and shas are case-insensitive: the writer and the drain must name one file whatever case each was handed.
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env),
  `${encodeURIComponent(String(repo).toLowerCase())}-${Number(pr)}-${String(head).toLowerCase()}.json`);

// Keep pre-normalization records authoritative for every status consumer too.
function readLatestRedTeamStatus({ repo, pr, head }, env) {
  const legacyPath = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);
  let status, statusAt = 0, selectedPath;
  for (const path of new Set([statusPath({ repo, pr, head }, env), legacyPath])) {
    try {
      const candidate = JSON.parse(readFileSync(path, 'utf8'));
      const at = statSync(path).mtimeMs;
      if (status === undefined || at > statusAt) { status = candidate; statusAt = at; selectedPath = path; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return { status, statusAt, selectedPath };
}

/** The exclusive retry marker is the durable spend; a status file restored without it cannot refund it. */
function retryMarkerSpent(path) {
  try { statSync(`${path}.retry-1`); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

/** Read the head-bound status; unreadable evidence is an error, absence is null.
 * A surviving retry marker is folded into retryCount, and a marker without its status is incomplete evidence.
 */
export function readRedTeamStatus({ repo, pr, head, env = process.env } = {}) {
  const { status, selectedPath } = readLatestRedTeamStatus({ repo, pr, head }, env);
  if (status === undefined) {
    if (retryMarkerSpent(statusPath({ repo, pr, head }, env))) throw Error('red-team retry marker has no status; inspect stored evidence');
    return null;
  }
  // Validate the selected legacy/canonical record with main's typed identity guard.
  const checked = readStatusFile(selectedPath, { repo, pr, head });
  if (checked === null) throw Error('red-team status disappeared; inspect stored evidence');
  return [undefined, 0].includes(checked.retryCount) && retryMarkerSpent(statusPath({ repo, pr, head }, env))
    ? { ...checked, retryCount: 1 } : checked;
}

/** Absence is null even beside a marker: only the writer may read that state, and it keeps the marker's spend. */
function readStatusFile(path, { repo, pr, head }) {
  let status;
  try {
    status = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return null;
  }
  if (!status || !sameRepo(status.repo, repo) || !['number', 'string'].includes(typeof status.pr)
    || Number(status.pr) !== Number(pr) || String(status.head ?? '').toLowerCase() !== String(head).toLowerCase()) {
    throw Object.assign(Error('red-team status identity mismatch'), { code: 'RED_TEAM_STATUS_IDENTITY' });
  }
  return [undefined, 0].includes(status.retryCount) && retryMarkerSpent(path) ? { ...status, retryCount: 1 } : status;
}

/** A status is written before settling speculation or starting the sequential pass; crashes leave a dead pid. */
export function recordRedTeamStatus({ repo, pr, loopPayload, status, result = null, retryCount, refundRetry = false }, { env = process.env, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime } = {}) {
  const head = loopPayload?.findings?.read?.netBasis?.rev;
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) return;
  const path = statusPath({ repo, pr, head }, env);
  mkdirSync(dirname(path), { recursive: true });
  // Retry admission survives running/finished rewrites, including lost seat-row appends.
  // A marker left by a failed status write must not wedge this writer: `claimed` below keeps its spend.
  let prior;
  try { prior = readStatusFile(path, { repo, pr, head }); }
  catch (error) {
    // Without a retry marker, ordinary writers may repair damaged JSON just as before retry admission.
    // Preserve marked evidence for inspection, and propagate filesystem errors even without a marker.
    if (retryMarkerSpent(path) || (!(error instanceof SyntaxError) && error.code !== 'RED_TEAM_STATUS_IDENTITY')) throw error;
    prior = null;
  }
  const spent = prior?.retryCount;
  if (spent !== undefined && (!Number.isSafeInteger(spent) || spent < 0)) throw Error('invalid red-team retry count');
  if (retryCount !== undefined && (!Number.isSafeInteger(retryCount) || retryCount < 0)) throw Error('invalid red-team retry count');
  const retryMarker = `${path}.retry-1`;
  // A refund returns this writer's own spend after a settlement that launched no model call. A reservation
  // moves the status to running, so only the still-queued admission record may refund; anything else keeps it.
  // A crash after removing the marker leaves the queued retryCount, which still counts as spent.
  // Any other record keeps the spend: the write below then proceeds as an ordinary settlement.
  // The start time rules out a later process that reused a dead admitter's pid.
  const refund = refundRetry === true && retryCount === undefined && prior?.status === 'queued' && prior.retryCount === 1
    && prior.pid === process.pid && prior.host === host && prior.pidNamespace === namespace
    && prior.pidStart === readPidStart(process.pid);
  if (refund) rmSync(retryMarker, { force: true });
  // The exclusive create is the spend: status read/write/read cannot arbitrate workers.
  // Keep the marker even if the subsequent write fails; an operator must inspect that attempt.
  if (retryCount === 1) {
    if (spent >= 1) throw Object.assign(Error('retry already admitted'), { code: 'RED_TEAM_RETRY_ADMITTED' });
    let fd;
    try { fd = openSync(retryMarker, 'wx', 0o600); }
    catch (e) {
      if (e.code === 'EEXIST') throw Object.assign(Error('retry already admitted'), { code: 'RED_TEAM_RETRY_ADMITTED' });
      throw e;
    }
    closeSync(fd);
  }
  let claimed = 0;
  try { statSync(retryMarker); claimed = 1; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const durableRetryCount = refund ? claimed : Math.max(spent ?? 0, retryCount ?? 0, claimed);
  // skipCardOnly is the writer's resolved setting, NOT evidence that this PR is card-only.
  // Consumers must classify the stored net read; the drain may resolve a different setting in its own process.
  writeJsonAtomic(path, { repo, pr, head, loopPayload, status, result,
    ...(durableRetryCount > 0 ? { retryCount: durableRetryCount } : {}), skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly,
    pid: process.pid, host, pidNamespace: namespace, pidStart: readPidStart(process.pid) });
}

/** Each conjunct is independently pinned by the historical fallback predicate tests. PURE. */
export function historicalCardOnlySkipCandidate(old) {
  const prior = old?.status;
  return prior?.status === 'finished' && prior.skipCardOnly === true
    && (typeof prior.result === 'string' ? prior.result : prior.result?.status) === 'skipped'
    && !old.recorded && !old.inFlight && !old.queued;
}

/** Absence of a review payload is not an accept. Labels alone never schedule a post-accept pass. */
export function readDrainRedTeamEvidence({ repo, pr, head, env = process.env,
  runsDir = resolveRunsDir(), list = listRunIds, read = readRun, isAlive = pidAlive, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime,
  readScorecards } = {}) {
  const originalHead = head;
  head = String(head ?? '').toLowerCase();
  // One scorecard read for this whole call, shared with the saved-result check below (xwu9oxh S2, per operation).
  // An injected reader keeps the saved-result check on its own fresh read, as before.
  const scorecardSnapshot = readScorecards === undefined ? scorecardOperationSnapshot(resolveScorecardStorePath(env)) : undefined;
  const rows = readScorecards === undefined ? snapshotStoreRecords(scorecardSnapshot, { strict: true }) : readScorecards();
  const recorded = rows.some(row => row?.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head);
  let attempted = attemptedRedTeamRun(rows, { repo, pr, head });
  // Saved-result usability is independent of historical scorecard attempts.
  const noSavedResult = readSavedRedTeamResult({ repo, pr, head, env, runsDir, scorecardSnapshot }) === null;
  const withUsability = evidence => ({ ...evidence, noUsableResult: noSavedResult && !evidence.inFlight && !evidence.queued });
  const untrustedSavedResult = rows.some(row => row?.status === 'ok' && row?.dispatchKind === 'review-seat'
    && row.seat === 'red-team' && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head)
    && noSavedResult;
  const seats = rows.filter(row => row?.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head);
  const seatEvidence = { seatRecorded: recorded, completedRecorded: seats.some(completedRedTeamSeat),
    failedSeatCount: seats.filter(row => !completedRedTeamSeat(row)).length };
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const latestRun = (exactHead = true) => {
    // Read, test and drop one run at a time (xwu9oxh S1a): same reads, order and errors as map-then-filter.
    const hits = readFilteredInOrder(list(runsDir).filter(id => id.startsWith('review-pr-')), id => read(id, runsDir),
      run => run?.op === 'review-pr' && sameRepo(run.input?.repo, repo) && Number(run.input?.pr) === Number(pr)
        && (!exactHead || String(run.findings?.read?.netBasis?.rev ?? '').toLowerCase() === head), (run, id) => ({ id, run }))
      .map(hit => ({ ...hit, at: statSync(join(runsDir, `${hit.id}.json`)).mtimeMs }));
    hits.sort((a, b) => b.at - a.at);
    return { run: hits[0]?.run ?? null, at: hits[0]?.at ?? 0 };
  };
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const owes = run => (redTeamPanelSeatOwed(run, env) || (redTeamEnabled(env) && redTeamOwedFor(run)));
  const { status, statusAt } = readLatestRedTeamStatus({ repo, pr, head: originalHead }, env);
  const matchingStatus = sameRepo(status?.repo, repo) && Number(status.pr) === Number(pr)
    && String(status.head ?? '').toLowerCase() === head;
  if (matchingStatus) attempted ||= attemptedRedTeamRun([], { repo, pr, head }, status.result);
  // Carry identities retain the writer's casing; both lookups keep the journal's strict validation.
  const carry = readRedTeamCarry({ repo, pr, head, env })
    ?? (originalHead !== head ? readRedTeamCarry({ repo, pr, head: originalHead, env }) : null);
  const ownStatus = carriedFrom => status === undefined || (matchingStatus
    && (String(status.loopPayload?.carriedFrom ?? '').toLowerCase() === String(carriedFrom).toLowerCase() || (String(status.head ?? '').toLowerCase() === String(carriedFrom).toLowerCase() && status.skipCardOnly === true))
    && status.status === 'finished'
    && (status.result === 'skipped' || (status.result?.status === 'skipped' && status.result.policy === 'card-only')));
  const statusCarriedFrom = matchingStatus && status.skipCardOnly === true && ownStatus(status.loopPayload?.carriedFrom)
    && eligibleRedTeamCarryPayload(status.loopPayload, status.head)
    ? status.loopPayload.carriedFrom : undefined;
  const carriedFrom = carry?.loopPayload.carriedFrom
    ?? (redTeamCardOnly(status?.loopPayload?.findings?.read) ? statusCarriedFrom : undefined);
  if (carriedFrom) {
    const latest = latestRun(false).run;
    const laterPanel = latest && String(latest.findings?.read?.netBasis?.rev ?? '').toLowerCase() !== String(carriedFrom).toLowerCase();
    if (laterPanel || (carry && !ownStatus(carriedFrom)) || recorded) {
      return { attempted, ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), noUsableResult: false, loopPayload: latest, status, carryConflict: true, inFlight: false,
        recorded, ...seatEvidence, scheduled: false };
    }
    if (carry) {
      // The journal survives a crash before the compatibility status exists. Never invent an accept.
      const projected = { repo, pr, head, loopPayload: carry.loopPayload, status: 'finished',
        result: { status: 'skipped', policy: 'card-only' }, skipCardOnly: true };
      return { attempted, ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), noUsableResult: false, carry, status: projected, loopPayload: carry.loopPayload, inFlight: false,
        recorded: false, ...seatEvidence, scheduled: false, skipCardOnly: true };
    }
  }
  if (matchingStatus) {
    // A finished status from an earlier review of this same head never supersedes a newer accepting run (a re-review
    // of an unchanged head labels its accept before its job writes `queued`).
    if (!['queued', 'running'].includes(status.status)) {
      const latest = latestRun();
      if (latest.at > statusAt && owes(latest.run)) {
        // A finished result that was never published still reaches the recovery path: a re-review of the same head must not
        // strand it behind a pass that may never come (#5759, #5762).
        const unpublished = status.status === 'finished' && ['withheld', 'error'].includes(status.result?.comment);
        return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), attempted, loopPayload: latest.run, inFlight: false, scheduled: true, recorded, ...seatEvidence, skipCardOnly: false, ...(unpublished ? { status } : {}) });
      }
    }
    // A local pid probe says nothing about another host or namespace: keep that pass held for its result.
    // For local records, a changed birth time proves pid reuse. An unavailable birth time is unknown,
    // so preserve the conservative liveness probe (also supports records written before this field).
    // A queued pass is a live queue entry only while the job that queued it is alive (the same probe).
    // The result is the bare status string or the compact result object that carries it.
    const resultStatus = typeof status.result === 'string' ? status.result : status.result?.status;
    let live = false;
    if (['queued', 'running'].includes(status.status)) {
      if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) live = true;
      else if (isAlive(status.pid)) {
        const start = status.pidStart ? readPidStart(status.pid) : null;
        live = !start || !status.pidStart || start === status.pidStart;
      }
    }
    // A skipped carry cannot supply a panel verdict even when its eligibility proof fails.
    // Legacy skip metadata alone cannot erase a real verdict.
    const skippedCarry = !!status.loopPayload?.carriedFrom && (status.result === 'skipped'
      || (status.result?.status === 'skipped' && status.result.policy === 'card-only'));
    const ineligibleCarry = skippedCarry && !carriedFrom;
    const loopPayload = carriedFrom || skippedCarry
      ? { ...status.loopPayload, verdict: null } : status.loopPayload;
    return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), ...(ineligibleCarry ? { ineligibleCarry: true } : {}), status, ...seatEvidence, loopPayload, inFlight: live && status.status === 'running', ...(live && status.status === 'queued' ? { queued: true } : {}),
      ...(typeof status.skipCardOnly === 'boolean' ? { skipCardOnly: status.skipCardOnly } : {}), scheduled: attempted || redTeamPanelSeatOwed(status.loopPayload, env) || ['queued', 'running'].includes(status.status) || ['ran', 'error'].includes(resultStatus),
      recorded: recorded || resultStatus === 'ran',
      // A pass whose job died while running started and left no usable result, like one that errored.
      attempted: attempted || (status.status === 'running' && !live) });
  }
  const loopPayload = latestRun().run;
  if (!loopPayload && !recorded) {
    const older = latestRun(false).run;
    const oldHead = older?.findings?.read?.netBasis?.rev;
    if (oldHead && String(oldHead).toLowerCase() !== head && redTeamCardOnly(older.findings.read)) {
      const old = readDrainRedTeamEvidence({ repo, pr, head: oldHead, env, runsDir, list, read,
        isAlive, host, namespace, readPidStart, readScorecards });
      if (historicalCardOnlySkipCandidate(old)) return old;
    }
  }
  // An owing run with no job status yet: only the job's process knows its card-only skip decision, so hold the head
  // (skip off) until that status records it (main's guard, kept). A recorded or started pass still holds.
  // A pass that already ran (even unusably) is scheduled, never "never scheduled".
  const ran = attempted || attemptedRedTeamRun([], { repo, pr, head }, loopPayload?.redTeam);
  return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload, ...seatEvidence, inFlight: false, scheduled: recorded || ran || owes(loopPayload),
    recorded, attempted: ran, ...(owes(loopPayload) ? { skipCardOnly: false } : {}) });
}
