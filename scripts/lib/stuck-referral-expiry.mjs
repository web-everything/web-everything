/**
 * Close only stale mandatory-referral suspensions, without deciding or applying anything.
 * mandatoryReferrals writes pending and exits: suspension is idle by design until --resume.
 * Without owner fields or a live process bound to the run id, a suspended run is provably idle.
 * A verdict-less terminal run becomes abandoned to drain-red-team-evidence after its
 * ABANDONED_REVIEW_AFTER_MS quiet horizon (60 minutes after this write). Until then it holds.
 * Unknown evidence holds for operator inspection; scans over 10,000 records also refuse.
 */
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { listRunIds, readRun, writeRun, runPath, sharedRunsDir, resolveRunsDir, isRunRecordTerminal } from '../operations/run-store.mjs';
import { validateRunRecord } from '../operations/run-record.mjs';
import { pidNamespace, pidStartTime } from './pid-alive.mjs';
import { ABANDONED_REVIEW_AFTER_MS } from './drain-red-team-evidence.mjs';
import { resolveReviewRedTeamOnSkip } from './review-red-team-on-skip.mjs';

const suspended = run => run?.op === 'review-pr'
  && run.pending?.kind === 'effect' && run.pending.step === 'mandatoryReferrals';
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const isRunBound = runId => execFileSync('ps', ['-axo', 'command'], {
  encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
}).includes(runId);
const defaultProbe = () => ({
  isRunBound,
  host: hostname(), namespace: pidNamespace(), readPidStart: pidStartTime,
  isAlive: pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  },
});

const readableRunIds = dir => {
  try {
    if (!statSync(dir).isDirectory()) throw Error('run store is not a directory');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return listRunIds(dir);
};

/** Complete, bounded local scan. Read/stat failures propagate: callers retain the human hold. */
function readRunRecords({ runsDir = resolveRunsDir(),
  list = readableRunIds, read = readRun, stat = statSync } = {}) {
  const ids = list(runsDir);
  if (!Array.isArray(ids) || ids.length > 10000) throw Error('referral run scan unavailable or over 10000 records; inspect run store');
  return ids.map(id => {
    const run = read(id, runsDir);
    if (!validateRunRecord(run).ok) throw Error('referral run record unreadable; inspect run store');
    const mtimeMs = stat(runPath(id, runsDir)).mtimeMs;
    if (!Number.isFinite(mtimeMs)) throw Error('referral run age unreadable; inspect run store');
    return { id, run, mtimeMs, at: mtimeMs };
  });
}

const matchesReview = (run, { repo, pr, head }) => run.op === 'review-pr'
  && run.input.repo === repo && Number(run.input.pr) === Number(pr)
  && (head == null || (run.findings?.read?.netBasis?.rev ?? run.input.head) === head);

/** Complete, bounded local scan. Read/stat failures propagate: callers retain the human hold. */
export function findSuspendedReferralRuns({ repo, pr, head, now = Date.now(), ...io } = {}) {
  const records = readRunRecords(io);
  return records.filter(({ run }) => suspended(run) && matchesReview(run, { repo, pr, head }))
    .map(item => {
      // A ruling can be saved before target selection. Protect matching PR work as
      // well as saved run-specific rulings, until terminal and past the quiet deadline.
      const rulings = records.filter(({ run }) => ['record-referral-ruling', 'review-ruling-resume'].includes(run.op)
        && (run.input.repo === repo && Number(run.input.pr) === Number(pr)
          || run.verdict?.record?.rulings?.some(r => r.runId === item.id)));
      return { ...item, pending: item.run.pending, ageMs: now - item.at,
        rulingOpen: rulings.some(({ run }) => !isRunRecordTerminal(run)),
        rulingAt: rulings.reduce((latest, r) => Math.max(latest, r.at), -Infinity) };
    });
}

/** Pure policy over a scan observation; injected probes do not apply effects. */
export function planReferralExpiry(observation, { now = Date.now(), deadlineMs, live, probe = defaultProbe() } = {}) {
  const hold = why => ({ action: 'hold', why });
  const run = observation?.run ?? observation;
  const ageMs = observation?.ageMs ?? now - observation?.mtimeMs;
  if (!Number.isFinite(now) || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return hold('expiry disabled or invalid');
  if (!suspended(run) || run.verdict != null || !validateRunRecord(run).ok || !Number.isFinite(ageMs) || !Number.isFinite(observation?.mtimeMs)) return hold('run evidence unreadable or no longer suspended');
  if (observation.rulingOpen === true) return hold('referral ruling open');
  if (ageMs < deadlineMs || now - observation.mtimeMs < deadlineMs) return hold('run recently written');
  if (live === true) return hold('owner live');
  if (live === null) return hold('liveness unreadable');
  if (run.resumedAt != null && (!Number.isFinite(stamp(run.resumedAt)) || now - stamp(run.resumedAt) < deadlineMs)) return hold('resume live or unreadable');
  // Drain deliberately never abandons resumeOf records. Preserve that protection even
  // for old resumes: an operator must settle them rather than strand a terminal resume.
  if (run.resumeOf != null || run.resumedAt != null) return hold('resumed review requires operator settlement');
  if (now - observation.rulingAt < deadlineMs) return hold('referral ruling in progress');
  if ((run.host != null && run.host !== probe?.host)
    || (run.pidNamespace != null && run.pidNamespace !== probe?.namespace)) return hold('owner on another host; unverifiable');
  if (run.host != null || run.pidNamespace != null || run.pid != null) {
    if (!probe || run.host !== probe.host || run.pidNamespace !== probe.namespace
      || !Number.isInteger(run.pid) || run.pid <= 0 || typeof probe.isAlive !== 'function') return hold('owner liveness unreadable');
    try {
      const alive = probe.isAlive(run.pid);
      if (alive !== true && alive !== false) return hold('owner liveness unreadable');
      if (alive) {
        let start;
        try { start = run.pidStart ? probe.readPidStart?.(run.pid) : null; }
        catch { return hold('owner live; start unreadable'); }
        if (!run.pidStart || start == null || start === run.pidStart) return hold('owner live');
      }
    } catch { return hold('owner liveness unreadable'); }
  }
  if (run.sessionId != null) {
    if (typeof probe?.isSessionAlive !== 'function') return hold('session liveness unverifiable');
    try {
      const alive = probe.isSessionAlive(run.sessionId);
      if (alive === true) return hold('session live');
      if (alive !== false) return hold('session probe unreadable');
    } catch { return hold('session probe unreadable'); }
  }
  try {
    const bound = probe?.isRunBound?.(run.id);
    if (bound === true) return hold('run bound to live process');
    if (bound !== false) return hold('run owner unreadable');
  } catch { return hold('run owner unreadable'); }
  return { action: 'expire', why: `expired: no referral ruling within ${deadlineMs / 60000}m` };
}

/** Re-read the entire witness, then plan and write that same record synchronously. */
export function expireSuspendedReferralRun({ runId, deadlineMs, source = 'standard', now = Date.now(),
  probe = defaultProbe(), write = writeRun, ...io } = {}) {
  const held = why => ({ expired: false, runId, why });
  try {
    const scan = () => findSuspendedReferralRuns({ ...io, now });
    const first = scan().find(r => r.id === runId);
    const initial = planReferralExpiry(first, { now, deadlineMs, probe });
    if (initial.action !== 'expire') return held(initial.why);
    const current = scan().find(r => r.id === runId);
    const plan = planReferralExpiry(current, { now, deadlineMs, probe });
    if (plan.action !== 'expire') return held(plan.why);
    const record = { ...current.run, pending: null,
      expired: { at: new Date(now).toISOString(), reason: plan.why, deadlineMs, source },
      effects: current.run.effects.map(e => ['pending', 'in-flight'].includes(e.status)
        ? { ...e, status: 'failed', error: plan.why } : e) };
    const valid = validateRunRecord(record);
    if (!valid.ok) return held('expired record invalid; inspect run store');
    write(record, io.runsDir ?? resolveRunsDir());
    return { expired: true, runId, deadlineMs };
  } catch { return held('run evidence unreadable; inspect run store'); }
}

export function expireStuckReferralRuns({ repo, pr, head, setting, env = process.env, now = Date.now(), log = () => {}, ...io } = {}) {
  const resolved = setting?.value ? setting : setting ? { value: setting, sources: { referralRunExpiryMinutes: 'injected' } }
    : resolveReviewRedTeamOnSkip({ env, log });
  const minutes = resolved.value.referralRunExpiryMinutes;
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || !Number.isSafeInteger(minutes * 60000)) return { expired: false, why: 'expiry disabled or invalid' };
  const source = resolved.sources?.referralRunExpiryMinutes ?? 'injected';
  const options = { runsDir: env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env), ...io, repo, pr, head, now };
  const held = [];
  let runs;
  try { runs = findSuspendedReferralRuns(options); }
  catch { return { expired: false, held: [{ why: 'run evidence unreadable; inspect run store' }] }; }
  for (const run of runs) {
    const result = expireSuspendedReferralRun({ ...options, runId: run.id, deadlineMs: minutes * 60000, source });
    if (result.expired) {
      log(`stuck-referral-expiry: ${repo}#${pr} run=${run.id} expired deadline=${minutes}m source=${source}`);
    } else held.push(result);
  }
  if (runs.length === 0 || held.length > 0) return { expired: false, held };
  const expiredIds = new Set(runs.map(run => run.id));
  let otherBlockers;
  try {
    otherBlockers = readRunRecords(options).filter(({ id, run, mtimeMs }) => {
      if (expiredIds.has(id)) return false;
      // Missing identity (even on an unrecognized operation) cannot clear the human hold.
      // Exclude only records whose readable identity proves they concern another repo/PR.
      const otherRepo = typeof run.input.repo === 'string' && run.input.repo.trim() !== ''
        && run.input.repo !== repo;
      const otherPr = typeof run.input.pr === 'number' && Number.isFinite(run.input.pr)
        && run.input.pr !== Number(pr);
      if (otherRepo || otherPr) return false;
      const abandoned = run.verdict == null && run.resumeOf == null && isRunRecordTerminal(run)
        && now - mtimeMs >= ABANDONED_REVIEW_AFTER_MS;
      return !abandoned && (run.verdict == null || run.pending != null
        || run.effects.some(effect => ['pending', 'in-flight'].includes(effect.status)));
    }).length;
  } catch {
    // An incomplete scan cannot clear the hold: retain the existing human escalation.
    otherBlockers = 1;
  }
  return { expired: true, otherBlockers };
}
