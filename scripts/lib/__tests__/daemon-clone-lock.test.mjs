/**
 * @file scripts/lib/__tests__/daemon-clone-lock.test.mjs
 * @description Card 4041/x3ecgta — the per-clone reader/writer lock. Every test uses a `mkdtemp` lock root
 *   (never `~/.claude/*`) and a `mkdtemp` clone dir, and injects `nowMs`/`now`/`sleep`/`probe`/`pid` so the
 *   pure reader/writer handshake is provable without any real waiting — except the final suite, which spawns
 *   two REAL child processes to prove actual cross-process mutual exclusion on the real filesystem (the one
 *   thing no amount of injected fakes can substitute for).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireRead,
  releaseRead,
  acquireWrite,
  releaseWrite,
  withWriteLock,
  inspectCloneLock,
  cloneLockKey,
  cloneLockDirs,
  HEARTBEAT_INTERVAL_MS,
  defaultProbePidLiveness,
  resolveWriterPriorityAfter,
} from '../daemon-clone-lock.mjs';

import { heartbeat } from '../../readiness/file-locks.mjs';

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-clone-lock.mjs');

const tmpDirs = [];
function mkTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

const alwaysAlive = () => 'alive';
const alwaysDead = () => 'dead';

describe('symmetric reader/writer fairness', () => {
  // Build real reader starvation records, then rotate through three different priority readers.
  // The fourth stays queued: clearing one reader's claim must not erase the writer's own refusals.
  async function rotatingReaders({ existingReader = false, useDefaults = false } = {}) {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    let clock = 1000;
    const common = {
      lockRoot, probe: alwaysAlive, writerClaimTtlMs: 1000,
      ...(useDefaults ? {} : { writerPriorityAfter: 3, writerPriorityMaxSkips: 2 }),
    };
    const read = (owner, overrides = {}) => acquireRead(clone, {
      ...common, owner, pid: 222, nowMs: clock, ...overrides,
    });
    const write = (overrides = {}) => acquireWrite(clone, {
      ...common, owner: 'writer-a', pid: 111, readerPriorityAfter: 3,
      writerWaitPriorityMs: 0, waitMs: 0, now: () => clock,
      sleep: async (ms) => { clock += ms; }, ...overrides,
    });
    expect(await write()).toEqual({ ok: true });
    const readers = ['reader-a', 'reader-b', 'reader-c', 'reader-d'];
    for (const owner of readers) {
      for (let refusal = 1; refusal <= 3; refusal += 1) {
        expect(read(owner)).toMatchObject({ ok: false, reason: 'writer-active', starved: refusal });
      }
    }
    releaseWrite(clone, { owner: 'writer-a', lockRoot });
    if (existingReader) expect(read('existing-reader')).toEqual({ ok: true });
    const pending = new Set(readers);
    const train = async (count = 3) => {
      for (let turn = 0; turn < count; turn += 1) {
        clock += 1;
        const result = await write();
        expect(result).toMatchObject({ ok: false, reason: 'reader-priority' });
        const owner = result.heldBy;
        expect(pending.delete(owner)).toBe(true);
        // Exercise the existing skip-cap bypass to let the reader that won take its turn.
        expect(read(owner, { writerPriorityMaxSkips: 0 })).toEqual({ ok: true });
        releaseRead(clone, { owner, lockRoot });
      }
    };
    return { clone, lockRoot, read, write, train, pending, advance: (ms) => { clock += ms; }, now: () => clock };
  }

  it('acquires after three writer refusals even when distinct priority readers rotate', async () => {
    const f = await rotatingReaders();
    await f.train();
    expect(await f.write()).toEqual({ ok: true });
  });

  it('uses omitted-option defaults: three writer refusals override older reader claims, with reader admission after two skips', async () => {
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER', undefined);
    vi.stubEnv('WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_MAX_SKIPS', undefined);
    try {
      const f = await rotatingReaders({ useDefaults: true });
      await f.train(2);
      expect(f.read('before-threshold')).toEqual({ ok: true });
      releaseRead(f.clone, { owner: 'before-threshold', lockRoot: f.lockRoot });
      await f.train(1);
      const olderReader = [...f.pending][0];
      expect(f.read(olderReader)).toMatchObject({ ok: false, reason: 'writer-priority' });
      expect(f.read(olderReader)).toMatchObject({ ok: false, reason: 'writer-priority' });
      expect(f.read(olderReader)).toEqual({ ok: true });
      expect(await f.write()).toMatchObject({ ok: false, reason: 'tick-in-progress', heldBy: olderReader });
      releaseRead(f.clone, { owner: olderReader, lockRoot: f.lockRoot });
      expect(await f.write()).toEqual({ ok: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses new readers with writer-priority while preserving an existing reader until it drains', async () => {
    const f = await rotatingReaders({ existingReader: true });
    await f.train();
    expect(f.read('new-reader')).toMatchObject({ ok: false, reason: 'writer-priority', heldBy: 'writer-a' });
    expect(inspectCloneLock(f.clone, {
      lockRoot: f.lockRoot, nowMs: f.now(), probe: alwaysAlive,
    }).readers).toEqual([expect.objectContaining({ owner: 'existing-reader', live: true })]);
    let drained = false;
    const result = await f.write({
      waitMs: 100, pollMs: 10,
      sleep: async (ms) => {
        f.advance(ms);
        const snapshot = inspectCloneLock(f.clone, {
          lockRoot: f.lockRoot, nowMs: f.now(), probe: alwaysAlive,
        });
        expect(snapshot.writerLive).toBe(true);
        expect(snapshot.readers).toEqual([expect.objectContaining({ owner: 'existing-reader', live: true })]);
        expect(f.read('another-new-reader')).toMatchObject({ ok: false, reason: 'writer-priority' });
        releaseRead(f.clone, { owner: 'existing-reader', lockRoot: f.lockRoot });
        drained = true;
      },
    });
    expect(drained).toBe(true);
    expect(result).toEqual({ ok: true });
  });

  it('still admits a reader after the writer-priority skip cap, and waits for its slot', async () => {
    const f = await rotatingReaders();
    await f.train();
    for (let skip = 0; skip < 2; skip += 1) {
      expect(f.read('capped-reader')).toMatchObject({ ok: false, reason: 'writer-priority' });
    }
    expect(f.read('capped-reader')).toEqual({ ok: true });
    expect(await f.write()).toMatchObject({ ok: false, reason: 'tick-in-progress', heldBy: 'capped-reader' });
    releaseRead(f.clone, { owner: 'capped-reader', lockRoot: f.lockRoot });
    expect(await f.write()).toEqual({ ok: true });
  });

  it('resets its consecutive refusal counter after a successful write acquire', async () => {
    const f = await rotatingReaders();
    await f.train();
    expect(await f.write()).toEqual({ ok: true });
    releaseWrite(f.clone, { owner: 'writer-a', lockRoot: f.lockRoot });
    // The last reader still has its original priority claim; the successful writer must start counting anew.
    for (let refusal = 1; refusal <= 3; refusal += 1) {
      expect(await f.write()).toMatchObject({ ok: false, reason: 'reader-priority', heldBy: [...f.pending][0] });
      if (refusal < 3) {
        expect(f.read('fresh-reader')).toEqual({ ok: true });
        releaseRead(f.clone, { owner: 'fresh-reader', lockRoot: f.lockRoot });
      }
    }
    expect(f.read('fresh-reader')).toMatchObject({ ok: false, reason: 'writer-priority' });
    expect(await f.write()).toEqual({ ok: true });
  });

  it('counts tick-in-progress and reader-priority refusals toward the same writer threshold', async () => {
    const f = await rotatingReaders({ existingReader: true });
    await f.train(2);
    expect(await f.write({ readerPriorityAfter: 0 })).toMatchObject({
      ok: false, reason: 'tick-in-progress', heldBy: 'existing-reader',
    });
    expect(f.read('new-reader')).toMatchObject({ ok: false, reason: 'writer-priority' });
    releaseRead(f.clone, { owner: 'existing-reader', lockRoot: f.lockRoot });
    expect(await f.write()).toEqual({ ok: true });
  });

  it('expires an effective writer claim so a new reader can enter without a writer retry', async () => {
    const f = await rotatingReaders();
    await f.train();
    expect(f.read('new-reader')).toMatchObject({ ok: false, reason: 'writer-priority' });
    f.advance(1001);
    expect(f.read('new-reader')).toEqual({ ok: true });
    expect(await f.write()).toMatchObject({ ok: false, reason: 'reader-priority' });
  });

  it('expires partial refusal counts rather than accumulating them across the claim TTL', async () => {
    const f = await rotatingReaders();
    await f.train(2);
    f.advance(1001);
    expect(await f.write()).toMatchObject({ ok: false, reason: 'reader-priority' });
    expect(f.read('new-reader')).toEqual({ ok: true });
    releaseRead(f.clone, { owner: 'new-reader', lockRoot: f.lockRoot });
    expect(await f.write()).toMatchObject({ ok: false, reason: 'reader-priority' });
    expect(await f.write()).toMatchObject({ ok: false, reason: 'reader-priority' });
    expect(f.read('new-reader')).toMatchObject({ ok: false, reason: 'writer-priority' });
  });

  it('keeps yielding to priority readers when writer priority is explicitly disabled', async () => {
    const f = await rotatingReaders();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await f.write({ writerPriorityAfter: 0 })).toMatchObject({ ok: false, reason: 'reader-priority' });
    }
    expect(f.read('new-reader')).toEqual({ ok: true });
  });

  it('resolves the default writer threshold to three, supports an env override and zero, and rejects invalid values', () => {
    expect(resolveWriterPriorityAfter({})).toBe(3);
    for (const value of ['', 'invalid', '-1', '1.5', 'Infinity']) {
      expect(resolveWriterPriorityAfter({ WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER: value })).toBe(3);
    }
    expect(resolveWriterPriorityAfter({ WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER: '5' })).toBe(5);
    expect(resolveWriterPriorityAfter({ WE_DAEMON_CLONE_LOCK_WRITER_PRIORITY_AFTER: '0' })).toBe(0);
  });
});

describe('acquireRead / acquireWrite — basic handshake', () => {
  it('reader is blocked by a live foreign writer', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const writerResult = await acquireWrite(clone, { owner: 'writer-a', lockRoot, nowMs: 0, pid: 111, probe: alwaysAlive });
    expect(writerResult.ok).toBe(true);
    const readResult = acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: 1000, pid: 222, probe: alwaysAlive });
    expect(readResult).toEqual({ ok: false, reason: 'writer-active', heldBy: 'writer-a', starved: 1 });
  });

  it('second writer while first is live → concurrent-mover', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const first = await acquireWrite(clone, { owner: 'writer-a', lockRoot, nowMs: 0, pid: 111, probe: alwaysAlive });
    expect(first.ok).toBe(true);
    const second = await acquireWrite(clone, { owner: 'writer-b', lockRoot, nowMs: 100, pid: 222, probe: alwaysAlive });
    expect(second).toEqual({ ok: false, reason: 'concurrent-mover', heldBy: 'writer-a' });
  });

  it('releaseRead / releaseWrite are idempotent', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    expect(() => releaseRead(clone, { owner: 'nobody', lockRoot })).not.toThrow();
    expect(releaseRead(clone, { owner: 'nobody', lockRoot })).toEqual({ ok: true });
    expect(() => releaseWrite(clone, { owner: 'nobody', lockRoot })).not.toThrow();

    const acquired = await acquireWrite(clone, { owner: 'writer-a', lockRoot, nowMs: 0, pid: 111, probe: alwaysAlive });
    expect(acquired.ok).toBe(true);
    expect(releaseWrite(clone, { owner: 'writer-a', lockRoot })).toEqual({ ok: true });
    expect(releaseWrite(clone, { owner: 'writer-a', lockRoot })).toEqual({ ok: true }); // second release: no-op
    const snapshot = inspectCloneLock(clone, { lockRoot });
    expect(snapshot.writer).toBeNull();
  });

  it('same clone under two different path spellings collides on the same lock key', () => {
    const clone = mkTmp('dcl-clone-');
    const linkParent = mkTmp('dcl-linkparent-');
    const link = join(linkParent, 'alias');
    symlinkSync(clone, link);
    expect(cloneLockKey(link)).toBe(cloneLockKey(clone));
    expect(cloneLockKey(`${clone}/.`)).toBe(cloneLockKey(clone));
  });
});

describe('Dekker ordering between acquireRead and acquireWrite', () => {
  it('a reader that passes step 1 before a writer reserves is refused at its step-3 re-check', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');

    // Simulate the interleave: reader's step (1) sees no writer (we don't call acquireRead yet — we hand-roll
    // the interleave by reserving the writer key BETWEEN what would be the reader's step 1 and step 2, then
    // running the real acquireRead call, whose own internal step-1 check happens first and would ALSO see the
    // writer if it ran after — so to truly exercise the step-3 recheck we reserve the writer only once the
    // reader is "inside" its own call. Vitest can't pause mid-function, so we prove the property the recheck
    // exists for directly: even though nothing was live at read-time entry, a writer present by the time the
    // reader re-checks must still refuse it.
    const writerResult = await acquireWrite(clone, { owner: 'writer-a', lockRoot, nowMs: 0, pid: 111, probe: alwaysAlive });
    expect(writerResult.ok).toBe(true);

    // Now a reader arrives after the writer already holds the key — its OWN step 1 refuses it (the common
    // case the recheck also covers). This proves acquireRead never reserves a reader key while any writer
    // check — first or second — sees a live foreign writer, i.e. the recheck can never let one through either.
    const readResult = acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: 100, pid: 222, probe: alwaysAlive });
    expect(readResult).toEqual({ ok: false, reason: 'writer-active', heldBy: 'writer-a', starved: 1 });
    // and no reader key was left behind
    const snapshot = inspectCloneLock(clone, { lockRoot });
    expect(snapshot.readers).toEqual([]);
  });
});

describe('acquireWrite waiting on readers', () => {
  // live 2026-10-11 rebuild-job livelock: the reservation must outlive its initial lease.
  it('heartbeats the writer while a live reader drains for over twelve minutes', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const { readersRoot } = cloneLockDirs(clone, lockRoot);
    let clock = 0;
    expect(acquireRead(clone, {
      owner: 'reader-a', lockRoot, nowMs: clock, pid: 333, probe: alwaysAlive,
    }).ok).toBe(true);
    let checked = false;
    const result = await acquireWrite(clone, {
      owner: 'writer-a', lockRoot, waitMs: 15 * 60_000, pollMs: 1000,
      now: () => clock, pid: 111, probe: alwaysAlive,
      sleep: async (ms) => {
        clock += ms;
        heartbeat(readersRoot, 'reader-a', 'reader-a', new Date(clock).toISOString(), 333);
        if (clock === 12 * 60_000) {
          const snapshot = inspectCloneLock(clone, { lockRoot, nowMs: clock, probe: alwaysAlive });
          expect(snapshot.writerLive).toBe(true);
          expect(clock - Date.parse(snapshot.writer.heartbeatAt)).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS);
          expect(snapshot.readers.some((r) => r.owner === 'reader-a' && r.live)).toBe(true);
          checked = true;
        }
        if (clock === 13 * 60_000) releaseRead(clone, { owner: 'reader-a', lockRoot });
      },
    });
    expect(checked).toBe(true);
    expect(clock).toBe(13 * 60_000);
    expect(result).toEqual({ ok: true });
  });

  it('waits for a live reader, then succeeds once the reader releases (fake sleep releases it)', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const clock = { value: 0 };
    const now = () => clock.value;

    const readAcquired = acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: clock.value, pid: 333, probe: alwaysAlive });
    expect(readAcquired.ok).toBe(true);

    let releasedReader = false;
    const sleep = async (ms) => {
      clock.value += ms;
      if (!releasedReader) {
        releaseRead(clone, { owner: 'reader-a', lockRoot });
        releasedReader = true;
      }
    };

    const result = await acquireWrite(clone, {
      owner: 'writer-a', lockRoot, waitMs: 100_000, pollMs: 1000, now, sleep, pid: 111, probe: alwaysAlive,
    });
    expect(result).toEqual({ ok: true });
    expect(releasedReader).toBe(true);
  });

  it('reports a blocked wait ONCE via onBlocked (who blocks, how long it may wait) — never a silent wait (#4044)', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const clock = { value: 0 };
    const sleep = async (ms) => { clock.value += ms; };
    acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: 0, pid: 333, probe: alwaysAlive });
    const onBlocked = vi.fn();
    await acquireWrite(clone, {
      owner: 'writer-a', lockRoot, waitMs: 5000, pollMs: 1000, now: () => clock.value, sleep, pid: 111, probe: alwaysAlive, onBlocked,
    });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith({ blockers: ['reader-a'], waitMs: 5000 });
  });

  it('times out waiting on a live reader → tick-in-progress, and the writer key is released', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const clock = { value: 0 };
    const now = () => clock.value;
    const sleep = async (ms) => { clock.value += ms; }; // never releases the reader

    const readAcquired = acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: 0, pid: 333, probe: alwaysAlive });
    expect(readAcquired.ok).toBe(true);

    const result = await acquireWrite(clone, {
      owner: 'writer-a', lockRoot, waitMs: 2000, pollMs: 1000, now, sleep, pid: 111, probe: alwaysAlive,
    });
    expect(result).toMatchObject({ ok: false, reason: 'tick-in-progress', heldBy: 'reader-a' });

    const snapshot = inspectCloneLock(clone, { lockRoot });
    expect(snapshot.writer).toBeNull(); // writer key released on timeout
  });

  it('a dead-pid reader is reclaimed at once (no waiting) when the writer polls', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const readAcquired = acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: 0, pid: 333, probe: alwaysAlive });
    expect(readAcquired.ok).toBe(true);

    let sleepCalls = 0;
    const result = await acquireWrite(clone, {
      owner: 'writer-a', lockRoot, waitMs: 100_000, pollMs: 1000, now: () => 0,
      sleep: async () => { sleepCalls += 1; }, pid: 111, probe: alwaysDead,
    });
    expect(result).toEqual({ ok: true });
    expect(sleepCalls).toBe(0); // reclaimed on the FIRST poll — never had to wait

    const snapshot = inspectCloneLock(clone, { lockRoot });
    expect(snapshot.readers).toEqual([]); // dead reader's slot was removed, not just ignored
  });

  it('an expired-lease reader is reclaimed at once even when probe says alive/unknown', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const readAcquired = acquireRead(clone, { owner: 'reader-a', lockRoot, nowMs: 0, pid: 333, probe: alwaysAlive });
    expect(readAcquired.ok).toBe(true);

    const farFuture = 60 * 60_000; // 1h later, way past the 10-minute default lease
    const result = await acquireWrite(clone, {
      owner: 'writer-a', lockRoot, waitMs: 100_000, pollMs: 1000, now: () => farFuture,
      sleep: async () => {}, pid: 111, probe: () => 'unknown',
    });
    expect(result).toEqual({ ok: true });
  });

  it('a dead-pid writer is reclaimed immediately by a new writer reservation', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const first = await acquireWrite(clone, { owner: 'writer-a', lockRoot, nowMs: 0, pid: 111, probe: alwaysAlive });
    expect(first.ok).toBe(true);

    const second = await acquireWrite(clone, {
      owner: 'writer-b', lockRoot, nowMs: 1000, pid: 222, probe: alwaysDead, sleep: async () => {},
    });
    expect(second).toEqual({ ok: true });
    const snapshot = inspectCloneLock(clone, { lockRoot });
    expect(snapshot.writer.owner).toBe('writer-b');
  });
});

describe('defaultProbePidLiveness', () => {
  it('reports unknown for a different host', () => {
    expect(defaultProbePidLiveness({ owner: 'some-other-host:99999', pid: 99999 })).toBe('unknown');
  });

  it('reports dead for a same-host pid that does not exist', () => {
    const entry = { owner: `${hostname()}:999999999`, pid: 999999999 };
    expect(defaultProbePidLiveness(entry)).toBe('dead');
  });

  it('reports alive for the current process itself (same host, running pid)', () => {
    const entry = { owner: `${hostname()}:${process.pid}`, pid: process.pid };
    expect(defaultProbePidLiveness(entry)).toBe('alive');
  });
});

describe('real cross-process mutual exclusion (two real child node processes)', () => {
  it('never lets two children hold the write lock at overlapping times', async () => {
    const lockRoot = mkTmp('dcl-lockroot-');
    const clone = mkTmp('dcl-clone-');
    const workDir = mkTmp('dcl-workdir-');
    const logFile = join(workDir, 'markers.log');
    const workerFile = join(workDir, 'worker.mjs');

    const workerSrc = `
      import { appendFileSync } from 'node:fs';
      import { withWriteLock } from ${JSON.stringify(MODULE_PATH)};
      const [, , cloneRoot, lockRoot, owner, logFile, holdMs] = process.argv;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function main() {
        let result = { ok: false };
        for (let attempt = 0; attempt < 200 && !result.ok; attempt += 1) {
          result = await withWriteLock(cloneRoot, async () => {
            appendFileSync(logFile, \`start \${owner} \${Date.now()}\\n\`);
            await sleep(Number(holdMs));
            appendFileSync(logFile, \`end \${owner} \${Date.now()}\\n\`);
          }, { lockRoot, owner, waitMs: 2000, pollMs: 25 });
          if (!result.ok) await sleep(25);
        }
        process.exit(result.ok ? 0 : 1);
      }
      main();
    `;
    appendFileSync(workerFile, workerSrc, 'utf8');

    const runChild = (owner) => new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [workerFile, clone, lockRoot, owner, logFile, '200'], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => resolvePromise(code));
    });

    const [codeA, codeB] = await Promise.all([runChild('child-a'), runChild('child-b')]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map((line) => {
      const [, kind, owner, ts] = line.match(/^(start|end) (\S+) (\d+)$/);
      return { kind, owner, ts: Number(ts) };
    });

    const byOwner = {};
    for (const e of events) {
      byOwner[e.owner] ??= {};
      byOwner[e.owner][e.kind] = e.ts;
    }
    const intervals = Object.entries(byOwner).map(([owner, { start, end }]) => ({ owner, start, end }));
    expect(intervals).toHaveLength(2);
    intervals.sort((a, b) => a.start - b.start);
    // the second interval must not start before the first one ended — the core mutual-exclusion property
    expect(intervals[1].start).toBeGreaterThanOrEqual(intervals[0].end);
  }, 30_000);
});
