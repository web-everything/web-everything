import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { isLeaseStale } from '../lib/lane-lease.mjs';
import { leasePool, removalRace } from '../conveyor/soak/breaks/lease-keeps-while-renewed.mjs';
import { journalLaneEvent, readLaneJournalTail } from '../lib/lane-history.mjs';

let pool;
beforeEach(() => { pool = leasePool(); });
afterEach(() => pool.close());

it('the renewal-race matrix covers every stale-verdict marker take', () => {
  const source = readFileSync('scripts/lane-pool.mjs', 'utf8');
  const functions = [...source.matchAll(/^function (\w+)\(/gm)];
  const sites = [...source.matchAll(/takeMarkerIf\([^\n]*sameStaleLease\(/g)]
    .map(m => functions.filter(f => f.index < m.index).at(-1)?.[1]);
  expect(sites.sort()).toEqual(['tryClaimLane', 'reapDeadLeasesInPool', 'claimLaneForRemoval', 'cmdReclaim', 'cmdReclaimSalvage'].sort());
});

it.each(['acquire', 'reap', 'trim', 'reclaim', 'salvage'])('%s preserves a renewal after the stale verdict', async (path) => {
  const r = await removalRace(pool, { path });
  expect(r.signal).toBeNull();
  expect(r.actual).toEqual(r.expected);
});

it.each(['acquire', 'reap', 'trim', 'reclaim', 'salvage'])('%s checks renewal on the moved marker', async (path) => {
  const r = await removalRace(pool, { path, stage: 'moved' });
  expect(r.signal).toBeNull();
  expect(r.actual).toEqual(r.expected);
});

it.each(['acquire', 'reap', 'trim', 'reclaim', 'salvage'])('%s refuses a moved lease with unchanged identity and renewal version when its TTL is live', async (path) => {
  const r = await removalRace(pool, { path, stage: 'moved', ttlOnly: true });
  expect(r.signal).toBeNull();
  expect(r.actual).toEqual(r.expected);
});

it('the same-version live-TTL regression distinguishes removal of the freshness predicate', () => {
  const source = readFileSync('scripts/lane-pool.mjs', 'utf8');
  const expression = source.match(/^const sameStaleLease = (.+);$/m)?.[1];
  expect(expression).toBeDefined();
  const original = { acquiredAt: new Date(Date.now() - 5 * 3600_000).toISOString(), ttlMinutes: 240 };
  const extended = { ...original, ttlMinutes: 1440 };
  const context = { isLeaseStale, sameLeaseVersion: () => true };
  const predicate = runInNewContext(`(${expression})`, context);
  expect(predicate(extended, original, 240 * 60_000)).toBe(false);
  // Mutation stays in an isolated expression, never in the source tree or the on-disk guard.
  const mutant = expression.replace(/ && isLeaseStale\(moved, Date\.now\(\), ttlMs\)/, '');
  expect(mutant).not.toBe(expression);
  expect(runInNewContext(`(${mutant})`, context)(extended, original, 240 * 60_000)).toBe(true);
});

it.each([null, '', 'garbage', { invalid: true }])('refuses changed raw renewal evidence %j on the moved marker', async (renewedAt) => {
  const r = await removalRace(pool, { stage: 'moved', renewedAt });
  expect(r.actual).toEqual(r.expected);
});

it.each(['acquire', 'reap', 'trim', 'reclaim', 'salvage'])('%s explains the removed lease to its old holder', (path) => {
  const old = { session: 'conveyor-9999', holder: 'old-holder', acquiredAt: '2020-01-01T00:00:00Z', ttlMinutes: 240 };
  writeFileSync(pool.marker, JSON.stringify(old));
  if (path === 'salvage') writeFileSync(join(pool.dir, 'unsaved.txt'), 'holder work\n');
  // Auto-pick reaps lane-1, then acquires it; the taker's ordinary release must not hide that event.
  const r = path === 'trim' ? pool.run('trim', '--max=0', '--json')
    : path === 'reclaim' || path === 'salvage' ? pool.run('reclaim', ...(path === 'salvage' ? ['--salvage'] : []), '--json')
      : pool.run('acquire', '--session=taker', '--no-reset', ...(path === 'acquire' ? ['--no-reap'] : []));
  expect(r.status, r.stderr).toBe(0);
  if (path === 'acquire' || path === 'reap') expect(pool.run('release', '--session=taker').status).toBe(0);
  const released = pool.run('release', '--session=conveyor-9999');
  expect(released.stdout + released.stderr).toContain('lease conveyor-9999 expired');
  if (path === 'reap') {
    expect(readLaneJournalTail(join(pool.dir, '..')).some(e => e.action === 'lease-expire' && e.reason.startsWith('acquire reap:'))).toBe(true);
  }
});

it('missing-lease output removes terminal controls and Unicode line separators from history', () => {
  const session = 'worker\x1b[31m\n\r\u2028\u2029\u200b';
  journalLaneEvent(pool.dir, { action: 'lease-expire', leaseSession: session });
  const r = pool.run('release', `--session=${session}`);
  expect(r.stdout + r.stderr).toContain('lease worker [31m');
  expect(r.stdout + r.stderr).not.toMatch(/[\x1b\r\u2028\u2029\u200b]/u);
  expect((r.stdout + r.stderr).split('lease worker')[1]).not.toContain('\n\r');
});

it('does not report another session or an older expiry after this holder released normally', () => {
  journalLaneEvent(pool.dir, { action: 'lease-expire', leaseSession: 'worker' }, { nowMs: Date.now() - 2000 });
  journalLaneEvent(pool.dir, { action: 'release', leaseSession: 'worker' }, { nowMs: Date.now() - 1000 });
  journalLaneEvent(pool.dir, { action: 'lease-expire', leaseSession: 'other' });
  const r = pool.run('release', '--session=worker');
  expect(r.stdout + r.stderr).not.toContain('expired');
});

it('a completed item still keeps an unexpired lease until its holder releases', () => {
  const old = { session: 'conveyor-9999', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
  writeFileSync(pool.marker, JSON.stringify(old));
  const r = pool.run('acquire', '--session=taker', '--no-reset');
  expect(r.status).not.toBe(0);
  expect(JSON.parse(readFileSync(pool.marker, 'utf8'))).toEqual(old);
  // The same terminal item becomes reapable after TTL expiry.
  writeFileSync(pool.marker, JSON.stringify({ ...old, acquiredAt: '2020-01-01T00:00:00Z' }));
  expect(pool.run('acquire', '--session=taker', '--no-reset').status).toBe(0);
});
