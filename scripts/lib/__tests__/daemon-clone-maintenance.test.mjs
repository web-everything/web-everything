/**
 * @file scripts/lib/__tests__/daemon-clone-maintenance.test.mjs
 * @description B13: daemon clones were never gc'd. The plan is pure (threshold, interval, never mid-rebuild, never
 *   while another owner holds the clone lease); the runner is non-fatal on gc failure or timeout.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planCloneMaintenance, runCloneMaintenance, maybeMaintainClone, LOOSE_THRESHOLD, INTERVAL_MS,
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
    expect(planCloneMaintenance({ looseCount: 99999, lastRunAt: null, now, rebuilding: true })).toMatchObject({ run: false, why: 'rebuilding' });
  });
  it('never runs while another owner holds the clone lease', () => {
    expect(planCloneMaintenance({ looseCount: 99999, lastRunAt: null, now, leaseHeldByOther: true })).toMatchObject({ run: false, why: 'lease-held' });
  });
  it('fails closed on an unreadable loose count', () => {
    expect(planCloneMaintenance({ looseCount: NaN, lastRunAt: null, now })).toMatchObject({ run: false, why: 'count-unreadable' });
  });
});

describe('runCloneMaintenance', () => {
  const base = () => ({
    clone: '/clone', now, log: { error: vi.fn() }, readLastRun: () => null, writeLastRun: vi.fn(),
  });
  it('runs gc --auto without prune=now and records the run', async () => {
    const calls = [];
    const run = vi.fn(async (args) => { calls.push(args); return args.includes('rev-parse') ? '.git\n.git\n' : args.includes('count-objects') ? 'count: 9000\n' : ''; });
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
    const run = vi.fn(async (a) => (a.includes('rev-parse') ? '.git\n.git\n' : 'count: 3\n'));
    const r = await runCloneMaintenance({ ...base(), readLastRun: () => now - 10, run });
    expect(r.ran).toBe(false);
    expect(run.mock.calls.some(([a]) => a.includes('gc'))).toBe(false);
  });
  it('is non-fatal when gc fails', async () => {
    const run = vi.fn(async (args) => { if (args.includes('gc')) throw new Error('gc boom'); return args.includes('rev-parse') ? '.git\n.git\n' : 'count: 9000\n'; });
    const r = await runCloneMaintenance({ ...base(), run });
    expect(r).toMatchObject({ ran: false, why: 'gc-failed' });
  });
  it('is non-fatal when gc times out', async () => {
    const run = vi.fn(async (args, { timeoutMs }) => {
      if (args.includes('gc')) { expect(timeoutMs).toBeGreaterThan(0); const e = new Error('timed out'); e.code = 'ETIMEDOUT'; throw e; }
      return args.includes('rev-parse') ? '.git\n.git\n' : 'count: 9000\n';
    });
    const r = await runCloneMaintenance({ ...base(), run });
    expect(r).toMatchObject({ ran: false, why: 'gc-failed' });
  });
  it('skips when leaseHeldByOther', async () => {
    const run = vi.fn(async (a) => (a.includes('rev-parse') ? '.git\n.git\n' : 'count: 9000\n'));
    const r = await runCloneMaintenance({ ...base(), run, leaseHeldByOther: () => true });
    expect(r).toMatchObject({ ran: false, why: 'lease-held' });
  });
  const okRun = (extra = () => {}) => vi.fn(async (a) => { extra(a); return a.includes('rev-parse') ? '.git\n.git\n' : 'count: 9000\n'; });
  it('re-checks the lease after counting, right before gc', async () => {
    let held = false;
    const run = okRun((a) => { if (a.includes('count-objects')) held = true; });
    const r = await runCloneMaintenance({ ...base(), run, leaseHeldByOther: () => held });
    expect(r).toMatchObject({ ran: false, why: 'lease-held' });
    expect(run.mock.calls.some(([a]) => a.includes('gc'))).toBe(false);
  });
  it('runs gc in the foreground (gc.autoDetach=false) so the timeout bounds it', async () => {
    const run = okRun();
    await runCloneMaintenance({ ...base(), run });
    const gc = run.mock.calls.map(([a]) => a).find((a) => a.includes('gc'));
    expect(gc).toEqual(expect.arrayContaining(['-c', 'gc.autoDetach=false']));
  });
  it('refuses a shared git dir', async () => {
    const run = vi.fn(async (a) => (a.includes('rev-parse') ? '.git/worktrees/x\n/other/.git\n' : 'count: 9000\n'));
    const r = await runCloneMaintenance({ ...base(), run });
    expect(r).toMatchObject({ ran: false, why: 'shared-git-dir' });
    expect(run.mock.calls.some(([a]) => a.includes('gc'))).toBe(false);
  });
});

describe('maybeMaintainClone', () => {
  it('treats unreadable build state as lease held (fail closed) and does not gc', async () => {
    const root = mkdtempSync(join(tmpdir(), 'we-cm-'));
    try {
      const log = { error: vi.fn() };
      const r = await maybeMaintainClone({
        root, stEnv: {}, log, now: () => now, lease: { token: 't' },
        readState: () => { throw new Error('corrupt'); }, lockOpts: { lockRoot: join(root, 'locks') },
      });
      expect(r.ran).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
