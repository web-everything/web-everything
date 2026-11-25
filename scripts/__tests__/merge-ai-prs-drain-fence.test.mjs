/**
 * @file scripts/__tests__/merge-ai-prs-drain-fence.test.mjs
 * @description BLUE-GREEN-SWAP S1.2 — the per-merge fence re-read (FLOW-DMN-012/013/014/015).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDrainLease, handoverDrainLease } from '../readiness/drain-lock.mjs';
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

  it('an unreadable or absent lease refuses (lease-unknown)', () => {
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1 })).toMatchObject({ ok: false, reason: 'lease-unknown' });
    expect(checkDrainFence({ lockRoot: root, owner: 'blue', fence: 1, read: () => { throw new Error('boom'); } })).toMatchObject({ ok: false, reason: 'lease-unknown' });
  });
});
