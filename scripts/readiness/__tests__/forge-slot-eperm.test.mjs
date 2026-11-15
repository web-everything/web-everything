/**
 * @file scripts/readiness/__tests__/forge-slot-eperm.test.mjs
 * @description Reclaiming a dead Forge slot lock renames it to a tombstone. When the caller may not rename
 *   OUTSIDE the lock root (sandboxed workers: EPERM), the reclaim must not throw (that sent the run to the Mac,
 *   reason remote-slot-unreadable). It retries inside the lock root, and when even that is refused it leaves the
 *   lock standing (fail closed) so the caller moves on to another Forge slot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserve, releaseLockDirIf, readLockEntry, lockDirFor } from '../file-locks.mjs';

const T0 = Date.parse('2026-11-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
let parent, root;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'forge-eperm-'));
  root = join(parent, 'remote'); mkdirSync(root);
});
afterEach(() => { chmodSync(parent, 0o755); chmodSync(root, 0o755); rmSync(parent, { recursive: true, force: true }); });
// The sandbox case: the lock root is writable, its parent (where the sibling tombstone goes) is not.
const denyOutside = () => chmodSync(parent, 0o555);
const denyAll = () => { chmodSync(parent, 0o555); chmodSync(root, 0o555); };

describe('forge slot reclaim under rename EPERM', () => {
  it('reclaims a dead owner in-root when renames outside the lock root are denied (no Mac fallback)', () => {
    expect(reserve(root, 'slot-0', 'dead-owner', T0, iso(T0), 111).ok).toBe(true);
    denyOutside();
    const r = reserve(root, 'slot-0', 'new-owner', T0 + 1000, iso(T0 + 1000), 222, 'dead');
    expect(r.ok).toBe(true);
    expect(readLockEntry(root, 'slot-0').owner).toBe('new-owner');
    expect(readdirSync(root).filter((n) => n.includes('gone'))).toEqual([]);
    chmodSync(parent, 0o755);
    expect(readdirSync(parent).filter((n) => n.includes('gone'))).toEqual([]);
  });

  it('fails closed (lock untouched, no throw) when every rename is refused, so the caller tries another slot', () => {
    reserve(root, 'slot-0', 'dead-owner', T0, iso(T0), 111);
    denyAll();
    let r;
    expect(() => { r = reserve(root, 'slot-0', 'new-owner', T0 + 1000, iso(T0 + 1000), 222, 'dead'); }).not.toThrow();
    expect(r.ok).toBe(false);
    expect(readLockEntry(root, 'slot-0').owner).toBe('dead-owner');
  });

  it('never reclaims a live owner, and never moves its dir', () => {
    reserve(root, 'slot-0', 'live-owner', T0, iso(T0), 111);
    denyOutside();
    const r = reserve(root, 'slot-0', 'new-owner', T0 + 1000, iso(T0 + 1000), 222, 'alive');
    expect(r.ok).toBe(false);
    expect(readLockEntry(root, 'slot-0').owner).toBe('live-owner');
  });

  it('two reclaimers of the same dead entry: exactly one wins (renames outside the lock root denied)', () => {
    reserve(root, 'slot-0', 'dead-owner', T0, iso(T0), 111);
    denyOutside();
    const seen = readLockEntry(root, 'slot-0');
    const first = releaseLockDirIf(root, 'slot-0', seen);
    const second = releaseLockDirIf(root, 'slot-0', seen);
    expect([first, second]).toEqual([true, false]);
    expect(existsSync(lockDirFor(root, 'slot-0'))).toBe(false);
  });
});
