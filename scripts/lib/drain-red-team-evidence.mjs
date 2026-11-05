/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { isRunRecordTerminal, listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { createNewestRunFinder, RUN_SCAN_CAPPED } from './stream-filter-runs.mjs';
import { readStore, resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor, redTeamCardOnly } from './review-red-team-policy.mjs';
import { readRedTeamProbes, redTeamForHead, parseRedTeamComment } from './red-team-gate.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { commentCreatedAt } from '../conveyor/round-extension-mark.mjs';
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

// mtime orders IO, but finishing an older panel can touch its file after a newer
// panel started. The record has no createdAt: only the read-step start orders runs.
const reviewStartedAt = hit => {
  const timings = hit.run.stepTimings;
  const started = Array.isArray(timings) ? timings.find(t => t?.step === 'read')?.startedAt : undefined;
  return typeof started === 'string' ? Date.parse(started) : NaN;
};
// R622: a rewound-and-resumed review keeps its original read start, so the resume stamp counts too. A resumed
// run with no readable stamp has no usable bound (NaN), so no comment can settle it.
const unfinishedSince = run => {
  const started = reviewStartedAt({ run });
  if (run.resumeOf == null && run.resumedAt == null) return started;
  const resumed = typeof run.resumedAt === 'number' ? run.resumedAt : Date.parse(run.resumedAt);
  return Number.isFinite(resumed) ? Math.max(started, resumed) : NaN;
};
const unfinishedReview = run => !run.verdict || run.pending != null
  || run.effects?.some(effect => ['pending', 'in-flight'].includes(effect?.status));

// A run record is written after its read step starts, so its mtime bounds that start from above.
// The slack covers filesystems that store mtime at 1-2 s granularity.
export const RUN_MTIME_SLACK_MS = 2000;
// A verdict-less record that run-store calls terminal (nothing pending or in flight) and that has not
// been written for this long is an abandoned attempt (a crash or kill): it is neither evidence nor an
// unfinished review. A run waiting on a pending step or effect is never abandoned, however old, and
// neither is a rewound resume (`resumeOf`): the review loop resumes that run, which may still reject.
export const ABANDONED_REVIEW_AFTER_MS = 60 * 60 * 1000;
const abandonedReview = (hit, now) => !hit.run.verdict && hit.run.resumeOf == null && isRunRecordTerminal(hit.run)
  && now - hit.at >= ABANDONED_REVIEW_AFTER_MS;
const TIE_ORDERS = ['id-asc', 'id-desc'];
// R622: the times a result comment must beat to settle unknown evidence. Non-enumerable, so every existing
// shape comparison of the failure object is unchanged; only settleUnknownEvidenceByComment reads it.
const withSettleBounds = (failure, bounds) => Object.defineProperty(failure, 'settleBounds', { value: bounds, enumerable: false });

// Retain only the selected head/PR payloads and the newest unfinished attempt. Finished
// evidence is usable only once the scan rules out a newer unfinished run. The scan stops as
// soon as every unread record was last written before the exact-head match started (so none
// of them can have started after it); otherwise it reads up to the shared parse cap.
// With no exact-head match, a capped scan still answers when the window provably holds the answer:
// the any-head query once the newest same-PR run started after every unread record was written,
// and the exact-head query for "nothing written after `writtenAfter`" once, in addition, every
// unread record was written at least the mtime slack before that time and the newest run reviewed `newestHead`
// (a carried head's source). Anything else holds as `scan-capped`.
// One scan serves both tie orders, so a caller's fallback shares this scan's parse budget.
function reviewRunLookup({ repo, pr, head, runsDir, list, read, stat, tieBreak = 'id-asc', scanSettings, warn, now = Date.now() }) {
  if (!TIE_ORDERS.includes(tieBreak)) throw new TypeError('unknown run tieBreak');
  // A run with a read start outranks a start-less one; start-less runs are ordered by the checks below.
  const newerBy = order => (candidate, selected) => {
    if (!selected) return true;
    const c = reviewStartedAt(candidate), s = reviewStartedAt(selected);
    if (!Number.isFinite(c) || !Number.isFinite(s)) return Number.isFinite(c);
    return c > s || (c === s && (order === 'id-desc' ? candidate.id.localeCompare(selected.id) > 0 : candidate.id < selected.id));
  };
  let scan = null;
  const failures = new Map();
  const runScan = () => {
    const slots = Object.fromEntries(TIE_ORDERS.map(order => [order, { newer: newerBy(order), newest: null, exact: null, unfinished: null, since: -Infinity }]));
    const startless = []; // ids and mtimes only, never payloads
    let count = 0, newestSettled = false, boundary = -Infinity;
    // The read window is fixed in one order (equal mtimes by ascending id) for every caller: the tie
    // order only ranks matches in the slots. Otherwise equal mtimes straddling the cap would put
    // different records in the drain's and recovery's windows, and the two could disagree.
    const find = createNewestRunFinder({ ids: list(runsDir).filter(id => id.startsWith('review-pr-')), tieBreak: 'id-asc',
      stat: id => stat(join(runsDir, `${id}.json`)), read: id => read(id, runsDir), scanSettings, warn });
    const end = find((run, id, at, nextAt) => {
      if (run?.op === 'review-pr' && run.input?.repo === repo && Number(run.input?.pr) === Number(pr)) {
        const hit = { run, id, at };
        if (!abandonedReview(hit, now)) {
          count++;
          if (!Number.isFinite(reviewStartedAt(hit))) startless.push({ id, at });
          for (const slot of Object.values(slots)) {
            if (slot.newer(hit, slot.newest)) slot.newest = hit;
            if (run.findings?.read?.netBasis?.rev === head && slot.newer(hit, slot.exact)) slot.exact = hit;
            if (unfinishedReview(run)) {
              if (slot.newer(hit, slot.unfinished)) slot.unfinished = hit;
              // R622: the settle bound covers EVERY unfinished run of this PR (any may be resumed later), NaN if any is unreadable.
              const since = unfinishedSince(run);
              slot.since = Number.isNaN(slot.since) || Number.isNaN(since) ? NaN : Math.max(slot.since, since);
            }
          }
        }
      }
      // Equal starts share one start time, so either tie order gives the same bound.
      const { exact, newest } = slots[tieBreak];
      boundary = nextAt;
      if (newest !== null && reviewStartedAt(newest) > nextAt + RUN_MTIME_SLACK_MS) newestSettled = true;
      return exact !== null && reviewStartedAt(exact) > nextAt + RUN_MTIME_SLACK_MS;
    });
    scan = { slots, startless, count, end, newestSettled, boundary };
  };
  const failureFor = (order, exactHead, writtenAfter, newestHead) => {
    const { newest, exact, unfinished, since } = scan.slots[order];
    const selected = exact ?? newest;
    const selectedStart = selected ? reviewStartedAt(selected) : NaN;
    // A start-less run last written before the selected run started is older; any other cannot be ordered.
    if (scan.count > 1 && (!Number.isFinite(selectedStart)
      || scan.startless.some(other => !(other.at + RUN_MTIME_SLACK_MS < selectedStart)))) {
      return { ok: false, reason: 'run-start-missing' };
    }
    if (unfinished && (!selected || unfinished.id === selected.id || reviewStartedAt(unfinished) >= selectedStart)) {
      return withSettleBounds({ ok: false, reason: 'review-unfinished' },
        { unfinishedStartedAt: since, ...(scan.end?.ok === false ? { unreadBoundaryAt: scan.boundary } : {}) });
    }
    if (scan.end?.ok !== false) return null;
    // Capped: usable only when no unread record can change this query's answer (see above).
    // The exact-head relaxation also needs the newest run to be the named head's review (the
    // carried-from panel): an unread exact-head run could otherwise hide an unread unfinished re-review.
    // `writtenAfter` and the boundary are both mtimes: an unread record stamped in the same coarse
    // mtime tick as the status may have been written after it, so it must be older by the slack.
    if (exact === null && scan.newestSettled && (!exactHead || (Number.isFinite(writtenAfter)
      && scan.boundary + RUN_MTIME_SLACK_MS <= writtenAfter
      && typeof newestHead === 'string' && newest.run.findings?.read?.netBasis?.rev === newestHead))) return null;
    return withSettleBounds({ ...scan.end }, { unreadBoundaryAt: scan.boundary });
  };
  return (exactHead = true, order = tieBreak, { writtenAfter, newestHead } = {}) => {
    if (!TIE_ORDERS.includes(order)) throw new TypeError('unknown run tieBreak');
    if (!scan) runScan();
    const key = `${order}|${exactHead}|${writtenAfter}|${newestHead}`;
    if (!failures.has(key)) failures.set(key, failureFor(order, exactHead, writtenAfter, newestHead));
    const slot = scan.slots[order];
    return failures.get(key) ?? (exactHead ? slot.exact : slot.newest) ?? { run: null, at: 0 };
  };
}

/** Raw, head-scoped evidence only. Never select an older accepting verdict over a newer rejection. */
// Match resolveRunsDir's override precedence without migrating runs during a raw read.
export function readRecoveryWitness({ repo, pr, head, env = process.env, runsDir = env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env),
  list = listRunIds, read = readRun, stat = statSync, scanSettings = { env }, warn, now = Date.now(),
  readScorecards = () => readStore({ path: resolveScorecardStorePath(env), strict: true }).records } = {}) {
  const key = { repo, pr, head }, path = statusPath(key, env), bytes = optionalBytes(path);
  const parsed = bytes === null ? null : JSON.parse(bytes);
  if (bytes !== null && (!parsed || parsed.repo !== repo || Number(parsed.pr) !== Number(pr) || parsed.head !== head)) throw Error('recovery writer identity mismatch');
  const records = readScorecards();
  const seats = records.filter(r => r.dispatchKind === 'review-seat' && r.seat === 'red-team'
    && r.repo === repo && Number(r.pr) === Number(pr) && r.rev === head);
  const lookup = reviewRunLookup({ repo, pr, head, runsDir, list, read, stat, tieBreak: 'id-desc', scanSettings, warn, now });
  // Preserve the existing policy-only carry surface; it never supplies a stale recovery payload.
  // The fallback reuses this scan (one parse budget and the same read window) but ranks equal
  // starts in the drain's ascending id order.
  const readCarryEvidence = () => readDrainRedTeamEvidence({ ...key, env, runsDir, list, read, stat, scanSettings, warn, now,
    lookup: (exactHead = true, _order, options) => lookup(exactHead, 'id-asc', options), readScorecards: () => records });
  const latest = lookup();
  let carryEvidence;
  if (latest.ok === false) {
    // A capped exact-head query cannot prove there is no exact-head run, but the drain's carry
    // paths answer from the same scan through their own, provable queries. Read that fallback
    // first, so recovery never holds a head the drain can settle. Its newest run stays null, which
    // recovery never treats as an owed pass. Unfinished or unordered runs still hold at once.
    if (latest.reason !== RUN_SCAN_CAPPED.reason) return latest;
    carryEvidence = readCarryEvidence();
    if (carryEvidence?.ok === false) return latest;
  }
  const newest = latest.run ? { id: latest.id, run: latest.run, at: latest.at } : null;
  const marker = optionalBytes(`${path}.stale-redispatch-1`);
  return { ...key, rawWriter: { bytes, parsed, sha256: digest(bytes) }, seats, newest: newest?.run ?? null,
    ...(newest ? {} : { carryEvidence: carryEvidence ?? readCarryEvidence() }),
    evidenceSha256: digest(JSON.stringify([seats, newest])),
    markers: { redispatch: marker === null ? null : JSON.parse(marker), retry: retryMarkerSpent(path) } };
}

/** Shared bounded lock: bind the pid to its birth time, host and namespace so PID reuse
 * cannot strand recovery. Legacy numeric claims retain their liveness guard. Unreadable
 * identities and live holders are never aged out; incomplete claims retain the 30s grace.
 */
export function withRedTeamStatusClaim(path, write, { readPidStart = pidStartTime } = {}) {
  const host = hostname(), namespace = pidNamespace();
  // Keep the numeric first line so older writers still recognize a live holder.
  const holderText = `${process.pid}\n${JSON.stringify({ pid: process.pid,
    pidStart: readPidStart(process.pid), host, pidNamespace: namespace })}\n`;
  const probeHolderLiveness = claimPath => {
    const [pidText, identityText] = readFileSync(claimPath, 'utf8').trim().split('\n');
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
    let identity;
    try { identity = JSON.parse(identityText); } catch { /* legacy numeric or interrupted metadata write */ }
    // A local pid says nothing about a process on another host or in another pid namespace.
    if (identity && (identity.pid !== pid || identity.host !== host || identity.pidNamespace !== namespace)) return 'alive';
    try { process.kill(pid, 0); }
    catch (error) { return error.code === 'ESRCH' ? 'dead' : 'alive'; }
    if (typeof identity?.pidStart !== 'string' || !identity.pidStart.trim()) return 'alive';
    let start;
    try { start = readPidStart(pid); } catch { return 'alive'; }
    if (typeof start !== 'string' || !start.trim()) return 'alive';
    const normalize = value => value.trim().replace(/\s+/g, ' ');
    return normalize(start) === normalize(identity.pidStart) ? 'alive' : 'dead';
  };
  try { return withFileLock(`${path}.retry-claim`, write, { timeoutMs: 1000, holderText, probeHolderLiveness }); }
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
  runsDir = resolveRunsDir(), list = listRunIds, read = readRun, stat = statSync, lookup, scanSettings = { env }, warn, now = Date.now(), isAlive = pidAlive, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime,
  readScorecards = () => readStore({ path: resolveScorecardStorePath(env) }).records } = {}) {
  const seats = readScorecards().filter(row => row.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && row.repo === repo && Number(row.pr) === Number(pr) && row.rev === head);
  const recorded = seats.length > 0;
  const seatEvidence = { seatRecorded: recorded, completedRecorded: seats.some(completedRedTeamSeat),
    failedSeatCount: seats.filter(row => !completedRedTeamSeat(row)).length };
  // The parse cap covers historical and recovery fallbacks too.
  const latestRun = lookup ?? reviewRunLookup({ repo, pr, head, runsDir, list, read, stat, scanSettings, warn, now });
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const owes = run => redTeamEnabled(env) && redTeamOwedFor(run);
  let status, statusAt = 0;
  try {
    status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8'));
    statusAt = statSync(statusPath({ repo, pr, head }, env)).mtimeMs;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Every path below checks its own scan query first, so unknown evidence always holds; a carried
  // head needs only the any-head query, and a head with a status only runs written after it.
  const carry = readRedTeamCarry({ repo, pr, head, env });
  const carriedFrom = carry?.loopPayload.carriedFrom ?? status?.loopPayload?.carriedFrom;
  if (carriedFrom) {
    const latestHit = latestRun(false);
    if (latestHit.ok === false) return latestHit;
    const latest = latestHit.run;
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
    const latest = latestRun(true, undefined, { writtenAfter: statusAt, newestHead: carriedFrom });
    if (latest.ok === false) return latest;
    // A finished status from an earlier review of this same head never supersedes a newer accepting run (a re-review
    // of an unchanged head labels its accept before its job writes `queued`).
    if (!['queued', 'running'].includes(status.status)) {
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
  const exactHit = latestRun();
  if (exactHit.ok === false) return exactHit;
  const loopPayload = exactHit.run;
  if (!loopPayload && !recorded) {
    const olderHit = latestRun(false);
    const older = olderHit.run;
    const oldHead = older?.findings?.read?.netBasis?.rev;
    if (oldHead && oldHead !== head && redTeamCardOnly(older.findings.read)) {
      const old = readDrainRedTeamEvidence({ repo, pr, head: oldHead, env, runsDir, list, read, stat, lookup: () => olderHit, scanSettings, warn, now,
        isAlive, host, namespace, readPidStart, readScorecards });
      if (historicalCardOnlySkipCandidate(old)) return old;
    }
  }
  // An owing run with no job status yet: only the job's process knows its card-only skip decision, so hold the head
  // (skip off) until that status records it. The never-scheduled deadline still applies if no job ever writes one.
  return { loopPayload, inFlight: false, scheduled: recorded || owes(loopPayload), recorded, ...seatEvidence, ...(owes(loopPayload) ? { skipCardOnly: false } : {}) };
}

// R622: unknown run evidence the comment thread can answer. A review run left unfinished (its human confirm never
// recorded because the accept came by label) or a capped run scan says nothing about a result that is already
// published. A trusted result comment bound to this exact head (redTeamForHead) is that result; nothing is owed
// ONLY IF it is newer than the evidence it settles: newer than the start of the unfinished review (a later
// re-review may still reject), and newer than every unread record of a capped scan (an unread re-review would have
// been written after it). Breaks are checked by redTeamEnqueueHold BEFORE it reads `ok`, so a recorded break still
// sends back. Every other unknown reason, any missing bound, and any head without a trusted result comment stays
// unknown (fail closed).
// The settling result's own time is the NEWEST trusted comment for this exact head, the one redTeamForHead returns.
const newestResultComment = (comments, pr, head) => (Array.isArray(comments) ? comments : [])
  .map((c, i) => ({ c, i, parsed: isTrustedMarkerAuthor(c) ? parseRedTeamComment(typeof c === 'string' ? c : c?.body) : null }))
  .filter(x => x.parsed && x.parsed.pr === Number(pr) && x.parsed.rev === String(head).toLowerCase())
  .sort((a, b) => (Date.parse(commentCreatedAt(a.c)) || 0) - (Date.parse(commentCreatedAt(b.c)) || 0) || a.i - b.i).at(-1)?.c;
export const COMMENT_SETTLEABLE_REASONS = Object.freeze(['review-unfinished', RUN_SCAN_CAPPED.reason]);
export function settleUnknownEvidenceByComment(evidence, comments, pr, head) {
  if (evidence?.ok !== false || !COMMENT_SETTLEABLE_REASONS.includes(evidence.reason)) return evidence;
  if (!redTeamForHead(comments, pr, head)) return evidence;
  const at = Date.parse(commentCreatedAt(newestResultComment(comments, pr, head)));
  const bounds = evidence.settleBounds ?? {};
  if (!Number.isFinite(at)) return evidence;
  if (evidence.reason === 'review-unfinished') {
    if (!(at > bounds.unfinishedStartedAt)) return evidence;
    if ('unreadBoundaryAt' in bounds && !(at > bounds.unreadBoundaryAt + RUN_MTIME_SLACK_MS)) return evidence;
  } else if (!(at > bounds.unreadBoundaryAt + RUN_MTIME_SLACK_MS)) return evidence;
  return { ok: true, settledByComment: evidence.reason, loopPayload: null, scheduled: false, inFlight: false,
    queued: false, recorded: true, skipCardOnly: false };
}
