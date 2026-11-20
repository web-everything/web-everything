// @vitest-environment node
const reservationBarrier = vi.hoisted(() => ({ hook: null }));
vi.mock('../file-locks.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, reserve: (...args) => {
    if (args[1] === 'slot-0' && args[2] === 'first') reservationBarrier.hook?.();
    return actual.reserve(...args);
  } };
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { reserve, readLockEntry, lockDirFor, releaseLockDir } from '../file-locks.mjs';
import { tryAcquireSlot, releaseOwnedSlot, heartbeatOwnedSlot, admissionStatus, heldSlots, slotPath } from '../heavy-admission.mjs';

let root;
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'capacity-shrink-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const hold = slot => reserve(root, slotPath(slot), 'old-holder', nowMs, nowIso, process.pid);
const acquire = cap => tryAcquireSlot({ lockRoot: root, cap, owner: 'new-holder', pid: process.pid, nowMs, nowIso });

describe('capacity shrinks with existing high-index holders', () => {
  it('concurrent acquisitions after shrink never exceed the resolved cap', async () => {
    hold(255);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { tryAcquireSlot } from ${JSON.stringify(new URL('../heavy-admission.mjs', import.meta.url).href)};
      parentPort.once('message', () => {
        const at = Date.now();
        const result = tryAcquireSlot({ lockRoot: workerData.root, cap: 2, owner: 'second', nowMs: at, nowIso: new Date(at).toISOString() });
        parentPort.postMessage(result);
        const signal = new Int32Array(workerData.signal);
        Atomics.store(signal, 0, 1);
        Atomics.notify(signal, 0);
      });
      parentPort.postMessage('ready');
    `)), { workerData: { root, signal: signal.buffer } });
    try {
      expect((await once(worker, 'message'))[0]).toBe('ready');
      const secondResult = once(worker, 'message');
      // Pause the first caller after its occupancy snapshot, immediately before slot reservation.
      reservationBarrier.hook = () => {
        reservationBarrier.hook = null;
        worker.postMessage('acquire');
        Atomics.wait(signal, 0, 0, 5000);
        expect(Atomics.load(signal, 0), 'competing acquisition completed at the barrier').toBe(1);
      };
      const first = tryAcquireSlot({ lockRoot: root, cap: 2, owner: 'first', nowMs, nowIso });
      const [second] = await secondResult;
      expect([first, second].filter(r => r.ok)).toHaveLength(1);
      expect(heldSlots({ lockRoot: root, cap: 2 })).toHaveLength(2);
    } finally {
      reservationBarrier.hook = null;
      await worker.terminate();
    }
  });
  it('refuses a live pool arbiter regardless of age and retries after release', () => {
    const key = '<admission:slot-acquisition>';
    const old = nowMs - 600_000;
    reserve(join(root, '.acquisition'), key, `${hostname()}:${process.pid}:deadbeef`, old, new Date(old).toISOString(), process.pid);
    expect(acquire(1)).toMatchObject({ ok: false, reason: 'pool-busy' });
    expect(heldSlots({ lockRoot: root, cap: 1 })).toHaveLength(0);
    releaseLockDir(join(root, '.acquisition'), key);
    expect(acquire(1).ok).toBe(true);
  });
  it('refuses incomplete pool arbitration evidence without reserving a slot', () => {
    const dir = lockDirFor(join(root, '.acquisition'), '<admission:slot-acquisition>');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lock.json'), '{');
    expect(acquire(1)).toMatchObject({ ok: false, reason: 'pool-busy' });
    expect(heldSlots({ lockRoot: root, cap: 1 })).toHaveLength(0);
  });
  it('releases pool arbitration when slot reservation throws', () => {
    reservationBarrier.hook = () => { throw new Error('reservation failed'); };
    try {
      expect(() => tryAcquireSlot({ lockRoot: root, cap: 2, owner: 'first', nowMs, nowIso })).toThrow('reservation failed');
    } finally { reservationBarrier.hook = null; }
    expect(acquire(1).ok).toBe(true);
  });
  it('counts holders through the previous hard ceiling before admitting into lower slots', () => {
    hold(255);
    expect(acquire(1)).toMatchObject({ ok: false, heldBy: [{ slot: 255, owner: 'old-holder' }] });
    expect(readLockEntry(root, slotPath(0))).toBeNull();
    expect(admissionStatus({ lockRoot: root, cap: 1 })).toMatchObject({ heldCount: 1, freeCount: 0, heavyFreeCount: 0 });
    expect(acquire(2)).toMatchObject({ ok: true, slot: 0 });
    expect(tryAcquireSlot({ lockRoot: root, cap: 2, owner: 'third', nowMs, nowIso }).ok).toBe(false);
  });
  it.each([255, 299])('status, heartbeat and release still find slot %s after shrink', slot => {
    hold(slot);
    const options = { lockRoot: root, cap: slot === 299 ? 300 : 1, fastSlots: 0 };
    expect(admissionStatus(options)).toMatchObject({ heldCount: 1, held: [{ slot, owner: 'old-holder' }] });
    expect(heartbeatOwnedSlot({ ...options, owner: 'old-holder', nowIso })).toBe(slot);
    expect(releaseOwnedSlot({ ...options, owner: 'old-holder' })).toEqual({ released: true, slot });
    expect(acquire(1).ok).toBe(true);
  });
  it('retired holders consume heavy capacity while current fast slots retain their allowance', () => {
    hold(255);
    reserve(root, slotPath(2), 'fast-holder', nowMs, nowIso, process.pid);
    expect(tryAcquireSlot({ lockRoot: root, cap: 2, slotSpan: 3, owner: 'heavy', nowMs, nowIso })).toMatchObject({ ok: true, slot: 0 });
    expect(tryAcquireSlot({ lockRoot: root, cap: 2, slotSpan: 3, owner: 'another-heavy', nowMs, nowIso }).ok).toBe(false);
    expect(tryAcquireSlot({ lockRoot: root, cap: 2, slotSpan: 3, slots: [2, 0, 1], owner: 'short', nowMs, nowIso }).ok).toBe(false);
  });
  it('preserves re-acquisition of a legacy same-owner slot without a recorded PID', () => {
    reserve(root, slotPath(0), 'new-holder', nowMs, nowIso, null);
    expect(acquire(1)).toMatchObject({ ok: true, slot: 0 });
  });
  it('a high holder that has died does not block lower-slot admission', () => {
    reserve(root, slotPath(255), 'dead-holder', nowMs, nowIso, 2147483647);
    expect(acquire(1).ok).toBe(true);
  });
});
