/**
 * @file scripts/lib/__tests__/daemon-clone-maintenance.test.mjs
 * @description B13: daemon clones were never gc'd. The plan is pure (threshold, interval, never mid-rebuild, never
 *   while another owner holds the clone lease); the runner is non-fatal on gc failure or timeout.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  planCloneMaintenance, runCloneMaintenance, LOOSE_THRESHOLD, INTERVAL_MS,
} from '../daemon-rebuild/clone-maintenance.mjs';

const now = 1_000_000_000_000;

describe('planCloneMaintenance', () => {
  it('runs when loose objects exceed the threshold', () => {
    expect(planCloneMaintenance({ looseCount: LOOSE_THRESHOLD + 1, lastRunAt: now - 1000, now }).run).toBe(true);
  });
  it('skips at or below the threshold when recently run', () => {
    expect(planCloneMaintenance({ looseCount: LOOSE_THRESHOLD, lastRunAt: now - 1000, now })).toMatchObject({ run: false });
  });
  it('runs when more than 24h since the last run, or never run', () => {
    expect(planCloneMaintenance({ looseCount: 1, lastRunAt: now - INTERVAL_MS - 1, now }).run).toBe(true);
    expect(planCloneMaintenance({ looseCount: 1, lastRunAt: null, now }).run).toBe(true);
  });
  it('never runs mid-rebuild', () => {
    expect(planCloneMaintenance({ looseCount: 99999, lastRunAt: null, now, rebuilding: true })).toMatchObject({ run: false, reason: 'rebuilding' });
  });
  it('never runs while another owner holds the clone lease', () => {
    expect(planCloneMaintenance({ looseCount: 99999, lastRunAt: null, now, leaseHeldByOther: true })).toMatchObject({ run: false, reason: 'lease-held' });
  });
  it('fails closed on an unreadable loose count', () => {
    expect(planCloneMaintenance({ looseCount: NaN, lastRunAt: null, now })).toMatchObject({ run: false, reason: 'count-unreadable' });
  });
});

describe('runCloneMaintenance', () => {
  const base = () => ({
    clone: '/clone', now, log: { error: vi.fn() }, readLastRun: () => null, writeLastRun: vi.fn(),
  });
  it('runs gc --auto without prune=now and records the run', async () => {
    const calls = [];
    const run = vi.fn(async (args) => { calls.push(args); return args.includes('count-objects') ? 'count: 9000\n' : ''; });
    const o = base();
    const r = await runCloneMaintenance({ ...o, run });
    expect(r.ran).toBe(true);
    const gc = calls.find((a) => a.includes('gc'));
    expect(gc).toEqual(expect.arrayContaining(['gc', '--auto', '--quiet']));
    expect(gc.join(' ')).not.toMatch(/prune=now/);
    expect(o.writeLastRun).toHaveBeenCalledWith(now);
    expect(o.log.error).toHaveBeenCalledTimes(1);
  });
  it('does not run gc when the plan says skip', async () => {
    const run = vi.fn(async () => 'count: 3\n');
    const r = await runCloneMaintenance({ ...base(), readLastRun: () => now - 10, run });
    expect(r.ran).toBe(false);
    expect(run.mock.calls.some(([a]) => a.includes('gc'))).toBe(false);
  });
  it('is non-fatal when gc fails', async () => {
    const run = vi.fn(async (args) => { if (args.includes('gc')) throw new Error('gc boom'); return 'count: 9000\n'; });
    const r = await runCloneMaintenance({ ...base(), run });
    expect(r).toMatchObject({ ran: false, reason: 'gc-failed' });
  });
  it('is non-fatal when gc times out', async () => {
    const run = vi.fn(async (args, { timeoutMs }) => {
      if (args.includes('gc')) { expect(timeoutMs).toBeGreaterThan(0); const e = new Error('timed out'); e.code = 'ETIMEDOUT'; throw e; }
      return 'count: 9000\n';
    });
    const r = await runCloneMaintenance({ ...base(), run });
    expect(r).toMatchObject({ ran: false, reason: 'gc-failed' });
  });
  it('skips when leaseHeldByOther', async () => {
    const run = vi.fn(async () => 'count: 9000\n');
    const r = await runCloneMaintenance({ ...base(), run, leaseHeldByOther: () => true });
    expect(r).toMatchObject({ ran: false, reason: 'lease-held' });
  });
});
