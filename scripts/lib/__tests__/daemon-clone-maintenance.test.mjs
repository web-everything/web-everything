/**
 * @file scripts/lib/__tests__/daemon-clone-maintenance.test.mjs
 * @description B13: daemon clones were never gc'd. The plan is pure (threshold, interval, never mid-rebuild, never
 *   while another owner holds the clone lease); the runner is non-fatal on gc failure or timeout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import {
  planCloneMaintenance, runCloneMaintenance, maybeMaintainClone, LOOSE_THRESHOLD, INTERVAL_MS,
} from '../daemon-rebuild/clone-maintenance.mjs';

// rebuildClone's own phases are mocked: this file only exercises the exit wrapper.
vi.mock('../daemon-rebuild/prepare.mjs', () => ({ prepareRebuild: vi.fn() }));
vi.mock('../daemon-rebuild/smoke.mjs', () => ({ smokeAndAdopt: vi.fn() }));
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import { prepareRebuild } from '../daemon-rebuild/prepare.mjs';
import { smokeAndAdopt } from '../daemon-rebuild/smoke.mjs';

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
        readState: () => { throw new Error('corrupt'); }, withLock: (fn, o) => withWriteLock(root, fn, o), lockOpts: { lockRoot: join(root, 'locks') },
      });
      expect(r.ran).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('fails closed on a corrupt state FILE that readRebuildState would swallow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'we-cm-'));
    try {
      const statePath = join(root, 'state.json');
      writeFileSync(statePath, '{not json');
      const r = await maybeMaintainClone({
        root, stEnv: {}, log: { error: vi.fn() }, now: () => now, lease: { token: 't' },
        readState: () => ({ building: null }), statePath, withLock: (fn, o) => withWriteLock(root, fn, o), lockOpts: { lockRoot: join(root, 'locks') },
      });
      expect(r.ran).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('is non-fatal when the write lock itself throws', async () => {
    const root = join(tmpdir(), 'we-cm-missing', 'nope');
    const log = { error: vi.fn() };
    const r = await maybeMaintainClone({
      root, stEnv: {}, log, now: () => now, lease: { token: 't' },
      readState: () => ({ building: null }), withLock: (fn, o) => withWriteLock(root, fn, o), lockOpts: { lockRoot: '/dev/null/cannot-create' },
    });
    expect(r.ran).toBe(false);
  });
});

describe('rebuildClone exit runs clone maintenance once per moved+adopted outcome (R928)', () => {
  const sha = 'b'.repeat(40);
  let scratch; let options;
  beforeEach(() => {
    vi.resetAllMocks();
    scratch = mkdtempSync(join(tmpdir(), 'we-cm-exit-'));
    const root = join(scratch, 'fix-daemon');
    mkdirSync(root);
    options = {
      root,
      env: {
        WE_DAEMON_STATE_DIR: join(scratch, 'state'), WE_DAEMON_CLONE_LOCK_ROOT: join(scratch, 'locks'),
        WE_DAEMON_OVERLAY_DIR: join(scratch, 'overlays'), WE_DAEMON_EVENTS: join(scratch, 'events.jsonl'),
      },
      versions: null, asJob: false, skipCheck: null, lockOpts: { waitMs: 20, pollMs: 1 },
      log: { error: vi.fn(), log: vi.fn() }, run: vi.fn(() => { throw new Error('unexpected git'); }),
      runSmoke: vi.fn(), prState: vi.fn(), emitEvent: vi.fn(),
    };
  });
  const maintenanceLines = () => options.log.error.mock.calls.map(([m]) => String(m)).filter((m) => /clone maintenance/.test(m));
  it('runs for the terminal ready-adopted return that job mode takes (rebuild.mjs terminal branch)', async () => {
    prepareRebuild.mockReturnValue({ terminal: true, result: { moved: true, adopted: true, reason: 'ready-adopted', head: sha }, alerts: [] });
    await rebuildClone(options);
    expect(smokeAndAdopt).not.toHaveBeenCalled();
    expect(maintenanceLines()).toHaveLength(1);
    rmSync(scratch, { recursive: true, force: true });
  });
  it('runs exactly once for the phase-2 adopt (no double run)', async () => {
    prepareRebuild.mockReturnValue({ terminal: false, plan: { finalSha: sha }, prevHead: 'a'.repeat(40), lease: { token: 't' }, overlays: [], alerts: [] });
    smokeAndAdopt.mockResolvedValue({ moved: true, adopted: true, head: sha, plan: { finalSha: sha }, alerts: [] });
    await rebuildClone(options);
    expect(maintenanceLines()).toHaveLength(1);
    rmSync(scratch, { recursive: true, force: true });
  });
  it('does not run when nothing moved (already-adopted / up-to-date)', async () => {
    prepareRebuild.mockReturnValue({ terminal: true, result: { moved: false, adopted: true, reason: 'already-adopted', head: sha }, alerts: [] });
    await rebuildClone(options);
    expect(maintenanceLines()).toHaveLength(0);
    rmSync(scratch, { recursive: true, force: true });
  });
});
