/**
 * Close only stale mandatory-referral suspensions, without deciding or applying anything.
 * A verdict-less terminal run becomes abandoned to drain-red-team-evidence after its
 * ABANDONED_REVIEW_AFTER_MS quiet horizon (60 minutes after this write). Until then it holds.
 * Unknown evidence holds for operator inspection; scans over 10,000 records also refuse.
 */
import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import { listRunIds, readRun, writeRun, runPath, sharedRunsDir, resolveRunsDir } from '../operations/run-store.mjs';
import { validateRunRecord } from '../operations/run-record.mjs';
import { pidAlive, pidNamespace, pidStartTime } from './pid-alive.mjs';
import { resolveReviewRedTeamOnSkip } from './review-red-team-on-skip.mjs';

const suspended = run => run?.op === 'review-pr'
  && run.pending?.kind === 'effect' && run.pending.step === 'mandatoryReferrals';
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const finishedAt = run => {
  const times = (run.stepTimings ?? []).map(t => stamp(t.finishedAt)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
};
const defaultProbe = () => ({ host: hostname(), namespace: pidNamespace(), isAlive: pidAlive, readPidStart: pidStartTime });

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
export function findSuspendedReferralRuns({ runsDir = resolveRunsDir(), repo, pr, head,
  list = readableRunIds, read = readRun, stat = statSync, now = Date.now() } = {}) {
  const ids = list(runsDir);
  if (!Array.isArray(ids) || ids.length > 10000) throw Error('referral run scan unavailable or over 10000 records; inspect run store');
  const records = ids.map(id => {
    const run = read(id, runsDir);
    if (!validateRunRecord(run).ok) throw Error('referral run record unreadable; inspect run store');
    const mtimeMs = stat(runPath(id, runsDir)).mtimeMs;
    const at = Number.isFinite(mtimeMs) ? mtimeMs : finishedAt(run);
    if (!Number.isFinite(at)) throw Error('referral run age unreadable; inspect run store');
    return { id, run, mtimeMs, at };
  });
  return records.filter(({ run }) => suspended(run) && run.input.repo === repo && Number(run.input.pr) === Number(pr)
    && (head == null || (run.findings?.read?.netBasis?.rev ?? run.input.head) === head))
    .map(item => ({ ...item, pending: item.run.pending, ageMs: now - item.at,
      // A ruling can be saved before target selection. Conservatively protect all recent
      // ruling work on this PR, including its saved verdict's run-specific rulings.
      rulingAt: records.filter(({ run }) => ['record-referral-ruling', 'review-ruling-resume'].includes(run.op)
        && (run.input.repo === repo && Number(run.input.pr) === Number(pr)
          || run.verdict?.record?.rulings?.some(r => r.runId === item.id)))
        .reduce((latest, r) => Math.max(latest, r.at), -Infinity) }));
}

/** Pure policy over a scan observation; injected probes do not apply effects. */
export function planReferralExpiry(observation, { now = Date.now(), deadlineMs, live, probe } = {}) {
  const hold = why => ({ action: 'hold', why });
  const run = observation?.run ?? observation;
  const ageMs = observation?.ageMs ?? now - (Number.isFinite(observation?.mtimeMs) ? observation.mtimeMs : finishedAt(run ?? {}));
  if (!Number.isFinite(now) || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return hold('expiry disabled or invalid');
  if (!suspended(run) || run.verdict != null || !validateRunRecord(run).ok || !Number.isFinite(ageMs)) return hold('run evidence unreadable or no longer suspended');
  if (ageMs < deadlineMs || now - observation.mtimeMs < deadlineMs) return hold('run recently written');
  if (live === true) return hold('owner live');
  if (live === null) return hold('liveness unreadable');
  if (run.resumedAt != null && (!Number.isFinite(stamp(run.resumedAt)) || now - stamp(run.resumedAt) < deadlineMs)) return hold('resume live or unreadable');
  // Drain deliberately never abandons resumeOf records. Preserve that protection even
  // for old resumes: an operator must settle them rather than strand a terminal resume.
  if (run.resumeOf != null || run.resumedAt != null) return hold('resumed review requires operator settlement');
  if (now - observation.rulingAt < deadlineMs) return hold('referral ruling in progress');
  if (probe && run.host === probe.host && run.pidNamespace === probe.namespace && Number.isInteger(run.pid) && run.pid > 0) {
    try {
      if (probe.isAlive(run.pid) === true) {
        let start;
        try { start = run.pidStart ? probe.readPidStart?.(run.pid) : null; }
        catch { return hold('owner live; start unreadable'); }
        if (!run.pidStart || start == null || start === run.pidStart) return hold('owner live');
      }
    } catch { /* Unprobeable owner: use the explicit quiet deadline. */ }
  }
  if (run.sessionId && probe?.isSessionAlive) {
    try { if (probe.isSessionAlive(run.sessionId) === true) return hold('session live'); }
    catch { return hold('session probe unreadable'); }
  }
  return { action: 'expire', why: `expired: no referral ruling within ${deadlineMs / 3600000}h` };
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
  const resolved = setting?.value ? setting : setting ? { value: setting, sources: { referralRunExpiryHours: 'injected' } }
    : resolveReviewRedTeamOnSkip({ env, log });
  const hours = resolved.value.referralRunExpiryHours;
  if (!Number.isSafeInteger(hours) || hours <= 0 || !Number.isSafeInteger(hours * 3600000)) return { expired: false, why: 'expiry disabled or invalid' };
  const source = resolved.sources?.referralRunExpiryHours ?? 'injected';
  const options = { runsDir: env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(env), ...io, repo, pr, head, now };
  let expired = false;
  for (const run of findSuspendedReferralRuns(options)) {
    const result = expireSuspendedReferralRun({ ...options, runId: run.id, deadlineMs: hours * 3600000, source });
    if (result.expired) {
      expired = true;
      log(`stuck-referral-expiry: ${repo}#${pr} run=${run.id} expired deadline=${hours}h source=${source}`);
    }
  }
  return { expired };
}
