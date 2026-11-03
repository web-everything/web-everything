/** Shared, per-head enqueue ownership. The serial caller deliberately fails open on IO errors. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
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
  const read = path => {
    let record;
    try { record = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!record || !['claimed', 'done'].includes(record.state) || typeof record.token !== 'string'
        || typeof record.kind !== 'string' || !Number.isInteger(record.pid) || record.pid <= 0
        || !Number.isFinite(record.claimedAt)) throw new Error('Invalid enqueue claim record');
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
        if (record && at - record.claimedAt <= ttlMs) {
          if (record.state === 'done' && record.kind !== candidate.kind) return { won: false, reason: 'done-by-other', heldBy: record };
          if (record.state === 'claimed' && pidAlive(record.pid)) return { won: false, reason: 'held', heldBy: record };
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
