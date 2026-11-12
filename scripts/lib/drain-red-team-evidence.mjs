/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { redTeamCheckRunPayload, postRedTeamCheckRun, postRedTeamPublicationHold } from './red-team-check-run.mjs';
import { redTeamEnqueueHold } from './drain-queue-safety.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { isUnderTest } from './under-test.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { foreignStaleOwnerDead } from './red-team-foreign-host-stale.mjs';
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
import { latestAcceptRecord } from './accept-carry-forward.mjs';
import { readRedTeamCarry } from './red-team-carry-machine.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);

/** Publication outbox only: no status parsing or review-run scan at enqueue. */
export function readRedTeamPublicationHold({ repo, pr, head, env = process.env }) {
  const reason = 'red-team round not confirmed published; retry check publication before enqueue';
  try {
    statSync(`${statusPath({ repo, pr, head }, env)}.unpublished`);
    return reason;
  } catch (error) {
    return error.code === 'ENOENT' ? null : `${reason} (publication hold unreadable; operator must inspect)`;
  }
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
const hasOpenEffect = run => run.effects?.some(effect => ['pending', 'in-flight'].includes(effect?.status));
const unfinishedReview = run => !run.verdict || run.pending != null || hasOpenEffect(run);
// R622: an unfinished run a comment may settle is one that has NOT decided anything yet: no verdict, or only the
// "needs a human" hold awaiting its confirm, and no label effect still pending or in flight. A run that already
// recorded any other verdict (a rejection above all) is only waiting on its effects: a clean result comment that
// is newer than its start must not release it, because those effects can still apply a send-back.
const verdictOf = run => (typeof run.verdict === 'string' ? run.verdict : run.verdict?.verdict);
// A verdict is PRESENT when it is anything but undefined or null: false, 0 and '' are malformed present verdicts, not absent ones.
const hasVerdict = run => run.verdict !== undefined && run.verdict !== null;
const abandonableReview = run => !hasVerdict(run) && run.resumeOf == null && run.resumedAt == null && isRunRecordTerminal(run);
const undecidedUnfinished = run => {
  // Any PRESENT verdict this reader does not recognise (an empty object, another key, an array, false, 0, '') counts as decided.
  return (!hasVerdict(run) || verdictOf(run) === 'needs-human') && !hasOpenEffect(run);
};
// R622: how a record weighs on comment settlement (what the complete same-head read keeps of it):
//  hard      a label effect still pending or in flight, a rejection still waiting on a step, or a present verdict this
//            reader does not recognise (fails closed): blocks whatever else exists, whatever its start time.
//  reject    a finished rejection (`changes`, or any other recognised non-accept string) with no open effect: blocks only
//            while it is the NEWEST completed review of its head (a later completed accept supersedes it).
//  accept    a finished accept-class review (`prevention-outstanding`: every finding resolved, nothing to send back).
//  undecided no verdict yet, or the "needs a human" hold: settleable once quiet, never a completed review.
const ACCEPT_VERDICTS = ['accept', 'prevention-outstanding'];
const settleKind = run => {
  if (hasOpenEffect(run)) return 'hard';
  if (!hasVerdict(run)) return 'undecided';
  const verdict = verdictOf(run);
  if (typeof verdict !== 'string' || verdict === '') return 'hard';
  if (verdict === 'needs-human') return 'undecided';
  if (ACCEPT_VERDICTS.includes(verdict)) return run.pending != null ? 'undecided' : 'accept';
  // Only the one rejection this pipeline records is a supersedable rejection; any other string ('Accept ', 'rejected',
  // 'bogus') is a shape this reader does not recognise and fails closed like a non-string one.
  return verdict === 'changes' && run.pending == null ? 'reject' : 'hard';
};
// What the complete read keeps of a record: never its payload. Cached per (read function, dir, id) with the mtime and
// size it was read at, so a settle attempt that keeps holding does not re-parse the whole store every tick; a rewrite
// changes mtime or size and replaces the entry (bounded by the number of records, not by the number of rewrites).
const summaryCache = new WeakMap();
// Identity fields are normalised strictly: a PR number is a positive integer or a digit string (never null, '' or
// false, which Number() turns into 0); a head that is not a clean 40-hex sha reads as unknown (null), which matches
// every head, so a blocking record with a damaged head still holds; repo names compare case-insensitively.
const strictPr = value => (Number.isSafeInteger(value) && value > 0 ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value.trim()) ? Number(value.trim()) : NaN);
const cleanRev = value => (typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null);
const summarizeRun = run => ({ review: run?.op === 'review-pr', repo: typeof run?.input?.repo === 'string' ? run.input.repo.trim().toLowerCase() : undefined,
  pr: strictPr(run?.input?.pr), rev: cleanRev(run?.findings?.read?.netBasis?.rev), kind: settleKind(run),
  // Order key: the read start, or the resume stamp when later (a rewound run finishes after it resumes); NaN when unreadable.
  orderAt: unfinishedSince(run), resumed: run?.resumeOf != null || run?.resumedAt != null, abandonable: abandonableReview(run) });
// R622: settlement needs a COMPLETE same-PR, same-head read. Run ids carry no PR, so this parses every review-pr
// record (no parse cap: the bounded scan cannot vouch for what it did not read) and keeps only the summary. Over the
// records of this PR whose head is this head (or whose head cannot be read):
//  - a `hard` record (open label effect, pending rejection, unrecognised verdict) holds, as does any head-less
//    blocking record, whose place among the heads cannot be ordered;
//  - a verdictless terminal, unresumed record quiet for the abandon horizon is ignored, regardless of its start;
//  - any other undecided record still inside the abandon horizon (a review that may be running) holds, as does one that started
//    at or after the settling comment (a later re-review that comment cannot answer) or whose start is unreadable;
//  - an undecided record that was rewound and resumed holds (the loop may still reject);
//  - otherwise only the NEWEST completed same-head review decides: a finished rejection holds while it is the newest,
//    and a later completed accept of the same head supersedes it. Newest is by read-step start (or resume stamp when later);
//    a record whose start is unreadable or in the future cannot be ordered: a rejection of that kind holds, an accept supersedes nothing.
// Any record that cannot be listed, statted, read or attributed to a PR fails closed.
function completeSameHeadRead({ repo, pr, head, runsDir, list, read, stat, now, settleAt }) {
  const incomplete = { complete: false, blocked: false };
  try {
    const cache = summaryCache.get(read) ?? summaryCache.set(read, new Map()).get(read);
    const want = String(head).toLowerCase(), wantRepo = String(repo).trim().toLowerCase();
    // Same id universe as the bounded scan and every other review-run reader: the `review-pr-` id minted for the op.
    // A review run given another id by `--run-id` is invisible to all of them before settlement is ever asked.
    let newest = null; // the newest completed review of this exact head: { at, rejects }
    for (const id of list(runsDir).filter(id => id.startsWith('review-pr-'))) {
      const st = stat(join(runsDir, `${id}.json`));
      if (!Number.isFinite(st?.mtimeMs)) return incomplete;
      const key = `${runsDir}|${id}`; // one entry per record: a rewrite replaces it, so the cache never outgrows the store
      let hit = cache.get(key);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        hit = { mtimeMs: st.mtimeMs, size: st.size, summary: summarizeRun(read(id, runsDir)) };
        cache.set(key, hit);
      }
      const s = hit.summary;
      if (!s.review) continue;
      if (typeof s.repo !== 'string' || !s.repo || !Number.isFinite(s.pr)) return incomplete;
      if (s.repo !== wantRepo || s.pr !== Number(pr)) continue;
      if (s.rev !== null && s.rev !== want) continue;
      if (s.kind === 'hard') return { complete: true, blocked: true };
      if (s.kind === 'undecided') {
        const quiet = now - st.mtimeMs >= ABANDONED_REVIEW_AFTER_MS;
        if (s.abandonable && quiet) continue;
        // maybe still running, or a rewound run the review loop will resume (which may still reject): holds. So does
        // a review that started at or after the settling comment (a later re-review the comment cannot answer), and one
        // whose start cannot be read, or a settle attempt that names no comment time: the chronology is strict.
        // A record with no readable start (a crash before the read step) is bounded from above by its own last write:
        // it started no later than that, so a quiet one written (beyond the mtime slack) before the comment cannot be a
        // later re-review, and a newer comment frees it instead of holding it forever.
        const startedBy = Number.isFinite(s.orderAt) ? s.orderAt : st.mtimeMs + RUN_MTIME_SLACK_MS;
        if (s.resumed || !quiet || !(startedBy < settleAt)) return { complete: true, blocked: true };
        continue;
      }
      // Order only on a readable start that is not in the future. A rejection that cannot be ordered holds; an accept
      // that cannot be ordered proves nothing (mtime is only an upper bound on a start and moves on a rewrite).
      const orderable = s.rev !== null && Number.isFinite(s.orderAt) && s.orderAt <= now + RUN_MTIME_SLACK_MS;
      if (!orderable) {
        if (s.kind === 'reject') return { complete: true, blocked: true };
        continue;
      }
      const at = s.orderAt; // a tie keeps the rejection: fail closed
      const rejects = s.kind === 'reject';
      if (!newest || at > newest.at) newest = { at, rejects };
      else if (at === newest.at) newest.rejects ||= rejects;
    }
    return { complete: true, blocked: newest?.rejects === true };
  } catch { return incomplete; }
}

// A run record is written after its read step starts, so its mtime bounds that start from above.
// The slack covers filesystems that store mtime at 1-2 s granularity.
export const RUN_MTIME_SLACK_MS = 2000;
// A verdict-less record that run-store calls terminal (nothing pending or in flight) and that has not
// been written for this long is an abandoned attempt (a crash or kill): it is neither evidence nor an
// unfinished review. A run waiting on a pending step or effect is never abandoned, however old, and
// neither is a rewound resume (`resumeOf`): the review loop resumes that run, which may still reject.
export const ABANDONED_REVIEW_AFTER_MS = 60 * 60 * 1000;
// The bounded scan's predicate is unchanged (a `resumedAt` stamp alone does not keep a record in it); only the
// complete same-head read additionally requires `resumedAt == null` (abandonableReview).
const abandonedReview = (hit, now) => !hasVerdict(hit.run) && hit.run.resumeOf == null && isRunRecordTerminal(hit.run)
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
  // R622: the complete same-PR, same-head read settlement requires; lazy (only a settle attempt pays) and memoized.
  const completeReads = new Map(); // per settling-comment time: the answer depends on it
  const completeHeadRead = ({ pr: askedPr, head: askedHead, at } = {}) => {
    if (Number(askedPr) !== Number(pr) || String(askedHead).toLowerCase() !== String(head).toLowerCase()) return { complete: false, blocked: false };
    const settleAt = Number.isFinite(at) ? at : NaN; // no usable comment time: any unfinished same-head review holds
    if (!completeReads.has(settleAt) && completeReads.size >= 8) completeReads.clear(); // bounded: few distinct comments per tick
    if (!completeReads.has(settleAt)) completeReads.set(settleAt, completeSameHeadRead({ repo, pr, head, runsDir, list, read, stat, now, settleAt }));
    return completeReads.get(settleAt);
  };
  const runScan = () => {
    const slots = Object.fromEntries(TIE_ORDERS.map(order => [order, { newer: newerBy(order), newest: null, exact: null, unfinished: null, since: -Infinity, active: -Infinity, undecided: true }]));
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
              if (!undecidedUnfinished(run)) slot.undecided = false;
              // R622 liveness: when any unfinished run was last written. A review still running keeps writing, so a
              // settle waits until every unfinished run has been quiet for the abandon horizon (NaN mtime never does).
              slot.active = Number.isNaN(slot.active) || !Number.isFinite(at) ? NaN : Math.max(slot.active, at);
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
    const { newest, exact, unfinished, since, undecided, active } = scan.slots[order];
    const selected = exact ?? newest;
    const selectedStart = selected ? reviewStartedAt(selected) : NaN;
    // A start-less run last written before the selected run started is older; any other cannot be ordered.
    if (scan.count > 1 && (!Number.isFinite(selectedStart)
      || scan.startless.some(other => !(other.at + RUN_MTIME_SLACK_MS < selectedStart)))) {
      return { ok: false, reason: 'run-start-missing' };
    }
    if (unfinished && (!selected || unfinished.id === selected.id || reviewStartedAt(unfinished) >= selectedStart)) {
      return withSettleBounds({ ok: false, reason: 'review-unfinished' },
        { unfinishedStartedAt: since, unfinishedUndecided: undecided, unfinishedActiveAt: active, evaluatedAt: now, completeHeadRead, ...(scan.end?.ok === false ? { unreadBoundaryAt: scan.boundary } : {}) });
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
    return withSettleBounds({ ...scan.end }, { unreadBoundaryAt: scan.boundary, unfinishedStartedAt: since, unfinishedUndecided: undecided, unfinishedActiveAt: active, evaluatedAt: now, completeHeadRead });
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
  // The writer file's mtime is the age of a record whose pid cannot be probed here (foreign host name). Unreadable stays unknown.
  let statusAt;
  if (bytes !== null) { try { statusAt = statSync(path).mtimeMs; } catch { statusAt = undefined; } }
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
  return { ...key, statusAt, rawWriter: { bytes, parsed, sha256: digest(bytes) }, seats, newest: newest?.run ?? null,
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
  const underTest = isUnderTest(options.env) || isUnderTest();
  const publish = typeof options.postCheckRun === 'function' || typeof options.gh === 'function' || !underTest;
  const path = statusPath({ ...input, head: input.loopPayload?.findings?.read?.netBasis?.rev }, options.env ?? process.env);
  mkdirSync(dirname(path), { recursive: true });
  return withRedTeamStatusClaim(path, () => {
    if (Object.hasOwn(options, 'expectedSha256') && digest(optionalBytes(path)) !== options.expectedSha256) throw Error('raw recovery writer changed');
    // Every transition may invalidate a prior success, including a terminal
    // failure. Keep its hold durable until publication is confirmed.
    // A write that throws persisted nothing and attempts no publication, so it must not leave a hold of its
    // own behind (nothing would ever clear it). An earlier writer's unconfirmed hold is kept.
    // Only a proven absence (ENOENT) counts as "no earlier hold"; an unreadable probe keeps the hold.
    let heldBefore = false;
    // A GitHub-visible hold (commit status) set by an earlier writer must survive until a confirmed publication
    // clears it. An unreadable marker counts as set (clearing a status never posted costs one harmless write). A
    // marker written before the flag existed counts as unset: no writer posted a status then.
    let remoteHold = false;
    if (publish) {
      try { statSync(`${path}.unpublished`); heldBefore = true; }
      catch (error) { heldBefore = error.code !== 'ENOENT'; }
      if (heldBefore) {
        try { remoteHold = JSON.parse(readFileSync(`${path}.unpublished`, 'utf8'))?.remoteHold === true; }
        catch { remoteHold = true; }
      }
    }
    const writeHold = () => writeJsonAtomic(`${path}.unpublished`, { status: input.status, remoteHold });
    if (publish) writeHold();
    let written;
    try { written = writeRedTeamStatus(input, options); }
    catch (error) {
      if (publish && !heldBefore) rmSync(`${path}.unpublished`, { force: true });
      throw error;
    }
    // Keep synchronous publication inside the claim: a newer writer must not persist or
    // publish a hold before this writer's check has been posted. Local persistence
    // still happens first and survives every publication failure.
    // Test runs need explicit IO.
    if (publish) {
      const report = outcome => {
        if (!outcome.published) {
          try { (options.log ?? (line => process.stderr.write(`${line}\n`)))(JSON.stringify(outcome)); }
          catch { /* logging cannot fail the persisted local write */ }
        }
        return outcome;
      };
      const safeReason = value => String(value ?? 'red-team check publication failed')
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 300);
      try {
        const head = input.loopPayload?.findings?.read?.netBasis?.rev;
        // A publisher alone must not opt terminal evidence reads into real GitHub IO.
        const gh = options.gh ?? (underTest ? () => { throw Error('test publication evidence requires injected gh'); }
          // A writer's own `opts.env` (the WE App identity, redTeamWriterEnv) wins over the drain's env (#6535).
          : (args, opts) => runGhSync(args, { env: options.env ?? process.env, ...opts }));
        // Test runs need explicit IO for this channel too: a check publisher alone does not opt into status writes.
        const statusChannel = typeof options.postPublicationHold === 'function' || typeof options.gh === 'function' || !underTest;
        const postHold = ({ held, reason }) => {
          try {
            const result = (options.postPublicationHold ?? postRedTeamPublicationHold)({ repo: input.repo, pr: input.pr, headSha: head, held, reason, gh,
              env: options.env ?? process.env });
            if (result?.ok === true) return result;
            // `definite` is computed by the poster from the untruncated error; an injected poster may only say it in its reason.
            const why = String(result?.reason ?? '');
            return { ok: false, reason: safeReason(why), definite: result?.definite === true || /HTTP 4\d\d/.test(why) };
          } catch (error) {
            return { ok: false, reason: safeReason(error?.message ?? error), definite: /HTTP 4\d\d/.test(`${error?.stderr ?? ''} ${error?.message ?? error}`) };
          }
        };
        // Set the GitHub-visible hold BEFORE any check post, so no CI read during the retries below sees the older
        // success unheld. Record the intent first: a crash after the post still clears it on the next confirmation.
        // A definite rejection (HTTP 4xx: e.g. the token lacks statuses:write) created no status, so the intent is
        // withdrawn and nothing is left that a later clear would have to remove (no wedge).
        let preHold = null; // confirmed only when posted by THIS call; an inherited flag proves nothing landed
        const setRemoteHold = why => {
          if (!statusChannel) return { ok: false, reason: 'no status IO in this test run' };
          remoteHold = true;
          writeHold();
          const result = postHold({ held: true, reason: why });
          if (!result.ok && result.definite) { remoteHold = false; writeHold(); }
          return result;
        };
        if (!remoteHold) preHold = setRemoteHold(`${input.status} round publication in progress`);
        let hold = 'red-team evidence unreadable; inspect the PR thread';
        let sendBack = input.sendBack === true;
        if (input.status === 'finished') {
          try {
            const comments = options.comments ?? readCompletePrComments(input.pr, { repo: input.repo,
              exec: (_file, args, opts) => gh(args, opts) });
            const live = JSON.parse(gh(['pr', 'view', String(input.pr), '--repo', input.repo, '--json', 'headRefOid,labels'],
              { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
            if (live?.headRefOid !== head || !Array.isArray(live.labels)) throw Error('red-team live head or labels unreadable');
            hold = redTeamEnqueueHold({ ...input, head, comments, scheduled: true,
              recorded: input.result === 'ran', env: options.env ?? process.env });
          } catch { /* unreadable evidence retains the hold */ }
        }
        const payload = redTeamCheckRunPayload({ repo: input.repo, pr: input.pr, headSha: head, status: input.status, hold, sendBack });
        const post = payload => {
          try {
            const result = (options.postCheckRun ?? postRedTeamCheckRun)({ repo: input.repo, pr: input.pr, headSha: head, payload, gh,
              env: options.env ?? process.env });
            return result?.ok === true ? result : { ok: false, reason: safeReason(result?.reason) };
          } catch (error) { return { ok: false, reason: safeReason(error?.message ?? error) }; }
        };
        const inProgress = payload.status === 'in_progress';
        const maxAttempts = inProgress ? 3 : 1;
        let posted;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          posted = post(payload);
          if (posted.ok) {
            // Confirmed only once the GitHub-visible hold is cleared too; otherwise the hold stays and is retried.
            if (remoteHold) {
              const cleared = postHold({ held: false });
              // A definite rejection means this credential cannot write statuses, so it cannot have set one either: the
              // local hold is released (no wedge). A status another credential set stays on GitHub and keeps CI held
              // (fail closed, named in the merge-gate reason). Any other failure keeps both holds for a retry.
              if (!cleared.ok && !cleared.definite) return report({ published: false, reason: `${input.status} red-team check published for PR #${input.pr} on ${head}, but its GitHub-visible hold was not cleared: ${cleared.reason}` });
              if (!cleared.ok) {
                try { (options.log ?? (line => process.stderr.write(`${line}\n`)))(JSON.stringify({ published: true,
                  warning: `GitHub-visible hold clear rejected (${cleared.reason}); a status left by another credential keeps CI held` })); }
                catch { /* logging cannot fail a confirmed publication */ }
              }
            }
            rmSync(`${path}.unpublished`, { force: true });
            return { published: true };
          }
        }
        let reason = `Unpublished ${input.status} red-team round for PR #${input.pr} on ${head}: ${posted.reason}`;
        {
          const supersede = post(redTeamCheckRunPayload({ repo: input.repo, pr: input.pr, headSha: head, status: 'finished', hold: reason, sendBack: true }));
          if (supersede.ok) reason += '; failure check superseded prior success';
          else {
            // The second channel (a head-bound commit status every CI host reads) was set before the posts. Retry
            // it once only if that attempt did not confirm.
            const held = preHold?.ok === true ? preHold : setRemoteHold(`${input.status} round not confirmed published`);
            reason += held.ok ? `; failure supersede also failed: ${supersede.reason}; GitHub-visible publication hold set`
              : `; failure supersede also failed: ${supersede.reason}; GitHub-visible hold also failed: ${held.reason}; operator must inspect GitHub check history before merging`;
          }
        }
        return report({ published: false, reason });
      } catch (error) {
        return report({ published: false, reason: safeReason(error?.message ?? error) });
      }
    }
    return written;
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

/** A result's identity for the seal: everything but the publication state (`comment`), which the publisher itself moves. */
const sealedResultKey = result => JSON.stringify(result && typeof result === 'object' ? { ...result, comment: undefined } : result ?? null);

/**
 * Does a rewrite keep the prior seal (PR #6622)? Yes when the prior file was damaged (its seal reads unreadable: fail
 * closed), when the rewrite installs no `ran` result — queued/running with none, a resume (the SAME pass's effects), a
 * finished error or skip — or when it carries the SAME result. A DIFFERENT `ran` result drops the seal at ANY status:
 * a recovery that queues a new pass's `ran` must not inherit the old pass's seal (the publisher seals the new one). PURE.
 */
export function keepSeal(prior, result) {
  if (!prior) return false;
  if (prior.damaged === true) return true;
  if (!isRanResult(result)) return true;
  return sealedResultKey(prior.result) === sealedResultKey(result);
}

const isRanResult = result => result === 'ran' || (result != null && typeof result === 'object' && result.status === 'ran');

/**
 * The prior pass's own stored findings, when its result is about to be dropped: a `ran` result object's findings
 * (unreadable when they cannot be read). With `legacy`, also `unreadable` for an unsealed bare legacy `ran` (its
 * findings live only in the seat row, which the publisher has not sealed yet). Undefined when there is none.
 */
function priorPassFindings(prior, { legacy = false } = {}) {
  const r = prior.result;
  if (r && typeof r === 'object' && r.status === 'ran') return Array.isArray(r.findings) ? r.findings : 'unreadable';
  if (legacy && r === 'ran' && prior.sealedBreaks === undefined) return LEGACY_PENDING;
  return undefined;
}

/** Stored evidence a damaged status file may hold: a seal, a legacy hold, carried findings, or a `ran` result. */
const DAMAGED_EVIDENCE = /"(sealedBreaks|sealedPosted|legacyHoldPublished|storedFindings)"|"result":\s*"ran"|"result":\s*\{[^{}]*"status":\s*"ran"/;

/** Does a rewritten status present its OWN result as pass evidence (what `sealedFromStatus` reads)? Only a finished `ran`. */
const presentsOwnEvidence = (status, result) => status === 'finished' && isRanResult(result);

/**
 * The stored findings a rewrite must carry (PR #6622). The reader takes a result's findings as evidence only from a
 * FINISHED `ran` result, so every rewrite that stops presenting the prior pass that way — a queued retry that re-sends
 * the same result, a running rewrite with no result, a resume (bare `resumed`), a finished error/skip — would drop the
 * only stored evidence of an unsealed pass. Its findings are carried as `storedFindings`, read exactly like the result's
 * own, until a NEW finished `ran` result replaces them. While a pass is pending (not finished), an unsealed bare legacy
 * `ran` is carried as unreadable too: the pending pass's result replaces it. A finished rewrite does not carry that
 * shape (nothing would ever replace it, so it would hold forever); the publisher's legacy path owns it. PURE.
 */
export function carriedStoredFindings(prior, result, status = 'finished') {
  if (!prior) return undefined;
  const carried = !presentsOwnEvidence(status, result)
    ? priorPassFindings(prior, { legacy: status !== 'finished' }) ?? prior.storedFindings
    // The same result keeps what an earlier rewrite carried; a NEW result drops it (the new result is the evidence now).
    : keepSeal({ ...prior, damaged: false }, result) ? prior.storedFindings : undefined;
  // The legacy carry lasts only while its pass is pending: a finished rewrite (an errored or skipped retry) drops it,
  // since nothing would ever replace it and the hold would never clear.
  return status === 'finished' && carried === LEGACY_PENDING ? undefined : carried;
}

/** The legacy `ran` carry: not a findings list, so every reader holds it as unreadable (`sealedFromStatus`). */
const LEGACY_PENDING = 'unreadable-pending-pass';

/** A status is written before settling speculation or starting the sequential pass; crashes leave a dead pid. */
function writeRedTeamStatus({ repo, pr, loopPayload, status, result = null, retryCount, refundRetry = false, admissionId }, { env = process.env, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime, lockTimeoutMs = 60_000 } = {}) {
  const head = loopPayload?.findings?.read?.netBasis?.rev;
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) return;
  const path = statusPath({ repo, pr, head }, env);
  mkdirSync(dirname(path), { recursive: true });
  // The publisher's status lock (red-team-withheld-publish): its seal and this rewrite never interleave, so neither
  // drops the other's write (PR #6622). The publisher never takes the retry claim, so the order cannot deadlock.
  // The publisher holds it across its gh reads and post, so wait longer than the 5s default before reporting busy.
  return withFileLock(`${path}.lock`, () => writeRedTeamStatusLocked(path, { repo, pr, head, loopPayload, status, result, retryCount, refundRetry, admissionId },
    { env, host, namespace, readPidStart }), { timeoutMs: lockTimeoutMs });
}

function writeRedTeamStatusLocked(path, { repo, pr, head, loopPayload, status, result, retryCount, refundRetry, admissionId }, { env, host, namespace, readPidStart }) {
  // Retry admission survives running/finished rewrites, including lost seat-row appends.
  // A marker left by a failed status write must not wedge this writer: `claimed` below keeps its spend.
  let prior;
  try { prior = readStatusFile(path, { repo, pr, head }); }
  catch (error) {
    // Without a retry marker, ordinary writers may repair damaged JSON just as before retry admission.
    // Preserve marked evidence for inspection, and propagate filesystem errors even without a marker.
    if (retryMarkerSpent(path) || (!(error instanceof SyntaxError) && error.code !== 'RED_TEAM_STATUS_IDENTITY')) throw error;
    // A damaged file that carried a seal, a legacy hold or stored pass evidence (a `ran` result, its findings, carried
    // `storedFindings`) must not be repaired into "nothing sealed": seal it unreadable.
    let raw = '';
    try { raw = String(optionalBytes(path) ?? ''); } catch { raw = '"sealedBreaks"'; }
    // Keyed on the RESULT's own shape, never a bare `"findings"` (every status carries `loopPayload.findings`).
    prior = DAMAGED_EVIDENCE.test(raw) ? { sealedBreaks: 'unreadable', damaged: true } : null;
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
    // The sealed stored breaks and the legacy hold flag survive a rewrite that keeps the sealed result (a retry or recovery
    // that has no new result yet) (PR #6622): dropping them lifts the hold. A NEW result drops them, so the status reads
    // as unsealed (or as the seat's own findings) until the publisher seals it: a seal never vouches for another result.
    ...(keepSeal(prior, result) ? {
      ...(prior?.sealedBreaks !== undefined ? { sealedBreaks: prior.sealedBreaks } : {}),
      ...(prior?.sealedPosted !== undefined ? { sealedPosted: prior.sealedPosted } : {}),
      ...(prior?.legacyHoldPublished === true ? { legacyHoldPublished: true } : {}),
    } : {}),
    ...(carriedStoredFindings(prior, result, status) !== undefined ? { storedFindings: carriedStoredFindings(prior, result, status) } : {}),
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
      // The host name can change under a still-running job (rename mid-run), so a foreign record is dead only when it is
      // stale AND its pid is not alive here with the recorded birth time. A cross-namespace record is never probed.
      if (foreignStaleOwnerDead(status, { host, namespace, statusAt, now, env, isAlive, readPidStart })) live = false;
      else if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) live = true;
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
// re-review may still reject). A capped scan's unread records are covered by the complete same-head read instead.
// Breaks are checked by redTeamEnqueueHold BEFORE it reads `ok`, so a recorded break still
// sends back. Every other unknown reason, any missing bound, and any head without a trusted result comment stays
// unknown (fail closed).
// The settling result's own time is the NEWEST trusted comment for this exact head, the one redTeamForHead returns.
const newestResultComment = (comments, pr, head) => (Array.isArray(comments) ? comments : [])
  .map((c, i) => ({ c, i, parsed: isTrustedMarkerAuthor(c) ? parseRedTeamComment(typeof c === 'string' ? c : c?.body) : null }))
  .filter(x => x.parsed && x.parsed.pr === Number(pr) && x.parsed.rev === String(head).toLowerCase())
  .sort((a, b) => (Date.parse(commentCreatedAt(a.c)) || 0) - (Date.parse(commentCreatedAt(b.c)) || 0) || a.i - b.i).at(-1)?.c;
// review-unfinished only: its bounded scan may also have left records unread, and the settle bound it carries is the
// unfinished review's, so the comment must be a whole abandon-horizon newer than the first unread record (one that has
// been quiet that long is no longer a live review). A scan-capped read needs no such margin: the complete read inspects
// every unread record, holding on any open effect, rejection or review that may still be running.
export const UNREAD_SETTLE_MARGIN_MS = RUN_MTIME_SLACK_MS + ABANDONED_REVIEW_AFTER_MS;
export const COMMENT_SETTLEABLE_REASONS =Object.freeze(['review-unfinished', RUN_SCAN_CAPPED.reason]);
export function settleUnknownEvidenceByComment(evidence, comments, pr, head, reviews = undefined) {
  if (evidence?.ok !== false || !COMMENT_SETTLEABLE_REASONS.includes(evidence.reason)) return evidence;
  if (!redTeamForHead(comments, pr, head)) return evidence;
  const resultAt = Date.parse(commentCreatedAt(newestResultComment(comments, pr, head)));
  const bounds = evidence.settleBounds ?? {};
  // A result older than the unfinished review is still answered when the operator's accept (a trusted record bound to
  // this exact head, with nothing held after it) came after that review started: the accept is the verdict the
  // unfinished run never recorded, and its time stands in for the result's in every bound and the complete read.
  let at = resultAt;
  // The formal reviews must be a complete read (an array): a later COMMENTED / CHANGES_REQUESTED review is a hold that
  // no comment or label shows, so a missing or unreadable read leaves the accept unusable (fail closed).
  if (evidence.reason === 'review-unfinished' && Array.isArray(reviews) && Number.isFinite(resultAt) && Number.isFinite(bounds.unfinishedStartedAt) && !(resultAt > bounds.unfinishedStartedAt)) {
    const rec = latestAcceptRecord(comments, reviews, { sha: String(head).toLowerCase() });
    const acceptAt = Date.parse(rec?.at ?? '');
    if (rec && !rec.laterBodyDerivedHold && !rec.laterVerdict && Number.isFinite(acceptAt) && acceptAt > bounds.unfinishedStartedAt) at = acceptAt;
  }
  if (!Number.isFinite(at)) return evidence;
  // An unfinished run that already decided (a rejection with its label effect still open) is not answered by a
  // clean comment from an earlier job; a bound that does not say so fails closed.
  if (bounds.unfinishedUndecided !== true) return evidence;
  // A review still running has no verdict yet either: a clean comment posted after its start must not release it. Every
  // unfinished run of the PR must have been quiet (no record write) for the abandon horizon as of the read; a bound
  // that carries no read time or write time fails closed.
  if (!(bounds.evaluatedAt - bounds.unfinishedActiveAt >= ABANDONED_REVIEW_AFTER_MS)) return evidence;
  if (evidence.reason === 'review-unfinished') {
    if (!(at > bounds.unfinishedStartedAt)) return evidence;
    if ('unreadBoundaryAt' in bounds && !(at > bounds.unreadBoundaryAt + UNREAD_SETTLE_MARGIN_MS)) return evidence;
  } else if (!(at > bounds.unfinishedStartedAt)) return evidence;
  // scan-capped: the complete same-head read below covers every unread record (a rejection or open effect holds, and a
  // same-head review that may still be running holds), so the unread boundary needs no margin of its own here.
  // The bounded scan cannot vouch for a same-head rejection (or its pending label effect) it did not read: only a
  // complete same-PR, same-head read with nothing blocking settles; no such read, or an incomplete one, stays held.
  let complete = null;
  try { complete = typeof bounds.completeHeadRead === 'function' ? bounds.completeHeadRead({ pr, head, at }) : null; } catch { /* unreadable: stays held */ }
  if (complete?.complete !== true || complete.blocked !== false) return evidence;
  return { ok: true, settledByComment: evidence.reason, loopPayload: null, scheduled: false, inFlight: false,
    queued: false, recorded: true, skipCardOnly: false };
}
