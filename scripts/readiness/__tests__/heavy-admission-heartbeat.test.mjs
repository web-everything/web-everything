/**
 * @file heavy-admission-heartbeat.test.mjs — a live slot holder refreshes its lease (verify-admission, 2026-10-20).
 * Before: the slot lease was a fixed 60-min TTL, so a gate still running past it was reclaimed by the next waiter
 * and kept running unslotted (12 concurrent verify-lanes, `heavy-queue` showing 0 held).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireSlot, heartbeatOwnedSlot, slotPath } from '../heavy-admission.mjs';
import { readLockEntry, reclaimDecision } from '../file-locks.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const root = () => { const r = mkdtempSync(join(tmpdir(), 'heavy-hb-')); roots.push(r); return r; };
const OWNER = '/x/.lanes/web-everything/lane-7';

describe('heartbeatOwnedSlot', () => {
  it('keeps a long-running holder from being reclaimed by lease expiry', () => {
    const lockRoot = root();
    const t0 = Date.parse('2026-10-20T10:00:00.000Z');
    expect(tryAcquireSlot({ lockRoot, cap: 2, owner: OWNER, nowMs: t0, nowIso: new Date(t0).toISOString(), pid: process.pid }).ok).toBe(true);
    const later = t0 + 90 * 60_000; // past the 60-min lease
    // Without a heartbeat the next waiter may seize the live holder's slot.
    expect(reclaimDecision(readLockEntry(lockRoot, slotPath(0)), later, 'other', 'alive', 60).acquirable).toBe(true);
    expect(heartbeatOwnedSlot({ lockRoot, cap: 2, owner: OWNER, pid: process.pid, nowIso: new Date(later - 60_000).toISOString(), fastSlots: 1 })).toBe(0);
    expect(reclaimDecision(readLockEntry(lockRoot, slotPath(0)), later, 'other', 'alive', 60)).toMatchObject({ acquirable: false, reason: 'held' });
  });

  it('never refreshes a slot held by a different process under the same owner string, and is a no-op with no slot', () => {
    const lockRoot = root();
    const now = Date.now();
    expect(tryAcquireSlot({ lockRoot, cap: 2, owner: OWNER, nowMs: now, nowIso: new Date(now).toISOString(), pid: 999_999_1 }).ok).toBe(true);
    expect(heartbeatOwnedSlot({ lockRoot, cap: 2, owner: OWNER, pid: process.pid, fastSlots: 1 })).toBe(null);
    expect(heartbeatOwnedSlot({ lockRoot: root(), cap: 2, owner: OWNER, pid: process.pid, fastSlots: 1 })).toBe(null);
  });
});

describe('admissionLockRoot outside the workspace (verify-admission, 2026-10-20)', () => {
  it('falls back to the running checkout pool when the cwd-derived pool does not exist (heavy-queue read 0/0 from ~)', async () => {
    const { admissionLockRoot } = await import('../heavy-admission.mjs');
    const env = { HOME: '/home/u' };
    const own = '/home/u/workspace/.lanes/web-everything/lane-3';
    const exists = (p) => p === '/home/u/workspace/.lanes';
    expect(admissionLockRoot('/home/u', env, { ownCheckout: own, exists })).toBe(join('/home/u/workspace/.lanes', '.admission', 'heavy'));
    // A pool that exists where the caller is, an explicit LANE_POOL_ROOT, or a test env keep their own root.
    expect(admissionLockRoot('/srv/ws/proj', env, { ownCheckout: own, exists: () => true })).toBe(join('/srv/ws/.lanes', '.admission', 'heavy'));
    expect(admissionLockRoot('/home/u', { ...env, LANE_POOL_ROOT: '/p' }, { ownCheckout: own, exists })).toBe(join('/p', '.admission', 'heavy'));
    expect(admissionLockRoot('/home/u', { ...env, VITEST: 'true' }, { ownCheckout: own, exists })).toBe(join('/home/.lanes', '.admission', 'heavy'));
  });
});
