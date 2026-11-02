import { describe, it, expect } from 'vitest';
import { hostname } from 'node:os';
import { buildLeaseIsLive, processStartMs } from '../daemon-rebuild/lease.mjs';

const nowMs = Date.parse('2026-11-01T20:00:00Z');
const startedAt = new Date(nowMs - 60_000).toISOString();
const lease = (pid) => ({ host: hostname(), pid, token: 't', startedAt });
const OTHER = process.pid + 1; // never === process.pid; liveness comes from process.kill, so use a real live pid
const livePid = process.ppid;

describe('buildLeaseIsLive pid-reuse guard', () => {
  it('treats a live pid that started AFTER the lease as dead (reused pid)', () => {
    const startTimeOf = () => nowMs - 10_000;
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf })).toBe(false);
  });
  it('keeps a live pid that started before the lease alive', () => {
    const startTimeOf = () => nowMs - 3_600_000;
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf })).toBe(true);
  });
  it('fails closed: an unreadable start time keeps the lease live', () => {
    expect(buildLeaseIsLive(lease(livePid), { nowMs, startTimeOf: () => null })).toBe(true);
  });
  it('processStartMs reads a real start time for this process and null for a bogus pid', () => {
    const t = processStartMs(process.pid);
    expect(Number.isFinite(t)).toBe(true);
    expect(Math.abs(Date.now() - t)).toBeLessThan(24 * 3_600_000);
    expect(processStartMs(0)).toBe(null);
  });
});
