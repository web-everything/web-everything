/**
 * serial: fail-open = status quo on main; async: fails closed; R425 (async path stays off/shadow until switched on)
 * Shared, per-head enqueue ownership. Serial bookkeeping deliberately fails open on
 * storage faults: withLandWriteLock already serializes the enqueue, so claim-store
 * failures warn without changing serial behavior. Explicit ownership refusals skip.
 * Live owners remain held regardless of age (including the legacy hardTtlMs cap).
 * Done records use ttlMs from doneAt across kinds, or claimedAt for legacy records.
 * Unreadable records remain held through ttlMs based on their file mtime.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function createEnqueueClaims({
  env = process.env,
  dir = join(resolveCoordinationRoot({ env }), 'drain-enqueue-claim'),
  now = Date.now,
  pidAlive = ownerAlive,
  ttlMs = 10 * 60_000,
  pid = process.pid,
} = {}) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const unreadable = path => {
    try { return { unreadable: true, mtimeMs: statSync(path).mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const read = path => {
    let source;
    try { source = readFileSync(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; return unreadable(path); }
    let record;
    try { record = JSON.parse(source); } catch { return unreadable(path); }
    if (!record || !['claimed', 'done'].includes(record.state) || typeof record.token !== 'string'
        || typeof record.kind !== 'string' || !Number.isInteger(record.pid) || record.pid <= 0
        || !Number.isFinite(record.claimedAt)) return unreadable(path);
    return record;
  };
  const write = (path, record) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' }); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  };
  const locked = (candidate, operation) => {
    const key = `${candidate.repo}#${candidate.num}@${candidate.headSha}`;
    const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
    const lock = `${path}.lock`;
    mkdirSync(dir, { recursive: true });
    const deadline = performance.now() + 2000;
    const owner = `${randomUUID()}.owner`;
    const staged = `${lock}.${owner}.tmp`;
    mkdirSync(staged);
    let owned = false;
    try {
      // Publish a nonempty directory atomically: even a delayed rmdir cannot remove a successor.
      writeFileSync(join(staged, owner), '', { flag: 'wx' });
      for (;;) {
        try {
          // Snapshot the unique marker BEFORE the age check. Unlink only that observed generation.
          const entries = readdirSync(lock);
          if (Date.now() - statSync(lock).mtimeMs > 5000) {
            if (entries.length === 0) rmdirSync(lock); // Legacy empty lock.
            else if (entries.length === 1 && entries[0].endsWith('.owner')) {
              unlinkSync(join(lock, entries[0]));
              rmdirSync(lock);
            }
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            try {
              const at = new Date(); utimesSync(staged, at, at);
              renameSync(staged, lock);
              owned = true;
              break;
            } catch (publishError) {
              if (!['EEXIST', 'ENOTEMPTY'].includes(publishError.code)) throw publishError;
            }
          } else if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        }
        if (performance.now() >= deadline) return { won: false, reason: 'lock-busy' };
        Atomics.wait(sleeper, 0, 0, 10);
      }
      return operation(path, key);
    } finally {
      rmSync(staged, { recursive: true, force: true });
      if (owned) {
        try { unlinkSync(join(lock, owner)); rmdirSync(lock); }
        catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      }
    }
  };
  return {
    claim(candidate) {
      return locked(candidate, (path, key) => {
        const record = read(path);
        const at = now();
        if (record) {
          if (record.unreadable && at - record.mtimeMs <= ttlMs) return { won: false, reason: 'unreadable-record' };
          if (record.state === 'done' && at - (record.doneAt ?? record.claimedAt) <= ttlMs && record.kind !== candidate.kind) return { won: false, reason: 'done-by-other', heldBy: record };
          if (record.state === 'claimed') {
            let alive;
            try { alive = pidAlive(record.pid); } catch (error) { alive = error.code !== 'ESRCH'; }
            if (alive) return { won: false, reason: 'held', heldBy: record };
          }
        }
        const token = randomUUID();
        write(path, { key, state: 'claimed', kind: candidate.kind, pid, token, claimedAt: at });
        return { won: true, token };
      });
    },
    release(candidate) {
      return locked(candidate, path => {
        const record = read(path);
        if (record && record.token === candidate.token) unlinkSync(path);
      });
    },
    markDone(candidate) {
      return locked(candidate, path => {
        const record = read(path);
        if (record && record.token === candidate.token) write(path, { ...record, state: 'done', doneAt: now() });
      });
    },
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
