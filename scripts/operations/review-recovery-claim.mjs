/** Exclusive daemon-to-loop recovery handoff. Unknown ownership always retains the claim. */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from '../lib/atomic-json-file.mjs';
import { pidNamespace, pidStartTime, pidIdentity as probeIdentity } from '../lib/pid-alive.mjs';
import { isValidRunId, resolveRunsDir, createFileRunStore } from './run-store.mjs';
import { RESUME_MAX_ATTEMPTS } from '../conveyor/review-referral-hold.mjs';

export function recoveryOwner() {
  return { host: hostname(), namespace: pidNamespace(), pid: process.pid, procStart: pidStartTime(process.pid) ?? '' };
}
export function validRecoveryOwner(o) {
  return Boolean(o && typeof o.host === 'string' && o.host && (o.namespace === null || typeof o.namespace === 'string' && o.namespace)
    && Number.isSafeInteger(o.pid) && o.pid > 0 && typeof o.procStart === 'string' && o.procStart.trim());
}
export function sameOwner(a, b) {
  return Boolean(a && b && ['host', 'namespace', 'pid', 'procStart'].every(k => a[k] === b[k]));
}
export function isProvablyDeadOwner(stamp, { owner = recoveryOwner(), pidIdentity = probeIdentity } = {}) {
  if (!validRecoveryOwner(stamp) || !validRecoveryOwner(owner) || !stamp.namespace || !owner.namespace || stamp.host !== owner.host || stamp.namespace !== owner.namespace) return false;
  try { return pidIdentity(stamp.pid, { expectStart: stamp.procStart })?.alive === false; } catch { return false; }
}
export function recoveryClaimPath({ dir = resolveRunsDir(), runId } = {}) {
  if (!isValidRunId(runId)) throw Error('invalid recovery run id');
  return join(dir, `${runId}.recovery.claim`);
}
export function readRecoveryClaim(options) {
  return JSON.parse(readFileSync(recoveryClaimPath(options), 'utf8'));
}
export function validRecoveryClaim(c) {
  return Boolean(c && typeof c.token === 'string' && c.token && Number.isFinite(Date.parse(c.createdAt))
    && (c.holder === 'handoff' ? validRecoveryOwner(c.sweepOwner) : validRecoveryOwner(c.holder)));
}
export function withRecoveryClaimLock(options, fn) {
  const dir = options.dir ?? resolveRunsDir(); mkdirSync(dir, { recursive: true });
  return withFileLock(`${recoveryClaimPath({ ...options, dir })}.lock`, fn);
}
export function createRecoveryHandoff(options = {}) {
  const { owner = recoveryOwner(), now = Date.now } = options;
  try {
    if (!validRecoveryOwner(owner)) return { ok: false, reason: 'owner identity unavailable; operator inspection required' };
    return withRecoveryClaimLock(options, () => {
      let old;
      try { old = readRecoveryClaim(options); } catch (error) { if (error.code !== 'ENOENT') return { ok: false, reason: 'unreadable claim' }; }
      if (old !== undefined) {
        if (!validRecoveryClaim(old)) return { ok: false, reason: 'malformed claim' };
        const stale = old.holder === 'handoff' ? now() - Date.parse(old.createdAt) > 600_000
          : isProvablyDeadOwner(old.holder, options);
        if (!stale) return { ok: false, reason: 'claim held' };
        unlinkSync(recoveryClaimPath(options));
      }
      const token = randomUUID();
      writeFileSync(recoveryClaimPath(options), JSON.stringify({ holder: 'handoff', token, sweepOwner: owner,
        createdAt: new Date(now()).toISOString() }), { flag: 'wx', mode: 0o600 });
      return { ok: true, token };
    });
  } catch { return { ok: false, reason: 'claim unavailable; operator inspection required' }; }
}
export function acquireRecoveryClaim(options = {}) {
  const { token, owner = recoveryOwner() } = options;
  try { return withRecoveryClaimLock(options, () => {
    const c = readRecoveryClaim(options);
    if (!validRecoveryOwner(owner) || !validRecoveryClaim(c) || c.holder !== 'handoff' || c.token !== token)
      return { ok: false, reason: 'claim lost or token mismatch' };
    writeFileSync(recoveryClaimPath(options), JSON.stringify({ ...c, holder: owner }), { mode: 0o600 });
    return { ok: true, token };
  }); } catch { return { ok: false, reason: 'claim unavailable' }; }
}
export function releaseRecoveryClaim(options = {}) {
  try { return withRecoveryClaimLock(options, () => {
    const c = readRecoveryClaim(options);
    if (!validRecoveryClaim(c) || c.token !== options.token || !sameOwner(c.holder, options.owner ?? recoveryOwner()))
      return { ok: false, reason: 'claim changed' };
    unlinkSync(recoveryClaimPath(options)); return { ok: true };
  }); } catch { return { ok: false, reason: 'claim unavailable' }; }
}

/** Bounded discovery independent of PR labels. Production admission is supplied by the daemon/job. */
export function sweepStrandedRecordEffects({ dir = resolveRunsDir(), runsDir = dir, store = createFileRunStore(runsDir),
  repo, owner = recoveryOwner(), pidIdentity = probeIdentity, now = Date.now, readRuns = () => store.list().map(id => store.read(id)),
  readRun = id => store.read(id), readPr, dispatch, leaseHeld = () => false, ciAllowed = () => false,
  cooldownActive = () => true, log = console.error, maxDispatch = 1 } = {}) {
  const dispatched = [];
  let candidates = 0;
  try {
    const runs = readRuns();
    if (!Array.isArray(runs) || runs.length > 10_000) throw Error('recovery discovery exceeds bound; operator must inspect runs');
    for (const saved of runs) {
      if (dispatched.length >= maxDispatch) break;
      if (saved?.op !== 'review-pr' || saved.input?.repo !== repo || saved.pending?.step !== 'record'
        || saved.pending.kind !== 'effect' || !saved.effects?.some(e => e.type === 'review.label-swap' && e.status === 'pending' && !e.idempotent)) continue;
      const count = saved.strandedResumeAttempts ?? 0;
      if (!Number.isSafeInteger(count) || count < 0 || count >= RESUME_MAX_ATTEMPTS
        || !isProvablyDeadOwner(saved.owner, { owner, pidIdentity })) continue;
      if (++candidates > 16) throw Error('recovery candidate bound exceeded; inspect remaining runs');
      if (leaseHeld() !== true || ciAllowed(saved) !== true || cooldownActive(saved) !== false) continue;
      const pr = readPr(saved.input);
      if (pr?.state !== 'OPEN' || pr.headRefOid !== saved.findings?.read?.netBasis?.rev) continue;
      const fresh = readRun(saved.id);
      if (!sameOwner(saved.owner, fresh?.owner) || !isProvablyDeadOwner(fresh.owner, { owner, pidIdentity })) continue;
      const h = createRecoveryHandoff({ dir: runsDir, runId: saved.id, owner, pidIdentity, now });
      if (!h.ok) continue;
      // A failed spawn retains the handoff for ten minutes; it must never license a duplicate child.
      if (leaseHeld() !== true) continue;
      dispatched.push(dispatch({ ...saved.input, expectedHead: pr.headRefOid, resumeRun: saved.id, claimToken: h.token, leaseHeld }));
    }
  } catch (error) { log(`stranded record recovery refused: ${error.message}; inspect and settle-applied`); }
  return { dispatched };
}
