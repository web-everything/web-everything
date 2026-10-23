/** Head-bound scheduler inputs and liveness shared by the review job and drain. */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { listRunIds, readRun, resolveRunsDir, sharedRunsDir } from '../operations/run-store.mjs';
import { resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';
import { scorecardOperationSnapshot, snapshotStoreRecords } from './scorecard-operation-snapshot.mjs';
import { readSavedRedTeamResult, attemptedRedTeamRun, sameRepo } from './drain-saved-red-team.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { redTeamEnabled, redTeamOwedFor, redTeamPanelSeatOwed } from './review-red-team-policy.mjs';
import { readRedTeamProbes } from './red-team-gate.mjs';
import { readFilteredInOrder } from './stream-filter-runs.mjs';

export const redTeamStatusDir = (env = process.env) => join(dirname(sharedRunsDir(env)), 'red-team-status');
// Slugs and shas are case-insensitive: the writer and the drain must name one file whatever case each was handed.
const statusPath = ({ repo, pr, head }, env) => join(redTeamStatusDir(env),
  `${encodeURIComponent(String(repo).toLowerCase())}-${Number(pr)}-${String(head).toLowerCase()}.json`);

// Every acquisition, stale-owner inspection/rename and release shares this short guard.
// Held for milliseconds; reclaim a guard older than 60 seconds and retry creation once.
function withAdmissionMutation(path, mutate, now) {
  const guard = path + '.guard';
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = openSync(guard, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (attempt !== 0) return { ok: false, reason: 'red-team admission in progress' };
      try {
        const mtime = statSync(guard).mtimeMs;
        if (now() - mtime <= 60_000) {
          return { ok: false, reason: 'red-team admission in progress' };
        }
        const renamed = guard + '.stale-' + process.pid + '-' + randomUUID();
        renameSync(guard, renamed);
        rmSync(renamed, { force: true });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  try {
    try { writeSync(fd, JSON.stringify({ pid: process.pid, at: now() })); }
    finally { closeSync(fd); }
    return mutate();
  } finally {
    try { unlinkSync(guard); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

/** Serialize admission until queued is durable; stale admission owners can be reclaimed. */
export function acquireRedTeamAdmissionLock({ repo, pr, head, env = process.env,
  now = Date.now, isAlive = pidAlive, readPidStart = pidStartTime }) {
  const path = statusPath({ repo, pr, head }, env) + '.admission.lock';
  const busy = () => ({ ok: false, reason: 'red-team admission in progress' });
  try {
    mkdirSync(dirname(path), { recursive: true });
    return withAdmissionMutation(path, () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let fd;
        try { fd = openSync(path, 'wx'); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (attempt !== 0) return busy();
          let owner;
          let content;
          try { content = readFileSync(path, 'utf8'); }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          try { owner = JSON.parse(content); } catch { /* incomplete owner */ }
          let mtime;
          try { mtime = statSync(path).mtimeMs; }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          const parsed = Number.isSafeInteger(owner?.pid) && owner.pid > 0
            && Number.isFinite(owner?.at) && Object.hasOwn(owner, 'pidStart');
          const age = now() - mtime;
          const start = parsed && owner.pidStart != null ? readPidStart(owner.pid) : null;
          const stale = parsed
            ? !isAlive(owner.pid) || (owner.pidStart != null && start != null && owner.pidStart !== start)
              // An unknown birth time cannot distinguish the owner from a reused pid.
              || ((owner.pidStart == null || start == null) && age > 600_000)
            : age > 60_000;
          if (!stale) return busy();
          const renamed = path + '.stale-' + process.pid + '-' + randomUUID();
          try { renameSync(path, renamed); }
          catch (e) { if (e.code === 'ENOENT') continue; throw e; }
          rmSync(renamed, { force: true });
          continue;
        }
        let owner;
        try {
          owner = { pid: process.pid, pidStart: readPidStart(process.pid), at: now() };
          writeSync(fd, JSON.stringify(owner));
        } finally { closeSync(fd); }
        return { ok: true, stillHeld() {
          try {
            const current = JSON.parse(readFileSync(path, 'utf8'));
            return current?.pid === owner.pid && current?.at === owner.at;
          } catch { return false; }
        }, release() {
          return withAdmissionMutation(path, () => {
            try {
              const current = JSON.parse(readFileSync(path, 'utf8'));
              if (current?.pid === owner.pid && current?.at === owner.at) unlinkSync(path);
            } catch (e) {
              if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
            }
          }, now);
        } };
      }
      return busy();
    }, now);
  } catch {
    return { ok: false, reason: 'red-team admission lock unavailable' };
  }
}

const freshAttemptPrefix = (input, env) => statusPath(input, env).replace(/\.json$/, '.fresh-attempt-');
const validFreshAttempt = attempt => Number.isSafeInteger(attempt?.at) && attempt.at >= 0
  && Number.isSafeInteger(attempt?.pid) && attempt.pid > 0;

/** List used head-bound attempt slots regardless of their contents; only directory reads can throw. */
export function readFreshRedTeamAttempts({ repo, pr, head, env = process.env } = {}) {
  const prefix = freshAttemptPrefix({ repo, pr, head }, env);
  const dir = dirname(prefix), namePrefix = prefix.slice(dir.length + 1);
  let names;
  try { names = readdirSync(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(name => name.startsWith(namePrefix) && /^(0|[1-9]\d*)\.json$/.test(name.slice(namePrefix.length)))
    .sort((a, b) => Number(a.slice(namePrefix.length, -5)) - Number(b.slice(namePrefix.length, -5)));
}

/** Exclusive creation is the admission boundary, independent of the per-job slot claim.
 * Return the first reserved index, or null when all slots exist. Failed writes retain
 * their slot: an interrupted admission must never make another attempt available.
 */
export function reserveFreshRedTeamAttempt({ repo, pr, head, at, pid, maxFreshPerHead }, { env = process.env, writeFile = writeFileSync } = {}) {
  const attempt = { at, pid };
  if (!validFreshAttempt(attempt) || !Number.isSafeInteger(maxFreshPerHead) || maxFreshPerHead < 0) {
    throw Error('invalid fresh red-team attempt');
  }
  const prefix = freshAttemptPrefix({ repo, pr, head }, env);
  mkdirSync(dirname(prefix), { recursive: true });
  for (let i = 0; i < maxFreshPerHead; i++) {
    let fd;
    try { fd = openSync(`${prefix}${i}.json`, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') continue; throw e; }
    try { writeFile(fd, JSON.stringify(attempt)); }
    finally { closeSync(fd); }
    return i;
  }
  return null;
}

/** How long a local `running` record with a dead pid is kept as "attempted" before it is read as over. Env override in minutes. */
export const STALE_RUNNING_TTL_MIN = 30;
export function staleRunningTtlMs(env = process.env) {
  const min = Number(env?.WE_RED_TEAM_STALE_RUNNING_TTL_MIN);
  return (Number.isFinite(min) && min > 0 ? min : STALE_RUNNING_TTL_MIN) * 60_000;
}

/** Read the head-bound status; unreadable evidence is an error, absence is null. */
export function readRedTeamStatus({ repo, pr, head, env = process.env } = {}) {
  try {
    const status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8'));
    if (!status || status.repo !== repo || Number(status.pr) !== Number(pr) || status.head !== head) throw Error('red-team status identity mismatch');
    return { ...status, updatedAtMs: statSync(statusPath({ repo, pr, head }, env)).mtimeMs };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Read the head-bound status; unreadable evidence is an error, absence is null. */
export function readRedTeamStatus({ repo, pr, head, env = process.env } = {}) {
  try {
    const status = JSON.parse(readFileSync(statusPath({ repo, pr, head }, env), 'utf8'));
    if (!status || status.repo !== repo || Number(status.pr) !== Number(pr) || status.head !== head) throw Error('red-team status identity mismatch');
    return status;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** A status is written before settling speculation or starting the sequential pass; crashes leave a dead pid. */
export function recordRedTeamStatus({ repo, pr, loopPayload, status, result = null }, { env = process.env, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime } = {}) {
  const head = loopPayload?.findings?.read?.netBasis?.rev;
  if (!/^[a-f0-9]{40}$/i.test(head ?? '')) return;
  const path = statusPath({ repo, pr, head }, env);
  mkdirSync(dirname(path), { recursive: true });
  // The writer's own card-only skip decision: the drain may resolve a different setting in its own process.
  writeJsonAtomic(path, { repo, pr, head, loopPayload, status, result, skipCardOnly: readRedTeamProbes({ env }).value.skipCardOnly,
    pid: process.pid, host, pidNamespace: namespace, pidStart: readPidStart(process.pid) });
}

/** Absence of a review payload is not an accept. Labels alone never schedule a post-accept pass. */
export function readDrainRedTeamEvidence({ repo, pr, head, env = process.env,
  runsDir = resolveRunsDir(), list = listRunIds, read = readRun, isAlive = pidAlive, host = hostname(), namespace = pidNamespace(), readPidStart = pidStartTime,
  readScorecards, now = Date.now } = {}) {
  const legacyStatusPath = join(redTeamStatusDir(env), `${encodeURIComponent(repo)}-${Number(pr)}-${head}.json`);
  head = String(head ?? '').toLowerCase();
  // One scorecard read for this whole call, shared with the saved-result check below (xwu9oxh S2, per operation).
  // An injected reader keeps the saved-result check on its own fresh read, as before.
  const scorecardSnapshot = readScorecards === undefined ? scorecardOperationSnapshot(resolveScorecardStorePath(env)) : undefined;
  const rows = readScorecards === undefined ? snapshotStoreRecords(scorecardSnapshot) : readScorecards();
  const recorded = rows.some(row => row?.dispatchKind === 'review-seat' && row.seat === 'red-team'
    && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && String(row.rev ?? '').toLowerCase() === head);
  let attempted = attemptedRedTeamRun(rows, { repo, pr, head });
  // Saved-result usability is independent of historical scorecard attempts.
  const noSavedResult = readSavedRedTeamResult({ repo, pr, head, env, runsDir, scorecardSnapshot }) === null;
  const withUsability = evidence => ({ ...evidence, noUsableResult: noSavedResult && !evidence.inFlight && !evidence.queued });
  const untrustedSavedResult = rows.some(row => row?.status === 'ok' && row?.dispatchKind === 'review-seat'
    && row.seat === 'red-team' && sameRepo(row.repo, repo) && Number(row.pr) === Number(pr) && row.rev === head)
    && noSavedResult;
  // Runs are immutable in identity but updated in place: choose the latest read of this exact repo/PR/head.
  const latestRun = () => {
    // Read, test and drop one run at a time (xwu9oxh S1a): same reads, order and errors as map-then-filter.
    const hits = readFilteredInOrder(list(runsDir).filter(id => id.startsWith('review-pr-')), id => read(id, runsDir),
      run => run?.op === 'review-pr' && sameRepo(run.input?.repo, repo) && Number(run.input?.pr) === Number(pr)
        && String(run.findings?.read?.netBasis?.rev ?? '').toLowerCase() === head, (run, id) => ({ id, run }))
      .map(hit => ({ ...hit, at: statSync(join(runsDir, `${hit.id}.json`)).mtimeMs }));
    hits.sort((a, b) => b.at - a.at);
    return { run: hits[0]?.run ?? null, at: hits[0]?.at ?? 0 };
  };
  // The review loop applies the accept labels before the job can write a status, so a persisted accepting run that
  // owes a pass holds until the job's status supersedes it. It is not a live queue entry: the drain's
  // never-scheduled deadline still applies when no job ever picks it up.
  const owes = run => (redTeamPanelSeatOwed(run, env) || (redTeamEnabled(env) && redTeamOwedFor(run)));
  let status, statusAt = 0;
  // Keep pre-normalization status records authoritative during the transition too.
  for (const path of new Set([statusPath({ repo, pr, head }, env), legacyStatusPath])) {
    try {
      const candidate = JSON.parse(readFileSync(path, 'utf8'));
      const at = statSync(path).mtimeMs;
      if (!status || at > statusAt) { status = candidate; statusAt = at; }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (sameRepo(status?.repo, repo) && Number(status.pr) === Number(pr) && String(status.head ?? '').toLowerCase() === head) {
    attempted ||= attemptedRedTeamRun([], { repo, pr, head }, status.result);
    // A finished status from an earlier review of this same head never supersedes a newer accepting run (a re-review
    // of an unchanged head labels its accept before its job writes `queued`).
    if (!['queued', 'running'].includes(status.status)) {
      const latest = latestRun();
      if (latest.at > statusAt && owes(latest.run)) return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload: latest.run, inFlight: false, scheduled: true, recorded, attempted, skipCardOnly: false });
    }
    // A local pid probe says nothing about another host or namespace: keep that pass held for its result.
    // For local records, a changed birth time proves pid reuse. An unavailable birth time is unknown,
    // so preserve the conservative liveness probe (also supports records written before this field).
    // A queued pass is a live queue entry only while the job that queued it is alive (the same probe).
    let live = false;
    if (['queued', 'running'].includes(status.status)) {
      if ((status.host && status.host !== host) || (status.pidNamespace && status.pidNamespace !== namespace)) live = true;
      else if (isAlive(status.pid)) {
        const start = status.pidStart ? readPidStart(status.pid) : null;
        live = !start || !status.pidStart || start === status.pidStart;
      }
    }
    const resultStatus = typeof status.result === 'string' ? status.result : status.result?.status;
    // A pass that is provably over and was never owed: a `not-owed` finish (the review did not accept), or a LOCAL
    // `running` record whose pid has been dead past the TTL (a speculative pass called off before its record was
    // finished; live #5608), on a head whose newest review does not owe a post-accept pass. This is DISPLAY evidence
    // only (`overNotOwed`, read by the status-label planner): every scheduling/attempt field below is unchanged, so the
    // drain's merge hold is exactly as before (a human accept over a non-accepting run still needs a result).
    const staleRunning = status.status === 'running' && !live && now() - statusAt >= staleRunningTtlMs(env);
    const notOwedFinish = status.status === 'finished' && resultStatus === 'not-owed';
    const overNotOwed = (staleRunning || notOwedFinish) && !redTeamOwedFor(latestRun().run ?? status.loopPayload);
    return withUsability({ ...(overNotOwed ? { overNotOwed: true } : {}), ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload: status.loopPayload, inFlight: live && status.status === 'running', ...(live && status.status === 'queued' ? { queued: true } : {}),
      ...(typeof status.skipCardOnly === 'boolean' ? { skipCardOnly: status.skipCardOnly } : {}), scheduled: redTeamPanelSeatOwed(status.loopPayload, env) || ['queued', 'running'].includes(status.status) || ['ran', 'error'].includes(resultStatus),
      recorded: recorded || resultStatus === 'ran',
      // A pass whose job died while running started and left no usable result, like one that errored.
      attempted: attemptedRedTeamRun(rows, { repo, pr, head }, status.result) || (status.status === 'running' && !live) });
  }
  const loopPayload = latestRun().run;
  // An owing run with no job status yet: only the job's process knows its card-only skip decision, so hold the head
  // (skip off) until that status records it (main's guard, kept). A recorded or started pass still holds.
  // A pass that already ran (even unusably) is scheduled, never "never scheduled".
  const ran = attempted || attemptedRedTeamRun([], { repo, pr, head }, loopPayload?.redTeam);
  return withUsability({ ...(untrustedSavedResult ? { untrustedSavedResult: true } : {}), loopPayload, inFlight: false, scheduled: recorded || ran || owes(loopPayload),
    recorded, attempted: ran, ...(owes(loopPayload) ? { skipCardOnly: false } : {}) });
}
