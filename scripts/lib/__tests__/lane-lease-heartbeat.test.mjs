/**
 * @file lane-lease-heartbeat.test.mjs — RS-7179-1: the lease renewal timer, with negative cases first
 *   (merge-path checklist 4 and 7): no lease, torn lease, foreign owner, reserved lease.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renewLaneLeaseOnce, startLaneLeaseHeartbeat } from '../lane-lease-heartbeat.mjs';

const gitDir = () => mkdtempSync(join(tmpdir(), 'lease-hb-'));
const lease = { session: 'a', acquiredAt: '2026-11-25T00:00:00.000Z', ttlMinutes: 240 };
const put = (d, v) => writeFileSync(join(d, '.lane-lease'), typeof v === 'string' ? v : JSON.stringify(v));
const read = (d) => JSON.parse(readFileSync(join(d, '.lane-lease'), 'utf8'));
const at = new Date('2026-11-25T03:00:00.000Z');

describe('renewLaneLeaseOnce', () => {
  it('never creates a lease where none exists', () => {
    const d = gitDir();
    expect(renewLaneLeaseOnce({ cwd: 'x', gitDirFn: () => d, now: () => at })).toBe(false);
    expect(existsSync(join(d, '.lane-lease'))).toBe(false);
  });
  it('writes nothing for a torn or non-object lease', () => {
    const d = gitDir();
    put(d, '{"session":');
    expect(renewLaneLeaseOnce({ cwd: 'x', gitDirFn: () => d, now: () => at })).toBe(false);
    expect(readFileSync(join(d, '.lane-lease'), 'utf8')).toBe('{"session":');
    put(d, '[1]');
    expect(renewLaneLeaseOnce({ cwd: 'x', gitDirFn: () => d, now: () => at })).toBe(false);
  });
  it('never extends a lease now held by another owner', () => {
    const d = gitDir();
    put(d, { ...lease, session: 'b' });
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a|2026-11-25T00:00:00.000Z', gitDirFn: () => d, now: () => at })).toBe(false);
    expect(read(d).renewedAt).toBeUndefined();
  });
  it('leaves a reserved lease unchanged', () => {
    const d = gitDir();
    put(d, { ...lease, reserved: true });
    expect(renewLaneLeaseOnce({ cwd: 'x', gitDirFn: () => d, now: () => at })).toBe(false);
  });
  it('renews an owned lease atomically', () => {
    const d = gitDir();
    put(d, lease);
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a|2026-11-25T00:00:00.000Z', gitDirFn: () => d, now: () => at })).toBe(true);
    expect(read(d).renewedAt).toBe(at.toISOString());
    expect(readdirSync(d)).toEqual(['.lane-lease']);
  });
});

describe('startLaneLeaseHeartbeat', () => {
  it('renews on start and on each tick until stopped; skips checkouts without a lease', () => {
    const d = gitDir();
    const none = gitDir();
    put(d, lease);
    let tick; let cleared = false; let n = 0;
    const stop = startLaneLeaseHeartbeat({
      cwds: ['lane', 'plain'], gitDirFn: (c) => (c === 'lane' ? d : none),
      now: () => new Date(at.getTime() + (n++) * 1000),
      setIntervalFn: (fn) => { tick = fn; return {}; }, clearIntervalFn: () => { cleared = true; },
    });
    const first = read(d).renewedAt;
    tick();
    expect(read(d).renewedAt).not.toBe(first);
    expect(existsSync(join(none, '.lane-lease'))).toBe(false);
    stop();
    expect(cleared).toBe(true);
  });
  it('is a no-op stop when no checkout has a lease', () => {
    const stop = startLaneLeaseHeartbeat({ cwds: ['x'], gitDirFn: () => gitDir() });
    expect(() => stop()).not.toThrow();
  });
});
