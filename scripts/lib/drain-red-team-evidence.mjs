/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { readFilteredInOrder } from './stream-filter-runs.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor, redTeamCardOnly } from './review-red-team-policy.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';
import { completedRedTeamSeat } from './red-team-run-result.mjs';
import { readRedTeamCarry } from './red-team-carry-machine.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

/** The exclusive retry marker is the durable spend; a status file restored without it cannot refund it. */
function retryMarkerSpent(path) {
  try { statSync(`${path}.retry-1`); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

/** Read the head-bound status; unreadable evidence is an error, absence is null.
 * A surviving retry marker is folded into retryCount, and a marker without its status is incomplete evidence.
 */
export function readRedTeamStatus({ repo, pr, head, env = process.env } = {}) {
  const path = statusPath({ repo, pr, head }, env);
  const status = readStatusFile(path, { repo, pr, head });
  if (status === null && retryMarkerSpent(path)) throw Error('red-team retry marker has no status; inspect stored evidence');
  return status;
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
  if (!status || status.repo !== repo || !['number', 'string'].includes(typeof status.pr)
    || Number(status.pr) !== Number(pr) || status.head !== head) {
    throw Object.assign(Error('red-team status identity mismatch'), { code: 'RED_TEAM_STATUS_IDENTITY' });
  }
  return [undefined, 0].includes(status.retryCount) && retryMarkerSpent(path) ? { ...status, retryCount: 1 } : status;
}

const digest = bytes => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const optionalBytes = path => { try { return readFileSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

/** Raw, head-scoped evidence only. Never select an older accepting verdict over a newer rejection. */
// Match resolveRunsDir's override precedence without migrating runs during a raw read.
export function readRecoveryWitness({ repo, pr, head, env = process.env, runsDir = env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env),
  readScorecards = () => readStore({ path: resolveScorecardStorePath(env), strict: true }).records } = {}) {
  const key = { repo, pr, head }, path = statusPath(key, env), bytes = optionalBytes(path);
  const parsed = bytes === null ? null : JSON.parse(bytes);
  if (bytes !== null && (!parsed || parsed.repo !== repo || Number(parsed.pr) !== Number(pr) || parsed.head !== head)) throw Error('recovery writer identity mismatch');
  const records = readScorecards();
  const seats = records.filter(r => r.dispatchKind === 'review-seat' && r.seat === 'red-team'
    && r.repo === repo && Number(r.pr) === Number(pr) && r.rev === head);
  const runs = readFilteredInOrder(listRunIds(runsDir).filter(id => id.startsWith('review-pr-')), id => readRun(id, runsDir),
    run => run?.op === 'review-pr' && run.input?.repo === repo && Number(run.input?.pr) === Number(pr)
      && run.findings?.read?.netBasis?.rev === head, (run, id) => ({ id, run }))
    .map(hit => ({ ...hit, at: statSync(join(runsDir, `${hit.id}.json`)).mtimeMs }))
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const marker = optionalBytes(`${path}.stale-redispatch-1`);
  return { ...key, rawWriter: { bytes, parsed, sha256: digest(bytes) }, seats, newest: runs[0]?.run ?? null,
    // Preserve the existing policy-only carry surface; it never supplies a stale recovery payload.
    ...(runs.length ? {} : { carryEvidence: readDrainRedTeamEvidence({ ...key, env, runsDir, readScorecards: () => records }) }),
    evidenceSha256: digest(JSON.stringify([seats, runs[0] ?? null])),
    markers: { redispatch: marker === null ? null : JSON.parse(marker), retry: retryMarkerSpent(path) } };
}

/** Shared bounded lock: records the holder pid, waits for short concurrent writes, and
 * reclaims dead/legacy/partially-written claims after 30s. Live holders are never aged out.
 */
export function withRedTeamStatusClaim(path, write) {
  try { return withFileLock(`${path}.retry-claim`, write, { timeoutMs: 1000 }); }
  catch (error) {
    if (error.message?.startsWith('withFileLock: timed out')) {
      throw Object.assign(Error('red-team status writer busy; retry next tick'), { code: 'RED_TEAM_RETRY_ADMITTED' });
    }
    throw error;
  }
}

/** CAS and atomic rename share a reclaimable recovery claim; a loser never rolls back the winner. */
export function recordRedTeamStatus(input, options = {}) {
  const path = statusPath({ ...input, head: input.loopPayload?.findings?.read?.netBasis?.rev }, options.env ?? process.env);
  mkdirSync(dirname(path), { recursive: true });
  return withRedTeamStatusClaim(path, () => {
    if (Object.hasOwn(options, 'expectedSha256') && digest(optionalBytes(path)) !== options.expectedSha256) throw Error('raw recovery writer changed');
    return writeRedTeamStatus(input, options);
  });
}

/** Roll back only this admission under the same claim; another writer always wins. */
export function restoreRecoveryWriter(key, witness, admissionId) {
  if (typeof admissionId !== 'string' || !admissionId) throw Error('missing rollback admission identity');
  const path = statusPath(key, key.env ?? process.env);
  return withRedTeamStatusClaim(path, () => {
    const current = optionalBytes(path);
    if (!current) return;
    const writer = JSON.parse(current);
    if (writer.admissionId !== admissionId || writer.status !== 'queued') return;
    // No runner was admitted. Refund only the spend this queued writer introduced.
    if (writer.retryCount === 1 && witness.markers?.retry === false) rmSync(`${path}.retry-1`, { force: true });
    if (witness.rawWriter.parsed === null) rmSync(path, { force: true });
    else writeJsonAtomic(path, witness.rawWriter.parsed);
  });
}

/** Versioned job-to-runner codec: identity and queued writer are checked again by the runner. */
export function decodeRecoveryAdmission(value) {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || data.schema !== 1 || !Object.hasOwn(data, 'prior') || !Number.isInteger(data.pid) || data.pid <= 0
    || data.queued?.status !== 'queued' || data.queued.pid !== data.pid || typeof data.queued.repo !== 'string'
    || !Number.isSafeInteger(Number(data.queued.pr)) || Number(data.queued.pr) <= 0
    || !/^[a-f0-9]{40}$/i.test(data.queued.head ?? '')) throw Error('invalid recovery admission schema');
  return data;
}

/** A status is written before settling speculation or starting the sequential pass; crashes leave a dead pid. */
function writeRedTeamStatus({ repo, pr, loopPayload, status, result = null, retryCount, refundRetry = false, admissionId }, { env = process.env, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime } = {}) {
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
    ...(admissionId ? { admissionId } : {}),
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
  readScorecards = () => readStore({ path: resolveScorecardStorePath(env) }).records } = {}) {
  const seats = readScorecards().filter(row => row.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && row.repo === repo && Number(row.pr) === Number(pr) && row.rev === head);
  const recorded = seats.length > 0;
  const seatEvidence = { seatRecorded: recorded, completedRecorded: seats.some(completedRedTeamSeat),
    failedSeatCount: seats.filter(row => !completedRedTeamSeat(row)).length };
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const latestRun = (exactHead = true) => {
    // Read, test and drop one run at a time (xwu9oxh S1a): same reads, order and errors as map-then-filter.
    const hits = readFilteredInOrder(list(runsDir).filter(id => id.startsWith('review-pr-')), id => read(id, runsDir),
      run => run?.op === 'review-pr' && run.input?.repo === repo && Number(run.input?.pr) === Number(pr)
        && (!exactHead || run.findings?.read?.netBasis?.rev === head), (run, id) => ({ id, run }))
      .map(hit => ({ ...hit, at: statSync(join(runsDir, `${hit.id}.json`)).mtimeMs }));
    hits.sort((a, b) => b.at - a.at);
    return { run: hits[0]?.run ?? null, at: hits[0]?.at ?? 0 };
  };
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const owes = run => redTeamEnabled(env) && redTeamOwedFor(run);
  let status, statusAt = 0;
  try {
    status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8'));
    statusAt = statSync(statusPath({ repo, pr, head }, env)).mtimeMs;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const carry = readRedTeamCarry({ repo, pr, head, env });
  const carriedFrom = carry?.loopPayload.carriedFrom ?? status?.loopPayload?.carriedFrom;
  if (carriedFrom) {
    const latest = latestRun(false).run;
    const laterPanel = latest && latest.findings?.read?.netBasis?.rev !== carriedFrom;
    const ownStatus = status === undefined || (status?.repo === repo && Number(status.pr) === Number(pr) && status.head === head
      && (status.loopPayload?.carriedFrom === carriedFrom || (status.head === carriedFrom && status.skipCardOnly === true))
      && status.status === 'finished'
      && (status.result === 'skipped' || (status.result?.status === 'skipped' && status.result.policy === 'card-only')));
    if (laterPanel || (carry && !ownStatus) || recorded) {
      return { loopPayload: latest, status, carryConflict: true, inFlight: false,
        recorded, ...seatEvidence, scheduled: false };
    }
    if (carry) {
      // The journal survives a crash before the compatibility status exists. Never invent an accept.
      const projected = { repo, pr, head, loopPayload: carry.loopPayload, status: 'finished',
        result: { status: 'skipped', policy: 'card-only' }, skipCardOnly: true };
      return { carry, status: projected, loopPayload: carry.loopPayload, inFlight: false,
        recorded: false, ...seatEvidence, scheduled: false, skipCardOnly: true };
    }
  }
  if (status?.repo === repo && Number(status.pr) === Number(pr) && status.head === head) {
    // A finished status from an earlier review of this same head never supersedes a newer accepting run (a re-review
    // of an unchanged head labels its accept before its job writes `queued`).
    if (!['queued', 'running'].includes(status.status)) {
      const latest = latestRun();
      if (latest.at > statusAt && owes(latest.run)) {
        // A finished result that was never published still reaches the recovery path: a re-review of the same head must not
        // strand it behind a pass that may never come (#5759, #5762).
        const unpublished = status.status === 'finished' && ['withheld', 'error'].includes(status.result?.comment);
        return { loopPayload: latest.run, inFlight: false, scheduled: true, recorded, ...seatEvidence, skipCardOnly: false, ...(unpublished ? { status } : {}) };
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
    // Settlement provenance cannot stand in for a panel verdict, even if an older
    // writer retained one. Keep the status intact for recovery's provenance checks.
    const loopPayload = status.loopPayload?.carriedFrom != null ? { ...status.loopPayload, verdict: null } : status.loopPayload;
    return { status, loopPayload, ...seatEvidence, inFlight: live && status.status === 'running', ...(live && status.status === 'queued' ? { queued: true } : {}),
      ...(typeof status.skipCardOnly === 'boolean' ? { skipCardOnly: status.skipCardOnly } : {}), scheduled: ['queued', 'running'].includes(status.status) || ['ran', 'error', 'failed'].includes(resultStatus), recorded: recorded || resultStatus === 'ran' };
  }
  const loopPayload = latestRun().run;
  if (!loopPayload && !recorded) {
    const older = latestRun(false).run;
    const oldHead = older?.findings?.read?.netBasis?.rev;
    if (oldHead && oldHead !== head && redTeamCardOnly(older.findings.read)) {
      const old = readDrainRedTeamEvidence({ repo, pr, head: oldHead, env, runsDir, list, read,
        isAlive, host, namespace, readPidStart, readScorecards });
      if (historicalCardOnlySkipCandidate(old)) return old;
    }
  }
  // An owing run with no job status yet: only the job's process knows its card-only skip decision, so hold the head
  // (skip off) until that status records it. The never-scheduled deadline still applies if no job ever writes one.
  return { loopPayload, inFlight: false, scheduled: recorded || owes(loopPayload), recorded, ...seatEvidence, ...(owes(loopPayload) ? { skipCardOnly: false } : {}) };
}
