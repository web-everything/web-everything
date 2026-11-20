import { writeFileSync, linkSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { currentBootId, boundedReadFile } from './proc-identity.mjs';

// Dead guards are immutable routing records: all contenders follow the same successor.
// Never unlink a dead guard: two reclaimers could otherwise delete a new writer's lock
// between checking its identity and unlinking it. Only the live owner removes its lock.
export function withLaneLeaseGuard(file, work, fsOverrides = {}) {
  const fs = { writeFileSync, readFileSync: path => boundedReadFile(path), linkSync, rmSync, ...fsOverrides };
  const base = `${file}.lock`;
  const bootId = currentBootId();
  const body = JSON.stringify({ pid: process.pid, host: hostname(), bootId, nonce: randomUUID() });
  const tmp = `${base}.tmp-${process.pid}-${randomUUID()}`;
  let lock = base;
  const deadline = Date.now() + 250;
  try {
    // Publish a complete owner record atomically; a crash during the write leaves
    // only a uniquely named temporary file, never an ownerless occupied guard.
    fs.writeFileSync(tmp, body, { flag: 'wx' });
    for (let depth = 0; depth < 32;) {
      try {
        fs.linkSync(tmp, lock);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let raw;
        try { raw = fs.readFileSync(lock, 'utf8'); }
        catch (readError) {
          if (readError.code === 'ENOENT' && Date.now() < deadline) continue;
          throw error;
        }
        let owner;
        try { owner = JSON.parse(raw); } catch { throw error; }
        // Accept the original PID-only format too; unknown hosts/owners fail closed.
        if (Number.isSafeInteger(owner)) owner = { pid: owner };
        if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0
            || (owner.bootId ? owner.bootId !== bootId : owner.host && owner.host !== hostname())) throw error;
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (probeError) { dead = probeError.code === 'ESRCH'; }
        if (dead) {
          lock = `${base}.after-${createHash('sha256').update(lock).update(raw).digest('hex')}`;
          depth++;
          continue;
        }
        if (owner.pid === process.pid || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      try { return work(); }
      finally { fs.rmSync(lock, { force: true }); }
    }
    throw Object.assign(new Error(`EEXIST: guard recovery limit at ${base}; stop all lane writers before removing its .lock* records`), { code: 'EEXIST' });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
