/**
 * @file lane-lease-heartbeat.test.mjs — RS-7179-1: the lease renewal timer, with negative cases first
 *   (merge-path checklist 4 and 7): no lease, torn lease, foreign owner, reserved lease.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(existsSync(join(d, '.lane-lease'))).toBe(false);
  });
  it('writes nothing for a torn or non-object lease', () => {
    const d = gitDir();
    put(d, '{"session":');
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(readFileSync(join(d, '.lane-lease'), 'utf8')).toBe('{"session":');
    put(d, '[1]');
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
  });
  it('never extends a lease now held by another owner', () => {
    const d = gitDir();
    put(d, { ...lease, session: 'b' });
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a||2026-11-25T00:00:00.000Z', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(read(d).renewedAt).toBeUndefined();
  });
  it('leaves a reserved lease unchanged', () => {
    const d = gitDir();
    put(d, { ...lease, reserved: true });
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
  });
  it('refuses an identityless record, a changed holder and an expired lease', () => {
    const d = gitDir();
    put(d, { foo: 1 });
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    put(d, { ...lease, holder: 'h2' });
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a|h1|2026-11-25T00:00:00.000Z', leaseDirFn: () => d, now: () => at })).toBe(false);
    put(d, { ...lease, ttlMinutes: 10 });
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at })).toBe(false);
    expect(read(d).renewedAt).toBeUndefined();
  });
  it('does not overwrite a lease replaced during the write', () => {
    const d = gitDir();
    put(d, lease);
    const fs = {
      existsSync, readFileSync, rmSync: (p, o) => rmSync(p, o), renameSync: () => { throw new Error('must not rename'); },
      writeFileSync: (p, data, o) => { writeFileSync(p, data, o); put(d, { ...lease, session: 'other' }); },
    };
    expect(renewLaneLeaseOnce({ cwd: 'x', leaseDirFn: () => d, now: () => at, fs })).toBe(false);
    expect(read(d).session).toBe('other');
  });
  it('renews an owned lease atomically', () => {
    const d = gitDir();
    put(d, lease);
    expect(renewLaneLeaseOnce({ cwd: 'x', owner: 'a||2026-11-25T00:00:00.000Z', leaseDirFn: () => d, now: () => at })).toBe(true);
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
      cwds: ['lane', 'plain'], leaseDirFn: (c) => (c === 'lane' ? d : none),
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
  it('beats at most every third of a short ttl and warns once when the lease is lost', () => {
    const d = gitDir();
    put(d, { ...lease, ttlMinutes: 3 });
    const warns = []; let period;
    startLaneLeaseHeartbeat({
      cwds: ['lane'], leaseDirFn: () => d, now: () => new Date('2026-11-25T00:00:30.000Z'), warn: (l) => warns.push(l),
      setIntervalFn: (fn, ms) => { period = ms; rmSync(join(d, '.lane-lease')); fn(); fn(); return {}; }, clearIntervalFn: () => {},
    });
    expect(period).toBe(60_000);
    expect(warns).toHaveLength(1);
  });
  it('is a no-op stop when no checkout has a lease', () => {
    const stop = startLaneLeaseHeartbeat({ cwds: ['x'], leaseDirFn: () => gitDir() });
    expect(() => stop()).not.toThrow();
  });
});
