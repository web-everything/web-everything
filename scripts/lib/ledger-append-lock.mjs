/** Host-wide, synchronous queue for ledger writers, shared across checkout lanes. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 5 * 60_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Unlink only the observed owner's unique record, never recursively remove a
// directory that may already belong to a successor. Exactly one reaper can unlink it.
function removeOwner(lock, ownerPath) {
  try {
    if (ownerPath) unlinkSync(ownerPath);
    rmdirSync(lock);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

/**
 * key identifies the logical repo + transport branch, not a checkout path.
 * Unknown/incomplete ownership waits for expiry; a full queue throws for retry later.
 * fn must be synchronous. dir is an injectable lock root (defaults to os.tmpdir()).
 */
export function withLedgerAppendLock(key, fn, {
  dir = tmpdir(), clock = Date.now, sleep = sleepSync, pidAlive = processAlive,
  waitMs = 120_000, random = Math.random,
} = {}) {
  if (typeof key !== 'string' || !key || typeof fn !== 'function') throw new TypeError('ledger lock requires a key and synchronous callback');
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('ledger lock waitMs must be finite and non-negative');
  const lock = join(dir, `ledger-append-${createHash('sha256').update(key).digest('hex')}.lock`);
  const ownerPath = join(lock, `${randomUUID()}.json`);
  const started = clock();
  mkdirSync(dir, { recursive: true });
  for (;;) {
    let acquired = false;
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (acquired) {
      try {
        writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, timestamp: clock() }), { flag: 'wx', mode: 0o600 });
        return fn();
      } finally { removeOwner(lock, ownerPath); }
    }

    try {
      const entries = readdirSync(lock);
      if (entries.length === 1) {
        const path = join(lock, entries[0]);
        let owner;
        try { owner = JSON.parse(readFileSync(path, 'utf8')); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const valid = Number.isSafeInteger(owner?.pid) && owner.pid > 0 && Number.isFinite(owner?.timestamp);
        const timestamp = valid ? owner.timestamp : statSync(lock).mtimeMs;
        if ((valid && !pidAlive(owner.pid)) || clock() - timestamp > STALE_MS) removeOwner(lock, path);
      } else if (!entries.length && clock() - statSync(lock).mtimeMs > STALE_MS) {
        removeOwner(lock);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // unreadable evidence never grants entry
    }
    const remaining = waitMs - (clock() - started);
    if (remaining <= 0) throw new Error('ledger writer queue is busy; retry later (ledger append was not written)');
    sleep(Math.min(remaining, 50 + Math.floor(random() * 201)));
  }
}
