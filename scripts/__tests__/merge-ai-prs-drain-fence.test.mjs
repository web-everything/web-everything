/**
 * @file scripts/__tests__/merge-ai-prs-drain-fence.test.mjs
 * @description BLUE-GREEN-SWAP S1.2 — the per-merge fence re-read (FLOW-DMN-012/013/014/015).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDrainLease, handoverDrainLease, heartbeatDrainLease, releaseDrainLease } from '../readiness/drain-lock.mjs';
import { checkDrainFence } from '../readiness/drain-fence.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'drain-fence-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('checkDrainFence', () => {
  it('no fence declared means no check (legacy under-lease child)', () => {
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: null })).toEqual({ ok: true, skipped: true });
  });

  it('allows a merge while owner and fence match', () => {
    acquireDrainLease(root, 'blue', { pid: 1 });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1 })).toMatchObject({ ok: true });
  });

  it('a pass started at fence f does not merge after the lease moves to f+1', () => {
    acquireDrainLease(root, 'blue', { pid: 1 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 2, expectFence: 1 });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1 })).toMatchObject({ ok: false, reason: 'owner-changed' });
  });

  it('a stored fence greater than ours refuses even for the same owner (rollback case)', () => {
    acquireDrainLease(root, 'blue', { pid: 1 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 2, expectFence: 1 });
    handoverDrainLease(root, { from: 'green', to: 'blue', toPid: 1, expectFence: 2 });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1 })).toMatchObject({ ok: false, reason: 'fence-advanced' });
  });

  it('refuses a future/mismatched fence, a malformed fence, and an expired lease', () => {
    acquireDrainLease(root, 'blue', { pid: 1 });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 999 })).toMatchObject({ ok: false, reason: 'fence-mismatch' });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: NaN })).toMatchObject({ ok: false });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: -1 })).toMatchObject({ ok: false });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1, nowMs: Date.now() + 3 * 3600_000 })).toMatchObject({ ok: false, reason: 'lease-expired' });
  });

  it('heartbeat and release with a stale expectFence are refused', () => {
    acquireDrainLease(root, 'blue', { pid: 1 });
    handoverDrainLease(root, { from: 'blue', to: 'green', toPid: 2, expectFence: 1 });
    handoverDrainLease(root, { from: 'green', to: 'blue', toPid: 1, expectFence: 2 });
    expect(heartbeatDrainLease(root, 'blue', { pid: 1, expectFence: 1 })).toBe(false);
    expect(releaseDrainLease(root, 'blue', { expectFence: 1 })).toBe(false);
    expect(heartbeatDrainLease(root, 'blue', { pid: 1, expectFence: 3 })).toBe(true);
  });

  it('an unreadable or absent lease refuses (lease-unknown)', () => {
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1 })).toMatchObject({ ok: false, reason: 'lease-unknown' });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1, read: () => { throw new Error('boom'); } })).toMatchObject({ ok: false, reason: 'lease-unknown' });
  });
});
