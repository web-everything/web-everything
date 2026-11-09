// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { foreignHostDead, foreignHostStaleMs, foreignStaleOwnerDead } from '../red-team-foreign-host-stale.mjs';

const now = 10_000_000, st = { host: 'old' };
it('foreign + stale is dead', () => expect(foreignHostDead(st, { host: 'new', statusAt: now - 1_800_001, now })).toBe(true));
it('foreign + fresh is live', () => expect(foreignHostDead(st, { host: 'new', statusAt: now - 60_000, now })).toBe(false));
it('same host is never judged here', () => expect(foreignHostDead(st, { host: 'old', statusAt: 1, now })).toBe(false));
it('unreadable timestamp holds', () => {
  for (const statusAt of [0, NaN, undefined]) expect(foreignHostDead(st, { host: 'new', statusAt, now })).toBe(false);
});
it('setting parses, bad value falls back to 30 min', () => {
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '900000' })).toBe(900000);
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '0' })).toBe(600000);
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: 'x' })).toBe(1_800_000);
  expect(foreignHostStaleMs({})).toBe(1_800_000);
});
it('any value below the 10 minute floor is raised to it', () => {
  for (const v of ['1', '60000', '599999']) expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: v })).toBe(600_000);
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '600001' })).toBe(600_001);
});

// The shared stale-owner decision used by both the evidence reader and the recovery planner.
describe('foreignStaleOwnerDead', () => {
  const rec = { host: 'old', pid: 42, pidStart: 'birth-a', pidNamespace: 'ns' };
  const opts = (patch = {}) => ({ host: 'new', namespace: 'ns', statusAt: now - 1_800_001, now, isAlive: () => false, readPidStart: () => 'birth-a', ...patch });
  it('is dead when stale, same namespace and the pid is gone', () => expect(foreignStaleOwnerDead(rec, opts())).toBe(true));
  it('never judges a record that names this host', () => expect(foreignStaleOwnerDead(rec, opts({ host: 'old' }))).toBe(false));
  it('honours the stale window setting', () => {
    const env = { WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '900000' };
    expect(foreignStaleOwnerDead(rec, opts({ statusAt: now - 1_000_000, env }))).toBe(true);
    expect(foreignStaleOwnerDead(rec, opts({ statusAt: now - 800_000, env }))).toBe(false);
  });
  it('treats an undefined recorded namespace like a null one', () => {
    expect(foreignStaleOwnerDead({ ...rec, pidNamespace: undefined }, opts({ namespace: 'other' }))).toBe(true);
  });
  it('holds a fresh record', () => expect(foreignStaleOwnerDead(rec, opts({ statusAt: now - 60_000 }))).toBe(false));
  it('holds a record from another pid namespace, without probing', () => {
    const isAlive = vi.fn(() => false);
    expect(foreignStaleOwnerDead(rec, opts({ namespace: 'other', isAlive }))).toBe(false);
    expect(isAlive).not.toHaveBeenCalled();
  });
  it('treats a record with no recorded namespace as probeable', () => expect(foreignStaleOwnerDead({ ...rec, pidNamespace: null }, opts())).toBe(true));
  it('holds while the pid is alive here with the recorded birth time', () => expect(foreignStaleOwnerDead(rec, opts({ isAlive: () => true }))).toBe(false));
  it('holds while the pid is alive here and the record has no birth time', () => {
    expect(foreignStaleOwnerDead({ ...rec, pidStart: null }, opts({ isAlive: () => true }))).toBe(false);
  });
  it('is dead on a verified birth-time mismatch (pid reuse)', () => {
    expect(foreignStaleOwnerDead(rec, opts({ isAlive: () => true, readPidStart: () => 'birth-b' }))).toBe(true);
  });
  it('holds when the birth time is unreadable', () => {
    expect(foreignStaleOwnerDead(rec, opts({ isAlive: () => true, readPidStart: () => null }))).toBe(false);
  });
  it('lets a throwing probe propagate so the caller holds the record', () => {
    expect(() => foreignStaleOwnerDead(rec, opts({ isAlive: () => { throw Error('probe failed'); } }))).toThrow('probe failed');
  });
});
