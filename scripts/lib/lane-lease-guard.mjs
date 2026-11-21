import { writeFileSync, readFileSync, linkSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { withLedgerAppendLock } from './ledger-append-lock.mjs';

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const pause = ms => Atomics.wait(sleeper, 0, 0, ms);

// The shared directory-lock primitive publishes populated, unique owner records.
// It serializes dead-file recovery too: two reclaimers cannot unlink a successor's
// guard. Retain the legacy wx file so older running clients remain fenced.
export function withLaneLeaseGuard(file, work, fs = { writeFileSync, rmSync }) {
  const lock = join(realpathSync(dirname(resolve(file))), `${basename(file)}.lock`);
  try {
    return withLedgerAppendLock(lock, () => {
      const pending = `${lock}.${randomUUID()}.pending`;
      try {
        fs.writeFileSync(pending, `${process.pid}\n`, { flag: 'wx' });
        const deadline = Date.now() + 500;
        let conflict;
        for (;;) {
          if (conflict && Date.now() >= deadline) throw conflict;
          // Link a populated file atomically; a crash must never leave an empty
          // shared guard whose owner's PID cannot be established.
          try { (fs.linkSync ?? linkSync)(pending, lock); break; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            conflict = error;
            let dead = false;
            try {
              const text = (fs.readFileSync ?? readFileSync)(lock, 'utf8').trim();
              const pid = /^\d+$/.test(text) ? Number(text) : NaN;
              if (Number.isSafeInteger(pid) && pid > 0) {
                try { process.kill(pid, 0); }
                catch (probe) { dead = probe.code === 'ESRCH'; }
              }
            } catch (read) { if (read.code === 'ENOENT') continue; }
            if (dead) { fs.rmSync(lock, { force: true }); continue; }
            if (Date.now() >= deadline) throw error;
            pause(10);
          }
        }
        try { return work(); }
        finally { fs.rmSync(lock, { force: true }); }
      } finally { fs.rmSync(pending, { force: true }); }
    }, { dir: dirname(lock), waitMs: 500 });
  } catch (error) {
    if (error.message?.startsWith('ledger writer queue is busy')) {
      throw Object.assign(new Error(`EEXIST: lane lease guard busy: ${lock}; retry the operation`), { code: 'EEXIST' });
    }
    throw error;
  }
}
