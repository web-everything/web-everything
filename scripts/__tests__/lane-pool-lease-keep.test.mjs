import { beforeEach, afterEach, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { leasePool, renewalRace } from '../conveyor/soak/breaks/lease-keeps-while-renewed.mjs';
import { journalLaneEvent } from '../lib/lane-history.mjs';
let pool;
beforeEach(() => { pool = leasePool(); });
afterEach(() => pool.close());
const acquire = (...args) => pool.run('acquire', '--session=worker', '--no-reset', '--no-reap', ...args);
const lease = () => JSON.parse(readFileSync(pool.marker, 'utf8'));
it('clamps a short requested TTL and stores at least 240 minutes with a warning', () => {
  const r = acquire('--ttl-minutes=30');
  expect(r.status, r.stderr).toBe(0);
  expect(lease().ttlMinutes).toBe(240);
  expect(r.stderr).toMatch(/WARNING.*30.*240/);
});
it('exact-ttl preserves an explicitly requested 30 minutes', () => {
  const r = acquire('--ttl-minutes=30', '--exact-ttl');
  expect(r.status, r.stderr).toBe(0);
  expect(lease().ttlMinutes).toBe(30);
});
it('reserved leases remain permanent with unchanged TTL metadata', () => {
  const r = acquire('--ttl-minutes=30', '--reserve');
  expect(r.status, r.stderr).toBe(0);
  expect(lease().reserved).toBe(true);
  expect(lease().ttlMinutes).toBe(30);
});
it('release without a marker names the expired session and takeover timestamp', () => {
  writeFileSync(pool.marker, JSON.stringify({ session: 'expired-worker', acquiredAt: '2020-01-01T00:00:00Z' }));
  expect(acquire().status).toBe(0);
  rmSync(pool.marker);
  const r = pool.run('release', '--session=expired-worker');
  expect(r.stdout + r.stderr).toMatch(/no lease to release \(lease expired-worker expired and was taken over at \d{4}-/);
});
it('does not invent expiry when history is absent or a later release supersedes it', () => {
  journalLaneEvent(pool.dir, { action: 'lease-expire', leaseSession: 'old' });
  journalLaneEvent(pool.dir, { action: 'release', leaseSession: 'new' });
  const r = pool.run('release');
  expect(r.stdout + r.stderr).not.toMatch(/expired and/);
});
it('stale reclaim preserves a lease renewed after the stale verdict', async () => {
  const r = await renewalRace(pool);
  expect(r.actual).toEqual(r.expected);
  expect(r.code).not.toBe(0);
});
it('malformed renewal evidence refuses stale takeover', async () => {
  const r = await renewalRace(pool, 'malformed');
  expect(r.actual).toEqual(r.expected);
  expect(r.code).not.toBe(0);
});
it('owner release still succeeds after its own renewal', () => {
  expect(acquire().status).toBe(0);
  writeFileSync(pool.marker, JSON.stringify({ ...lease(), renewedAt: new Date().toISOString() }));
  const r = pool.run('release', '--session=worker');
  expect(r.status, r.stderr).toBe(0);
  expect(() => readFileSync(pool.marker)).toThrow();
});
it('missing or unreadable history gives only the plain missing-lease message', () => {
  writeFileSync(pool.dir + '/.git/lane-history.jsonl', 'malformed history');
  const r = pool.run('release');
  expect(r.stdout + r.stderr).toContain('lane-1: no lease to release');
  expect(r.stdout + r.stderr).not.toContain('expired and');
});
