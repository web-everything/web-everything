/**
 * @file scripts/readiness/__tests__/drain-lock-handover.test.mjs
 * @description BLUE-GREEN-SWAP S1.2 — fenced drain-lease handover (FLOW-DMN-012/013/046/048). Real temp lock root.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDirFor } from '../file-locks.mjs';
import {
  DRAIN_LEASE_PATH, acquireDrainLease, heartbeatDrainLease, releaseDrainLease, drainLeaseStatus, handoverDrainLease, readDrainFence, drainMutexDirFor,
} from '../drain-lock.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'drain-handover-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('fenced drain-lease handover', () => {
  it('a fresh lease starts at fence 1 and survives heartbeats', () => {
    expect(acquireDrainLease(root, 'blue', { pid: 11 }).ok).toBe(true);
    expect(readDrainFence(root)).toBe(1);
    expect(heartbeatDrainLease(root, 'blue', { pid: 11 })).toBe(true);
    expect(readDrainFence(root)).toBe(1);
  });

  it('hands over at expectFence, raising the fence, with no free window', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    const r = handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1, gen: 2, codeDigest: 'd2' });
    expect(r).toMatchObject({ ok: true, fence: 2 });
    const st = drainLeaseStatus(root);
    expect(st).toMatchObject({ held: true, owner: 'green' });
    expect(readDrainFence(root)).toBe(2);
    const entry = JSON.parse(readFileSync(join(lockDirFor(root, DRAIN_LEASE_PATH), 'lock.json'), 'utf8'));
    expect(entry.meta.handover).toMatchObject({ from: 'blue', fromFence: 1, gen: 2, codeDigest: 'd2' });
    expect(heartbeatDrainLease(root, 'green', { pid: 22 })).toBe(true);
    expect(readDrainFence(root)).toBe(2);
  });

  it('a handover with a stale expectFence is refused and leaves the entry unchanged', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    const before = readFileSync(join(lockDirFor(root, DRAIN_LEASE_PATH), 'lock.json'), 'utf8');
    const r = handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 7 });
    expect(r).toMatchObject({ ok: false, reason: 'fence-mismatch' });
    expect(readFileSync(join(lockDirFor(root, DRAIN_LEASE_PATH), 'lock.json'), 'utf8')).toBe(before);
  });

  it('a handover from a non-owner or on an absent lease is refused', () => {
    expect(handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 })).toMatchObject({ ok: false, reason: 'no-lease' });
    acquireDrainLease(root, 'other', { pid: 5 });
    expect(handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 })).toMatchObject({ ok: false, reason: 'not-owner' });
  });

  it("after handover the old owner's heartbeat and release return false", () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 });
    expect(heartbeatDrainLease(root, 'blue', { pid: 11 })).toBe(false);
    expect(releaseDrainLease(root, 'blue')).toBe(false);
    expect(drainLeaseStatus(root).owner).toBe('green');
  });

  it('rollback is the same call in reverse and the fence never goes down', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 });
    const back = handoverDrainLease(root, { from: 'green', to: 'blue', toPid: 11, expectFence: 2 });
    expect(back).toMatchObject({ ok: true, fence: 3 });
    expect(drainLeaseStatus(root).owner).toBe('blue');
  });

  it('a concurrent acquireDrainLease during the handover never succeeds', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    let during = null;
    const r = handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 }, { beforeRename: () => { during = acquireDrainLease(root, 'intruder', { pid: 99 }); } });
    expect(r.ok).toBe(true);
    expect(during.ok).toBe(false);
    expect(drainLeaseStatus(root).owner).toBe('green');
  });

  it('appends handovers.jsonl ordered by fence after the CAS verifies', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1, gen: 2 });
    const lines = readFileSync(join(root, 'handovers.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ from: 'blue', to: 'green', fence: 2 });
  });
});

describe('round 3 — one lock, expiry, durable fence floor', () => {
  it('a competing handover during the first is refused (one lock, no read-then-rename window)', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    let inner = null;
    const r = handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 }, { beforeRename: () => { inner = handoverDrainLease(root, { from: 'blue', to: 'rival', toPid: 33, expectFence: 1, mutexWaitMs: 30 }); } });
    expect(r).toMatchObject({ ok: true, fence: 2 });
    expect(inner).toMatchObject({ ok: false, reason: 'mutex-busy' });
    expect(drainLeaseStatus(root).owner).toBe('green');
  });

  it('heartbeat, release and acquire refuse while the drain mutex is held', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    mkdirSync(drainMutexDirFor(root));
    expect(heartbeatDrainLease(root, 'blue', { pid: 11, mutexWaitMs: 20 })).toBe(false);
    expect(releaseDrainLease(root, 'blue', { mutexWaitMs: 20 })).toBe(false);
    expect(handoverDrainLease(root, { from: 'blue', to: 'g', expectFence: 1, mutexWaitMs: 20 })).toMatchObject({ ok: false, reason: 'mutex-busy' });
    expect(acquireDrainLease(root, 'other', { pid: 5, mutexWaitMs: 20 })).toMatchObject({ ok: false });
  });

  it('a crashed holder\'s stale mutex is reclaimed', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    const m = drainMutexDirFor(root);
    mkdirSync(m);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(m, old, old);
    expect(handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 })).toMatchObject({ ok: true });
  });

  it('a handover from an expired lease is refused', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    const r = handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1, nowMs: Date.now() + 3 * 3600_000 });
    expect(r).toMatchObject({ ok: false, reason: 'lease-expired' });
  });

  it('the fence never resets after a release (durable floor)', () => {
    acquireDrainLease(root, 'blue', { pid: 11 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 22, expectFence: 1 });
    expect(releaseDrainLease(root, 'green')).toBe(true);
    acquireDrainLease(root, 'blue', { pid: 11 });
    expect(readDrainFence(root)).toBe(3);
  });
});
