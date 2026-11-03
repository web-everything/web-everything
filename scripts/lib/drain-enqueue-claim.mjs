/**
 * serial: fail-open = status quo on main; async: fails closed; R425 (async path stays off/shadow until switched on)
 * Shared, per-head enqueue ownership. Serial bookkeeping deliberately fails open on
 * storage faults: withLandWriteLock already serializes the enqueue, so claim-store
 * failures warn without changing serial behavior. Explicit ownership refusals skip.
 * Live owners remain held regardless of age (including the legacy hardTtlMs cap).
 * Enqueued terminals use ttlMs from doneAt across kinds; same-kind retries proceed.
 * Unreadable or inconsistent coordination records are storage faults, never reclaimed by age.
 */
import { hostname } from 'node:os';
import { createActionStore, CoordinationUnavailableError } from '../operations/action-store.mjs';
import { actionResource } from '../operations/action-record.mjs';
import { pidAlive as ownerAlive } from '../operations/coordination-lock.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';

export function createEnqueueClaims({
  env = process.env,
  root = resolveCoordinationRoot({ env }),
  dir, // Retain the old explicit test/storage override as an action-store root.
  now = Date.now,
  pidAlive = ownerAlive,
  isPidAlive = pidAlive,
  ttlMs = 10 * 60_000,
  pid = process.pid,
  host = hostname(),
} = {}) {
  const store = createActionStore({ root: dir ?? root, now, isPidAlive });
  // Item IDs permit a lossless hex encoding of the head-qualified enqueue key.
  const resourceFor = c => actionResource(c.repo, { type: 'item',
    id: `enqueue-${Buffer.from(`${c.num}@${c.headSha}`).toString('hex')}` });
  const alive = record => {
    const owner = record.evidence;
    if (owner.host !== host) return undefined;
    try { return isPidAlive(owner.pid); }
    catch (error) { return error.code === 'ESRCH' ? false : undefined; }
  };
  const finish = (candidate, outcome) => {
    const resource = resourceFor(candidate);
    const record = store.attempts(resource).at(-1);
    if (!record || record.ownerToken !== candidate.token || record.state === 'terminal') return;
    const result = store.transition(resource, record.attempt, {
      token: candidate.token, rev: record.rev, from: 'intent', to: 'terminal',
      patch: { outcome },
    });
    if (!result.ok) throw new CoordinationUnavailableError(resource, result.reason);
  };
  return {
    claim(candidate) {
      const result = store.claim({
        resource: resourceFor(candidate), kind: 'enqueue', owner: `${host}:${pid}`,
        evidence: { pid, host, kind: candidate.kind, key: `${candidate.repo}#${candidate.num}@${candidate.headSha}` },
        canClaim: previous => previous.outcome !== 'enqueued' || previous.evidence.kind === candidate.kind
          || now() - previous.evidence.doneAt > ttlMs,
        reconcile: record => store.reconcile(record, { ownerAlive: alive }),
      });
      if (result.ok) return { won: true, token: result.record.ownerToken };
      return { won: false, reason: result.record?.state === 'terminal' ? 'done-by-other' : 'held',
        heldBy: result.record?.evidence };
    },
    release: candidate => finish(candidate, 'released'),
    markDone: candidate => finish(candidate, 'enqueued'),
  };
}

function warnClaimFault(identity, op, error, mode, emit) {
  const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const message = clean(error?.message ?? error);
  const key = clean(`${identity.repo}#${identity.num}@${identity.headSha}`);
  process.stderr.write(`drain-enqueue-claim: ${op} failed for ${key}: ${message} — ${mode === 'serial' ? 'proceeding fail-open' : 'held fail-closed; retry claim storage before async enqueue'}\n`);
  try {
    Promise.resolve(emit({ kind: 'drain-enqueue-claim-error', repo: identity.repo, pr: identity.num,
      daemon: 'drain', detail: { op, headSha: identity.headSha, message } })).catch(() => {});
  } catch { /* Event storage never changes the admission outcome. */ }
}

/** Synchronous claim admission; async names the consumer path, not a Promise store. */
export function claimOrFault(claims, identity, { mode = 'async', emit = appendDaemonEvent } = {}) {
  if (!['serial', 'async'].includes(mode)) throw new TypeError(`Unknown claim mode: ${mode}`);
  let result;
  try {
    if (!claims) throw new Error('claim store unavailable');
    result = claims.claim(identity);
    if (result?.won === true && typeof result.token === 'string' && result.token) return result;
    if (result?.won === false && ['held', 'done-by-other', 'unreadable-record'].includes(result.reason)) return result;
    throw new Error(result?.reason ?? 'invalid claim result');
  } catch (error) {
    warnClaimFault(identity, 'claim', error, mode, emit);
    // Serial historically skips a busy lock, but proceeds when storage itself faults.
    if (mode === 'serial') return result?.reason === 'lock-busy' ? result : { won: true };
    return { won: false, reason: 'claim-fault' };
  }
}

/** Serial bookkeeping is best-effort; ownership refusals still skip the enqueue. */
export function withSerialEnqueueClaim(claims, identity, run, { emit = appendDaemonEvent } = {}) {
  const warn = (op, error) => warnClaimFault(identity, op, error, 'serial', emit);
  const bookkeeping = (op, token) => {
    try {
      const result = claims[op]({ ...identity, token });
      if (result?.reason === 'lock-busy') warn(op, 'lock-busy');
    } catch (error) { warn(op, error); }
  };
  const claim = claimOrFault(claims, { ...identity, kind: 'serial' }, { mode: 'serial', emit });
  if (claim?.won === false) {
    return { skipped: 'claimed-elsewhere' };
  }
  let result;
  try { result = run(); } catch (error) {
    if (claim?.won && claim.token) bookkeeping('release', claim.token);
    throw error;
  }
  if (claim?.won && claim.token) bookkeeping(result?.enqueued === true ? 'markDone' : 'release', claim.token);
  return result;
}
